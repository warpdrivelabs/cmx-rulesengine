// P1 · 单据 → 记账凭证 端到端（真机 :8094）。三类单据各经 声明式适配器 → 记账事件 → 规则引擎
// 两步判定（① Collect 分录模板 → accountKey ② 科目确定 Unique → 真实科目）→ 组装平衡凭证。
// 运行：node docs/full-test/p1/run.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toAccountingEvent, assembleVoucher } from './event_adapter.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const KEY = 'cmx_sk_dev_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'
const API = 'http://127.0.0.1:8094/api/rules/v1'
let pass = 0, fail = 0
const A = (ok, desc, detail) => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${desc}${detail ? '  :: ' + detail : ''}`) }

async function api (path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY, ...(opts.headers || {}) } })
  const j = await r.json().catch(() => null)
  if (!r.ok || (j && typeof j.code === 'number' && j.code !== 0)) throw new Error((j && j.msg) || ('HTTP ' + r.status))
  return j && 'data' in j ? j.data : j
}
const save = (def) => api('/definitions/draft', { method: 'POST', body: JSON.stringify(def) })
const evaluate = async (key, input) => (await api(`/decisions/${encodeURIComponent(key)}/evaluate`, { method: 'POST', body: JSON.stringify({ input }) }))

// ── ② 科目确定（共享 COA 映射，Unique）accountKey → 真实 cf_gl_account ──
const COA = {
  key: 'acct_determ_coa', name: '科目确定·COA映射', version: 1, categoryCode: 'gl_posting',
  kind: 'decisionTable', hitPolicy: 'U',
  inputs: [{ id: 'k', label: '科目映射键', expression: 'accountKey' }],
  outputs: [{ id: 'acc', name: 'glAccount', label: '总账科目' }, { id: 'an', name: 'glAccountName', label: '科目名' }],
  rules: [
    ['INVENTORY', '140301', '原材料'], ['EXPENSE', '660201', '管理费用'], ['INPUT_VAT', '22210101', '进项税额'],
    ['PAYABLE', '220201', '应付账款'], ['BANK', '100201', '银行存款'],
    ['EXPENSE_TRAVEL', '660101', '差旅费'], ['EXPENSE_MEAL', '660102', '业务招待费'],
  ].map(([k, a, n], i) => ({ id: 'a' + i, inputEntries: [`"${k}"`], outputEntries: [`"${a}"`, `"${n}"`] })),
}
// ── ① 分录模板（每类单据一张 Collect 表）bizEvent → N 条 {accountKey,drcr,amount} ──
const mkPosting = (key, name, bizEvent, rows) => ({
  key, name, version: 1, categoryCode: 'gl_posting', kind: 'decisionTable', hitPolicy: 'C',
  inputs: [{ id: 'e', label: '业务事件', expression: 'bizEvent' }],
  outputs: [{ id: 'ak', name: 'accountKey', label: '科目键' }, { id: 'dc', name: 'drcr', label: '借贷' }, { id: 'amt', name: 'amount', label: '金额' }],
  rules: rows.map((r, i) => ({ id: 'r' + i, inputEntries: [`"${bizEvent}"`], outputEntries: [`"${r[0]}"`, `"${r[1]}"`, r[2]] })),
})
const POSTINGS = {
  PURCHASE_INVOICE: mkPosting('gl_posting_purchase_invoice', '记账规则·采购发票', 'SUPPLIER_INVOICE', [
    ['INVENTORY', 'D', 'amounts.netStock'], ['EXPENSE', 'D', 'amounts.netExpense'], ['INPUT_VAT', 'D', 'amounts.tax'], ['PAYABLE', 'C', 'amounts.gross']]),
  EXPENSE_CLAIM: mkPosting('gl_posting_expense_claim2', '记账规则·费用报销(P1)', 'EXPENSE_REIMBURSE', [
    ['EXPENSE_TRAVEL', 'D', 'amounts.travel'], ['EXPENSE_MEAL', 'D', 'amounts.meal'], ['BANK', 'C', 'amounts.total']]),
  PAYMENT: mkPosting('gl_posting_payment', '记账规则·付款单', 'SUPPLIER_PAYMENT', [
    ['PAYABLE', 'D', 'amounts.total'], ['BANK', 'C', 'amounts.total']]),
}
const CASES = [
  { name: '采购发票', docType: 'PURCHASE_INVOICE', spec: 'purchase_invoice', raw: 'purchase_invoice', expectLines: 4, expectTotal: 13560 },
  { name: '费用报销', docType: 'EXPENSE_CLAIM', spec: 'expense_claim', raw: 'expense_claim', expectLines: 3, expectTotal: 1000 },
  { name: '付款单', docType: 'PAYMENT', spec: 'payment', raw: 'payment', expectLines: 2, expectTotal: 13560 },
]

const load = (sub, f) => JSON.parse(readFileSync(join(DIR, sub, f + '.json'), 'utf8'))
const determCache = {}
async function resolveAccount (accountKey) {
  if (!determCache[accountKey]) { const o = (await evaluate('acct_determ_coa', { accountKey })).output || {}; determCache[accountKey] = { account: o.glAccount, name: o.glAccountName } }
  return determCache[accountKey]
}

;(async () => {
  console.log('═══ 种子：分类 + 科目确定 + 3 张分录模板 ═══')
  await api('/categories', { method: 'POST', body: JSON.stringify({ code: 'gl_posting', name: '记账规则', ord: 10 }) }).catch(() => {})
  await save(COA)
  for (const p of Object.values(POSTINGS)) await save(p)
  console.log('  ✓ acct_determ_coa + gl_posting_{purchase_invoice,expense_claim2,payment}')

  console.log('\n═══ 科目确定完整性分析（gap/overlap）═══')
  const an = await api('/decisions/acct_determ_coa/analyze', { method: 'POST', body: '{}' })
  A(an.hasOverlap === false, '科目映射无重叠（accountKey→唯一科目）', `overlap=${an.hasOverlap}`)

  for (const c of CASES) {
    console.log(`\n═══ ${c.name}（${c.docType}）═══`)
    const raw = load('raw', c.raw), spec = load('specs', c.spec)
    // ① 适配器：任意单据 JSON → 记账事件契约
    const event = toAccountingEvent(raw, spec)
    A(event.docType === c.docType && event.lines.length >= 1 && event.amounts.total === c.expectTotal,
      '适配器投影为记账事件（顶层/明细/预聚合）', `lines=${event.lines.length} amounts.total=${event.amounts.total}`)
    if (c.docType === 'PURCHASE_INVOICE') console.log('    事件.amounts =', JSON.stringify(event.amounts))
    // ② 分录模板（Collect）→ N 条 {accountKey,drcr,amount}
    const posting = (await evaluate(POSTINGS[c.docType].key, event)).output || []
    A(Array.isArray(posting) && posting.length === c.expectLines, `Collect 出 ${c.expectLines} 条分录模板`, `got=${posting.length}`)
    // ③ 科目确定：accountKey → 真实科目
    const lines = []
    for (const p of posting) { const r = await resolveAccount(p.accountKey); lines.push({ account: r.account, accountName: r.name, drcr: p.drcr, amount: p.amount }) }
    A(lines.every((l) => /^\d{6,}$/.test(l.account)), '每条分录落到真实 cf_gl_account 科目', lines.map((l) => l.account).join(','))
    // ④ 组装 + 借贷平衡
    const { balanced, dr, cr, voucher } = assembleVoucher(lines, { docNo: 'GL-' + raw.header.docNo, postingDate: event.postingDate, period: event.period, summary: event.header.summary })
    A(balanced && dr === c.expectTotal, `借贷平衡 借${dr}=贷${cr}`, balanced ? '✓' : '✗ 不平衡')
    console.log('    凭证:', voucher.cv_acc_line.map((l) => `${l.dc === 'S' ? '借' : '贷'} ${l.gl_account}${l.name} ${l.dc === 'S' ? l.local_dr : l.local_cr}`).join(' / '))
  }

  console.log(`\n════ P1 单据适配器：${pass}/${pass + fail} 通过（3 类单据各经 适配器→规则引擎→凭证 全绿）════`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error('FATAL', e.message); process.exit(2) })
