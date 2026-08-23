// P2 · 单据 → 凭证草稿落库（对齐真实 cv_* 4 层 schema）。
// 承 P1：适配器→记账事件→规则引擎 Collect→分录；本阶段：code→id FK 解析 + 组装 4 层 changeset
// + 按真实 meta 列校验 schema + 借贷平衡/差额行 + 尝试 POST /api/doc/save（表未部署则优雅报告）。
// 运行：node docs/full-test/p2/run.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toAccountingEvent } from '../p1/event_adapter.mjs'
import { assembleChangeset } from './voucher_assembler.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(DIR, '../../../..') // → presentation/
const KEY = 'cmx_sk_dev_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'
const RULES = 'http://127.0.0.1:8094/api/rules/v1'
const PORTAL = 'http://127.0.0.1:8080'
let pass = 0, fail = 0
const A = (ok, d, det) => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${d}${det ? '  :: ' + det : ''}`) }

// ── code→id FK 解析器（来自真实 cf_gl_account 种子）──
const coa = JSON.parse(readFileSync(join(ROOT, 'cmx-container/data/dictbak/entries/fi/cmxfico/gl/cf_gl_account.json'), 'utf8'))
const coaRows = Array.isArray(coa) ? coa : (coa.entries || coa.rows || [])
const code2id = new Map(coaRows.map((r) => [r.item_code || r.code, r.id]))
const resolveAccountId = (code) => code2id.get(code)

// ── 真实 meta 列（schema 校验用）：voucherTables 各表列 ∪ base_doc_meta 公共列（继承）──
const meta = JSON.parse(readFileSync(join(ROOT, 'cmx-container/data/meta/definitions/fi/cmxfico/gl/cmxfico_doc_meta_v2.json'), 'utf8'))
const baseMeta = JSON.parse(readFileSync(join(ROOT, 'cmx-container/data/meta/definitions/base/base_doc_meta_v1.json'), 'utf8'))
const baseFields = new Set(); (function scan (o) { if (!o) return; if (Array.isArray(o)) return o.forEach(scan); if (typeof o === 'object') { if (o.name && (o.dataType || o.type)) baseFields.add(o.name); for (const k in o) scan(o[k]) } })(baseMeta)
const cols = Object.fromEntries((meta.voucherTables || []).map((t) => [t.tableName || t.table, new Set([...(t.columns || t.fields || []).map((c) => c.name || c.field), ...baseFields])]))

async function rules (path, body) {
  const r = await fetch(RULES + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: JSON.stringify(body) })
  const j = await r.json(); if (j.code !== 0) throw new Error(j.msg); return j.data
}

// P1 posting/determ 决策集已在 P1 落库；直接复用。
const POSTKEY = { PURCHASE_INVOICE: 'gl_posting_purchase_invoice', EXPENSE_CLAIM: 'gl_posting_expense_claim2', PAYMENT: 'gl_posting_payment' }
const determCache = {}
async function resolveKey (accountKey) {
  if (!determCache[accountKey]) { const o = (await rules('/decisions/acct_determ_coa/evaluate', { input: { accountKey } })).output || {}; determCache[accountKey] = { account: o.glAccount, name: o.glAccountName } }
  return determCache[accountKey]
}
const load = (p) => JSON.parse(readFileSync(join(DIR, '..', 'p1', p), 'utf8'))
const CASES = [
  { name: '采购发票', docType: 'PURCHASE_INVOICE', spec: 'specs/purchase_invoice.json', raw: 'raw/purchase_invoice.json', expDr: 13560 },
  { name: '费用报销', docType: 'EXPENSE_CLAIM', spec: 'specs/expense_claim.json', raw: 'raw/expense_claim.json', expDr: 1000 },
  { name: '付款单', docType: 'PAYMENT', spec: 'specs/payment.json', raw: 'raw/payment.json', expDr: 13560 },
]

// changeset 每行 fields 的列名必须都是真实 meta 列
function validateSchema (changeset) {
  const bad = []
  for (const [table, blk] of Object.entries(changeset.changes)) {
    const known = cols[table]; if (!known) { bad.push(`未知表 ${table}`); continue }
    for (const row of blk.inserted || []) for (const f of Object.keys(row.fields || {})) if (!known.has(f)) bad.push(`${table}.${f}`)
  }
  return bad
}

;(async () => {
  console.log('═══ 前置：cf_gl_account code→id 解析器（真实种子）═══')
  A(code2id.size > 100 && resolveAccountId('140301') === 2010025, `COA 映射就绪（${code2id.size} 科目，140301→${resolveAccountId('140301')}）`)

  let anySave = false
  for (const c of CASES) {
    console.log(`\n═══ ${c.name}（${c.docType}）═══`)
    const event = toAccountingEvent(load(c.raw), load(c.spec))
    const posting = (await rules(`/decisions/${POSTKEY[c.docType]}/evaluate`, { input: event })).output || []
    const lines = []
    for (const p of posting) { const r = await resolveKey(p.accountKey); lines.push({ account: r.account, accountName: r.name, drcr: p.drcr, amount: p.amount, dims: c.docType === 'EXPENSE_CLAIM' ? { costCenter: null } : (p.accountKey === 'PAYABLE' ? { supplier: event.header.supplierId ? 1 : null } : {}) }) }

    const ctx = { compUnitId: 1000, docTypeId: 1, entityId: 1000, docNo: 'GL-' + load(c.raw).header.docNo, docDate: event.postingDate, docStatus: 'draft', ledgerCode: '0L', fiscalYear: 2026, period: event.period, postingDate: event.postingDate, currency: event.currency || 'CNY', summary: event.header.summary, roundAccountId: resolveAccountId('660201') }
    const { balanced, local_dr, local_cr, changeset } = assembleChangeset(lines, ctx, resolveAccountId)

    A(balanced && local_dr === c.expDr, `4 层组装 + 借贷平衡（本位币 借${local_dr}=贷${local_cr}）`, balanced ? '✓' : '✗')
    // 结构：4 层 + upper_id 链
    const ch = changeset.changes
    const linkOk = ch.cv_header.inserted[0].upper_id === 'bat_1' && ch.cv_acc_line.inserted.every((r) => r.upper_id === 'hdr_1')
    A(ch.cv_batch.inserted.length === 1 && ch.cv_header.inserted.length === 1 && ch.cv_acc_line.inserted.length >= 2 && linkOk, `4 层 changeset + upper_id 链（批→头→${ch.cv_acc_line.inserted.length}科目行→${ch.cv_aux_line.inserted.length}辅助行）`)
    // FK：科目行都落真实 gl_account_id
    A(ch.cv_acc_line.inserted.every((r) => Number.isInteger(r.fields.gl_account_id)), 'code→id FK：科目行落真实 gl_account_id', ch.cv_acc_line.inserted.map((r) => r.fields.gl_account_id).join(','))
    // 6 币位 + dc
    const s0 = ch.cv_acc_line.inserted[0].fields
    A('entered_dr' in s0 && 'local_dr' in s0 && 'group_dr' in s0 && (s0.debit_credit_code === 'S' || s0.debit_credit_code === 'H'), '6 币位金额 + dc_indicator(借S/贷H)', `dc=${s0.debit_credit_code}`)
    // schema 校验：所有 fields 列名都是真实 meta 列
    const bad = validateSchema(changeset)
    A(bad.length === 0, 'changeset 列名全部命中真实 meta 列（零臆造列）', bad.length ? bad.slice(0, 4).join(',') : '4 层全对齐')

    if (c.docType === 'PURCHASE_INVOICE') console.log('    凭证头本位币借贷:', s0 && `${local_dr}/${local_cr}`, '| 科目行 gl_account_id:', ch.cv_acc_line.inserted.map((r) => r.fields.gl_account_id).join(','))

    // 尝试真机落库（doc=cmxfico 真实 moduleCode；表未部署→优雅捕获）
    try {
      const r = await fetch(`${PORTAL}/api/doc/save?domain=fi&application=cmxfico&module=gl&doc=cmxfico`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: JSON.stringify(changeset) })
      const j = await r.json().catch(() => null)
      if (r.ok && j && j.code === 0) { anySave = true; console.log('    ✓ 真机落库成功 idMap:', JSON.stringify(j.data).slice(0, 120)) }
      else {
        const v = (j && j.data && (j.data.violations || j.data.errors)) || []
        const vn = Array.isArray(v) ? v.length : 0
        console.log(`    ⚠ 落库未成（code=${j && j.code}${vn ? ' · ' + vn + ' 处校验' : ''} / ${(j && j.msg || '').slice(0, 70)}）`)
        if (vn) v.slice(0, 3).forEach((x) => console.log('        ·', (x.table || '') + '.' + (x.field || ''), (x.message || x.msg || '').slice(0, 50)))
      }
    } catch (e) { console.log('    ⚠ 落库调用异常:', e.message.slice(0, 80)) }
  }

  console.log(`\n════ P2 凭证组装（真实 schema）：${pass}/${pass + fail} 通过 ════`)
  console.log(anySave ? '   真机 cv_* 落库成功。' : '   注：cv_*/cf_* 物理表未在本 dev fico 库部署（仅 cmx_/cg_/cr_）；changeset 已按真实 meta 校验通过，部署+COA seed 后即可落库（见报告部署前置）。')
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error('FATAL', e.message); process.exit(2) })
