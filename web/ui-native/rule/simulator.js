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

async function apiJson(url, options = {}) {
  const full = (CFG.apiBase && url.charAt(0) === '/') ? CFG.apiBase + url : url;
  const res = await fetch(full, { ...CFG.fetchInit, ...options, headers: { Accept: 'application/json', ...CFG.authHeaders(), ...(options.headers || {}) } });
  let j = null; try { j = await res.json(); } catch { /* */ }
  if (!res.ok || (j && typeof j.code === 'number' && j.code !== 0)) throw new Error((j && (j.msg || j.error)) || `HTTP ${res.status}`);
  return j && typeof j === 'object' && 'data' in j ? j.data : j;
}

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

async function loadAll(st) {
  try { st.def = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(st.props.key)); } catch { st.def = null; }
  try { st.tests = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/tests') || []; } catch { st.tests = []; }
  st.loaded = true;
}
async function evaluate(st) {
  try {
    st.result = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: typedInput(st.facts), options: { trace: true } }),
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, input: typedInput(st.facts), expected: st.result.output }),
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
  const inputs = d.inputs || [];
  const fields = inputs.map(c => {
    const key = c.expression;
    return `<label class="rs-field"><span>${esc(c.label || key)} <code>${esc(key)}</code></span>
      <input class="rs-in" data-fact="${esc(key)}" value="${esc(st.facts[key] ?? '')}" placeholder="输入 ${esc(key)}"/></label>`;
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
    <div class="rs-form">${fields || '<div class="ph">该决策无输入列</div>'}</div>
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
  root.addEventListener('input', (ev) => { const f = ev.target.closest('[data-fact]'); if (f) st.facts[f.getAttribute('data-fact')] = f.value; });
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
    el.style.cssText = `position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:99999;padding:10px 18px;border-radius:8px;font-size:13px;color:#fff;background:${err ? '#d9534f' : '#2e7d5b'};box-shadow:0 4px 16px rgba(0,0,0,.25)`;
    document.body.appendChild(el); setTimeout(() => el.remove(), 2200); } catch { /* */ }
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

function css() {
  return `
  .rs{font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--sapTextColor,#32363a);height:100%;box-sizing:border-box;padding:8px 10px;overflow:auto}
  .ph{color:#8b97b3;padding:16px 10px;text-align:center}
  .rs-hd{font-weight:600;font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);margin:10px 0 6px;display:flex;align-items:center;gap:8px}
  .rs-sub{font-weight:400;color:#8b97b3;font-size:11px}
  .rs-form{display:flex;flex-direction:column;gap:8px}
  .rs-field{display:flex;flex-direction:column;gap:3px}.rs-field span{font-size:11px;color:#8b97b3}.rs-field code{color:#8b97b3;font-size:10px}
  .rs-in{border:1px solid var(--sapField_BorderColor,#c9ced4);border-radius:6px;padding:6px 9px;font-size:13px;background:var(--sapField_Background,#fff);color:inherit}
  .rs-in:focus{outline:none;border-color:#0a6ed1}
  .rs-btn{border:1px solid #0a6ed1;background:#fff;color:#0a6ed1;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer}
  .rs-btn.primary{background:#0a6ed1;color:#fff}.rs-btn.primary:hover{background:#085caf}.rs-btn.xs{padding:2px 8px;font-size:11px}
  .rs-btn:disabled{opacity:.45;cursor:default}
  .rs-actions{margin-top:12px;display:flex;gap:8px}
  .rs-out{margin-top:14px;border-radius:8px;padding:10px 12px}
  .rs-out.ok{background:rgba(46,125,91,.08);border:1px solid rgba(46,125,91,.25)}
  .rs-out.err{background:rgba(217,83,79,.08);border:1px solid rgba(217,83,79,.3)}
  .rs-outhd{font-weight:600;font-size:12px;margin-bottom:6px}
  .rs-json{margin:0;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:inherit}.rs-json.sm{font-size:11px;color:#6a6d70;margin-top:4px}
  .rs-fail{color:#c0392b;font-size:11px;margin-top:6px}
  .rs-kv{display:flex;gap:8px;padding:3px 0}.rs-kv span{color:#8b97b3;width:60px}
  .rs-tcs{list-style:none;margin:0;padding:0}
  .rs-tc{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer}
  .rs-tc:hover{background:var(--sapList_Hover_Background,#f2f3f4)}
  .rs-tcname{font-weight:500}.rs-tcin{flex:1;font:10px ui-monospace,monospace;color:#8b97b3}
  .rs-x{border:none;background:transparent;color:#c0392b;cursor:pointer;font-size:14px;padding:0 4px}
  .rs-runsum{display:flex;gap:6px;margin:4px 0 8px}
  .rs-badge{width:fit-content;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:600}
  .rs-badge.ok{background:rgba(46,125,91,.12);color:#2e7d5b}.rs-badge.warn{background:rgba(217,131,79,.14);color:#b5651d}
  .rs-node{border:1px solid var(--sapList_BorderColor,#e5e5e5);border-left-width:3px;border-radius:7px;padding:8px 10px;margin-bottom:8px}
  .rs-node.hit{border-left-color:#2e7d5b}.rs-node.miss{border-left-color:#c0c4c8}.rs-node.fail{border-left-color:#c0392b;background:rgba(217,83,79,.05)}
  .rs-nodehd{font-weight:600;font-size:12px;display:flex;align-items:center;gap:8px}
  .rs-tag{font-size:10px;background:#eef1f5;color:#6a6d70;padding:1px 6px;border-radius:8px}
  .rs-us{margin-left:auto;font-size:10px;color:#8b97b3}
  .rs-noderow{font-size:11px;color:#6a6d70;margin-top:3px}
  .rs-case{border:1px solid var(--sapList_BorderColor,#e5e5e5);border-left-width:3px;border-radius:7px;padding:7px 10px;margin-bottom:6px}
  .rs-case.pass{border-left-color:#2e7d5b}.rs-case.fail{border-left-color:#c0392b}
  .rs-casehd{font-weight:600;font-size:12px}.rs-diff{font-size:11px;color:#6a6d70;margin-top:3px}.rs-diff code{color:#0a6ed1}
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
