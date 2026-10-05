function installThreadMetrics() {
  const VERSION = 2;
  const KEY = '__codexThreadMetrics';
  const MARK = 'data-codex-thread-metrics';
  const ROOT = '[data-codex-composer-root][data-composer-placement="thread"]';
  const ROW = '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]';
  const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (window[KEY]?.version === VERSION) { window[KEY].refresh(); return; }
  window[KEY]?.destroy?.();
  let disposed = false;
  let refreshTimer = null;
  let composer = null;
  let threadId = null;
  let snapshot = { ok: false, checkedAt: null, perThread: {} };
  const strip = document.createElement('div');
  strip.setAttribute(MARK, '');
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', '当前会话运行指标');
  strip.hidden = true;
  const style = document.createElement('style');
  style.id = 'codex-thread-metrics-style';
  style.textContent = `
    [${MARK}] {
      --thread-metrics-text: #73777c; --thread-metrics-divider: #73777c66;
      box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center;
      flex: 0 0 auto; gap: 3px 9px; width: 100%; min-width: 0; max-width: 100%;
      margin: 7px 0 0; padding: 0 2px 2px; color: var(--color-text-secondary, var(--thread-metrics-text));
      font-family: inherit; font-size: 11px; font-weight: 400; line-height: 1.6;
      font-variant-numeric: tabular-nums; -webkit-app-region: no-drag;
    }
    [${MARK}][hidden] { display: none !important; }
    [${MARK}] .thread-metrics-group { display: block; flex: 0 1 auto;
      min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
    [${MARK}] .thread-metrics-group:not(:last-child)::after {
      content: '|'; margin-left: 9px; color: var(--thread-metrics-divider);
    }
    [${MARK}] .thread-metrics-value { display: inline-block; min-width: .35em; white-space: nowrap; }
    html.dark [${MARK}], html[data-theme="dark"] [${MARK}] {
      --thread-metrics-text: #a5a9ad; --thread-metrics-divider: #a5a9ad88;
    }
    @media (prefers-color-scheme: dark) {
      html:not(.light):not([data-theme="light"]) [${MARK}] {
        --thread-metrics-text: #a5a9ad; --thread-metrics-divider: #a5a9ad88;
      }
    }
  `;
  const values = new Map();
  function group(parts) {
    const element = document.createElement('span');
    element.className = 'thread-metrics-group';
    for (const part of parts) {
      if (typeof part === 'string') element.append(document.createTextNode(part));
      else {
        const span = document.createElement('span');
        span.className = 'thread-metrics-value';
        span.dataset.metric = part.field;
        values.set(part.field, span); element.append(span);
      }
    }
    strip.append(element);
  }
  group([{ field: 'rounds' }, ' 轮 · ', { field: 'steps' }, ' 步']);
  group(['LLM ', { field: 'llmDurationMs' }, ' · 工具调用 ', { field: 'toolDurationMs' }]);
  group(['首 token 平均 ', { field: 'firstTokenAvgMs' }, ' · ', { field: 'tokensPerSecond' }, ' tok/s']);
  group(['缓存命中 ', { field: 'cacheHitPercent' }]);
  group(['输入 ', { field: 'inputTokens' }, ' tok · 输出 ', { field: 'outputTokens' }, ' tok']);
  const visible = el => {
    if (!el?.isConnected || el.closest('[hidden], [inert], [aria-hidden="true"], [data-app-shell-active-page="false"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  function discover() {
    const roots = [...document.querySelectorAll(ROOT)].filter(root => visible(root) && visible(root.querySelector('[data-codex-composer]')));
    // Multiple visible composers can belong to a modal or another pane. Do not
    // attach a different thread's data to an ambiguous input.
    if (roots.length !== 1) return { root: null, id: null };
    const root = roots[0];
    const ids = [...new Set([...root.querySelectorAll('[data-above-composer-conversation-id]')]
      .map(el => el.getAttribute('data-above-composer-conversation-id')).filter(Boolean))];
    if (ids.length !== 1 || !UUID.test(ids[0])) return { root, id: null };
    const id = ids[0];
    const matchingRows = [...document.querySelectorAll(ROW)]
      .filter(row => row.getAttribute('data-app-action-sidebar-thread-id') === `local:${id}`);
    // A bare conversation UUID does not identify its host. Confirm the local
    // thread from the app's sidebar metadata; cloud and remote inputs stay blank.
    const local = matchingRows.length > 0 && matchingRows.every(row =>
      row.getAttribute('data-app-action-sidebar-thread-host-id') === 'local' &&
      row.getAttribute('data-app-action-sidebar-thread-kind') === 'local');
    return { root, id: local ? id : null };
  }
  const nonnegative = number => typeof number === 'number' && Number.isFinite(number) && number >= 0;
  const count = number => Number.isSafeInteger(number) && number >= 0 ? number.toLocaleString('zh-CN') : '';
  const decimal = number => String(Number(number.toFixed(1)));
  function duration(number) {
    if (!nonnegative(number)) return '';
    if (number < 60000) return `${decimal(number / 1000)}s`;
    const total = Math.floor(number / 1000);
    const hours = Math.floor(total / 3600);
    return `${hours ? `${hours}h` : ''}${Math.floor(total % 3600 / 60)}m${total % 60}s`;
  }
  function tokens(number) {
    if (!Number.isSafeInteger(number) || number < 0) return '';
    for (const [divisor, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']])
      if (number >= divisor) return `${decimal(number / divisor)}${suffix}`;
    return String(number);
  }
  const formatters = {
    rounds: count, steps: count, llmDurationMs: duration, toolDurationMs: duration,
    firstTokenAvgMs: duration,
    tokensPerSecond: number => nonnegative(number) ? decimal(number) : '',
    cacheHitPercent: number => nonnegative(number) && number <= 100 ? `${decimal(number)}%` : '',
    inputTokens: tokens, outputTokens: tokens,
  };
  function render() {
    const stale = Number.isFinite(snapshot.checkedAt) && Date.now() - snapshot.checkedAt > 30000;
    const metric = threadId && snapshot.ok && !stale && Object.hasOwn(snapshot.perThread, threadId)
      ? snapshot.perThread[threadId] : null;
    let measured = null;
    if (threadId) try {
      const monitor = window.__codexThreadPerformance;
      const health = monitor?.status?.();
      const candidate = health?.supported === true && health.active === true && health.connected === true ? monitor.snapshot(threadId) : null;
      if (candidate?.timingApproximate === true && Number.isSafeInteger(candidate.observedResponses) && candidate.observedResponses > 0 &&
        nonnegative(candidate.observedSince) && nonnegative(candidate.lastSampleAt) &&
        candidate.lastSampleAt >= candidate.observedSince && candidate.lastSampleAt <= Date.now() + 1000) measured = candidate;
    } catch { /* A missing or replaced monitor leaves only the file-backed values. */ }
    let available = 0;
    for (const [field, span] of values) {
      const live = measured && ['llmDurationMs', 'tokensPerSecond'].includes(field) && nonnegative(measured[field]);
      const formatted = formatters[field](live ? measured[field] : metric?.[field]);
      const approximate = live || metric?.timingApproximate === true && ['llmDurationMs', 'tokensPerSecond'].includes(field);
      const text = formatted && approximate ? `≈${formatted}` : formatted;
      if (span.textContent !== text) span.textContent = text;
      if (text) available++;
    }
    const state = available ? 'ready' : stale ? 'stale' : 'unknown';
    if (strip.dataset.state !== state) strip.dataset.state = state;
    const id = threadId ?? '';
    if (strip.dataset.threadId !== id) strip.dataset.threadId = id;
    const reason = measured && !metric ? '当前会话的实时观测独立更新；本地累计记录暂不可读取。' :
      stale ? '数据已过期，等待重新连接。' : !metric ? '此会话暂无可读取的本地指标。' :
      metric.complete === false ? '本地记录不完整；无法确认的指标留空。' : '来自当前会话的本地会话记录；无法读取的指标留空。';
    const timing = '\nLLM：本次有效监测时段完整观测响应阶段的累计耗时，不回算历史。\n≈tok/s：客户端实测响应阶段均速，含推理/工具参数和通知延迟，扣除可观测的工具执行间隔；最近5次有效完整观测，非严格服务端生成速度。';
    const sample = measured ? `\n监测时段开始 ${new Date(measured.observedSince).toLocaleString('zh-CN')}；已完整观测 ${measured.observedResponses} 次响应。\n最近样本 ${new Date(measured.lastSampleAt).toLocaleString('zh-CN')}。` : '';
    const description = `${reason}\n轮数：开始的会话轮次。步数：已完成的模型响应数。\n工具调用：已配对工具调用的时间戳间隔（包括等待），并行区间合并。\n首 token：已完成轮次显式记录的首 token 延迟均值。缓存命中：缓存输入 Token / 输入 Token。${timing}${sample}`;
    if (strip.title !== description) strip.title = description;
  }
  function refresh() {
    if (disposed || !document.body) return;
    if (!style.isConnected) (document.head ?? document.documentElement).append(style);
    for (const duplicate of document.querySelectorAll(`[${MARK}]`)) if (duplicate !== strip) duplicate.remove();
    const next = discover();
    if (composer !== next.root) {
      if (composer) resizeObserver.unobserve(composer);
      composer = next.root;
      if (composer) resizeObserver.observe(composer);
    }
    threadId = next.id;
    render();
    strip.hidden = !composer;
    if (!composer) { strip.remove(); return; }
    // Append an owned child below the whole composer, without wrapping or
    // reparenting React's editor, controls, rail, or input decorations.
    if (strip.parentElement !== composer || strip !== composer.lastElementChild) composer.append(strip);
  }
  function scheduleRefresh() {
    if (disposed || refreshTimer !== null) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 80);
  }
  const owned = node => node === style || node === strip || strip.contains(node);
  const observer = new MutationObserver(records => {
    if (records.some(record => !owned(record.target) &&
      (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !owned(node))))) scheduleRefresh();
  });
  const resizeObserver = new ResizeObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-above-composer-conversation-id', 'data-composer-placement',
      'data-app-shell-active-page', 'data-app-action-sidebar-thread-id',
      'data-app-action-sidebar-thread-host-id', 'data-app-action-sidebar-thread-kind',
      'class', 'style', 'hidden', 'inert', 'aria-hidden'] });
  // Also repairs a strip removed by a native rerender, without observing our
  // own text updates and creating a mutation/placement loop.
  const freshnessTimer = setInterval(refresh, 1000);
  window.addEventListener('resize', scheduleRefresh);
  window.addEventListener('popstate', scheduleRefresh);
  window.addEventListener('hashchange', scheduleRefresh);
  document.addEventListener('visibilitychange', scheduleRefresh);
  window[KEY] = {
    version: VERSION, refresh,
    requestedIds() { const { id } = discover(); return id ? [id] : []; },
    update(next) {
      snapshot = { ok: next?.ok === true, checkedAt: Number.isFinite(next?.checkedAt) ? next.checkedAt : null,
        perThread: next?.perThread && typeof next.perThread === 'object' ? next.perThread : {} };
      refresh();
    },
    status() { return { version: VERSION, placed: strip.isConnected && !strip.hidden && visible(strip),
      threadId, state: strip.dataset.state, available: [...values.values()].filter(el => el.textContent !== '').length,
      checkedAt: snapshot.checkedAt, ok: snapshot.ok, stripCount: document.querySelectorAll(`[${MARK}]`).length }; },
    destroy() {
      disposed = true; observer.disconnect(); resizeObserver.disconnect();
      clearTimeout(refreshTimer); clearInterval(freshnessTimer);
      window.removeEventListener('resize', scheduleRefresh);
      window.removeEventListener('popstate', scheduleRefresh); window.removeEventListener('hashchange', scheduleRefresh);
      document.removeEventListener('visibilitychange', scheduleRefresh);
      strip.remove(); style.remove(); delete window[KEY];
    }
  };
  refresh();
}
