//! rule 路由模块适配器——`ModuleRoutes<S>` 契约接入（bin 组合根消费）。
//!
//! [`crate::rule_routes`] / [`crate::rule_routes_v1`] 自由函数仍是路由真源（平台壳
//! `cmx-rule-api` 以 `S = CmxAppState` 直调），本模块仅以 unit struct 适配为契约模块，
//! 供独立壳 bin 以 [`crate::ModuleSet`] 组合（去重守卫 + 统一 fold）。v1 与旧前缀是同
//! inner 表的双前缀二重挂载，注册为两个模块（module_name 不同），去重守卫不误伤。

use axum::Router;

use cmx_engine_kit::routes::ModuleRoutes;

use crate::{rule_routes, rule_routes_v1};

/// 旧前缀 `/rules/*`（内嵌壳兼容）。
pub struct RuleCoreModule;

impl<S: Clone + Send + Sync + 'static> ModuleRoutes<S> for RuleCoreModule {
    fn routes(&self) -> Router<S> {
        rule_routes::<S>()
    }

    fn prefix(&self) -> &'static str {
        "/rules"
    }

    fn module_name(&self) -> &'static str {
        "rules.core"
    }
}

/// v1 正式契约 `/rules/v1/*`（R4 headless）。
pub struct RuleV1Module;

impl<S: Clone + Send + Sync + 'static> ModuleRoutes<S> for RuleV1Module {
    fn routes(&self) -> Router<S> {
        rule_routes_v1::<S>()
    }

    fn prefix(&self) -> &'static str {
        "/rules/v1"
    }

    fn module_name(&self) -> &'static str {
        "rules.v1"
    }
}
