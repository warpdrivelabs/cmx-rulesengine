//! 求值上下文与结果（driver 无关）。
//!
//! - [`EvalContext`]：一次决策的输入事实容器 + JSON 路径取值（供输入列表达式 R0 取值）。
//! - [`TraceNode`]：单节点求值轨迹，**含失败归因** `failure`（GoRules ZEN 的 trace 不显示"哪个
//!   节点导致失败"，这是本引擎刻意补齐的世界级可解释性）。
//! - [`EvalResult`]：最终输出 + 全 trace 树。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 一次决策求值的输入事实容器。
#[derive(Debug, Clone)]
pub struct EvalContext {
    /// 输入事实（通常是 JSON 对象）。
    pub input: Value,
}

impl EvalContext {
    /// 用输入事实构造。
    pub fn new(input: Value) -> Self {
        Self { input }
    }

    /// 按点分路径从输入事实取值（对齐 cmx-flow-model 的嵌套路径语义）：
    /// - 整名精确命中平坦 key 优先（历史数据存了字面量点号 key 时）；
    /// - 否则逐段下钻：对象取字段、数组取数字下标；
    /// - 任一段缺失 → `Value::Null`（不 panic，供 unary test 判 falsy）。
    pub fn get_path(&self, path: &str) -> Value {
        // 整名平坦 key 优先（let-chain：先判对象再取键）。
        if let Value::Object(map) = &self.input
            && let Some(v) = map.get(path)
        {
            return v.clone();
        }
        let mut cur = &self.input;
        for seg in path.split('.') {
            match cur {
                Value::Object(map) => match map.get(seg) {
                    Some(v) => cur = v,
                    None => return Value::Null,
                },
                Value::Array(arr) => match seg.parse::<usize>().ok().and_then(|i| arr.get(i)) {
                    Some(v) => cur = v,
                    None => return Value::Null,
                },
                _ => return Value::Null,
            }
        }
        cur.clone()
    }
}

/// 单节点求值轨迹（决策表 / R2 图节点各产一条）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceNode {
    /// 节点 id（决策表用其 key / 单表用 "decisionTable"）。
    pub node_id: String,
    /// 节点类型（"decisionTable"，R2 起 "expression"/"switch"/…）。
    pub node_kind: String,
    /// 命中的规则行号（0-based；多命中/聚合可多个；无命中为空）。
    #[serde(default)]
    pub matched_rules: Vec<usize>,
    /// 进入该节点时的输入快照（可解释性）。
    pub input: Value,
    /// 该节点产出的输出。
    pub output: Value,
    /// 求值耗时（微秒）。
    #[serde(default)]
    pub timing_us: u64,
    /// 失败归因（None = 成功）。**超越 ZEN**：定位到"哪个节点/为什么失败"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

/// 一次决策求值的最终结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalResult {
    /// 决策输出（命中行输出对象；多命中为数组；无命中为 null）。
    pub output: Value,
    /// 逐节点 trace（R0 单表 = 1 条；R2 图 = 多条）。
    pub trace: Vec<TraceNode>,
}

impl EvalResult {
    /// 该次求值是否有任一节点失败。
    pub fn has_failure(&self) -> bool {
        self.trace.iter().any(|t| t.failure.is_some())
    }
}
