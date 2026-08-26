//! 认证中间件（R0 最小：off / jwt / api-key），建租户 scope。
//!
//! 配置 ConfigManager 直读（rules-server.toml `[auth]` 段 ← env `AUTH__*` 覆盖），每请求热读：
//! - `auth.mode = "off"`（默认）：不校验，建 `default` 租户 scope 放行 —— 单租户零回归。
//! - `auth.mode = "jwt"`：验 Bearer JWT（HS256），解 tenant/user/roles claim；缺/坏 → 401。
//! - API Key（`auth.api_keys = "key:tenant,..."`）：`X-API-Key` 命中 → 服务身份，租户取 key 绑定。
//!
//! R3 将扩展 per-tenant DB 派生 + 委托用户令牌桥（对齐 flow S6）。本 R0 版把接缝留全，只做最小校验。

use crate::tenant::{scope, TenantCtx};
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

/// 认证配置（ConfigManager 直读 `[auth]` 段，每请求热读；未初始化时回退默认 = off 模式）。
struct AuthConfig {
    mode: String,
    jwt_secret: String,
    tenant_claim: String,
    roles_claim: String,
    api_keys: Vec<(String, String)>, // (key, tenant)
}

impl AuthConfig {
    fn load() -> Self {
        let get = |key: &str, default: &str| {
            cmx_utils::ConfigManager::try_global()
                .and_then(|cm| cm.get_string(key).ok())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| default.to_string())
        };
        let api_keys = get("auth.api_keys", "")
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .filter_map(|pair| {
                let (k, t) = pair.split_once(':')?;
                Some((k.trim().to_string(), t.trim().to_string()))
            })
            .collect();
        Self {
            mode: get("auth.mode", "off"),
            jwt_secret: get("auth.jwt_secret", "change-me"),
            tenant_claim: get("auth.jwt_tenant_claim", "tenant"),
            roles_claim: get("auth.jwt_roles_claim", "roles"),
            api_keys,
        }
    }
}

/// JWT claim（宽松：tenant/roles 键名可配，故用 Value 二次取）。
#[derive(Deserialize)]
struct Claims {
    #[serde(default)]
    sub: Option<String>,
    #[serde(flatten)]
    extra: serde_json::Value,
}

/// 认证中间件。建租户 scope + 确保租户库就绪后放行；失败返 401。
pub async fn auth(req: Request, next: Next) -> Response {
    let cfg = AuthConfig::load();

    // off：默认租户放行（单租户零回归）。
    if cfg.mode == "off" {
        return scoped_run(TenantCtx::new(crate::tenant::DEFAULT_TENANT), req, next).await;
    }

    // API Key 优先（服务身份）。
    if let Some(key) = req
        .headers()
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok())
    {
        if let Some((_, tenant)) = cfg.api_keys.iter().find(|(k, _)| k == key) {
            let ctx = TenantCtx::new(tenant.clone()).with_roles(vec!["service".into()]);
            return scoped_run(ctx, req, next).await;
        }
        return unauthorized("无效 API Key");
    }

    // Bearer JWT。
    if cfg.mode == "jwt" {
        let token = req
            .headers()
            .get("Authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "));
        let Some(token) = token else {
            return unauthorized("缺少 Bearer 令牌");
        };
        match decode_claims(token, &cfg) {
            Ok(ctx) => scoped_run(ctx, req, next).await,
            Err(msg) => unauthorized(&msg),
        }
    } else {
        unauthorized("未知认证模式")
    }
}

/// 建立租户 scope，在其内确保租户库就绪（multi 模式懒备库）后放行 handler。
async fn scoped_run(ctx: TenantCtx, req: Request, next: Next) -> Response {
    scope(ctx, async move {
        crate::tenancy::ensure_current_ready().await;
        next.run(req).await
    })
    .await
}

/// 验签解 claim → TenantCtx。
fn decode_claims(token: &str, cfg: &AuthConfig) -> Result<TenantCtx, String> {
    use jsonwebtoken::{decode, DecodingKey, Validation};
    let mut validation = Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = false; // R0 不强制过期校验；R3 收紧。
    validation.required_spec_claims.clear();
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(cfg.jwt_secret.as_bytes()),
        &validation,
    )
    .map_err(|e| format!("令牌验签失败: {e}"))?;

    let claims = data.claims;
    let tenant = claims
        .extra
        .get(&cfg.tenant_claim)
        .and_then(|v| v.as_str())
        .unwrap_or(crate::tenant::DEFAULT_TENANT)
        .to_string();
    let roles = claims
        .extra
        .get(&cfg.roles_claim)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    // username claim → 展示名（平台 AccessClaims 自带；缺省 None，留痕经
    // current_display_user 回退用户 id，避免把 id 当姓名写审计日志）。
    let username = claims
        .extra
        .get("username")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(TenantCtx::new(tenant)
        .with_user(claims.sub)
        .with_username(username)
        .with_roles(roles))
}

fn unauthorized(msg: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(serde_json::json!({ "code": 401, "msg": msg })),
    )
        .into_response()
}
