//! 决策图求值（R2，JDM 式 DAG）——拓扑序遍历，上下文左→右累积。
//!
//! 节点：input（入口，提供事实）/ output（出口，收集累积上下文）/ decisionTable（决策表求值，输出并入
//! 上下文）/ expression（FEEL 字段变换并入）/ decision（子决策递归，`DecisionResolver` 装载，深度限）。
//! 对标 GoRules JDM 的「数据左→右流经节点累积」模型。

use cmx_rule_model::{DecisionGraph, DecisionDef, EvalContext, EvalResult, TraceNode};
use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};

/// 子决策解析器：按 key 装载决策定义（供 decision 节点递归）。
pub trait DecisionResolver {
    fn resolve(&self, key: &str) -> Option<DecisionDef>;
}

/// 空解析器（无子决策；decision 节点将失败归因）。
pub struct NoResolver;
impl DecisionResolver for NoResolver {
    fn resolve(&self, _key: &str) -> Option<DecisionDef> {
        None
    }
}

/// 内存解析器（预加载 key→def 映射；app 层 BFS 预取后传入）。
pub struct MapResolver(pub HashMap<String, DecisionDef>);
impl DecisionResolver for MapResolver {
    fn resolve(&self, key: &str) -> Option<DecisionDef> {
        self.0.get(key).cloned()
    }
}

/// 子决策嵌套深度上限（对标 GoRules 默认防无限递归）。
const MAX_DEPTH: usize = 8;

/// 收集图中所有 decision 节点引用的子决策 key（app 层据此 BFS 预加载解析器）。
pub fn collect_decision_keys(g: &DecisionGraph) -> Vec<String> {
    g.nodes
        .iter()
        .filter(|n| n.node_type == "decision")
        .filter_map(|n| n.decision_key.clone())
        .collect()
}

/// 求值决策图。永不 panic：任何节点失败落入其 trace 的 `failure`。
pub fn evaluate_graph(
    g: &DecisionGraph,
    ctx: &EvalContext,
    resolver: &dyn DecisionResolver,
    depth: usize,
) -> EvalResult {
    let input_snapshot = ctx.input.clone();
    if depth > MAX_DEPTH {
        return one_fail(input_snapshot, "子决策嵌套过深（可能存在循环引用）".into());
    }
    if let Err(e) = g.validate() {
        return one_fail(input_snapshot, format!("决策图结构非法: {e}"));
    }
    let order = match topo_order(g) {
        Ok(o) => o,
        Err(e) => return one_fail(input_snapshot, e),
    };

    // 上下文累积：起始 = 输入事实对象。
    let mut context: Map<String, Value> = match &ctx.input {
        Value::Object(m) => m.clone(),
        _ => Map::new(),
    };
    let mut trace = Vec::new();
    let mut output = Value::Object(context.clone());

    for &ni in &order {
        let node = &g.nodes[ni];
        let node_ctx = Value::Object(context.clone());
        match node.node_type.as_str() {
            "input" => trace.push(ok_node(&node.id, "input", node_ctx.clone(), node_ctx)),
            "output" => {
                output = Value::Object(context.clone());
                trace.push(ok_node(&node.id, "output", node_ctx, output.clone()));
            }
            "decisionTable" => match &node.table {
                Some(t) => {
                    let tn = crate::evaluate_table(t, &EvalContext::new(node_ctx), &node.id);
                    merge(&mut context, &tn.output);
                    trace.push(tn);
                }
                None => trace.push(fail(&node.id, node_ctx, "决策表节点缺 table".into())),
            },
            "expression" => {
                let mut obj = Map::new();
                let mut err = None;
                for m in &node.mappings {
                    match cmx_rule_feel::eval_output(&m.expression, &node_ctx) {
                        Ok(v) => {
                            obj.insert(m.key.clone(), v);
                        }
                        Err(e) => {
                            err = Some(format!("字段 {:?} 表达式 {:?} —— {e}", m.key, m.expression));
                            break;
                        }
                    }
                }
                match err {
                    Some(msg) => trace.push(fail(&node.id, node_ctx, msg)),
                    None => {
                        let out = Value::Object(obj);
                        merge(&mut context, &out);
                        trace.push(ok_node(&node.id, "expression", node_ctx, out));
                    }
                }
            }
            "decision" => {
                let key = node.decision_key.clone().unwrap_or_default();
                match resolver.resolve(&key) {
                    Some(sub) => {
                        let sub_res = crate::evaluate_with(
                            &sub,
                            &EvalContext::new(node_ctx.clone()),
                            resolver,
                            depth + 1,
                        );
                        merge(&mut context, &sub_res.output);
                        trace.push(ok_node(&node.id, "decision", node_ctx, sub_res.output.clone()));
                        trace.extend(sub_res.trace); // 子决策逐节点 trace 并入
                    }
                    None => trace.push(fail(&node.id, node_ctx, format!("子决策未找到: {key}"))),
                }
            }
            other => trace.push(fail(&node.id, node_ctx, format!("未知节点类型: {other}"))),
        }
    }
    EvalResult { output, trace }
}

/// 合并节点输出对象的字段到累积上下文（非对象输出忽略）。
fn merge(ctx: &mut Map<String, Value>, out: &Value) {
    if let Value::Object(m) = out {
        for (k, v) in m {
            ctx.insert(k.clone(), v.clone());
        }
    }
}

/// Kahn 拓扑排序；有环 → Err。无边时按声明序。
fn topo_order(g: &DecisionGraph) -> Result<Vec<usize>, String> {
    let n = g.nodes.len();
    let idx: HashMap<&str, usize> = g.nodes.iter().enumerate().map(|(i, nd)| (nd.id.as_str(), i)).collect();
    let mut indeg = vec![0usize; n];
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for e in &g.edges {
        if let (Some(&s), Some(&t)) = (idx.get(e.source.as_str()), idx.get(e.target.as_str())) {
            adj[s].push(t);
            indeg[t] += 1;
        }
    }
    let mut q: VecDeque<usize> = (0..n).filter(|&i| indeg[i] == 0).collect();
    let mut order = Vec::with_capacity(n);
    while let Some(u) = q.pop_front() {
        order.push(u);
        for &v in &adj[u] {
            indeg[v] -= 1;
            if indeg[v] == 0 {
                q.push_back(v);
            }
        }
    }
    if order.len() != n {
        Err("决策图存在环".into())
    } else {
        Ok(order)
    }
}

fn ok_node(id: &str, kind: &str, input: Value, output: Value) -> TraceNode {
    TraceNode {
        node_id: id.to_string(),
        node_kind: kind.to_string(),
        matched_rules: Vec::new(),
        input,
        output,
        timing_us: 0,
        failure: None,
    }
}
fn fail(id: &str, input: Value, msg: String) -> TraceNode {
    tracing::warn!(node = id, "决策图节点失败: {msg}");
    TraceNode {
        node_id: id.to_string(),
        node_kind: "graph".to_string(),
        matched_rules: Vec::new(),
        input,
        output: Value::Null,
        timing_us: 0,
        failure: Some(msg),
    }
}
fn one_fail(input: Value, msg: String) -> EvalResult {
    EvalResult {
        output: Value::Null,
        trace: vec![fail("graph", input, msg)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 图：input → 决策表(定档) → expression(算额度) → output
    fn tier_graph() -> DecisionGraph {
        serde_json::from_value(json!({
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "tbl", "type": "decisionTable", "table": {
                    "hitPolicy": "F",
                    "inputs": [ { "expression": "score" } ],
                    "outputs": [ { "name": "tier" }, { "name": "rate" } ],
                    "rules": [
                        { "inputEntries": [">= 700"], "outputEntries": ["\"A\"", "5"] },
                        { "inputEntries": ["-"], "outputEntries": ["\"B\"", "3"] }
                    ]
                }},
                { "id": "calc", "type": "expression", "mappings": [
                    { "key": "maxLimit", "expression": "income * rate" }
                ]},
                { "id": "out", "type": "output" }
            ],
            "edges": [
                { "source": "in", "target": "tbl" },
                { "source": "tbl", "target": "calc" },
                { "source": "calc", "target": "out" }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn graph_chains_table_and_expression() {
        let g = tier_graph();
        let ctx = EvalContext::new(json!({ "score": 800, "income": 10000 }));
        let r = evaluate_graph(&g, &ctx, &NoResolver, 0);
        assert!(!r.has_failure(), "trace: {:?}", r.trace);
        let out = r.output.as_object().unwrap();
        assert_eq!(out.get("tier"), Some(&json!("A")));
        assert_eq!(out.get("rate"), Some(&json!(5.0)));
        assert_eq!(out.get("maxLimit"), Some(&json!(50000.0))); // income*rate = 10000*5
    }

    #[test]
    fn graph_sub_decision_via_resolver() {
        // 主图有一个 decision 节点引用子决策 "sub"（决策表）。
        let main: DecisionDef = serde_json::from_value(json!({
            "key": "main", "kind": "graph",
            "nodes": [
                { "id": "in", "type": "input" },
                { "id": "d", "type": "decision", "decisionKey": "sub" },
                { "id": "out", "type": "output" }
            ],
            "edges": [ { "source": "in", "target": "d" }, { "source": "d", "target": "out" } ]
        }))
        .unwrap();
        let sub: DecisionDef = serde_json::from_value(json!({
            "key": "sub", "kind": "decisionTable", "hitPolicy": "F",
            "inputs": [ { "expression": "score" } ], "outputs": [ { "name": "grade" } ],
            "rules": [ { "inputEntries": [">= 60"], "outputEntries": ["\"pass\""] }, { "inputEntries": ["-"], "outputEntries": ["\"fail\""] } ]
        }))
        .unwrap();
        let mut map = std::collections::HashMap::new();
        map.insert("sub".to_string(), sub);
        let resolver = MapResolver(map);
        let r = crate::evaluate_with(&main, &EvalContext::new(json!({ "score": 75 })), &resolver, 0);
        assert!(!r.has_failure(), "trace: {:?}", r.trace);
        assert_eq!(r.output.get("grade"), Some(&json!("pass")));
    }

    #[test]
    fn graph_cycle_fails() {
        let g: DecisionGraph = serde_json::from_value(json!({
            "nodes": [ { "id": "a", "type": "input" }, { "id": "b", "type": "output" } ],
            "edges": [ { "source": "a", "target": "b" }, { "source": "b", "target": "a" } ]
        }))
        .unwrap();
        let r = evaluate_graph(&g, &EvalContext::new(json!({})), &NoResolver, 0);
        assert!(r.has_failure());
        assert!(r.trace[0].failure.as_ref().unwrap().contains("环"));
    }
}
