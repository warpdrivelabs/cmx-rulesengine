#!/usr/bin/env bash
# P0 · 最小闭环：费用报销单 → 记账凭证（真机跑通）
# 步骤：①分类 gl_posting ②建 Collect 记账规则表 + 科目确定表 ③evaluate 出借贷分录数组
#       ④科目确定表 gap/overlap 完整性分析 ⑤组装器：借贷平衡校验 + 组装 cv_* 凭证 ⑥审计日志下钻
# 前置：rules.sh 起 :8094。运行：bash docs/full-test/p0-expense-voucher.sh
set -uo pipefail
KEY='cmx_sk_dev_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'
API='http://127.0.0.1:8094/api/rules/v1'
post() { curl -s -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -X POST "$API$1" -d "$2"; }
get()  { curl -s -H "X-API-Key: $KEY" "$API$1"; }
data() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(JSON.stringify(j.data??j,null,2))}catch{console.log(s)}})'; }

echo "═══ ① 分类 gl_posting（复用受管分类）═══"
post /categories '{"code":"gl_posting","name":"记账规则","ord":10}' >/dev/null && echo "  ✓ 分类就绪"

echo "═══ ② 建决策表：记账规则(Collect) + 科目确定(Unique) ═══"
post /definitions/draft '{
  "key":"gl_posting_expense_claim","name":"记账规则·费用报销","version":1,"categoryCode":"gl_posting",
  "kind":"decisionTable","hitPolicy":"C",
  "inputs":[{"id":"i_evt","label":"业务事件","expression":"bizEvent"}],
  "outputs":[
    {"id":"o_acc","name":"account","label":"科目"},
    {"id":"o_an","name":"accountName","label":"科目名"},
    {"id":"o_dc","name":"drcr","label":"借贷"},
    {"id":"o_amt","name":"amount","label":"金额"}],
  "rules":[
    {"id":"r_travel","inputEntries":["\"EXPENSE_REIMBURSE\""],"outputEntries":["\"660101\"","\"差旅费\"","\"D\"","amounts.travel"]},
    {"id":"r_meal","inputEntries":["\"EXPENSE_REIMBURSE\""],"outputEntries":["\"660102\"","\"业务招待费\"","\"D\"","amounts.meal"]},
    {"id":"r_bank","inputEntries":["\"EXPENSE_REIMBURSE\""],"outputEntries":["\"100201\"","\"银行存款\"","\"C\"","amounts.total"]}]
}' >/dev/null && echo "  ✓ gl_posting_expense_claim (Collect)"
post /definitions/draft '{
  "key":"acct_determ_expense","name":"科目确定·费用报销","version":1,"categoryCode":"gl_posting",
  "kind":"decisionTable","hitPolicy":"U",
  "inputs":[{"id":"k","label":"费用类型","expression":"expenseType"}],
  "outputs":[{"id":"acc","name":"glAccount","label":"总账科目"}],
  "rules":[
    {"id":"a_travel","inputEntries":["\"TRAVEL\""],"outputEntries":["\"660101\""]},
    {"id":"a_meal","inputEntries":["\"MEAL\""],"outputEntries":["\"660102\""]}]
}' >/dev/null && echo "  ✓ acct_determ_expense (Unique)"

echo "═══ ③ evaluate：费用报销事件 → 借贷分录数组 ═══"
EVENT='{"docType":"EXPENSE_CLAIM","bizEvent":"EXPENSE_REIMBURSE","compUnit":"1000","postingDate":"2026-08-22","period":"2026-08","currency":"CNY","header":{"employee":"E1001","summary":"张三差旅报销"},"amounts":{"travel":800,"meal":200,"total":1000},"dims":{"costCenter":"CC01"}}'
EVAL=$(post /decisions/gl_posting_expense_claim/evaluate "{\"input\":$EVENT}")
echo "$EVAL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s).data;console.log("  output(分录数组):");console.log(JSON.stringify(j.output));console.log("  logId:",j.logId)})'
LOGID=$(echo "$EVAL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.logId))')

echo "═══ ④ 科目确定完整性分析（gap/overlap）═══"
post /decisions/acct_determ_expense/analyze '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).data;console.log("  complete:",a.complete,"| hasOverlap:",a.hasOverlap,"| gaps:",(a.gaps||[]).length,"| overlaps:",(a.overlaps||[]).length);(a.gaps||[]).slice(0,3).forEach(g=>console.log("   gap:",g.description))})'

echo "═══ ⑤ 组装器：借贷平衡 + 组装 cv_* 凭证 ═══"
echo "$EVAL" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const lines=JSON.parse(s).data.output;
  let dr=0,cr=0; const acc=[];
  lines.filter(l=>l.amount!==0).forEach((l,i)=>{ const d=l.drcr==="D"; if(d)dr+=l.amount;else cr+=l.amount;
    acc.push({lineNo:i+1,gl_account:l.account,name:l.accountName,dc:d?"S":"H",local_dr:d?l.amount:0,local_cr:d?0:l.amount});});
  const balanced=Math.abs(dr-cr)<0.005;
  const voucher={cv_header:{docType:"记账凭证",docNo:"GL-20260822-P0",postingDate:"2026-08-22",postingPeriod:"2026-08",summary:"张三差旅报销",local_dr_total:dr,local_cr_total:cr,status:"draft"},cv_acc_line:acc};
  console.log("  借合计:",dr,"| 贷合计:",cr,"|",balanced?"✓ 借贷平衡":"✗ 不平衡");
  console.log("  凭证 JSON（cv_*，可 POST /api/doc/save 落库）:");
  console.log(JSON.stringify(voucher,null,2).split("\n").map(l=>"    "+l).join("\n"));
})'

echo "═══ ⑥ 审计：决策日志下钻（每行凭证←规则）═══"
get "/logs/$LOGID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s).data;console.log("  logId:",l.id,"| decision:",l.decisionKey,"v"+l.decisionVersion);const t=(l.trace||[])[0]||{};console.log("  命中规则行:",JSON.stringify(t.matchedRules||[]),"（3 条 = 借差旅/借招待/贷银行）")})'

echo ""
echo "════ P0 闭环完成：费用报销事件 → Collect 决策表 → 3 条借贷分录 → 平衡 → cv_* 凭证 → 审计可追溯 ════"
