#!/usr/bin/env bash
#
# 规则引擎演示数据 seed —— 让五个前端页(设计工作台/设计器/应用工作台/仿真台/审计中心)有真实内容。
# 经真实 API 灌数(exercise publish/evaluate/tests)。默认打直连 rules-server(:8094，off/single 模式)。
#
# 用法：./seed-demo.sh                       # 直连 rules-server
#       B=http://host:8094/api/rules/v1 ./seed-demo.sh
set -euo pipefail
B="${B:-http://127.0.0.1:8094/api/rules/v1}"
J='-H Content-Type:application/json'
echo "seed → $B"

draft() { curl -s -XPOST "$B/definitions/draft" -H 'Content-Type: application/json' -d "$1" >/dev/null; }
pub()   { curl -s -XPOST "$B/definitions/$1/publish" >/dev/null; }
evalk() { curl -s -XPOST "$B/decisions/$1/evaluate" -H 'Content-Type: application/json' -d "$2" >/dev/null; }
test_c(){ curl -s -XPOST "$B/decisions/$1/tests" -H 'Content-Type: application/json' -d "$2" >/dev/null; }

# 1) 信贷审批（决策表，计算额度输出，已发布）
draft '{"key":"credit_approval","name":"信贷审批","kind":"decisionTable","hitPolicy":"U",
 "inputs":[{"id":"i1","label":"信用分","expression":"score"},{"id":"i2","label":"地区","expression":"region"}],
 "outputs":[{"id":"o1","name":"tier","label":"等级"},{"id":"o2","name":"maxLimit","label":"额度上限"}],
 "rules":[
   {"inputEntries":[">= 750","-"],"outputEntries":["\"A\"","income * 5"]},
   {"inputEntries":["[650..750)","\"north\""],"outputEntries":["\"B\"","income * 4"]},
   {"inputEntries":["[650..750)","-"],"outputEntries":["\"B\"","income * 3"]},
   {"inputEntries":["< 650","-"],"outputEntries":["\"C\"","0"]}
 ]}'
pub credit_approval

# 2) 折扣分级（决策表，First，已发布）
draft '{"key":"discount_tier","name":"折扣分级","kind":"decisionTable","hitPolicy":"F",
 "inputs":[{"id":"i1","label":"订单金额","expression":"amount"},{"id":"i2","label":"会员等级","expression":"memberLevel"}],
 "outputs":[{"id":"o1","name":"discount","label":"折扣率"}],
 "rules":[
   {"inputEntries":[">= 10000","\"gold\""],"outputEntries":["0.20"]},
   {"inputEntries":[">= 10000","-"],"outputEntries":["0.15"]},
   {"inputEntries":[">= 5000","-"],"outputEntries":["0.10"]},
   {"inputEntries":["-","-"],"outputEntries":["0.05"]}
 ]}'
pub discount_tier

# 3) 风险评分（决策表，故意留 25~60 空隙——演示 gap 分析）
draft '{"key":"risk_score","name":"风险评分","kind":"decisionTable","hitPolicy":"U",
 "inputs":[{"id":"i1","label":"年龄","expression":"age"}],
 "outputs":[{"id":"o1","name":"risk","label":"风险"}],
 "rules":[
   {"inputEntries":["< 25"],"outputEntries":["\"high\""]},
   {"inputEntries":[">= 60"],"outputEntries":["\"high\""]}
 ]}'

# 4) 贷款综合决策（决策图，R2：input→基础额度表→子决策 risk_score→计算 finalLimit→output）
draft '{"key":"loan_decision","name":"贷款综合决策","kind":"graph",
 "nodes":[
   {"id":"in","name":"输入","type":"input"},
   {"id":"base","name":"基础额度","type":"decisionTable","table":{"hitPolicy":"F",
     "inputs":[{"expression":"income"}],"outputs":[{"name":"baseLimit"}],
     "rules":[{"inputEntries":[">= 8000"],"outputEntries":["income * 5"]},{"inputEntries":["-"],"outputEntries":["income * 2"]}]}},
   {"id":"risk","name":"风险子决策","type":"decision","decisionKey":"risk_score"},
   {"id":"calc","name":"终额度","type":"expression","mappings":[{"key":"finalLimit","expression":"if risk = \"high\" then baseLimit * 0.5 else baseLimit"}]},
   {"id":"out","name":"输出","type":"output"}
 ],
 "edges":[{"source":"in","target":"base"},{"source":"base","target":"risk"},{"source":"risk","target":"calc"},{"source":"calc","target":"out"}]}'

# 5) 测试用例（信贷审批：2 通过 + 1 故意失败）
test_c credit_approval '{"name":"高分北方→A","input":{"score":800,"region":"north","income":10000},"expected":{"tier":"A","maxLimit":50000}}'
test_c credit_approval '{"name":"低分→C","input":{"score":500,"region":"south","income":6000},"expected":{"tier":"C","maxLimit":0}}'
test_c credit_approval '{"name":"中分应B(故意错期望)","input":{"score":680,"region":"north","income":8000},"expected":{"tier":"A"}}'

# 6) 求值若干次 → 生成决策日志（审计中心有数据）
evalk credit_approval '{"input":{"score":800,"region":"north","income":10000}}'
evalk credit_approval '{"input":{"score":680,"region":"south","income":8000}}'
evalk credit_approval '{"input":{"score":500,"region":"east","income":6000}}'
evalk discount_tier '{"input":{"amount":12000,"memberLevel":"gold"}}'
evalk discount_tier '{"input":{"amount":6000,"memberLevel":"silver"}}'
evalk discount_tier '{"input":{"amount":800,"memberLevel":"none"}}'

echo "✅ seed 完成：4 决策(credit_approval/discount_tier/risk_score 表 + loan_decision 图) + 3 用例 + 6 决策日志"
echo "   决策数: $(curl -s "$B/definitions" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["data"]))')"
