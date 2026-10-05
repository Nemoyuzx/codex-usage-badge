const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { installThreadMetrics } = require('../agent.cjs');

const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const REMOTE = '00000000-0000-0000-0000-000000000003';
const CLOUD = '00000000-0000-0000-0000-000000000004';
const UNKNOWN = '00000000-0000-0000-0000-000000000005';
const MARK = '[data-codex-thread-metrics]';
const fields = ['rounds', 'steps', 'llmDurationMs', 'toolDurationMs', 'firstTokenAvgMs',
  'tokensPerSecond', 'cacheHitPercent', 'inputTokens', 'outputTokens'];
const metrics = { rounds: 1, steps: 52, llmDurationMs: 2274000, toolDurationMs: 25000,
  firstTokenAvgMs: 5900, tokensPerSecond: 42, cacheHitPercent: 97, inputTokens: 5000000, outputTokens: 8000 };
const row = (id, host = 'local', kind = 'local', key = `local:${id}`) => `<div data-app-action-sidebar-thread-row
  data-app-action-sidebar-thread-id="${key}" data-app-action-sidebar-thread-host-id="${host}"
  data-app-action-sidebar-thread-kind="${kind}"><span data-thread-title>测试会话</span></div>`;
const composer = (id, name, active, placement = 'thread') => `<section data-page="${name}"
  data-app-shell-active-page="${active}" style="${active ? '' : 'display:none'}">
  <div data-codex-composer-root data-composer-placement="${placement}">
    <div data-above-composer-portal data-above-composer-conversation-id="${id}"></div>
    <div class="input-shell"><div data-composer-body><div data-composer-input>
      <div contenteditable="true" role="textbox" data-codex-composer aria-label="随心输入">保留草稿</div>
    </div><footer data-composer-footer-responsive><button data-model>GPT-6</button><button data-send>发送</button></footer></div></div>
    <div data-composer-rail>原有提示文字</div>
  </div></section>`;
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>
  *{box-sizing:border-box}body{margin:0;padding:12px;font:14px/1.5 -apple-system,sans-serif;background:#f7f7f7;color:#222}
  html.dark body{background:#202121;color:#eee}aside{height:32px;display:flex;gap:12px;overflow:hidden;font-size:11px}
  main{max-width:1050px;margin:40px auto 0}section{width:100%}[data-codex-composer-root]{min-width:0}
  .input-shell{border:1px solid #8885;border-radius:18px;padding:12px;background:#fff}
  html.dark .input-shell{background:#292929}[data-codex-composer]{min-height:54px;outline:none}
  footer{display:flex;justify-content:space-between;gap:12px;margin-top:10px}button{padding:5px 12px;border:0;border-radius:8px;background:#8882;color:inherit}
  [data-composer-rail]{margin-top:5px;color:#888;font-size:11px}
</style><aside>${row(A)}${row(B)}${row(REMOTE, 'remote-machine')}${row(CLOUD, 'local', 'chatgpt')}</aside>
<main>${composer(A, 'a', true)}${composer(B, 'b', false)}${composer('', 'home', false, 'home')}</main></html>`;

async function metricValues(page) {
  return page.locator(MARK + ' [data-metric]').evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [element.dataset.metric, element.textContent])));
}
async function assertBlank(page) {
  assert.deepEqual(await metricValues(page), Object.fromEntries(fields.map(field => [field, ''])));
}
async function update(page, perThread, checkedAt = Date.now(), ok = true) {
  await page.evaluate(data => window.__codexThreadMetrics.update(data), { ok, checkedAt, perThread });
}
async function select(page, name) {
  await page.evaluate(name => {
    for (const element of document.querySelectorAll('[data-page]')) {
      const active = element.dataset.page === name;
      element.setAttribute('data-app-shell-active-page', String(active));
      element.style.display = active ? '' : 'none';
    }
  }, name);
  await page.waitForTimeout(150);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 500 }, deviceScaleFactor: 2 });
    for (const theme of ['light', 'dark']) for (const width of [1180, 760, 384, 244, 204]) {
      await page.setViewportSize({ width, height: 560 });
      await page.setContent(fixture);
      await page.evaluate(theme => {
        document.documentElement.className = theme;
        window.originalEditors = [...document.querySelectorAll('[data-codex-composer]')];
        window.originalParents = window.originalEditors.map(editor => editor.parentElement);
        window.originalChildren = [...document.querySelector('[data-page="a"] [data-codex-composer-root]').children];
        window.sendCount = 0;
        document.querySelector('[data-page="a"] [data-send]').addEventListener('click', () => window.sendCount++);
      }, theme);
      await page.evaluate(`(${installThreadMetrics.toString()})()`);
      await update(page, { [A]: metrics });
      assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), [A]);
      assert.deepEqual(await metricValues(page), { rounds: '1', steps: '52', llmDurationMs: '37m54s', toolDurationMs: '25s',
        firstTokenAvgMs: '5.9s', tokensPerSecond: '42', cacheHitPercent: '97%', inputTokens: '5M', outputTokens: '8k' });
      const geometry = await page.locator(MARK).evaluate(element => {
        const root = element.parentElement;
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, rootBottom: root.getBoundingClientRect().bottom,
          nativeBottom: root.querySelector('[data-composer-rail]').getBoundingClientRect().bottom,
          overflow: element.scrollWidth > element.clientWidth,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          childOverflow: [...element.children].some(child => child.getBoundingClientRect().right > box.right + .5),
          color: getComputedStyle(element).color, editorText: root.querySelector('[data-codex-composer]').textContent };
      });
      assert.ok(geometry.top > geometry.nativeBottom, `${theme}/${width}: strip must appear below the whole input`);
      assert.ok(geometry.bottom <= geometry.rootBottom + .5);
      assert.equal(geometry.overflow, false, `${theme}/${width}: metrics must fit the input width`);
      assert.equal(geometry.childOverflow, false, `${theme}/${width}: grouped metrics must fit the input width`);
      assert.equal(geometry.pageOverflow, false, `${theme}/${width}: metrics must not widen the page`);
      assert.equal(geometry.editorText, '保留草稿');
      assert.equal(geometry.color, theme === 'dark' ? 'rgb(165, 169, 173)' : 'rgb(115, 119, 124)');
      assert.equal(await page.evaluate(() => window.originalEditors.every((editor, i) => editor.isConnected &&
        editor.parentElement === window.originalParents[i]) && window.originalChildren.every((child, i) =>
        document.querySelector('[data-page="a"] [data-codex-composer-root]').children[i] === child)), true);
      await page.locator('[data-page="a"] [data-send]').click();
      assert.equal(await page.evaluate(() => window.sendCount), 1, 'native send handler must be preserved');
      assert.equal(await page.locator('[data-page="b"] ' + MARK).count(), 0, 'hidden kept-alive pages receive no strip');
      for (let i = 0; i < 3; i++) await page.evaluate(`(${installThreadMetrics.toString()})()`);
      assert.equal(await page.locator(MARK).count(), 1);
      if (width === 760) {
        const output = path.join(__dirname, 'artifacts'); fs.mkdirSync(output, { recursive: true });
        await page.screenshot({ path: path.join(output, `thread-metrics-${theme}.png`) });
      }
      await page.evaluate(() => window.__codexThreadMetrics.destroy());
      assert.equal(await page.locator(MARK).count(), 0);
      assert.equal(await page.locator('#codex-thread-metrics-style').count(), 0);
    }

    await page.setViewportSize({ width: 760, height: 560 });
    await page.setContent(fixture);
    await page.evaluate(() => {
      const NativeObserver = window.MutationObserver;
      window.metricsObservers = 0; window.metricsRefreshSchedules = 0; window.metricsIntervals = new Set();
      window.MutationObserver = class extends NativeObserver {
        constructor(callback) { super(callback); this.active = false; }
        observe(...args) { if (!this.active) { this.active = true; window.metricsObservers++; } return super.observe(...args); }
        disconnect() { if (this.active) { this.active = false; window.metricsObservers--; } return super.disconnect(); }
      };
      const nativeTimeout = window.setTimeout, nativeInterval = window.setInterval, nativeClear = window.clearInterval;
      window.setTimeout = (callback, delay, ...args) => { if (delay === 80) window.metricsRefreshSchedules++; return nativeTimeout(callback, delay, ...args); };
      window.setInterval = (callback, delay, ...args) => { const id = nativeInterval(callback, delay, ...args); if (delay === 1000) window.metricsIntervals.add(id); return id; };
      window.clearInterval = id => { window.metricsIntervals.delete(id); return nativeClear(id); };
    });
    await page.evaluate(`(${installThreadMetrics.toString()})()`);
    await update(page, { [A]: metrics });
    for (let i = 0; i < 5; i++) await page.evaluate(`(${installThreadMetrics.toString()})()`);
    assert.deepEqual(await page.evaluate(() => [window.metricsObservers, window.metricsIntervals.size]), [1, 1]);
    await page.waitForTimeout(200);
    const schedules = await page.evaluate(() => window.metricsRefreshSchedules);
    await update(page, { [A]: { ...metrics, steps: 53 } });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.metricsRefreshSchedules), schedules, 'own metric text updates must not schedule observer refresh loops');

    await select(page, 'b');
    await assertBlank(page);
    assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), [B]);
    assert.equal(await page.locator('[data-page="a"] ' + MARK).count(), 0);
    assert.equal(await page.locator('[data-page="b"] ' + MARK).count(), 1);
    await update(page, { [B]: { rounds: 9, inputTokens: 0 } });
    assert.equal((await metricValues(page)).rounds, '9');
    assert.equal((await metricValues(page)).inputTokens, '0', 'zero is shown only when supplied');
    assert.equal((await metricValues(page)).llmDurationMs, '', 'unsupported fields remain blank');
    assert.match(await page.locator(MARK).textContent(), /LLM/);
    assert.match(await page.locator(MARK).textContent(), /首 token 平均/);
    assert.match(await page.locator(MARK).textContent(), /缓存命中/);
    await update(page, { [B]: metrics }, Date.now() - 31000);
    await assertBlank(page);
    assert.equal(await page.locator(MARK).getAttribute('data-state'), 'stale');
    await update(page, { [B]: metrics }, Date.now(), false);
    await assertBlank(page);
    await update(page, { [B]: metrics });
    await update(page, {});
    await assertBlank(page);

    // Invalid values must not become zero, NaN, an invented percent or a string.
    await update(page, { [B]: { rounds: -1, steps: 1.2, llmDurationMs: '1000', toolDurationMs: -100,
      firstTokenAvgMs: 'no', tokensPerSecond: -2, cacheHitPercent: 101, inputTokens: 1.1, outputTokens: null } });
    await assertBlank(page);
    await update(page, { [B]: { ...metrics, complete: false } });
    assert.match(await page.locator(MARK).getAttribute('title'), /本地记录不完整/);
    await update(page, { [B]: { ...metrics, timingApproximate: true } });
    assert.equal((await metricValues(page)).llmDurationMs, '≈37m54s');
    assert.equal((await metricValues(page)).tokensPerSecond, '≈42');
    assert.equal((await metricValues(page)).firstTokenAvgMs, '5.9s', 'approximate response timings must not relabel logged first-token measurements');

    for (const id of [REMOTE, CLOUD, UNKNOWN]) {
      await page.locator('[data-page="b"] [data-above-composer-conversation-id]').evaluate((el, id) =>
        el.setAttribute('data-above-composer-conversation-id', id), id);
      await update(page, { [id]: metrics, [B]: metrics });
      await assertBlank(page);
      assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), [], 'only explicitly local threads may be requested');
    }
    // Sidebar selection does not override a conflicting composer identity.
    await page.locator('[data-page="b"] [data-above-composer-conversation-id]').evaluate((el, id) => {
      el.setAttribute('data-above-composer-conversation-id', id);
      const conflict = el.cloneNode(); conflict.setAttribute('data-above-composer-conversation-id', '00000000-0000-0000-0000-000000000001'); el.after(conflict);
    }, B);
    await update(page, { [A]: metrics, [B]: metrics });
    await assertBlank(page);
    assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), []);
    await select(page, 'home');
    assert.equal(await page.locator(MARK).count(), 0, 'new-chat input must not show the previous thread metrics');
    assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), []);

    // Rerenders may discard the owned strip. Repair without moving native nodes.
    await select(page, 'a');
    await update(page, { [A]: metrics });
    await page.locator('[data-page="a"] [data-codex-composer-root]').evaluate(root => root.replaceWith(root.cloneNode(true)));
    await page.waitForTimeout(180);
    assert.equal(await page.locator(MARK).count(), 1);
    assert.equal((await metricValues(page)).rounds, '1');
    await page.locator(MARK).evaluate(strip => strip.remove());
    await page.waitForTimeout(1100);
    assert.equal(await page.locator(MARK).count(), 1, 'repair externally removed strip');
    await page.evaluate(() => window.__codexThreadMetrics.destroy());
    assert.deepEqual(await page.evaluate(() => [window.metricsObservers, window.metricsIntervals.size]), [0, 0]);
    await page.evaluate(() => document.body.append(document.createElement('div')));
    await page.waitForTimeout(150);
    assert.equal(await page.locator(MARK).count(), 0, 'destroyed installer must not recreate itself');
    console.log('PASS Thread metrics footer: live composer structure, both themes, narrow layout, preserved input controls, local identity, kept-alive page switching, blanks/staleness, reinjection, observer loops and cleanup');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
