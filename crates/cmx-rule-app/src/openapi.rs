//! 最小 OpenAPI 文档（R0 手工 paths；R4 补全所有端点 + schema 注解）。

use axum::Json;
use utoipa::openapi::{InfoBuilder, OpenApi, OpenApiBuilder};

/// 构造 rules v1 的 OpenAPI 文档（R0 骨架：仅 info + 版本；R4 填 paths/components）。
pub fn rule_openapi() -> OpenApi {
    OpenApiBuilder::new()
        .info(
            InfoBuilder::new()
                .title("cmx-rulesengine API")
                .version("v1")
                .description(Some(
                    "决策规则引擎 headless 契约：决策定义、evaluate（含 trace）、决策日志、FEEL 试算。",
                ))
                .build(),
        )
        .build()
}

/// GET /rules/v1/openapi.json —— 公开文档（免认证）。
pub async fn openapi_json() -> Json<OpenApi> {
    Json(rule_openapi())
}

