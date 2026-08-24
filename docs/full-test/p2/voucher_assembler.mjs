// P2 · 凭证组装器（对齐真实 cmxfico_doc_meta_v2 的 4 层 cv_* schema）+ code→id FK 解析 + 差额行 + 6 币位。
//
// 承 P1：规则引擎 Collect 出的借贷分录（{account,accountName,drcr,amount}）→ 组装成 DOC changeset
// （saveMode:merge，4 层 cv_batch→cv_header→cv_acc_line→cv_aux_line 经 upper_id 链），可 POST /api/doc/save。
//
// 真实 schema 关键（读 meta 得，非臆造）：
//   cv_acc_line.gl_account_id = BIGINT（绑字典 gl_account）→ 需 code(140301)→id(2010025) FK 解析；
//   debit_credit_code 绑 dc_indicator（借=S/贷=H）；6 币位 entered/local/group_dr|cr 逐层上卷；本位币借贷须平衡。
//   cv_aux_line（L4）挂 cost_center_id / supplier_id / profit_ctr_id 等维度。
// 纯函数、无 server 依赖，可移植 Rust cmx-gl-model。

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const DC = { D: 'S', C: 'H' } // 借=S 贷=H（dc_indicator）

// 6 币位金额块：本位币=交易币×汇率、集团币×集团汇率（demo 汇率=1，可传入）。
function money (amount, isDebit, rate = 1, groupRate = 1) {
  const a = round2(amount)
  const z = { entered_dr: 0, entered_cr: 0, local_dr: 0, local_cr: 0, group_dr: 0, group_cr: 0 }
  if (isDebit) { z.entered_dr = a; z.local_dr = round2(a * rate); z.group_dr = round2(a * groupRate) }
  else { z.entered_cr = a; z.local_cr = round2(a * rate); z.group_cr = round2(a * groupRate) }
  return z
}
const sumMoney = (rows) => rows.reduce((s, r) => ({
  entered_dr: round2(s.entered_dr + r.entered_dr), entered_cr: round2(s.entered_cr + r.entered_cr),
  local_dr: round2(s.local_dr + r.local_dr), local_cr: round2(s.local_cr + r.local_cr),
  group_dr: round2(s.group_dr + r.group_dr), group_cr: round2(s.group_cr + r.group_cr),
}), { entered_dr: 0, entered_cr: 0, local_dr: 0, local_cr: 0, group_dr: 0, group_cr: 0 })

/**
 * 组装 4 层 changeset。
 * @param lines 规则引擎输出 [{account,accountName,drcr,amount,dims?:{costCenter,supplier,...}}]
 * @param ctx   {compUnitId,docTypeId,ledgerCode,period,fiscalYear,postingDate,summary,currency,rate,groupRate,roundAccountId}
 * @param resolveAccountId (code)=>id  科目 code→id FK 解析器（来自 cf_gl_account）
 */
export function assembleChangeset (lines, ctx, resolveAccountId) {
  const rate = ctx.rate ?? 1, groupRate = ctx.groupRate ?? 1
  const kept = lines.filter((l) => Number(l.amount) !== 0)

  // 借贷平衡 + 舍入差额行（本位币）：差额兜到 roundAccountId（如 财务费用/汇兑损益）。
  let dr = 0, cr = 0
  for (const l of kept) { const m = money(l.amount, l.drcr === 'D', rate, groupRate); dr += m.local_dr; cr += m.local_cr }
  dr = round2(dr); cr = round2(cr)
  const diff = round2(dr - cr)
  const balanceLines = [...kept]
  if (Math.abs(diff) >= 0.01 && ctx.roundAccountId) {
    // dr>cr → 需补一条贷方差额；反之补借方
    balanceLines.push({ account: '__ROUND__', accountId: ctx.roundAccountId, accountName: '舍入差额', drcr: diff > 0 ? 'C' : 'D', amount: Math.abs(diff) })
  }

  // L3 科目行 + L4 辅助行
  const accRows = [], auxRows = []
  balanceLines.forEach((l, i) => {
    const accId = 'acc_' + (i + 1)
    const isD = l.drcr === 'D'
    const glId = l.accountId ?? resolveAccountId(l.account)
    if (glId == null) throw new Error(`科目 code 未找到对应 id: ${l.account}`)
    const m = money(l.amount, isD, rate, groupRate)
    accRows.push({ id: accId, upper_id: 'hdr_1', fields: {
      comp_unit_id: ctx.compUnitId, gl_account_id: glId, debit_credit_code: DC[l.drcr],
      item_text: l.accountName || '', ...m } })
    const d = l.dims || {}
    if (d.costCenter || d.supplier || d.profitCenter || d.project) {
      auxRows.push({ id: 'aux_' + (i + 1), upper_id: accId, fields: {
        comp_unit_id: ctx.compUnitId, ledger_code: ctx.ledgerCode,
        cost_center_id: d.costCenter ?? null, supplier_id: d.supplier ?? null,
        profit_ctr_id: d.profitCenter ?? null, wbs_element_id: d.project ?? null, ...m } })
    }
  })

  const accTotal = sumMoney(accRows.map((r) => r.fields))
  const periodInt = Number(String(ctx.period).split('-')[1] || ctx.period) // "2026-08" → 8（记账期间=月 TINYINT 1..12）
  const headerFields = {
    comp_unit_id: ctx.compUnitId, doc_type_id: ctx.docTypeId, entity_id: ctx.entityId ?? ctx.compUnitId,
    doc_no: ctx.docNo, doc_date: ctx.docDate || ctx.postingDate, doc_status: ctx.docStatus || 'draft',
    ledger_code: ctx.ledgerCode, fiscal_year: ctx.fiscalYear, posting_period: periodInt, posting_date: ctx.postingDate,
    doc_currency_code: ctx.currency || 'CNY', exchange_rate: rate, group_rate: groupRate,
    header_text: ctx.summary || '', preparer_id: ctx.preparerId ?? null, ...accTotal,
  }
  const batchFields = {
    comp_unit_id: ctx.compUnitId, doc_type_id: ctx.docTypeId, entity_id: ctx.entityId ?? ctx.compUnitId,
    doc_date: ctx.docDate || ctx.postingDate, doc_status: ctx.docStatus || 'draft',
    ledger_code: ctx.ledgerCode, period_code: ctx.period, posting_date: ctx.postingDate,
    batch_name: ctx.summary || '记账凭证批', batch_status: 'D', // 批状态 U/P/D 单字符
    control_total: accTotal.local_dr, ...accTotal,
  }

  const balanced = Math.abs(accTotal.local_dr - accTotal.local_cr) < 0.005
  return {
    balanced, local_dr: accTotal.local_dr, local_cr: accTotal.local_cr, roundDiff: diff,
    changeset: {
      saveMode: 'merge',
      changes: {
        cv_batch: { inserted: [{ id: 'bat_1', fields: batchFields }] },
        cv_header: { inserted: [{ id: 'hdr_1', upper_id: 'bat_1', fields: headerFields }] },
        cv_acc_line: { inserted: accRows },
        cv_aux_line: { inserted: auxRows },
      },
    },
  }
}
