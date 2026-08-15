//! 决策存储访问 + 启动预热（对标 cmx-flow-app::engine，但规则无长驻实例，**无 poller/无引擎状态**）。
//!
//! R3 多租户：[`store`] 按当前请求租户派生 db_id（见 [`crate::tenancy`]）返回一个轻量
//! [`PgDecisionStore`]（仅裹 db_id，构造廉价）。single 模式恒用 [`RULE_DB_ID`]，零回归。

use cmx_rule_store_pg::PgDecisionStore;

/// 默认（single）租户库数据源 id；boot 注册，DDL 建 cmx_rule_* 表落此库。
pub const RULE_DB_ID: &str = crate::tenancy::RULE_DB_ID;

/// 取当前请求租户的决策存储（single → 默认库；multi → `rule_<tenant>`）。构造廉价（仅裹 db_id）。
pub fn store() -> PgDecisionStore {
    PgDecisionStore::new(crate::tenancy::current_db_id())
}

/// 启动钩子：建默认库表（single 模式的 RULE_DB_ID；multi 的租户库由 tenancy::ensure_current_ready 懒建）。
/// 非致命——DB/schema 不可用只 warn，服务仍起（端点返错便于诊断）。**不起后台线程**。
pub async fn warm_store() -> Result<(), String> {
    PgDecisionStore::new(RULE_DB_ID)
        .ensure_schema()
        .await
        .map_err(|e| format!("建表失败: {e}"))?;
    tracing::info!(db = RULE_DB_ID, "✅ 决策存储 schema 就绪（规则引擎无 poller，纯请求驱动）");
    Ok(())
}
