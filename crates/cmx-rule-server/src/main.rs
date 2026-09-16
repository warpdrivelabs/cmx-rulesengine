/*
 * cmx-rule 独立决策引擎微服务 HTTP 服务器。
 *
 * 采用通用骨架 cmx-web-chassis：main 只填 ServiceSpec——rule 路由 + 两个启动钩子（注册数据源、
 * 建表预热）+ rule 专属 banner/配色，交 chassis::run 装配。零 cmx-api 依赖。
 *
 * 与 flow-server 的唯一实质差异：**无定时器 poller**（规则决策无长驻实例/定时器），钩子②只建表
 * 预热存储，不起后台线程——纯请求驱动的无状态求值。
 *
 * 配置（rules-server.toml，路径由 CONFIG_FILE 指定；[server] 框架键 env 覆盖 SERVER__*，与 ConfigManager `__` 约定同名）：
 *   [server] host/port/log_dir/log_level/graceful_timeout_secs（默认 0.0.0.0:8094）
 *   [[databases]] 标准数据源段（db_id = RULE_DB_ID = "rule_pg"，default=true；缺段启动失败）
 *   [auth] 段 → cmx-rule-app 认证中间件 ConfigManager 直读（env 覆盖 AUTH__*）
 *
 * 用法：
 *   cargo run -p cmx-rule-server   # 读 cwd 的 rules-server.toml（或 CONFIG_FILE 指定）
 *   curl -XPOST http://127.0.0.1:8094/api/rules/v1/evaluate -d '{...}'
 */

use cmx_form::serve::{FormPagesModule, PageServeConfig};
use cmx_rule_app::openapi::openapi_json;
use cmx_rule_app::{
    ModuleSet, RuleCoreModule, RuleError, RuleV1Module, rule_openapi, warm_store, RULE_DB_ID,
};
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

#[tokio::main]
async fn main() -> cmx_web_chassis::Result<()> {
    dotenvy::dotenv().ok();
    // 基础设施装配（与门户 run_platform 同一制度）：本地 toml ← Nacos 远程配置中心 ← env
    // 三源 ConfigManager + 注册中心客户端（自注册 + 实例缓存 + 30s 服务列表同步）。开关默认
    // 全关（未开 NACOS_ENABLED 时走 Mock，纯本地 toml+env，行为与接入前一致）；开启后
    // create 阶段强依赖 Nacos 可达，失败即中止启动（register 阶段失败仅 warn）。
    cmx_service_base::init_infra()
        .await
        .map_err(|e| cmx_web_chassis::ChassisError::Config(format!("基础设施初始化失败: {e}")))?;

    let mut cfg = ChassisConfig::load("rules", "rules-server.toml");
    if std::env::var("SERVER__PORT").is_err() && cfg.port == 8080 {
        cfg.port = 8094; // rule 默认端口（避开平台 8080 / flow 8091 / report 8092）。
    }

    let banner = BannerSpec::defaults("rules")
        .art(RULE_ART)
        .tagline("  MEGA Rules · 决策规则引擎微服务 · cmx-web-chassis ")
        .stops(vec![(0, 230, 170), (58, 140, 255), (150, 90, 255)]);

    // 路由：模块化装配（authed / open 双切片 + api_router 级公开 openapi.json）见 [`build_app_router`]。
    let app_router = build_app_router();

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
        // 钩子① 注册数据源——平台封装：BaseConfig（标准 [[databases]] 段，ConfigManager 三源
        // 合并）+ 共享注册原语 register_pg_datasources。要求 db_id = RULE_DB_ID（store 按该
        // db_id 寻址）；缺段 / 缺 db_id 启动失败（无内置 URL 兜底）。注册建池即首连验证——
        // 库不可达同样终止启动（fail-fast）。
        .init("datasources", |_meta| {
            // 004 小项 fail-fast：auth.mode 缺失/非法在启动期即失败（无鉴权必须是显式 off）。
            cmx_rule_app::auth::auth_config_warmup();
            Box::pin(async {
                let base = cmx_service_base::BaseConfig::from_config_manager()
                    .map_err(|e| anyhow::anyhow!("读取 [[databases]] 配置失败: {e}"))?;
                cmx_service_base::validate_databases(
                    &base.databases,
                    &cmx_service_base::DatasourceRules {
                        required_db_ids: &[RULE_DB_ID],
                        ..Default::default()
                    },
                )
                .map_err(|e| anyhow::anyhow!("数据源校验失败（需 db_id=\"{RULE_DB_ID}\"，决策 store 按该 db_id 寻址）: {e}"))?;
                let ids: Vec<&str> = base.databases.iter().map(|d| d.db_id.as_str()).collect();
                cmx_service_base::register_pg_datasources(&base.databases)
                    .await
                    .map_err(|e| anyhow::anyhow!("注册数据源失败: {e}"))?;
                tracing::info!(databases = ?ids, "✅ 决策引擎 tokio-pg 数据源已注册（[[databases]] 配置驱动）");
                Ok(())
            })
        })
        // 钩子② 建表预热（**无 poller**）。DB 不可达已在钩子① 探活 fail-fast；此处失败
        //（建表权限等）同样终止启动——带病启动端点只会全返错。
        .init("store", |_meta| {
            Box::pin(async {
                warm_store()
                    .await
                    .map_err(|e| anyhow::anyhow!("决策存储初始化失败: {e}"))?;
                Ok(())
            })
        });

    let result = run(spec).await;
    // serve 结束（收到关闭信号或自然退出）：注销注册中心实例后再返回——不用 `?` 提前返回，
    // 否则 Err 路径会跳过注销（实例要等 Nacos 心跳超时才摘除）。
    cmx_service_base::shutdown_infra().await;
    result
}

// ============================================================================
// bin 组合根装配（模块化）
// ============================================================================

/// authed 切片：决策业务路由（v1 正式契约 + 旧前缀，同 inner 表双前缀）。
///
/// 返回**未加层**的路由器——main 按现状序「observe（内）→ auth（外）」加层；契约测试
/// 直接探测本函数（auth 中间件对无凭证请求统一 401，会掩盖 405/404 区分）。
fn build_authed_router() -> axum::Router {
    ModuleSet::<()>::new(vec![])
        // v1 在前、旧前缀在后：与改造前 `rule_routes_v1().merge(rule_routes())` 顺序一致。
        .with(Box::new(RuleV1Module))
        .with(Box::new(RuleCoreModule))
        .fold()
}

/// open 切片：前端页只读投递（native；门户 F3 反代 portal.rules.* 取页请求到此，免认证）。
///
/// 挂认证之外、与 openapi 同层；**现状无任何中间件层，保持**。规则引擎仅 native 页
/// （HtmlLayout::Disabled）；错误体经 RuleError 保持历史 code=4 语义。
fn build_open_router() -> axum::Router {
    ModuleSet::<()>::new(vec![]).with(Box::new(FormPagesModule::<RuleError>::new(
        PageServeConfig { html: cmx_form::serve::HtmlLayout::Disabled, ..PageServeConfig::from_assets() },
    ))).fold()
}

/// 全量装配：根级大盘 + `/api`（authed 切片 + open 切片 + 公开 openapi.json）。
///
/// openapi.json 挂在 api_router 上、authed 子树之外（URL 含 `/api` 前缀，免认证公开文档），
/// **不得挪到 app_router 根**（会丢 `/api` 前缀致消费方 404）。
fn build_app_router() -> axum::Router {
    let authed = build_authed_router()
        .layer(axum::middleware::from_fn(cmx_web_monitor::observe))
        .layer(axum::middleware::from_fn(cmx_rule_app::auth_middleware));
    let api_router = axum::Router::new()
        .merge(authed)
        .merge(build_open_router())
        .route("/rules/v1/openapi.json", axum::routing::get(openapi_json));
    axum::Router::new()
        // 根 → 决策引擎监控大盘（免认证，轮询 /api/rules/v1/stats）。
        .route("/", axum::routing::get(cmx_rule_app::dashboard::dashboard))
        .nest("/api", api_router)
}

// ============================================================================
// 路由契约守护（bin 装配级）
// ============================================================================

#[cfg(test)]
mod route_contract {
    //! 静态清单以改造前 main.rs 逐条抄录（改造后不变即零回归）。
    //!
    //! 探测法：以 **OPTIONS** 探测——命中已有路径返回 405（方法不符），未命中 404；
    //! 不触发任何 handler。authed 切片在加层前探测（原因见 [`super::build_authed_router`]）。

    use super::{build_app_router, build_authed_router, build_open_router};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    /// authed 切片（改造前 main.rs 挂载清单抽样：v1 求值 + stats）。
    const AUTHED: &[&str] = &["/rules/v1/evaluate", "/rules/v1/stats"];

    /// open / 根级（改造前 main.rs 挂载清单：大盘、公开文档、页面端点）。
    const OPEN_OR_ROOT: &[&str] = &[
        "/",
        "/api/rules/v1/openapi.json",
        "/api/native-pages",
        "/api/native-pages/probe-id",
    ];

    async fn probe(router: axum::Router, method: &str, path: &str) -> StatusCode {
        let req = Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .unwrap();
        router.oneshot(req).await.unwrap().status()
    }

    #[tokio::test]
    async fn authed_paths_mounted() {
        let router = build_authed_router();
        for path in AUTHED {
            let status = probe(router.clone(), "OPTIONS", path).await;
            assert_ne!(status, StatusCode::NOT_FOUND, "authed 路径丢失: {path}");
        }
    }

    #[tokio::test]
    async fn open_and_root_paths_mounted() {
        let router = build_app_router();
        for path in OPEN_OR_ROOT {
            let status = probe(router.clone(), "OPTIONS", path).await;
            assert_ne!(status, StatusCode::NOT_FOUND, "open/根级路径丢失: {path}");
        }
    }

    #[tokio::test]
    async fn open_slice_mounts_without_auth_layers() {
        // 防误把页面投递挂进 authed（免认证面被收窄属行为回归）。
        let status = probe(build_open_router(), "OPTIONS", "/native-pages").await;
        assert_ne!(status, StatusCode::NOT_FOUND, "open 切片路径丢失");
    }

    #[tokio::test]
    async fn unknown_path_is_404() {
        let router = build_app_router();
        for path in ["/api/__definitely_absent__", "/__definitely_absent__"] {
            let status = probe(router.clone(), "OPTIONS", path).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "未注册路径竟命中: {path}");
        }
    }
}
