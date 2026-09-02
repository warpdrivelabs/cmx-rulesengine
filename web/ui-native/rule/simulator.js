/*
 * portal.rules.simulator —— 决策仿真台 / 应用器（native_pages 多实例，四区）。
 *
 * 由 portal.rules.sim-workbench 的「打开仿真台」经 openWorkNode 动态开成 Tab；instances Map 按
 * instanceKey(key@@version) 隔离多实例。数据消费侧（对标报表 report-applier）：
 *   content  —— 输入事实 facts 表单 + 「求值」→ 输出 + 命中行 + 时延 + 失败归因；「存为用例」
 *   property —— 决策轨迹 trace 逐节点归因（命中/未命中/**失败节点红标**）+ 决策元信息
 *   explorer —— 测试用例集（点击载入 facts / 删除）+「运行套件」→ 通过率 + 覆盖率 + 逐例 diff
 *
 * 走 /simulate（不落审计日志，试算）；用例 /tests（增删查）+ /tests/run（批跑 diff + 覆盖率）。
 * 把 R0 已产出的 trace + 失败归因**可视化**——这是相对 GoRules ZEN 的差异化（其 trace 不显示失败节点）。
 */

const CFG = { apiBase: '', fetchInit: { credentials: 'same-origin' }, authHeaders: () => ({}) };
export function configure(o) { Object.assign(CFG, o || {}); return CFG; }

const instances = new Map();
function instanceKey(props) { return `${props?.key || '?'}@@${props?.version ?? 'draft'}`; }
function getInst(ctx) {
  const k = instanceKey(ctx.props);
  let st = instances.get(k);
  if (!st) { st = { props: ctx.props || {}, def: null, facts: {}, result: null, tests: [], runResult: null, loaded: false, hosts: new Set() }; instances.set(k, st); }
  return st;
}

const { apiJson: _sharedApiJson } = globalThis.__cmxDataComp // 共享 fetch 封装（cmx-data-comp/lib/cmx-page-helpers.js）；经 CFG 转发保留组件壳 configure() 契约
async function apiJson (url, options = {}) { return _sharedApiJson(url, options, CFG) }

// facts 值智能转型：纯数字→number，true/false→bool，否则 string（空跳过）。
function typedInput(facts) {
  const input = {};
  for (const [k, raw] of Object.entries(facts)) {
    if (raw === '' || raw == null) continue;
    if (/^-?\d+(\.\d+)?$/.test(raw)) input[k] = Number(raw);
    else if (raw === 'true' || raw === 'false') input[k] = raw === 'true';
    else input[k] = raw;
  }
  return input;
}

// FEEL 保留字/内置函数名（不作为事实变量提取）。
const FEEL_RESERVED = new Set([
  'if', 'then', 'else', 'and', 'or', 'not', 'true', 'false', 'null', 'for', 'in', 'return',
  'some', 'every', 'satisfies', 'item',
  'floor', 'ceiling', 'ceil', 'round', 'abs', 'modulo', 'sqrt', 'min', 'max', 'sum', 'mean', 'avg',
  'upper', 'upperCase', 'lower', 'lowerCase', 'substring', 'contains', 'startsWith', 'startswith',
  'endsWith', 'endswith', 'concatenate', 'concat', 'string', 'number', 'trim', 'count', 'length',
  'len', 'sort', 'append', 'coalesce',
]);

// 从 FEEL 表达式提取顶层变量名（取标识符根，去保留字/函数调用名/字符串字面量内文本）。
function extractVars(expr, out) {
  if (!expr || typeof expr !== 'string') return;
  // 先剔除字符串字面量（"..." / '...'），避免把引号内文本误当变量。
  const stripped = expr.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/'(?:[^'\\]|\\.)*'/g, ' ');
  const re = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g;
  let m;
  while ((m = re.exec(stripped))) {
    // 函数调用名（后跟左括号）跳过。
    if (stripped[re.lastIndex] === '(') continue;
    const root = m[0].split('.')[0];
    if (FEEL_RESERVED.has(root)) continue;
    out.add(root);
  }
}

// 收集一个决策所有可作为「输入事实」的变量：输入列表达式 ∪ 输出/单元格/图节点表达式引用的自由变量。
// 修复 BUG-003：输出格如 income*5 引用的 income 不是输入列，原表单遗漏，用户无法录入。
function collectFactVars(d) {
  if (!d) return [];
  const vars = [];        // 有序：输入列在前
  const seen = new Set();
  const add = (name, label) => { if (name && !seen.has(name)) { seen.add(name); vars.push({ name, label: label || name }); } };
  // 1) 决策表输入列（保留 label）。
  (d.inputs || []).forEach(c => { const k = c.expression; if (k) add(k, c.label); extraFromExpr(c.expression); });
  // 2) 决策表规则行单元格 + 输出格表达式。
  (d.rules || []).forEach(r => {
    (r.inputEntries || []).forEach(extraFromExpr);
    (r.outputEntries || []).forEach(extraFromExpr);
  });
  // 3) 决策图节点：内联表、expression 映射、edge 无表达式。
  (d.nodes || []).forEach(n => {
    if (n.table) collectFactVars(n.table).forEach(v => add(v.name, v.label));
    (n.mappings || []).forEach(mp => extraFromExpr(mp.expression));
  });
  function extraFromExpr(expr) {
    const s = new Set();
    extractVars(expr, s);
    s.forEach(v => add(v));
  }
  return vars;
}

async function loadAll(st) {
  try { st.def = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(st.props.key)); } catch { st.def = null; }
  try { st.tests = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/tests') || []; } catch { st.tests = []; }
  st.loaded = true;
}
// 组装最终 input：表单 facts（智能转型）叠加「高级 JSON」（若填了且合法，覆盖同名字段）。
function buildInput(st) {
  const base = typedInput(st.facts);
  const raw = (st.factsRaw || '').trim();
  if (!raw) return base;
  try { const j = JSON.parse(raw); if (j && typeof j === 'object') return { ...base, ...j }; } catch { /* 非法 JSON 忽略，仅用表单 */ }
  return base;
}
async function evaluate(st) {
  try {
    st.result = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: buildInput(st), options: { trace: true } }),
    });
  } catch (e) { st.result = { error: e.message }; }
  refresh(st, 'content'); refresh(st, 'property');
}
async function saveAsTest(st) {
  if (!st.result || st.result.error) { flash('先求值再存为用例', true); return; }
  const name = prompt('用例名称：', '场景 ' + (st.tests.length + 1));
  if (name == null) return;
  try {
    await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/tests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, input: buildInput(st), expected: st.result.output }),
    });
    st.tests = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/tests') || [];
    flash('已存为用例'); refresh(st, 'explorer');
  } catch (e) { flash('存用例失败：' + e.message, true); }
}
async function delTest(st, id) {
  try { await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/tests/' + encodeURIComponent(id), { method: 'DELETE' });
    st.tests = st.tests.filter(t => t.id !== id); refresh(st, 'explorer'); } catch (e) { flash('删除失败：' + e.message, true); }
}
async function runSuite(st) {
  try { st.runResult = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/tests/run', { method: 'POST' }); }
  catch (e) { st.runResult = { error: e.message }; }
  refresh(st, 'explorer'); refresh(st, 'property');
}
function loadTestFacts(st, id) {
  const t = st.tests.find(x => x.id === id); if (!t) return;
  st.facts = {}; for (const [k, v] of Object.entries(t.input || {})) st.facts[k] = String(v);
  st.result = null; refresh(st, 'content');
}

// ── 渲染 ──
function hostRoot(host) { return host?.renderRoot || host?.shadowRoot?.querySelector('.rs') || host; }
function mount(ctx, view) {
  const st = getInst(ctx); const host = ctx.host; st.hosts.add(host); host.__view = view; host.__key = instanceKey(ctx.props);
  const render = () => { const root = hostRoot(host); if (!root || root.isConnected === false) return; root.innerHTML = `<style>${css()}</style>${viewHtml(st, view)}`; bind(root, st, view); };
  requestAnimationFrame(async () => { render(); if (!st.loaded) { await loadAll(st); refresh(st, 'content'); refresh(st, 'explorer'); refresh(st, 'property'); } });
  return `<style>${css()}</style>${viewHtml(st, view)}`;
}
function refresh(st, view) {
  for (const host of st.hosts) { if (host.__view !== view) continue; const root = hostRoot(host); if (!root || root.isConnected === false) continue; root.innerHTML = `<style>${css()}</style>${viewHtml(st, view)}`; bind(root, st, view); }
}
function viewHtml(st, view) {
  if (!st.loaded) return `<div class="rs"><div class="ph">加载中…</div></div>`;
  if (view === 'explorer') return explorerHtml(st);
  if (view === 'property') return propertyHtml(st);
  return contentHtml(st);
}

function contentHtml(st) {
  const d = st.def;
  if (!d) return `<div class="rs"><div class="ph">决策不存在</div></div>`;
  const factVars = collectFactVars(d);
  const inputKeys = new Set((d.inputs || []).map(c => c.expression));
  const fields = factVars.map(v => {
    const badge = inputKeys.has(v.name) ? '' : ' <em class="rs-derived" title="输出/条件表达式引用的变量">派生</em>';
    return `<label class="rs-field"><span>${esc(v.label)} <code>${esc(v.name)}</code>${badge}</span>
      <input class="rs-in" data-fact="${esc(v.name)}" value="${esc(st.facts[v.name] ?? '')}" placeholder="输入 ${esc(v.name)}"/></label>`;
  }).join('');
  const r = st.result; let out = '';
  if (r && r.error) out = `<div class="rs-out err"><div class="rs-outhd">✕ 求值失败</div><div class="rs-fail">${esc(r.error)}</div></div>`;
  else if (r) {
    const matched = (r.trace && r.trace[0] && r.trace[0].matchedRules) || [];
    out = `<div class="rs-out ${r.failure ? 'err' : 'ok'}">
      <div class="rs-outhd">${r.failure ? '⚠ 决策失败' : '✓ 决策输出'} · ${r.timingUs}µs · 命中行 ${matched.length ? matched.join(', ') : '无'}</div>
      <pre class="rs-json">${esc(JSON.stringify(r.output, null, 2))}</pre>
      ${r.failure ? `<div class="rs-fail">失败归因：${esc(r.failure)}</div>` : ''}</div>`;
  }
  return `<div class="rs">
    <div class="rs-hd">${esc(d.name || d.key)} · 输入事实</div>
    <div class="rs-form">${fields || '<div class="ph">该决策无可录入变量</div>'}</div>
    <details class="rs-rawwrap"><summary>高级：直接编辑 JSON facts</summary>
      <textarea class="rs-raw" data-fact-raw placeholder='{"score":800,"income":10000}'>${esc(st.factsRaw ?? '')}</textarea>
      <div class="rs-rawhint">填了此处则以此为准（覆盖上方表单），便于补录任意字段</div></details>
    <div class="rs-actions"><button class="rs-btn primary" data-act="eval">求值</button>
      <button class="rs-btn" data-act="save-test" ${r && !r.error ? '' : 'disabled'}>存为用例</button></div>
    ${out}</div>`;
}

function explorerHtml(st) {
  const d = st.def || {};
  const tests = st.tests.map(t => `<li class="rs-tc" data-tc="${esc(t.id)}">
    <span class="rs-tcname">${esc(t.name || t.id)}</span>
    <span class="rs-tcin">${esc(shortObj(t.input))}</span>
    <button class="rs-x" data-act="del-test" data-tc="${esc(t.id)}" title="删除">×</button></li>`).join('');
  const rr = st.runResult;
  let runHtml = '';
  if (rr && rr.error) runHtml = `<div class="rs-fail">${esc(rr.error)}</div>`;
  else if (rr) runHtml = `<div class="rs-runsum">
    <div class="rs-badge ${rr.failed ? 'warn' : 'ok'}">${rr.passed}/${rr.total} 通过</div>
    <div class="rs-badge ${rr.coverage && rr.coverage.complete ? 'ok' : 'warn'}">${rr.coverage && rr.coverage.complete ? '✓ 无空隙' : '⚠ 空隙 ' + ((rr.coverage && rr.coverage.gaps) || 0)}</div>
  </div>`;
  return `<div class="rs">
    <div class="rs-kv"><span>决策</span><b>${esc(d.name || d.key || '')}</b></div>
    <div class="rs-kv"><span>版本</span><b>v${d.version ?? 1}</b></div>
    <div class="rs-kv"><span>命中策略</span><b>${esc(d.hitPolicy || 'U')}</b></div>
    <div class="rs-hd">测试用例 <span class="rs-sub">${st.tests.length} 例</span> <button class="rs-btn xs" data-act="run-suite">运行套件</button></div>
    ${runHtml}
    <ul class="rs-tcs">${tests || '<li class="ph">暂无用例（求值后「存为用例」）</li>'}</ul>
  </div>`;
}

function propertyHtml(st) {
  const rr = st.runResult;
  // 优先展示套件结果逐例 diff；否则展示最近一次求值的 trace。
  if (rr && !rr.error && rr.cases) {
    const rows = rr.cases.map(c => `<div class="rs-case ${c.pass ? 'pass' : 'fail'}">
      <div class="rs-casehd">${c.pass ? '✓' : '✗'} ${esc(c.name || c.id)}</div>
      ${c.pass ? '' : `<div class="rs-diff"><div>实际 <code>${esc(JSON.stringify(c.actual))}</code></div><div>期望 <code>${esc(JSON.stringify(c.expected))}</code></div></div>`}
      ${c.failure ? `<div class="rs-fail">${esc(c.failure)}</div>` : ''}</div>`).join('');
    return `<div class="rs"><div class="rs-hd">套件结果 <span class="rs-sub">${rr.passed}/${rr.total} 通过</span></div>${rows}</div>`;
  }
  const r = st.result;
  if (!r || r.error) return `<div class="rs"><div class="ph">求值后在此查看逐节点 trace 归因</div></div>`;
  const trace = r.trace || [];
  const nodes = trace.map(t => `<div class="rs-node ${t.failure ? 'fail' : (t.matchedRules || []).length ? 'hit' : 'miss'}">
    <div class="rs-nodehd">${esc(t.nodeId)} <span class="rs-tag">${esc(t.nodeKind)}</span><span class="rs-us">${t.timingUs}µs</span></div>
    <div class="rs-noderow">命中规则行：${(t.matchedRules || []).length ? t.matchedRules.join(', ') : '无'}</div>
    ${t.failure ? `<div class="rs-fail">${esc(t.failure)}</div>` : ''}
    <pre class="rs-json sm">${esc(JSON.stringify(t.output))}</pre></div>`).join('');
  return `<div class="rs"><div class="rs-hd">决策轨迹 trace<span class="rs-sub">逐节点归因 · 超越 ZEN</span></div>${nodes || '<div class="ph">无 trace</div>'}</div>`;
}

function bind(root, st, view) {
  if (root.__rulesSimBound) return; // 委托监听只绑一次；refresh 仅重置 innerHTML 不动 root，重复绑会叠加→事件风暴
  root.__rulesSimBound = true;
  root.addEventListener('input', (ev) => {
    const f = ev.target.closest('[data-fact]'); if (f) { st.facts[f.getAttribute('data-fact')] = f.value; return; }
    if (ev.target.matches('[data-fact-raw]')) st.factsRaw = ev.target.value; // 高级 JSON facts
  });
  root.addEventListener('click', (ev) => {
    const tc = ev.target.closest('.rs-tc')?.getAttribute('data-tc');
    const act = ev.target.closest('[data-act]')?.getAttribute('data-act');
    if (act === 'del-test') { delTest(st, ev.target.closest('[data-tc]').getAttribute('data-tc')); return; }
    if (tc && !act) { loadTestFacts(st, tc); return; }
    if (act === 'eval') evaluate(st);
    else if (act === 'save-test') saveAsTest(st);
    else if (act === 'run-suite') runSuite(st);
  });
}

function shortObj(o) { try { const s = JSON.stringify(o); return s.length > 40 ? s.slice(0, 40) + '…' : s; } catch { return ''; } }
function flash(msg, err) {
  try { const el = document.createElement('div'); el.textContent = msg;
    el.style.cssText = `position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:99999;padding:10px 18px;border-radius:8px;font-size:13px;color:var(--sapGroup_ContentBorderColor, #ffffff);background:${err ? 'var(--sapNegativeElementColor, #d9534f)' : 'var(--sapPositiveElementColor, #2e7d5b)'};box-shadow:0 4px 16px rgba(0,0,0,.25)`;
    document.body.appendChild(el); setTimeout(() => el.remove(), 2200); } catch { /* */ }
}
const { escHtml: esc } = globalThis.__cmxDataComp // 共享转义（cmx-data-comp/lib/cmx-page-helpers.js；最严格五字符集合，文本/属性上下文皆安全）

function css() {
  return `
  .rs{
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
    --dg-ok:var(--sapPositiveColor,#178a5a);--dg-warn:var(--sapCriticalColor,#c26a00);--dg-danger:var(--sapNegativeColor,#d1394a);
    --dg-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    color-scheme:light dark;
    font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--dg-fg);height:100%;box-sizing:border-box;padding:10px 11px;overflow:auto}
  .ph{color:var(--dg-faint);padding:22px 10px;text-align:center;font-size:12px}
  .rs-hd{font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dg-muted);margin:12px 0 7px;display:flex;align-items:center;gap:8px}
  .rs-hd::before{content:"";width:3px;height:12px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent-line);flex:0 0 auto}
  .rs-hd:first-child{margin-top:2px}
  .rs-sub{font-weight:500;color:var(--dg-faint);font-size:10px;letter-spacing:0;text-transform:none;padding:1px 6px;border-radius:10px;background:var(--dg-accent-soft)}
  .rs-form{display:flex;flex-direction:column;gap:9px}
  .rs-field{display:flex;flex-direction:column;gap:4px}.rs-field span{font-size:11px;color:var(--dg-muted)}.rs-field code{color:var(--dg-faint);font-size:10px;font-family:var(--dg-mono)}
  .rs-in{border:1px solid var(--dg-border-strong);border-radius:8px;padding:7px 10px;font-size:13px;background:var(--sapField_Background,#fff);color:inherit;transition:border-color .14s,box-shadow .14s}
  .rs-in:focus{outline:none;border-color:var(--dg-accent);box-shadow:0 0 0 3px var(--dg-accent-soft)}
  .rs-derived{font-style:normal;font-size:9px;color:var(--dg-warn);background:color-mix(in srgb,var(--dg-warn) 14%,transparent);border:1px solid color-mix(in srgb,var(--dg-warn) 28%,transparent);border-radius:6px;padding:0 5px;margin-left:5px;font-weight:600}
  .rs-rawwrap{margin:8px 0 2px;font-size:12px}
  .rs-rawwrap summary{cursor:pointer;color:var(--dg-faint);font-size:11px;user-select:none}.rs-rawwrap summary:hover{color:var(--dg-accent)}
  .rs-raw{width:100%;box-sizing:border-box;min-height:56px;margin-top:6px;border:1px solid var(--dg-border-strong);border-radius:8px;padding:7px 10px;font:12px/1.5 var(--dg-mono);background:var(--sapField_Background,#fff);color:inherit;resize:vertical}
  .rs-raw:focus{outline:none;border-color:var(--dg-accent);box-shadow:0 0 0 3px var(--dg-accent-soft)}
  .rs-rawhint{font-size:10px;color:var(--dg-faint);margin-top:3px}
  .rs-btn{border:1px solid var(--dg-border-strong);background:var(--dg-surface);color:var(--dg-accent);border-radius:8px;padding:7px 14px;font-size:12px;font-weight:500;cursor:pointer;transition:border-color .14s,box-shadow .14s}
  .rs-btn:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}
  .rs-btn.primary{background:linear-gradient(135deg,var(--dg-accent),var(--dg-accent2));color: #fff;border-color:transparent}
  .rs-btn.primary:hover{filter:brightness(1.06)}.rs-btn.xs{padding:3px 9px;font-size:11px}
  .rs-btn:disabled{opacity:.4;cursor:default;box-shadow:none}
  .rs-actions{margin-top:12px;display:flex;gap:8px}
  .rs-out{margin-top:14px;border-radius:11px;padding:11px 13px;position:relative;overflow:hidden}
  .rs-out::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px}
  .rs-out.ok{background:linear-gradient(135deg,color-mix(in srgb,var(--dg-ok) 10%,transparent),transparent 68%),var(--dg-surface);border:1px solid color-mix(in srgb,var(--dg-ok) 30%,transparent)}
  .rs-out.ok::before{background:var(--dg-ok);box-shadow:0 0 10px var(--dg-ok)}
  .rs-out.err{background:linear-gradient(135deg,color-mix(in srgb,var(--dg-danger) 10%,transparent),transparent 68%),var(--dg-surface);border:1px solid color-mix(in srgb,var(--dg-danger) 30%,transparent)}
  .rs-out.err::before{background:var(--dg-danger);box-shadow:0 0 10px var(--dg-danger)}
  .rs-outhd{font-weight:600;font-size:12px;margin-bottom:6px;font-variant-numeric:tabular-nums}
  .rs-json{margin:0;font:12px/1.5 var(--dg-mono);white-space:pre-wrap;color:inherit}.rs-json.sm{font-size:11px;color:var(--dg-muted);margin-top:4px}
  .rs-fail{color:var(--dg-danger);font-size:11px;margin-top:6px}
  .rs-kv{display:flex;gap:8px;padding:4px 0;align-items:baseline}.rs-kv span{color:var(--dg-faint);width:60px;font-size:11px;flex:0 0 auto}
  .rs-tcs{list-style:none;margin:0;padding:0}
  .rs-tc{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:9px;cursor:pointer;border:1px solid transparent;transition:background .14s,border-color .14s}
  .rs-tc:hover{background:var(--dg-hover)}.rs-tc.sel{background:var(--dg-sel);border-color:var(--dg-accent-line)}
  .rs-tcname{font-weight:500}.rs-tcin{flex:1;font:10px var(--dg-mono);color:var(--dg-faint)}
  .rs-x{border:none;background:transparent;color:var(--dg-danger);cursor:pointer;font-size:14px;padding:0 4px;border-radius:5px}.rs-x:hover{background:color-mix(in srgb,var(--dg-danger) 15%,transparent)}
  .rs-runsum{display:flex;gap:6px;margin:4px 0 8px}
  .rs-badge{display:inline-flex;align-items:center;width:fit-content;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid transparent}
  .rs-badge.ok{background:color-mix(in srgb,var(--dg-ok) 14%,transparent);color:var(--dg-ok);border-color:color-mix(in srgb,var(--dg-ok) 30%,transparent)}
  .rs-badge.warn{background:color-mix(in srgb,var(--dg-warn) 15%,transparent);color:var(--dg-warn);border-color:color-mix(in srgb,var(--dg-warn) 32%,transparent)}
  .rs-node{border:1px solid var(--dg-border);border-left-width:3px;border-radius:9px;padding:9px 11px;margin-bottom:8px;background:var(--dg-surface)}
  .rs-node.hit{border-left-color:var(--dg-ok)}.rs-node.miss{border-left-color:var(--dg-faint)}.rs-node.fail{border-left-color:var(--dg-danger);background:linear-gradient(135deg,color-mix(in srgb,var(--dg-danger) 7%,transparent),transparent 70%),var(--dg-surface)}
  .rs-nodehd{font-weight:600;font-size:12px;display:flex;align-items:center;gap:8px}
  .rs-tag{font-size:10px;background:var(--dg-accent-soft);color:var(--dg-accent);padding:1px 7px;border-radius:9px;font-weight:600}
  .rs-us{margin-left:auto;font-size:10px;color:var(--dg-faint);font-family:var(--dg-mono);font-variant-numeric:tabular-nums}
  .rs-noderow{font-size:11px;color:var(--dg-muted);margin-top:4px}
  .rs-case{border:1px solid var(--dg-border);border-left-width:3px;border-radius:9px;padding:8px 11px;margin-bottom:6px;background:var(--dg-surface)}
  .rs-case.pass{border-left-color:var(--dg-ok)}.rs-case.fail{border-left-color:var(--dg-danger)}
  .rs-casehd{font-weight:600;font-size:12px}.rs-diff{font-size:11px;color:var(--dg-muted);margin-top:3px}.rs-diff code{color:var(--dg-accent);font-family:var(--dg-mono)}
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
