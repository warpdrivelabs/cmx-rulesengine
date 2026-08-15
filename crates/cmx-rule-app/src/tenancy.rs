//! 多租户：db-per-tenant 物理隔离（R3，镜像 flow S2）。
//!
//! 模式由 `RULE_TENANCY` 决定：`single`（默认，单库，零回归）| `multi`（每租户一库）。
//! multi 下按 [`current_tenant`](crate::tenant::current_tenant) 派生 db_id `rule_<tenant>`（小写——
//! 避 flow S6 记录的租户名大小写敏感坑），并在该租户首次访问时**懒注册**数据源（URL 由
//! `RULE_TENANT_DB_URL_TEMPLATE` 的 `{tenant}` 占位派生）+ 建表；single 下恒用 [`RULE_DB_ID`]。
//!
//! 规则引擎无长驻运行态，故 R3 比 flow S2 更简单：只需「按租户选 db_id + 懒备库」，无 per-tenant
//! 引擎实例缓存。

use cmx_database_pg::{DbConfig, DbType};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// 默认租户库 db_id（single 模式 / 无租户 scope）。
pub const RULE_DB_ID: &str = "rule_pg";

/// 租户模式（`RULE_TENANCY`，默认 single）。
fn mode() -> String {
    std::env::var("RULE_TENANCY").unwrap_or_else(|_| "single".to_string())
}

/// 是否多租户模式。
pub fn is_multi() -> bool {
    mode() == "multi"
}

/// 当前请求应使用的 db_id。single → [`RULE_DB_ID`]；multi → `rule_<tenant>`（小写）。
pub fn current_db_id() -> String {
    if is_multi() {
        format!("rule_{}", crate::tenant::current_tenant().to_lowercase())
    } else {
        RULE_DB_ID.to_string()
    }
}

static READY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn ready_set() -> &'static Mutex<HashSet<String>> {
    READY.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 确保当前租户库就绪（懒注册数据源 + 建表；每 db_id 一次）。single 模式：默认库已在 boot 注册，跳过。
/// 由认证中间件在建立租户 scope 后、handler 前调用。非致命：失败只 warn，端点后续返错便于诊断。
pub async fn ensure_current_ready() {
    if !is_multi() {
        return;
    }
    let db_id = current_db_id();
    {
        let set = ready_set().lock().unwrap();
        if set.contains(&db_id) {
            return;
        }
    }
    let tenant = crate::tenant::current_tenant().to_lowercase();
    let template = std::env::var("RULE_TENANT_DB_URL_TEMPLATE")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:5432/rules_{tenant}".to_string());
    let url = template.replace("{tenant}", &tenant);
    let cfg = DbConfig {
        db_type: DbType::Postgres,
        db_url: url,
        db_id: db_id.clone(),
        db_name: None,
        db_schema: Some("public".to_string()),
        default: false,
        pool_config: Default::default(),
        health_check_interval: 60,
        health_check_timeout: 5,
        domain_code: None,
        application_code: None,
        module_code: None,
        source_type: Some("default".to_string()),
    };
    if let Err(e) = cmx_service_base::register_pg_datasources(&[cfg]).await {
        tracing::warn!(db_id = %db_id, error = %e, "租户数据源注册失败");
        return;
    }
    let store = cmx_rule_store_pg::PgDecisionStore::new(db_id.clone());
    if let Err(e) = store.ensure_schema().await {
        tracing::warn!(db_id = %db_id, error = %e, "租户建表失败");
        return;
    }
    ready_set().lock().unwrap().insert(db_id.clone());
    tracing::info!(db_id = %db_id, "✅ 租户库就绪（数据源 + schema）");
}
