//! 决策表 IR（编译产物，只读执行）—— 对标 OMG DMN 决策表 + GoRules 决策表节点。
//!
//! 决策表 = 输入列（每列一个取值表达式）× 规则行（每行各输入项 = 一个 unary test，行内 AND）
//! × 输出列。多行命中由**命中策略**裁决（[`HitPolicy`]，DMN 标准 11 变体）。
//!
//! R2 将新增 [`DecisionGraph`]（JDM 式 DAG，把多张决策表/表达式编排起来）；本文件 R0 只承载
//! 单决策表。为此 [`crate::def::DecisionBody`] 用 enum 固定形状，R2 加 `Graph` 变体不破坏 R0。

use serde::{Deserialize, Serialize};

/// 决策表命中策略（DMN 标准 11 变体）。序列化用 DMN 单字母代号，利于与 DMN/Camunda/Drools 互通。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum HitPolicy {
    /// U —— 唯一：至多一行命中（重叠视为错误）。默认。
    #[default]
    #[serde(rename = "U")]
    Unique,
    /// A —— 任意：可重叠，但所有命中行输出须一致，取其一。
    #[serde(rename = "A")]
    Any,
    /// P —— 优先：多行命中时按输出值优先级取最高（R1 完善优先级列表）。
    #[serde(rename = "P")]
    Priority,
    /// F —— 首个：按行序取首个命中（DMN 视为不良实践，慎用）。
    #[serde(rename = "F")]
    First,
    /// C —— 收集：返回所有命中行输出的无序列表。
    #[serde(rename = "C")]
    Collect,
    /// R —— 规则序：返回所有命中行输出，按规则行序。
    #[serde(rename = "R")]
    RuleOrder,
    /// O —— 输出序：返回所有命中行输出，按输出优先级序（R1 完善）。
    #[serde(rename = "O")]
    OutputOrder,
    /// C+ —— 收集求和：命中行单一输出列求和。
    #[serde(rename = "C+")]
    CollectSum,
    /// C&lt; —— 收集取最小。
    #[serde(rename = "C<")]
    CollectMin,
    /// C&gt; —— 收集取最大。
    #[serde(rename = "C>")]
    CollectMax,
    /// C# —— 收集计数：命中行数。
    #[serde(rename = "C#")]
    CollectCount,
}

impl HitPolicy {
    /// 是否为"多命中"策略（返回列表而非单值）。
    pub fn is_multi(self) -> bool {
        matches!(self, Self::Collect | Self::RuleOrder | Self::OutputOrder)
    }
    /// 是否为 Collect 聚合（C+/C&lt;/C&gt;/C#，返回单一聚合值）。
    pub fn is_aggregate(self) -> bool {
        matches!(
            self,
            Self::CollectSum | Self::CollectMin | Self::CollectMax | Self::CollectCount
        )
    }
}

/// 输入列（input clause）。求值时按 [`expression`](Self::expression) 从输入事实取出该列待测值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputClause {
    /// 列 id（trace / gap-overlap 引用）。
    #[serde(default)]
    pub id: String,
    /// 展示名（业务可读，如 "申请金额"）。
    #[serde(default)]
    pub label: String,
    /// 取值表达式：作用于输入事实。R0 支持 JSON 路径（`amount` / `order.amount` / `items.0.qty`）。
    /// R1 起为完整 FEEL 表达式（由 cmx-rule-feel 求值）。
    pub expression: String,
}

/// 输出列（output clause）。命中行该列的输出表达式求值后写入 `output[name]`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputClause {
    /// 列 id。
    #[serde(default)]
    pub id: String,
    /// 展示名。
    #[serde(default)]
    pub label: String,
    /// 输出对象的键名（命中行该列值写入 `output[name]`）。
    pub name: String,
}

/// 规则行（decision rule）。行内各输入项 AND；命中则各输出项求值写入输出。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRule {
    /// 规则 id（稳定业务键，利于协同编辑 / trace）。
    #[serde(default)]
    pub id: String,
    /// 每个输入列一个 unary test 文本；长度须 = `inputs.len()`。`-` 或空串 = 通配（恒真）。
    /// 例：`> 700` / `[18..65)` / `"north","south"` / `true`。
    pub input_entries: Vec<String>,
    /// 每个输出列一个输出表达式；长度须 = `outputs.len()`。R0：字面量（数字/带引号字符串/bool/null）。
    pub output_entries: Vec<String>,
    /// 规则注释（可选，业务说明）。
    #[serde(default)]
    pub annotation: Option<String>,
}

/// 决策表（内核主体）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionTable {
    /// 命中策略（默认 U）。
    #[serde(default)]
    pub hit_policy: HitPolicy,
    /// 输入列。
    pub inputs: Vec<InputClause>,
    /// 输出列。
    pub outputs: Vec<OutputClause>,
    /// 规则行。
    pub rules: Vec<DecisionRule>,
}

impl DecisionTable {
    /// 结构自检：每条规则的输入/输出项数须与列数一致，且至少一个输出列。
    /// 在装载/发布时调用，避免运行期越界。
    pub fn validate(&self) -> crate::Result<()> {
        if self.outputs.is_empty() {
            return Err(crate::Error::Definition("决策表至少需一个输出列".into()));
        }
        let (ni, no) = (self.inputs.len(), self.outputs.len());
        for (i, r) in self.rules.iter().enumerate() {
            if r.input_entries.len() != ni {
                return Err(crate::Error::Definition(format!(
                    "规则行 {i} 输入项数 {} 与输入列数 {ni} 不符",
                    r.input_entries.len()
                )));
            }
            if r.output_entries.len() != no {
                return Err(crate::Error::Definition(format!(
                    "规则行 {i} 输出项数 {} 与输出列数 {no} 不符",
                    r.output_entries.len()
                )));
            }
        }
        Ok(())
    }
}
