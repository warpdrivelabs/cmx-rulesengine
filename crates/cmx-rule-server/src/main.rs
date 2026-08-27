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

    // 路由：v1 正式契约 + 旧前缀（内嵌壳兼容），经认证中间件。
    let authed = rule_routes_v1::<()>()
        .merge(rule_routes::<()>())
        .layer(axum::middleware::from_fn(cmx_web_monitor::observe))
        .layer(axum::middleware::from_fn(cmx_rule_app::auth_middleware));
    // 公开文档（免认证，挂认证之外）。
    let api_router = axum::Router::new()
        .merge(authed)
        // 前端页只读投递（native；门户 F3 反代 portal.rules.* 取页请求到此，免认证——静态内容 +
        // 门户反代注入服务身份）。挂认证之外、与 openapi 同层，得 /api/native-pages/*。
        // 规则引擎仅 native 页（HtmlLayout::Disabled）；错误体经 RuleError 保持历史 code=4 语义。
        .merge(cmx_form::serve::frontend_pages_routes::<(), cmx_rule_app::RuleError>(
            cmx_form::serve::PageServeConfig {
                html: cmx_form::serve::HtmlLayout::Disabled,
                ..cmx_form::serve::PageServeConfig::from_assets()
            },
        ))
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
        // 钩子① 注册数据源——平台封装：BaseConfig（标准 [[databases]] 段，ConfigManager 三源
        // 合并）+ 共享注册原语 register_pg_datasources。要求 db_id = RULE_DB_ID（store 按该
        // db_id 寻址）；缺段 / 缺 db_id 启动失败（无内置 URL 兜底）。注册建池即首连验证——
        // 库不可达同样终止启动（fail-fast）。
        .init("datasources", |_meta| {
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
