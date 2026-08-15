//! 决策求值内核。R0：单决策表求值 + 11 命中策略 + trace（含失败归因）。
//!
//! 求值流程：对每条规则行，逐输入列取值（[`EvalContext::get_path`]）→ 该列 unary test 判真
//! （[`cmx_rule_feel::eval_unary_test`]）→ 行内全真则命中 → 按 [`HitPolicy`] 汇总命中行输出。
//!
//! **失败归因**（超越 ZEN）：任一单元格表达式解析/求值报错 → trace 该节点 `failure` 记明"哪条
//! 规则、哪个输入列、什么错"，而非静默吞掉或只抛顶层错。

use cmx_rule_model::{
    CoverageReport, DecisionBody, DecisionDef, DecisionRule, DecisionTable, EvalContext, EvalResult,
    HitPolicy, TraceNode,
};
use serde_json::{json, Value};

pub mod analyze;
pub mod graph;
pub use analyze::analyze_table;
pub use graph::{collect_decision_keys, evaluate_graph, DecisionResolver, MapResolver, NoResolver};

/// 求值一个决策定义（决策表或决策图）。图含子决策时用 [`evaluate_with`] 传入解析器。
pub fn evaluate(def: &DecisionDef, ctx: &EvalContext) -> EvalResult {
    evaluate_with(def, ctx, &graph::NoResolver, 0)
}

/// 求值决策定义，可注入子决策解析器 + 递归深度（决策图的 decision 节点用）。
pub fn evaluate_with(
    def: &DecisionDef,
    ctx: &EvalContext,
    resolver: &dyn DecisionResolver,
    depth: usize,
) -> EvalResult {
    match &def.body {
        DecisionBody::DecisionTable(table) => {
            let node = evaluate_table(table, ctx, "decisionTable");
            let output = node.output.clone();
            EvalResult {
                output,
                trace: vec![node],
            }
        }
        DecisionBody::Graph(g) => graph::evaluate_graph(g, ctx, resolver, depth),
    }
}

/// 决策定义的完整性分析（决策表直接分析；决策图聚合各决策表节点，node id 前缀区分）。
pub fn analyze_def(def: &DecisionDef) -> CoverageReport {
    match &def.body {
        DecisionBody::DecisionTable(t) => analyze::analyze_table(t),
        DecisionBody::Graph(g) => {
            let mut report = CoverageReport::default();
            for node in &g.nodes {
                if node.node_type == "decisionTable"
                    && let Some(t) = &node.table
                {
                    let r = analyze::analyze_table(t);
                    for mut gp in r.gaps {
                        gp.description = format!("[{}] {}", node.id, gp.description);
                        report.gaps.push(gp);
                    }
                    for mut ov in r.overlaps {
                        ov.description = format!("[{}] {}", node.id, ov.description);
                        report.overlaps.push(ov);
                    }
                }
            }
            report
        }
    }
}

/// 求值单张决策表，产一个 [`TraceNode`]。
pub fn evaluate_table(table: &DecisionTable, ctx: &EvalContext, node_id: &str) -> TraceNode {
    // 简易微秒计时：不引 Instant（保 wasm/确定性友好），R0 记 0；app 层用 wall clock 覆盖。
    let input_snapshot = ctx.input.clone();

    // 结构自检：非法表直接失败归因。
    if let Err(e) = table.validate() {
        return fail_node(node_id, input_snapshot, format!("决策表结构非法: {e}"));
    }

    // 逐规则行匹配。
    let mut matched: Vec<usize> = Vec::new();
    for (ri, rule) in table.rules.iter().enumerate() {
        match row_matches(table, rule, ctx) {
            Ok(true) => matched.push(ri),
            Ok(false) => {}
            Err(msg) => {
                // 失败归因：定位到规则行 + 输入列。
                return fail_node(
                    node_id,
                    input_snapshot,
                    format!("规则行 {ri} 求值失败: {msg}"),
                );
            }
        }
    }

    // 按命中策略汇总输出。
    match summarize(table, &matched, ctx) {
        Ok(output) => TraceNode {
            node_id: node_id.to_string(),
            node_kind: "decisionTable".to_string(),
            matched_rules: matched,
            input: input_snapshot,
            output,
            timing_us: 0,
            failure: None,
        },
        Err(msg) => fail_node(node_id, input_snapshot, msg),
    }
}

/// 一条规则行是否命中（行内各输入列 AND）。
fn row_matches(
    table: &DecisionTable,
    rule: &DecisionRule,
    ctx: &EvalContext,
) -> Result<bool, String> {
    for (ci, input) in table.inputs.iter().enumerate() {
        let cell = &rule.input_entries[ci];
        let value = ctx.get_path(&input.expression);
        // 操作数/裸布尔单测可引用其它输入变量（`> avgScore` / `contains(?, "vip")`），故传 ctx.input。
        let ok = cmx_rule_feel::eval_unary_test(cell, &value, &ctx.input)
            .map_err(|e| format!("输入列 {:?} 单测 {:?} —— {e}", input.expression, cell))?;
        if !ok {
            return Ok(false);
        }
    }
    Ok(true)
}

/// 是否有任一规则行命中给定输入（gap 分析用；求值出错按未命中）。
pub fn any_rule_matches(table: &DecisionTable, ctx: &EvalContext) -> bool {
    table
        .rules
        .iter()
        .any(|r| row_matches(table, r, ctx).unwrap_or(false))
}

/// 求值一条命中规则行的输出对象（各输出列为完整 FEEL 表达式，可引用输入事实）。
fn row_output(table: &DecisionTable, rule: &DecisionRule, ctx: &EvalContext) -> Result<Value, String> {
    let mut obj = serde_json::Map::new();
    for (ci, out) in table.outputs.iter().enumerate() {
        let expr = &rule.output_entries[ci];
        let v = cmx_rule_feel::eval_output(expr, &ctx.input)
            .map_err(|e| format!("输出列 {:?} 表达式 {:?} —— {e}", out.name, expr))?;
        obj.insert(out.name.clone(), v);
    }
    Ok(Value::Object(obj))
}

/// 按命中策略把命中行汇总成最终输出。
fn summarize(table: &DecisionTable, matched: &[usize], ctx: &EvalContext) -> Result<Value, String> {
    let hp = table.hit_policy;

    // 无命中：单命中/聚合 → null；多命中 → 空列表；C# → 0。
    if matched.is_empty() {
        return Ok(match hp {
            HitPolicy::Collect | HitPolicy::RuleOrder | HitPolicy::OutputOrder => json!([]),
            HitPolicy::CollectCount => json!(0),
            HitPolicy::CollectSum => json!(0.0),
            _ => Value::Null,
        });
    }

    let outputs: Result<Vec<Value>, String> =
        matched.iter().map(|&ri| row_output(table, &table.rules[ri], ctx)).collect();
    let outputs = outputs?;

    match hp {
        // —— 单命中 ——
        HitPolicy::Unique => {
            if matched.len() > 1 {
                return Err(format!(
                    "命中策略 UNIQUE 违反：规则行 {matched:?} 同时命中（存在重叠）"
                ));
            }
            Ok(outputs.into_iter().next().unwrap())
        }
        HitPolicy::Any => {
            // 所有命中行输出须一致。
            if outputs.iter().any(|o| o != &outputs[0]) {
                return Err(format!(
                    "命中策略 ANY 违反：规则行 {matched:?} 命中但输出不一致"
                ));
            }
            Ok(outputs.into_iter().next().unwrap())
        }
        HitPolicy::First => Ok(outputs.into_iter().next().unwrap()),
        // P/O 的优先级列表 R1 完善；R0 退化为取首个（行序）。
        HitPolicy::Priority | HitPolicy::OutputOrder => Ok(outputs.into_iter().next().unwrap()),
        // —— 多命中 ——
        HitPolicy::Collect | HitPolicy::RuleOrder => Ok(Value::Array(outputs)),
        // —— Collect 聚合（单一输出列）——
        HitPolicy::CollectCount => Ok(json!(matched.len())),
        HitPolicy::CollectSum | HitPolicy::CollectMin | HitPolicy::CollectMax => {
            let nums = single_output_numbers(table, &outputs)?;
            let agg = match hp {
                HitPolicy::CollectSum => nums.iter().sum::<f64>(),
                HitPolicy::CollectMin => nums.iter().cloned().fold(f64::INFINITY, f64::min),
                HitPolicy::CollectMax => nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                _ => unreachable!(),
            };
            Ok(json!(agg))
        }
    }
}

/// Collect 聚合要求恰好一个输出列且均为数值；取出数值序列。
fn single_output_numbers(table: &DecisionTable, outputs: &[Value]) -> Result<Vec<f64>, String> {
    if table.outputs.len() != 1 {
        return Err(format!(
            "Collect 聚合（C+/C</C>）要求恰一个输出列，实为 {}",
            table.outputs.len()
        ));
    }
    let name = &table.outputs[0].name;
    outputs
        .iter()
        .map(|o| {
            o.get(name)
                .and_then(|v| v.as_f64())
                .ok_or_else(|| format!("Collect 聚合输出列 {name:?} 含非数值"))
        })
        .collect()
}

/// 构造一个失败 trace 节点（失败归因）。
fn fail_node(node_id: &str, input: Value, msg: String) -> TraceNode {
    tracing::warn!(node = node_id, "决策求值失败: {msg}");
    TraceNode {
        node_id: node_id.to_string(),
        node_kind: "decisionTable".to_string(),
        matched_rules: Vec::new(),
        input,
        output: Value::Null,
        timing_us: 0,
        failure: Some(msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn credit_table(hp: HitPolicy) -> DecisionTable {
        // 输入: score, region ; 输出: tier
        serde_json::from_value(json!({
            "hitPolicy": serde_json::to_value(hp).unwrap(),
            "inputs": [
                { "id": "i1", "expression": "score" },
                { "id": "i2", "expression": "region" }
            ],
            "outputs": [ { "id": "o1", "name": "tier" } ],
            "rules": [
                { "inputEntries": [">= 750", "-"],            "outputEntries": ["\"A\""] },
                { "inputEntries": ["[650..750)", "\"north\""], "outputEntries": ["\"B\""] },
                { "inputEntries": ["< 650", "-"],             "outputEntries": ["\"C\""] }
            ]
        }))
        .unwrap()
    }

    fn eval(table: &DecisionTable, input: Value) -> TraceNode {
        evaluate_table(table, &EvalContext::new(input), "t")
    }

    #[test]
    fn unique_single_hit() {
        let t = credit_table(HitPolicy::Unique);
        let n = eval(&t, json!({ "score": 800, "region": "south" }));
        assert!(n.failure.is_none());
        assert_eq!(n.matched_rules, vec![0]);
        assert_eq!(n.output, json!({ "tier": "A" }));

        let n = eval(&t, json!({ "score": 700, "region": "north" }));
        assert_eq!(n.output, json!({ "tier": "B" }));

        let n = eval(&t, json!({ "score": 500, "region": "east" }));
        assert_eq!(n.output, json!({ "tier": "C" }));
    }

    #[test]
    fn unique_no_hit_is_null() {
        let t = credit_table(HitPolicy::Unique);
        // score 700 但 region 非 north → 行2 不中；行0/2 也不中 → 无命中。
        let n = eval(&t, json!({ "score": 700, "region": "south" }));
        assert!(n.failure.is_none());
        assert!(n.matched_rules.is_empty());
        assert_eq!(n.output, json!(null));
    }

    #[test]
    fn unique_overlap_is_failure_with_attribution() {
        // 构造重叠：两行都可命中 score=800。
        let t: DecisionTable = serde_json::from_value(json!({
            "hitPolicy": "U",
            "inputs": [ { "expression": "score" } ],
            "outputs": [ { "name": "tier" } ],
            "rules": [
                { "inputEntries": ["> 700"], "outputEntries": ["\"A\""] },
                { "inputEntries": ["> 750"], "outputEntries": ["\"B\""] }
            ]
        }))
        .unwrap();
        let n = eval(&t, json!({ "score": 800 }));
        assert!(n.failure.is_some(), "UNIQUE 重叠应失败");
        assert!(n.failure.unwrap().contains("UNIQUE"));
    }

    #[test]
    fn collect_and_aggregates() {
        // 单输出列 amount，三行都通配命中。
        let mk = |hp: &str| -> DecisionTable {
            serde_json::from_value(json!({
                "hitPolicy": hp,
                "inputs": [ { "expression": "x" } ],
                "outputs": [ { "name": "amount" } ],
                "rules": [
                    { "inputEntries": ["-"], "outputEntries": ["10"] },
                    { "inputEntries": ["-"], "outputEntries": ["30"] },
                    { "inputEntries": ["-"], "outputEntries": ["20"] }
                ]
            }))
            .unwrap()
        };
        assert_eq!(eval(&mk("C#"), json!({})).output, json!(3));
        assert_eq!(eval(&mk("C+"), json!({})).output, json!(60.0));
        assert_eq!(eval(&mk("C<"), json!({})).output, json!(10.0));
        assert_eq!(eval(&mk("C>"), json!({})).output, json!(30.0));
        // Collect 列表（顺序 = 规则行序）。
        assert_eq!(
            eval(&mk("C"), json!({})).output,
            json!([{"amount":10.0},{"amount":30.0},{"amount":20.0}])
        );
    }

    #[test]
    fn first_takes_row_order() {
        let t: DecisionTable = serde_json::from_value(json!({
            "hitPolicy": "F",
            "inputs": [ { "expression": "score" } ],
            "outputs": [ { "name": "tier" } ],
            "rules": [
                { "inputEntries": ["> 700"], "outputEntries": ["\"A\""] },
                { "inputEntries": ["> 750"], "outputEntries": ["\"B\""] }
            ]
        }))
        .unwrap();
        // 两行都中，FIRST 取首行。
        assert_eq!(eval(&t, json!({ "score": 800 })).output, json!({ "tier": "A" }));
    }

    #[test]
    fn evaluate_def_wraps_trace() {
        let def: DecisionDef = serde_json::from_value(json!({
            "key": "credit",
            "kind": "decisionTable",
            "hitPolicy": "U",
            "inputs": [ { "expression": "score" } ],
            "outputs": [ { "name": "tier" } ],
            "rules": [ { "inputEntries": [">= 700"], "outputEntries": ["\"A\""] } ]
        }))
        .unwrap();
        let r = evaluate(&def, &EvalContext::new(json!({ "score": 720 })));
        assert_eq!(r.trace.len(), 1);
        assert!(!r.has_failure());
        assert_eq!(r.output, json!({ "tier": "A" }));
    }
}
