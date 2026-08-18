/*
 * portal.rules.designer —— 决策表设计器（native_pages 多实例，四区）。
 *
 * 由 portal.rules.design-workbench 的「编辑」经 openWorkNode 动态开成 Tab；instances Map 按
 * instanceKey(key@@version) 隔离多实例。四区：
 *   explorer —— 输入/输出字段速览 + FEEL 函数目录（/feel/functions，向导参考）
 *   content  —— **可编辑决策表网格**：命中策略 + 输入列/输出列（动态增删）+ 规则行；每个输入格
 *               是 unary test（内联编辑 + fx 弹层参考 FEEL 目录 + /feel/validate 校验），输出格是
 *               表达式；工具栏 保存草稿 / 发布 / 分析
 *   property —— gap/overlap **完整性实时报告**（超越 ZEN）+ 命中策略说明 + 版本信息
 *
 * 决策表网格刻意手搓（非 cmx-revo-grid）：结构化输入/输出列 + 规则行 + 每格 FEEL 更贴决策表语义，
 * 且规避 shadow DOM 组件懒加载陷阱。存回 POST /definitions/draft；发布 POST /publish；分析用内联
 * 定义 POST /analyze（分析在编未存的表）。
 */

const CFG = { apiBase: '', fetchInit: { credentials: 'same-origin' }, authHeaders: () => ({}) };
export function configure(o) { Object.assign(CFG, o || {}); return CFG; }

// ── 多实例：instances Map + instanceKey(props) ──
const instances = new Map();
function instanceKey(props) { return `${props?.key || '?'}@@${props?.version ?? 'draft'}`; }
function getInst(ctx) {
  const k = instanceKey(ctx.props);
  let st = instances.get(k);
  if (!st) {
    st = { props: ctx.props || {}, def: null, analysis: null, feelFns: [], dirty: false, loaded: false, fx: null, hosts: new Set() };
    instances.set(k, st);
  }
  return st;
}

async function apiJson(url, options = {}) {
  const full = (CFG.apiBase && url.charAt(0) === '/') ? CFG.apiBase + url : url;
  const res = await fetch(full, { ...CFG.fetchInit, ...options, headers: { Accept: 'application/json', ...CFG.authHeaders(), ...(options.headers || {}) } });
  let j = null; try { j = await res.json(); } catch { /* */ }
  if (!res.ok || (j && typeof j.code === 'number' && j.code !== 0)) throw new Error((j && (j.msg || j.error)) || `HTTP ${res.status}`);
  return j && typeof j === 'object' && 'data' in j ? j.data : j;
}

// ── 数据 ──
async function loadDef(st) {
  try {
    const d = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(st.props.key));
    d.inputs = d.inputs || []; d.outputs = d.outputs || []; d.rules = d.rules || []; d.hitPolicy = d.hitPolicy || 'U';
    st.def = d;
  } catch (e) { st.def = { key: st.props.key, name: st.props.name || st.props.key, kind: 'decisionTable', hitPolicy: 'U', inputs: [], outputs: [], rules: [] }; }
  st.loaded = true;
  await analyze(st);
}
async function ensureFeelFns(st) { if (!st.feelFns.length) { try { st.feelFns = await apiJson('/api/rules/v1/feel/functions') || []; } catch { st.feelFns = []; } } }
async function analyze(st) {
  try { st.analysis = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(st.props.key) + '/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: st.def }) }); }
  catch { st.analysis = null; }
  refresh(st, 'property');
}
let analyzeTimer = null;
function scheduleAnalyze(st) { clearTimeout(analyzeTimer); analyzeTimer = setTimeout(() => analyze(st), 400); }
async function saveDraft(st) {
  try { await apiJson('/api/rules/v1/definitions/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st.def) }); st.dirty = false; flash('已保存草稿'); refresh(st, 'content'); }
  catch (e) { flash('保存失败：' + e.message, true); }
}
async function publish(st) {
  try { await apiJson('/api/rules/v1/definitions/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st.def) });
    const r = await apiJson('/api/rules/v1/definitions/' + encodeURIComponent(st.props.key) + '/publish', { method: 'POST' });
    st.dirty = false; flash('已发布 v' + (r && r.version)); refresh(st, 'content'); refresh(st, 'property'); }
  catch (e) { flash('发布失败：' + e.message, true); }
}

// ── 结构编辑 ──
function addRule(st) { const d = st.def; d.rules.push({ id: '', inputEntries: d.inputs.map(() => '-'), outputEntries: d.outputs.map(() => '') }); st.dirty = true; refresh(st, 'content'); scheduleAnalyze(st); }
function delRule(st, r) { st.def.rules.splice(r, 1); st.dirty = true; refresh(st, 'content'); scheduleAnalyze(st); }
function addInput(st) { const d = st.def; d.inputs.push({ id: 'i' + (d.inputs.length + 1), label: '', expression: 'field' + (d.inputs.length + 1) }); d.rules.forEach(rr => rr.inputEntries.push('-')); st.dirty = true; refresh(st, 'content'); }
function addOutput(st) { const d = st.def; d.outputs.push({ id: 'o' + (d.outputs.length + 1), name: 'out' + (d.outputs.length + 1), label: '' }); d.rules.forEach(rr => rr.outputEntries.push('')); st.dirty = true; refresh(st, 'content'); }
function delInput(st, c) { const d = st.def; d.inputs.splice(c, 1); d.rules.forEach(rr => rr.inputEntries.splice(c, 1)); st.dirty = true; refresh(st, 'content'); scheduleAnalyze(st); }
function delOutput(st, c) { const d = st.def; d.outputs.splice(c, 1); d.rules.forEach(rr => rr.outputEntries.splice(c, 1)); st.dirty = true; refresh(st, 'content'); scheduleAnalyze(st); }

// ── 渲染 ──
function hostRoot(host) { return host?.renderRoot || host?.shadowRoot?.querySelector('.rd') || host; }
function mount(ctx, view) {
  const st = getInst(ctx); const host = ctx.host; st.hosts.add(host); host.__view = view; host.__key = instanceKey(ctx.props);
  const render = () => { const root = hostRoot(host); if (!root || root.isConnected === false) return; root.innerHTML = `<style>${css()}</style>${viewHtml(st, view)}`; bind(root, st, view, host); };
  requestAnimationFrame(async () => {
    render();
    if (!st.loaded) { await ensureFeelFns(st); await loadDef(st); refresh(st, 'content'); refresh(st, 'explorer'); refresh(st, 'property'); }
  });
  return `<style>${css()}</style>${viewHtml(st, view)}`;
}
function refresh(st, view) {
  for (const host of st.hosts) {
    if (host.__view !== view) continue;
    const root = hostRoot(host); if (!root || root.isConnected === false) continue;
    root.innerHTML = `<style>${css()}</style>${viewHtml(st, view)}`; bind(root, st, view, host);
  }
}
function viewHtml(st, view) {
  if (!st.loaded) return `<div class="rd"><div class="ph">加载中…</div></div>`;
  if (view === 'explorer') return explorerHtml(st);
  if (view === 'property') return propertyHtml(st);
  return contentHtml(st);
}

const HIT_POLICIES = ['U', 'A', 'P', 'F', 'C', 'R', 'O', 'C+', 'C<', 'C>', 'C#'];
const HP_LABEL = { U: '唯一', A: '任意', P: '优先', F: '首个', C: '收集', R: '规则序', O: '输出序', 'C+': '求和', 'C<': '最小', 'C>': '最大', 'C#': '计数' };

function contentHtml(st) {
  const d = st.def; const ins = d.inputs, outs = d.outputs, rules = d.rules;
  const hpSel = `<select class="rd-hp" data-act="hitpolicy">${HIT_POLICIES.map(h => `<option value="${h}" ${h === d.hitPolicy ? 'selected' : ''}>${h} · ${HP_LABEL[h] || ''}</option>`).join('')}</select>`;
  const toolbar = `<div class="rd-toolbar">
    <b class="rd-title">${esc(d.name || d.key)}</b>
    <span class="rd-dirty ${st.dirty ? 'on' : ''}">${st.dirty ? '● 未保存' : '已保存'}</span>
    <span class="rd-sp"></span>
    命中策略 ${hpSel}
    <button class="rd-btn" data-act="add-rule">+ 规则行</button>
    <button class="rd-btn" data-act="add-input">+ 输入列</button>
    <button class="rd-btn" data-act="add-output">+ 输出列</button>
    <button class="rd-btn primary" data-act="save">保存草稿</button>
    <button class="rd-btn ok" data-act="publish">发布</button>
  </div>`;
  // 表头：# | 输入列(label+expr+del) | 输出列(name+del) | 操作
  const head = `<tr>
    <th class="rd-idx">#</th>
    ${ins.map((c, ci) => `<th class="rd-in">
      <input class="rd-h" data-kind="in-label" data-c="${ci}" value="${esc(c.label || '')}" placeholder="列名"/>
      <input class="rd-h sub" data-kind="in-expr" data-c="${ci}" value="${esc(c.expression || '')}" placeholder="字段/路径"/>
      <button class="rd-x" data-act="del-input" data-c="${ci}" title="删除输入列">×</button>
    </th>`).join('')}
    ${outs.map((c, ci) => `<th class="rd-out">
      <input class="rd-h" data-kind="out-name" data-c="${ci}" value="${esc(c.name || '')}" placeholder="输出键"/>
      <input class="rd-h sub" data-kind="out-label" data-c="${ci}" value="${esc(c.label || '')}" placeholder="说明"/>
      <button class="rd-x" data-act="del-output" data-c="${ci}" title="删除输出列">×</button>
    </th>`).join('')}
    <th class="rd-ops"></th>
  </tr>`;
  const body = rules.map((rl, ri) => `<tr>
    <td class="rd-idx">${ri}</td>
    ${ins.map((c, ci) => `<td class="rd-in">
      <input class="rd-cell" data-kind="in" data-r="${ri}" data-c="${ci}" value="${esc(rl.inputEntries[ci] ?? '')}" placeholder="-"/>
      <button class="rd-fx" data-act="fx" data-r="${ri}" data-c="${ci}" title="FEEL 向导">fx</button>
    </td>`).join('')}
    ${outs.map((c, ci) => `<td class="rd-out"><input class="rd-cell" data-kind="out" data-r="${ri}" data-c="${ci}" value="${esc(rl.outputEntries[ci] ?? '')}" placeholder="值"/></td>`).join('')}
    <td class="rd-ops"><button class="rd-x" data-act="del-rule" data-r="${ri}" title="删除规则行">×</button></td>
  </tr>`).join('');
  const empty = (!ins.length && !outs.length) ? `<div class="ph">空决策表：先加输入列/输出列，再加规则行</div>` : '';
  return `<div class="rd">
    ${toolbar}
    <div class="rd-gridwrap"><table class="rd-grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    ${empty}
    ${st.fx ? fxHtml(st) : ''}
  </div>`;
}

function fxHtml(st) {
  const { r, c } = st.fx;
  const cur = st.def.rules[r]?.inputEntries[c] ?? '';
  const cats = {};
  for (const f of st.feelFns) { (cats[f.category] = cats[f.category] || []).push(f); }
  const chips = Object.entries(cats).map(([cat, fns]) => `<div class="fx-cat"><span class="fx-catn">${esc(cat)}</span>${fns.map(f => `<button class="fx-chip" data-fxins="${esc(f.example)}" title="${esc(f.description)}">${esc(f.name)}<code>${esc(f.example)}</code></button>`).join('')}</div>`).join('');
  return `<div class="rd-fxpanel">
    <div class="fx-hd">FEEL 向导 · 规则行 ${r} · <span class="fx-valid" id="fxv"></span> <button class="rd-x" data-act="fx-close">×</button></div>
    <div class="fx-editrow"><input class="fx-input" id="fxinput" value="${esc(cur)}" placeholder="unary test，如 > 700 / [18..65) / \"north\""/>
      <button class="rd-btn primary" data-act="fx-commit">确定</button></div>
    <div class="fx-cats">${chips || '<span class="ph">函数目录加载中…</span>'}</div>
  </div>`;
}

function explorerHtml(st) {
  const d = st.def;
  const inList = d.inputs.map((c, i) => `<li class="rd-fld in">输入 ${i}：<b>${esc(c.label || c.expression)}</b><span class="rd-expr">${esc(c.expression)}</span></li>`).join('');
  const outList = d.outputs.map((c, i) => `<li class="rd-fld out">输出 ${i}：<b>${esc(c.name)}</b>${c.label ? '<span class="rd-expr">' + esc(c.label) + '</span>' : ''}</li>`).join('');
  const cats = {};
  for (const f of st.feelFns) { (cats[f.category] = cats[f.category] || []).push(f); }
  const fnRef = Object.entries(cats).map(([cat, fns]) => `<div class="rd-fncat"><div class="rd-fncatn">${esc(cat)}</div>${fns.map(f => `<div class="rd-fn"><code>${esc(f.example)}</code><span>${esc(f.description)}</span></div>`).join('')}</div>`).join('');
  return `<div class="rd">
    <div class="rd-hd">字段</div>
    <ul class="rd-flds">${inList || '<li class="ph">无输入列</li>'}${outList || '<li class="ph">无输出列</li>'}</ul>
    <div class="rd-hd">FEEL 函数目录<span class="rd-sub">决策表单元格 unary test</span></div>
    <div class="rd-fnref">${fnRef || '<div class="ph">加载中…</div>'}</div>
  </div>`;
}

function propertyHtml(st) {
  const d = st.def, a = st.analysis;
  const analysis = a ? `<div class="rd-anal">
    <div class="rd-badge ${a.complete ? 'ok' : 'warn'}">${a.complete ? '✓ 无空隙' : '⚠ 空隙 ' + (a.gaps || []).length}</div>
    <div class="rd-badge ${a.hasOverlap ? 'warn' : 'ok'}">${a.hasOverlap ? '⚠ 重叠 ' + (a.overlaps || []).length : '✓ 无重叠'}</div>
    <div class="rd-gaps">
      ${(a.overlaps || []).slice(0, 8).map(o => `<div class="rd-gap ov">${esc(o.description)}</div>`).join('')}
      ${(a.gaps || []).slice(0, 8).map(g => `<div class="rd-gap">${esc(g.description)}</div>`).join('')}
    </div>
  </div>` : '<div class="ph">分析中…</div>';
  return `<div class="rd">
    <div class="rd-hd">决策属性</div>
    <div class="rd-kv"><span>键</span><b>${esc(d.key)}</b></div>
    <div class="rd-kv"><span>版本</span><b>v${d.version ?? 1}</b></div>
    <div class="rd-kv"><span>命中策略</span><b>${esc(d.hitPolicy)} · ${HP_LABEL[d.hitPolicy] || ''}</b></div>
    <div class="rd-kv"><span>规模</span><b>${d.inputs.length} 入 / ${d.outputs.length} 出 / ${d.rules.length} 则</b></div>
    <div class="rd-hd">完整性分析<span class="rd-sub">gap / overlap · 超越 ZEN</span> <button class="rd-btn xs" data-act="reanalyze">刷新</button></div>
    ${analysis}
  </div>`;
}

// ── 事件 ──
function bind(root, st, view, host) {
  if (root.__rulesDesignerBound) return; // 委托监听只绑一次；refresh 仅重置 innerHTML 不动 root，重复绑会叠加→事件风暴
  root.__rulesDesignerBound = true;
  // 内联编辑（change 即写 state，不整表重渲，保编辑流畅）。
  root.addEventListener('change', (ev) => {
    const el = ev.target; const kind = el.getAttribute?.('data-kind'); if (!kind) return;
    const c = +el.getAttribute('data-c'); const r = el.getAttribute('data-r');
    const d = st.def; st.dirty = true;
    if (kind === 'in') d.rules[+r].inputEntries[c] = el.value;
    else if (kind === 'out') d.rules[+r].outputEntries[c] = el.value;
    else if (kind === 'in-label') d.inputs[c].label = el.value;
    else if (kind === 'in-expr') d.inputs[c].expression = el.value;
    else if (kind === 'out-name') d.outputs[c].name = el.value;
    else if (kind === 'out-label') d.outputs[c].label = el.value;
    markDirtyBadge(root, st);
    scheduleAnalyze(st);
  });
  // fx 弹层内实时校验。
  root.addEventListener('input', (ev) => { if (ev.target.id === 'fxinput') validateFx(root, ev.target.value); });
  root.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.getAttribute('data-act');
    const ins = ev.target.closest('[data-fxins]')?.getAttribute('data-fxins');
    if (ins != null) { const inp = root.querySelector('#fxinput'); if (inp) { inp.value = (inp.value && inp.value !== '-' ? inp.value + ', ' : '') + ins; validateFx(root, inp.value); inp.focus(); } return; }
    if (!act) return;
    const r = ev.target.closest('[data-r]')?.getAttribute('data-r');
    const c = ev.target.closest('[data-c]')?.getAttribute('data-c');
    if (act === 'add-rule') addRule(st);
    else if (act === 'del-rule') delRule(st, +r);
    else if (act === 'add-input') addInput(st);
    else if (act === 'add-output') addOutput(st);
    else if (act === 'del-input') delInput(st, +c);
    else if (act === 'del-output') delOutput(st, +c);
    else if (act === 'save') saveDraft(st);
    else if (act === 'publish') publish(st);
    else if (act === 'reanalyze') analyze(st);
    else if (act === 'fx') { st.fx = { r: +r, c: +c }; refresh(st, 'content'); }
    else if (act === 'fx-close') { st.fx = null; refresh(st, 'content'); }
    else if (act === 'fx-commit') {
      const inp = root.querySelector('#fxinput'); if (inp && st.fx) { st.def.rules[st.fx.r].inputEntries[st.fx.c] = inp.value; st.dirty = true; }
      st.fx = null; refresh(st, 'content'); scheduleAnalyze(st);
    }
  });
  root.addEventListener('change', (ev) => { if (ev.target.getAttribute?.('data-act') === 'hitpolicy') { st.def.hitPolicy = ev.target.value; st.dirty = true; scheduleAnalyze(st); markDirtyBadge(root, st); } });
}
function markDirtyBadge(root, st) { const b = root.querySelector('.rd-dirty'); if (b) { b.classList.toggle('on', st.dirty); b.textContent = st.dirty ? '● 未保存' : '已保存'; } }
async function validateFx(root, expr) {
  const el = root.querySelector('#fxv'); if (!el) return;
  try { const r = await apiJson('/api/rules/v1/feel/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ test: expr }) });
    el.textContent = r.valid ? '✓ 语法正确' : '✗ ' + (r.error || '语法错误'); el.className = 'fx-valid ' + (r.valid ? 'ok' : 'bad'); }
  catch { el.textContent = ''; }
}

function flash(msg, err) {
  try { const el = document.createElement('div'); el.textContent = msg;
    el.style.cssText = `position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:99999;padding:10px 18px;border-radius:8px;font-size:13px;color:#fff;background:${err ? '#d9534f' : '#2e7d5b'};box-shadow:0 4px 16px rgba(0,0,0,.25)`;
    document.body.appendChild(el); setTimeout(() => el.remove(), 2200); } catch { /* */ }
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

function css() {
  return `
  .rd{
    /* ── 设计令牌：锚定 UI5 --sap*（随门户主题 light/dark 翻转，穿透 shadow DOM）；独立 :8094 走 hex 兜底。 ── */
    --dg-fg:var(--sapTextColor,#1c2530);--dg-muted:var(--sapContent_LabelColor,#5a6b7b);--dg-faint:var(--sapContent_LabelColor,#8b97b3);
    --dg-bg:var(--sapGroup_ContentBackground,#fff);
    --dg-surface:color-mix(in srgb,var(--sapList_Background,#fff) 88%,var(--sapHighlightColor,#0a6ed1) 3%);
    --dg-hover:var(--sapList_Hover_Background,#eef3fb);
    --dg-border:color-mix(in srgb,var(--sapField_BorderColor,#c9ced4) 60%,transparent);
    --dg-border-strong:color-mix(in srgb,var(--sapField_BorderColor,#c9ced4) 90%,transparent);
    --dg-accent:var(--sapHighlightColor,#0a6ed1);--dg-accent2:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 55%,#00d0c0);
    --dg-accent-soft:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 12%,transparent);
    --dg-accent-line:color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 40%,transparent);
    --dg-glow:0 0 0 1px color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 22%,transparent),0 6px 18px -8px color-mix(in srgb,var(--sapHighlightColor,#0a6ed1) 45%,transparent);
    --dg-ok:var(--sapPositiveColor,#178a5a);--dg-warn:var(--sapCriticalColor,#c26a00);--dg-danger:var(--sapNegativeColor,#d1394a);
    --dg-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    color-scheme:light dark;
    font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--dg-fg);height:100%;box-sizing:border-box;padding:10px 11px;overflow:auto;position:relative}
  .ph{color:var(--dg-faint);padding:22px 10px;text-align:center;font-size:12px}
  .rd-hd{font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dg-muted);margin:12px 0 7px;display:flex;align-items:center;gap:8px}
  .rd-hd::before{content:"";width:3px;height:12px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent-line);flex:0 0 auto}
  .rd-hd:first-child{margin-top:2px}
  .rd-sub{font-weight:500;color:var(--dg-faint);font-size:10px;letter-spacing:0;text-transform:none;padding:1px 6px;border-radius:10px;background:var(--dg-accent-soft)}
  .rd-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 2px 11px;border-bottom:1px solid var(--dg-border);margin-bottom:10px}
  .rd-title{font-size:14px;font-weight:600}.rd-sp{flex:1}
  .rd-dirty{font-size:11px;color:var(--dg-faint)}.rd-dirty.on{color:var(--dg-warn);font-weight:600}
  .rd-hp{border:1px solid var(--dg-border-strong);border-radius:8px;padding:5px 8px;font-size:12px;background:var(--sapField_Background,#fff);color:inherit}
  .rd-hp:focus{outline:none;border-color:var(--dg-accent);box-shadow:0 0 0 3px var(--dg-accent-soft)}
  .rd-btn{border:1px solid var(--dg-border-strong);background:var(--dg-surface);color:var(--dg-accent);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer;transition:border-color .14s,box-shadow .14s}
  .rd-btn:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}
  .rd-btn.primary{background:linear-gradient(135deg,var(--dg-accent),var(--dg-accent2));color:#fff;border-color:transparent}
  .rd-btn.ok{background:linear-gradient(135deg,var(--dg-ok),color-mix(in srgb,var(--dg-ok) 60%,#00d0c0));color:#fff;border-color:transparent}
  .rd-btn.xs{padding:3px 9px;font-size:11px}
  .rd-gridwrap{overflow:auto;border:1px solid var(--dg-border);border-radius:11px}
  .rd-grid{border-collapse:collapse;width:100%;font-size:12px}
  .rd-grid th,.rd-grid td{border:1px solid var(--dg-border);padding:3px 5px;vertical-align:top}
  .rd-grid th{background:color-mix(in srgb,var(--dg-accent) 5%,var(--dg-surface));position:relative}
  .rd-grid th.rd-in,.rd-grid td.rd-in{background:color-mix(in srgb,var(--dg-accent) 6%,transparent)}
  .rd-grid th.rd-out,.rd-grid td.rd-out{background:color-mix(in srgb,var(--dg-ok) 7%,transparent)}
  .rd-idx{color:var(--dg-faint);text-align:center;width:28px;font-family:var(--dg-mono)}
  .rd-h{width:100%;border:none;background:transparent;font-weight:600;font-size:12px;color:inherit;padding:2px 3px}
  .rd-h.sub{font-weight:400;font-size:11px;color:var(--dg-muted)}
  .rd-h:focus,.rd-cell:focus{outline:none;box-shadow:0 0 0 2px var(--dg-accent);border-radius:4px;background:var(--dg-bg)}
  .rd-cell{width:100%;min-width:80px;border:1px solid transparent;background:transparent;font:12px var(--dg-mono);color:inherit;padding:3px 4px;border-radius:4px}
  .rd-cell:hover{border-color:var(--dg-border-strong);background:var(--dg-bg)}
  .rd-fx{position:absolute;right:2px;top:2px;font-size:9px;padding:0 4px;border:1px solid var(--dg-border-strong);border-radius:4px;background:var(--dg-surface);color:var(--dg-accent);cursor:pointer;line-height:15px}
  .rd-fx:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}
  td.rd-in{position:relative}
  .rd-x{border:none;background:transparent;color:var(--dg-danger);cursor:pointer;font-size:14px;line-height:1;padding:0 4px;border-radius:5px}
  .rd-x:hover{background:color-mix(in srgb,var(--dg-danger) 15%,transparent)}
  .rd-ops{width:30px;text-align:center}
  .rd-kv{display:flex;gap:8px;padding:4px 0;align-items:baseline}.rd-kv span{color:var(--dg-faint);width:60px;font-size:11px;flex:0 0 auto}
  .rd-anal{display:flex;flex-direction:column;gap:6px}
  .rd-badge{display:inline-flex;align-items:center;width:fit-content;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid transparent}
  .rd-badge.ok{background:color-mix(in srgb,var(--dg-ok) 14%,transparent);color:var(--dg-ok);border-color:color-mix(in srgb,var(--dg-ok) 30%,transparent)}
  .rd-badge.warn{background:color-mix(in srgb,var(--dg-warn) 15%,transparent);color:var(--dg-warn);border-color:color-mix(in srgb,var(--dg-warn) 32%,transparent)}
  .rd-gap{font-size:11px;color:var(--dg-warn);padding:2px 0}.rd-gap.ov{color:var(--dg-danger)}
  .rd-flds{list-style:none;margin:0;padding:0}.rd-fld{padding:5px 8px;border-radius:7px}.rd-fld.in{background:color-mix(in srgb,var(--dg-accent) 6%,transparent)}.rd-fld.out{background:color-mix(in srgb,var(--dg-ok) 7%,transparent);margin-top:3px}
  .rd-expr{font:11px var(--dg-mono);color:var(--dg-faint);margin-left:6px}
  .rd-fnref,.rd-fncat{font-size:11px}.rd-fncatn{font-weight:600;color:var(--dg-muted);margin:7px 0 2px;text-transform:uppercase;letter-spacing:.03em;font-size:10px}
  .rd-fn{display:flex;gap:8px;padding:1px 0}.rd-fn code{color:var(--dg-accent);min-width:80px;font-family:var(--dg-mono)}.rd-fn span{color:var(--dg-faint)}
  .rd-fxpanel{position:sticky;bottom:0;margin-top:10px;border:1px solid var(--dg-accent-line);border-radius:12px;background:linear-gradient(180deg,var(--dg-accent-soft),transparent),var(--dg-bg);box-shadow:0 -6px 22px -10px color-mix(in srgb,var(--dg-accent) 50%,transparent);padding:11px 13px}
  .fx-hd{font-weight:600;font-size:12px;display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .fx-valid{font-size:11px}.fx-valid.ok{color:var(--dg-ok)}.fx-valid.bad{color:var(--dg-danger)}
  .fx-editrow{display:flex;gap:8px;margin-bottom:8px}.fx-input{flex:1;border:1px solid var(--dg-border-strong);border-radius:8px;padding:7px 10px;font:13px var(--dg-mono);color:inherit;background:var(--sapField_Background,#fff)}
  .fx-input:focus{outline:none;border-color:var(--dg-accent);box-shadow:0 0 0 3px var(--dg-accent-soft)}
  .fx-cats{max-height:150px;overflow:auto}.fx-cat{margin-bottom:5px}.fx-catn{font-size:11px;color:var(--dg-faint);margin-right:6px}
  .fx-chip{border:1px solid var(--dg-border);border-radius:12px;background:var(--dg-surface);padding:2px 8px;margin:2px;font-size:11px;cursor:pointer;color:inherit;transition:border-color .14s,box-shadow .14s}
  .fx-chip:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}.fx-chip code{color:var(--dg-accent);margin-left:5px;font-family:var(--dg-mono)}
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
