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
const state = { list: [], categories: [], collapsed: {}, managingCats: false, selectedKey: null, detail: null, analysis: null, loadingKey: null, creating: false, gNode: null, gEdge: null, search: '', page: 1, hosts: new Set() };
const PAGE_SIZE = 12;
// 过滤（按名称/键，不分大小写）+ 分页，返回当前页项 + 元信息。
function visibleList() {
  const q = (state.search || '').trim().toLowerCase();
  const filtered = q ? state.list.filter(d => (d.name || '').toLowerCase().includes(q) || (d.key || '').toLowerCase().includes(q)) : state.list;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, state.page), pages);
  const start = (page - 1) * PAGE_SIZE;
  return { items: filtered.slice(start, start + PAGE_SIZE), total, pages, page, filteredTotal: total };
}
// 过滤（同 visibleList）后按分类分桶，组顺序取分类字典 ord，未分类置底。用于「按分类分组折叠」。
function groupedList() {
  const q = (state.search || '').trim().toLowerCase();
  const filtered = q ? state.list.filter(d => (d.name || '').toLowerCase().includes(q) || (d.key || '').toLowerCase().includes(q)) : state.list;
  const cats = state.categories || [];
  const known = new Set(cats.map(c => c.code));
  const buckets = new Map();
  for (const d of filtered) {
    const code = (d.categoryCode && known.has(d.categoryCode)) ? d.categoryCode : ''; // 未知/空 → 未分类
    if (!buckets.has(code)) buckets.set(code, []);
    buckets.get(code).push(d);
  }
  const groups = [];
  for (const c of cats) if (buckets.has(c.code)) groups.push({ code: c.code, name: c.name || c.code, items: buckets.get(c.code) });
  if (buckets.has('')) groups.push({ code: '', name: '未分类', items: buckets.get('') }); // 置底
  return { groups, filteredTotal: filtered.length };
}

// ── 信封解包 fetch ──
const { apiJson: _sharedApiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js）；经 CFG 转发保留组件壳 configure() 契约
async function apiJson (url, options = {}) { return _sharedApiJson(url, options, CFG) }
const { cmxConfirm } = globalThis.__cmxDataComp // 共享确认弹窗（cmx-data-comp/lib/cmx-message-dialog.js；审查 A-03 替换原生 confirm）

// ── 数据加载 ──
async function loadList() {
  try {
    const [list, cats] = await Promise.all([
      apiJson('/api/rules/v1/definitions'),
      apiJson('/api/rules/v1/categories').catch(() => []),
    ]);
    state.list = list || []; state.categories = cats || [];
  }
  catch (e) { state.list = []; console.warn('装载决策集失败', e); flash('装载决策集失败: ' + e.message, true); }
  refreshView('explorer');
}
async function selectDecision(key) {
  if (key === state.selectedKey && state.loadingKey === key) return; // 同键正在加载，忽略重复触发
  state.selectedKey = key; state.detail = null; state.analysis = null; state.loadingKey = key; state.gNode = null; state.gEdge = null;
  refreshView('explorer'); refreshView('content'); refreshView('property');
  let detail = null, analysis = null;
  try {
    detail = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(key));
    analysis = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(key) + '/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch (e) { console.warn('装载定义/分析失败', e); flash('装载定义/分析失败: ' + e.message, true); }
  if (state.loadingKey !== key) return; // 选择已切换，丢弃过期结果（避免旧响应覆盖新选择）
  state.detail = detail; state.analysis = analysis; state.loadingKey = null;
  refreshView('content'); refreshView('property');
}
async function publish(key) {
  try {
    const r = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(key) + '/publish', { method: 'POST' });
    await loadList(); await selectDecision(key);
    flash('已发布 v' + (r && r.version));
  } catch (e) { flash('发布失败: ' + e.message, true); }
}

// ── 新建决策集：存最小合法骨架(至少一输出列) → 刷新列表 → 直接打开 F3 设计器编辑 ──
function slugify(s) { return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
async function createDecision(root) {
  const name = (root.querySelector('#nc-name')?.value || '').trim();
  const key = slugify(root.querySelector('#nc-key')?.value || '') || slugify(name);
  const kind = root.querySelector('input[name="nc-kind"]:checked')?.value || 'decisionTable';
  if (!key) { flash('请填写名称或业务键', true); return; }
  if (state.list.some(d => d.key === key)) { flash(`键 "${key}" 已存在`, true); return; }
  const skeleton = kind === 'graph'
    ? {
        key, name: name || key, version: 1, kind: 'graph',
        nodes: [
          { id: 'in', name: '输入', type: 'input' },
          { id: 'dt1', name: '决策表', type: 'decisionTable', table: { hitPolicy: 'U', inputs: [{ id: 'i1', label: '输入1', expression: 'input1' }], outputs: [{ id: 'o1', name: 'result', label: '结果' }], rules: [{ id: 'r1', inputEntries: ['-'], outputEntries: ['""'] }] } },
          { id: 'out', name: '输出', type: 'output' },
        ],
        edges: [{ source: 'in', target: 'dt1' }, { source: 'dt1', target: 'out' }],
      }
    : {
        key, name: name || key, version: 1, kind: 'decisionTable', hitPolicy: 'U',
        inputs: [{ id: 'i1', label: '输入1', expression: 'input1' }],
        outputs: [{ id: 'o1', name: 'result', label: '结果' }],
        rules: [{ id: 'r1', inputEntries: ['-'], outputEntries: ['""'] }],
      };
  const catCode = (root.querySelector('#nc-cat')?.value || '').trim();
  if (catCode) skeleton.categoryCode = catCode;
  try {
    await apiJson('/api/rules/v1/definitions/draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(skeleton),
    });
  } catch (e) { flash('创建失败: ' + e.message, true); return; }
  state.creating = false;
  await loadList();
  await selectDecision(key);
  flash(`已创建${kind === 'graph' ? '决策图' : '决策表'}「${name || key}」，打开设计器…`);
  openDesigner(root);
}

// ── 删除决策集：二次确认 → DELETE（后端连带清理发布/日志/用例四表）→ 刷新；删的是当前选中则清空右侧 ──
async function deleteDecision(key) {
  const d = state.list.find(x => x.key === key);
  const label = d ? (d.name || d.key) : key;
  if (!await cmxConfirm({ message: `确认删除决策集「${label}」？\n将连同其发布版本、决策日志、测试用例一并永久删除，不可恢复。`, intent: 'danger', confirmText: '删除' })) return;
  try {
    await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(key), { method: 'DELETE' });
  } catch (e) { flash('删除失败: ' + e.message, true); return; }
  if (state.selectedKey === key) { state.selectedKey = null; state.detail = null; state.analysis = null; state.loadingKey = null; }
  await loadList();
  refreshView('content'); refreshView('property');
  flash(`已删除「${label}」`);
}

// ── 分类：改选中决策集所属分类（元数据；取完整 def → 覆盖 categoryCode → 重存草稿，不改版本/发布态）──
async function recategorize(newCode) {
  const key = state.selectedKey; if (!key) return;
  const meta = state.list.find(x => x.key === key) || {};
  let def; try { def = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(key)); }
  catch (e) { flash('读取定义失败: ' + e.message, true); return; }
  def.name = def.name || meta.name || key;
  if (newCode) def.categoryCode = newCode; else delete def.categoryCode;
  try {
    await apiJson('/api/rules/v1/definitions/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def) });
  } catch (e) { flash('改分类失败: ' + e.message, true); return; }
  await loadList(); refreshView('property');
  flash('已更新分类');
}

// ── 分类字典管理（受管 CRUD：新增 / 重命名 / 上下移 / 删除）──
async function saveCategory(cat) {
  await apiJson('/api/rules/v1/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cat) });
}
async function catAdd(root) {
  const code = slugify(root.querySelector('#cat-new-code')?.value || '') || slugify(root.querySelector('#cat-new-name')?.value || '');
  const name = (root.querySelector('#cat-new-name')?.value || '').trim();
  if (!code) { flash('请填写分类 code 或名称', true); return; }
  if ((state.categories || []).some(c => c.code === code)) { flash(`分类「${code}」已存在`, true); return; }
  const ord = (state.categories || []).reduce((m, c) => Math.max(m, c.ord || 0), 0) + 1;
  try { await saveCategory({ code, name: name || code, ord }); } catch (e) { flash('新增分类失败: ' + e.message, true); return; }
  await loadList(); flash(`已新增分类「${name || code}」`);
}
async function catRename(code, name) {
  const c = (state.categories || []).find(x => x.code === code); if (!c || (c.name || '') === name) return;
  try { await saveCategory({ code, name, ord: c.ord || 0 }); } catch (e) { flash('重命名失败: ' + e.message, true); return; }
  await loadList();
}
async function catMove(code, dir) {
  const cats = [...(state.categories || [])]; // 已按 ord 升序
  const i = cats.findIndex(c => c.code === code); if (i < 0) return;
  const j = dir === 'up' ? i - 1 : i + 1; if (j < 0 || j >= cats.length) return;
  const a = cats[i], b = cats[j], ao = a.ord || 0, bo = b.ord || 0;
  try { await saveCategory({ code: a.code, name: a.name || a.code, ord: bo }); await saveCategory({ code: b.code, name: b.name || b.code, ord: ao }); }
  catch (e) { flash('排序失败: ' + e.message, true); return; }
  await loadList();
}
async function catDelete(code) {
  const c = (state.categories || []).find(x => x.code === code);
  if (!await cmxConfirm({ message: `确认删除分类「${c ? (c.name || c.code) : code}」？\n引用它的决策集将归入「未分类」。`, intent: 'danger', confirmText: '删除' })) return;
  try { await apiJson('/api/rules/v1/categories/' + encodeURIComponent(code), { method: 'DELETE' }); }
  catch (e) { flash('删除分类失败: ' + e.message, true); return; }
  await loadList(); flash('已删除分类');
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
    maybeMountPreview(host, view);
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
    maybeMountPreview(host, view);
  }
}
// content 区且当前是决策图 → 挂只读组件预览。
function maybeMountPreview(host, view) {
  if (view !== 'content') return;
  const d = state.detail;
  if (d && (d.kind === 'graph' || Array.isArray(d.nodes))) mountGraphPreview(host, d);
}

// ── 四区 HTML ──
function viewHtml(view) {
  if (view === 'explorer') return explorerHtml();
  if (view === 'property') return propertyHtml();
  return contentHtml();
}
function explorerHtml() {
  const gl = groupedList();
  const catOpts = (state.categories || []).map(c => `<option value="${esc(c.code)}">${esc(c.name || c.code)}</option>`).join('');
  const createForm = state.creating ? `
    <div class="np-create">
      <div class="np-seg-row">
        <label class="np-seg"><input type="radio" name="nc-kind" value="decisionTable" checked> 决策表</label>
        <label class="np-seg"><input type="radio" name="nc-kind" value="graph"> 决策图</label>
      </div>
      <input class="np-in" id="nc-name" placeholder="决策集名称，如 授信审批" autocomplete="off">
      <input class="np-in" id="nc-key" placeholder="业务键（英数下划线，如 credit_line）" autocomplete="off">
      <select class="np-in" id="nc-cat" title="分类"><option value="">未分类</option>${catOpts}</select>
      <div class="np-create-row">
        <button class="np-btn xs" data-act="create-ok">创建并编辑</button>
        <button class="np-btn xs ghost" data-act="create-cancel">取消</button>
      </div>
      <div class="np-create-hint">决策表=单张二维表+命中策略；决策图=多节点编排的 DAG。键跨版本不变、求值按它寻址；留空则由名称推导。</div>
    </div>` : '';
  const mgr = state.managingCats ? catManagerHtml() : '';
  const groupsHtml = gl.groups.length
    ? gl.groups.map(g => {
        const gid = g.code || '__none__';
        const open = state.search ? true : !state.collapsed[gid]; // 搜索时强制展开；否则按折叠态（默认展开）
        return `<details class="np-grp"${open ? ' open' : ''} data-grp="${esc(gid)}">
          <summary class="np-grp-hd"><span class="np-grp-nm">${esc(g.name)}</span><span class="np-sub">${g.items.length}</span></summary>
          <ul class="np-list-inner">${g.items.map(itemRow).join('')}</ul>
        </details>`;
      }).join('')
    : `<div class="np-empty">${state.list.length ? '无匹配决策集' : '暂无决策集'}</div>`;
  return `<div class="np-root np-explorer">
    <div class="np-hd">决策集<span class="np-sub">${gl.filteredTotal}${gl.filteredTotal !== state.list.length ? '/' + state.list.length : ''}</span>
      <span class="np-hd-actions"><button class="np-btn xs" data-act="new">+ 新建</button><button class="np-iconbtn ${state.managingCats ? 'on' : ''}" data-act="cat-manage" title="管理分类">⚙</button></span></div>
    <div class="np-searchbar">
      <span class="np-searchwrap"><input class="np-in np-search" id="np-search" placeholder="查找名称或键…" value="${esc(state.search)}" autocomplete="off"/>${state.search ? '<button class="np-searchx" data-act="search-clear" title="清空">✕</button>' : ''}</span>
      <button class="np-iconbtn" data-act="reload" title="刷新">${ICON_REFRESH}</button>
    </div>
    ${mgr}
    ${createForm}
    <div class="np-groups">${groupsHtml}</div>
  </div>`;
}
// 单个决策集行（分组内复用）。
function itemRow(d) {
  return `<li class="np-item ${d.key === state.selectedKey ? 'sel' : ''}" data-key="${esc(d.key)}">
      <span class="np-dot ${d.published ? 'pub' : 'draft'}"></span>
      <span class="np-nm">${esc(d.name || d.key)}</span>
      <span class="np-ver">v${d.version ?? 1}</span>
      <button class="np-del" data-del="${esc(d.key)}" title="删除决策集">✕</button>
    </li>`;
}
// 分类管理面板（受管字典 CRUD：改名/上下移/删除/新增）。
function catManagerHtml() {
  const rows = (state.categories || []).map(c => `
    <div class="np-catrow" data-cat="${esc(c.code)}">
      <input class="np-in xs np-cat-name" data-cat-name="${esc(c.code)}" value="${esc(c.name || '')}" placeholder="分类名" title="回车/失焦保存名称"/>
      <span class="np-cat-code" title="分类 code">${esc(c.code)}</span>
      <button class="np-iconbtn xs" data-act="cat-up" data-code="${esc(c.code)}" title="上移">↑</button>
      <button class="np-iconbtn xs" data-act="cat-down" data-code="${esc(c.code)}" title="下移">↓</button>
      <button class="np-iconbtn xs danger" data-act="cat-del" data-code="${esc(c.code)}" title="删除分类">✕</button>
    </div>`).join('') || '<div class="np-empty">暂无分类，下方新增</div>';
  return `<div class="np-catmgr">
    <div class="np-catmgr-hd">分类管理<button class="np-btn xs ghost" data-act="cat-manage">收起</button></div>
    ${rows}
    <div class="np-catadd">
      <input class="np-in xs" id="cat-new-code" placeholder="code（英数下划线）" autocomplete="off"/>
      <input class="np-in xs" id="cat-new-name" placeholder="名称" autocomplete="off"/>
      <button class="np-btn xs" data-act="cat-add">+ 加分类</button>
    </div>
  </div>`;
}
const ICON_REFRESH = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3h-3"/></svg>';
const NODE_LABEL = { input: '输入', output: '输出', decisionTable: '决策表', expression: '表达式', decision: '子决策' };

// ── 决策图预览用独立组件 <cmx-decision-graph readonly>（与设计器同一组件，只读模式）。──
// native 页 new Function 执行、不能相对 import，故 fetch 组件源 → blob import 自注册（一次性幂等）。
let _componentPromise = null;
function ensureGraphComponent() {
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
// 把预览组件挂进图态 content 宿主（幂等）。
function mountGraphPreview(host, def) {
  const root = hostRoot(host);
  const slot = root && root.querySelector('[data-graph-preview]');
  if (!slot) return;
  if (typeof customElements === 'undefined' || !customElements.get('cmx-decision-graph')) {
    ensureGraphComponent().then(() => mountGraphPreview(host, def)).catch(() => { slot.innerHTML = '<div class="np-placeholder">图组件加载失败</div>'; });
    return;
  }
  let el = slot.querySelector('cmx-decision-graph');
  if (!el) {
    el = document.createElement('cmx-decision-graph'); el.setAttribute('readonly', ''); el.style.cssText = 'display:block;height:360px'; slot.innerHTML = ''; slot.appendChild(el);
    // 只读预览也支持点选：点节点/边 → 右侧 property 区显只读属性。
    el.addEventListener('node-select', (e) => { state.gNode = e.detail.node || null; state.gEdge = null; refreshView('property'); });
    el.addEventListener('edge-select', (e) => { state.gEdge = e.detail.edge || null; state.gNode = null; refreshView('property'); });
  }
  if (typeof el.setGraph === 'function') el.setGraph(def);
}
function contentHtml() {
  if (!state.selectedKey) return `<div class="np-root"><div class="np-placeholder">从左侧选择一个决策集</div></div>`;
  const d = state.detail;
  if (!d) return `<div class="np-root"><div class="np-placeholder">加载中…</div></div>`;
  // 决策图：用只读组件画真正的有向图；编辑走可视化图设计器。
  if (d.kind === 'graph' || Array.isArray(d.nodes)) {
    const nodes = d.nodes || [], edges = d.edges || [];
    return `<div class="np-root">
      <div class="np-hd">${esc(d.name || d.key)} · <b>决策图</b>
        <button class="np-btn xs" data-act="open-designer">编辑（F3）</button></div>
      <div class="np-graphmeta">${nodes.length} 个节点 · ${edges.length} 条边</div>
      <div class="np-svgwrap" data-graph-preview><div class="np-placeholder">图组件加载中…</div></div>
    </div>`;
  }
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
const NODE_LABEL_P = { input: '输入', output: '输出', decisionTable: '决策表', expression: '表达式', decision: '子决策' };
function graphSelectionHtml() {
  const d = state.detail;
  const nodeName = (id) => { const n = (d?.nodes || []).find(x => x.id === id); return n ? (n.name || n.id) : id; };
  if (state.gNode) {
    const n = state.gNode;
    let extra = '';
    if (n.type === 'decisionTable' && n.table) {
      const t = n.table;
      extra = `<div class="np-kv"><span>命中策略</span><b>${esc(t.hitPolicy || 'U')}</b></div>
        <div class="np-kv"><span>规模</span><b>${(t.inputs || []).length} 入 / ${(t.outputs || []).length} 出 / ${(t.rules || []).length} 则</b></div>`;
    } else if (n.type === 'expression') {
      const rows = (n.mappings || []).map(m => `<div class="np-gap">${esc(m.key)} = ${esc(m.expression)}</div>`).join('');
      extra = `<div class="np-kv"><span>映射</span><b>${(n.mappings || []).length} 条</b></div>${rows}`;
    } else if (n.type === 'decision') {
      extra = `<div class="np-kv"><span>引用</span><b>${esc(n.decisionKey || '未选')}</b></div>`;
    }
    return `<div class="np-hd">选中节点<span class="np-sub">只读 · 编辑请进设计器</span></div>
      <div class="np-kv"><span>类型</span><b>${esc(NODE_LABEL_P[n.type] || n.type)}</b></div>
      <div class="np-kv"><span>名称</span><b>${esc(n.name || n.id)}</b></div>
      <div class="np-kv"><span>id</span><b>${esc(n.id)}</b></div>
      ${extra}`;
  }
  if (state.gEdge) {
    const e = state.gEdge;
    return `<div class="np-hd">选中边<span class="np-sub">只读</span></div>
      <div class="np-kv"><span>从</span><b>${esc(nodeName(e.source))}</b></div>
      <div class="np-kv"><span>到</span><b>${esc(nodeName(e.target))}</b></div>
      <div class="np-gap">数据从「${esc(nodeName(e.source))}」流入「${esc(nodeName(e.target))}」</div>`;
  }
  return '';
}
function propertyHtml() {
  if (!state.selectedKey) return `<div class="np-root"><div class="np-placeholder">未选择</div></div>`;
  const d = state.detail, a = state.analysis;
  // 当前分类以列表元数据为准（草稿行的 categoryCode；published 定义 detail 走 release 不带分类）。
  const curCat = (state.list.find(x => x.key === state.selectedKey) || {}).categoryCode || '';
  const isGraph = d && (d.kind === 'graph' || Array.isArray(d.nodes));
  const selHtml = isGraph ? graphSelectionHtml() : '';
  const analysisHtml = a ? `
    <div class="np-analysis">
      <div class="np-badge ${a.complete ? 'ok' : 'warn'}">${a.complete ? '✓ 无空隙' : '⚠ 有空隙 ' + (a.gaps || []).length}</div>
      <div class="np-badge ${a.hasOverlap ? 'warn' : 'ok'}">${a.hasOverlap ? '⚠ 有重叠 ' + (a.overlaps || []).length : '✓ 无重叠'}</div>
      ${(a.gaps || []).slice(0, 6).map(g => `<div class="np-gap">${esc(g.description)}</div>`).join('')}
      ${(a.overlaps || []).slice(0, 6).map(o => `<div class="np-gap">${esc(o.description)}</div>`).join('')}
    </div>` : '<div class="np-placeholder">分析中…</div>';
  return `<div class="np-root">
    ${selHtml}
    <div class="np-hd">定义详情</div>
    <div class="np-kv"><span>键</span><b>${esc(state.selectedKey)}</b></div>
    <div class="np-kv"><span>名称</span><b>${esc(d?.name || '')}</b></div>
    <div class="np-kv"><span>版本</span><b>v${d?.version ?? 1}</b></div>
    <div class="np-kv np-kv-sel"><span>分类</span>
      <select class="np-in xs" id="np-cat-sel" title="改变即保存">
        <option value="" ${!curCat ? 'selected' : ''}>未分类</option>
        ${(state.categories || []).map(c => `<option value="${esc(c.code)}" ${curCat === c.code ? 'selected' : ''}>${esc(c.name || c.code)}</option>`).join('')}
      </select>
    </div>
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
function designerView(id, view, tabLabel, icon, props, page) {
  return { id, tabLabel, icon, type: 'native_pages', native_page: page, view, props };
}
function openDesigner(sourceEl) {
  const d = state.detail || {};
  const key = state.selectedKey; if (!key) return;
  const version = d.version ?? 1;
  const props = { key, name: d.name || key, version };
  const slug = String(key).replace(/[^a-zA-Z0-9]+/g, '_');
  const sid = `${slug}_${version}`;
  const isGraph = d.kind === 'graph' || Array.isArray(d.nodes);
  const page = isGraph ? 'portal.rules.graph-designer' : 'portal.rules.designer';
  const label = isGraph ? '决策图设计器' : '决策表设计器';
  const icon = isGraph ? 'org-chart' : 'table-view';
  const contentCap = isGraph ? '决策图' : '决策表';
  const menu = {
    id: `rules-designer-${sid}`, code: `rules-designer-${sid}`,
    name: `rules-designer-${sid}`, caption: `${d.name || key} · ${label}`,
    type: 'workspace-node', icon, openType: 0, status: 1,
    workspace: {
      id: `rules_designer_${sid}`, params: props, explorerWidth: 300, propertyWidth: 340,
      model: { id: `rules-designer-${sid}-model`, type: 'native_pages', native_page: page, view: 'content', props },
      explorer: { caption: isGraph ? '节点' : '设计资源', icon: 'database', views: [designerView(`rules-designer-${sid}-fields`, 'explorer', isGraph ? '节点/子决策' : '字段/函数', 'database', props, page)] },
      content: { caption: contentCap, icon, views: [designerView(`rules-designer-${sid}-grid`, 'content', contentCap, icon, props, page)] },
      property: { caption: '属性', icon: 'detail-view', views: [designerView(`rules-designer-${sid}-prop`, 'property', isGraph ? '节点/分析' : '完整性', 'detail-view', props, page)] },
    },
  };
  openWorkNode(menu, sourceEl);
}

// ── 事件委托 ──
// 监听器绑在持久的 root 上并靠 closest 委托，故**每个 root 只绑一次**。
// refreshView/render 只重置 innerHTML（不动 root 本身），重复 bind 会叠加监听器：
// selectDecision 内又 refreshView('explorer') 重绑点击来源 → 监听器指数增长 → 每次点击触发成倍相同请求 → 假死。
function bind(root, view) {
  if (root.__ruleBound) return;
  root.__ruleBound = true;
  root.addEventListener('click', (ev) => {
    const del = ev.target.closest('[data-del]');
    if (del) { ev.stopPropagation(); deleteDecision(del.getAttribute('data-del')); return; } // 删除按钮：先于行选中拦截
    const item = ev.target.closest('[data-key]');
    if (item) { selectDecision(item.getAttribute('data-key')); return; }
    const actEl = ev.target.closest('[data-act]');
    const act = actEl?.getAttribute('data-act');
    if (!act) return;
    if (act === 'reload') loadList();
    else if (act === 'new') { state.creating = true; refreshView('explorer'); focusCreate(root); }
    else if (act === 'create-ok') createDecision(root);
    else if (act === 'create-cancel') { state.creating = false; refreshView('explorer'); }
    else if (act === 'publish' && state.selectedKey) publish(state.selectedKey);
    else if (act === 'open-designer') openDesigner(ev.target);
    else if (act === 'page-prev') { if (state.page > 1) { state.page--; refreshView('explorer'); } }
    else if (act === 'page-next') { state.page++; refreshView('explorer'); }
    else if (act === 'search-clear') { state.search = ''; state.page = 1; refreshView('explorer'); focusSearch(root); }
    // 分类管理
    else if (act === 'cat-manage') { state.managingCats = !state.managingCats; refreshView('explorer'); }
    else if (act === 'cat-add') catAdd(root);
    else if (act === 'cat-up') catMove(actEl.getAttribute('data-code'), 'up');
    else if (act === 'cat-down') catMove(actEl.getAttribute('data-code'), 'down');
    else if (act === 'cat-del') catDelete(actEl.getAttribute('data-code'));
  }, { once: false });
  // 分组折叠态记忆（toggle 不冒泡 → 捕获阶段在 root 接住；只记 state，不重渲）。
  root.addEventListener('toggle', (ev) => {
    const d = ev.target; if (!d.matches || !d.matches('details.np-grp')) return;
    state.collapsed[d.getAttribute('data-grp')] = !d.open;
  }, true);
  // 分类选择/重命名（change=失焦/回车）。
  root.addEventListener('change', (ev) => {
    if (ev.target.id === 'np-cat-sel') { recategorize(ev.target.value); return; }
    if (ev.target.classList && ev.target.classList.contains('np-cat-name')) { catRename(ev.target.getAttribute('data-cat-name'), ev.target.value.trim()); return; }
  });
  // 查找输入：即时过滤。整页重渲后恢复输入焦点+光标（这样清空按钮✕能正确出现/消失）。
  root.addEventListener('input', (ev) => {
    if (ev.target.id !== 'np-search') return;
    const pos = ev.target.selectionStart;
    state.search = ev.target.value; state.page = 1;
    refreshView('explorer');
    focusSearch(root, pos);
  });
  // 新建输入框回车即创建；分类新增输入回车即加分类。
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (ev.target.id === 'nc-name' || ev.target.id === 'nc-key') { ev.preventDefault(); createDecision(root); }
    else if (ev.target.id === 'cat-new-code' || ev.target.id === 'cat-new-name') { ev.preventDefault(); catAdd(root); }
  });
}
// 恢复搜索框焦点 + 光标位置（整页重渲后）。
function focusSearch(root, pos) {
  requestAnimationFrame(() => { for (const h of state.hosts) { if (h.__ruleView === 'explorer') { const r = hostRoot(h); const inp = r?.querySelector?.('#np-search'); if (inp) { inp.focus(); const p = pos == null ? inp.value.length : pos; try { inp.setSelectionRange(p, p); } catch { /* */ } } } } });
}
function focusCreate(root) {
  requestAnimationFrame(() => { for (const h of state.hosts) { if (h.__ruleView === 'explorer') { const r = hostRoot(h); r?.querySelector?.('#nc-name')?.focus(); } } });
}

function flash(msg, err) {
  try {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:9999;padding:10px 18px;border-radius:8px;font-size:13px;color:var(--sapGroup_ContentBorderColor, #ffffff);background:${err ? 'var(--sapNegativeElementColor, #d9534f)' : 'var(--sapPositiveElementColor, #2e7d5b)'};box-shadow:0 4px 16px rgba(0,0,0,.25)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  } catch { /* 无 document */ }
}

const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）

function styleCss() {
  return `
  .np-root{
    /* ── 设计令牌：全部锚定 UI5 --sap* 变量（随门户主题 light/dark 翻转，穿透 shadow DOM）；
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
  /* 分类分组折叠 */
  .np-groups{flex:1 1 auto;overflow:auto;min-height:0;margin:0 -2px;padding:0 2px}
  .np-list-inner{list-style:none;margin:0;padding:0}
  .np-grp{border-bottom:1px solid var(--dg-border)}
  .np-grp[open]>.np-grp-hd{color:var(--dg-fg)}
  .np-grp-hd{list-style:none;cursor:pointer;user-select:none;display:flex;align-items:center;gap:7px;padding:7px 6px;font-size:11.5px;font-weight:600;color:var(--dg-muted);letter-spacing:.02em}
  .np-grp-hd::-webkit-details-marker{display:none}
  .np-grp-hd::before{content:"▸";font-size:10px;color:var(--dg-faint);transition:transform .12s;flex:0 0 auto}
  .np-grp[open]>.np-grp-hd::before{transform:rotate(90deg)}
  .np-grp-nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .np-hd-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto}
  .np-iconbtn.on{color:var(--dg-accent);background:var(--dg-accent-soft)}
  /* 分类管理面板 */
  .np-catmgr{border:1px solid var(--dg-border);border-radius:8px;padding:7px;margin:2px 0 8px;background:var(--dg-surface)}
  .np-catmgr-hd{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--dg-muted);margin-bottom:6px}
  .np-catrow{display:flex;align-items:center;gap:5px;margin-bottom:4px}
  .np-cat-name{flex:1 1 auto;min-width:0}
  .np-cat-code{flex:0 0 auto;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dg-mono);font-size:10.5px;color:var(--dg-faint)}
  .np-catadd{display:flex;align-items:center;gap:5px;margin-top:7px;padding-top:7px;border-top:1px dashed var(--dg-border)}
  .np-in.xs{height:26px;font-size:12px;padding:2px 7px}
  .np-kv-sel{align-items:center}
  .np-kv-sel select.np-in{flex:1 1 auto;min-width:0;margin-left:8px}
  .np-hd{font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dg-muted);margin:12px 0 7px;display:flex;align-items:center;gap:8px;flex:0 0 auto}
  .np-hd::before{content:"";width:3px;height:12px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent-line)}
  .np-hd:first-child{margin-top:2px}
  .np-sub{font-weight:500;color:var(--dg-faint);font-size:10px;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;padding:1px 6px;border-radius:10px;background:var(--dg-accent-soft)}
  .np-list{list-style:none;margin:0;padding:0}
  .np-item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:9px;cursor:pointer;position:relative;border:1px solid transparent;transition:background .14s,border-color .14s}
  .np-item:hover{background:var(--dg-hover)}
  .np-item.sel{background:var(--dg-sel);border-color:var(--dg-accent-line)}
  .np-item.sel::before{content:"";position:absolute;left:0;top:18%;bottom:18%;width:2.5px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent)}
  .np-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent)}
  .np-dot.pub{background:var(--dg-ok);color:var(--dg-ok)}.np-dot.draft{background:var(--dg-faint);color:var(--dg-faint)}
  .np-nm{flex:1;font-weight:500}.np-ver{font-size:10px;color:var(--dg-faint);font-variant-numeric:tabular-nums;font-family:var(--dg-mono)}
  .np-del{flex:0 0 auto;border:none;background:transparent;color:var(--dg-faint);font-size:12px;line-height:1;padding:2px 5px;border-radius:6px;cursor:pointer;opacity:0;transition:opacity .12s,background .12s,color .12s}
  .np-item:hover .np-del{opacity:1}
  .np-del:hover{background:color-mix(in srgb,var(--dg-danger) 16%,transparent);color:var(--dg-danger)}
  .np-empty,.np-placeholder{color:var(--dg-faint);padding:22px 10px;text-align:center;font-size:12px}
  .np-btn{border:1px solid var(--dg-border-strong);background:var(--dg-surface);color:var(--dg-accent);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer;transition:border-color .14s,box-shadow .14s,background .14s}
  .np-btn:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}
  .np-btn.xs{padding:3px 9px;font-size:11px}
  .np-btn.ghost{border-color:var(--dg-border);color:var(--dg-muted);background:transparent}
  .np-btn.ghost:hover{border-color:var(--dg-accent);color:var(--dg-accent)}
  .np-btn.ghost[disabled]{opacity:.35;cursor:default;box-shadow:none;border-color:var(--dg-border)}
  .np-create{display:flex;flex-direction:column;gap:7px;padding:11px;margin:2px 0 8px;border:1px solid var(--dg-border);border-radius:11px;background:linear-gradient(180deg,var(--dg-accent-soft),transparent),var(--dg-surface);flex:0 0 auto;box-shadow:0 8px 24px -18px var(--dg-accent)}
  .np-in{border:1px solid var(--dg-border-strong);border-radius:8px;padding:7px 10px;font-size:13px;background:var(--sapField_Background,#fff);color:inherit;box-sizing:border-box;width:100%;transition:border-color .14s,box-shadow .14s}
  .np-in:focus{outline:none;border-color:var(--dg-accent);box-shadow:0 0 0 3px var(--dg-accent-soft)}
  .np-create-row{display:flex;gap:6px}
  .np-create-hint{font-size:11px;color:var(--dg-faint);line-height:1.5}
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
  .np-seg-row{display:flex;gap:6px}
  .np-seg{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;border:1px solid var(--dg-border-strong);border-radius:8px;padding:6px 8px;font-size:12px;cursor:pointer;background:var(--sapField_Background,#fff);transition:border-color .14s,background .14s,color .14s}
  .np-seg:has(input:checked){border-color:var(--dg-accent);background:var(--dg-accent-soft);color:var(--dg-accent);font-weight:600;box-shadow:inset 0 0 0 1px var(--dg-accent-line)}
  .np-graphmeta{margin:2px 0 8px;font-size:11px;color:var(--dg-muted);font-variant-numeric:tabular-nums}
  .np-svgwrap{overflow:auto;border:1px solid var(--dg-border);border-radius:11px;background:
    radial-gradient(120% 80% at 50% -10%,var(--dg-accent-soft),transparent 60%),
    linear-gradient(90deg,color-mix(in srgb,var(--dg-accent) 6%,transparent) 1px,transparent 1px) 0 0/22px 22px,
    linear-gradient(color-mix(in srgb,var(--dg-accent) 6%,transparent) 1px,transparent 1px) 0 0/22px 22px,var(--dg-surface);min-height:140px}
  .np-svg{display:block}
  .np-node rect{fill:var(--dg-bg);stroke:var(--dg-border-strong);stroke-width:1.5}
  .np-node.t-input rect,.np-node.t-output rect{fill:color-mix(in srgb,var(--dg-faint) 12%,var(--dg-bg))}
  .np-node.t-decisionTable rect{fill:color-mix(in srgb,var(--dg-accent) 10%,var(--dg-bg))}
  .np-node.t-expression rect{fill:color-mix(in srgb,var(--dg-ok) 12%,var(--dg-bg))}
  .np-node.t-decision rect{fill:color-mix(in srgb,#7c5cff 12%,var(--dg-bg))}
  .np-nlabel{font-size:11px;font-weight:600;fill:var(--dg-fg);text-anchor:middle}
  .np-ntype{font-size:9px;fill:var(--dg-faint);text-anchor:middle}
  .np-edge{fill:none;stroke:color-mix(in srgb,var(--dg-accent) 55%,var(--dg-muted));stroke-width:1.5}
  .np-tablewrap{overflow:auto;border:1px solid var(--dg-border);border-radius:11px}
  .np-dt{border-collapse:collapse;width:100%;font-size:12px}
  .np-dt th,.np-dt td{border:1px solid var(--dg-border);padding:6px 10px;text-align:left;white-space:nowrap}
  .np-dt th{background:color-mix(in srgb,var(--dg-accent) 5%,var(--dg-surface));font-weight:600;position:sticky;top:0}
  .np-dt th.in,.np-dt td.in{background:color-mix(in srgb,var(--dg-accent) 6%,transparent)}
  .np-dt th.out,.np-dt td.out{background:color-mix(in srgb,var(--dg-ok) 7%,transparent)}
  .np-dt td.idx{color:var(--dg-faint);text-align:center;font-family:var(--dg-mono)}
  .np-kv{display:flex;gap:8px;padding:5px 0;align-items:baseline}.np-kv span{color:var(--dg-faint);width:44px;font-size:11px;flex:0 0 auto}
  .np-analysis{display:flex;flex-direction:column;gap:6px}
  .np-badge{display:inline-flex;align-items:center;gap:5px;width:fit-content;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid transparent}
  .np-badge.ok{background:color-mix(in srgb,var(--dg-ok) 14%,transparent);color:var(--dg-ok);border-color:color-mix(in srgb,var(--dg-ok) 30%,transparent)}
  .np-badge.warn{background:color-mix(in srgb,var(--dg-warn) 15%,transparent);color:var(--dg-warn);border-color:color-mix(in srgb,var(--dg-warn) 32%,transparent)}
  .np-gap{font-size:11px;color:var(--dg-warn);padding:2px 0;line-height:1.5}
  .np-actions{margin-top:14px;display:flex;gap:6px;flex-wrap:wrap}
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
