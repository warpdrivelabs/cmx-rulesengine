/*
 * portal.rules.logs —— 决策日志 / 可解释性审计中心（native_pages 四区，列表层）。
 *
 * 金融/合规刚需：事后就某笔具体决策还原"哪条规则/哪些输入/什么输出/为何失败"。把 R0 已落库的
 * 决策日志（每次 evaluate 一条，含逐节点 trace + 失败归因）做成独立审计视图。四区：
 *   explorer —— 决策集列表（选中过滤该决策的日志）
 *   content  —— 决策日志列表（时刻/输出/时延/调用方/失败徽标；点击下钻）
 *   property —— 单次决策全量 trace 归因（输入 + 逐节点 + 失败红标）—— 可解释性
 *
 * 端点全 R0/F1：GET /definitions、GET /decisions/{key}/logs、GET /logs/{id}。
 */

const CFG = { apiBase: '', fetchInit: { credentials: 'same-origin' }, authHeaders: () => ({}) };
export function configure(o) { Object.assign(CFG, o || {}); return CFG; }

const state = { list: [], selectedKey: null, logs: [], selectedLog: null, detail: null, hosts: new Set() };

async function apiJson(url, options = {}) {
  const full = (CFG.apiBase && url.charAt(0) === '/') ? CFG.apiBase + url : url;
  const res = await fetch(full, { ...CFG.fetchInit, ...options, headers: { Accept: 'application/json', ...CFG.authHeaders(), ...(options.headers || {}) } });
  let j = null; try { j = await res.json(); } catch { /* */ }
  if (!res.ok || (j && typeof j.code === 'number' && j.code !== 0)) throw new Error((j && (j.msg || j.error)) || `HTTP ${res.status}`);
  return j && typeof j === 'object' && 'data' in j ? j.data : j;
}

async function loadList() { try { state.list = await apiJson('/api/rules/v1/definitions') || []; } catch { state.list = []; } refreshView('explorer'); }
async function selectDecision(key) {
  state.selectedKey = key; state.logs = []; state.selectedLog = null; state.detail = null;
  refreshView('explorer'); refreshView('content'); refreshView('property');
  try { state.logs = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(key) + '/logs') || []; } catch { state.logs = []; }
  refreshView('content');
}
async function selectLog(id) {
  state.selectedLog = id; state.detail = null; refreshView('content'); refreshView('property');
  try { state.detail = await apiJson('/api/rules/v1/logs/' + encodeURIComponent(id)); } catch { /* */ }
  refreshView('property');
}

function hostRoot(host) { return host?.renderRoot || host?.shadowRoot?.querySelector('.rl') || host; }
function mount(ctx, view) {
  const host = ctx.host; state.hosts.add(host); host.__view = view;
  const render = () => { const root = hostRoot(host); if (!root || root.isConnected === false) return; root.innerHTML = `<style>${css()}</style>${viewHtml(view)}`; bind(root, view); };
  requestAnimationFrame(() => { render(); if (view === 'explorer' && !state.list.length) loadList(); });
  return `<style>${css()}</style>${viewHtml(view)}`;
}
function refreshView(view) { for (const host of state.hosts) { if (host.__view !== view) continue; const root = hostRoot(host); if (!root || root.isConnected === false) continue; root.innerHTML = `<style>${css()}</style>${viewHtml(view)}`; bind(root, view); } }
function viewHtml(view) { if (view === 'explorer') return explorerHtml(); if (view === 'property') return propertyHtml(); return contentHtml(); }

function explorerHtml() {
  const rows = state.list.map(d => `<li class="rl-item ${d.key === state.selectedKey ? 'sel' : ''}" data-key="${esc(d.key)}"><span class="rl-nm">${esc(d.name || d.key)}</span></li>`).join('');
  return `<div class="rl"><div class="rl-hd">决策集</div><ul class="rl-list">${rows || '<li class="ph">暂无决策集</li>'}</ul></div>`;
}
function contentHtml() {
  if (!state.selectedKey) return `<div class="rl"><div class="ph">从左侧选择决策集，查看其决策日志</div></div>`;
  const logs = state.logs;
  const rows = logs.map(l => `<tr class="rl-log ${l.id === state.selectedLog ? 'sel' : ''} ${l.failure ? 'fail' : ''}" data-log="${esc(l.id)}">
    <td class="rl-t">${esc(fmtTime(l.createdAt))}</td>
    <td>v${l.decisionVersion ?? 1}</td>
    <td class="rl-o">${esc(shortObj(l.output))}</td>
    <td class="rl-num">${l.timingUs ?? 0}µs</td>
    <td>${esc(l.caller || '—')}</td>
    <td>${l.failure ? '<span class="rl-badge fail">失败</span>' : '<span class="rl-badge ok">成功</span>'}</td>
  </tr>`).join('');
  return `<div class="rl">
    <div class="rl-hd">决策日志 <span class="rl-sub">${logs.length} 条（近 100）</span> <button class="rl-btn xs" data-act="reload">刷新</button></div>
    <div class="rl-tablewrap"><table class="rl-table"><thead><tr><th>时刻</th><th>版本</th><th>输出</th><th>时延</th><th>调用方</th><th>状态</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="ph">该决策暂无日志（求值后产生）</td></tr>'}</tbody></table></div>
  </div>`;
}
function propertyHtml() {
  if (!state.selectedLog) return `<div class="rl"><div class="ph">点击日志行查看全量 trace 归因</div></div>`;
  const d = state.detail;
  if (!d) return `<div class="rl"><div class="ph">加载中…</div></div>`;
  const trace = d.trace || [];
  const nodes = trace.map(t => `<div class="rl-node ${t.failure ? 'fail' : (t.matchedRules || []).length ? 'hit' : 'miss'}">
    <div class="rl-nodehd">${esc(t.nodeId)} <span class="rl-tag">${esc(t.nodeKind)}</span><span class="rl-us">${t.timingUs}µs</span></div>
    <div class="rl-noderow">命中规则行：${(t.matchedRules || []).length ? t.matchedRules.join(', ') : '无'}</div>
    ${t.failure ? `<div class="rl-fail">${esc(t.failure)}</div>` : ''}
    <pre class="rl-json sm">${esc(JSON.stringify(t.output))}</pre></div>`).join('');
  return `<div class="rl">
    <div class="rl-hd">决策归因 <span class="rl-sub">可解释性 · 超越 ZEN</span></div>
    <div class="rl-kv"><span>决策</span><b>${esc(d.decisionKey)} v${d.decisionVersion ?? 1}</b></div>
    <div class="rl-sec">输入</div><pre class="rl-json">${esc(JSON.stringify(d.input, null, 2))}</pre>
    <div class="rl-sec">输出</div><pre class="rl-json ${d.failure ? 'err' : ''}">${esc(JSON.stringify(d.output, null, 2))}</pre>
    ${d.failure ? `<div class="rl-fail">失败归因：${esc(d.failure)}</div>` : ''}
    <div class="rl-sec">轨迹 trace</div>${nodes || '<div class="ph">无 trace</div>'}
  </div>`;
}

function bind(root, view) {
  root.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-key]'); if (item) { selectDecision(item.getAttribute('data-key')); return; }
    const log = ev.target.closest('[data-log]'); if (log) { selectLog(log.getAttribute('data-log')); return; }
    const act = ev.target.closest('[data-act]')?.getAttribute('data-act');
    if (act === 'reload' && state.selectedKey) selectDecision(state.selectedKey);
  });
}

function fmtTime(s) { if (!s) return '—'; try { return String(s).replace('T', ' ').replace(/\.\d+.*/, ''); } catch { return String(s); } }
function shortObj(o) { try { const s = typeof o === 'string' ? o : JSON.stringify(o); return s && s.length > 36 ? s.slice(0, 36) + '…' : (s || 'null'); } catch { return 'null'; } }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

function css() {
  return `
  .rl{font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--sapTextColor,#32363a);height:100%;box-sizing:border-box;padding:8px 10px;overflow:auto}
  .ph{color:#8b97b3;padding:16px 10px;text-align:center}
  .rl-hd{font-weight:600;font-size:12px;color:var(--sapContent_LabelColor,#6a6d70);margin:10px 0 6px;display:flex;align-items:center;gap:8px}
  .rl-sub{font-weight:400;color:#8b97b3;font-size:11px}
  .rl-list{list-style:none;margin:0;padding:0}
  .rl-item{padding:7px 9px;border-radius:7px;cursor:pointer}.rl-item:hover{background:var(--sapList_Hover_Background,#f2f3f4)}.rl-item.sel{background:var(--sapList_SelectionBackgroundColor,#e5f0fa)}
  .rl-nm{font-weight:500}
  .rl-tablewrap{overflow:auto;border:1px solid var(--sapList_BorderColor,#e5e5e5);border-radius:8px}
  .rl-table{border-collapse:collapse;width:100%;font-size:12px}
  .rl-table th,.rl-table td{border:1px solid var(--sapList_BorderColor,#ededed);padding:5px 8px;text-align:left;white-space:nowrap}
  .rl-table th{background:var(--sapList_HeaderBackground,#f7f7f7);font-weight:600;position:sticky;top:0}
  .rl-log{cursor:pointer}.rl-log:hover{background:var(--sapList_Hover_Background,#f5f6f7)}.rl-log.sel{background:#e5f0fa}.rl-log.fail td.rl-o{color:#c0392b}
  .rl-t{color:#6a6d70}.rl-o{font:11px ui-monospace,monospace;color:#0a6ed1}.rl-num{text-align:right;color:#8b97b3}
  .rl-badge{padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}.rl-badge.ok{background:rgba(46,125,91,.12);color:#2e7d5b}.rl-badge.fail{background:rgba(217,83,79,.14);color:#c0392b}
  .rl-btn{border:1px solid #0a6ed1;background:#fff;color:#0a6ed1;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}.rl-btn.xs{padding:2px 8px;font-size:11px}
  .rl-kv{display:flex;gap:8px;padding:3px 0}.rl-kv span{color:#8b97b3;width:44px}
  .rl-sec{font-size:11px;color:#8b97b3;margin:10px 0 3px;font-weight:600}
  .rl-json{margin:0;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;background:var(--sapField_ReadOnly_Background,#f7f8f9);border-radius:6px;padding:6px 8px;color:inherit}
  .rl-json.sm{font-size:11px;color:#6a6d70;margin-top:4px}.rl-json.err{color:#c0392b}
  .rl-fail{color:#c0392b;font-size:11px;margin-top:6px}
  .rl-node{border:1px solid var(--sapList_BorderColor,#e5e5e5);border-left-width:3px;border-radius:7px;padding:8px 10px;margin-top:6px}
  .rl-node.hit{border-left-color:#2e7d5b}.rl-node.miss{border-left-color:#c0c4c8}.rl-node.fail{border-left-color:#c0392b;background:rgba(217,83,79,.05)}
  .rl-nodehd{font-weight:600;font-size:12px;display:flex;align-items:center;gap:8px}.rl-tag{font-size:10px;background:#eef1f5;color:#6a6d70;padding:1px 6px;border-radius:8px}.rl-us{margin-left:auto;font-size:10px;color:#8b97b3}
  .rl-noderow{font-size:11px;color:#6a6d70;margin-top:3px}
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
