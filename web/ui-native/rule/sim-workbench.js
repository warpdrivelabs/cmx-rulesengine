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

const state = { list: [], categories: [], collapsed: {}, selectedKey: null, detail: null, facts: {}, factsRaw: '', result: null, search: '', page: 1, hosts: new Set() };
const PAGE_SIZE = 12;
function visibleList() {
  const q = (state.search || '').trim().toLowerCase();
  const filtered = q ? state.list.filter(d => (d.name || '').toLowerCase().includes(q) || (d.key || '').toLowerCase().includes(q)) : state.list;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, state.page), pages);
  return { items: filtered.slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE), total, pages, page, filteredTotal: total };
}
// 过滤后按分类分桶（组顺序取分类字典 ord，未分类置底）——用于按分类分组折叠展示。
function groupedList() {
  const q = (state.search || '').trim().toLowerCase();
  const filtered = q ? state.list.filter(d => (d.name || '').toLowerCase().includes(q) || (d.key || '').toLowerCase().includes(q)) : state.list;
  const cats = state.categories || [];
  const known = new Set(cats.map(c => c.code));
  const buckets = new Map();
  for (const d of filtered) {
    const code = (d.categoryCode && known.has(d.categoryCode)) ? d.categoryCode : '';
    if (!buckets.has(code)) buckets.set(code, []);
    buckets.get(code).push(d);
  }
  const groups = [];
  for (const c of cats) if (buckets.has(c.code)) groups.push({ code: c.code, name: c.name || c.code, items: buckets.get(c.code) });
  if (buckets.has('')) groups.push({ code: '', name: '未分类', items: buckets.get('') });
  return { groups, filteredTotal: filtered.length };
}
function focusSearch(pos) {
  requestAnimationFrame(() => { for (const h of state.hosts) { if (h.__ruleView === 'explorer') { const inp = hostRoot(h)?.querySelector?.('#np-search'); if (inp) { inp.focus(); const p = pos == null ? inp.value.length : pos; try { inp.setSelectionRange(p, p); } catch { /* */ } } } } });
}

// FEEL 保留字/内置函数（不作事实变量）。
const FEEL_RESERVED = new Set(['if','then','else','and','or','not','true','false','null','for','in','return','some','every','satisfies','item','floor','ceiling','ceil','round','abs','modulo','sqrt','min','max','sum','mean','avg','upper','upperCase','lower','lowerCase','substring','contains','startsWith','startswith','endsWith','endswith','concatenate','concat','string','number','trim','count','length','len','sort','append','coalesce']);
function extractVars(expr, out) {
  if (!expr || typeof expr !== 'string') return;
  const stripped = expr.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/'(?:[^'\\]|\\.)*'/g, ' ');
  const re = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g; let m;
  while ((m = re.exec(stripped))) { if (stripped[re.lastIndex] === '(') continue; const root = m[0].split('.')[0]; if (!FEEL_RESERVED.has(root)) out.add(root); }
}
// 收集所有可录入变量：输入列 ∪ 输出/单元格/图节点表达式引用的自由变量（修复 BUG-003）。
function collectFactVars(d) {
  if (!d) return [];
  const vars = [], seen = new Set();
  const add = (name, label) => { if (name && !seen.has(name)) { seen.add(name); vars.push({ name, label: label || name }); } };
  const fromExpr = (e) => { const s = new Set(); extractVars(e, s); s.forEach(v => add(v)); };
  (d.inputs || []).forEach(c => { if (c.expression) add(c.expression, c.label); });
  (d.rules || []).forEach(r => { (r.inputEntries || []).forEach(fromExpr); (r.outputEntries || []).forEach(fromExpr); });
  (d.nodes || []).forEach(n => { if (n.table) collectFactVars(n.table).forEach(v => add(v.name, v.label)); (n.mappings || []).forEach(mp => fromExpr(mp.expression)); });
  return vars;
}

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
  try {
    const [list, cats] = await Promise.all([
      apiJson('/api/rules/v1/definitions'),
      apiJson('/api/rules/v1/categories').catch(() => []),
    ]);
    state.list = list || []; state.categories = cats || [];
  } catch { state.list = []; }
  refreshView('explorer');
}
async function selectDecision(key) {
  state.selectedKey = key; state.detail = null; state.facts = {}; state.factsRaw = ''; state.result = null;
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
  // 高级 JSON facts 覆盖同名字段。
  const rawTxt = (state.factsRaw || '').trim();
  let finalInput = input;
  if (rawTxt) { try { const j = JSON.parse(rawTxt); if (j && typeof j === 'object') finalInput = { ...input, ...j }; } catch { /* 非法忽略 */ } }
  try {
    state.result = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(state.selectedKey) + '/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: finalInput, options: { trace: true } }),
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
  const gl = groupedList();
  const groupsHtml = gl.groups.length
    ? gl.groups.map(g => {
        const gid = g.code || '__none__';
        const open = state.search ? true : !state.collapsed[gid];
        const rows = g.items.map(d => `
          <li class="np-item ${d.key === state.selectedKey ? 'sel' : ''}" data-key="${esc(d.key)}">
            <span class="np-dot ${d.published ? 'pub' : 'draft'}"></span>
            <span class="np-nm">${esc(d.name || d.key)}</span>
          </li>`).join('');
        return `<details class="np-grp"${open ? ' open' : ''} data-grp="${esc(gid)}">
          <summary class="np-grp-hd"><span class="np-grp-nm">${esc(g.name)}</span><span class="np-sub">${g.items.length}</span></summary>
          <ul class="np-list-inner">${rows}</ul>
        </details>`;
      }).join('')
    : `<div class="np-empty">${state.list.length ? '无匹配决策集' : '暂无决策集'}</div>`;
  return `<div class="np-root np-explorer">
    <div class="np-hd">决策集<span class="np-sub">${gl.filteredTotal}${gl.filteredTotal !== state.list.length ? '/' + state.list.length : ''}</span></div>
    <div class="np-searchbar">
      <span class="np-searchwrap"><input class="np-in np-search" id="np-search" placeholder="查找名称或键…" value="${esc(state.search)}" autocomplete="off"/>${state.search ? '<button class="np-searchx" data-act="search-clear" title="清空">✕</button>' : ''}</span>
      <button class="np-iconbtn" data-act="reload" title="刷新">${ICON_REFRESH}</button>
    </div>
    <div class="np-groups">${groupsHtml}</div>
  </div>`;
}
const ICON_REFRESH = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3h-3"/></svg>';
function contentHtml() {
  if (!state.selectedKey) return `<div class="np-root"><div class="np-placeholder">从左侧选择决策集，输入事实后求值</div></div>`;
  const d = state.detail;
  if (!d) return `<div class="np-root"><div class="np-placeholder">加载中…</div></div>`;
  const factVars = collectFactVars(d);
  const inputKeys = new Set((d.inputs || []).map(c => c.expression));
  const fields = factVars.map(v => {
    const badge = inputKeys.has(v.name) ? '' : ' <em class="np-derived" title="输出/条件表达式引用的变量">派生</em>';
    return `<label class="np-field"><span>${esc(v.label)}${badge}</span>
      <input class="np-in" data-fact="${esc(v.name)}" value="${esc(state.facts[v.name] ?? '')}" placeholder="${esc(v.name)}"/></label>`;
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
    <div class="np-form">${fields || '<div class="np-placeholder">该决策无可录入变量</div>'}</div>
    <details class="np-rawwrap"><summary>高级：直接编辑 JSON facts</summary>
      <textarea class="np-raw" data-fact-raw placeholder='{"score":800,"income":10000}'>${esc(state.factsRaw ?? '')}</textarea></details>
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
  if (root.__ruleSwBound) return; // 委托监听只绑一次（避免 refresh 重复绑叠加→事件风暴）
  root.__ruleSwBound = true;
  // 分组折叠态记忆（toggle 不冒泡 → 捕获阶段接住）。
  root.addEventListener('toggle', (ev) => {
    const d = ev.target; if (!d.matches || !d.matches('details.np-grp')) return;
    state.collapsed[d.getAttribute('data-grp')] = !d.open;
  }, true);
  root.addEventListener('input', (ev) => {
    if (ev.target.id === 'np-search') { const pos = ev.target.selectionStart; state.search = ev.target.value; state.page = 1; refreshView('explorer'); focusSearch(pos); return; }
    const f = ev.target.closest('[data-fact]');
    if (f) { state.facts[f.getAttribute('data-fact')] = f.value; return; }
    if (ev.target.matches('[data-fact-raw]')) state.factsRaw = ev.target.value; // 高级 JSON facts
  });
  root.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-key]');
    if (item) { selectDecision(item.getAttribute('data-key')); return; }
    const act = ev.target.closest('[data-act]')?.getAttribute('data-act');
    if (act === 'eval') evaluate();
    else if (act === 'open-sim') openSimulator(ev.target);
    else if (act === 'reload') loadList();
    else if (act === 'page-prev') { if (state.page > 1) { state.page--; refreshView('explorer'); } }
    else if (act === 'page-next') { state.page++; refreshView('explorer'); }
    else if (act === 'search-clear') { state.search = ''; state.page = 1; refreshView('explorer'); focusSearch(); }
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
  .np-root{
    /* ── 设计令牌：全部锚定 UI5 --sap*（随门户主题 light/dark 翻转，穿透 shadow DOM）；
       独立 :8094 无 --sap* 时走 hex 兜底（亮色）。科技感来自 color-mix 派生的强调色/微光/渐变。 ── */
    --dg-fg:var(--sapTextColor,#1c2530);
    --dg-muted:var(--sapContent_LabelColor,#5a6b7b);
    --dg-faint:var(--sapContent_LabelColor,#8b97b3);
    --dg-bg:var(--sapGroup_ContentBackground,#fff);
    --dg-surface:color-mix(in srgb,var(--sapList_Background,#fff) 88%,var(--sapHighlightColor,#0a6ed1) 3%);
    --dg-hover:var(--sapList_Hover_Background,#eef3fb);
    --dg-sel:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 14%,transparent);
    --dg-border:color-mix(in srgb,var(--sapField_BorderColor,#c9ced4) 60%,transparent);
    --dg-border-strong:color-mix(in srgb,var(--sapField_BorderColor,#c9ced4) 90%,transparent);
    --dg-accent:var(--sapHighlightColor,#0a6ed1);
    --dg-accent2:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 55%,#00d0c0);
    --dg-accent-soft:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 12%,transparent);
    --dg-accent-line:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 40%,transparent);
    --dg-glow:0 0 0 1px color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 22%,transparent),0 6px 18px -8px color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 45%,transparent);
    --dg-ok:var(--sapPositiveColor,#178a5a);--dg-warn:var(--sapCriticalColor,#c26a00);--dg-danger:var(--sapNegativeColor,#d1394a);
    --dg-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    color-scheme:light dark;
    font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--dg-fg);height:100%;box-sizing:border-box;padding:10px 11px;overflow:auto}
  .np-root.np-explorer{display:flex;flex-direction:column;overflow:hidden}
  .np-root.np-explorer .np-list{flex:1 1 auto;overflow:auto;min-height:0;margin:0 -2px;padding:0 2px}
  .np-groups{flex:1 1 auto;overflow:auto;min-height:0;margin:0 -2px;padding:0 2px}
  .np-list-inner{list-style:none;margin:0;padding:0}
  .np-grp{border-bottom:1px solid var(--dg-border)}
  .np-grp-hd{list-style:none;cursor:pointer;user-select:none;display:flex;align-items:center;gap:7px;padding:7px 6px;font-size:11.5px;font-weight:600;color:var(--dg-muted);letter-spacing:.02em}
  .np-grp-hd::-webkit-details-marker{display:none}
  .np-grp-hd::before{content:"▸";font-size:10px;color:var(--dg-faint);transition:transform .12s;flex:0 0 auto}
  .np-grp[open]>.np-grp-hd::before{transform:rotate(90deg)}
  .np-grp[open]>.np-grp-hd{color:var(--dg-fg)}
  .np-grp-nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .np-hd{font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dg-muted);margin:12px 0 7px;display:flex;align-items:center;gap:8px;flex:0 0 auto}
  .np-hd::before{content:"";width:3px;height:12px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent-line);flex:0 0 auto}
  .np-hd:first-child{margin-top:2px}
  .np-sub{font-weight:500;color:var(--dg-faint);font-size:10px;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;padding:1px 6px;border-radius:10px;background:var(--dg-accent-soft)}
  .np-list{list-style:none;margin:0;padding:0}
  .np-item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:9px;cursor:pointer;position:relative;border:1px solid transparent;transition:background .14s,border-color .14s}
  .np-item:hover{background:var(--dg-hover)}
  .np-item.sel{background:var(--dg-sel);border-color:var(--dg-accent-line)}
  .np-item.sel::before{content:"";position:absolute;left:0;top:18%;bottom:18%;width:2.5px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent)}
  .np-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent)}
  .np-dot.pub{background:var(--dg-ok);color:var(--dg-ok)}.np-dot.draft{background:var(--dg-faint);color:var(--dg-faint)}
  .np-nm{flex:1;font-weight:500}
  .np-empty,.np-placeholder{color:var(--dg-faint);padding:22px 10px;text-align:center;font-size:12px}
  .np-btn{border:1px solid var(--dg-border-strong);background:var(--dg-surface);color:var(--dg-accent);border-radius:8px;padding:7px 14px;font-size:12px;font-weight:500;cursor:pointer;transition:border-color .14s,box-shadow .14s,background .14s}
  .np-btn:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}
  .np-btn.primary{background:linear-gradient(135deg,var(--dg-accent),var(--dg-accent2));color:#fff;border-color:transparent}
  .np-btn.primary:hover{box-shadow:var(--dg-glow);filter:brightness(1.06)}
  .np-btn.xs{padding:3px 9px;font-size:11px}
  .np-btn.ghost{border-color:var(--dg-border);color:var(--dg-muted);background:transparent}
  .np-btn.ghost:hover{border-color:var(--dg-accent);color:var(--dg-accent)}
  .np-btn.ghost[disabled]{opacity:.35;cursor:default;box-shadow:none;border-color:var(--dg-border)}
  .np-searchbar{display:flex;align-items:stretch;gap:6px;margin:4px 0 6px;flex:0 0 auto}
  .np-searchwrap{position:relative;flex:1 1 auto;display:flex}
  .np-search{width:100%;box-sizing:border-box;padding-right:26px}
  .np-searchx{position:absolute;right:7px;top:50%;transform:translateY(-50%);border:none;background:transparent;color:var(--dg-faint);cursor:pointer;font-size:12px;line-height:1;padding:2px 4px}
  .np-searchx:hover{color:var(--dg-danger)}
  .np-iconbtn{flex:0 0 auto;width:32px;aspect-ratio:1/1;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--dg-border-strong);border-radius:8px;background:var(--dg-surface);color:var(--dg-accent);cursor:pointer;transition:border-color .14s,box-shadow .14s,transform .3s}
  .np-iconbtn:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}
  .np-iconbtn:active svg{transform:rotate(180deg)}
  .np-iconbtn svg{display:block;transition:transform .3s}
  .np-pager{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px;flex:0 0 auto}
  .np-pager:empty{margin:0}
  .np-pageinfo{font-size:11px;color:var(--dg-muted);min-width:46px;text-align:center;font-variant-numeric:tabular-nums;font-family:var(--dg-mono)}
  .np-form{display:flex;flex-direction:column;gap:9px}
  .np-field{display:flex;flex-direction:column;gap:4px}.np-field span{font-size:11px;color:var(--dg-muted)}
  .np-in{border:1px solid var(--dg-border-strong);border-radius:8px;padding:7px 10px;font-size:13px;background:var(--sapField_Background,#fff);color:inherit;box-sizing:border-box;width:100%;transition:border-color .14s,box-shadow .14s}
  .np-in:focus{outline:none;border-color:var(--dg-accent);box-shadow:0 0 0 3px var(--dg-accent-soft)}
  .np-derived{font-style:normal;font-size:9px;color:var(--dg-warn);background:color-mix(in srgb,var(--dg-warn) 14%,transparent);border:1px solid color-mix(in srgb,var(--dg-warn) 28%,transparent);border-radius:6px;padding:0 5px;margin-left:5px;font-weight:600}
  .np-rawwrap{margin:8px 0 2px}.np-rawwrap summary{cursor:pointer;color:var(--dg-faint);font-size:11px;user-select:none}.np-rawwrap summary:hover{color:var(--dg-accent)}
  .np-raw{width:100%;box-sizing:border-box;min-height:52px;margin-top:6px;border:1px solid var(--dg-border-strong);border-radius:8px;padding:7px 10px;font:12px/1.5 var(--dg-mono);background:var(--sapField_Background,#fff);color:inherit;resize:vertical}
  .np-raw:focus{outline:none;border-color:var(--dg-accent);box-shadow:0 0 0 3px var(--dg-accent-soft)}
  .np-actions{margin-top:14px;display:flex;gap:6px;flex-wrap:wrap}
  .np-out{margin-top:14px;border-radius:11px;padding:11px 13px;position:relative;overflow:hidden}
  .np-out::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px}
  .np-out.ok{background:linear-gradient(135deg,color-mix(in srgb,var(--dg-ok) 10%,transparent),transparent 68%),var(--dg-surface);border:1px solid color-mix(in srgb,var(--dg-ok) 30%,transparent)}
  .np-out.ok::before{background:var(--dg-ok);box-shadow:0 0 10px var(--dg-ok)}
  .np-out.err{background:linear-gradient(135deg,color-mix(in srgb,var(--dg-danger) 10%,transparent),transparent 68%),var(--dg-surface);border:1px solid color-mix(in srgb,var(--dg-danger) 30%,transparent)}
  .np-out.err::before{background:var(--dg-danger);box-shadow:0 0 10px var(--dg-danger)}
  .np-outhd{font-weight:600;font-size:12px;margin-bottom:6px;font-variant-numeric:tabular-nums}
  .np-json{margin:0;font:12px/1.5 var(--dg-mono);white-space:pre-wrap;color:inherit}
  .np-json.sm{font-size:11px;color:var(--dg-muted);margin-top:4px}
  .np-fail{color:var(--dg-danger);font-size:11px;margin-top:6px}
  .np-node{border:1px solid var(--dg-border);border-left-width:3px;border-radius:9px;padding:9px 11px;margin-bottom:8px;background:var(--dg-surface);transition:border-color .14s,box-shadow .14s}
  .np-node.hit{border-left-color:var(--dg-ok)}
  .np-node.miss{border-left-color:var(--dg-faint)}
  .np-node.fail{border-left-color:var(--dg-danger);background:linear-gradient(135deg,color-mix(in srgb,var(--dg-danger) 7%,transparent),transparent 70%),var(--dg-surface)}
  .np-nodehd{font-weight:600;font-size:12px;display:flex;align-items:center;gap:8px}
  .np-tag{font-size:10px;background:var(--dg-accent-soft);color:var(--dg-accent);padding:1px 7px;border-radius:9px;font-weight:600}
  .np-us{margin-left:auto;font-size:10px;color:var(--dg-faint);font-family:var(--dg-mono);font-variant-numeric:tabular-nums}
  .np-noderow{font-size:11px;color:var(--dg-muted);margin-top:4px}
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
