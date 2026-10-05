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
  console.log('PASS async metric refresh: validated thread IDs, isolated per-window data, offline sessions, unavailable data and idle agent');
})().catch(error => { console.error(error); process.exitCode = 1; });
