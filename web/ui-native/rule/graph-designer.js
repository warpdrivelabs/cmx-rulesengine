/*
 * portal.rules.graph-designer —— 决策图设计器（native_pages 多实例，四区）。**薄壳**：图渲染/布局/
 * 拖拽/连线全部下放到独立组件 <cmx-decision-graph>（@cmx/decision-graph，vendor 到 web/ui-native/
 * vendor/）。本壳只负责：后端 I/O（装载/保存/发布/分析）、native 页多实例生命周期、以及 decisionTable
 * 节点的内嵌网格编辑器（决策表专属，作为宿主注入的节点编辑器留在 shell，不进通用图核）。
 *
 * 组件加载：native 页由 new Function 执行、不能相对 import，故首次挂载时 fetch 组件源
 * （/api/native-pages/portal.rules.graph-component）→ blob module URL → 动态 import → 自注册
 * <cmx-decision-graph>（一次性、幂等）。独立 :8094 与门户 F3 反代都走 /api/native-pages，两处皆可。
 *
 * 四区：explorer 节点列表/调色板/子决策参考；content 组件画布 + 工具栏；property 选中节点编辑器 +
 * 图级 gap/overlap 分析 + 保存/发布。试算走 simulator 页（simulate 只认已存 def）。
 */

const CFG = { apiBase: '', fetchInit: { credentials: 'same-origin' }, authHeaders: () => ({}) };
export function configure(o) { Object.assign(CFG, o || {}); return CFG; }

// ── 多实例 ──
const instances = new Map();
function instanceKey(props) { return `${props?.key || '?'}@@${props?.version ?? 'draft'}`; }
function getInst(ctx) {
  const k = instanceKey(ctx.props);
  let st = instances.get(k);
  if (!st) {
    st = { props: ctx.props || {}, def: null, analysis: null, decisions: [],
      dirty: false, loaded: false, selectedNodeId: null, selectedNode: null, selectedEdge: null, hosts: new Set(), el: null };
    instances.set(k, st);
  }
  return st;
}

const { apiJson: _sharedApiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js）；经 CFG 转发保留组件壳 configure() 契约
async function apiJson (url, options = {}) { return _sharedApiJson(url, options, CFG) }

const NODE_LABEL = { input: '输入', output: '输出', decisionTable: '决策表', expression: '表达式', decision: '子决策' };
const NODE_TYPES = ['input', 'output', 'decisionTable', 'expression', 'decision'];
const HIT_POLICIES = ['U', 'A', 'P', 'F', 'C', 'R', 'O', 'C+', 'C<', 'C>', 'C#'];
const HP_LABEL = { U: '唯一', A: '任意', P: '优先', F: '首个', C: '收集', R: '规则序', O: '输出序', 'C+': '求和', 'C<': '最小', 'C>': '最大', 'C#': '计数' };

// ── 组件加载（一次性，幂等）──
let _componentPromise = null;
function ensureComponent() {
  if (typeof customElements !== 'undefined' && customElements.get('cmx-decision-graph')) return Promise.resolve();
  if (_componentPromise) return _componentPromise;
  _componentPromise = (async () => {
    const src = await apiJson('/api/native-pages/portal.rules.graph-component');
    const code = src && src.source ? src.source : '';
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try { await import(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
  })();
  return _componentPromise;
}

// ── 数据层 ──
function skeleton(key, name) {
  return { key, name: name || key, version: 1, kind: 'graph',
    nodes: [{ id: 'in', name: '输入', type: 'input' }, { id: 'out', name: '输出', type: 'output' }],
    edges: [{ source: 'in', target: 'out' }] };
}
async function loadDef(st) {
  try {
    const d = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(st.props.key));
    d.nodes = d.nodes || []; d.edges = d.edges || []; d.kind = 'graph';
    if (!d.nodes.length) { const s = skeleton(st.props.key, st.props.name); d.nodes = s.nodes; d.edges = s.edges; }
    st.def = d;
  } catch { st.def = skeleton(st.props.key, st.props.name); }
  st.loaded = true;
  await ensureDecisions(st);
  await analyze(st);
}
async function ensureDecisions(st) {
  try { const list = await apiJson('/api/rules/v1/definitions') || []; st.decisions = list.filter(x => x.key !== st.props.key); }
  catch { st.decisions = []; }
}
async function analyze(st) {
  try { st.analysis = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: st.def }) }); }
  catch { st.analysis = null; }
  refresh(st, 'property');
}
let analyzeTimer = null;
function scheduleAnalyze(st) { clearTimeout(analyzeTimer); analyzeTimer = setTimeout(() => analyze(st), 400); }
async function saveDraft(st) {
  syncFromComponent(st);
  const err = validateGraph(st.def);
  if (err) { flash('无法保存：' + err, true); return false; }
  try { await apiJson('/api/rules/v1/definitions/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stripLayout(st.def)) }); st.dirty = false; flash('已保存草稿'); refresh(st, 'content'); refresh(st, 'property'); return true; }
  catch (e) { flash('保存失败：' + e.message, true); return false; }
}
async function publish(st) {
  if (!(await saveDraft(st))) return;
  try { const r = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(st.props.key) + '/publish', { method: 'POST' });
    flash('已发布 v' + (r && r.version)); refresh(st, 'content'); refresh(st, 'property'); }
  catch (e) { flash('发布失败：' + e.message, true); }
}

// 取组件当前模型回填 st.def（保存前）。
function syncFromComponent(st) {
  if (st.el && typeof st.el.getGraph === 'function') { try { st.def = st.el.getGraph(); } catch { /* */ } }
}
// 剥离组件私有布局提示（_layout 非后端契约；后端 serde 会忽略未知字段，此处显式剥离更干净）。
function stripLayout(def) { const d = { ...def }; delete d._layout; return d; }

// 本地结构校验（镜像后端；组件也有 validate，但保存前壳再兜一道）。
function validateGraph(d) {
  const nodes = d.nodes || [], edges = d.edges || [];
  if (!nodes.length) return '决策图至少需一个节点';
  const ids = new Set();
  for (const n of nodes) { if (ids.has(n.id)) return `节点 id 重复：${n.id}`; ids.add(n.id); }
  for (const e of edges) { if (!ids.has(e.source) || !ids.has(e.target)) return `边端点不存在：${e.source} → ${e.target}`; }
  for (const n of nodes) {
    if (n.type === 'decisionTable') {
      const t = n.table;
      if (!t) return `决策表节点「${n.name || n.id}」缺表`;
      if (!(t.outputs || []).length) return `决策表节点「${n.name || n.id}」至少需一个输出列`;
      for (let i = 0; i < (t.rules || []).length; i++) {
        const r = t.rules[i];
        if ((r.inputEntries || []).length !== (t.inputs || []).length) return `节点「${n.name || n.id}」规则行 ${i} 输入项数与列数不符`;
        if ((r.outputEntries || []).length !== (t.outputs || []).length) return `节点「${n.name || n.id}」规则行 ${i} 输出项数与列数不符`;
      }
    }
    if (n.type === 'decision' && !n.decisionKey) return `子决策节点「${n.name || n.id}」未选择引用决策`;
  }
  return null;
}

// ── 渲染生命周期 ──
function hostRoot(host) { return host?.renderRoot || host?.shadowRoot?.querySelector('.g') || host; }
function mount(ctx, view) {
  const st = getInst(ctx); const host = ctx.host; st.hosts.add(host); host.__view = view; host.__key = instanceKey(ctx.props);
  const render = () => { const root = hostRoot(host); if (!root || root.isConnected === false) return; root.innerHTML = `<style>${css()}</style>${viewHtml(st, view)}`; bind(root, st, view, host); };
  requestAnimationFrame(async () => {
    render();
    if (!st.loaded) { await ensureComponent().catch(() => {}); await loadDef(st); refresh(st, 'content'); refresh(st, 'explorer'); refresh(st, 'property'); }
    else if (view === 'content') mountComponent(st, host); // 组件区重挂
  });
  return `<style>${css()}</style>${viewHtml(st, view)}`;
}
function refresh(st, view) {
  for (const host of st.hosts) {
    if (host.__view !== view) continue;
    const root = hostRoot(host); if (!root || root.isConnected === false) continue;
    root.innerHTML = `<style>${css()}</style>${viewHtml(st, view)}`; bind(root, st, view, host);
    if (view === 'content') mountComponent(st, host);
  }
}
function viewHtml(st, view) {
  if (!st.loaded) return `<div class="g"><div class="ph">加载中…</div></div>`;
  if (view === 'explorer') return explorerHtml(st);
  if (view === 'property') return propertyHtml(st);
  return contentHtml(st);
}

// ── content：工具栏 + <cmx-decision-graph> 组件宿主 ──
function contentHtml(st) {
  const d = st.def;
  const addBtns = NODE_TYPES.map(t => `<button class="g-btn xs" data-act="add-node" data-nodetype="${t}">+ ${NODE_LABEL[t]}</button>`).join('');
  const toolbar = `<div class="g-toolbar">
    <b class="g-title">${esc(d.name || d.key)}</b>
    <span class="g-dirty ${st.dirty ? 'on' : ''}">${st.dirty ? '● 未保存' : '已保存'}</span>
    <span class="g-sp"></span>
    ${addBtns}
    <button class="g-btn" data-act="auto-layout">重排</button>
    <button class="g-btn primary" data-act="save">保存草稿</button>
    <button class="g-btn ok" data-act="publish">发布</button>
  </div>`;
  const hint = `<div class="g-hint">拖拽节点移位 · 从节点右缘小圆拉线连边 · 点节点在右侧编辑 · 点边可删除 · ${(d.nodes || []).length} 节点 / ${(d.edges || []).length} 边</div>`;
  return `<div class="g">
    ${toolbar}
    ${hint}
    <div class="g-canvaswrap" data-graph-host></div>
  </div>`;
}

// 把组件挂进 content 宿主（幂等：已挂则只 setGraph）。
function mountComponent(st, host) {
  const root = hostRoot(host);
  const slot = root && root.querySelector('[data-graph-host]');
  if (!slot) return;
  if (typeof customElements === 'undefined' || !customElements.get('cmx-decision-graph')) {
    slot.innerHTML = '<div class="ph">决策图组件加载中…</div>';
    ensureComponent().then(() => mountComponent(st, host)).catch(() => { slot.innerHTML = '<div class="ph">组件加载失败</div>'; });
    return;
  }
  let el = slot.querySelector('cmx-decision-graph');
  if (!el) {
    el = document.createElement('cmx-decision-graph');
    el.style.cssText = 'display:block;height:520px';
    slot.innerHTML = '';
    slot.appendChild(el);
    wireComponent(st, el);
  }
  st.el = el;
  if (typeof el.setDecisions === 'function') el.setDecisions(st.decisions || []);
  if (typeof el.setGraph === 'function') el.setGraph(st.def);
}

// 组件 → 壳 事件接线。
function wireComponent(st, el) {
  el.addEventListener('graph-change', (e) => {
    st.def = e.detail.graph; st.dirty = true;
    markDirtyAll(st);
    scheduleAnalyze(st);
  });
  el.addEventListener('node-select', (e) => {
    st.selectedNodeId = e.detail.nodeId; st.selectedNode = e.detail.node; st.selectedEdge = null;
    refresh(st, 'property');
  });
  el.addEventListener('edge-select', (e) => {
    st.selectedEdge = e.detail.edge || null; st.selectedNodeId = null; st.selectedNode = null;
    refresh(st, 'property');
  });
  el.addEventListener('connect-rejected', (e) => { flash(e.detail.reason || '连线被拒', true); });
}
function markDirtyAll(st) {
  for (const host of st.hosts) {
    if (host.__view !== 'content') continue;
    const b = hostRoot(host)?.querySelector('.g-dirty');
    if (b) { b.classList.add('on'); b.textContent = '● 未保存'; }
  }
}

// ── explorer：节点列表 + 调色板 + 子决策参考 ──
function explorerHtml(st) {
  const d = st.def;
  const nlist = (d.nodes || []).map(n => `<li class="g-nrow ${st.selectedNodeId === n.id ? 'sel' : ''}" data-node="${esc(n.id)}">
    <span class="g-nbadge t-${esc(n.type)}">${esc(NODE_LABEL[n.type] || n.type)}</span>
    <span class="g-nname">${esc(n.name || n.id)}</span>
    <button class="g-x" data-act="del-node" data-node="${esc(n.id)}" title="删除节点">×</button></li>`).join('');
  const palette = NODE_TYPES.map(t => `<button class="g-btn xs" data-act="add-node" data-nodetype="${t}">+ ${NODE_LABEL[t]}</button>`).join('');
  const subRef = (st.decisions || []).slice(0, 30).map(x => `<li class="g-subref">${esc(x.name || x.key)}<code>${esc(x.key)}</code></li>`).join('');
  return `<div class="g">
    <div class="g-hd">节点 <span class="g-sub">${(d.nodes || []).length} 个</span></div>
    <ul class="g-nlist">${nlist || '<li class="ph">空图</li>'}</ul>
    <div class="g-hd">添加节点</div>
    <div class="g-palette">${palette}</div>
    <div class="g-hd">可引用子决策<span class="g-sub">decision 节点</span></div>
    <ul class="g-nlist">${subRef || '<li class="ph">无其它决策</li>'}</ul>
  </div>`;
}

// ── property：选中节点/边编辑器（宿主注入决策表网格等）+ 图级分析 ──
function propertyHtml(st) {
  const d = st.def, a = st.analysis;
  const n = (d.nodes || []).find(x => x.id === st.selectedNodeId);
  let editor;
  if (st.selectedEdge) {
    editor = edgeEditorHtml(st, st.selectedEdge);
  } else if (n) {
    editor = nodeEditorHtml(st, n);
  } else {
    editor = `<div class="ph">点画布或左侧列表中的节点/边查看属性</div>`;
  }
  const analysis = a ? `<div class="g-anal">
    <div class="g-badge ${a.complete ? 'ok' : 'warn'}">${a.complete ? '✓ 无空隙' : '⚠ 空隙 ' + (a.gaps || []).length}</div>
    <div class="g-badge ${a.hasOverlap ? 'warn' : 'ok'}">${a.hasOverlap ? '⚠ 重叠 ' + (a.overlaps || []).length : '✓ 无重叠'}</div>
    <div class="g-gaps">
      ${(a.overlaps || []).slice(0, 8).map(o => `<div class="g-gap ov">${esc(o.description)}</div>`).join('')}
      ${(a.gaps || []).slice(0, 8).map(g => `<div class="g-gap">${esc(g.description)}</div>`).join('')}
    </div></div>` : '<div class="ph">分析中…</div>';
  return `<div class="g">
    ${editor}
    <div class="g-hd">完整性分析<span class="g-sub">各决策表节点 gap/overlap · 超越 ZEN</span> <button class="g-btn xs" data-act="reanalyze">刷新</button></div>
    ${analysis}
    <div class="g-hd">图</div>
    <div class="g-kv"><span>键</span><b>${esc(d.key)}</b></div>
    <div class="g-kv"><span>版本</span><b>v${d.version ?? 1}</b></div>
    <div class="g-kv"><span>规模</span><b>${(d.nodes || []).length} 节点 / ${(d.edges || []).length} 边</b></div>
    <div class="g-actions"><button class="g-btn primary" data-act="save">保存草稿</button><button class="g-btn ok" data-act="publish">发布</button></div>
  </div>`;
}

// 边属性编辑器（显示源/目标 + 删除）。
function edgeEditorHtml(st, edge) {
  const nodeName = (id) => { const n = (st.def.nodes || []).find(x => x.id === id); return n ? (n.name || n.id) : id; };
  const idx = (st.def.edges || []).findIndex(e => e.source === edge.source && e.target === edge.target);
  return `<div class="g-hd">边属性 <button class="g-x" data-act="del-edge" data-edge-idx="${idx}" title="删除边">×</button></div>
    <div class="g-kv"><span>从</span><b>${esc(nodeName(edge.source))}</b></div>
    <div class="g-kv"><span></span><span class="g-sub">${esc(edge.source)}</span></div>
    <div class="g-kv"><span>到</span><b>${esc(nodeName(edge.target))}</b></div>
    <div class="g-kv"><span></span><span class="g-sub">${esc(edge.target)}</span></div>
    <div class="g-note">数据从「${esc(nodeName(edge.source))}」流入「${esc(nodeName(edge.target))}」。</div>
    <div class="g-actions"><button class="g-btn warn" data-act="del-edge" data-edge-idx="${idx}">删除此边</button></div>`;
}

// ── 按 type 分派的节点编辑器（改的是 st.def 里的节点，回写组件）──
function selectedNode(st) { return (st.def.nodes || []).find(x => x.id === st.selectedNodeId); }
function nodeEditorHtml(st, n) {
  const head = `<div class="g-hd">节点：${esc(NODE_LABEL[n.type] || n.type)} <span class="g-sub">${esc(n.id)}</span>
    <button class="g-x" data-act="del-node" data-node="${esc(n.id)}" title="删除节点">×</button></div>
    <div class="g-field"><span>名称</span><input class="g-in" data-kind="node-name" value="${esc(n.name || '')}" placeholder="节点名"/></div>`;
  if (n.type === 'input' || n.type === 'output') {
    return head + `<div class="g-note">${n.type === 'input' ? '入口：提供输入事实作为初始上下文。' : '出口：收集当前累积上下文为最终输出。'}</div>`;
  }
  if (n.type === 'decision') {
    const opts = ['<option value="">（选择被引用的决策）</option>'].concat((st.decisions || []).map(x => `<option value="${esc(x.key)}" ${x.key === n.decisionKey ? 'selected' : ''}>${esc(x.name || x.key)} · ${esc(x.key)}</option>`)).join('');
    const dangling = n.decisionKey && !(st.decisions || []).some(x => x.key === n.decisionKey) ? `<div class="g-warn">⚠ 引用的决策「${esc(n.decisionKey)}」不存在</div>` : '';
    return head + `<div class="g-field"><span>引用决策</span><select class="g-in" data-kind="decision-key">${opts}</select></div>${dangling}
      <div class="g-note">子决策：对当前上下文递归求值另一个决策，输出并入上下文。</div>`;
  }
  if (n.type === 'expression') {
    const rows = (n.mappings || []).map((m, i) => `<div class="g-maprow">
      <input class="g-in key" data-kind="map-key" data-i="${i}" value="${esc(m.key)}" placeholder="字段名"/>
      <input class="g-in expr" data-kind="map-expr" data-i="${i}" value="${esc(m.expression)}" placeholder="FEEL 表达式，如 income * 5"/>
      <button class="g-x" data-act="del-mapping" data-i="${i}" title="删除">×</button></div>`).join('');
    return head + `<div class="g-hd sub2">字段映射 <button class="g-btn xs" data-act="add-mapping">+ 映射</button></div>
      ${rows || '<div class="ph">无映射，点「+ 映射」添加</div>'}
      <div class="g-note">表达式节点：每个映射用 FEEL 算出一个新字段并入上下文。</div>`;
  }
  if (n.type === 'decisionTable') return head + tableEditorHtml(n);
  return head;
}

// decisionTable 节点内嵌网格（决策表专属，留在 shell 作为注入编辑器）。
function tableEditorHtml(n) {
  const t = n.table || (n.table = { hitPolicy: 'U', inputs: [], outputs: [], rules: [] });
  const ins = t.inputs || [], outs = t.outputs || [], rules = t.rules || [];
  const hpSel = `<select class="g-in hp" data-kind="tbl-hitpolicy">${HIT_POLICIES.map(h => `<option value="${h}" ${h === t.hitPolicy ? 'selected' : ''}>${h} · ${HP_LABEL[h] || ''}</option>`).join('')}</select>`;
  const head = `<tr><th class="g-idx">#</th>
    ${ins.map((c, ci) => `<th class="g-tin"><input class="g-th" data-kind="tbl-in-expr" data-c="${ci}" value="${esc(c.expression || '')}" placeholder="字段"/><button class="g-x" data-act="tbl-del-input" data-c="${ci}" title="删列">×</button></th>`).join('')}
    ${outs.map((c, ci) => `<th class="g-tout"><input class="g-th" data-kind="tbl-out-name" data-c="${ci}" value="${esc(c.name || '')}" placeholder="输出键"/><button class="g-x" data-act="tbl-del-output" data-c="${ci}" title="删列">×</button></th>`).join('')}
    <th class="g-tops"></th></tr>`;
  const body = rules.map((rl, ri) => `<tr><td class="g-idx">${ri}</td>
    ${ins.map((c, ci) => `<td class="g-tin"><input class="g-tcell" data-kind="tbl-in" data-r="${ri}" data-c="${ci}" value="${esc(rl.inputEntries[ci] ?? '')}" placeholder="-"/></td>`).join('')}
    ${outs.map((c, ci) => `<td class="g-tout"><input class="g-tcell" data-kind="tbl-out" data-r="${ri}" data-c="${ci}" value="${esc(rl.outputEntries[ci] ?? '')}" placeholder="值"/></td>`).join('')}
    <td class="g-tops"><button class="g-x" data-act="tbl-del-rule" data-r="${ri}" title="删行">×</button></td></tr>`).join('');
  return `<div class="g-hd sub2">决策表 · 命中策略 ${hpSel}</div>
    <div class="g-tbtns">
      <button class="g-btn xs" data-act="tbl-add-input">+ 输入列</button>
      <button class="g-btn xs" data-act="tbl-add-output">+ 输出列</button>
      <button class="g-btn xs" data-act="tbl-add-rule">+ 规则行</button>
    </div>
    <div class="g-tblwrap"><table class="g-tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

// 节点编辑改了 st.def → 回写组件重画 + 去抖分析。
function pushToComponent(st) { if (st.el && typeof st.el.setGraph === 'function') { try { st.el.setGraph(st.def); } catch { /* */ } } }

// ── 事件绑定 ──
function bind(root, st, view, host) {
  if (root.__ruleGraphShellBound) return;
  root.__ruleGraphShellBound = true;
  root.addEventListener('click', (ev) => {
    const nodeRow = ev.target.closest('.g-nrow[data-node]');
    const actEl = ev.target.closest('[data-act]');
    const act = actEl?.getAttribute('data-act');
    if (act) { handleAct(st, act, actEl); return; }
    if (nodeRow) { st.selectedNodeId = nodeRow.getAttribute('data-node'); st.selectedEdge = null; if (st.el?.selectNode) st.el.selectNode(st.selectedNodeId); refresh(st, 'property'); refresh(st, 'explorer'); }
  });
  root.addEventListener('change', (ev) => handleChange(st, ev));
}

function handleAct(st, act, el) {
  const nt = el.getAttribute('data-nodetype');
  const c = el.getAttribute('data-c'), r = el.getAttribute('data-r'), i = el.getAttribute('data-i');
  const node = () => selectedNode(st);
  switch (act) {
    case 'add-node': if (st.el?.addNode) { st.selectedNodeId = st.el.addNode(nt); st.def = st.el.getGraph(); refresh(st, 'explorer'); refresh(st, 'property'); } break;
    case 'del-node': { const id = el.getAttribute('data-node'); if (st.el?.delNode) { st.el.delNode(id); st.def = st.el.getGraph(); if (st.selectedNodeId === id) st.selectedNodeId = null; refresh(st, 'explorer'); refresh(st, 'property'); } break; }
    case 'del-edge': { const idx = +el.getAttribute('data-edge-idx'); if (st.el?.delEdge && idx >= 0) { st.el.delEdge(idx); st.def = st.el.getGraph(); st.selectedEdge = null; refresh(st, 'property'); } break; }
    case 'auto-layout': if (st.el?.autoLayout) st.el.autoLayout(); break;
    case 'save': saveDraft(st); break;
    case 'publish': publish(st); break;
    case 'reanalyze': analyze(st); break;
    case 'add-mapping': { const n = node(); if (n) { (n.mappings = n.mappings || []).push({ key: 'field' + (n.mappings.length + 1), expression: '' }); afterNodeEdit(st); } break; }
    case 'del-mapping': { const n = node(); if (n) { n.mappings.splice(+i, 1); afterNodeEdit(st); } break; }
    case 'tbl-add-input': { const t = node()?.table; if (t) { t.inputs.push({ id: 'i' + (t.inputs.length + 1), label: '', expression: 'field' + (t.inputs.length + 1) }); t.rules.forEach(rr => rr.inputEntries.push('-')); afterNodeEdit(st); } break; }
    case 'tbl-add-output': { const t = node()?.table; if (t) { t.outputs.push({ id: 'o' + (t.outputs.length + 1), name: 'out' + (t.outputs.length + 1), label: '' }); t.rules.forEach(rr => rr.outputEntries.push('""')); afterNodeEdit(st); } break; }
    case 'tbl-add-rule': { const t = node()?.table; if (t) { t.rules.push({ id: '', inputEntries: t.inputs.map(() => '-'), outputEntries: t.outputs.map(() => '""') }); afterNodeEdit(st); } break; }
    case 'tbl-del-input': { const t = node()?.table; if (t) { t.inputs.splice(+c, 1); t.rules.forEach(rr => rr.inputEntries.splice(+c, 1)); afterNodeEdit(st); } break; }
    case 'tbl-del-output': { const t = node()?.table; if (t) { if (t.outputs.length <= 1) { flash('决策表至少需一个输出列', true); break; } t.outputs.splice(+c, 1); t.rules.forEach(rr => rr.outputEntries.splice(+c, 1)); afterNodeEdit(st); } break; }
    case 'tbl-del-rule': { const t = node()?.table; if (t) { t.rules.splice(+r, 1); afterNodeEdit(st); } break; }
  }
}
function handleChange(st, ev) {
  const el = ev.target, kind = el.getAttribute?.('data-kind'); if (!kind) return;
  const n = selectedNode(st);
  const c = +el.getAttribute('data-c'), r = +el.getAttribute('data-r'), i = +el.getAttribute('data-i');
  st.dirty = true;
  if (kind === 'node-name') { if (n) n.name = el.value; afterNodeEdit(st, true); return; }
  if (kind === 'decision-key') { if (n) n.decisionKey = el.value; afterNodeEdit(st); return; }
  if (kind === 'map-key') { if (n) n.mappings[i].key = el.value; pushToComponent(st); scheduleAnalyze(st); return; }
  if (kind === 'map-expr') { if (n) n.mappings[i].expression = el.value; pushToComponent(st); scheduleAnalyze(st); return; }
  const t = n?.table; if (!t) return;
  if (kind === 'tbl-hitpolicy') { t.hitPolicy = el.value; afterNodeEdit(st); }
  else if (kind === 'tbl-in-expr') { t.inputs[c].expression = el.value; pushToComponent(st); scheduleAnalyze(st); }
  else if (kind === 'tbl-out-name') { t.outputs[c].name = el.value; afterNodeEdit(st); }
  else if (kind === 'tbl-in') { t.rules[r].inputEntries[c] = el.value; pushToComponent(st); scheduleAnalyze(st); }
  else if (kind === 'tbl-out') { t.rules[r].outputEntries[c] = el.value; pushToComponent(st); scheduleAnalyze(st); }
}
// 节点编辑落定：回写组件（重画图，如节点副标题/名称）+ 重渲属性区（列增删）+ 去抖分析。
function afterNodeEdit(st, keepFocus) {
  st.dirty = true;
  pushToComponent(st);
  if (!keepFocus) refresh(st, 'property');
  refresh(st, 'explorer');
  scheduleAnalyze(st);
}

// ── helpers ──
function flash(msg, err) {
  try { const el = document.createElement('div'); el.textContent = msg;
    el.style.cssText = `position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:99999;padding:10px 18px;border-radius:8px;font-size:13px;color:var(--sapGroup_ContentBorderColor, #ffffff);background:${err ? 'var(--sapNegativeElementColor, #d9534f)' : 'var(--sapPositiveElementColor, #2e7d5b)'};box-shadow:0 4px 16px rgba(0,0,0,.25)`;
    document.body.appendChild(el); setTimeout(() => el.remove(), 2400); } catch { /* */ }
}
const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）

function css() {
  return `
  .g{
    /* ── 设计令牌：锚定 UI5 --sap*（随门户主题 light/dark 翻转，穿透 shadow DOM）；独立 :8094 走 hex 兜底。 ── */
    --dg-fg:var(--sapTextColor,#1c2530);--dg-muted:var(--sapContent_LabelColor,#5a6b7b);--dg-faint:var(--sapContent_LabelColor,#8b97b3);
    --dg-bg:var(--sapGroup_ContentBackground,#fff);
    --dg-surface:color-mix(in srgb,var(--sapList_Background,#fff) 88%,var(--sapHighlightColor,#0a6ed1) 3%);
    --dg-hover:var(--sapList_Hover_Background,#eef3fb);
    --dg-sel:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 14%,transparent);
    --dg-border:color-mix(in srgb,var(--sapField_BorderColor,#c9ced4) 60%,transparent);
    --dg-border-strong:color-mix(in srgb,var(--sapField_BorderColor,#c9ced4) 90%,transparent);
    --dg-accent:var(--sapHighlightColor,#0a6ed1);--dg-accent2:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 55%,#00d0c0);
    --dg-accent-soft:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 12%,transparent);
    --dg-accent-line:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 40%,transparent);
    --dg-glow:0 0 0 1px color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 22%,transparent),0 6px 18px -8px color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 45%,transparent);
    --dg-ok:var(--sapPositiveColor,#178a5a);--dg-warn:var(--sapCriticalColor,#c26a00);--dg-danger:var(--sapNegativeColor,#d1394a);--dg-purple:#7c5cff;
    --dg-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    color-scheme:light dark;
    font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--dg-fg);height:100%;box-sizing:border-box;padding:10px 11px;overflow:auto;position:relative}
  .ph{color:var(--dg-faint);padding:22px 10px;text-align:center;font-size:12px}
  .g-hd{font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dg-muted);margin:12px 0 7px;display:flex;align-items:center;gap:8px}
  .g-hd::before{content:"";width:3px;height:12px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent-line);flex:0 0 auto}
  .g-hd:first-child{margin-top:2px}
  .g-hd.sub2{margin:9px 0 4px;font-size:10px}
  .g-sub{font-weight:500;color:var(--dg-faint);font-size:10px;letter-spacing:0;text-transform:none;padding:1px 6px;border-radius:10px;background:var(--dg-accent-soft)}
  .g-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 2px 9px;border-bottom:1px solid var(--dg-border);margin-bottom:8px}
  .g-title{font-size:14px;font-weight:600}.g-sp{flex:1}
  .g-dirty{font-size:11px;color:var(--dg-faint)}.g-dirty.on{color:var(--dg-warn);font-weight:600}
  .g-btn{border:1px solid var(--dg-border-strong);background:var(--dg-surface);color:var(--dg-accent);border-radius:8px;padding:6px 11px;font-size:12px;font-weight:500;cursor:pointer;transition:border-color .14s,box-shadow .14s}
  .g-btn:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}
  .g-btn.primary{background:linear-gradient(135deg,var(--dg-accent),var(--dg-accent2));color: #fff;border-color:transparent}
  .g-btn.ok{background:linear-gradient(135deg,var(--dg-ok),color-mix(in srgb,var(--dg-ok) 60%,#00d0c0));color: #fff;border-color:transparent}
  .g-btn.xs{padding:3px 9px;font-size:11px}
  .g-hint{font-size:11px;color:var(--dg-muted);padding:2px 2px 8px}
  .g-canvaswrap{border:1px solid var(--dg-border);border-radius:11px;overflow:hidden;min-height:200px}
  .g-nlist{list-style:none;margin:0;padding:0}
  .g-nrow{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:9px;cursor:pointer;border:1px solid transparent;position:relative;transition:background .14s,border-color .14s}
  .g-nrow:hover{background:var(--dg-hover)}.g-nrow.sel{background:var(--dg-sel);border-color:var(--dg-accent-line)}
  .g-nrow.sel::before{content:"";position:absolute;left:0;top:18%;bottom:18%;width:2.5px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent)}
  .g-nname{flex:1;font-weight:500}
  .g-nbadge{font-size:9px;padding:1px 7px;border-radius:9px;font-weight:600;color: #fff;background:var(--dg-faint)}
  .g-nbadge.t-decisionTable{background:var(--dg-accent)}.g-nbadge.t-expression{background:var(--dg-ok)}.g-nbadge.t-decision{background:var(--dg-purple)}
  .g-subref{list-style:none;display:flex;justify-content:space-between;padding:3px 7px;font-size:11px;color:var(--dg-muted)}.g-subref code{color:var(--dg-faint);font-family:var(--dg-mono)}
  .g-palette{display:flex;flex-wrap:wrap;gap:5px}
  .g-x{border:none;background:transparent;color:var(--dg-danger);cursor:pointer;font-size:14px;line-height:1;padding:0 4px;border-radius:5px}.g-x:hover{background:color-mix(in srgb,var(--dg-danger) 15%,transparent)}
  .g-field{display:flex;align-items:center;gap:8px;padding:4px 0}.g-field span{color:var(--dg-faint);width:56px;font-size:12px}
  .g-in{flex:1;border:1px solid var(--dg-border-strong);border-radius:8px;padding:6px 9px;font-size:12px;background:var(--sapField_Background,#fff);color:inherit;box-sizing:border-box;transition:border-color .14s,box-shadow .14s}
  .g-in:focus{outline:none;border-color:var(--dg-accent);box-shadow:0 0 0 3px var(--dg-accent-soft)}
  .g-maprow{display:flex;gap:5px;align-items:center;margin-bottom:4px}.g-in.key{flex:0 0 34%}.g-in.expr{flex:1;font-family:var(--dg-mono)}
  .g-note{font-size:11px;color:var(--dg-faint);padding:6px 0}
  .g-warn{font-size:11px;color:var(--dg-warn);background:color-mix(in srgb,var(--dg-warn) 12%,transparent);border:1px solid color-mix(in srgb,var(--dg-warn) 26%,transparent);border-radius:8px;padding:6px 9px;margin:4px 0}
  .g-kv{display:flex;gap:8px;padding:4px 0;align-items:baseline}.g-kv span{color:var(--dg-faint);width:56px;font-size:11px;flex:0 0 auto}
  .g-anal{display:flex;flex-direction:column;gap:6px}
  .g-badge{display:inline-flex;align-items:center;width:fit-content;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid transparent}
  .g-badge.ok{background:color-mix(in srgb,var(--dg-ok) 14%,transparent);color:var(--dg-ok);border-color:color-mix(in srgb,var(--dg-ok) 30%,transparent)}
  .g-badge.warn{background:color-mix(in srgb,var(--dg-warn) 15%,transparent);color:var(--dg-warn);border-color:color-mix(in srgb,var(--dg-warn) 32%,transparent)}
  .g-gap{font-size:11px;color:var(--dg-warn);padding:2px 0}.g-gap.ov{color:var(--dg-danger)}
  .g-actions{margin-top:12px;display:flex;gap:6px}
  .g-tbtns{display:flex;gap:5px;margin-bottom:5px}
  .g-tblwrap{overflow:auto;border:1px solid var(--dg-border);border-radius:9px}
  .g-tbl{border-collapse:collapse;width:100%;font-size:11px}
  .g-tbl th,.g-tbl td{border:1px solid var(--dg-border);padding:2px 3px;vertical-align:top}
  .g-tbl th{background:color-mix(in srgb,var(--dg-accent) 5%,var(--dg-surface));position:relative}
  .g-tbl th.g-tin,.g-tbl td.g-tin{background:color-mix(in srgb,var(--dg-accent) 6%,transparent)}.g-tbl th.g-tout,.g-tbl td.g-tout{background:color-mix(in srgb,var(--dg-ok) 7%,transparent)}
  .g-idx{color:var(--dg-faint);text-align:center;width:22px;font-family:var(--dg-mono)}.g-tops{width:24px}
  .g-th{width:100%;border:none;background:transparent;font-weight:600;font-size:11px;color:inherit;padding:1px 2px}
  .g-tcell{width:100%;min-width:64px;border:1px solid transparent;background:transparent;font:11px var(--dg-mono);color:inherit;padding:2px 3px;border-radius:4px}
  .g-tcell:hover{border-color:var(--dg-border-strong);background:var(--dg-bg)}.g-tcell:focus,.g-th:focus{outline:none;box-shadow:0 0 0 2px var(--dg-accent);border-radius:4px;background:var(--dg-bg)}
  .g-in.hp{flex:0 0 auto;display:inline-block;width:auto}
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
