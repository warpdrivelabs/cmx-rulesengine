/*
 * cmx-rule 独立决策引擎微服务 HTTP 服务器。
 *
 * 采用通用骨架 cmx-web-chassis：main 只填 ServiceSpec——rule 路由 + 两个启动钩子（注册数据源、
 * 建表预热）+ rule 专属 banner/配色，交 chassis::run 装配。零 cmx-api 依赖。
 *
 * 与 flow-server 的唯一实质差异：**无定时器 poller**（规则决策无长驻实例/定时器），钩子②只建表
 * 预热存储，不起后台线程——纯请求驱动的无状态求值。
 *
 * 配置（chassis 框架级用 RULE_ 前缀；rule 专属用各自变量）：
 *   RULE_HOST / RULE_PORT（默认 0.0.0.0:8094）/ RULE_LOG_DIR / RULE_LOG_LEVEL / RULE_CONFIG(toml)
 *   RULE_PG_URL（数据源）/ RULE_AUTH_MODE / RULE_JWT_* / RULE_API_KEYS
 *
 * 用法：
 *   RULE_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/fico cargo run -p cmx-rule-server
 *   curl -XPOST http://127.0.0.1:8094/api/rules/v1/evaluate -d '{...}'
 */

use cmx_database_pg::{DbConfig, DbType};
use cmx_rule_app::openapi::openapi_json;
use cmx_rule_app::{rule_openapi, rule_routes, rule_routes_v1, warm_store, RULE_DB_ID};
use cmx_web_chassis::{run, BannerSpec, ChassisConfig, ServiceSpec};

/// rule 专属字符画（MEGA RULES）。
const RULE_ART: &str = r#"
███╗   ███╗███████╗ ██████╗  █████╗     ██████╗ ██╗   ██╗██╗     ███████╗███████╗
████╗ ████║██╔════╝██╔════╝ ██╔══██╗    ██╔══██╗██║   ██║██║     ██╔════╝██╔════╝
██╔████╔██║█████╗  ██║  ███╗███████║    ██████╔╝██║   ██║██║     █████╗  ███████╗
██║╚██╔╝██║██╔══╝  ██║   ██║██╔══██║    ██╔══██╗██║   ██║██║     ██╔══╝  ╚════██║
██║ ╚═╝ ██║███████╗╚██████╔╝██║  ██║    ██║  ██║╚██████╔╝███████╗███████╗███████║
╚═╝     ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝╚══════╝
"#;

/// rules-server.toml 的 [auth]/[datasource] 段（全可选）。
#[derive(serde::Deserialize, Default)]
struct FileConfig {
    #[serde(default)]
    auth: AuthSection,
    #[serde(default)]
    datasource: DatasourceSection,
}

#[derive(serde::Deserialize, Default)]
struct AuthSection {
    mode: Option<String>,
    jwt_alg: Option<String>,
    jwt_secret: Option<String>,
    jwt_tenant_claim: Option<String>,
    jwt_roles_claim: Option<String>,
    api_keys: Option<String>,
    tenancy: Option<String>,
}

#[derive(serde::Deserialize, Default)]
struct DatasourceSection {
    rule_pg_url: Option<String>,
}

/// 读 toml 的 [auth]/[datasource] 段 → 注入 RULE_* 环境变量（env 未设时；env 优先）。
fn apply_toml_env() {
    let path = std::env::var("CONFIG_FILE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("RULE_CONFIG").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| "rules-server.toml".to_string());
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let file: FileConfig = match toml::from_str(&text) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(path = %path, error = %e, "rules-server.toml 解析失败，回退环境变量");
            return;
        }
    };
    let set_if_absent = |key: &str, val: &Option<String>| {
        if let Some(v) = val
            && !v.trim().is_empty()
            && std::env::var(key).is_err()
        {
            // SAFETY: 启动早期、单线程、任何请求前设置进程环境变量。
            unsafe { std::env::set_var(key, v) }
        }
    };
    set_if_absent("RULE_AUTH_MODE", &file.auth.mode);
    set_if_absent("RULE_JWT_ALG", &file.auth.jwt_alg);
    set_if_absent("RULE_JWT_SECRET", &file.auth.jwt_secret);
    set_if_absent("RULE_JWT_TENANT_CLAIM", &file.auth.jwt_tenant_claim);
    set_if_absent("RULE_JWT_ROLES_CLAIM", &file.auth.jwt_roles_claim);
    set_if_absent("RULE_API_KEYS", &file.auth.api_keys);
    set_if_absent("RULE_TENANCY", &file.auth.tenancy);
    set_if_absent("RULE_PG_URL", &file.datasource.rule_pg_url);
}

#[tokio::main]
async fn main() -> cmx_web_chassis::Result<()> {
    dotenvy::dotenv().ok();
    if let Err(e) = cmx_service_base::init_config_manager() {
        tracing::warn!(error = %e, "全局 ConfigManager 初始化失败，回退 env/默认兜底");
    }

    let mut cfg = ChassisConfig::load("rules", "RULE", "rules-server.toml");
    apply_toml_env();
    if std::env::var("RULE_PORT").is_err() && cfg.port == 8080 {
        cfg.port = 8094; // rule 默认端口（避开平台 8080 / flow 8091 / report 8092）。
    }

    let banner = BannerSpec::defaults("rules")
        .art(RULE_ART)
        .tagline("  MEGA Rules · 决策规则引擎微服务 · cmx-web-chassis ")
        .stops(vec![(0, 230, 170), (58, 140, 255), (150, 90, 255)]);

    // 路由：v1 正式契约 + 旧前缀（内嵌壳兼容），经认证中间件。
    let authed = rule_routes_v1::<()>()
        .merge(rule_routes::<()>())
        .layer(axum::middleware::from_fn(cmx_web_monitor::observe))
        .layer(axum::middleware::from_fn(cmx_rule_app::auth_middleware));
    // 公开文档（免认证，挂认证之外）。
    let api_router = axum::Router::new()
        .merge(authed)
        .route("/rules/v1/openapi.json", axum::routing::get(openapi_json));
    let app_router = axum::Router::new()
        // 根 → 决策引擎监控大盘（免认证，轮询 /api/rules/v1/stats）。
        .route("/", axum::routing::get(cmx_rule_app::dashboard::dashboard))
        .nest("/api", api_router);

    // 技术监控（/_mon）：注入身份读取器 + 拓扑（rule 自身即引擎，内嵌）。
    cmx_web_monitor::set_service_name("cmx-rules 决策引擎");
    cmx_web_monitor::set_identity_provider(cmx_rule_app::identity_snapshot);
    cmx_web_monitor::set_topology_provider(|| {
        vec![cmx_web_monitor::ServiceDep {
            key: "rules".into(),
            label: "决策引擎".into(),
            mode: "embedded".into(),
            target: None,
            proxiable: true,
        }]
    });
    // rule_openapi 供 SwaggerUi（R4）；R0 先只暴露 openapi.json，保留引用避免 dead_code。
    let _ = rule_openapi();

    let spec = ServiceSpec::<()>::new("rules", cfg)
        .banner(banner)
        .nest_api(false) // 已自行 nest /api，让根大盘 / 逃出 /api。
        .router(app_router)
        .state(())
        // 钩子① 注册数据源（db_id 对齐 RULE_DB_ID）。
        .init("datasources", |_meta| {
            Box::pin(async {
                let url = std::env::var("RULE_PG_URL").unwrap_or_else(|_| {
                    "postgres://postgres:postgres@127.0.0.1:5432/fico".to_string()
                });
                cmx_service_base::register_pg_datasources(&[rule_db_config(RULE_DB_ID, &url)])
                    .await
                    .map_err(|e| anyhow::anyhow!("注册数据源失败: {e}"))?;
                tracing::info!(db = RULE_DB_ID, "✅ 数据源已注册");
                Ok(())
            })
        })
        // 钩子② 建表预热（**无 poller**）。非致命：DB/schema 不可用只 warn，服务仍起。
        .init("store", |_meta| {
            Box::pin(async {
                if let Err(e) = warm_store().await {
                    tracing::warn!(error = %e, "决策存储初始化失败（DB/schema 不可用？端点将返错）");
                }
                Ok(())
            })
        });

    run(spec).await
}

/// 构造 rule PG 数据源配置（url 从 env 来）。
fn rule_db_config(db_id: &str, url: &str) -> DbConfig {
    DbConfig {
        db_type: DbType::Postgres,
        db_url: url.to_string(),
        db_id: db_id.to_string(),
        db_name: None,
        db_schema: Some("public".to_string()),
        default: true,
        pool_config: Default::default(),
        health_check_interval: 60,
        health_check_timeout: 5,
        domain_code: None,
        application_code: None,
        module_code: None,
        source_type: Some("default".to_string()),
    }
}
