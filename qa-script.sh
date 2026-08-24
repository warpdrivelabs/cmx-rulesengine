#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# cmx-rulesengine 脚本能力（SC0-SC4）全面后端测试套件
# 直连 rules-server :8094（auth.mode=off，单租户 default）。
# 覆盖：Rhai 接缝 / 四载体（Script 节点·脚本单元格·函数库·脚本决策）/ 沙箱 /
#       语法校验 / 完整性分析黑盒 / trace 可解释性 / 数值 f64 归一 / 错误归因。
# 所有落库数据以 qsc_ 前缀（脚本决策/图）与 qfn_ 前缀（函数）保留，末尾清理临时项。
# 输出：每断言 PASS/FAIL；结尾汇总。退出码 = 失败数。
# ═══════════════════════════════════════════════════════════════════════════
set -u
B="${B:-http://127.0.0.1:8094/api/rules/v1}"
PASS=0; FAIL=0; declare -a FAILED_TESTS
CT='-H Content-Type:application/json'

# ── 断言助手 ──
assert_eq() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf "  ✅ %s\n" "$1";
  else FAIL=$((FAIL+1)); FAILED_TESTS+=("$1 | 期望[$2] 实际[$3]"); printf "  ❌ %s\n     期望[%s] 实际[%s]\n" "$1" "$2" "$3"; fi
}
assert_contains() {
  if printf '%s' "$3" | grep -qF "$2"; then PASS=$((PASS+1)); printf "  ✅ %s\n" "$1";
  else FAIL=$((FAIL+1)); FAILED_TESTS+=("$1 | 应含[$2] 实际[$3]"); printf "  ❌ %s\n     应含[%s] 实际[%s]\n" "$1" "$2" "$3"; fi
}
assert_not_contains() {
  if printf '%s' "$3" | grep -qF "$2"; then FAIL=$((FAIL+1)); FAILED_TESTS+=("$1 | 不应含[$2] 实际[$3]"); printf "  ❌ %s\n     不应含[%s] 实际[%s]\n" "$1" "$2" "$3";
  else PASS=$((PASS+1)); printf "  ✅ %s\n" "$1"; fi
}
# jget "<json>" "<python-expr on d>"：expr 以 [ 开头自动补 d 前缀，否则原样 eval。
jget() { EXPR="$2" python3 -c "
import sys,json,os
try: d=json.load(sys.stdin)
except Exception as e: print('JSONERR:'+str(e)); sys.exit(0)
e=os.environ['EXPR']
try: print(eval(('d'+e) if e.startswith('[') else e))
except Exception as ex: print('EXPRERR:'+str(ex))
" <<<"$1"; }
post() { curl -s "$B$1" $CT -X POST -d "$2"; }
get()  { curl -s "$B$1"; }
del()  { curl -s "$B$1" -X DELETE; }

echo "═══════════════════════════════════════════════════════════════════"
echo " 规则引擎脚本能力测试套件（SC0-SC4）  $B"
echo "═══════════════════════════════════════════════════════════════════"

# ═══════════════════════════════════════════════════════════════════════════
echo; echo "【SC0 · Rhai 接缝 / 沙箱 / 校验 —— /script/eval】"
# ═══════════════════════════════════════════════════════════════════════════

R=$(post /script/eval '{"script":"income * 0.1","context":{"income":30000}}')
assert_eq "单表达式求值 income*0.1" "3000.0" "$(jget "$R" "['data']['result']")"

R=$(post /script/eval '{"script":"40 + 2"}')
assert_eq "无上下文常量表达式 40+2" "42.0" "$(jget "$R" "['data']['result']")"

# 数值 f64 归一化：整数运算结果也应带 .0（与 FEEL 算术一致）。
R=$(post /script/eval '{"script":"1 + 1"}')
assert_eq "整数 1+1 归一为 f64(2.0)" "2.0" "$(jget "$R" "['data']['result']")"

# 阶梯累进（招牌场景：多语句 + 循环 + 状态迭代，FEEL 表达不动）。
LADDER='let taxable=income-5000; let t=0.0; let br=[[25000.0,0.25],[12000.0,0.20],[3000.0,0.10],[0.0,0.03]]; let b=taxable; for x in br { if b>x[0] { t+=(b-x[0])*x[1]; b=x[0]; } } t'
R=$(post /script/eval "{\"script\":\"$LADDER\",\"context\":{\"income\":30000}}")
# taxable=25000: (25000-25000)*.25=0 +(25000-12000)*.2=2600 +(12000-3000)*.1=900 +(3000-0)*.03=90 = 3590
assert_eq "阶梯累进个税 income=30000 → 3590" "3590.0" "$(jget "$R" "['data']['result']")"

# 返回 map 对象。
R=$(post /script/eval '{"script":"#{ tax: income*0.1, net: income*0.9 }","context":{"income":30000}}')
assert_eq "返回对象 map .tax" "3000.0" "$(jget "$R" "['data']['result']['tax']")"
assert_eq "返回对象 map .net" "27000.0" "$(jget "$R" "['data']['result']['net']")"

# 字符串拼接 + 上下文变量。
R=$(post /script/eval '{"script":"\"tier-\" + level","context":{"level":"gold"}}')
assert_eq "字符串拼接读上下文" "tier-gold" "$(jget "$R" "['data']['result']")"

# 沙箱：死循环被操作数闸门 kill（不挂起、亚秒返回、错误归因到脚本）。
T0=$(python3 -c 'import time;print(time.time())')
R=$(post /script/eval '{"script":"let i=0; while true { i+=1; } i"}')
T1=$(python3 -c 'import time;print(time.time())')
DUR=$(python3 -c "print(round($T1-$T0,2))")
assert_contains "死循环被沙箱拦(错误归因脚本)" "脚本" "$R"
FASTKILL=$(python3 -c "print('yes' if $T1-$T0 < 3 else 'no')")
assert_eq "死循环亚 3 秒被 kill（实测 ${DUR}s）" "yes" "$FASTKILL"

# 沙箱：运行期错误（未定义变量 / 不存在函数）落 Result 不 panic，带行号。
R=$(post /script/eval '{"script":"let a=1;\nno_such_fn(a)"}')
assert_contains "调用不存在函数 → 错误" "脚本" "$R"
assert_contains "运行期错误带行号(第 2 行)" "行" "$R"

# 沙箱：深递归 → 调用层级闸门 kill（Stack overflow，不爆栈 panic）。
R=$(post /script/eval '{"script":"fn rec(n){ rec(n+1) } rec(0)"}')
assert_contains "深递归被调用层级闸门拦" "脚本" "$R"

# 沙箱：超大字符串分配 → 字符串尺寸闸门 kill（不 OOM）。
R=$(post /script/eval '{"script":"let s=\"x\"; for i in 0..30 { s += s; } s.len()"}')
assert_contains "超大字符串被尺寸闸门拦" "脚本" "$R"

# 语法预检（check_script 经 /script/eval 编译阶段暴露）。
R=$(post /script/eval '{"script":"let x = ;"}')
assert_contains "语法错误被拦" "错误" "$R"

# 空脚本 → null。
R=$(post /script/eval '{"script":"   "}')
assert_eq "空脚本 → null" "None" "$(jget "$R" "['data']['result']")"

# 嵌套结构桥接 + len() 归一。
R=$(post /script/eval '{"script":"#{ n: order.items.len(), vip: order.vip }","context":{"order":{"items":[1,2,3],"vip":true}}}')
assert_eq "嵌套读取 items.len() 归一 f64" "3.0" "$(jget "$R" "['data']['result']['n']")"
assert_eq "嵌套读取布尔 vip" "True" "$(jget "$R" "['data']['result']['vip']")"

# ═══════════════════════════════════════════════════════════════════════════
echo; echo "【SC1 · 决策图 Script 节点 —— /evaluate 内联图】"
# ═══════════════════════════════════════════════════════════════════════════

SC1_DEF='{"key":"qsc_graph","name":"脚本节点图","version":1,"kind":"graph","nodes":[
  {"id":"in","type":"input"},
  {"id":"tax","type":"script","lang":"rhai","script":"let taxable=income-5000; if taxable<=0 { return #{tax:0.0,taxable:0.0}; } let t=0.0; let br=[[25000.0,0.25],[12000.0,0.20],[3000.0,0.10],[0.0,0.03]]; let b=taxable; for x in br { if b>x[0] { t+=(b-x[0])*x[1]; b=x[0]; } } #{ tax:t, taxable:taxable, afterTax: income-t }"},
  {"id":"out","type":"output"}],
  "edges":[{"source":"in","target":"tax"},{"source":"tax","target":"out"}]}'
R=$(post /evaluate "{\"definition\":$SC1_DEF,\"input\":{\"income\":30000},\"options\":{\"trace\":true}}")
assert_eq "Script 节点：tax=3590" "3590.0" "$(jget "$R" "['data']['output']['tax']")"
assert_eq "Script 节点：taxable=25000" "25000.0" "$(jget "$R" "['data']['output']['taxable']")"
assert_eq "Script 节点：afterTax=26410" "26410.0" "$(jget "$R" "['data']['output']['afterTax']")"
assert_eq "Script 节点 trace nodeKind=script" "script" "$(jget "$R" "next(t['nodeKind'] for t in d['data']['trace'] if t['nodeId']=='tax')")"
assert_eq "trace 三节点(input→script→output)" "['input', 'script', 'output']" "$(jget "$R" "str([t['nodeKind'] for t in d['data']['trace']])")"

# 边界：taxable<=0 提前 return。
R=$(post /evaluate "{\"definition\":$SC1_DEF,\"input\":{\"income\":3000},\"options\":{\"trace\":true}}")
assert_eq "Script 节点 early-return tax=0" "0.0" "$(jget "$R" "['data']['output']['tax']")"

# Script 节点运行期错误 → 该节点 failure 带行号，nodeKind 保持 script（不误标 graph）。
SC1_BAD='{"key":"qsc_gbad","name":"坏脚本图","version":1,"kind":"graph","nodes":[
  {"id":"in","type":"input"},{"id":"bad","type":"script","script":"let a=1;\nno_such_fn(a)"},{"id":"out","type":"output"}],
  "edges":[{"source":"in","target":"bad"},{"source":"bad","target":"out"}]}'
R=$(post /evaluate "{\"definition\":$SC1_BAD,\"input\":{\"x\":1},\"options\":{\"trace\":true}}")
assert_contains "坏 Script 节点 → failure 归因" "脚本" "$R"
assert_eq "失败 Script 节点 nodeKind 仍=script(不误标 graph)" "script" "$(jget "$R" "next(t['nodeKind'] for t in d['data']['trace'] if t['nodeId']=='bad')")"

# Script 节点须返回对象（非 map → 错误归因）。
SC1_NONMAP='{"key":"qsc_gnm","name":"非对象","version":1,"kind":"graph","nodes":[
  {"id":"in","type":"input"},{"id":"s","type":"script","script":"42"},{"id":"out","type":"output"}],
  "edges":[{"source":"in","target":"s"},{"source":"s","target":"out"}]}'
R=$(post /evaluate "{\"definition\":$SC1_NONMAP,\"input\":{\"x\":1},\"options\":{\"trace\":true}}")
assert_contains "Script 节点非对象返回 → 错误归因" "对象" "$R"

# ═══════════════════════════════════════════════════════════════════════════
echo; echo "【SC2 · 决策表脚本单元格 —— =rhai: 前缀，判定侧仍 FEEL】"
# ═══════════════════════════════════════════════════════════════════════════

# 决策表：输入 score 判定用 FEEL（> 700 等），输出格用 =rhai: 脚本算 bonus。
SC2_DEF='{"key":"qsc_table","name":"脚本单元格表","version":1,"kind":"decisionTable","hitPolicy":"F",
  "inputs":[{"label":"分数","expression":"score"}],
  "outputs":[{"label":"奖金","name":"bonus"}],
  "rules":[
    {"inputEntries":["> 700"],"outputEntries":["=rhai: score * 4"]},
    {"inputEntries":["<= 700"],"outputEntries":["=rhai: score * 2"]}
  ]}'
R=$(post /evaluate "{\"definition\":$SC2_DEF,\"input\":{\"score\":750},\"options\":{\"trace\":true}}")
assert_eq "脚本单元格 score=750(>700) bonus=3000" "3000.0" "$(jget "$R" "['data']['output']['bonus']")"
R=$(post /evaluate "{\"definition\":$SC2_DEF,\"input\":{\"score\":500},\"options\":{\"trace\":true}}")
assert_eq "脚本单元格 score=500(<=700) bonus=1000" "1000.0" "$(jget "$R" "['data']['output']['bonus']")"

# 同表 FEEL 输出格与脚本输出格数值一致（f64 归一，无 Number(i)!=Number(f) 破裂）。
SC2_MIX='{"key":"qsc_mix","name":"混合格","version":1,"kind":"decisionTable","hitPolicy":"U",
  "inputs":[{"label":"额","expression":"amt"}],
  "outputs":[{"label":"feel","name":"a"},{"label":"脚本","name":"b"}],
  "rules":[{"inputEntries":["> 0"],"outputEntries":["amt * 5","=rhai: amt * 5"]}]}'
R=$(post /evaluate "{\"definition\":$SC2_MIX,\"input\":{\"amt\":8000},\"options\":{\"trace\":false}}")
assert_eq "FEEL 输出格 a=40000" "40000.0" "$(jget "$R" "['data']['output']['a']")"
assert_eq "脚本输出格 b=40000（与 FEEL 同 f64）" "40000.0" "$(jget "$R" "['data']['output']['b']")"

# 完整性分析：判定侧纯 FEEL → gap/overlap 仍有效（脚本在输出侧不影响）。
R=$(post /decisions/qsc_gapcheck/analyze "{\"definition\":{\"key\":\"qsc_gapcheck\",\"name\":\"缺口\",\"version\":1,\"kind\":\"decisionTable\",\"hitPolicy\":\"U\",\"inputs\":[{\"label\":\"s\",\"expression\":\"score\"}],\"outputs\":[{\"label\":\"o\",\"name\":\"o\"}],\"rules\":[{\"inputEntries\":[\"> 100\"],\"outputEntries\":[\"=rhai: score * 2\"]}]}}")
assert_contains "脚本单元格表判定侧仍可 gap 分析" "gap" "$(printf '%s' "$R" | tr 'A-Z' 'a-z')$(jget "$R" "[len(d['data'].get('gaps',[]))]")"

# ═══════════════════════════════════════════════════════════════════════════
echo; echo "【SC4 · 脚本决策（DecisionBody::Script）—— kind:script】"
# ═══════════════════════════════════════════════════════════════════════════

SC4_DEF='{"key":"qsc_decision","name":"脚本决策","version":1,"kind":"script","lang":"rhai",
  "script":"let base = price * (1.0 - discount); #{ finalPrice: base, saved: price - base }"}'
R=$(post /evaluate "{\"definition\":$SC4_DEF,\"input\":{\"price\":130,\"discount\":0.1},\"options\":{\"trace\":true}}")
assert_eq "脚本决策 finalPrice=117" "117.0" "$(jget "$R" "['data']['output']['finalPrice']")"
assert_eq "脚本决策 saved=13" "13.0" "$(jget "$R" "['data']['output']['saved']")"
assert_eq "脚本决策 trace nodeKind=script" "script" "$(jget "$R" "d['data']['trace'][0]['nodeKind']")"

# 脚本决策空 script → 结构校验失败（validate）。
R=$(post /evaluate '{"definition":{"key":"qsc_empty","name":"空","version":1,"kind":"script","lang":"rhai","script":"   "},"input":{},"options":{"trace":false}}')
assert_contains "脚本决策空 script → 校验失败" "不可为空" "$R"

# 完整性分析：脚本决策黑盒 → 显式告知（非静默假 complete）。
R=$(post /decisions/qsc_decision/analyze "{\"definition\":$SC4_DEF}")
assert_contains "脚本决策 analyze 显式黑盒告知" "黑盒" "$R"

# ═══════════════════════════════════════════════════════════════════════════
echo; echo "【SC3 · 脚本函数库全生命周期 —— /functions + 三载体调用】"
# ═══════════════════════════════════════════════════════════════════════════

# 清理可能残留。
del /functions/qfn_grade >/dev/null 2>&1
del /functions/qfn_helper >/dev/null 2>&1

# 存草稿（编译校验）。
R=$(post /functions/draft '{"name":"qfn_grade","params":["raw"],"body":"if raw >= 90 { \"优\" } else if raw >= 60 { \"中\" } else { \"差\" }","lang":"rhai","description":"评级"}')
assert_contains "函数存草稿成功" "saved" "$R"

# 语法错草稿被拦（带行号）。
R=$(post /functions/draft '{"name":"qfn_bad","params":["x"],"body":"let a = ;","lang":"rhai"}')
assert_contains "语法错函数草稿被拦" "语法错误" "$R"

# 空函数名被拒。
R=$(post /functions/draft '{"name":"  ","params":[],"body":"1","lang":"rhai"}')
assert_contains "空函数名被拒" "不可为空" "$R"

# 未发布 → 求值时不注册（调用报 Function not found）。
R=$(post /script/eval '{"script":"qfn_grade(95)"}')
assert_contains "未发布函数不可调用" "脚本" "$R"

# 发布 → version+1。
R=$(post /functions/qfn_grade/publish '')
assert_eq "函数发布 published=true" "True" "$(jget "$R" "['data']['published']")"

# 已发布 → /script/eval 可调。
R=$(post /script/eval '{"script":"#{ g: qfn_grade(score) }","context":{"score":95}}')
assert_eq "已发布函数 /script/eval 可调 → 优" "优" "$(jget "$R" "['data']['result']['g']")"
R=$(post /script/eval '{"script":"qfn_grade(50)","context":{}}')
assert_eq "已发布函数边界 raw=50 → 差" "差" "$(jget "$R" "['data']['result']")"

# 已发布 → 脚本决策(SC4)可调库函数。
R=$(post /evaluate '{"definition":{"key":"qsc_fnuse","name":"用库","version":1,"kind":"script","lang":"rhai","script":"#{ grade: qfn_grade(score) }"},"input":{"score":72},"options":{"trace":false}}')
assert_eq "脚本决策调库函数 raw=72 → 中" "中" "$(jget "$R" "['data']['output']['grade']")"

# 已发布 → 决策表脚本单元格(SC2)可调库函数。
R=$(post /evaluate '{"definition":{"key":"qsc_fncell","name":"格调库","version":1,"kind":"decisionTable","hitPolicy":"F","inputs":[{"label":"s","expression":"score"}],"outputs":[{"label":"g","name":"g"}],"rules":[{"inputEntries":["> 0"],"outputEntries":["=rhai: qfn_grade(score)"]}]},"input":{"score":88},"options":{"trace":false}}')
assert_eq "脚本单元格调库函数 raw=88 → 中" "中" "$(jget "$R" "['data']['output']['g']")"

# 函数间互调（helper 调 grade）。
R=$(post /functions/draft '{"name":"qfn_helper","params":["s"],"body":"\"[\" + qfn_grade(s) + \"]\"","lang":"rhai"}')
assert_contains "互调函数存草稿" "saved" "$R"
R=$(post /functions/qfn_helper/publish '')
R=$(post /script/eval '{"script":"qfn_helper(95)"}')
assert_eq "函数间互调 helper(95) → [优]" "[优]" "$(jget "$R" "['data']['result']")"

# 列表 / 详情 / 删除。
R=$(get /functions)
assert_contains "函数列表含 qfn_grade" "qfn_grade" "$R"
R=$(get /functions/qfn_grade)
assert_contains "函数详情可取" "qfn_grade" "$R"
R=$(del /functions/qfn_helper)
assert_eq "函数删除 deleted=true" "True" "$(jget "$R" "['data']['deleted']")"
R=$(get /functions/qfn_helper)
assert_contains "删除后详情 404" "不存在" "$R"

# 删除后跨请求不泄漏（qfn_helper 已删 → 调用报错）。
R=$(post /script/eval '{"script":"qfn_helper(1)"}')
assert_contains "已删函数不可调用(无泄漏)" "脚本" "$R"

# ═══════════════════════════════════════════════════════════════════════════
echo; echo "【落库校验 · save_draft 拦脚本语法错（check_scripts）】"
# ═══════════════════════════════════════════════════════════════════════════

# 图 Script 节点语法错 → save_draft 落库前拦。
R=$(post /definitions/draft '{"key":"qsc_baddraft","name":"坏草稿","version":1,"kind":"graph","nodes":[{"id":"in","type":"input"},{"id":"s","type":"script","script":"let x = ;"},{"id":"out","type":"output"}],"edges":[{"source":"in","target":"s"},{"source":"s","target":"out"}]}')
assert_contains "save_draft 拦图 Script 节点语法错" "错误" "$R"

# 脚本决策语法错 → save_draft 拦。
R=$(post /definitions/draft '{"key":"qsc_baddec","name":"坏决策","version":1,"kind":"script","lang":"rhai","script":"let a = ;"}')
assert_contains "save_draft 拦脚本决策语法错" "错误" "$R"

# 合法脚本决策 → save_draft 成功（落库后清理）。
R=$(post /definitions/draft "$SC4_DEF")
assert_contains "合法脚本决策 save_draft 成功" "qsc_decision" "$R"

# ── 清理临时落库项 ──
echo; echo "── 清理临时数据 ──"
for k in qsc_decision qsc_gapcheck; do del /definitions/$k >/dev/null 2>&1; done
del /functions/qfn_grade >/dev/null 2>&1
echo "  （qfn_/qsc_ 临时项已清理；内联 evaluate 未落库）"

# ═══════════════════════════════════════════════════════════════════════════
echo; echo "═══════════════════════════════════════════════════════════════════"
printf "  脚本能力断言汇总：PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
echo "SUMMARY_LINE PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "  ── 失败明细 ──"
  for t in "${FAILED_TESTS[@]}"; do echo "   ✗ $t"; done
fi
echo "═══════════════════════════════════════════════════════════════════"
exit "$FAIL"
