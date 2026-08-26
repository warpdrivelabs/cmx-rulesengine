//! 请求级租户上下文（多租户 db-per-tenant，R3）。
//!
//! 镜像 cmx-flow-app::tenant（平台 context_scope 模式）：认证中间件在请求入口建 scope，请求生命
//! 周期内任意 `.await` 点都能无参读当前租户/用户/角色。
//!
//! **单租户零回归**：无 scope 时 `current_tenant()` 回退 [`DEFAULT_TENANT`]（等价单库形态）。

use tokio::task_local;

/// 默认租户名（无租户上下文时的回退）。
pub const DEFAULT_TENANT: &str = "default";

task_local! {
    static TENANT: TenantCtx;
}

/// 请求级租户上下文快照。
#[derive(Debug, Clone)]
pub struct TenantCtx {
    pub tenant: String,
    /// 当前用户 id（JWT sub；可空）。授权比对用此。
    pub user: Option<String>,
    /// 当前用户名（JWT `username` claim；可空——旧令牌/第三方精简令牌无）。留痕/审计
    /// 展示用 [`current_display_user`] 取「用户名优先、id 兜底」，勿拿 user 直接当姓名。
    pub username: Option<String>,
    pub roles: Vec<String>,
}

impl TenantCtx {
    pub fn new(tenant: impl Into<String>) -> Self {
        Self {
            tenant: tenant.into(),
            user: None,
            username: None,
            roles: Vec::new(),
        }
    }
    pub fn with_user(mut self, user: Option<String>) -> Self {
        self.user = user;
        self
    }
    pub fn with_username(mut self, username: Option<String>) -> Self {
        self.username = username;
        self
    }
    pub fn with_roles(mut self, roles: Vec<String>) -> Self {
        self.roles = roles;
        self
    }
}

/// 在给定租户上下文作用域内执行 future（认证中间件调用）。
pub async fn scope<F, R>(ctx: TenantCtx, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    TENANT.scope(ctx, fut).await
}

/// 当前租户名。无 scope 时回退 [`DEFAULT_TENANT`]。
pub fn current_tenant() -> String {
    TENANT
        .try_with(|c| c.tenant.clone())
        .unwrap_or_else(|_| DEFAULT_TENANT.to_string())
}

/// 当前用户 id。
pub fn current_user() -> Option<String> {
    TENANT.try_with(|c| c.user.clone()).ok().flatten()
}

/// 留痕/审计展示用操作人名：优先 `username` claim（如 "admin"），无则回退用户 id——
/// 平台 AccessClaims 自带 `username`，旧令牌/第三方精简令牌缺省时退 id 保证不空。
pub fn current_display_user() -> Option<String> {
    TENANT
        .try_with(|c| {
            c.username
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| c.user.clone())
        })
        .ok()
        .flatten()
}

/// 当前用户角色。
pub fn current_roles() -> Vec<String> {
    TENANT.try_with(|c| c.roles.clone()).unwrap_or_default()
}

/// 是否处于租户 scope 内。
pub fn in_scope() -> bool {
    TENANT.try_with(|_| ()).is_ok()
}

/// 身份快照 —— 供 cmx_web_monitor 的 observe 中间件读取当前请求身份。
pub fn identity_snapshot() -> Option<cmx_web_monitor::Identity> {
    if !in_scope() {
        return None;
    }
    Some(cmx_web_monitor::Identity {
        tenant: current_tenant(),
        user: current_user(),
        roles: current_roles(),
    })
}
