//! cmx-rule-app —— cmx-rule 决策引擎的**平台中立应用层**（一芯）。
//!
//! **一芯多壳**：本 crate 是"芯"。handler 不绑 `State` 提取器，故 [`rule_routes::<S>()`] 对任意
//! state 泛型 `S` 成立：
//!   - 平台壳 `cmx-rule-api`（cmx-container 内）：`rule_routes::<CmxAppState>()`；
//!   - 独立壳 `cmx-rule-server`（本 workspace）：`rule_routes::<()>()`。
//!
//! 两壳复用同一 handler + 同一路由表，零业务漂移。

pub mod auth;
pub mod dashboard;
pub mod engine;
pub mod handlers;
pub mod native_pages;
pub mod openapi;
pub mod resp;
pub mod stats;
pub mod tenancy;
pub mod tenant;

pub use auth::auth as auth_middleware;
pub use engine::{warm_store, RULE_DB_ID};
pub use openapi::rule_openapi;
pub use resp::{ApiResp, Result, RuleError};
pub use tenant::{current_tenant, current_user, identity_snapshot};

use axum::routing::{delete, get, post};
use axum::Router;

/// 决策模块全部路由，**旧前缀 `/rules/*`**（内嵌壳兼容）。对任意 state 泛型 `S` 成立。
pub fn rule_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new().nest("/rules", rule_routes_inner::<S>())
}

/// 决策模块全部路由，**v1 正式契约前缀 `/rules/v1/*`**（R4 headless）。
pub fn rule_routes_v1<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new().nest("/rules/v1", rule_routes_inner::<S>())
}

/// 路由表本体（相对前缀）。
fn rule_routes_inner<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        // —— 定义（设计器：草稿/校验/列表/详情）——
        .route("/definitions", get(handlers::list_definitions))
        .route("/definitions/draft", post(handlers::save_draft))
        .route("/definitions/validate", post(handlers::validate_definition))
        .route(
            "/definitions/{key}",
            get(handlers::get_definition).delete(handlers::delete_definition),
        )
        // —— 发布 / 版本（F1）——
        .route("/definitions/{key}/publish", post(handlers::publish_definition))
        .route("/definitions/{key}/versions", get(handlers::list_versions))
        .route(
            "/definitions/{key}/versions/{version}/activate",
            post(handlers::activate_version),
        )
        // —— 求值（核心，无状态）——
        .route("/decisions/{key}/evaluate", post(handlers::evaluate_by_key))
        .route("/evaluate", post(handlers::evaluate_inline))
        // —— 仿真 / 完整性分析（F1）——
        .route("/decisions/{key}/simulate", post(handlers::simulate_by_key))
        .route("/decisions/{key}/analyze", post(handlers::analyze_decision))
        // —— 测试用例（F1）——
        .route(
            "/decisions/{key}/tests",
            get(handlers::list_tests).post(handlers::save_test),
        )
        .route("/decisions/{key}/tests/run", post(handlers::run_tests))
        .route("/decisions/{key}/tests/{id}", delete(handlers::delete_test))
        // —— 决策日志 / 审计（可解释性下钻）——
        .route("/decisions/{key}/logs", get(stats::list_logs))
        .route("/logs/{id}", get(stats::get_log))
        // —— FEEL 试算 / 校验 / 函数目录 ——
        .route("/feel/eval", post(handlers::feel_eval))
        .route("/feel/expression", post(handlers::feel_expression))
        .route("/feel/validate", post(handlers::feel_validate))
        .route("/feel/functions", get(handlers::feel_functions))
        // —— 监控大盘数据源 ——
        .route("/stats", get(stats::stats))
}
