//! 决策存储单例 + 数据源常量 + 求值/装载助手（对标 cmx-flow-app::engine，但规则无长驻实例，
//! 故这里只持久层单例 + 预编译缓存，**无 poller、无引擎实例状态**）。
//!
//! R0：进程级单一 [`PgDecisionStore`]（default 租户）。R3 改 OnceCell-per-tenant 缓存。

use cmx_rule_store_pg::PgDecisionStore;
use std::sync::OnceLock;

/// 规则运行库数据源 id（注册时对齐；DDL 建 cmx_rule_* 表落此库）。
pub const RULE_DB_ID: &str = "rule_pg";

static STORE: OnceLock<PgDecisionStore> = OnceLock::new();

/// 取（或初始化）默认决策存储单例。
pub fn store() -> &'static PgDecisionStore {
    STORE.get_or_init(|| PgDecisionStore::new(RULE_DB_ID))
}

/// 启动钩子：建表 + 预热（R0 仅建表；R2 起预编译已发布决策图到内存缓存，仿 ZEN compiled_cache）。
/// 非致命——DB/schema 不可用只 warn，服务仍起（端点返错便于诊断）。对标 flow 的 spawn_timer_poller
/// 之"建表 + 装载"，但**不起后台线程**。
pub async fn warm_store() -> Result<(), String> {
    store()
        .ensure_schema()
        .await
        .map_err(|e| format!("建表失败: {e}"))?;
    tracing::info!(db = RULE_DB_ID, "✅ 决策存储 schema 就绪（规则引擎无 poller，纯请求驱动）");
    Ok(())
}
