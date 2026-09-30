function installProjectSizes() {
  const VERSION = 2;
  const KEY = '__codexProjectSizes';
  const ROW = '[data-app-action-sidebar-project-row][data-app-action-sidebar-project-id]';
  const MARK = 'data-codex-project-size';
  if (window[KEY]?.version === VERSION) { window[KEY].refresh(); return; }
  window[KEY]?.destroy?.();
  let snapshot = { ok: false, sizes: {}, checkedAt: null };
  let received = false;
  let disposed = false;
  let refreshTimer = null;
  let bootstrapCache = null;
  let bootstrapReadAt = 0;
  const badges = new Map();
  const style = document.createElement('style');
  style.id = 'codex-project-sizes-style';
  style.textContent = `
    [${MARK}] { display: inline-block; flex: 0 0 auto; max-width: 74px; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: var(--color-text-tertiary, currentColor); opacity: .58;
      font: 500 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-variant-numeric: tabular-nums; letter-spacing: -.02em; user-select: none; }
    [${MARK}][data-state="pending"] { opacity: .36; }
    [${MARK}][data-state="error"], [${MARK}][data-state="unavailable"] { opacity: .34; }
  `;
  function identity(row) {
    const id = row?.getAttribute('data-app-action-sidebar-project-id');
    const kind = row?.querySelector('[data-sidebar-project-kind]')?.getAttribute('data-sidebar-project-kind')
      ?? row?.closest('[data-sidebar-project-kind]')?.getAttribute('data-sidebar-project-kind');
    return { id: typeof id === 'string' && id.length <= 512 ? id : null, kind };
  }
  function formatBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${Number(value.toFixed(digits))} ${units[unit]}`;
  }
  function reading(row) {
    const { id, kind } = identity(row);
    if (!id || kind !== 'local') return { state: 'unavailable', text: '—', detail: '此项目不是本地文件夹' };
    const value = snapshot.sizes[id];
    if (!received) return { state: 'pending', text: '…', detail: '正在计算项目文件夹大小' };
    if (!snapshot.ok) return { state: 'error', text: '—', detail: '暂时无法读取项目文件夹大小' };
    if (!value || value.state === 'pending') return { state: 'pending', text: '…', detail: '正在计算项目文件夹大小' };
    if (value.state !== 'ready' || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
      return { state: value?.state === 'error' ? 'error' : 'unavailable', text: '—',
        detail: value?.message || '项目文件夹不可用' };
    }
    const text = formatBytes(value.bytes);
    const roots = Array.isArray(value.roots) ? value.roots.filter(root => typeof root === 'string') : [];
    const suffix = value.stale ? '\n数据正在后台刷新' : '';
    return { state: 'ready', text, detail: `项目大小：${text}${roots.length ? `\n${roots.join('\n')}` : ''}${suffix}` };
  }
  function labelAndSlot(row) {
    const labelId = row.getAttribute('aria-labelledby');
    let label = labelId ? document.getElementById(labelId) : null;
    if (!label || !row.contains(label)) label = row.querySelector('[data-marquee-text]')?.parentElement ?? null;
    if (!label?.parentElement) return {};
    let slot = label.nextElementSibling;
    if (!slot || slot.matches('button, [role="button"]')) {
      slot = document.createElement('span');
      slot.setAttribute('data-codex-project-size-slot', '');
      label.after(slot);
    }
    return { label, slot };
  }
  function render(row, badge) {
    const value = reading(row);
    if (badge.textContent !== value.text) badge.textContent = value.text;
    if (badge.dataset.state !== value.state) badge.dataset.state = value.state;
    if (badge.title !== value.detail) badge.title = value.detail;
    if (badge.getAttribute('aria-label') !== value.detail.replaceAll('\n', '，')) badge.setAttribute('aria-label', value.detail.replaceAll('\n', '，'));
  }
  function refresh() {
    if (disposed || !document.body) return;
    if (!style.isConnected) (document.head ?? document.documentElement).append(style);
    const owned = new Set(badges.values());
    for (const badge of document.querySelectorAll(`[${MARK}]`)) if (!owned.has(badge)) badge.remove();
    for (const [row, badge] of badges) {
      const { slot } = labelAndSlot(row);
      if (!row.isConnected || !row.matches(ROW) || identity(row).kind !== 'local' || !slot || badge.parentElement !== slot) {
        badge.remove(); badges.delete(row);
      }
    }
    for (const row of document.querySelectorAll(ROW)) {
      const { id, kind } = identity(row);
      if (!id || kind !== 'local') continue;
      const { slot } = labelAndSlot(row);
      if (!slot) continue;
      let badge = badges.get(row);
      if (!badge) {
        badge = document.createElement('span'); badge.setAttribute(MARK, ''); badge.setAttribute('role', 'status');
        slot.append(badge); badges.set(row, badge);
      }
      render(row, badge);
    }
  }
  function scheduleRefresh() {
    if (disposed || refreshTimer !== null) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 80);
  }
  async function projectRoots() {
    if (bootstrapCache && Date.now() - bootstrapReadAt < 30000) return bootstrapCache;
    const map = Object.create(null);
    try {
      const bootstrap = await window.electronBridge?.getInitialSidebarBootstrap?.();
      const projects = bootstrap?.globalStateEntries?.find(entry => entry?.key === 'local-projects')?.value;
      if (projects && typeof projects === 'object') {
        for (const [id, project] of Object.entries(projects)) {
          const roots = Array.isArray(project?.rootPaths) ? project.rootPaths.filter(root => typeof root === 'string' && root.length <= 4096).slice(0, 8) : [];
          if (id.length <= 512 && roots.length) map[id] = roots;
        }
      }
    } catch {}
    bootstrapCache = map; bootstrapReadAt = Date.now(); return map;
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => !record.target.closest?.(`[${MARK}]`) && record.target !== style)) scheduleRefresh();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-app-action-sidebar-project-id', 'data-sidebar-project-kind', 'aria-labelledby'] });
  window[KEY] = {
    version: VERSION, refresh,
    async requestedProjects() {
      const roots = await projectRoots();
      const ids = [...new Set([...document.querySelectorAll(ROW)].map(row => identity(row)).filter(item => item.id && item.kind === 'local').map(item => item.id))].slice(0, 200);
      return ids.map(id => ({ id, roots: roots[id] ?? [] }));
    },
    invalidateProjects() { bootstrapCache = null; bootstrapReadAt = 0; },
    update(next) {
      snapshot = { ok: next?.ok === true, checkedAt: Number.isFinite(next?.checkedAt) ? next.checkedAt : null,
        sizes: next?.sizes && typeof next.sizes === 'object' ? next.sizes : {} };
      received = true; refresh();
    },
    status() { return { version: VERSION, badges: [...badges.values()].filter(el => el.isConnected).length,
      available: [...badges.values()].filter(el => el.isConnected && el.dataset.state === 'ready').length,
      pending: [...badges.values()].filter(el => el.isConnected && el.dataset.state === 'pending').length,
      source: 'local-project-roots', checkedAt: snapshot.checkedAt, ok: snapshot.ok }; },
    destroy() {
      disposed = true; observer.disconnect(); clearTimeout(refreshTimer);
      for (const badge of badges.values()) badge.remove(); badges.clear();
      for (const slot of document.querySelectorAll('[data-codex-project-size-slot]')) if (!slot.childNodes.length) slot.remove();
      style.remove(); delete window[KEY];
    }
  };
  refresh();
}
