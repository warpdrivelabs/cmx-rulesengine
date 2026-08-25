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

const state = { list: [], categories: [], collapsed: {}, selectedKey: null, logs: [], selectedLog: null, detail: null, search: '', page: 1, hosts: new Set() };
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
  requestAnimationFrame(() => { for (const h of state.hosts) { if (h.__view === 'explorer') { const inp = hostRoot(h)?.querySelector?.('#rl-search'); if (inp) { inp.focus(); const p = pos == null ? inp.value.length : pos; try { inp.setSelectionRange(p, p); } catch { /* */ } } } } });
}

async function apiJson(url, options = {}) {
  const full = (CFG.apiBase && url.charAt(0) === '/') ? CFG.apiBase + url : url;
  const res = await fetch(full, { ...CFG.fetchInit, ...options, headers: { Accept: 'application/json', ...CFG.authHeaders(), ...(options.headers || {}) } });
  let j = null; try { j = await res.json(); } catch { /* */ }
  if (!res.ok || (j && typeof j.code === 'number' && j.code !== 0)) throw new Error((j && (j.msg || j.error)) || `HTTP ${res.status}`);
  return j && typeof j === 'object' && 'data' in j ? j.data : j;
}

async function loadList() { try { const [list, cats] = await Promise.all([apiJson('/api/rules/v1/definitions'), apiJson('/api/rules/v1/categories').catch(() => [])]); state.list = list || []; state.categories = cats || []; } catch (e) { state.list = []; console.warn('装载决策集失败', e); flash('装载决策集失败: ' + (e.message || e), true); } refreshView('explorer'); }
async function selectDecision(key) {
  state.selectedKey = key; state.logs = []; state.selectedLog = null; state.detail = null;
  refreshView('explorer'); refreshView('content'); refreshView('property');
  try { state.logs = await apiJson('/api/rules/v1/decisions/' + encodeURIComponent(key) + '/logs') || []; } catch (e) { state.logs = []; console.warn('装载执行日志失败', e); flash('装载执行日志失败: ' + (e.message || e), true); }
  refreshView('content');
}
async function selectLog(id) {
  state.selectedLog = id; state.detail = null; refreshView('content'); refreshView('property');
  try { state.detail = await apiJson('/api/rules/v1/logs/' + encodeURIComponent(id)); } catch (e) { console.warn('装载日志明细失败', e); flash('装载日志明细失败: ' + (e.message || e), true); }
  refreshView('property');
}

/** 轻提示（与 design-workbench.js 的 flash 同实现副本，native 页无模块共享，改动须同步）。 */
function flash(msg, err) {
  try {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:9999;padding:10px 18px;border-radius:8px;font-size:13px;color:#fff;background:${err ? '#d9534f' : '#2e7d5b'};box-shadow:0 4px 16px rgba(0,0,0,.25)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  } catch { /* 无 document */ }
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
  const gl = groupedList();
  const groupsHtml = gl.groups.length
    ? gl.groups.map(g => {
        const gid = g.code || '__none__';
        const open = state.search ? true : !state.collapsed[gid];
        const rows = g.items.map(d => `<li class="rl-item ${d.key === state.selectedKey ? 'sel' : ''}" data-key="${esc(d.key)}"><span class="rl-nm">${esc(d.name || d.key)}</span></li>`).join('');
        return `<details class="rl-grp"${open ? ' open' : ''} data-grp="${esc(gid)}">
          <summary class="rl-grp-hd"><span class="rl-grp-nm">${esc(g.name)}</span><span class="rl-sub">${g.items.length}</span></summary>
          <ul class="rl-list-inner">${rows}</ul>
        </details>`;
      }).join('')
    : `<div class="ph">${state.list.length ? '无匹配决策集' : '暂无决策集'}</div>`;
  return `<div class="rl rl-explorer">
    <div class="rl-hd">决策集<span class="rl-sub">${gl.filteredTotal}${gl.filteredTotal !== state.list.length ? '/' + state.list.length : ''}</span></div>
    <div class="rl-searchbar">
      <span class="rl-searchwrap"><input class="rl-search" id="rl-search" placeholder="查找名称或键…" value="${esc(state.search)}" autocomplete="off"/>${state.search ? '<button class="rl-searchx" data-act="list-search-clear" title="清空">✕</button>' : ''}</span>
      <button class="rl-iconbtn" data-act="list-reload" title="刷新">${ICON_REFRESH}</button>
    </div>
    <div class="rl-groups">${groupsHtml}</div>
  </div>`;
}
const ICON_REFRESH = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3h-3"/></svg>';
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
  if (root.__rulesLogsBound) return; // 委托监听只绑一次；refresh 仅重置 innerHTML 不动 root，重复绑会叠加→事件风暴
  root.__rulesLogsBound = true;
  // 分组折叠态记忆（toggle 不冒泡 → 捕获阶段接住）。
  root.addEventListener('toggle', (ev) => {
    const d = ev.target; if (!d.matches || !d.matches('details.rl-grp')) return;
    state.collapsed[d.getAttribute('data-grp')] = !d.open;
  }, true);
  root.addEventListener('input', (ev) => {
    if (ev.target.id !== 'rl-search') return;
    const pos = ev.target.selectionStart;
    state.search = ev.target.value; state.page = 1;
    refreshView('explorer'); focusSearch(pos);
  });
  root.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-key]'); if (item) { selectDecision(item.getAttribute('data-key')); return; }
    const log = ev.target.closest('[data-log]'); if (log) { selectLog(log.getAttribute('data-log')); return; }
    const act = ev.target.closest('[data-act]')?.getAttribute('data-act');
    if (act === 'reload' && state.selectedKey) selectDecision(state.selectedKey); // content 区：刷新当前决策日志
    else if (act === 'list-reload') loadList();                                    // explorer 区：刷新决策集列表
    else if (act === 'list-prev') { if (state.page > 1) { state.page--; refreshView('explorer'); } }
    else if (act === 'list-next') { state.page++; refreshView('explorer'); }
    else if (act === 'list-search-clear') { state.search = ''; state.page = 1; refreshView('explorer'); focusSearch(); }
  });
}

function fmtTime(s) { if (!s) return '—'; try { return String(s).replace('T', ' ').replace(/\.\d+.*/, ''); } catch { return String(s); } }
function shortObj(o) { try { const s = typeof o === 'string' ? o : JSON.stringify(o); return s && s.length > 36 ? s.slice(0, 36) + '…' : (s || 'null'); } catch { return 'null'; } }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

function css() {
  return `
  .rl{
    /* ── 设计令牌：锚定 UI5 --sap*（随门户主题 light/dark 翻转，穿透 shadow DOM）；独立 :8094 走 hex 兜底。 ── */
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
  .rl.rl-explorer{display:flex;flex-direction:column;overflow:hidden}
  .rl.rl-explorer .rl-list{flex:1 1 auto;overflow:auto;min-height:0;margin:0 -2px;padding:0 2px}
  .rl-groups{flex:1 1 auto;overflow:auto;min-height:0;margin:0 -2px;padding:0 2px}
  .rl-list-inner{list-style:none;margin:0;padding:0}
  .rl-grp{border-bottom:1px solid var(--dg-border)}
  .rl-grp-hd{list-style:none;cursor:pointer;user-select:none;display:flex;align-items:center;gap:7px;padding:7px 6px;font-size:11.5px;font-weight:600;color:var(--dg-muted);letter-spacing:.02em}
  .rl-grp-hd::-webkit-details-marker{display:none}
  .rl-grp-hd::before{content:"▸";font-size:10px;color:var(--dg-faint);transition:transform .12s;flex:0 0 auto}
  .rl-grp[open]>.rl-grp-hd::before{transform:rotate(90deg)}
  .rl-grp[open]>.rl-grp-hd{color:var(--dg-fg)}
  .rl-grp-nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ph{color:var(--dg-faint);padding:22px 10px;text-align:center;font-size:12px}
  .rl-hd{font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dg-muted);margin:12px 0 7px;display:flex;align-items:center;gap:8px;flex:0 0 auto}
  .rl-hd::before{content:"";width:3px;height:12px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent-line);flex:0 0 auto}
  .rl-hd:first-child{margin-top:2px}
  .rl-sub{font-weight:500;color:var(--dg-faint);font-size:10px;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;padding:1px 6px;border-radius:10px;background:var(--dg-accent-soft)}
  .rl-list{list-style:none;margin:0;padding:0}
  .rl-item{padding:8px 10px;border-radius:9px;cursor:pointer;position:relative;border:1px solid transparent;transition:background .14s,border-color .14s}
  .rl-item:hover{background:var(--dg-hover)}
  .rl-item.sel{background:var(--dg-sel);border-color:var(--dg-accent-line)}
  .rl-item.sel::before{content:"";position:absolute;left:0;top:18%;bottom:18%;width:2.5px;border-radius:2px;background:linear-gradient(var(--dg-accent),var(--dg-accent2));box-shadow:0 0 8px var(--dg-accent)}
  .rl-nm{font-weight:500}
  .rl-tablewrap{overflow:auto;border:1px solid var(--dg-border);border-radius:11px}
  .rl-table{border-collapse:collapse;width:100%;font-size:12px}
  .rl-table th,.rl-table td{border:1px solid var(--dg-border);padding:6px 9px;text-align:left;white-space:nowrap}
  .rl-table th{background:color-mix(in srgb,var(--dg-accent) 5%,var(--dg-surface));font-weight:600;position:sticky;top:0;color:var(--dg-muted)}
  .rl-log{cursor:pointer;transition:background .12s}.rl-log:hover{background:var(--dg-hover)}.rl-log.sel{background:var(--dg-sel)}.rl-log.fail td.rl-o{color:var(--dg-danger)}
  .rl-t{color:var(--dg-muted);font-variant-numeric:tabular-nums}.rl-o{font:11px var(--dg-mono);color:var(--dg-accent)}.rl-num{text-align:right;color:var(--dg-faint);font-family:var(--dg-mono);font-variant-numeric:tabular-nums}
  .rl-badge{display:inline-flex;align-items:center;padding:1px 9px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid transparent}
  .rl-badge.ok{background:color-mix(in srgb,var(--dg-ok) 14%,transparent);color:var(--dg-ok);border-color:color-mix(in srgb,var(--dg-ok) 30%,transparent)}
  .rl-badge.fail{background:color-mix(in srgb,var(--dg-danger) 15%,transparent);color:var(--dg-danger);border-color:color-mix(in srgb,var(--dg-danger) 32%,transparent)}
  .rl-btn{border:1px solid var(--dg-border-strong);background:var(--dg-surface);color:var(--dg-accent);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer;transition:border-color .14s,box-shadow .14s}
  .rl-btn:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}
  .rl-btn.xs{padding:3px 9px;font-size:11px}
  .rl-btn.ghost{border-color:var(--dg-border);color:var(--dg-muted);background:transparent}
  .rl-btn.ghost:hover{border-color:var(--dg-accent);color:var(--dg-accent)}
  .rl-btn.ghost[disabled]{opacity:.35;cursor:default;box-shadow:none;border-color:var(--dg-border)}
  .rl-searchbar{display:flex;align-items:stretch;gap:6px;margin:4px 0 6px;flex:0 0 auto}
  .rl-searchwrap{position:relative;flex:1 1 auto;display:flex}
  .rl-search{width:100%;box-sizing:border-box;border:1px solid var(--dg-border-strong);border-radius:8px;padding:7px 26px 7px 10px;font-size:13px;background:var(--sapField_Background,#fff);color:inherit;transition:border-color .14s,box-shadow .14s}
  .rl-search:focus{outline:none;border-color:var(--dg-accent);box-shadow:0 0 0 3px var(--dg-accent-soft)}
  .rl-searchx{position:absolute;right:7px;top:50%;transform:translateY(-50%);border:none;background:transparent;color:var(--dg-faint);cursor:pointer;font-size:12px;line-height:1;padding:2px 4px}
  .rl-searchx:hover{color:var(--dg-danger)}
  .rl-iconbtn{flex:0 0 auto;width:32px;aspect-ratio:1/1;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--dg-border-strong);border-radius:8px;background:var(--dg-surface);color:var(--dg-accent);cursor:pointer;transition:border-color .14s,box-shadow .14s,transform .3s}
  .rl-iconbtn:hover{border-color:var(--dg-accent);box-shadow:var(--dg-glow)}
  .rl-iconbtn:active svg{transform:rotate(180deg)}
  .rl-iconbtn svg{display:block;transition:transform .3s}
  .rl-pager{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px;flex:0 0 auto}
  .rl-pager:empty{margin:0}
  .rl-pageinfo{font-size:11px;color:var(--dg-muted);min-width:46px;text-align:center;font-variant-numeric:tabular-nums;font-family:var(--dg-mono)}
  .rl-kv{display:flex;gap:8px;padding:4px 0;align-items:baseline}.rl-kv span{color:var(--dg-faint);width:44px;font-size:11px;flex:0 0 auto}.rl-kv b{font-variant-numeric:tabular-nums}
  .rl-sec{font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--dg-muted);margin:12px 0 4px;font-weight:600}
  .rl-json{margin:0;font:12px/1.5 var(--dg-mono);white-space:pre-wrap;background:var(--dg-surface);border:1px solid var(--dg-border);border-radius:8px;padding:7px 9px;color:inherit}
  .rl-json.sm{font-size:11px;color:var(--dg-muted);margin-top:4px}.rl-json.err{color:var(--dg-danger);border-color:color-mix(in srgb,var(--dg-danger) 30%,transparent)}
  .rl-fail{color:var(--dg-danger);font-size:11px;margin-top:6px}
  .rl-node{border:1px solid var(--dg-border);border-left-width:3px;border-radius:9px;padding:9px 11px;margin-top:6px;background:var(--dg-surface)}
  .rl-node.hit{border-left-color:var(--dg-ok)}.rl-node.miss{border-left-color:var(--dg-faint)}.rl-node.fail{border-left-color:var(--dg-danger);background:linear-gradient(135deg,color-mix(in srgb,var(--dg-danger) 7%,transparent),transparent 70%),var(--dg-surface)}
  .rl-nodehd{font-weight:600;font-size:12px;display:flex;align-items:center;gap:8px}.rl-tag{font-size:10px;background:var(--dg-accent-soft);color:var(--dg-accent);padding:1px 7px;border-radius:9px;font-weight:600}.rl-us{margin-left:auto;font-size:10px;color:var(--dg-faint);font-family:var(--dg-mono);font-variant-numeric:tabular-nums}
  .rl-noderow{font-size:11px;color:var(--dg-muted);margin-top:4px}
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
