// gen.mjs — 生成「cmx-rulesengine 实现方案与开源全景对比」报告的全部图。
// 自包含浅色卡片 SVG，复用验证过的 CVD-安全调色板与 helper。
// 用法: node docs/report/assets/gen.mjs  → 写出 fig-*.svg
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const DIR = dirname(fileURLToPath(import.meta.url))

const P = {
  surface: '#fcfcfb', plane: '#f4f4f1', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781',
  grid: '#e1e0d9', base: '#c3c2b7', border: 'rgba(11,11,11,0.12)',
  blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a', yellow: '#eda100',
  magenta: '#e87ba4', green: '#008300', violet: '#4a3aa7', red: '#e34948',
  good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b',
  blue100: '#cde2fb', blue550: '#1c5cab',
}
const FONT = "system-ui,-apple-system,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const wOf = (s, per = 11) => [...String(s)].reduce((a, c) => a + (/[\x00-\xff]/.test(c) ? per * 0.58 : per), 0)

const T = (x, y, s, o = {}) => {
  const { size = 13, w = 400, fill = P.ink, anchor = 'start', op = 1, mono = false } = o
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${w}" fill="${fill}" text-anchor="${anchor}" opacity="${op}"${mono ? ' font-variant-numeric="tabular-nums"' : ''}>${esc(s)}</text>`
}
const R = (x, y, w, h, o = {}) => {
  const { rx = 10, fill = 'none', stroke = 'none', sw = 1, fop = 1, sop = 1 } = o
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" fill-opacity="${fop}" stroke="${stroke}" stroke-opacity="${sop}" stroke-width="${sw}"/>`
}
const LINE = (x1, y1, x2, y2, o = {}) => {
  const { stroke = P.muted, sw = 1.5, dash = '', marker = true } = o
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}${marker ? ' marker-end="url(#arr)"' : ''}/>`
}
const card = (w, h) => R(0, 0, w, h, { rx: 16, fill: P.surface, stroke: P.border, sw: 1 })
const defs = `<defs>
  <marker id="arr" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0,0 L6.5,3 L0,6 Z" fill="${P.muted}"/></marker>
</defs>`
const doc = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">${defs}${card(w, h)}${body}</svg>`

const band = (x, y, w, h, hue, title, sub, loc) => {
  let s = R(x, y, w, h, { rx: 10, fill: hue, fop: 0.10, stroke: hue, sop: 0.32, sw: 1 })
  s += R(x, y, 4, h, { rx: 2, fill: hue })
  s += T(x + 18, y + (sub ? h / 2 - 4 : h / 2 + 5), title, { size: 14.5, w: 700 })
  if (sub) s += T(x + 18, y + h / 2 + 15, sub, { size: 11.5, fill: P.ink2 })
  if (loc) s += T(x + w - 14, y + h / 2 + 5, loc, { size: 12, fill: P.muted, anchor: 'end', mono: true })
  return s
}
const cell = (x, y, w, h, hue, title, sub) => {
  let s = R(x, y, w, h, { rx: 9, fill: hue, fop: 0.10, stroke: hue, sop: 0.30, sw: 1 })
  s += R(x, y, 4, h, { rx: 2, fill: hue })
  s += T(x + w / 2 + 2, y + (sub ? h / 2 - 2 : h / 2 + 4), title, { size: 12.5, w: 700, anchor: 'middle' })
  if (sub) s += T(x + w / 2 + 2, y + h / 2 + 13, sub, { size: 10, fill: P.ink2, anchor: 'middle' })
  return s
}
const chip = (x, y, label, hue, o = {}) => {
  const { size = 11, pad = 11, h = 22 } = o
  const w = Math.round(wOf(label, size) + pad * 2)
  let s = R(x, y, w, h, { rx: h / 2, fill: hue, fop: 0.13, stroke: hue, sop: 0.34, sw: 1 })
  s += `<circle cx="${x + pad - 2}" cy="${y + h / 2}" r="3" fill="${hue}"/>`
  s += T(x + pad + 5, y + h / 2 + 4, label, { size, fill: P.ink })
  return { svg: s, w }
}
const chipFlow = (x0, y0, maxX, items, hue, o = {}) => {
  const { gap = 7, lh = 28 } = o
  let x = x0, y = y0, out = ''
  for (const it of items) {
    const c = chip(x, y, it, hue, o)
    if (x + c.w > maxX && x > x0) { x = x0; y += lh; }
    const c2 = chip(x, y, it, hue, o)
    out += c2.svg; x += c2.w + gap
  }
  return { svg: out, height: y + lh - y0 }
}
const titleBlk = (w, s, sub) => T(w / 2, 34, s, { size: 19, w: 800, anchor: 'middle' }) +
  (sub ? T(w / 2, 54, sub, { size: 12.5, fill: P.ink2, anchor: 'middle' }) : '')

const ST = { ok: P.good, warn: P.warning, no: P.muted }
const GLY = { ok: '✓', warn: '!', no: '–' }
const statusCell = (x, y, label, st, wFixed) => {
  const hue = ST[st], h = 24, w = wFixed || Math.round(wOf(label, 11.5) + 40)
  let s = R(x, y, w, h, { rx: 7, fill: hue, fop: st === 'no' ? 0.07 : 0.13, stroke: hue, sop: st === 'no' ? 0.3 : 0.36, sw: 1 })
  s += `<circle cx="${x + 13}" cy="${y + h / 2}" r="7.5" fill="${hue}"/>`
  s += T(x + 13, y + h / 2 + 4, GLY[st], { size: 11, w: 800, anchor: 'middle', fill: '#fff' })
  s += T(x + 27, y + h / 2 + 4.5, label, { size: 11.5, fill: st === 'no' ? P.ink2 : P.ink })
  return { svg: s, w }
}
const statusFlow = (x0, y0, maxX, items) => {
  const gap = 7, lh = 30
  let x = x0, y = y0, out = ''
  for (const [label, st] of items) {
    const probe = statusCell(x, y, label, st)
    if (x + probe.w > maxX && x > x0) { x = x0; y += lh }
    const c = statusCell(x, y, label, st)
    out += c.svg; x += c.w + gap
  }
  return { svg: out, height: y + lh - y0 }
}

// ══════════════ 图·封面定位 ══════════════
function figOverview () {
  const W = 940, H = 342
  const x = 40, w = W - 80
  let b = titleBlk(W, 'cmx-rulesengine · Rust 原生决策 / 规则引擎',
    '图优先 JDM 决策图 + 决策表(11 命中策略) + 自研 FEEL · 无状态微秒级同步求值 · 独立微服务 / 可嵌组件 / Headless · 对标 GoRules Zen · Drools · DMN')
  const tiles = [
    ['Rust', '语言 · edition 2024', P.violet],
    ['Apache-2.0', '许可 · 无使用限制', P.green],
    ['5,642', '域 LOC · 6 crate', P.blue],
    ['无状态', '微秒级同步求值', P.aqua],
    ['11 策略', 'DMN 命中策略', P.orange],
    ['JDM + FEEL', '决策图 + S-FEEL', P.magenta],
  ]
  const cols = 3, gap = 16, tw = (w - (cols - 1) * gap) / cols, th = 74, y0 = 74
  tiles.forEach((t, i) => {
    const cx = x + (i % cols) * (tw + gap), cy = y0 + Math.floor(i / cols) * (th + 14)
    b += R(cx, cy, tw, th, { rx: 12, fill: P.surface, stroke: P.border, sw: 1 })
    b += R(cx, cy, tw, 4, { rx: 2, fill: t[2] })
    b += T(cx + tw / 2, cy + 42, t[0], { size: 24, w: 800, anchor: 'middle', fill: t[2], mono: true })
    b += T(cx + tw / 2, cy + 62, t[1], { size: 11, w: 600, anchor: 'middle', fill: P.ink2 })
  })
  const chy = 252
  const diff = ['无 GC · 单二进制', '决策图可视设计器', '决策表设计器', 'FEEL 判定 + Rhai 副作用', '仿真台 + 归因', 'gap/overlap 分析', 'db-per-tenant', '可嵌 @cmx/decision-graph', 'Headless v1 + OpenAPI', '一体化平台·第五元 RULE']
  b += T(x, chy + 16, '差异化亮点：', { size: 11.5, w: 800, fill: P.ink2 })
  b += chipFlow(x + 84, chy, x + w, diff, P.blue, { size: 10.5 }).svg
  return doc(W, H, b)
}

// ══════════════ 图·架构总览「一芯多壳」 ══════════════
function figArch () {
  const W = 940, H = 500
  const x = 40, w = W - 80
  let b = titleBlk(W, '总体架构 · 一芯多壳（One Core, Multi-Shell）',
    '6 crate · 5,642 域 LOC（~2,405 测试）· edition 2024 · 工具链 1.97.1 · Apache-2.0 · 无状态同步引擎 · 语义中立内核可 wasm/嵌入')
  const shW = (w - 2 * 16) / 3
  b += cell(x, 74, shW, 46, P.violet, '① 独立 server bin', 'cmx-rule-server · :8094')
  b += cell(x + shW + 16, 74, shW, 46, P.violet, '② 平台反代壳', 'cmx-rule-api · 门户内嵌')
  b += cell(x + 2 * (shW + 16), 74, shW, 46, P.violet, '③ 可嵌 Web Component', 'rule-designer/logs/simulator')
  b += LINE(W / 2, 120, W / 2, 140)
  b += band(x, 142, w, 50, P.blue, 'cmx-rule-app · 平台中立应用核',
    'rule_routes::<S>() 泛型路由 + 32 handler + store 单例 + 租户/认证 + OpenAPI + 大盘', '1,136')
  b += LINE(W / 2, 192, W / 2, 208)
  b += band(x, 210, w, 48, P.aqua, 'cmx-rule-engine · 求值内核',
    '逐行 unary test → 11 命中策略裁决 → 逐节点 trace + 失败归因 · 决策图拓扑求值(Kahn) + 子决策递归 · gap/overlap 分析', '1,167')
  b += LINE(W / 2, 258, W / 2, 276)
  b += band(x, 278, w, 48, P.orange, 'cmx-rule-feel · FEEL 表达式引擎',
    'S-FEEL 一元测试子集（比较/区间/列表/取反/字面量）+ Rhai 脚本沙箱（SC0 · =rhai: 前缀 · 无 IO/时钟/随机）', '1,749')
  b += LINE(W / 2, 326, W / 2, 344)
  b += band(x, 346, w, 48, P.violet, 'cmx-rule-model · 语义中立内核（IR + 决策图 + eval 上下文/trace + DecisionStore 契约）',
    '决策表 IR（11 策略）· 决策图 · gap/overlap 类型 · 无 DB/infra 依赖 · 可 wasm/嵌入（leaf）', '771')
  b += R(x, 410, w, 74, { rx: 10, fill: P.plane, stroke: P.border, sw: 1 })
  b += T(x + 16, 431, '持久化 cmx-rule-store-pg（681）→ PgDecisionStore：6 表 definition / release / decision_log / test_case / script_function / category —— 无运行态表（无状态引擎）。', { size: 10.5, w: 700, fill: P.ink2 })
  b += T(x + 16, 450, '单向借用基础库：cmx-database-pg · cmx-core · cmx-web-chassis · cmx-web-monitor · cmx-service-base', { size: 10.5, fill: P.muted, mono: true })
  b += T(x + 16, 468, '2 注入 trait：DecisionStore（→ PgDecisionStore）· DecisionResolver（子决策递归，MAX_DEPTH=8，NoResolver/MapResolver）', { size: 10.5, fill: P.muted })
  return doc(W, H, b)
}

// ══════════════ 图·与主流开源决策/规则引擎全维度对比（中心图）══════════════
function figCompare () {
  const engines = [
    ['cmx-rulesengine', 'Rust · Apache-2.0', true],
    ['GoRules Zen', 'Rust · MIT', false],
    ['Drools / KIE', 'Java · Apache-2.0', false],
    ['Camunda DMN', 'Java · Apache*', false],
    ['OpenL Tablets', 'Java · LGPL', false],
  ]
  const rows = [
    ['语言 / 运行时', [['Rust', 'neu'], ['Rust', 'neu'], ['Java/JVM', 'neu'], ['Java/JVM', 'neu'], ['Java/JVM', 'neu']]],
    ['模型 / 范式', [['JDM 图 + 表', 'neu'], ['JDM 图 + 表', 'neu'], ['RETE + DRL', 'neu'], ['DMN 标准', 'neu'], ['Excel 决策表', 'neu']]],
    ['表达式语言', [['自研 S-FEEL', 'neu'], ['ZEN 表达式', 'neu'], ['DRL / MVEL', 'neu'], ['FEEL(完整)', 'neu'], ['语法 / Java', 'neu']]],
    ['决策表 + 命中策略', [['11 策略', 'ok'], ['多策略', 'ok'], ['✓ 决策表', 'ok'], ['✓ DMN', 'ok'], ['✓ Excel', 'ok']]],
    ['决策图 DAG 编排', [['✓ 拓扑 + 防环', 'ok'], ['✓ JDM 图', 'ok'], ['规则集 / DRD', 'warn'], ['DRD', 'ok'], ['–', 'no']]],
    ['DMN 标准合规', [['S-FEEL 子集', 'warn'], ['支持 DMN', 'ok'], ['完整 Level 3', 'ok'], ['完整 DMN', 'ok'], ['部分', 'warn']]],
    ['产生式推理 (RETE)', [['–', 'no'], ['–', 'no'], ['✓ 前/后向链', 'ok'], ['–', 'no'], ['–', 'no']]],
    ['可解释 trace / 归因', [['✓ 逐节点归因', 'ok'], ['✓ trace', 'ok'], ['✓', 'ok'], ['✓', 'ok'], ['部分', 'warn']]],
    ['仿真 / 测试台', [['✓ 归因+用例+diff', 'ok'], ['编辑器 simulator', 'ok'], ['Workbench', 'ok'], ['有', 'warn'], ['WebStudio', 'warn']]],
    ['设计器（内置）', [['决策表 + 图·内置', 'ok'], ['JDM Editor(React)', 'ok'], ['Business Central', 'ok'], ['Camunda Modeler', 'ok'], ['Excel + WebStudio', 'ok']]],
    ['脚本扩展', [['Rhai 沙箱', 'ok'], ['表达式 / 函数', 'warn'], ['Java / MVEL', 'ok'], ['FEEL / Java', 'warn'], ['Java', 'warn']]],
    ['多租户', [['db-per-tenant', 'ok'], ['库(宿主)', 'neu'], ['宿主 / KIE', 'warn'], ['平台级', 'warn'], ['宿主', 'warn']]],
    ['部署 / 可嵌形态 ★', [['库/服务/组件/headless', 'ok'], ['库 + 编辑器组件', 'warn'], ['库 + Workbench', 'warn'], ['平台内嵌', 'warn'], ['服务 / WebStudio', 'warn']]],
    ['多语言 SDK', [['REST + WC', 'warn'], ['✓ 8+ 语言绑定', 'ok'], ['JVM', 'neu'], ['JVM / REST', 'neu'], ['JVM', 'neu']]],
    ['许可 / 开放性 ★', [['Apache-2.0 无限制', 'ok'], ['MIT', 'ok'], ['Apache-2.0', 'ok'], ['源码可得 / EOL', 'warn'], ['LGPL', 'ok']]],
  ]
  const W = 1060, x0 = 30, dimW = 148, ew = (W - 2 * x0 - dimW) / 5
  const headY = 74, headH = 52, rowH = 33, y0 = headY + headH + 5
  const H = y0 + rows.length * rowH + 50
  let b = titleBlk(W, '与主流开源决策 / 规则引擎 · 全维度对比',
    'cmx-rulesengine 当前能力 vs GoRules Zen / Drools·KIE / Camunda DMN / OpenL Tablets　·　★ = cmx 差异化项')
  engines.forEach((e, i) => {
    const cx = x0 + dimW + i * ew
    const acc = e[2] ? P.blue : P.base
    b += R(cx + 2, headY, ew - 4, headH, { rx: 8, fill: acc, fop: e[2] ? 0.16 : 0.08, stroke: acc, sop: e[2] ? 0.44 : 0.22, sw: e[2] ? 1.5 : 1 })
    b += T(cx + ew / 2, headY + 22, e[0], { size: 12.5, w: 800, anchor: 'middle', fill: e[2] ? P.blue550 : P.ink })
    b += T(cx + ew / 2, headY + 40, e[1], { size: 9.5, anchor: 'middle', fill: P.ink2 })
  })
  b += T(x0 + dimW / 2, headY + 30, '对比维度', { size: 11.5, w: 800, anchor: 'middle', fill: P.ink2 })
  const gTint = { ok: P.good, warn: P.warning, no: P.muted }
  rows.forEach((r, ri) => {
    const ry = y0 + ri * rowH
    b += R(x0, ry, dimW, rowH - 3, { rx: 6, fill: P.plane, stroke: P.border, sw: 1 })
    b += T(x0 + 10, ry + rowH / 2 + 2, r[0], { size: 10.5, w: 700, fill: P.ink })
    r[1].forEach(([txt, g], ci) => {
      const cx = x0 + dimW + ci * ew
      const isCmx = ci === 0
      if (g === 'neu') {
        b += R(cx + 2, ry, ew - 4, rowH - 3, { rx: 6, fill: isCmx ? P.blue : P.plane, fop: isCmx ? 0.05 : 1, stroke: P.border, sw: 1 })
        b += T(cx + ew / 2, ry + rowH / 2 + 2, txt, { size: 10, anchor: 'middle', fill: P.ink2 })
      } else {
        const hue = gTint[g]
        b += R(cx + 2, ry, ew - 4, rowH - 3, { rx: 6, fill: hue, fop: g === 'no' ? 0.07 : 0.14, stroke: hue, sop: g === 'no' ? 0.28 : 0.36, sw: 1 })
        b += R(cx + 2, ry, 3, rowH - 3, { rx: 1.5, fill: hue })
        b += T(cx + ew / 2 + 2, ry + rowH / 2 + 2, txt, { size: 10, w: g === 'no' ? 400 : 600, anchor: 'middle', fill: g === 'no' ? P.ink2 : P.ink })
      }
    })
  })
  const ly = y0 + rows.length * rowH + 10
  b += R(x0, ly, W - 2 * x0, 30, { rx: 8, fill: P.plane, stroke: P.border, sw: 1 })
  b += T(x0 + 14, ly + 19, '图例：', { size: 10.5, w: 700, fill: P.ink2 })
  let lx = x0 + 58
  ;[['强 / 完整', 'ok'], ['部分 / 受限', 'warn'], ['弱 / 无', 'no'], ['中性事实', 'neu']].forEach(([lab, g]) => {
    const hue = g === 'neu' ? P.base : gTint[g]
    b += R(lx, ly + 7, 15, 15, { rx: 4, fill: hue, fop: g === 'no' ? 0.1 : 0.16, stroke: hue, sop: 0.4, sw: 1 })
    b += T(lx + 21, ly + 19, lab, { size: 10.5, fill: P.ink2 }); lx += 34 + wOf(lab, 10.5)
  })
  return doc(W, H, b)
}

// ══════════════ 图·许可与开放性格局 ══════════════
function figOpenness () {
  const W = 940, H = 406
  const x = 40, w = W - 80
  const pw = (w - 16) / 2
  let b = titleBlk(W, '许可与开放性格局（Licensing & Openness）',
    '开源决策引擎的可持续性差异 —— OSI 真开源 vs 商业/SaaS vs 随平台受限')
  const litem = (px, py, name, note, star) => {
    let s = T(px, py, (star ? '★ ' : '') + name, { size: 12.5, w: 800, fill: star ? P.green : P.ink })
    s += T(px, py + 16, note, { size: 10, fill: P.ink2 })
    return s
  }
  let py = 74
  b += R(x, py, pw, 304, { rx: 12, fill: P.green, fop: 0.08, stroke: P.green, sop: 0.30, sw: 1.2 })
  b += R(x, py, pw, 4, { rx: 2, fill: P.green })
  b += T(x + 18, py + 28, '① 自由开源 · 自托管生产免费', { size: 13.5, w: 800, fill: P.green })
  b += T(x + 18, py + 46, 'OSI 批准许可 · 可商用 · 可魔改 · 无生产许可门槛', { size: 10.5, fill: P.ink2 })
  const L = [
    ['cmx-rulesengine', 'Apache-2.0 · 一体化微服务(设计器/仿真/审计/多租户/headless 全内置)', true],
    ['GoRules Zen', 'MIT · Rust 引擎 + React 编辑器全开源（商业 BRMS 另售）', false],
    ['Drools / KIE / Kogito', 'Apache-2.0 · Java · 完整 DMN L3 + RETE', false],
    ['OpenL Tablets', 'LGPL · Excel 决策表 + WebStudio', false],
    ['json-rules-engine / easy-rules', 'ISC / MIT · 轻量 JS / Java', false],
  ]
  L.forEach((it, i) => { b += litem(x + 20, py + 84 + i * 42, it[0], it[1], it[2]) })
  const rx = x + pw + 16
  b += R(rx, py, pw, 304, { rx: 12, fill: P.warning, fop: 0.09, stroke: P.warning, sop: 0.34, sw: 1.2 })
  b += R(rx, py, pw, 4, { rx: 2, fill: P.warning })
  b += T(rx + 18, py + 28, '② 商业 / SaaS / 随平台受限', { size: 13.5, w: 800, fill: P.serious })
  b += T(rx + 18, py + 46, '自托管/长期可持续前须评估许可与生命周期', { size: 10.5, fill: P.ink2 })
  b += R(rx + 16, py + 66, pw - 32, 96, { rx: 9, fill: P.warning, fop: 0.10, stroke: P.warning, sop: 0.30, sw: 1 })
  b += T(rx + 30, py + 90, 'Camunda DMN（随 Camunda 平台）', { size: 12, w: 800, fill: P.serious })
  b += T(rx + 30, py + 110, 'Camunda 7 CE：Apache-2.0，但 2025-10 已 EOL', { size: 10, fill: P.ink2 })
  b += T(rx + 30, py + 126, 'Camunda 8 DMN：源码可得，8.6+ 生产需付费许可', { size: 10, fill: P.ink2 })
  b += T(rx + 30, py + 142, 'FEEL 完整、DMN 标准合规强，但绑定其平台', { size: 10, fill: P.muted })
  b += R(rx + 16, py + 172, pw - 32, 96, { rx: 9, fill: P.critical, fop: 0.06, stroke: P.critical, sop: 0.26, sw: 1 })
  b += T(rx + 30, py + 196, 'IBM ODM · DecisionRules · Nected', { size: 12, w: 800, fill: P.critical })
  b += T(rx + 30, py + 216, '商业 BRMS / 闭源 / SaaS（按坐席或用量计费）', { size: 10, fill: P.ink2 })
  b += T(rx + 30, py + 232, '功能全、治理强，但非开源、供应商锁定', { size: 10, fill: P.ink2 })
  b += T(rx + 30, py + 248, '“许可 $0 ≠ 拥有成本 $0”—— 决策逻辑自持 vs 外购', { size: 10, fill: P.muted })
  return doc(W, H, b)
}

// ══════════════ 图·决策模型与求值语义 ══════════════
function figModel () {
  const W = 940, H = 574
  const x = 40, w = W - 80
  let b = titleBlk(W, '决策模型与求值语义 · 图优先 JDM + FEEL',
    'DAG 拓扑序（Kahn）· 上下文左→右累积 · 决策表 11 命中策略 · 纯 FEEL 判定 + Rhai 副作用 · 逐节点失败归因')
  const nodes = [['input', '事实入口'], ['output', '结果快照'], ['decisionTable', '11 策略'], ['expression', 'FEEL 映射'], ['decision', '子决策 ≤8'], ['script', 'Rhai SC1']]
  const ncw = (w - 5 * 10) / 6
  nodes.forEach((n, i) => { b += cell(x + i * (ncw + 10), 74, ncw, 46, i === 5 ? P.magenta : P.aqua, n[0], n[1]) })
  b += LINE(W / 2, 120, W / 2, 136)
  b += R(x, 138, w, 52, { rx: 10, fill: P.blue, fop: 0.12, stroke: P.blue, sop: 0.34, sw: 1 })
  b += R(x, 138, 4, 52, { rx: 2, fill: P.blue })
  b += T(x + 18, 162, 'evaluate_graph · Kahn 拓扑序求值（防环）', { size: 13.5, w: 800 })
  b += T(x + 18, 181, '校验 → 拓扑排序（order.len≠n → 报「决策图存在环」）→ 按序求值 · 上下文 merge 左→右累积 → output 快照 + 逐节点 TraceNode', { size: 10.5, fill: P.ink2 })
  let y = 204
  b += R(x, y, w, 96, { rx: 10, fill: P.orange, fop: 0.09, stroke: P.orange, sop: 0.28, sw: 1 })
  b += R(x, y, 4, 96, { rx: 2, fill: P.orange })
  b += T(x + 16, y + 22, '决策表 · 11 DMN 命中策略（输入格 = 纯 FEEL 一元测试 · 输出格 = FEEL 或 =rhai:）', { size: 12, w: 800 })
  const hp = ['U 唯一', 'A 任一', 'P 优先*', 'F 首命中', 'C 收集', 'R 规则序', 'O 输出序*', 'C+ 求和', 'C< 最小', 'C> 最大', 'C# 计数']
  b += chipFlow(x + 16, y + 32, x + w - 16, hp, P.orange, { size: 10.5 }).svg
  b += T(x + 16, y + 88, '* Priority / OutputOrder 当前降级为首命中（R1 优先级列表待补）· C+/C</C> 需单一数值输出列', { size: 9.5, fill: P.muted })
  y = 312
  b += R(x, y, w, 104, { rx: 10, fill: P.green, fop: 0.08, stroke: P.green, sop: 0.28, sw: 1 })
  b += R(x, y, 4, 104, { rx: 2, fill: P.green })
  b += T(x + 16, y + 22, 'cmx-rule-feel · 自研 Pratt FEEL 引擎（S-FEEL 一元测试 over 全 FEEL 表达式 · 25 内建）', { size: 12, w: 800 })
  const ff = ['数/串/布尔/null/列表', '算术 + - * / **', '比较', 'and/or/not', 'if/then/else', 'for…return', 'some/every', '区间 [a..b]', 'in 成员', '过滤 l[p]', '点式路径', '25 内建函数']
  b += chipFlow(x + 16, y + 32, x + w - 16, ff, P.green, { size: 10.5 }).svg
  b += T(x + 16, y + 96, '缺（vs 完整 DMN FEEL）：时间/日期/时段类型 · 上下文字面量 {a:1} · 自定义 FEEL 函数 · 正则/统计内建 · Decimal128（用 f64）', { size: 9.5, fill: P.muted })
  y = 428
  const rw = (w - 14) / 2
  b += R(x, y, rw, 62, { rx: 10, fill: P.aqua, fop: 0.10, stroke: P.aqua, sop: 0.30, sw: 1 }); b += R(x, y, 4, 62, { rx: 2, fill: P.aqua })
  b += T(x + 16, y + 22, '可解释 · 逐节点归因（超越 ZEN）', { size: 12, w: 800 })
  b += T(x + 16, y + 40, '每节点 TraceNode{matched_rules, input, output, timing_us, failure}', { size: 10, fill: P.ink2 })
  b += T(x + 16, y + 55, '精确到 规则行 / 输入列 / 表达式 + Rhai 行号 · 落 DecisionLog 审计', { size: 10, fill: P.muted })
  const r2 = x + rw + 14
  b += R(r2, y, rw, 62, { rx: 10, fill: P.violet, fop: 0.10, stroke: P.violet, sop: 0.30, sw: 1 }); b += R(r2, y, 4, 62, { rx: 2, fill: P.violet })
  b += T(r2 + 16, y + 22, '完备性 · gap / overlap 分析（超越 ZEN）', { size: 12, w: 800 })
  b += T(r2 + 16, y + 40, 'overlap = 结构化 Constraint 两两区间求交', { size: 10, fill: P.ink2 })
  b += T(r2 + 16, y + 55, 'gap = 边界分段笛卡尔积代表点回代真匹配器', { size: 10, fill: P.muted })
  y = 502
  b += R(x, y, w, 56, { rx: 10, fill: P.magenta, fop: 0.09, stroke: P.magenta, sop: 0.28, sw: 1 }); b += R(x, y, 4, 56, { rx: 2, fill: P.magenta })
  b += T(x + 16, y + 22, 'Rhai 脚本四载体 · 判定侧永远 FEEL（保 gap/overlap 分析有效）', { size: 12, w: 800 })
  b += T(x + 16, y + 41, '脚本节点 · 脚本格 =rhai: · 函数库(发布·线程本地 RAII) · 脚本决策(整体) —— 沙箱 max_ops=10万 · 无 IO/时钟/随机 · 整数归一 f64', { size: 10, fill: P.ink2 })
  return doc(W, H, b)
}

// ══════════════ 图·企业/平台能力全景 ══════════════
function figFeatures () {
  const W = 940
  const x = 40, w = W - 80
  const cols = [
    ['设计态 · 前端', P.violet, ['决策表设计器(11 策略)', '格内 FEEL + fx 向导', '决策图可视设计器(SVG DAG)', '防环 wouldCycle/Kahn', '@cmx/decision-graph 组件', '仿真台 + 归因', '测试用例 + 套件 diff', '审计中心(decision_log)', '分类分组 category', 'explorer 查找/刷新/分页']],
    ['运行时 · API', P.blue, ['发布 / 版本 / 激活', 'simulate 仿真', 'gap / overlap 分析', 'Headless /rules/v1', 'SSE 事件流', 'OpenAPI + Swagger', 'API-Key / JWT / off', 'db-per-tenant 多租户', '决策日志落库']],
    ['集成 · 场景', P.aqua, ['native-pages(cmx-form::serve)', '门户反代 + center_client', 'Nacos 自注册', '单据转凭证(P1/P2)', 'Collect 分录 + 科目表', '财务风控双案例', 'Rhai SC0–SC4', 'metaKind 第五元 RULE', 'flow businessRuleTask 调用']],
  ]
  const cw = (w - 2 * 16) / 3
  let maxH = 0, body = ''
  cols.forEach(([name, hue, items], ci) => {
    const cx = x + ci * (cw + 16)
    body += R(cx, 74, cw, 40, { rx: 9, fill: hue, fop: 0.14, stroke: hue, sop: 0.34, sw: 1 })
    body += T(cx + cw / 2, 74 + 25, name, { size: 13, w: 800, anchor: 'middle' })
    const f = chipFlow(cx + 8, 126, cx + cw - 4, items, hue, { size: 10.5, lh: 27 })
    body += f.svg
    maxH = Math.max(maxH, 126 + f.height)
  })
  const H = maxH + 58
  let b = titleBlk(W, '企业 / 平台能力全景', '设计态/前端 · 运行时/API · 集成/场景 —— 均已实现，多数含单测 + 后端回归 / CDP 验证')
  b += body
  b += R(x, maxH + 8, w, 34, { rx: 9, fill: P.plane, stroke: P.border, sw: 1 })
  b += T(x + 16, maxH + 30, 'cmx-rule-app 为 JSON-API-only 后端；静态页由 cmx-form::serve 投递、门户 F3 反代；一芯多壳与 flowengine 同盘。', { size: 11, fill: P.ink2 })
  return doc(W, H, b)
}

// ══════════════ 图·部署姿态 ══════════════
function figDeploy () {
  const W = 920, H = 428
  let b = titleBlk(W, '部署姿态 · 同一引擎核', '无状态同步·微秒级求值；JSON-API-only 后端（静态页由 cmx-form::serve 投递）；门户纯 HTTP 反代')
  const box = (x, y, w, h, hue, t, s) => cell(x, y, w, h, hue, t, s)
  const lane = (y, tag, tagHue) => { b += R(30, y, 96, 58, { rx: 9, fill: tagHue, fop: 0.14, stroke: tagHue, sop: 0.34, sw: 1 }); b += T(78, y + 26, tag.split('|')[0], { size: 12.5, w: 800, anchor: 'middle' }); b += T(78, y + 43, tag.split('|')[1], { size: 10.5, fill: P.ink2, anchor: 'middle' }) }
  let y = 78; lane(y, '① 独立|微服务', P.violet)
  b += box(150, y, 176, 58, P.blue, '门户 Portal', ':8080')
  b += LINE(326, y + 29, 396, y + 29); b += T(361, y + 20, 'RuleProxy', { size: 10, fill: P.muted, anchor: 'middle' }); b += T(361, y + 46, '/api/rules/*', { size: 9.5, fill: P.muted, anchor: 'middle', mono: true })
  b += box(398, y, 176, 58, P.aqua, 'rule-server', 'cmx-rule-server · :8094')
  b += LINE(574, y + 29, 644, y + 29); b += T(609, y + 20, 'db-per-tenant', { size: 10, fill: P.muted, anchor: 'middle' })
  b += box(646, y, 234, 58, P.orange, 'PostgreSQL', '6 表 · 无运行态')
  y = 168; lane(y, '② 可嵌|组件', P.magenta)
  b += box(150, y, 210, 58, P.green, '宿主 App', 'React / Vue / 原生')
  b += LINE(360, y + 29, 452, y + 29); b += T(406, y + 20, '<rule-designer>', { size: 9.5, fill: P.muted, anchor: 'middle', mono: true }); b += T(406, y + 46, '<cmx-decision-graph>', { size: 9, fill: P.muted, anchor: 'middle', mono: true })
  b += box(454, y, 426, 58, P.aqua, 'rule-server v1 API', '自定义元素直连 /api/rules/v1/*')
  y = 258; lane(y, '③ Headless|库 / 嵌入', P.blue)
  b += box(150, y, 210, 58, P.violet, '自建系统 / 嵌入', 'REST · 或 库/wasm 内存态')
  b += LINE(360, y + 29, 452, y + 29); b += T(406, y + 21, 'REST + SSE', { size: 9.5, fill: P.muted, anchor: 'middle' }); b += T(406, y + 46, 'OpenAPI · µs 同步', { size: 9.5, fill: P.muted, anchor: 'middle' })
  b += box(454, y, 426, 58, P.aqua, '/api/rules/v1/* · /docs · 或 flow businessRuleTask', 'model+engine+feel 内存态同步求值(无 DB)')
  b += R(30, 336, W - 60, 64, { rx: 10, fill: P.plane, stroke: P.border, sw: 1 })
  b += T(46, 358, '无状态同步引擎：无令牌/任务/定时器/poller/运行态表——每次求值 µs 级、无副作用，水平扩展 = 多副本 + 负载均衡（对比 flowengine 的持久化令牌引擎）。', { size: 11, fill: P.ink2 })
  b += T(46, 378, '三层出站鉴权：X-API-Key（服务身份）+ X-User / JWT（真实调用者）+ 租户；库/wasm 姿态可被 flowengine 的 businessRuleTask 直接内嵌调用。', { size: 11, fill: P.muted })
  return doc(W, H, b)
}

// ══════════════ 图·测试与质量 ══════════════
function figTests () {
  const W = 940, H = 428
  let b = titleBlk(W, '测试与质量 · 真机验证', 'Rust 单测 + 后端 curl 回归 + 脚本能力 + Playwright/CDP 前端 + 单据转凭证 E2E（口径为当前实测/文档）')
  const tiles = [
    ['63', 'Rust 单测 · 0 失败/0 ignored', 'feel35 / engine24 / model4'],
    ['146', '后端回归断言', 'qa-backend-1/2.sh (98+48)'],
    ['55/55', '脚本能力 SC0–SC4', 'qa-script.sh'],
    ['11/11', '数据保留 E2E', 'e2e-script-preserve.sh'],
    ['13/13', '单据转凭证 P1', 'p1/run.mjs · Collect 分录'],
    ['16/16', '单据转凭证 P2', 'p2/run.mjs · cv_* 装配'],
    ['13/13', '11 命中策略组', 'hit-policy group'],
    ['~20', '决策图组件 CDP', 'decision_graph_component.cjs'],
    ['~12', '分类分组 CDP', 'category_grouping.cjs'],
    ['209/209', '脚本能力报告全绿', '单测 63 + 后端 146'],
    ['0', 'clippy 告警', '--all-targets'],
    ['µs 级', '无状态同步求值', 'stateless · 无 poller'],
  ]
  const cols = 4, gap = 16, x0 = 40, tw = (W - 80 - (cols - 1) * gap) / cols, th = 96, y0 = 78
  tiles.forEach((t, i) => {
    const cx = x0 + (i % cols) * (tw + gap), cy = y0 + Math.floor(i / cols) * (th + 16)
    b += R(cx, cy, tw, th, { rx: 12, fill: P.surface, stroke: P.border, sw: 1 })
    b += R(cx, cy, tw, 4, { rx: 2, fill: P.good })
    b += `<circle cx="${cx + 16}" cy="${cy + 26}" r="7" fill="${P.good}" fill-opacity="0.15"/><path d="M${cx + 12.5},${cy + 26} l2.5,2.5 l5,-5.5" stroke="${P.good}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    b += T(cx + tw / 2 + 8, cy + 48, t[0], { size: 25, w: 800, anchor: 'middle', fill: P.good, mono: true })
    b += T(cx + tw / 2, cy + 68, t[1], { size: 11, w: 700, anchor: 'middle', fill: P.ink })
    b += T(cx + tw / 2, cy + 85, t[2], { size: 9, anchor: 'middle', fill: P.muted, mono: true })
  })
  return doc(W, H, b)
}

// ══════════════ 图·能力演进时间线 ══════════════
function figTimeline () {
  const W = 980
  const tracks = [
    ['引擎核心', 'R0–R7', P.blue, ['R0 表求值+骨架', 'R1 S-FEEL + gap/overlap', 'R2 JDM 图 + 导入导出', 'R3 多租户 + JWT', 'R4 headless + OpenAPI', 'R5 前端一芯三壳', 'R6 平台反代', 'R7+ Rete/全FEEL(规划)']],
    ['FEEL 引擎', 'R1 · CL2', P.orange, ['Pratt 分词/解析', '一元测试 S-FEEL', '算术/比较/逻辑', 'if/for/some/every', '区间/in/过滤', '25 内建', 'contains 递归 bug 修', 'f64 语义修 BUG-001/002']],
    ['决策图 JDM', 'R2', P.aqua, ['6 节点类型', 'Kahn 拓扑 + 防环', '子决策递归 ≤8', 'DecisionResolver 预取', 'gap/overlap 分析', '逐节点 trace 归因']],
    ['脚本能力', 'SC0–SC4', P.magenta, ['SC0 Rhai 接缝', 'SC1 脚本节点', 'SC2 脚本格 =rhai:', 'SC3 函数库', 'SC4 脚本决策', '沙箱 max_ops', '判定侧永远 FEEL']],
    ['前端', 'F1–F5', P.yellow, ['F1 发布/版本', 'F2 决策表设计器', 'F3 决策图设计器', 'F4 仿真台', 'F5 审计中心', '分类分组', 'explorer 查找/分页', '@cmx/decision-graph 组件']],
    ['业务落地', '', P.green, ['单据转凭证 P0/P1/P2', 'Collect 分录模板', '科目表 Unique 定科目', 'cv_* 四层装配', '财务风控双案例', '费用报销图', '反洗钱 Collect']],
  ]
  const x0 = 156, maxX = W - 34
  let rows = '', y = 78
  for (const [name, code, hue, items] of tracks) {
    const f = chipFlow(x0, y, maxX, items, hue, { size: 11, lh: 28 })
    const rowH = f.height
    rows += R(28, y - 4, 116, rowH - 4, { rx: 9, fill: hue, fop: 0.10, stroke: hue, sop: 0.30, sw: 1 })
    rows += R(28, y - 4, 4, rowH - 4, { rx: 2, fill: hue })
    rows += T(44, y + 14, name, { size: 12.5, w: 800 })
    if (code) rows += T(44, y + 31, code, { size: 10, fill: P.muted, mono: true })
    rows += f.svg
    y += rowH + 8
  }
  const H = y + 42
  let b = titleBlk(W, '能力演进时间线 · 六条能力轨', 'R0–R3 后端 + F1–F5 前端 + SC0–SC4 脚本 均已交付并回归通过（里程碑代号取自源码/测试文件命名）')
  b += rows
  b += R(28, y + 2, W - 56, 30, { rx: 9, fill: P.plane, stroke: P.border, sw: 1 })
  b += T(44, y + 22, 'R 引擎(↔flow S0–S6) · SC 脚本 · F 前端 · 业务落地 —— 全部已交付并纳入回归（63 单测 + 后端/脚本/CDP/单据转凭证 E2E 全绿）。R7+ Rete/全FEEL 为规划。', { size: 11, fill: P.ink2 })
  return doc(W, H, b)
}

// ══════════════ 图·路线图 Now/Next/Later ══════════════
function figRoadmap () {
  const W = 940
  const x = 40, w = W - 80
  const cols = [
    ['Now · 已交付并测试', P.green, ['决策表 11 命中策略', 'JDM 决策图 + 拓扑防环', '自研 S-FEEL(25 内建)', 'gap/overlap 完备性分析', '逐节点 trace 归因', 'Rhai 四载体沙箱', '多租户 db-per-tenant', 'Headless v1 + SSE + OpenAPI', '决策表 + 决策图设计器', '仿真台 + 审计中心', '单据转凭证 P1/P2', '财务风控双案例']],
    ['Next · 标准完整度', P.blue, ['全 FEEL CL3(时间/上下文/自定义函数)', 'Priority/OutputOrder 优先级列表', 'DMN 1.x 导入导出对齐', '决策日志 TTL / 归档', '更多脚本载体治理']],
    ['Later · 世界级 · 择机', P.violet, ['Rete/前向链推理节点', 'Switch 节点', 'dsntk-rs 全 FEEL 集成(评估)', 'Decimal128 精确数', 'PMML / 评分卡', '更多语言 SDK']],
  ]
  const cw = (w - 2 * 16) / 3
  let maxH = 0, body = ''
  cols.forEach(([name, hue, items], ci) => {
    const cx = x + ci * (cw + 16)
    body += R(cx, 74, cw, 40, { rx: 9, fill: hue, fop: 0.14, stroke: hue, sop: 0.34, sw: 1 })
    body += T(cx + cw / 2, 74 + 25, name, { size: 12.5, w: 800, anchor: 'middle' })
    const f = chipFlow(cx + 8, 126, cx + cw - 4, items, hue, { size: 10.5, lh: 27 })
    body += f.svg
    maxH = Math.max(maxH, 126 + f.height)
  })
  const H = maxH + 64
  let b = titleBlk(W, '路线图 · Now / Next / Later', '图优先多范式、Rete 后置可选 · 标准优先(不自造方言) · 判定侧永远 FEEL')
  b += body
  b += R(x, maxH + 8, w, 40, { rx: 9, fill: P.plane, stroke: P.border, sw: 1 })
  b += T(x + 16, maxH + 26, '把「决策表 + 决策图 + 可解释 + 完备性」做透并生产可靠，而非盲目追全 DMN/Rete 广度；企业高频决策以决策表/序列求值为主，Rete 后置可选。', { size: 11, fill: P.ink2 })
  b += T(x + 16, maxH + 41, 'Now 全部已交付并经真机测试；Next / Later 为规划项，非承诺排期。', { size: 10, fill: P.muted })
  return doc(W, H, b)
}

const FIGS = {
  'fig-overview': figOverview, 'fig-arch': figArch, 'fig-model': figModel, 'fig-features': figFeatures,
  'fig-deploy': figDeploy, 'fig-compare': figCompare, 'fig-openness': figOpenness,
  'fig-tests': figTests, 'fig-timeline': figTimeline, 'fig-roadmap': figRoadmap,
}

function main () {
  for (const [k, fn] of Object.entries(FIGS)) {
    const svg = fn()
    writeFileSync(join(DIR, `${k}.svg`), svg)
    console.log(`wrote ${k}.svg (${(svg.length / 1024).toFixed(1)} KiB)`)
  }
}
main()
