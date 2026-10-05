// Durable numeric snapshots. This database contains no prompts, text deltas,
// credentials, paths to conversations, or original account identifiers.
class ThreadMetricsStore {
  constructor({ file, now = Date.now } = {}) {
    const path = require('node:path'), os = require('node:os');
    const directory = process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexUsageBadge')
      : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'CodexUsageBadge')
        : path.join(os.homedir(), '.local', 'share', 'CodexUsageBadge');
    this.file = file || path.join(directory, 'thread-metrics.sqlite');
    this.now = now; this.db = null; this.stopped = false;
  }
  scope(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }
  uuid(value) { return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value); }
  time(value, at) { return Number.isSafeInteger(value) && value >= 0 && value <= at + 1000; }
  number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
  metric(field, value) {
    const known = ['rounds', 'steps', 'llmDurationMs', 'toolDurationMs', 'firstTokenAvgMs', 'tokensPerSecond', 'cacheHitPercent', 'inputTokens', 'outputTokens'];
    return known.includes(field) && this.number(value)
      && (!['rounds', 'steps', 'inputTokens', 'outputTokens'].includes(field) || Number.isSafeInteger(value))
      && (field !== 'cacheHitPercent' || value <= 100);
  }
  project(record, at) {
    if (!record || record.version !== 1 || !this.scope(record.scopeId) || !this.scope(record.actorScopeId) || !this.uuid(record.threadId)
      || !this.time(record.updatedAt, at) || !Number.isSafeInteger(record.pendingVersion) || record.pendingVersion < 0
      || record.producerId !== undefined && !this.uuid(record.producerId)
      || record.revision != null && !this.scope(record.revision) || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) return null;
    const fields = {};
    for (const [field, entry] of Object.entries(record.fields)) {
      if (!entry || !this.metric(field, entry.value) || !this.time(entry.at, at) || !['file', 'monitor'].includes(entry.source)
        || typeof entry.approximate !== 'boolean' || typeof entry.lowerBound !== 'boolean') continue;
      const clean = { value: entry.value, at: entry.at, source: entry.source, approximate: entry.approximate, lowerBound: entry.lowerBound };
      if (this.time(entry.observedSince, at) && entry.observedSince <= entry.at) clean.observedSince = entry.observedSince;
      if (Number.isSafeInteger(entry.observedResponses) && entry.observedResponses >= 0) clean.observedResponses = entry.observedResponses;
      fields[field] = clean;
    }
    if (!Object.keys(fields).length) return null;
    return { version: 1, scopeId: record.scopeId, actorScopeId: record.actorScopeId, threadId: record.threadId,
      updatedAt: record.updatedAt, pendingVersion: record.pendingVersion, revision: record.revision ?? null,
      ...(record.producerId === undefined ? {} : { producerId: record.producerId }),
      rolloutSize: Number.isSafeInteger(record.rolloutSize) && record.rolloutSize >= 0 ? record.rolloutSize : null,
      rolloutMtimeMs: this.number(record.rolloutMtimeMs) && record.rolloutMtimeMs <= at + 1000 ? record.rolloutMtimeMs : null, fields };
  }
  acknowledgement(record) {
    return { actorScopeId: record.actorScopeId, scopeId: record.scopeId, threadId: record.threadId, pendingVersion: record.pendingVersion,
      ...(record.producerId === undefined ? {} : { producerId: record.producerId }) };
  }
  open() {
    if (this.stopped) throw new Error('Metrics store stopped');
    if (this.db) return this.db;
    const fs = require('node:fs'), path = require('node:path');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(this.file);
    if (existed && fs.lstatSync(this.file).isSymbolicLink()) throw new Error('Metrics store cannot follow a symlink');
    const db = new (require('node:sqlite').DatabaseSync)(this.file, { timeout: 200 });
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (![0, 1].includes(version) || tables.some(row => !['thread_metric_snapshots', 'thread_metric_values'].includes(row.name))) throw new Error('Unknown metrics store schema');
      if (version === 0 && tables.length) throw new Error('Unversioned metrics store schema');
      if (version === 1) {
        const columns = {
          thread_metric_snapshots: ['actor_scope', 'local_scope', 'thread_id', 'revision', 'updated_at', 'rollout_size', 'rollout_mtime_ms'],
          thread_metric_values: ['actor_scope', 'local_scope', 'thread_id', 'field', 'value', 'measured_at', 'source', 'approximate', 'lower_bound', 'observed_since', 'observed_responses'],
        };
        if (tables.length !== 2 || Object.entries(columns).some(([table, expected]) => {
          const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
          return actual.length !== expected.length || expected.some((column, index) => actual[index] !== column);
        })) throw new Error('Unknown metrics store columns');
      }
      db.exec('PRAGMA foreign_keys=ON');
      if (version === 0) db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS thread_metric_snapshots(
          actor_scope TEXT NOT NULL, local_scope TEXT NOT NULL, thread_id TEXT NOT NULL,
          revision TEXT, updated_at INTEGER NOT NULL, rollout_size INTEGER, rollout_mtime_ms REAL,
          PRIMARY KEY(actor_scope,local_scope,thread_id));
        CREATE TABLE IF NOT EXISTS thread_metric_values(
          actor_scope TEXT NOT NULL, local_scope TEXT NOT NULL, thread_id TEXT NOT NULL, field TEXT NOT NULL,
          value REAL NOT NULL, measured_at INTEGER NOT NULL, source TEXT NOT NULL,
          approximate INTEGER NOT NULL, lower_bound INTEGER NOT NULL, observed_since INTEGER, observed_responses INTEGER,
          PRIMARY KEY(actor_scope,local_scope,thread_id,field),
          FOREIGN KEY(actor_scope,local_scope,thread_id) REFERENCES thread_metric_snapshots(actor_scope,local_scope,thread_id) ON DELETE CASCADE);
        PRAGMA user_version=1; COMMIT;`);
      if (!existed && process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
      this.db = db; return db;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} try { db.close(); } catch {} throw error; }
  }
  write(records) {
    if (this.stopped || !Array.isArray(records)) return [];
    const accepted = [], at = this.now();
    const clean = records.map(record => this.project(record, at)).filter(Boolean);
    if (!clean.length) return accepted;
    let db;
    try {
      db = this.open(); db.exec('BEGIN IMMEDIATE');
      const get = db.prepare('SELECT * FROM thread_metric_snapshots WHERE actor_scope=? AND local_scope=? AND thread_id=?');
      const getField = db.prepare('SELECT * FROM thread_metric_values WHERE actor_scope=? AND local_scope=? AND thread_id=? AND field=?');
      const remove = db.prepare('DELETE FROM thread_metric_values WHERE actor_scope=? AND local_scope=? AND thread_id=?');
      const put = db.prepare(`INSERT INTO thread_metric_snapshots VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(actor_scope,local_scope,thread_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,
        rollout_size=excluded.rollout_size,rollout_mtime_ms=excluded.rollout_mtime_ms`);
      const putField = db.prepare(`INSERT INTO thread_metric_values VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(actor_scope,local_scope,thread_id,field) DO UPDATE SET value=excluded.value,measured_at=excluded.measured_at,
        source=excluded.source,approximate=excluded.approximate,lower_bound=excluded.lower_bound,
        observed_since=excluded.observed_since,observed_responses=excluded.observed_responses`);
      for (const record of clean) {
        const key = [record.actorScopeId, record.scopeId, record.threadId], prior = get.get(...key);
        const revisionChanged = prior && record.revision !== null && prior.revision !== null && prior.revision !== record.revision;
        if (revisionChanged && record.updatedAt < prior.updated_at) {
          accepted.push(this.acknowledgement(record));
          continue; // This valid outbox version is superseded by a newer revision.
        }
        if (revisionChanged) remove.run(...key);
        const newerMetadata = !prior || record.updatedAt >= prior.updated_at;
        put.run(...key, record.revision ?? prior?.revision ?? null, Math.max(record.updatedAt, prior?.updated_at ?? 0),
          newerMetadata ? record.rolloutSize ?? prior?.rollout_size ?? null : prior.rollout_size,
          newerMetadata ? record.rolloutMtimeMs ?? prior?.rollout_mtime_ms ?? null : prior.rollout_mtime_ms);
        for (const [field, entry] of Object.entries(record.fields)) {
          const old = revisionChanged ? null : getField.get(...key, field);
          // A partial backfill or a new observer epoch cannot erase a larger
          // already-confirmed historical count while the same file revision
          // is still current. Keep its original measurement time too.
          if (old && ['rounds', 'steps'].includes(field) && entry.lowerBound &&
            (old.value > entry.value || old.value === entry.value && !old.lower_bound)) continue;
          const equallyNew = old && entry.at === old.measured_at;
          const better = equallyNew && (Boolean(old.lower_bound) && !entry.lowerBound || Boolean(old.approximate) && !entry.approximate);
          if (!old || entry.at > old.measured_at || better) putField.run(...key, field, entry.value, entry.at, entry.source,
            Number(entry.approximate), Number(entry.lowerBound), entry.observedSince ?? null, entry.observedResponses ?? null);
        }
        // Older valid fields are safely superseded by their durable successors.
        // Acknowledge them too so one stale window cannot stall the entire outbox.
        accepted.push(this.acknowledgement(record));
      }
      db.exec('COMMIT'); return accepted;
    } catch { try { db?.exec('ROLLBACK'); } catch {} return []; }
  }
  read({ actorScopeId, scopeId, threadId, revision } = {}) {
    if (this.stopped || !this.scope(actorScopeId) || !this.scope(scopeId) || !this.uuid(threadId) || revision != null && !this.scope(revision)) return null;
    try {
      const db = this.open(), key = [actorScopeId, scopeId, threadId];
      const row = db.prepare('SELECT * FROM thread_metric_snapshots WHERE actor_scope=? AND local_scope=? AND thread_id=?').get(...key);
      if (!row || revision !== undefined && revision !== row.revision) return null;
      const fields = {};
      for (const entry of db.prepare('SELECT * FROM thread_metric_values WHERE actor_scope=? AND local_scope=? AND thread_id=?').all(...key)) {
        const clean = { value: entry.value, at: entry.measured_at, source: entry.source,
          approximate: Boolean(entry.approximate), lowerBound: Boolean(entry.lower_bound) };
        if (entry.observed_since !== null) clean.observedSince = entry.observed_since;
        if (entry.observed_responses !== null) clean.observedResponses = entry.observed_responses;
        fields[entry.field] = clean;
      }
      const clean = this.project({ version: 1, actorScopeId, scopeId, threadId, updatedAt: row.updated_at, revision: row.revision,
        rolloutSize: row.rollout_size, rolloutMtimeMs: row.rollout_mtime_ms, fields, pendingVersion: 0 }, this.now());
      if (!clean) return null;
      delete clean.pendingVersion; return clean;
    } catch { return null; }
  }
  stop() { this.stopped = true; try { this.db?.close(); } catch {} this.db = null; }
}
