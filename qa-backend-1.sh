#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# cmx-rulesengine 全面后端功能测试套件
# 直连 rules-server :8094。所有测试数据以 qa_ 前缀保留（不清理）。
# 输出：每断言 PASS/FAIL；结尾汇总。退出码 = 失败数。
# ═══════════════════════════════════════════════════════════════════════════
B="${B:-http://127.0.0.1:8094/api/rules/v1}"
PASS=0; FAIL=0; declare -a FAILED_TESTS
J='-H Content-Type:application/json'

# 断言：期望值 实际值 描述
assert_eq() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf "  ✅ %s\n" "$1";
  else FAIL=$((FAIL+1)); FAILED_TESTS+=("$1 | 期望[$2] 实际[$3]"); printf "  ❌ %s\n     期望[%s] 实际[%s]\n" "$1" "$2" "$3"; fi
}
assert_contains() {
  if echo "$3" | grep -qF "$2"; then PASS=$((PASS+1)); printf "  ✅ %s\n" "$1";
  else FAIL=$((FAIL+1)); FAILED_TESTS+=("$1 | 应含[$2] 实际[$3]"); printf "  ❌ %s\n     应含[%s] 实际[%s]\n" "$1" "$2" "$3"; fi
}
# jget "<json>" "<expr>"：expr 以 [ 开头则自动补 d 前缀（d['data']...）；否则原样 eval（如 len(d['data'])）
jget() { EXPR="$2" python3 -c "
import sys,json,os
d=json.load(sys.stdin)
e=os.environ['EXPR']
print(eval(('d'+e) if e.startswith('[') else e))
" 2>/dev/null <<< "$1"; }

CURL="curl -s -m10 --no-keepalive"
post() { $CURL -XPOST "$B/$1" $J -d "$2"; }
get()  { $CURL "$B/$1"; }
del()  { $CURL -XDELETE "$B/$1"; }
code() { $CURL -o /dev/null -w "%{http_code}" -XPOST "$B/$1" $J -d "$2"; }
codeg(){ $CURL -o /dev/null -w "%{http_code}" "$B/$1"; }
coded(){ $CURL -o /dev/null -w "%{http_code}" -XDELETE "$B/$1"; }

echo "════════════════════════════════════════════════════════"
echo " cmx-rulesengine 后端全面测试 @ $B"
echo "════════════════════════════════════════════════════════"

# ═══════════════ 组 1：定义 CRUD ═══════════════
echo; echo "【组1】定义 CRUD"
R=$(post "definitions/draft" '{"key":"qa_credit","name":"QA信贷审批","kind":"decisionTable","hitPolicy":"U",
 "inputs":[{"id":"i1","label":"信用分","expression":"score"},{"id":"i2","label":"地区","expression":"region"}],
 "outputs":[{"id":"o1","name":"tier","label":"等级"},{"id":"o2","name":"maxLimit","label":"额度"}],
 "rules":[
   {"inputEntries":[">= 750","-"],"outputEntries":["\"A\"","income * 5"]},
   {"inputEntries":["[650..750)","\"north\""],"outputEntries":["\"B\"","income * 4"]},
   {"inputEntries":["[650..750)","-"],"outputEntries":["\"B\"","income * 3"]},
   {"inputEntries":["< 650","-"],"outputEntries":["\"C\"","0"]}]}')
assert_eq "存草稿 qa_credit 返回 code=0" "0" "$(jget "$R" "['code']")"
assert_eq "存草稿返回 saved=true" "True" "$(jget "$R" "['data']['saved']")"

R=$(get "definitions/qa_credit")
assert_eq "取详情 key 正确" "qa_credit" "$(jget "$R" "['data']['key']")"
assert_eq "取详情 hitPolicy=U" "U" "$(jget "$R" "['data']['hitPolicy']")"
assert_eq "取详情输入列数=2" "2" "$(jget "$R" "len(d['data']['inputs'])")"

R=$(get "definitions")
assert_contains "列表含 qa_credit" "qa_credit" "$R"

R=$(post "definitions/validate" '{"key":"qa_v","kind":"decisionTable","hitPolicy":"U","inputs":[],"outputs":[{"name":"r"}],"rules":[]}')
assert_eq "校验合法定义 valid=true" "True" "$(jget "$R" "['data']['valid']")"

R=$(post "definitions/validate" '{"key":"qa_v","kind":"decisionTable","hitPolicy":"U","inputs":[],"outputs":[],"rules":[]}')
assert_eq "校验无输出列 valid=false" "False" "$(jget "$R" "['data']['valid']")"

# ═══════════════ 组 2：发布 / 版本 ═══════════════
echo; echo "【组2】发布 / 版本"
R=$(post "definitions/qa_credit/publish" '')
V1=$(jget "$R" "['data']['version']")
assert_eq "首次发布 published=true" "True" "$(jget "$R" "['data']['published']")"
assert_eq "发布返回数字版本号" "True" "$(python3 -c "print(str('$V1').isdigit())")"

R=$(post "definitions/qa_credit/publish" '')
V2=$(jget "$R" "['data']['version']")
assert_eq "再次发布版本号递增(+1)" "True" "$(python3 -c "print($V2 == $V1 + 1)")"

R=$(get "definitions/qa_credit/versions")
assert_eq "版本列表条数 = 最新版本号" "True" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']) == $V2)" <<< "$R")"

R=$(post "definitions/qa_credit/versions/1/activate" '')
assert_eq "激活 v1 成功 active=true" "True" "$(jget "$R" "['data']['active']")"
# 激活回最新版，避免影响后续求值
post "definitions/qa_credit/versions/$V2/activate" '' >/dev/null

# 发布不存在的
assert_contains "发布不存在草稿报错" "无草稿" "$(post "definitions/qa_nonexist/publish" '')"

# ═══════════════ 组 3：核心求值 ═══════════════
echo; echo "【组3】核心求值"
R=$(post "decisions/qa_credit/evaluate" '{"input":{"score":800,"region":"north","income":10000}}')
assert_eq "求值 tier=A" "A" "$(jget "$R" "['data']['output']['tier']")"
assert_eq "求值 maxLimit=50000(income*5)" "50000.0" "$(jget "$R" "['data']['output']['maxLimit']")"
assert_contains "求值返回 logId" "logId" "$R"
assert_eq "求值命中行=[0]" "[0]" "$(jget "$R" "['data']['trace'][0]['matchedRules']")"

R=$(post "decisions/qa_credit/evaluate" '{"input":{"score":700,"region":"north","income":8000}}')
# 注意：qa_credit 的行1[650..750)&north 与 行2[650..750)&- 对 north 中分**重叠**，U 策略下引擎正确报失败归因
assert_contains "中分北方触发 UNIQUE 重叠失败归因(引擎正确)" "UNIQUE" "$R"

R=$(post "decisions/qa_credit/evaluate" '{"input":{"score":500,"region":"east","income":6000}}')
assert_eq "求值低分 tier=C" "C" "$(jget "$R" "['data']['output']['tier']")"

# 无命中（score 700 但非 north，行2 需 north；行1 需 >=750；行3 需 <650）→ 命中行2(650..750,-)
R=$(post "decisions/qa_credit/evaluate" '{"input":{"score":700,"region":"south","income":5000}}')
assert_eq "中分南方命中行2 maxLimit=15000(income*3)" "15000.0" "$(jget "$R" "['data']['output']['maxLimit']")"

# options.trace=false
R=$(post "decisions/qa_credit/evaluate" '{"input":{"score":800,"region":"x","income":100},"options":{"trace":false,"log":false}}')
assert_eq "trace=false 时无 trace 字段" "False" "$(python3 -c "import sys,json;print('trace' in json.load(sys.stdin)['data'])" <<< "$R")"

# 内联求值 /evaluate
R=$(post "evaluate" '{"input":{"x":5},"definition":{"key":"inl","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"x"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":["> 3"],"outputEntries":["\"big\""]}]}}')
assert_eq "内联求值 r=big" "big" "$(jget "$R" "['data']['output']['r']")"

# 求值不存在的决策
assert_eq "求值不存在决策→404" "404" "$(code "decisions/qa_ghost/evaluate" '{"input":{}}')"

# ═══════════════ 组 4：11 命中策略 ═══════════════
echo; echo "【组4】11 命中策略（单输出列 amount，三行全通配命中 10/30/20）"
mkhp() {
  post "definitions/draft" "{\"key\":\"qa_hp_$1\",\"name\":\"QA-$1\",\"kind\":\"decisionTable\",\"hitPolicy\":\"$2\",
   \"inputs\":[{\"expression\":\"x\"}],\"outputs\":[{\"name\":\"amount\"}],
   \"rules\":[{\"inputEntries\":[\"-\"],\"outputEntries\":[\"10\"]},{\"inputEntries\":[\"-\"],\"outputEntries\":[\"30\"]},{\"inputEntries\":[\"-\"],\"outputEntries\":[\"20\"]}]}" >/dev/null
}
evalhp() { post "decisions/qa_hp_$1/evaluate" '{"input":{"x":1},"options":{"log":true}}'; }

mkhp count "C#"; assert_eq "C# 计数=3" "3" "$(jget "$(evalhp count)" "['data']['output']")"
mkhp sum "C+";   assert_eq "C+ 求和=60" "60.0" "$(jget "$(evalhp sum)" "['data']['output']")"
mkhp min "C<";   assert_eq "C< 最小=10" "10.0" "$(jget "$(evalhp min)" "['data']['output']")"
mkhp max "C>";   assert_eq "C> 最大=30" "30.0" "$(jget "$(evalhp max)" "['data']['output']")"
mkhp first "F";  assert_eq "F 首个 amount=10" "10.0" "$(jget "$(evalhp first)" "['data']['output']['amount']")"
mkhp collect "C"; assert_eq "C 收集列表长度=3" "3" "$(jget "$(evalhp collect)" "len(d['data']['output'])")"
mkhp ruleorder "R"; assert_eq "R 规则序列表长度=3" "3" "$(jget "$(evalhp ruleorder)" "len(d['data']['output'])")"

# U 重叠 → 失败归因
mkhp unique "U"
R=$(evalhp unique)
assert_contains "U 重叠→失败归因含 UNIQUE" "UNIQUE" "$R"

# A 输出不一致 → 失败
mkhp any "A"
R=$(evalhp any)
assert_contains "A 输出不一致→失败归因" "不一致" "$R"

# A 输出一致 → 取一
post "definitions/draft" '{"key":"qa_hp_any_ok","kind":"decisionTable","hitPolicy":"A","inputs":[{"expression":"x"}],"outputs":[{"name":"g"}],"rules":[{"inputEntries":["-"],"outputEntries":["\"same\""]},{"inputEntries":["-"],"outputEntries":["\"same\""]}]}' >/dev/null
assert_eq "A 输出一致→取一 g=same" "same" "$(jget "$(post "decisions/qa_hp_any_ok/evaluate" '{"input":{"x":1}}')" "['data']['output']['g']")"

# 无命中各策略
post "definitions/draft" '{"key":"qa_hp_nohit_u","kind":"decisionTable","hitPolicy":"U","inputs":[{"expression":"x"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":["> 100"],"outputEntries":["\"y\""]}]}' >/dev/null
R=$(post "decisions/qa_hp_nohit_u/evaluate" '{"input":{"x":1}}')
assert_eq "U 无命中→output=null" "None" "$(jget "$R" "['data']['output']")"

post "definitions/draft" '{"key":"qa_hp_nohit_c","kind":"decisionTable","hitPolicy":"C","inputs":[{"expression":"x"}],"outputs":[{"name":"r"}],"rules":[{"inputEntries":["> 100"],"outputEntries":["\"y\""]}]}' >/dev/null
R=$(post "decisions/qa_hp_nohit_c/evaluate" '{"input":{"x":1}}')
assert_eq "C 无命中→output=[]" "[]" "$(jget "$R" "['data']['output']")"

# ═══════════════ 组 5：FEEL unary test ═══════════════
echo; echo "【组5】FEEL unary test（/feel/eval）"
fe() { local c="${3:-{\}}"; post "feel/eval" "{\"test\":$1,\"value\":$2,\"context\":$c}"; }
# FEEL 单测：feval "<test文本>" "<value JSON>" "[context JSON]" → result
# 用 python 组装 body（彻底规避 bash 引号/花括号脆弱性）
feval() {
  local ctx="$3"; [ -z "$ctx" ] && ctx="{}"
  local body; body=$(TEST="$1" VAL="$2" CTX="$ctx" python3 -c "
import os,json
print(json.dumps({'test':os.environ['TEST'],'value':json.loads(os.environ['VAL']),'context':json.loads(os.environ['CTX'])}))
")
  post "feel/eval" "$body"
}
fr() { jget "$(feval "$1" "$2" "$3")" "['data']['result']"; }
assert_eq "通配 - 恒真" "True" "$(fr "-" 5)"
assert_eq "> 700 对 720 真" "True" "$(fr "> 700" 720)"
assert_eq "> 700 对 700 假" "False" "$(fr "> 700" 700)"
assert_eq ">= 18 对 18 真" "True" "$(fr ">= 18" 18)"
assert_eq "闭区间 [1..10] 对 10 真" "True" "$(fr "[1..10]" 10)"
assert_eq "半开 [18..65) 对 65 假" "False" "$(fr "[18..65)" 65)"
assert_eq "开区间 (0..100] 对 0 假" "False" "$(fr "(0..100]" 0)"
assert_eq "反括号 ]1..5] 对 1 假" "False" "$(fr "]1..5]" 1)"
assert_eq "枚举 north,south 对 south 真" "True" "$(fr '"north","south"' '"south"')"
assert_eq "枚举 对 east 假" "False" "$(fr '"north","south"' '"east"')"
assert_eq "not(> 100) 对 50 真" "True" "$(fr "not(> 100)" 50)"
assert_eq "裸字符串等值 vip" "True" "$(fr '"vip"' '"vip"')"
assert_eq "!= 5 对 5 假" "False" "$(fr "!= 5" 5)"
assert_eq "true 对 true 真" "True" "$(fr "true" true)"
assert_eq "null 对 null 真" "True" "$(fr "null" null)"
assert_eq "> 100 对 null 假(不报错)" "False" "$(fr "> 100" null)"
assert_eq "引用变量 > avgScore" "True" "$(fr "> avgScore" 700 '{"avgScore":650}')"
assert_eq "裸布尔 contains(?,vip)" "True" "$(fr 'contains(?, "vip")' '"vip-user"')"
assert_eq "? in [18..65)" "True" "$(fr "? in [18..65)" 30)"

# validate
assert_eq "校验合法单测 valid=true" "True" "$(jget "$(post "feel/validate" '{"test":"[1..10]"}')" "['data']['valid']")"
assert_eq "校验非法区间 valid=false" "False" "$(jget "$(post "feel/validate" '{"test":"[bad..10]"}')" "['data']['valid']")"

# ═══════════════ 组 6：FEEL 完整表达式 + 内置函数 ═══════════════
echo; echo "【组6】FEEL 表达式 + 内置函数（/feel/expression）"
# FEEL 表达式：er "<expr文本>" "[context JSON]" → result（python 组装 body）
er() {
  local ctx="$2"; [ -z "$ctx" ] && ctx="{}"
  local body; body=$(EXPR="$1" CTX="$ctx" python3 -c "
import os,json
print(json.dumps({'expression':os.environ['EXPR'],'context':json.loads(os.environ['CTX'])}))
")
  jget "$(post "feel/expression" "$body")" "['data']['result']"
}
assert_eq "算术优先级 2+3*4=14" "14.0" "$(er "2 + 3 * 4")"
assert_eq "括号 (2+3)*4=20" "20.0" "$(er "(2 + 3) * 4")"
assert_eq "幂右结合 2**3**2=512" "512.0" "$(er "2 ** 3 ** 2")"
assert_eq "除零→null" "None" "$(er "10 / 0")"
assert_eq "变量 income*5" "25000.0" "$(er "income * 5" '{"income":5000}')"
assert_eq "路径 order.amount>10000" "True" "$(er "order.amount > 10000" '{"order":{"amount":12000}}')"
assert_eq "缺失变量→null" "None" "$(er "missing" '{}')"
assert_eq "if-then-else" "A" "$(er 'if score >= 700 then "A" else "B"' '{"score":720}')"
assert_eq "and 逻辑" "True" "$(er "score > 600 and score < 750" '{"score":720}')"
assert_eq "字符串拼接 +" "tier-A" "$(er '"tier-" + "A"')"
assert_eq "upper" "ABC" "$(er 'upper("abc")')"
assert_eq "substring(hello,2,3)" "ell" "$(er 'substring("hello", 2, 3)')"
assert_eq "contains" "True" "$(er 'contains("hello", "ell")')"
assert_eq "floor(3.7)" "3.0" "$(er "floor(3.7)")"
assert_eq "ceiling(3.2)" "4.0" "$(er "ceiling(3.2)")"
assert_eq "round(3.14159,2)" "3.14" "$(er "round(3.14159, 2)")"
assert_eq "abs(-5)" "5.0" "$(er "abs(-5)")"
assert_eq "modulo(7,3)" "1.0" "$(er "modulo(7, 3)")"
assert_eq "sqrt(9)" "3.0" "$(er "sqrt(9)")"
assert_eq "min(3,1,2)" "1.0" "$(er "min(3, 1, 2)")"
assert_eq "max(1,9,4)" "9.0" "$(er "max(1, 9, 4)")"
assert_eq "sum([1,2,3,4])" "10.0" "$(er "sum([1, 2, 3, 4])")"
assert_eq "mean([2,4])" "3.0" "$(er "mean([2, 4])")"
assert_eq "count([10,20,30])" "3" "$(er "count([10, 20, 30])")"
assert_eq "5 in [1..10]" "True" "$(er "5 in [1..10]")"
assert_eq "some 量词" "True" "$(er "some x in [1, 2, 3] satisfies x > 2")"
assert_eq "every 量词 全真" "True" "$(er "every x in [1, 2, 3] satisfies x > 0")"
assert_eq "every 量词 有假" "False" "$(er "every x in [1, 2, 3] satisfies x > 2")"
assert_eq "for 推导" "[10.0, 20.0, 30.0]" "$(er "for x in [1, 2, 3] return x * 10")"
assert_eq "列表过滤" "[3.0, 4.0]" "$(er "[1, 2, 3, 4][item > 2]")"
assert_eq "startsWith" "True" "$(er 'startsWith("hello", "he")')"
assert_eq "endsWith" "True" "$(er 'endsWith("hello", "lo")')"
assert_eq "sort" "[1.0, 2.0, 3.0]" "$(er "sort([3, 1, 2])")"
assert_eq "append" "[1.0, 2.0, 3.0]" "$(er "append([1, 2], 3)")"
assert_eq "coalesce" "5.0" "$(er "coalesce(null, 5)")"
assert_eq "not(true)" "False" "$(er "not(true)")"
assert_eq "string(42) [BUG-001 已修:整数无.0]" "42" "$(er "string(42)")"
assert_eq "number(3.14)" "3.14" "$(er 'number("3.14")')"
assert_eq "trim" "x" "$(er 'trim(" x ")')"
assert_eq "concat" "ab" "$(er 'concat("a", "b")')"

# feel/functions 目录
R=$(get "feel/functions")
assert_eq "函数目录非空(>=10)" "True" "$(python3 -c "import sys,json;print(len(json.load(sys.stdin)['data'])>=10)" <<< "$R")"

echo; echo "════ 后端断言汇总：PASS=$PASS  FAIL=$FAIL ════"
if [ $FAIL -gt 0 ]; then echo "失败明细："; for t in "${FAILED_TESTS[@]}"; do echo "  ✗ $t"; done; fi
echo "SUMMARY_LINE PASS=$PASS FAIL=$FAIL"
exit $FAIL