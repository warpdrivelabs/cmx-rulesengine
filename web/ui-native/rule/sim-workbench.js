/*
 * portal.rules.sim-workbench —— 决策应用/仿真工作台（native_pages 四区，列表层）。
 *
 * 四区：
 *   explorer —— 决策集列表（选中）
 *   content  —— 选中决策的输入事实 facts 表单 + 「求值」→ 输出 + 命中行 + 逐节点 trace
 *   property —— 输出详情 + trace 逐节点归因（失败节点红标）—— 把 R0 已产出的可解释性可视化
 *
 * 走 /simulate（不落审计日志，设计期试算）。真正的多实例仿真台（场景集/批跑）是 F4 的
 * portal.rules.simulator。
 */

const CFG = { apiBase: '', fetchInit: { credentials: 'same-origin' }, authHeaders: () => ({}) };
export function configure(o) { Object.assign(CFG, o || {}); return CFG; }

const state = { list: [], selectedKey: null, detail: null, facts: {}, result: null, hosts: new Set() };

async function apiJson(url, options = {}) {
  const full = (CFG.apiBase && url.charAt(0) === '/') ? CFG.apiBase + url : url;
  const res = await fetch(full, {
    ...CFG.fetchInit, ...options,
    headers: { Accept: 'application/json', ...CFG.authHeaders(), ...(options.headers || {}) },
  });
  let j = null; try { j = await res.json(); } catch { /* */ }
  if (!res.ok || (j && typeof j.code === 'number' && j.code !== 0)) {
    throw new Error((j && (j.msg || j.error)) || `HTTP ${res.status}`);
  }
  return j && typeof j === 'object' && 'data' in j ? j.data : j;
}

async function loadList() {
  try { state.list = await apiJson('/api/rules/v1/definitions') || []; } catch { state.list = []; }
  refreshView('explorer');
}
async function selectDecision(key) {
  state.selectedKey = key; state.detail = null; state.facts = {}; state.result = null;
  refreshView('explorer'); refreshView('content'); refreshView('property');
  try { state.detail = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(key)); } catch { /* */ }
  refreshView('content');
}
async function evaluate() {
  if (!state.selectedKey) return;
  // facts 值智能转型：纯数字→number，true/false→bool，否则 string。
  const input = {};
  for (const [k, raw] of Object.entries(state.facts)) {
    if (raw === '' || raw == null) continue;
    if (/^-?\d+(\.\d+)?$/.test(raw)) input[k] = Number(raw);
    else if (raw === 'true' || raw === 'false') input[k] = raw === 'true';
    else input[k] = raw;
  }
  try {
    state.result = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(state.selectedKey) + '/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, options: { trace: true } }),
    });
  } catch (e) { state.result = { error: e.message }; }
  refreshView('content'); refreshView('property');
}

function hostRoot(host) { return host?.renderRoot || host?.shadowRoot?.querySelector('.np-root') || host; }
function mount(ctx, view) {
  const host = ctx.host; state.hosts.add(host); host.__ruleView = view;
  const render = () => {
    const root = hostRoot(host);
    if (!root || root.isConnected === false) return;
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
    </li>`).join('');
  return `<div class="np-root"><div class="np-hd">决策集</div>
    <ul class="np-list">${rows || '<li class="np-empty">暂无决策集</li>'}</ul></div>`;
}
function contentHtml() {
  if (!state.selectedKey) return `<div class="np-root"><div class="np-placeholder">从左侧选择决策集，输入事实后求值</div></div>`;
  const d = state.detail;
  if (!d) return `<div class="np-root"><div class="np-placeholder">加载中…</div></div>`;
  const inputs = d.inputs || [];
  const fields = inputs.map(c => {
    const key = c.expression;
    return `<label class="np-field"><span>${esc(c.label || key)}</span>
      <input class="np-in" data-fact="${esc(key)}" value="${esc(state.facts[key] ?? '')}" placeholder="${esc(key)}"/></label>`;
  }).join('');
  const r = state.result;
  let out = '';
  if (r && r.error) out = `<div class="np-out err">求值失败：${esc(r.error)}</div>`;
  else if (r) {
    const failure = r.failure;
    out = `<div class="np-out ${failure ? 'err' : 'ok'}">
      <div class="np-outhd">${failure ? '⚠ 决策失败' : '✓ 决策输出'} · ${r.timingUs}µs</div>
      <pre class="np-json">${esc(JSON.stringify(r.output, null, 2))}</pre>
      ${failure ? `<div class="np-fail">失败归因：${esc(failure)}</div>` : ''}
    </div>`;
  }
  return `<div class="np-root">
    <div class="np-hd">${esc(d.name || d.key)} · 输入事实</div>
    <div class="np-form">${fields || '<div class="np-placeholder">该决策无输入列</div>'}</div>
    <div class="np-actions"><button class="np-btn primary" data-act="eval">求值</button>
      <button class="np-btn" data-act="open-sim">打开仿真台</button></div>
    ${out}
  </div>`;
}
function propertyHtml() {
  const r = state.result;
  if (!r || r.error) return `<div class="np-root"><div class="np-placeholder">求值后在此查看逐节点 trace</div></div>`;
  const trace = r.trace || [];
  const nodes = trace.map(t => `
    <div class="np-node ${t.failure ? 'fail' : (t.matchedRules || []).length ? 'hit' : 'miss'}">
      <div class="np-nodehd">${esc(t.nodeId)} <span class="np-tag">${esc(t.nodeKind)}</span> <span class="np-us">${t.timingUs}µs</span></div>
      <div class="np-noderow">命中规则行：${(t.matchedRules || []).length ? (t.matchedRules).join(', ') : '无'}</div>
      ${t.failure ? `<div class="np-fail">${esc(t.failure)}</div>` : ''}
      <pre class="np-json sm">${esc(JSON.stringify(t.output))}</pre>
    </div>`).join('');
  return `<div class="np-root">
    <div class="np-hd">决策轨迹 trace<span class="np-sub">逐节点归因 · 超越 ZEN</span></div>
    ${nodes || '<div class="np-placeholder">无 trace</div>'}
  </div>`;
}

function bind(root, view) {
  root.addEventListener('input', (ev) => {
    const f = ev.target.closest('[data-fact]');
    if (f) state.facts[f.getAttribute('data-fact')] = f.value;
  });
  root.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-key]');
    if (item) { selectDecision(item.getAttribute('data-key')); return; }
    const act = ev.target.closest('[data-act]')?.getAttribute('data-act');
    if (act === 'eval') evaluate();
    else if (act === 'open-sim') openSimulator(ev.target);
  });
}

// ── 打开决策仿真台（多实例，openWorkNode 动态开成 Tab）──
function dispatchPortalAction(sourceEl, detail) {
  const ev = new CustomEvent('portal-help-action', { detail, bubbles: true, composed: true });
  try { (sourceEl?.dispatchEvent ? sourceEl : document).dispatchEvent(ev); return true; }
  catch { try { document.dispatchEvent(new CustomEvent('portal-help-action', { detail, bubbles: true, composed: true })); return true; } catch { return false; } }
}
async function openWorkNode(workNode, sourceEl) {
  for (const t of [window, window.parent, window.top, globalThis].filter(Boolean)) {
    try { if (typeof t.openTab === 'function') { t.openTab(workNode); return true; } if (typeof t.openWorkspaceNode === 'function') { t.openWorkspaceNode(workNode); return true; } } catch { /* */ }
  }
  if (dispatchPortalAction(sourceEl, { kind: 'inlineNode', node: workNode, icon: workNode.icon || 'play', title: workNode.caption || workNode.id })) return true;
  try { await apiJson('/api/workspace-nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: workNode.id, name: workNode.caption || workNode.id, icon: workNode.icon || 'play', details: `决策仿真台工作区：${workNode.id}`, workspace: workNode.workspace }) }); return true; } catch { /* */ }
  try { window.parent?.postMessage({ type: 'openTab', payload: workNode }, '*'); window.top?.postMessage({ type: 'openTab', payload: workNode }, '*'); document.dispatchEvent(new CustomEvent('cmx-open-workspace-node', { detail: { workNode, menu: workNode }, bubbles: true, composed: true })); } catch { /* */ }
  return true;
}
function simView(id, view, tabLabel, icon, props) { return { id, tabLabel, icon, type: 'native_pages', native_page: 'portal.rules.simulator', view, props }; }
function openSimulator(sourceEl) {
  const key = state.selectedKey; if (!key) return;
  const d = state.detail || {}; const version = d.version ?? 1;
  const props = { key, name: d.name || key, version };
  const sid = `${String(key).replace(/[^a-zA-Z0-9]+/g, '_')}_${version}`;
  const menu = {
    id: `rules-sim-${sid}`, code: `rules-sim-${sid}`, name: `rules-sim-${sid}`, caption: `${d.name || key} · 仿真台`,
    type: 'workspace-node', icon: 'play', openType: 0, status: 1,
    workspace: {
      id: `rules_sim_${sid}`, params: props, explorerWidth: 300, propertyWidth: 340,
      model: { id: `rules-sim-${sid}-model`, type: 'native_pages', native_page: 'portal.rules.simulator', view: 'content', props },
      explorer: { caption: '用例', icon: 'test', views: [simView(`rules-sim-${sid}-cases`, 'explorer', '用例', 'test', props)] },
      content: { caption: '求值', icon: 'play', views: [simView(`rules-sim-${sid}-eval`, 'content', '求值', 'play', props)] },
      property: { caption: '轨迹', icon: 'detail-view', views: [simView(`rules-sim-${sid}-trace`, 'property', 'trace', 'detail-view', props)] },
    },
  };
  openWorkNode(menu, sourceEl);
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function styleCss() {
  return `
  .np-root{font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--sapTextColor,#32363a);height:100%;box-sizing:border-box;padding:8px 10px;overflow:auto}
  .np-hd{font-weight:600;font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);margin:10px 0 6px;display:flex;align-items:center;gap:8px}
  .np-sub{font-weight:400;color:#8b97b3;font-size:11px}
  .np-list{list-style:none;margin:0;padding:0}
  .np-item{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer}
  .np-item:hover{background:var(--sapList_Hover_Background,#f2f3f4)}
  .np-item.sel{background:var(--sapList_SelectionBackgroundColor,#e5f0fa)}
  .np-dot{width:8px;height:8px;border-radius:50%}.np-dot.pub{background:#2e7d5b}.np-dot.draft{background:#c0c4c8}
  .np-nm{flex:1;font-weight:500}
  .np-empty,.np-placeholder{color:#8b97b3;padding:16px 10px;text-align:center}
  .np-form{display:flex;flex-direction:column;gap:8px}
  .np-field{display:flex;flex-direction:column;gap:3px}.np-field span{font-size:11px;color:#8b97b3}
  .np-in{border:1px solid var(--sapField_BorderColor,#c9ced4);border-radius:6px;padding:6px 9px;font-size:13px;background:var(--sapField_Background,#fff);color:inherit}
  .np-in:focus{outline:none;border-color:#0a6ed1}
  .np-btn{border:1px solid #0a6ed1;background:#fff;color:#0a6ed1;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer}
  .np-btn.primary{background:#0a6ed1;color:#fff}.np-btn.primary:hover{background:#085caf}
  .np-actions{margin-top:12px}
  .np-out{margin-top:14px;border-radius:8px;padding:10px 12px}
  .np-out.ok{background:rgba(46,125,91,.08);border:1px solid rgba(46,125,91,.25)}
  .np-out.err{background:rgba(217,83,79,.08);border:1px solid rgba(217,83,79,.3)}
  .np-outhd{font-weight:600;font-size:12px;margin-bottom:6px}
  .np-json{margin:0;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:inherit}
  .np-json.sm{font-size:11px;color:#6a6d70;margin-top:4px}
  .np-fail{color:#c0392b;font-size:11px;margin-top:6px}
  .np-node{border:1px solid var(--sapList_BorderColor,#e5e5e5);border-left-width:3px;border-radius:7px;padding:8px 10px;margin-bottom:8px}
  .np-node.hit{border-left-color:#2e7d5b}.np-node.miss{border-left-color:#c0c4c8}.np-node.fail{border-left-color:#c0392b;background:rgba(217,83,79,.05)}
  .np-nodehd{font-weight:600;font-size:12px;display:flex;align-items:center;gap:8px}
  .np-tag{font-size:10px;background:#eef1f5;color:#6a6d70;padding:1px 6px;border-radius:8px}
  .np-us{margin-left:auto;font-size:10px;color:#8b97b3}
  .np-noderow{font-size:11px;color:#6a6d70;margin-top:3px}
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
