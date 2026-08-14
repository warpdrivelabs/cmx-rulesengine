//! 决策定义 / 元数据 / 决策日志 DTO（引擎 ↔ 存储 ↔ API 流转单元）。

use crate::ir::DecisionTable;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 决策体：一个决策"是什么"。R0 仅单决策表；R2 加 `Graph`（JDM 式 DAG）变体。
///
/// internally tagged（`kind` 字段）——与 GoRules JDM 的节点类型标注同构，且 R2 加变体不破坏 R0 JSON。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum DecisionBody {
    /// 单决策表（R0）。序列化为 `{"kind":"decisionTable", "hitPolicy":…, "inputs":…, …}`。
    #[serde(rename = "decisionTable")]
    DecisionTable(DecisionTable),
    // R2: #[serde(rename = "graph")] Graph(crate::ir::DecisionGraph),
}

/// 决策定义（设计器产物 / 引擎输入）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionDef {
    /// 稳定业务键（跨版本不变，evaluate 按它寻址）。
    pub key: String,
    /// 展示名。
    #[serde(default)]
    pub name: String,
    /// 版本号（发布 +1；求值装载激活版本）。
    #[serde(default = "default_version")]
    pub version: u32,
    /// 决策体（flatten 进顶层：`{key,name,version,kind,...}`）。
    #[serde(flatten)]
    pub body: DecisionBody,
}

fn default_version() -> u32 {
    1
}

impl DecisionDef {
    /// 结构自检（委派给决策体）。
    pub fn validate(&self) -> crate::Result<()> {
        match &self.body {
            DecisionBody::DecisionTable(t) => t.validate(),
        }
    }
}

/// 决策定义元数据（列表/浏览用，不含决策体）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionDefMeta {
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_version")]
    pub version: u32,
    /// 是否已发布（有不可变 release）。
    #[serde(default)]
    pub published: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

/// 决策日志（每次求值一条，审计 + 可解释性下钻）—— 规则引擎的"历史态"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionLog {
    /// 日志 id。
    pub id: String,
    /// 决策 key + 求值时的版本。
    pub decision_key: String,
    pub decision_version: u32,
    /// 输入事实。
    pub input: Value,
    /// 决策输出。
    pub output: Value,
    /// 序列化的逐节点 trace（`Vec<TraceNode>`）。
    pub trace: Value,
    /// 求值耗时（微秒）。
    #[serde(default)]
    pub timing_us: u64,
    /// 调用方（JWT user / 服务名；可空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    /// 失败归因（None = 成功决策）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    /// 求值时刻。
    pub created_at: DateTime<Utc>,
}
