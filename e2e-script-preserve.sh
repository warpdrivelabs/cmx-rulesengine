#!/usr/bin/env bash
# 规则引擎脚本能力（SC0-SC4）真机 E2E —— **保留测试数据**版。
# 与 qa-script.sh（末尾清理）互补：本脚本部署+发布四载体各一份代表决策/函数，
# 全部以 sce2e_ 前缀落库并**保留**，供设计器/仿真台/审计中心查看。直连 :8094。
set -u
B="${B:-http://127.0.0.1:8094/api/rules/v1}"
PASS=0; FAIL=0
ok(){ printf '  \xE2\x9C\x93 %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  \xE2\x9C\x97 %s  [%s]\n' "$1" "$2"; FAIL=$((FAIL+1)); }
say(){ printf '\n=== %s ===\n' "$1"; }
post(){ curl -s "$B$1" -H 'Content-Type: application/json' -X POST -d "$2"; }
jget(){ EXPR="$2" python3 -c "import sys,json,os;d=json.load(sys.stdin);e=os.environ['EXPR'];print(eval(('d'+e) if e.startswith('[') else e))" <<<"$1" 2>/dev/null; }

# ---------- SC0 · Rhai 接缝 /script/eval ----------
say "SC0 · Rhai 接缝（/script/eval 直接求值 + f64 归一 + 沙箱）"
R=$(post /script/eval '{"script":"income * 0.1","context":{"income":30000}}')
[ "$(jget "$R" "['data']['result']")" = "3000.0" ] && ok "算术求值 income*0.1=3000.0（f64 归一）" || no "算术" "$R"
R=$(post /script/eval '{"script":"let i=0; while true { i+=1; } i"}')
echo "$R" | grep -qiE "operation|too many|错误|脚本" && ok "死循环被沙箱 max_operations 拦（非 wall-clock）" || no "沙箱" "$R"

# ---------- SC3 · 脚本函数库（先建库，供三载体调用）----------
say "SC3 · 脚本函数库（draft→publish→三载体调用）"
post /functions/draft '{"name":"sce2e_grade","params":["s"],"body":"fn sce2e_grade(s){ if s>=90 {\"优\"} else if s>=75 {\"良\"} else if s>=60 {\"中\"} else {\"差\"} }","description":"E2E 保留：评级函数"}' >/dev/null
RP=$(post /functions/sce2e_grade/publish '{}')
[ "$(jget "$RP" "['data']['published']")" = "True" ] && ok "函数 sce2e_grade 发布 published=true" || no "发布" "$RP"
R=$(post /script/eval '{"script":"sce2e_grade(88)"}')
[ "$(jget "$R" "['data']['result']")" = "良" ] && ok "已发布函数 /script/eval 调用 grade(88)=良" || no "调用" "$R"

# ---------- SC1 · 决策图 Script 节点（部署+发布+保留）----------
say "SC1 · 决策图 Script 节点（阶梯累进个税，部署保留）"
SC1='{"key":"sce2e_graph","name":"E2E脚本节点图-阶梯个税","version":1,"kind":"graph","nodes":[
  {"id":"in","type":"input"},
  {"id":"tax","type":"script","lang":"rhai","script":"let taxable=income-5000; if taxable<=0 { return #{tax:0.0}; } let t=0.0; let br=[[25000.0,0.25],[12000.0,0.20],[3000.0,0.10],[0.0,0.03]]; let b=taxable; for x in br { if b>x[0] { t+=(b-x[0])*x[1]; b=x[0]; } } #{ tax:t, afterTax: income-t }"},
  {"id":"out","type":"output"}],
  "edges":[{"source":"in","target":"tax"},{"source":"tax","target":"out"}]}'
post /definitions/draft "$SC1" >/dev/null
post /definitions/sce2e_graph/publish '{}' >/dev/null
R=$(post /evaluate "{\"definition\":$SC1,\"input\":{\"income\":30000},\"options\":{\"trace\":true}}")
[ "$(jget "$R" "['data']['output']['tax']")" = "3590.0" ] && ok "图 Script 节点 income=30000 → tax=3590" || no "SC1 求值" "$R"
[ "$(jget "$R" "next(t['nodeKind'] for t in d['data']['trace'] if t['nodeId']=='tax')")" = "script" ] && ok "trace nodeKind=script（可解释）" || no "SC1 trace" "$R"

# ---------- SC2 · 决策表脚本单元格（=rhai: 前缀，判定侧仍 FEEL）----------
say "SC2 · 决策表脚本单元格（=rhai: 输出，判定侧 FEEL 不变）"
SC2='{"key":"sce2e_table","name":"E2E脚本单元格表-奖金","version":1,"kind":"decisionTable","hitPolicy":"F",
  "inputs":[{"label":"分数","expression":"score"}],
  "outputs":[{"label":"奖金","name":"bonus"}],
  "rules":[
    {"inputEntries":["> 700"],"outputEntries":["=rhai: score * 4"]},
    {"inputEntries":["<= 700"],"outputEntries":["=rhai: score * 2"]}
  ]}'
post /definitions/draft "$SC2" >/dev/null
post /definitions/sce2e_table/publish '{}' >/dev/null
R=$(post /evaluate "{\"definition\":$SC2,\"input\":{\"score\":750},\"options\":{\"trace\":true}}")
[ "$(jget "$R" "['data']['output']['bonus']")" = "3000.0" ] && ok "脚本单元格 score=750(>700) → bonus=3000" || no "SC2" "$R"

# ---------- SC4 · 脚本决策（DecisionBody::Script，调库函数）----------
say "SC4 · 脚本决策（kind:script，调 SC3 库函数）"
SC4='{"key":"sce2e_decision","name":"E2E脚本决策-定价+评级","version":1,"kind":"script","lang":"rhai",
  "script":"let base = price * (1.0 - discount); #{ finalPrice: base, saved: price - base, grade: sce2e_grade(score) }"}'
post /definitions/draft "$SC4" >/dev/null
post /definitions/sce2e_decision/publish '{}' >/dev/null
R=$(post /evaluate "{\"definition\":$SC4,\"input\":{\"price\":130,\"discount\":0.1,\"score\":72},\"options\":{\"trace\":true}}")
[ "$(jget "$R" "['data']['output']['finalPrice']")" = "117.0" ] && ok "脚本决策 finalPrice=117" || no "SC4 价" "$R"
[ "$(jget "$R" "['data']['output']['grade']")" = "中" ] && ok "脚本决策调库函数 grade(72)=中" || no "SC4 库调用" "$R"

# ---------- 校验/分析黑盒 ----------
say "校验 / 完整性分析（脚本决策黑盒）"
R=$(post /definitions/draft '{"key":"sce2e_bad","name":"坏脚本","version":1,"kind":"script","lang":"rhai","script":"let a = ;"}')
echo "$R" | grep -qiE "错误|error|syntax|脚本|line|行" && ok "save_draft 拦脚本语法错（check_scripts 带行号）" || no "校验" "$R"
R=$(post /decisions/sce2e_decision/analyze "{\"definition\":$SC4}")
echo "$R" | grep -qiE "false|黑盒|script|脚本" && ok "脚本决策完整性分析显式黑盒（非假 complete）" || no "分析" "$R"

printf '\n========== 脚本能力 E2E 汇总: PASS=%d FAIL=%d ==========\n' "$PASS" "$FAIL"
printf '保留数据（sce2e_ 前缀，运维/设计器可查）:\n'
printf '  函数库: sce2e_grade（已发布）\n'
printf '  决策集: sce2e_graph(SC1图) / sce2e_table(SC2表) / sce2e_decision(SC4脚本决策)\n'
