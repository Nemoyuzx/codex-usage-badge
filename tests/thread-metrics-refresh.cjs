const assert = require('node:assert/strict');
const { refreshThreadMetrics } = require('../agent.cjs');
const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];
const session = requested => ({
  updates: [],
  async evaluate(expression) {
    if (expression.includes('requestedIds()')) return { result: { value: requested } };
    assert.ok(expression.startsWith('window.__codexThreadMetrics?.update('));
    this.updates.push(JSON.parse(expression.slice('window.__codexThreadMetrics?.update('.length, -1)));
  }
});
(async () => {
  const first = session([ids[0], 'invalid-id', "');throw Error('injection')//"]);
  const second = session([ids[1]]);
  const offline = { async evaluate() { throw Error('disconnected'); } };
  let reads = 0;
  const reader = { async read(requested) {
    reads++;
    assert.deepEqual(requested, ids);
    // A real reader returns a promise while streaming bounded local chunks.
    await new Promise(resolve => setImmediate(resolve));
    return { ok: true, checkedAt: 123, perThread: { [ids[0]]: { rounds: 1, inputTokens: 100, outputTokens: null }, [ids[1]]: { rounds: 2, inputTokens: 200 } } };
  } };
  const injector = { sessions: new Map([['first', first], ['second', second], ['offline', offline]]) };
  await refreshThreadMetrics(injector, reader);
  assert.equal(reads, 1);
  assert.deepEqual(Object.keys(first.updates[0].perThread), [ids[0]], 'each window receives only its current thread aggregates');
  assert.deepEqual(Object.keys(second.updates[0].perThread), [ids[1]]);
  assert.equal(first.updates[0].perThread[ids[0]].outputTokens, null, 'unknown metrics must remain null');
  assert.equal(first.updates[0].checkedAt, 123);
  await refreshThreadMetrics(injector, { async read() { return { ok: false, checkedAt: 124, perThread: {} }; } });
  assert.deepEqual(first.updates[1], { ok: false, checkedAt: 124, perThread: {} }, 'an unavailable reader clears old values');
  injector.sessions.clear();
  await refreshThreadMetrics(injector, { read() { throw Error('must not read without a window'); } });
  const actorA = 'a'.repeat(64), actorB = 'b'.repeat(64), local = 'c'.repeat(64), revision = 'd'.repeat(64);
  const savedA = { threadId: ids[0], actorScopeId: actorA, scopeId: local, pendingVersion: 4, producerId: '00000000-0000-0000-0000-000000000010', fields: {} };
  const contextSession = context => ({ updates: [], acks: [], async evaluate(expression) {
    if (expression.includes('requestedIds()')) return { result: { value: context } };
    const prefix = expression.startsWith('window.__codexThreadMetrics?.ackPersisted(') ? 'window.__codexThreadMetrics?.ackPersisted(' : 'window.__codexThreadMetrics?.update(';
    const value = JSON.parse(expression.slice(prefix.length, -1));
    (prefix.includes('ackPersisted') ? this.acks : this.updates).push(value);
  } });
  const third = '00000000-0000-0000-0000-000000000003';
  const a = contextSession({ ids: [ids[0], third], actorScopeId: actorA, pending: [savedA] });
  const b = contextSession({ ids: [ids[1]], actorScopeId: actorB, pending: [] });
  const queries = [], writes = [];
  const store = { write(records) { writes.push(records); return records.map(({ actorScopeId, scopeId, threadId, pendingVersion, producerId }) => ({ actorScopeId, scopeId, threadId, pendingVersion, producerId })); },
    read(query) { queries.push(query); return { actorScopeId: query.actorScopeId, scopeId: query.scopeId, threadId: query.threadId, fields: {} }; } };
  await refreshThreadMetrics({ sessions: new Map([['a', a], ['b', b]]) }, { async read(requested) {
    assert.deepEqual(requested, [ids[0], ids[1], third], 'both windows active threads must precede background candidates');
    return { ok: true, perThread: { [ids[0]]: { localVerified: true, scopeId: local, revision }, [ids[1]]: { localVerified: true, scopeId: local }, [third]: {} }, checkedAt: 125 };
  } }, store);
  assert.deepEqual(writes, [[savedA]]);
  assert.equal(a.acks[0][0].producerId, savedA.producerId, 'the originating widget nonce must survive durable acknowledgement');
  assert.equal(b.acks.length, 0);
  assert.deepEqual(queries, [{ actorScopeId: actorA, scopeId: local, threadId: ids[0], revision }, { actorScopeId: actorB, scopeId: local, threadId: ids[1] }], 'restores require current local proof and each window current account scope');
  assert.deepEqual(Object.keys(a.updates[0].persistedPerThread), [ids[0]]);
  assert.deepEqual(Object.keys(b.updates[0].persistedPerThread), [ids[1]]);
  await refreshThreadMetrics({ sessions: new Map([['a', a]]) }, { async read() { return { ok: false, perThread: {}, checkedAt: 126 }; } }, { write() { return []; }, read() { throw Error('unverified data must not restore'); } });
  assert.equal(a.acks.length, 1, 'failed/uncommitted writes remain pending without false acknowledgements');
  assert.deepEqual(a.updates[1].persistedPerThread, {});
  console.log('PASS async metric refresh: per-window fairness and data isolation, durable nonce/version acknowledgements, scoped restores, offline windows and failed-write retry');
})().catch(error => { console.error(error); process.exitCode = 1; });
