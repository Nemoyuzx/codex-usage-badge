const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const filename = path.join(__dirname, '../src/thread-metrics-store.js');
const source = new Module(filename, module);
source.filename = filename; source.paths = module.paths;
source._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports={ThreadMetricsStore};', filename);
const { ThreadMetricsStore } = source.exports;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-metrics-store-'));
const file = path.join(temp, 'support', 'thread-metrics.sqlite');
const actorScopeId = 'a'.repeat(64), scopeId = 'b'.repeat(64), revision = 'c'.repeat(64);
const ids = Array.from({ length: 150 }, (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`);
let at = 10000;
const entry = (value, time = at, extra = {}) => ({ value, at: time, source: 'file', approximate: false, lowerBound: false, ...extra });
const record = (threadId, fields, extra = {}) => ({ version: 1, actorScopeId, scopeId, threadId, updatedAt: at,
  revision, rolloutSize: 3000, rolloutMtimeMs: at - 100, fields, pendingVersion: 1, ...extra });
const key = (threadId, extra = {}) => ({ actorScopeId, scopeId, threadId, ...extra });
let store;
try {
  store = new ThreadMetricsStore({ file, now: () => at });
  const fields = { rounds: entry(3), steps: entry(40), llmDurationMs: entry(4000.5), toolDurationMs: entry(1200),
    firstTokenAvgMs: entry(255.5), tokensPerSecond: entry(32.5, at, { source: 'monitor', approximate: true, observedSince: 9000, observedResponses: 5 }),
    cacheHitPercent: entry(98.7), inputTokens: entry(1000000), outputTokens: entry(30000) };
  const privateRecord = record(ids[0], { ...fields, prompt: entry(10), private: 'PRIVATE BODY' }, {
    prompt: 'PRIVATE PROMPT', auth: 'PRIVATE AUTH', path: 'PRIVATE PATH', email: 'PRIVATE EMAIL',
  });
  privateRecord.fields.rounds.private = 'PRIVATE FIELD';
  assert.deepEqual(store.write([privateRecord]), [{ actorScopeId, scopeId, threadId: ids[0], pendingVersion: 1 }]);
  const initial = store.read(key(ids[0]));
  assert.deepEqual(Object.keys(initial.fields).sort(), Object.keys(fields).sort());
  assert.equal(initial.fields.rounds.value, 3);
  assert.equal(initial.fields.tokensPerSecond.observedResponses, 5);
  assert.equal(initial.pendingVersion, undefined, 'transport acknowledgements are not persisted');
  const producerId = '10000000-0000-0000-0000-000000000001';
  const producerAck = store.write([record(ids[0], fields, { producerId, pendingVersion: 1 })]);
  assert.deepEqual(producerAck, [{ actorScopeId, scopeId, threadId: ids[0], pendingVersion: 1, producerId }],
    'an acknowledgement identifies its renderer producer even when a reload restarts the monotonic version');
  assert.equal(store.read(key(ids[0])).producerId, undefined, 'producer identity is ephemeral transport metadata, not durable collected data');
  assert.equal(fs.readFileSync(file).toString('utf8').includes(producerId), false);
  assert.deepEqual(store.write([record(ids[0], fields, { producerId: 'INVALID PRODUCER', pendingVersion: 1 })]), []);
  assert.doesNotMatch(JSON.stringify(initial), /PRIVATE|auth|email|prompt/);
  assert.equal(store.read(key(ids[0], { actorScopeId: 'd'.repeat(64) })), null);
  assert.equal(store.read(key(ids[0], { scopeId: 'd'.repeat(64) })), null);
  assert.equal(store.read(key(ids[0], { revision: 'd'.repeat(64) })), null);

  at = 11000;
  assert.equal(store.write([record(ids[0], { rounds: entry(4), steps: entry(null), inputTokens: null }, { pendingVersion: 2 })]).length, 1);
  const partial = store.read(key(ids[0]));
  assert.equal(partial.fields.rounds.value, 4);
  assert.equal(partial.fields.steps.value, 40, 'null cannot erase previously known fields');
  assert.equal(partial.fields.tokensPerSecond.value, 32.5);
  assert.equal(partial.fields.steps.at, 10000, 'partial writes preserve the original field timestamp');
  assert.equal(store.write([record(ids[0], { rounds: entry(3, 9000) }, { updatedAt: 9000, pendingVersion: 3, rolloutSize: 1 })]).length, 1,
    'a valid older outbox version is acknowledged as superseded without overwriting newer durable data');
  assert.equal(store.read(key(ids[0])).fields.rounds.value, 4);
  assert.equal(store.read(key(ids[0])).rolloutSize, 3000, 'stale record metadata cannot overwrite newer provenance');
  assert.equal(store.write([record(ids[0], { rounds: entry(4, 9000) }, { updatedAt: 9000, pendingVersion: 4 })]).length, 1,
    'older equal values already subsumed by newer committed data can be acknowledged');

  at = 12000;
  store.write([record(ids[0], { steps: entry(3, at, { lowerBound: true }) }, { pendingVersion: 5 })]);
  assert.equal(store.read(key(ids[0])).fields.steps.value, 40, 'a fresh partial observer cannot downgrade a larger already-saved complete historical count');
  assert.equal(store.read(key(ids[0])).fields.steps.at, 10000, 'retained complete counters keep their actual measurement timestamp');
  store.write([record(ids[0], { rounds: entry(5, at, { lowerBound: true }) }, { pendingVersion: 5 })]);
  assert.equal(store.read(key(ids[0])).fields.rounds.lowerBound, true);
  store.write([record(ids[0], { rounds: entry(5, at, { lowerBound: false }) }, { pendingVersion: 6 })]);
  assert.equal(store.read(key(ids[0])).fields.rounds.lowerBound, false, 'equal timestamps prefer exact metadata over lower bounds');
  assert.equal(store.write([record(ids[0], { rounds: entry(5, at, { lowerBound: true }) }, { pendingVersion: 7 })]).length, 1);
  assert.equal(store.read(key(ids[0])).fields.rounds.lowerBound, false);

  at = 13000;
  store.write([record(ids[0], { rounds: entry(1) }, { revision: 'e'.repeat(64), pendingVersion: 8, rolloutSize: 50 })]);
  const replaced = store.read(key(ids[0]));
  assert.equal(replaced.fields.rounds.value, 1);
  assert.equal(replaced.fields.steps, undefined, 'a verified rollout revision change resets all fields from its predecessor');
  assert.equal(replaced.fields.tokensPerSecond, undefined);
  assert.equal(store.write([record(ids[0], { rounds: entry(9, 9000) }, { updatedAt: 9000, pendingVersion: 9 })]).length, 1,
    'an older superseded revision drains safely without erasing current-generation metrics');
  assert.equal(store.read(key(ids[0])).revision, 'e'.repeat(64));

  const many = ids.slice(1).map((id, index) => record(id, { rounds: entry(index + 1), steps: entry(index + 10) }, { pendingVersion: index + 20 }));
  assert.equal(store.write(many).length, 149);
  store.write([record(ids[0], { rounds: entry(99) }, { actorScopeId: 'f'.repeat(64), pendingVersion: 10 })]);
  store.write([record(ids[0], { rounds: entry(88) }, { scopeId: 'f'.repeat(64), pendingVersion: 11 })]);
  store.stop();
  assert.deepEqual(store.write(many), []);
  assert.equal(store.read(key(ids[0])), null);
  store = new ThreadMetricsStore({ file, now: () => at });
  assert.equal(store.read(key(ids[0])).fields.rounds.value, 1);
  assert.equal(store.read(key(ids[0], { actorScopeId: 'f'.repeat(64) })).fields.rounds.value, 99);
  assert.equal(store.read(key(ids[0], { scopeId: 'f'.repeat(64) })).fields.rounds.value, 88);
  for (const [index, id] of ids.slice(1).entries()) assert.equal(store.read(key(id)).fields.rounds.value, index + 1,
    'switching through more than 64 conversations must never evict durable history');
  assert.doesNotMatch(fs.readFileSync(file).toString('utf8'), /PRIVATE/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const invalid = [
    record(ids[0], { rounds: entry(2) }, { actorScopeId: 'PRIVATE' }),
    record(ids[0], { rounds: entry(2) }, { scopeId: 'PRIVATE' }),
    record('invalid-thread', { rounds: entry(2) }),
    record(ids[0], { rounds: entry(2) }, { updatedAt: at + 1001 }),
    record(ids[0], { rounds: entry(2) }, { revision: 'PRIVATE' }),
    record(ids[0], { rounds: entry(2) }, { pendingVersion: 'PRIVATE' }),
    record(ids[0], { rounds: entry(1.5), steps: entry(-1), cacheHitPercent: entry(101), tokensPerSecond: entry(Infinity) }),
    record(ids[0], { rounds: entry(2, at + 1001), steps: entry(2, at, { source: 'PRIVATE' }) }),
  ];
  assert.deepEqual(store.write(invalid), []);
  assert.equal(store.read({ actorScopeId, scopeId, threadId: "');DELETE FROM thread_metric_snapshots;--" }), null);
  assert.equal(store.read(key(ids[0])).fields.rounds.value, 1);
  assert.equal(store.write([record(ids[0], { rounds: entry(null) }, { revision: 'd'.repeat(64) })]).length, 0,
    'empty or wholly invalid fields cannot reset a legitimate revision');
  assert.equal(store.read(key(ids[0])).revision, 'e'.repeat(64));

  const blocker = path.join(temp, 'not-a-directory'); fs.writeFileSync(blocker, 'owned fixture');
  const failing = new ThreadMetricsStore({ file: path.join(blocker, 'thread-metrics.sqlite'), now: () => at });
  assert.deepEqual(failing.write([record(ids[0], { rounds: entry(1) })]), [], 'a write failure never acknowledges pending data');
  assert.equal(failing.read(key(ids[0])), null); failing.stop();
  const unrelated = path.join(temp, 'unrelated.sqlite');
  const other = new DatabaseSync(unrelated); other.exec('CREATE TABLE unrelated(value TEXT)'); other.prepare('INSERT INTO unrelated VALUES(?)').run('PRIVATE OTHER DATA'); other.close();
  const before = fs.readFileSync(unrelated);
  const unsafe = new ThreadMetricsStore({ file: unrelated, now: () => at });
  assert.deepEqual(unsafe.write([record(ids[0], { rounds: entry(1) })]), []);
  unsafe.stop(); assert.deepEqual(fs.readFileSync(unrelated), before, 'unknown/unrelated databases are never modified');
  const lock = new DatabaseSync(file); lock.exec('BEGIN IMMEDIATE');
  assert.deepEqual(store.write([record(ids[0], { rounds: entry(2) }, { revision: 'e'.repeat(64) })]), [], 'busy transactions never send a false acknowledgement');
  lock.exec('ROLLBACK'); lock.close();
  assert.equal(store.read(key(ids[0])).fields.rounds.value, 1);
  console.log('PASS durable SQLite metrics across 150 threads and reopen, account/storage isolation, private projection, per-field timestamp merge, partial/null retention, revision resets, strict validation, committed-only acknowledgements, safe permissions and failed/busy writes');
} finally { store?.stop(); fs.rmSync(temp, { recursive: true, force: true }); }
