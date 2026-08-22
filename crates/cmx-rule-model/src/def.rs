//! 决策定义 / 元数据 / 决策日志 DTO（引擎 ↔ 存储 ↔ API 流转单元）。

use crate::ir::{DecisionGraph, DecisionTable, ScriptBody};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 决策体：一个决策"是什么"。R0 单决策表；R2 加 `Graph`（JDM 式 DAG）；SC4 加 `Script`（脚本决策）。
///
/// internally tagged（`kind` 字段）——与 GoRules JDM 的节点类型标注同构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum DecisionBody {
    /// 单决策表（R0）。序列化为 `{"kind":"decisionTable", "hitPolicy":…, "inputs":…, …}`。
    #[serde(rename = "decisionTable")]
    DecisionTable(DecisionTable),
    /// 决策图（R2，JDM 式 DAG）。序列化为 `{"kind":"graph", "nodes":[…], "edges":[…]}`。
    #[serde(rename = "graph")]
    Graph(DecisionGraph),
    /// 脚本决策（SC4）。序列化为 `{"kind":"script", "lang":"rhai", "script":"…"}`。
    #[serde(rename = "script")]
    Script(ScriptBody),
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
    /// 所属分类 code（受管分类字典 [`RuleCategory`] 的 code；None/空=未分类）。仅设计期组织用，求值不依赖。
    #[serde(default, rename = "categoryCode", skip_serializing_if = "Option::is_none")]
    pub category_code: Option<String>,
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
            DecisionBody::Graph(g) => g.validate(),
            DecisionBody::Script(s) => s.validate(),
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
    /// 所属分类 code（未分类=None）。前端按它分组展示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

/// 受管分类字典项（决策集的「分类」；per-tenant DB，无 tenant 列）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleCategory {
    /// 分类 code（稳定键，决策集 `category_code` 引用它）。
    pub code: String,
    /// 展示名。
    #[serde(default)]
    pub name: String,
    /// 排序（升序；前端组顺序按它，未分类置底）。
    #[serde(default)]
    pub ord: i32,
}

/// 决策日志（每次求值一条，审计 + 可解释性下钻）—— 规则引擎的"历史态"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionLog {    /// 日志 id。
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

/// 不可变发布元数据（`cmx_rule_release` 一行）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseMeta {
    pub id: String,
    pub key: String,
    pub version: u32,
    /// 发布时决策体的内容哈希（xxhash64→16hex）。
    pub rev: String,
    /// 是否为当前激活版本（求值装载它）。
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_by: Option<String>,
    pub published_at: DateTime<Utc>,
}

/// 测试用例（`cmx_rule_test_case` 一行）：输入 → 期望输出，供仿真回归 + 覆盖率。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCase {
    pub id: String,
    pub decision_key: String,
    #[serde(default)]
    pub name: String,
    pub input: Value,
    /// 期望输出（决策的 output）。
    pub expected: Value,
    pub created_at: DateTime<Utc>,
}

/// 脚本函数库条目（`cmx_rule_script_function` 一行，SC3）——可复用 Rhai 函数。
///
/// 求值前引擎把租户的**已发布**函数注册进 Rhai `Engine`，决策表/图/脚本决策皆可 `name(args)` 调用。
/// `name` 为调用标识（PK）；`params` 供设计器提示（求值实际以脚本体 fn 声明为准）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFunction {
    /// 函数名（调用标识 + PK）。
    pub name: String,
    /// 参数名数组（设计器提示用）。
    #[serde(default)]
    pub params: Vec<String>,
    /// 脚本体（Rhai）。P2：以 `fn name(params) { ... }` 声明，或裸表达式（按 params 包装）。
    pub body: String,
    /// 语言（默认 "rhai"）。
    #[serde(default = "default_script_lang")]
    pub lang: String,
    /// 版本。
    #[serde(default = "default_version")]
    pub version: u32,
    /// 是否已发布（求值只注册已发布函数）。
    #[serde(default)]
    pub published: bool,
    /// 说明。
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

fn default_script_lang() -> String {
    "rhai".to_string()
}
