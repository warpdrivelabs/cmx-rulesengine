#!/usr/bin/env bash
# deploy-cases.sh —— 部署费用报销 + 反洗钱两案例（docs/落地方案-财务风控双案例.md 配套脚本）
# 幂等，可反复跑。默认打直连 rules-server(:8094)。
#   ./deploy-cases.sh                          # 直连
#   B=http://host:8094/api/rules/v1 ./deploy-cases.sh
set -euo pipefail
B="${B:-http://127.0.0.1:8094/api/rules/v1}"
draft() { curl -s -XPOST "$B/definitions/draft" -H 'Content-Type: application/json' -d "$1" -o /dev/null -w "  draft %{http_code}\n"; }
pub()   { curl -s -XPOST "$B/definitions/$1/publish" -o /dev/null -w "  publish $1 %{http_code}\n"; }

echo "① 差旅标准";  draft '{"key":"travel_standard","name":"差旅住宿标准","kind":"decisionTable","hitPolicy":"F","inputs":[{"id":"i1","label":"职级","expression":"level"},{"id":"i2","label":"城市级别","expression":"cityTier"}],"outputs":[{"id":"o1","name":"hotelCap","label":"住宿上限"}],"rules":[{"inputEntries":[">= 5","-"],"outputEntries":["1000"]},{"inputEntries":["[3..5)","\"tier1\""],"outputEntries":["800"]},{"inputEntries":["[3..5)","-"],"outputEntries":["500"]},{"inputEntries":["< 3","\"tier1\""],"outputEntries":["500"]},{"inputEntries":["< 3","-"],"outputEntries":["300"]}]}'

echo "② 记账科目";  draft '{"key":"expense_account","name":"费用记账科目","kind":"decisionTable","hitPolicy":"F","inputs":[{"id":"i1","label":"费用类别","expression":"category"}],"outputs":[{"id":"o1","name":"debit","label":"借方科目"},{"id":"o2","name":"debitName","label":"科目名称"}],"rules":[{"inputEntries":["\"travel\""],"outputEntries":["\"660101\"","\"差旅费\""]},{"inputEntries":["\"office\""],"outputEntries":["\"660102\"","\"办公费\""]},{"inputEntries":["\"meal\""],"outputEntries":["\"660103\"","\"业务招待费\""]},{"inputEntries":["-"],"outputEntries":["\"660199\"","\"其他费用\""]}]}'

echo "③ 费用报销主图"; draft '{"key":"expense_claim","name":"费用报销智能处理","kind":"graph","nodes":[{"id":"in","name":"报销单","type":"input"},{"id":"std","name":"差旅标准","type":"decision","decisionKey":"travel_standard"},{"id":"chk","name":"超标与审批判定","type":"expression","mappings":[{"key":"isOverLimit","expression":"if category = \"travel\" then amount > hotelCap else false"},{"key":"approvalLevel","expression":"if category = \"travel\" and amount > hotelCap then \"manager\" else if amount > 2000 then \"manager\" else \"auto\""}]},{"id":"acc","name":"记账科目","type":"decision","decisionKey":"expense_account"},{"id":"out","name":"处理结论","type":"output"}],"edges":[{"source":"in","target":"std"},{"source":"std","target":"chk"},{"source":"chk","target":"acc"},{"source":"acc","target":"out"}]}'

echo "④ 反洗钱预警"; draft '{"key":"aml_screening","name":"反洗钱交易预警","kind":"decisionTable","hitPolicy":"C","inputs":[{"id":"i1","label":"单笔金额","expression":"amount"},{"id":"i2","label":"当日累计","expression":"dailyTotal"},{"id":"i3","label":"对手方高风险国","expression":"counterpartyRisk"},{"id":"i4","label":"客户风险等级","expression":"customerRisk"}],"outputs":[{"id":"o1","name":"rule","label":"命中规则"},{"id":"o2","name":"score","label":"风险分"}],"rules":[{"inputEntries":[">= 50000","-","-","-"],"outputEntries":["\"大额交易\"","30"]},{"inputEntries":["-",">= 200000","-","-"],"outputEntries":["\"当日累计超限\"","40"]},{"inputEntries":["-","-","true","-"],"outputEntries":["\"涉高风险国\"","50"]},{"inputEntries":["-","-","-","\"high\""],"outputEntries":["\"高风险客户\"","35"]},{"inputEntries":["[9000..10000)","-","-","-"],"outputEntries":["\"疑似拆分规避\"","45"]}]}'

echo "发布："; for k in travel_standard expense_account expense_claim aml_screening; do pub "$k"; done
echo "✅ 完成。求值示例："
echo "  curl -XPOST $B/decisions/expense_claim/evaluate -H 'Content-Type: application/json' -d '{\"input\":{\"level\":4,\"cityTier\":\"tier1\",\"category\":\"travel\",\"amount\":900}}'"
