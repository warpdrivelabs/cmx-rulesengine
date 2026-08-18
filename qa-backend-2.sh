#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# cmx-rulesengine 后端测试套件 · 第2部分
# 决策图 / gap-overlap / 仿真-用例-日志 / simulate / 错误路径 / 类型容错 / 删除
# 数据以 qa_ 前缀保留。
# ═══════════════════════════════════════════════════════════════════════════
B="${B:-http://127.0.0.1:8094/api/rules/v1}"
PASS=0; FAIL=0; declare -a FAILED_TESTS
J='-H Content-Type:application/json'
CURL="curl -s -m10 --no-keepalive"
assert_eq()       { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf "  ✅ %s\n" "$1"; else FAIL=$((FAIL+1)); FAILED_TESTS+=("$1 | 期望[$2] 实际[$3]"); printf "  ❌ %s\n     期望[%s] 实际[%s]\n" "$1" "$2" "$3"; fi; }
assert_contains() { if echo "$3" | grep -qF "$2"; then PASS=$((PASS+1)); printf "  ✅ %s\n" "$1"; else FAIL=$((FAIL+1)); FAILED_TESTS+=("$1 | 应含[$2] 实际[$3]"); printf "  ❌ %s\n     应含[%s] 实际[%s]\n" "$1" "$2" "$3"; fi; }
jget() { EXPR="$2" python3 -c "
import sys,json,os
d=json.load(sys.stdin);e=os.environ['EXPR']
print(eval(('d'+e) if e.startswith('[') else e))
" 2>/dev/null <<< "$1"; }
post() { $CURL -XPOST "$B/$1" $J -d "$2"; }
get()  { $CURL "$B/$1"; }
code() { $CURL -o /dev/null -w "%{http_code}" -XPOST "$B/$1" $J -d "$2"; }
codeg(){ $CURL -o /dev/null -w "%{http_code}" "$B/$1"; }
coded(){ $CURL -o /dev/null -w "%{http_code}" -XDELETE "$B/$1"; }

echo "════════════════════════════════════════════════════════"
echo " cmx-rulesengine 后端测试 · 第2部分 @ $B"
echo "════════════════════════════════════════════════════════"

# ═══════════════ 组 7：决策图 ═══════════════
echo; echo "【组7】决策图（JDM DAG）"
# 子决策：风险评分（First）
post "definitions/draft" '{"key":"qa_risk","name":"QA风险评分","kind":"decisionTable","hitPolicy":"F",
 "inputs":[{"expression":"score"}],"outputs":[{"name":"rate"}],
 "rules":[{"inputEntries":[">= 700"],"outputEntries":["5"]},{"inputEntries":["[600..700)"],"outputEntries":["3"]},{"inputEntries":["-"],"outputEntries":["1"]}]}' >/dev/null
# 主图：input → 内联表 base → 子决策 risk → 表达式 calc → output
post "definitions/draft" '{"key":"qa_loan","name":"QA信贷综合","kind":"graph",
 "nodes":[
   {"id":"in","type":"input"},
   {"id":"base","type":"decisionTable","table":{"hitPolicy":"F","inputs":[{"expression":"income"}],"outputs":[{"name":"baseLimit"}],"rules":[{"inputEntries":[">= 8000"],"outputEntries":["income * 2"]},{"inputEntries":["-"],"outputEntries":["income"]}]}},
   {"id":"risk","type":"decision","decisionKey":"qa_risk"},
   {"id":"calc","type":"expression","mappings":[{"key":"maxLimit","expression":"baseLimit * rate"}]},
   {"id":"out","type":"output"}
 ],
 "edges":[{"source":"in","target":"base"},{"source":"base","target":"risk"},{"source":"risk","target":"calc"},{"source":"calc","target":"out"}]}' >/dev/null

R=$(post "decisions/qa_loan/evaluate" '{"input":{"score":750,"income":10000}}')
# income>=8000→baseLimit=20000; score750→rate=5; maxLimit=20000*5=100000
assert_eq "图求值 baseLimit=20000" "20000.0" "$(jget "$R" "['data']['output']['baseLimit']")"
assert_eq "图求值子决策 rate=5" "5.0" "$(jget "$R" "['data']['output']['rate']")"
assert_eq "图求值 maxLimit=100000" "100000.0" "$(jget "$R" "['data']['output']['maxLimit']")"
assert_eq "图 trace 节点数>=5(含子决策)" "True" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']['trace'])>=5)" <<< "$R")"

# 低分低收入路径
R=$(post "decisions/qa_loan/evaluate" '{"input":{"score":500,"income":5000}}')
# income<8000→baseLimit=5000; score500→rate=1; maxLimit=5000
assert_eq "图求值低分 maxLimit=5000" "5000.0" "$(jget "$R" "['data']['output']['maxLimit']")"

# 环检测
post "definitions/draft" '{"key":"qa_cycle","kind":"graph","nodes":[{"id":"a","type":"input"},{"id":"b","type":"output"}],"edges":[{"source":"a","target":"b"},{"source":"b","target":"a"}]}' >/dev/null
R=$(post "decisions/qa_cycle/evaluate" '{"input":{}}')
assert_contains "决策图环→失败归因含'环'" "环" "$R"

# 子决策缺失
post "definitions/draft" '{"key":"qa_missdep","kind":"graph","nodes":[{"id":"in","type":"input"},{"id":"d","type":"decision","decisionKey":"qa_ghost_dep"},{"id":"out","type":"output"}],"edges":[{"source":"in","target":"d"},{"source":"d","target":"out"}]}' >/dev/null
R=$(post "decisions/qa_missdep/evaluate" '{"input":{}}')
assert_contains "子决策缺失→失败归因" "未找到" "$R"

# 决策图结构校验：决策表节点缺 table
R=$(post "definitions/validate" '{"key":"qa_badgraph","kind":"graph","nodes":[{"id":"a","type":"decisionTable"}],"edges":[]}')
assert_eq "图决策表节点缺table→valid=false" "False" "$(jget "$R" "['data']['valid']")"

# ═══════════════ 组 8：gap / overlap 完整性分析 ═══════════════
echo; echo "【组8】完整性分析 gap/overlap"
# 完整覆盖表（无空隙无重叠）
post "definitions/draft" '{"key":"qa_complete","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"age"}],"outputs":[{"name":"g"}],"rules":[{"inputEntries":["< 18"],"outputEntries":["\"minor\""]},{"inputEntries":[">= 18"],"outputEntries":["\"adult\""]}]}' >/dev/null
R=$(post "decisions/qa_complete/analyze" '{}')
assert_eq "完整表 complete=true" "True" "$(jget "$R" "['data']['complete']")"
assert_eq "完整表 hasOverlap=false" "False" "$(jget "$R" "['data']['hasOverlap']")"

# 有空隙（25~60 未覆盖）
post "definitions/draft" '{"key":"qa_gap","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"age"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":["< 25"],"outputEntries":["\"y\""]},{"inputEntries":[">= 60"],"outputEntries":["\"o\""]}]}' >/dev/null
R=$(post "decisions/qa_gap/analyze" '{}')
assert_eq "空隙表 complete=false" "False" "$(jget "$R" "['data']['complete']")"
assert_eq "空隙表 gaps 非空" "True" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']['gaps'])>0)" <<< "$R")"

# 有重叠
post "definitions/draft" '{"key":"qa_overlap","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"x"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":["> 700"],"outputEntries":["\"a\""]},{"inputEntries":["> 750"],"outputEntries":["\"b\""]}]}' >/dev/null
R=$(post "decisions/qa_overlap/analyze" '{}')
assert_eq "重叠表 hasOverlap=true" "True" "$(jget "$R" "['data']['hasOverlap']")"
assert_contains "重叠描述含'同时命中'" "同时命中" "$R"

# not() 无法结构化 → 显式说明
post "definitions/draft" '{"key":"qa_other","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"x"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":["not(> 100)"],"outputEntries":["\"y\""]}]}' >/dev/null
R=$(post "decisions/qa_other/analyze" '{}')
assert_contains "not()表→gap说明无法结构化" "无法结构化" "$R"

# 内联定义分析（未存表）
R=$(post "decisions/whatever/analyze" '{"definition":{"key":"inl2","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"x"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":["> 5"],"outputEntries":["\"a\""]},{"inputEntries":["> 3"],"outputEntries":["\"b\""]}]}}')
assert_eq "内联定义分析 hasOverlap=true" "True" "$(jget "$R" "['data']['hasOverlap']")"

# ═══════════════ 组 9：仿真 / 测试用例 / 日志 ═══════════════
echo; echo "【组9】仿真 / 测试用例 / 日志"
# simulate 不落日志
BEFORE=$(get "decisions/qa_risk/logs" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']))" 2>/dev/null || echo 0)
post "decisions/qa_risk/simulate" '{"input":{"score":800}}' >/dev/null
AFTER=$(get "decisions/qa_risk/logs" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']))" 2>/dev/null || echo 0)
assert_eq "simulate 不落日志(前后日志数不变)" "$BEFORE" "$AFTER"

# 存测试用例
R=$(post "decisions/qa_risk/tests" '{"name":"高分","input":{"score":750},"expected":{"rate":5}}')
assert_eq "存用例返回 saved=true" "True" "$(jget "$R" "['data']['saved']")"
TID=$(jget "$R" "['data']['id']")
post "decisions/qa_risk/tests" '{"name":"中分","input":{"score":650},"expected":{"rate":3}}' >/dev/null
post "decisions/qa_risk/tests" '{"name":"故意错","input":{"score":800},"expected":{"rate":99}}' >/dev/null

R=$(get "decisions/qa_risk/tests")
assert_eq "用例列表>=3" "True" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)['data'])>=3)" <<< "$R")"

# 批跑套件
R=$(post "decisions/qa_risk/tests/run" '')
assert_eq "套件 total>=3" "True" "$(python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total']>=3)" <<< "$R")"
assert_eq "套件有通过(passed>=2)" "True" "$(python3 -c "import sys,json;print(json.load(sys.stdin)['data']['passed']>=2)" <<< "$R")"
assert_eq "套件有失败(failed>=1,含故意错)" "True" "$(python3 -c "import sys,json;print(json.load(sys.stdin)['data']['failed']>=1)" <<< "$R")"
assert_contains "套件含 coverage" "coverage" "$R"

# 删用例
assert_eq "删用例返回200" "200" "$(coded "decisions/qa_risk/tests/$TID")"

# 日志下钻
post "decisions/qa_risk/evaluate" '{"input":{"score":720}}' >/dev/null
R=$(get "decisions/qa_risk/logs")
LID=$(jget "$R" "['data'][0]['id']")
assert_eq "日志列表非空" "True" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)['data'])>0)" <<< "$R")"
R=$(get "logs/$LID")
assert_eq "日志下钻含 trace" "True" "$(python3 -c "import sys,json;print('trace' in json.load(sys.stdin)['data'])" <<< "$R")"
assert_eq "日志下钻含 input" "True" "$(python3 -c "import sys,json;print('input' in json.load(sys.stdin)['data'])" <<< "$R")"
assert_eq "日志下钻不存在id→404" "404" "$(codeg "logs/qa_nolog_xxx")"

# ═══════════════ 组 10：错误路径 / 边界 / 类型容错 ═══════════════
echo; echo "【组10】错误路径 / 边界 / 类型容错"
assert_eq "取不存在定义→404" "404" "$(codeg "definitions/qa_ghost")"
assert_eq "求值不存在决策→404" "404" "$(code "decisions/qa_ghost/evaluate" '{"input":{}}')"
assert_eq "删不存在定义→404" "404" "$(coded "definitions/qa_ghost")"
# 存无输出列草稿→业务错误 code=1
R=$(post "definitions/draft" '{"key":"qa_bad","kind":"decisionTable","hitPolicy":"U","inputs":[],"outputs":[],"rules":[]}')
assert_eq "存非法定义→code=1" "1" "$(jget "$R" "['code']")"
# 规则项数不符
R=$(post "definitions/draft" '{"key":"qa_bad2","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"x"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":[],"outputEntries":["1"]}]}')
assert_eq "输入项数不符→code=1" "1" "$(jget "$R" "['code']")"
# 内联求值缺 definition
R=$(post "evaluate" '{"input":{"x":1}}')
assert_eq "内联求值缺definition→code=1" "1" "$(jget "$R" "['code']")"
# FEEL 语法错误
R=$(post "feel/expression" '{"expression":"2 +","context":{}}')
assert_eq "FEEL 语法错→code=1" "1" "$(jget "$R" "['code']")"
# 类型容错：缺失字段做序比较不报错
post "definitions/draft" '{"key":"qa_missing","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"score"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":["> 100"],"outputEntries":["\"y\""]}]}' >/dev/null
R=$(post "decisions/qa_missing/evaluate" '{"input":{"other":5}}')
assert_eq "缺失字段求值不报错 output=null" "None" "$(jget "$R" "['data']['output']")"
assert_eq "缺失字段无 failure" "None" "$(jget "$R" "['data'].get('failure')")"
# 空输入对象
R=$(post "decisions/qa_missing/evaluate" '{"input":{}}')
assert_eq "空输入求值不崩" "0" "$(jget "$R" "['code']")"

# ═══════════════ 组 11：删除（连带清理四表） ═══════════════
echo; echo "【组11】删除（连带清理）"
# 建带关联的临时决策
post "definitions/draft" '{"key":"qa_delme","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"x"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":["> 5"],"outputEntries":["\"a\""]}]}' >/dev/null
post "decisions/qa_delme/publish" '' >/dev/null
post "decisions/qa_delme/evaluate" '{"input":{"x":10}}' >/dev/null
post "decisions/qa_delme/tests" '{"name":"t","input":{"x":10},"expected":{"r":"a"}}' >/dev/null
assert_eq "删除决策返回200" "200" "$(coded "definitions/qa_delme")"
assert_eq "删除后取详情→404" "404" "$(codeg "definitions/qa_delme")"
assert_eq "删除后日志清空" "0" "$(get "decisions/qa_delme/logs" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']))" 2>/dev/null || echo ERR)"
assert_eq "删除后用例清空" "0" "$(get "decisions/qa_delme/tests" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']))" 2>/dev/null || echo ERR)"

# ═══════════════ 组 12：stats / 监控 ═══════════════
echo; echo "【组12】stats / 监控端点"
R=$(get "stats")
assert_contains "stats 含 definitions" "definitions" "$R"
assert_contains "stats 含 successRate" "successRate" "$R"
assert_eq "openapi.json→200" "200" "$(codeg "openapi.json")"
assert_eq "旧前缀 /api/rules/stats→200" "200" "$($CURL -o /dev/null -w '%{http_code}' http://127.0.0.1:8094/api/rules/stats)"
assert_eq "大盘根路径→200" "200" "$($CURL -o /dev/null -w '%{http_code}' http://127.0.0.1:8094/)"
assert_eq "技术监控 /_mon→200" "200" "$($CURL -o /dev/null -w '%{http_code}' http://127.0.0.1:8094/_mon)"

echo; echo "════ 第2部分汇总：PASS=$PASS  FAIL=$FAIL ════"
if [ $FAIL -gt 0 ]; then echo "失败明细："; for t in "${FAILED_TESTS[@]}"; do echo "  ✗ $t"; done; fi
echo "SUMMARY_LINE PASS=$PASS FAIL=$FAIL"
exit $FAIL