// P1 · 单据适配器（记账事件契约的声明式映射解释器 + 凭证组装器）。
//
// 设计：任意业务单据（DOC 分层 header+lines，即 `GET /api/doc/data/*` 返回形状）→ 统一「记账事件契约」。
//   每类单据一份**声明式映射规范**（specs/*.json），本解释器逐字段投影——**新增单据 = 加一份 spec，零改码**。
//   本文件是**参考实现（语言无关的 spec 才是真正交付物）**，可原样移植到 Rust（cmx-gl-model）解释器。
//   记账「判定」（科目/借贷/金额派生）仍归规则引擎决策表——适配器只做数据规整（拉字段/迭代行/预聚合），
//   两者分工清晰：适配器=plumbing，决策表=judgment（judgment 才能被 gap/overlap 完整性分析）。

// 点路径取值：get(obj, "header.supplierId") / get(line, "netAmount")。缺失→undefined。
export function get (obj, path) {
  if (obj == null || !path) return undefined
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

// 解析一个映射值：字符串=点路径；{const:x}=常量；{path,default}=带兜底。
function resolve (raw, v) {
  if (v && typeof v === 'object') {
    if ('const' in v) return v.const
    if ('path' in v) { const r = get(raw, v.path); return r === undefined ? v.default : r }
  }
  return get(raw, v)
}

// 单条聚合：sum(over 数组 的 amount 字段，可 where 过滤) 或 add(of 若干已算聚合名)。
function aggregate (event, spec, key) {
  if (spec.op === 'add') return (spec.of || []).reduce((s, k) => s + (Number(event.amounts[k]) || 0), 0)
  if (spec.op === 'sum') {
    const arr = event[spec.over] || []
    return arr.reduce((s, row) => {
      if (spec.where) { for (const [k, val] of Object.entries(spec.where)) if (row[k] !== val) return s }
      return s + (Number(get(row, spec.amount)) || 0)
    }, 0)
  }
  if (spec.op === 'const') return spec.value
  return 0
}

/** 任意单据 JSON + 映射规范 → 记账事件契约。 */
export function toAccountingEvent (raw, spec) {
  const event = { docType: spec.docType, bizEvent: spec.bizEvent }
  // 顶层字段（compUnit/postingDate/period/currency…）
  for (const [k, v] of Object.entries(spec.top || {})) event[k] = resolve(raw, v)
  // header 子对象（summary/供应商/单号…）
  event.header = {}
  for (const [k, v] of Object.entries(spec.header || {})) event.header[k] = resolve(raw, v)
  // 明细行迭代
  const src = get(raw, (spec.lines && spec.lines.from) || 'lines') || []
  event.lines = src.map((ln, i) => {
    const out = { lineNo: i + 1 }
    for (const [k, v] of Object.entries((spec.lines && spec.lines.map) || {})) out[k] = resolve(ln, v)
    return out
  })
  // 预聚合（按声明顺序，add 可引用先前聚合）
  event.amounts = {}
  for (const [k, s] of Object.entries(spec.amounts || {})) event.amounts[k] = round2(aggregate(event, s, k))
  // 维度（可选，头级）
  event.dims = {}
  for (const [k, v] of Object.entries(spec.dims || {})) event.dims[k] = resolve(raw, v)
  return event
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/** 借贷分录数组（规则引擎 Collect 输出）→ 借贷平衡校验 + 组装 cv_* 凭证。 */
export function assembleVoucher (lines, meta = {}) {
  let dr = 0, cr = 0
  const acc = []
  lines.filter((l) => Number(l.amount) !== 0).forEach((l, i) => {
    const isD = l.drcr === 'D'
    if (isD) dr += Number(l.amount); else cr += Number(l.amount)
    acc.push({ lineNo: i + 1, gl_account: l.account, name: l.accountName || '', dc: isD ? 'S' : 'H', local_dr: isD ? round2(l.amount) : 0, local_cr: isD ? 0 : round2(l.amount) })
  })
  dr = round2(dr); cr = round2(cr)
  return {
    balanced: Math.abs(dr - cr) < 0.005,
    dr, cr,
    voucher: {
      cv_header: { docType: '记账凭证', docNo: meta.docNo || '', postingDate: meta.postingDate || '', postingPeriod: meta.period || '', summary: meta.summary || '', local_dr_total: dr, local_cr_total: cr, status: 'draft' },
      cv_acc_line: acc,
    },
  }
}
