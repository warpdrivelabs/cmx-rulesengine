//! 认证中间件——已收编至 `cmx-engine-kit::auth::jwt`（唯一真源）。
//!
//! 本仓包装器注入多租户懒备库就绪钩子（[`crate::tenancy::ensure_current_ready`]，
//! 在租户 scope 内、handler 前执行）。`auth::auth` 签名不变，挂载侧零改动。
//!
//! **升级说明**（相对本仓原 R0 裁剪版，已拍板对齐 flow 超集语义）：
//! - exp 校验开启（过期令牌从放行 → 拒绝，与平台一致）；
//! - off 模式吃 `X-Tenant` / `X-User` 头（原先忽略，租户恒 default）；
//! - `bearer` 小写前缀容忍、roles 逗号串容忍、API-Key + `X-Delegated-User-Token` 委托桥激活；
//! - 配置装载 OnceLock 快照化（原每请求热读）——改 `[auth]` 配置需重启。
//!
//! 真源：`../cmx-container/crates/libs/cmx-engine-kit/src/auth/jwt.rs`。

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

use cmx_engine_kit::auth::jwt::{self, JwtSpec};

pub use cmx_engine_kit::auth::jwt::auth_config_warmup;

/// 本仓专属参数：无 SSE 票据路径（rule 无 EventSource 端点）。
static SPEC: JwtSpec = JwtSpec::new("rules", &[], None);

/// 认证中间件（建租户 scope + 确保租户库就绪后放行；签名不变）。
pub async fn auth(req: Request, next: Next) -> Response {
    jwt::auth_mw_with_ready(req, next, &SPEC, || async {
        // multi 模式懒备库（幂等去重；内部失败仅 warn，维持既有非致命语义）。
        crate::tenancy::ensure_current_ready().await;
    })
    .await
}
