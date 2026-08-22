//! 驱动无关的持久化契约（引擎不认识任何数据库；PG 实现见 cmx-rule-store-pg）。
//!
//! 对标 cmx-flow-model 的 `RuntimeStore`，但规则引擎**无长驻运行态**，故契约只覆盖：
//! 决策定义读写、发布态列表、决策日志追加（审计）。无令牌/任务/快照。

use crate::def::{DecisionDef, DecisionDefMeta, DecisionLog, RuleCategory};
use crate::StoreResult;
use async_trait::async_trait;

/// 决策定义与决策日志的存储契约。所有方法按租户隔离（单租户传 "default"）。
#[async_trait]
pub trait DecisionStore: Send + Sync {
    /// 按 key 装载激活版本的决策定义（无则 None）。
    async fn load_definition(&self, tenant: &str, key: &str) -> StoreResult<Option<DecisionDef>>;

    /// 保存决策定义（草稿态 upsert；发布另经 def 层建 release）。
    async fn save_definition(&self, tenant: &str, def: &DecisionDef) -> StoreResult<()>;

    /// 列出租户下所有决策定义元数据。
    async fn list_definitions(&self, tenant: &str) -> StoreResult<Vec<DecisionDefMeta>>;

    /// 追加一条决策日志（审计 + 可解释性）。
    async fn append_log(&self, tenant: &str, log: &DecisionLog) -> StoreResult<()>;

    /// 列出受管分类字典（按 ord 升序）。
    async fn list_categories(&self, tenant: &str) -> StoreResult<Vec<RuleCategory>>;

    /// upsert 一个分类（按 code）。
    async fn save_category(&self, tenant: &str, cat: &RuleCategory) -> StoreResult<()>;

    /// 删除一个分类（引用它的决策集不动，前端归「未分类」）。
    async fn delete_category(&self, tenant: &str, code: &str) -> StoreResult<()>;
}
