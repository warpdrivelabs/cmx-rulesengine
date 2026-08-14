//! cmx-rule-model —— 规则引擎的语义中立内核。
//!
//! 对外导出（稳定浅层 API）：
//! - IR：[`DecisionTable`] / [`HitPolicy`] / [`InputClause`] / [`OutputClause`] / [`DecisionRule`]
//! - 定义：[`DecisionDef`] / [`DecisionBody`] / [`DecisionDefMeta`] / [`DecisionLog`]
//! - 运行态：[`EvalContext`] / [`EvalResult`] / [`TraceNode`]
//! - 完整性：[`CoverageReport`] / [`Gap`] / [`Overlap`]
//! - 契约：[`DecisionStore`]（驱动无关持久化）
//!
//! 本 crate 不依赖任何数据库 / 任何 cmx-* infra，可 wasm / 嵌入式复用。

pub mod analyze;
pub mod def;
pub mod error;
pub mod eval;
pub mod ir;
pub mod store;

pub use analyze::{CoverageReport, Gap, Overlap};
pub use def::{DecisionBody, DecisionDef, DecisionDefMeta, DecisionLog};
pub use error::{Error, Result, StoreError, StoreResult};
pub use eval::{EvalContext, EvalResult, TraceNode};
pub use ir::{DecisionRule, DecisionTable, HitPolicy, InputClause, OutputClause};
pub use store::DecisionStore;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn get_path_nested_and_flat_and_missing() {
        let ctx = EvalContext::new(json!({
            "amount": 1500,
            "order": { "region": "north", "buyer": { "vip": true } },
            "items": [ { "qty": 3 }, { "qty": 9 } ],
            "order.amount": 42
        }));
        assert_eq!(ctx.get_path("amount"), json!(1500));
        assert_eq!(ctx.get_path("order.region"), json!("north"));
        assert_eq!(ctx.get_path("order.buyer.vip"), json!(true));
        assert_eq!(ctx.get_path("items.1.qty"), json!(9));
        // 整名平坦 key 优先于下钻。
        assert_eq!(ctx.get_path("order.amount"), json!(42));
        // 缺失 → null（不 panic）。
        assert_eq!(ctx.get_path("nope.deep"), json!(null));
    }

    #[test]
    fn table_validate_row_arity() {
        let mk = |ie: Vec<&str>, oe: Vec<&str>| DecisionRule {
            id: String::new(),
            input_entries: ie.into_iter().map(String::from).collect(),
            output_entries: oe.into_iter().map(String::from).collect(),
            annotation: None,
        };
        let ok = DecisionTable {
            hit_policy: HitPolicy::Unique,
            inputs: vec![InputClause { id: "i1".into(), label: String::new(), expression: "amount".into() }],
            outputs: vec![OutputClause { id: "o1".into(), label: String::new(), name: "tier".into() }],
            rules: vec![mk(vec!["> 1000"], vec!["\"A\""])],
        };
        assert!(ok.validate().is_ok());

        // 输入项数与列数不符 → Err。
        let bad = DecisionTable {
            rules: vec![mk(vec!["> 1000", "extra"], vec!["\"A\""])],
            ..ok.clone()
        };
        assert!(bad.validate().is_err());

        // 无输出列 → Err。
        let no_out = DecisionTable { outputs: vec![], ..ok.clone() };
        assert!(no_out.validate().is_err());
    }

    #[test]
    fn hit_policy_dmn_codes() {
        assert_eq!(serde_json::to_string(&HitPolicy::Unique).unwrap(), "\"U\"");
        assert_eq!(serde_json::to_string(&HitPolicy::CollectSum).unwrap(), "\"C+\"");
        assert_eq!(serde_json::to_string(&HitPolicy::CollectCount).unwrap(), "\"C#\"");
        assert_eq!(
            serde_json::from_str::<HitPolicy>("\"C>\"").unwrap(),
            HitPolicy::CollectMax
        );
        assert!(HitPolicy::Collect.is_multi());
        assert!(HitPolicy::CollectSum.is_aggregate());
        assert!(!HitPolicy::Unique.is_multi());
    }

    #[test]
    fn decision_def_json_roundtrip_with_kind_tag() {
        let src = json!({
            "key": "credit_approval",
            "name": "信贷审批",
            "version": 2,
            "kind": "decisionTable",
            "hitPolicy": "F",
            "inputs": [ { "id": "i1", "expression": "score" } ],
            "outputs": [ { "id": "o1", "name": "approved" } ],
            "rules": [ { "inputEntries": [">= 700"], "outputEntries": ["true"] } ]
        });
        let def: DecisionDef = serde_json::from_value(src).unwrap();
        assert_eq!(def.key, "credit_approval");
        assert_eq!(def.version, 2);
        assert!(def.validate().is_ok());
        match &def.body {
            DecisionBody::DecisionTable(t) => {
                assert_eq!(t.hit_policy, HitPolicy::First);
                assert_eq!(t.inputs.len(), 1);
            }
        }
        // 往返回 JSON：kind 标签仍在。
        let back = serde_json::to_value(&def).unwrap();
        assert_eq!(back["kind"], json!("decisionTable"));
        assert_eq!(back["hitPolicy"], json!("F"));
    }
}
