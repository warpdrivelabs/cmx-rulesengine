// 生成「业务单据→会计凭证」方案的两张图（自包含浅色卡片 SVG，CVD-安全调色板）：
//   fig-arch  架构图（单据→规则引擎→凭证→过账 全景 + EXISTS/GAP）
//   fig-flow  记账流水图（采购发票 worked example 的数据变换流水）
// 用法: node docs/assets/gen-acct-svgs.mjs
import { writeFileSync } from 'node:fs'
const DIR = '/Users/nanomesh/Workspace/presentation/cmx-rulesengine/docs/assets'

const P = {
  surface: '#fcfcfb', plane: '#f4f4f1', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781',
  grid: '#e1e0d9', base: '#c3c2b7', border: 'rgba(11,11,11,0.12)',
  blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a', yellow: '#eda100',
  magenta: '#e87ba4', green: '#008300', violet: '#4a3aa7', red: '#e34948',
  good: '#0ca30c', warn: '#fab219', muted2: '#898781', mono: 'ui-monospace,SFMono-Regular,Menlo,monospace',
}
const FONT = "system-ui,-apple-system,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const wOf = (s, per = 11) => [...String(s)].reduce((a, c) => a + (/[\x00-\xff]/.test(c) ? per * 0.58 : per), 0)
const T = (x, y, s, o = {}) => { const { size = 13, w = 400, fill = P.ink, anchor = 'start', op = 1, mono = false } = o; return `<text x="${x}" y="${y}" font-family="${mono ? P.mono : FONT}" font-size="${size}" font-weight="${w}" fill="${fill}" text-anchor="${anchor}" opacity="${op}">${esc(s)}</text>` }
const R = (x, y, w, h, o = {}) => { const { rx = 10, fill = 'none', stroke = 'none', sw = 1, fop = 1, sop = 1, dash = '' } = o; return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" fill-opacity="${fop}" stroke="${stroke}" stroke-opacity="${sop}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>` }
const LINE = (x1, y1, x2, y2, o = {}) => { const { stroke = P.muted, sw = 1.6, dash = '', marker = true } = o; return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}${marker ? ' marker-end="url(#arr)"' : ''}/>` }
const defs = `<defs><marker id="arr" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0,0 L6.5,3 L0,6 Z" fill="${P.muted}"/></marker></defs>`
const doc = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">${defs}${R(0, 0, w, h, { rx: 16, fill: P.surface, stroke: P.border, sw: 1 })}${body}</svg>`
const title = (w, s, sub) => T(w / 2, 34, s, { size: 19, w: 800, anchor: 'middle' }) + (sub ? T(w / 2, 55, sub, { size: 12.5, fill: P.ink2, anchor: 'middle' }) : '')
// 徽标：EXISTS(good) / GAP(warn) / 下游(muted)
const badge = (x, y, txt, kind) => { const c = kind === 'exists' ? P.good : kind === 'gap' ? P.warn : P.muted2; const w = wOf(txt, 10) + 16; return R(x - w, y, w, 16, { rx: 8, fill: c, fop: 0.16, stroke: c, sop: 0.4, sw: 1 }) + T(x - w / 2, y + 11.5, txt, { size: 9.5, w: 700, fill: P.ink, anchor: 'middle' }) }
// 阶段卡：色条 + 序号 + 标题 + 副标 + 数据行 + 角标
const stage = (x, y, w, h, hue, num, tt, sub, lines, o = {}) => {
  let s = R(x, y, w, h, { rx: 11, fill: hue, fop: 0.09, stroke: hue, sop: 0.34, sw: 1 })
  s += R(x, y, 4, h, { rx: 2, fill: hue })
  if (num) { s += `<circle cx="${x + 22}" cy="${y + 22}" r="11" fill="${hue}"/>` + T(x + 22, y + 26, num, { size: 12, w: 800, fill: '#fff', anchor: 'middle' }) }
  s += T(x + (num ? 40 : 16), y + 20, tt, { size: 13.5, w: 700 })
  if (sub) s += T(x + (num ? 40 : 16), y + 35, sub, { size: 10.5, fill: P.ink2 })
  ;(lines || []).forEach((ln, i) => { s += T(x + 16, y + 54 + i * 15, ln, { size: 10.5, fill: P.ink2, mono: !!o.mono }) })
  if (o.badge) s += badge(x + w - 8, y + 8, o.badge[0], o.badge[1])
  return s
}

// ════════════ 图1 · 架构图 ════════════
function figArch () {
  const W = 980, H = 384
  let b = title(W, '架构图 · 业务单据 → 会计凭证 → 过账', '规则引擎是「产凭证」的大脑；总账是「过账」的手。绿=已具备可复用 · 橙=轻量新增 · 灰=下游另案')
  // 顶部触发条
  b += R(40, 72, W - 80, 30, { rx: 8, fill: P.green, fop: 0.10, stroke: P.green, sop: 0.3, sw: 1 })
  b += T(56, 91, '触发（已测）：流程审批通过节点 → businessRuleTask（decisionRef=记账规则）→ serviceTask 出凭证', { size: 11.5, w: 600, fill: P.ink })
  b += badge(W - 48, 79, '复用', 'exists')
  // 四阶段
  const y = 128, h = 132, gap = 18, sw = (W - 80 - 3 * gap) / 4
  const xs = [0, 1, 2, 3].map(i => 40 + i * (sw + gap))
  b += stage(xs[0], y, sw, h, P.blue, '', '业务单据 DOC', 'cmx-doc', ['header + 明细行', 'cv_* 同机制', 'GET /api/doc/data'], { badge: ['已有', 'exists'] })
  b += stage(xs[1], y, sw, h, P.orange, '', '记账规则引擎', 'cmx-rulesengine', ['① 事件适配器', '② 决策图: Collect表', '   +科目确定+脚本平衡'], { badge: ['引擎有·胶水新增', 'gap'] })
  b += stage(xs[2], y, sw, h, P.blue, '', '会计凭证草稿', 'cv_* (DOC)', ['借贷分录 6币位', 'POST /api/doc/save', '状态 draft'], { badge: ['已有', 'exists'] })
  b += stage(xs[3], y, sw, h, P.muted2, '', '总账过账', 'cmx-gl（另案）', ['cv_* → ga_journal', '+ ga_balance', '单一写账·只增'], { badge: ['下游·已设计', 'down'] })
  for (let i = 0; i < 3; i++) b += LINE(xs[i] + sw, y + h / 2, xs[i + 1], y + h / 2)
  // 产凭证 | 过账 分界
  const bx = (xs[2] + sw + xs[3]) / 2
  b += LINE(bx, y - 12, bx, y + h + 12, { stroke: P.base, sw: 1.4, dash: '5 4', marker: false })
  b += T(xs[0], y + h + 26, '◀── 产凭证 = 规则引擎（本方案范围） ──▶', { size: 11, w: 700, fill: P.orange })
  b += T(xs[3] + sw, y + h + 26, '◀ 过账 = 总账 ▶', { size: 11, w: 700, fill: P.muted, anchor: 'end' })
  // 主数据层（底部，向上喂）
  const my = y + h + 42
  b += R(40, my, W - 80, 44, { rx: 10, fill: P.violet, fop: 0.09, stroke: P.violet, sop: 0.32, sw: 1 })
  b += R(40, my, 4, 44, { rx: 2, fill: P.violet })
  b += T(56, my + 19, 'DCT 主数据（唯一事实源，规则只引用不定义）', { size: 12, w: 700 })
  b += T(56, my + 35, 'cf_gl_account 自分级科目表(COA) · 35 个 cf_* 辅助核算维度(成本中心/项目/往来/税码/组织/期间…) · 经 DctHierService 查 item_code', { size: 10.5, fill: P.ink2 })
  b += badge(W - 48, my + 6, '已有', 'exists')
  b += LINE(xs[1] + sw / 2, my, xs[1] + sw / 2, y + h + 6, { stroke: P.violet, sw: 1.4 })
  return doc(W, H, b)
}

// ════════════ 图2 · 记账流水图（采购发票 worked example）════════════
function figFlow () {
  const W = 980, H = 500
  let b = title(W, '记账流水图 · 采购发票 → 记账凭证（实例）', '一次 evaluate：Collect 决策表把单据展开为 N 条借贷分录，科目确定落真实科目，平衡后组装凭证')
  const y1 = 76, y2 = 268, h = 168, gap = 20, w = (W - 80 - 2 * gap) / 3
  const xs = [0, 1, 2].map(i => 40 + i * (w + gap))
  // Row 1
  b += stage(xs[0], y1, w, h, P.aqua, '1', '采购发票', '3 明细 · 价税合计 13,560', ['存货 净额 10,000', '费用 净额 2,000', '进项税 1,560', '税码 J1 / 供应商 V0001'])
  b += stage(xs[1], y1, w, h, P.blue, '2', '记账事件契约', '归一化 · 任意单据同一契约', ['docType/bizEvent/期间', 'amounts.netStock=10000', 'amounts.netExpense=2000', 'amounts.tax=1560 gross=13560'], { mono: false })
  b += stage(xs[2], y1, w, h, P.orange, '3', 'Collect 决策表', 'hitPolicy "C" → 行数组', ['借 INVENTORY  10000', '借 EXPENSE     2000', '借 INPUT_VAT   1560', '贷 PAYABLE    13560'], { mono: true })
  for (let i = 0; i < 2; i++) b += LINE(xs[i] + w, y1 + h / 2, xs[i + 1], y1 + h / 2)
  // wrap arrow row1→row2
  b += LINE(xs[2] + w / 2, y1 + h, xs[2] + w / 2, y1 + h + 14, { marker: false, sw: 1.6 })
  b += LINE(xs[2] + w / 2, y1 + h + 14, xs[0] + w / 2, y1 + h + 14, { marker: false, sw: 1.6 })
  b += LINE(xs[0] + w / 2, y1 + h + 14, xs[0] + w / 2, y2, { sw: 1.6 })
  // Row 2
  b += stage(xs[0], y2, w, h, P.magenta, '4', '科目确定（子决策）', '映射键 → cf_gl_account', ['INVENTORY→140301 原材料', 'EXPENSE  →660201 管理费用', 'INPUT_VAT→22210101 进项税', 'PAYABLE  →220201 应付账款'], { mono: false })
  b += stage(xs[1], y2, w, h, P.green, '5', '平衡 & 组装', '脚本节点 · 过滤0额+差额行', ['借合计 13,560', '贷合计 13,560', '✓ 借贷平衡', '→ 凭证头(凭证字/摘要/期间)'])
  // Row2 card 6 = 分录表
  const cx = xs[2], cy = y2
  b += R(cx, cy, w, h, { rx: 11, fill: P.blue, fop: 0.09, stroke: P.blue, sop: 0.34, sw: 1 })
  b += R(cx, cy, 4, h, { rx: 2, fill: P.blue })
  b += `<circle cx="${cx + 22}" cy="${cy + 22}" r="11" fill="${P.blue}"/>` + T(cx + 22, cy + 26, '6', { size: 12, w: 800, fill: '#fff', anchor: 'middle' })
  b += T(cx + 40, cy + 20, '会计凭证', { size: 13.5, w: 700 })
  b += T(cx + 40, cy + 35, 'cv_acc_line · 借贷分录', { size: 10.5, fill: P.ink2 })
  // 迷你分录表
  const tx = cx + 14, tw = w - 28, ty = cy + 46, rh = 19
  const cols = [tx + 2, tx + tw - 96, tx + tw - 30]
  b += T(cols[0], ty, '科目', { size: 9.5, w: 700, fill: P.muted }) + T(cols[1], ty, '借', { size: 9.5, w: 700, fill: P.muted, anchor: 'end' }) + T(cols[2], ty, '贷', { size: 9.5, w: 700, fill: P.muted, anchor: 'end' })
  const rows = [['140301 原材料', '10000', ''], ['660201 管理费用', '2000', ''], ['22210101 进项税', '1560', ''], ['220201 应付账款', '', '13560']]
  rows.forEach((r, i) => { const yy = ty + 8 + (i + 1) * rh; b += T(cols[0], yy, r[0], { size: 10, fill: P.ink, mono: false }); b += T(cols[1], yy, r[1], { size: 10, fill: P.ink, anchor: 'end', mono: true }); b += T(cols[2], yy, r[2], { size: 10, fill: P.ink, anchor: 'end', mono: true }) })
  const yt = ty + 8 + 5 * rh + 4
  b += LINE(tx, yt - 12, tx + tw, yt - 12, { stroke: P.base, sw: 1, marker: false })
  b += T(cols[0], yt, '合计', { size: 9.5, w: 700, fill: P.muted }) + T(cols[1], yt, '13560', { size: 10, w: 700, anchor: 'end', mono: true, fill: P.good }) + T(cols[2], yt, '13560', { size: 10, w: 700, anchor: 'end', mono: true, fill: P.good })
  for (let i = 0; i < 2; i++) b += LINE(xs[i] + w, y2 + h / 2, xs[i + 1], y2 + h / 2)
  // trace 注脚
  b += T(40, H - 16, '审计：GET /logs/{id} — 每条凭证行可回溯到产出它的规则（如 660201 ← 规则 r_expense + 科目确定 a2）。引擎产出数组、借贷平衡由脚本/组装校验。', { size: 10.5, fill: P.muted })
  return doc(W, H, b)
}

const figs = { 'fig-arch': figArch(), 'fig-flow': figFlow() }
const out = {}
for (const [k, v] of Object.entries(figs)) { writeFileSync(`${DIR}/${k}.svg`, v); out[k] = `data:image/svg+xml;base64,${Buffer.from(v).toString('base64')}`; console.log(`${k}.svg ${v.length}B → b64 ${out[k].length}B`) }
writeFileSync(`${DIR}/embeds.json`, JSON.stringify(out, null, 2))
console.log('embeds.json written')
