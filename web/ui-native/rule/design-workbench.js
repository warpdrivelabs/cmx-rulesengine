/*
 * portal.rules.design-workbench —— 决策集设计工作台（native_pages 四区，列表层）。
 *
 * 模块级单例，export default { defaultView, views:{explorer,content,property} }。门户为每区渲一个
 * host，按 view 分派。四区：
 *   explorer —— 决策集列表（点击选中，跨区广播）
 *   content  —— 选中决策的决策表只读预览（输入列/规则行/输出列网格）
 *   property —— 定义详情 + 发布/版本 + gap/overlap 完整性分析（超越 ZEN 的世界级能力）
 *
 * URL 一律写 /api/rules/v1/*（门户壳 apiBase='' 同源；可嵌壳指远程）。契约 {code,msg,data}。
 * 真正可编辑的决策表设计器（多实例、cmx-revo-grid + cmx-fx-editor）是 F3 的 portal.rules.designer。
 */

// ── 可被壳覆盖的接缝 ──
const CFG = {
  apiBase: '',
  fetchInit: { credentials: 'same-origin' },
  authHeaders: () => ({}),
  onOpenDesigner: null, // F3：委托打开多实例设计器
};
export function configure(o) { Object.assign(CFG, o || {}); return CFG; }

// ── 模块级状态（单实例页；跨区靠 state + refreshView）──
const state = { list: [], selectedKey: null, detail: null, analysis: null, hosts: new Set() };

// ── 信封解包 fetch ──
async function apiJson(url, options = {}) {
  const full = (CFG.apiBase && url.charAt(0) === '/') ? CFG.apiBase + url : url;
  const res = await fetch(full, {
    ...CFG.fetchInit, ...options,
    headers: { Accept: 'application/json', ...CFG.authHeaders(), ...(options.headers || {}) },
  });
  let j = null; try { j = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || (j && typeof j.code === 'number' && j.code !== 0)) {
    throw new Error((j && (j.msg || j.error)) || `HTTP ${res.status}`);
  }
  return j && typeof j === 'object' && 'data' in j ? j.data : j;
}

// ── 数据加载 ──
async function loadList() {
  try { state.list = await apiJson('/api/rules/v1/definitions') || []; }
  catch (e) { state.list = []; console.warn('装载决策集失败', e); }
  refreshView('explorer');
}
async function selectDecision(key) {
  state.selectedKey = key; state.detail = null; state.analysis = null;
  refreshView('explorer'); refreshView('content'); refreshView('property');
  try {
    state.detail = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(key));
    state.analysis = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(key) + '/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch (e) { console.warn('装载定义/分析失败', e); }
  refreshView('content'); refreshView('property');
}
async function publish(key) {
  try {
    const r = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(key) + '/publish', { method: 'POST' });
    await loadList(); await selectDecision(key);
    flash('已发布 v' + (r && r.version));
  } catch (e) { flash('发布失败: ' + e.message, true); }
}

// ── native-page 视图入口 ──
function hostRoot(host) { return host?.renderRoot || host?.shadowRoot?.querySelector('.np-root') || host; }
function mount(ctx, view) {
  const host = ctx.host; state.hosts.add(host); host.__ruleView = view;
  const render = () => {
    const root = hostRoot(host);
    if (!root || (root.isConnected === false)) return;
    root.innerHTML = `<style>${styleCss()}</style>${viewHtml(view)}`;
    bind(root, view);
  };
  requestAnimationFrame(() => { render(); if (view === 'explorer' && !state.list.length) loadList(); });
  return `<style>${styleCss()}</style>${viewHtml(view)}`;
}
function refreshView(view) {
  for (const host of state.hosts) {
    if (host.__ruleView !== view) continue;
    const root = hostRoot(host);
    if (!root || root.isConnected === false) continue;
    root.innerHTML = `<style>${styleCss()}</style>${viewHtml(view)}`;
    bind(root, view);
  }
}

// ── 四区 HTML ──
function viewHtml(view) {
  if (view === 'explorer') return explorerHtml();
  if (view === 'property') return propertyHtml();
  return contentHtml();
}
function explorerHtml() {
  const rows = state.list.map(d => `
    <li class="np-item ${d.key === state.selectedKey ? 'sel' : ''}" data-key="${esc(d.key)}">
      <span class="np-dot ${d.published ? 'pub' : 'draft'}"></span>
      <span class="np-nm">${esc(d.name || d.key)}</span>
      <span class="np-ver">v${d.version ?? 1}</span>
    </li>`).join('');
  return `<div class="np-root">
    <div class="np-hd">决策集 <button class="np-btn xs" data-act="reload">刷新</button></div>
    <ul class="np-list">${rows || '<li class="np-empty">暂无决策集</li>'}</ul>
  </div>`;
}
function contentHtml() {
  if (!state.selectedKey) return `<div class="np-root"><div class="np-placeholder">从左侧选择一个决策集</div></div>`;
  const d = state.detail;
  if (!d) return `<div class="np-root"><div class="np-placeholder">加载中…</div></div>`;
  const inputs = d.inputs || [], outputs = d.outputs || [], rules = d.rules || [];
  const head = `<tr><th>#</th>${inputs.map(c => `<th class="in">${esc(c.label || c.expression)}</th>`).join('')}${outputs.map(c => `<th class="out">${esc(c.label || c.name)}</th>`).join('')}</tr>`;
  const body = rules.map((r, i) => `<tr>
    <td class="idx">${i}</td>
    ${(r.inputEntries || []).map(v => `<td class="in">${esc(v || '-')}</td>`).join('')}
    ${(r.outputEntries || []).map(v => `<td class="out">${esc(v)}</td>`).join('')}
  </tr>`).join('');
  return `<div class="np-root">
    <div class="np-hd">${esc(d.name || d.key)} · 命中策略 <b>${esc(d.hitPolicy || 'U')}</b>
      <button class="np-btn xs" data-act="open-designer">编辑（F3）</button></div>
    <div class="np-tablewrap"><table class="np-dt"><thead>${head}</thead><tbody>${body}</tbody></table></div>
  </div>`;
}
function propertyHtml() {
  if (!state.selectedKey) return `<div class="np-root"><div class="np-placeholder">未选择</div></div>`;
  const d = state.detail, a = state.analysis;
  const analysisHtml = a ? `
    <div class="np-analysis">
      <div class="np-badge ${a.complete ? 'ok' : 'warn'}">${a.complete ? '✓ 无空隙' : '⚠ 有空隙 ' + (a.gaps || []).length}</div>
      <div class="np-badge ${a.hasOverlap ? 'warn' : 'ok'}">${a.hasOverlap ? '⚠ 有重叠 ' + (a.overlaps || []).length : '✓ 无重叠'}</div>
      ${(a.gaps || []).slice(0, 6).map(g => `<div class="np-gap">${esc(g.description)}</div>`).join('')}
      ${(a.overlaps || []).slice(0, 6).map(o => `<div class="np-gap">${esc(o.description)}</div>`).join('')}
    </div>` : '<div class="np-placeholder">分析中…</div>';
  return `<div class="np-root">
    <div class="np-hd">定义详情</div>
    <div class="np-kv"><span>键</span><b>${esc(state.selectedKey)}</b></div>
    <div class="np-kv"><span>名称</span><b>${esc(d?.name || '')}</b></div>
    <div class="np-kv"><span>版本</span><b>v${d?.version ?? 1}</b></div>
    <div class="np-hd">完整性分析<span class="np-sub">gap / overlap · 超越 ZEN</span></div>
    ${analysisHtml}
    <div class="np-actions">
      <button class="np-btn" data-act="publish">发布当前版本</button>
    </div>
  </div>`;
}

// ── 打开决策表设计器（多实例，openWorkNode 动态开成 Tab）──
function dispatchPortalAction(sourceEl, detail) {
  const ev = new CustomEvent('portal-help-action', { detail, bubbles: true, composed: true });
  try { (sourceEl?.dispatchEvent ? sourceEl : document).dispatchEvent(ev); return true; }
  catch { try { document.dispatchEvent(new CustomEvent('portal-help-action', { detail, bubbles: true, composed: true })); return true; } catch { return false; } }
}
async function openWorkNode(workNode, sourceEl) {
  for (const t of [window, window.parent, window.top, globalThis].filter(Boolean)) {
    try {
      if (typeof t.openTab === 'function') { t.openTab(workNode); return true; }
      if (typeof t.openWorkspaceNode === 'function') { t.openWorkspaceNode(workNode); return true; }
    } catch { /* */ }
  }
  const inlineDetail = { kind: 'inlineNode', node: workNode, icon: workNode.icon || 'table-view', title: workNode.caption || workNode.name || workNode.id };
  if (dispatchPortalAction(sourceEl, inlineDetail)) return true;
  try {
    await apiJson('/api/workspace-nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: workNode.id, name: workNode.caption || workNode.name || workNode.id, icon: workNode.icon || 'table-view', details: `决策表设计器工作区：${workNode.id}`, workspace: workNode.workspace }) });
    return true;
  } catch { /* */ }
  try {
    window.parent?.postMessage({ type: 'openTab', payload: workNode }, '*');
    window.top?.postMessage({ type: 'openTab', payload: workNode }, '*');
    document.dispatchEvent(new CustomEvent('cmx-open-workspace-node', { detail: { workNode, menu: workNode }, bubbles: true, composed: true }));
  } catch { /* */ }
  return true;
}
function designerView(id, view, tabLabel, icon, props) {
  return { id, tabLabel, icon, type: 'native_pages', native_page: 'portal.rules.designer', view, props };
}
function openDesigner(sourceEl) {
  const d = state.detail || {};
  const key = state.selectedKey; if (!key) return;
  const version = d.version ?? 1;
  const props = { key, name: d.name || key, version };
  const slug = String(key).replace(/[^a-zA-Z0-9]+/g, '_');
  const sid = `${slug}_${version}`;
  const menu = {
    id: `rules-designer-${sid}`, code: `rules-designer-${sid}`,
    name: `rules-designer-${sid}`, caption: `${d.name || key} · 决策表设计器`,
    type: 'workspace-node', icon: 'table-view', openType: 0, status: 1,
    workspace: {
      id: `rules_designer_${sid}`, params: props, explorerWidth: 300, propertyWidth: 340,
      model: { id: `rules-designer-${sid}-model`, type: 'native_pages', native_page: 'portal.rules.designer', view: 'content', props },
      explorer: { caption: '设计资源', icon: 'database', views: [designerView(`rules-designer-${sid}-fields`, 'explorer', '字段/函数', 'database', props)] },
      content: { caption: '决策表', icon: 'table-view', views: [designerView(`rules-designer-${sid}-grid`, 'content', '决策表', 'table-view', props)] },
      property: { caption: '属性', icon: 'detail-view', views: [designerView(`rules-designer-${sid}-prop`, 'property', '完整性', 'detail-view', props)] },
    },
  };
  openWorkNode(menu, sourceEl);
}

// ── 事件委托 ──
function bind(root, view) {
  root.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-key]');
    if (item) { selectDecision(item.getAttribute('data-key')); return; }
    const act = ev.target.closest('[data-act]')?.getAttribute('data-act');
    if (!act) return;
    if (act === 'reload') loadList();
    else if (act === 'publish' && state.selectedKey) publish(state.selectedKey);
    else if (act === 'open-designer') openDesigner(ev.target);
  }, { once: false });
}

function flash(msg, err) {
  try {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:9999;padding:10px 18px;border-radius:8px;font-size:13px;color:#fff;background:${err ? '#d9534f' : '#2e7d5b'};box-shadow:0 4px 16px rgba(0,0,0,.25)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  } catch { /* 无 document */ }
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function styleCss() {
  return `
  .np-root{font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--sapTextColor,#32363a);height:100%;box-sizing:border-box;padding:8px 10px;overflow:auto}
  .np-hd{font-weight:600;font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);margin:10px 0 6px;display:flex;align-items:center;gap:8px}
  .np-sub{font-weight:400;color:var(--sapNeutralColor,#8b97b3);font-size:11px}
  .np-list{list-style:none;margin:0;padding:0}
  .np-item{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer}
  .np-item:hover{background:var(--sapList_Hover_Background,#f2f3f4)}
  .np-item.sel{background:var(--sapList_SelectionBackgroundColor,#e5f0fa)}
  .np-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
  .np-dot.pub{background:#2e7d5b}.np-dot.draft{background:#c0c4c8}
  .np-nm{flex:1;font-weight:500}.np-ver{font-size:11px;color:#8b97b3}
  .np-empty,.np-placeholder{color:#8b97b3;padding:16px 10px;text-align:center}
  .np-btn{border:1px solid var(--sapButton_BorderColor,#0a6ed1);background:var(--sapButton_Background,#fff);color:var(--sapButton_TextColor,#0a6ed1);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer}
  .np-btn:hover{background:var(--sapButton_Hover_Background,#ebf5ff)}
  .np-btn.xs{padding:2px 8px;font-size:11px}
  .np-tablewrap{overflow:auto;border:1px solid var(--sapList_BorderColor,#e5e5e5);border-radius:8px}
  .np-dt{border-collapse:collapse;width:100%;font-size:12px}
  .np-dt th,.np-dt td{border:1px solid var(--sapList_BorderColor,#ededed);padding:5px 9px;text-align:left;white-space:nowrap}
  .np-dt th{background:var(--sapList_HeaderBackground,#f7f7f7);font-weight:600}
  .np-dt th.in,.np-dt td.in{background:rgba(10,110,209,.04)}
  .np-dt th.out,.np-dt td.out{background:rgba(46,125,91,.05)}
  .np-dt td.idx{color:#8b97b3;text-align:center}
  .np-kv{display:flex;gap:8px;padding:4px 0}.np-kv span{color:#8b97b3;width:44px}
  .np-analysis{display:flex;flex-direction:column;gap:6px}
  .np-badge{display:inline-block;width:fit-content;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:600}
  .np-badge.ok{background:rgba(46,125,91,.12);color:#2e7d5b}
  .np-badge.warn{background:rgba(217,131,79,.14);color:#b5651d}
  .np-gap{font-size:11px;color:#b5651d;padding:2px 0}
  .np-actions{margin-top:14px}
  `;
}

export { mount };
export default {
  defaultView: 'content',
  views: {
    async explorer(ctx) { return mount(ctx, 'explorer'); },
    async content(ctx) { return mount(ctx, 'content'); },
    async property(ctx) { return mount(ctx, 'property'); },
  },
};
