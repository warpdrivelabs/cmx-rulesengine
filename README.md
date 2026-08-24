# cmx-rulesengine —— 独立决策规则引擎微服务

对标全球最先进规则引擎（GoRules ZEN / Camunda DMN / Drools / IBM ODM），用 **Rust** 打造的**独立 Cargo workspace**，承载与平台/框架解耦的决策规则引擎全部 crate。目标：可独立部署、独立运行、独立升级、支持多租户的纯决策引擎微服务，架构范式**参照 `cmx-flowengine`（S0→S6）的"一芯多壳"**。

在 CMX 平台 `metaKind` 分类学里，这是继 **DCT（字典）/ DOC（单据）/ FLX（流程表单）/ RPT（报表）** 之后的**第五元：RULE（决策规则）**。

> 完整架构方案见 [`docs/cmx-rulesengine-design.md`](docs/cmx-rulesengine-design.md)（对标选型 + 一芯多壳 + headless 契约 + R0–R7 路线）。

## 定位：管"决策"，不管"流转"

- **流程引擎（cmx-flowengine）** 管**流转**：人与节点的推进、审批、会签、待办——有长驻实例、令牌、定时器。
- **规则引擎（本库）** 管**决策**：给定输入事实 → 产出结论——**无状态、同步、微秒级**求值，无令牌/任务/定时器/poller。

把频繁变更的业务决策逻辑（审批矩阵/定价/风控/资格）从代码和流程图里剥离出来，交给业务人员可视化维护。flow 的 `businessRuleTask` 可直接调它。

## 现状：R0（内核骨架 + 真机跑通）

已落地并**真机实测全绿**（PostgreSQL）：单决策表求值 + DMN 11 命中策略 + S-FEEL 表达式子集 + 逐节点 trace（含**失败归因**）+ 决策日志审计 + chassis 独立 bin。**19 单测 + 0 clippy 警告**。

**两处对标并超越 ZEN 的设计**：
1. **失败归因 trace** —— 求值失败时精确定位"哪条规则、哪个输入列、什么错"（ZEN 的 trace 不显示失败节点）。
2. **决策表 gap/overlap 完整性分析** —— R0 已建类型，算法 R1 落地（ZEN 无此能力）。

后续里程碑（R1 全 FEEL + gap/overlap 算法 / R2 决策图 JDM + DMN 导入 / R3 多租户 / R4 headless 契约 / R5 前端一芯三壳 / R6 平台对接 / R7 Rete 推理节点）见方案文档 §11。

## crate 布局

```
crates/
  cmx-rule-model     决策语义中立内核：决策表 IR（11 命中策略）+ 求值上下文 + trace（含失败归因）
                     + DecisionStore 契约 + gap/overlap 报告类型（零 cmx 依赖，可 wasm）
  cmx-rule-feel      S-FEEL unary test 求值：比较/区间 [1..10]/枚举 OR/not()/字面量（决策表单元格所需）
  cmx-rule-engine    决策求值内核：单决策表求值 + 11 命中策略汇总 + 失败归因 trace
  cmx-rule-store-pg  DecisionStore 的 PostgreSQL 实现（4 表，无 RU 运行表）
  cmx-rule-app       平台中立应用层（一芯）：rule_routes::<S>() 泛型路由 + 全部 handler
                     + 自持响应信封 + 租户 scope + 认证 + 监控大盘 + OpenAPI
  cmx-rule-server    独立可执行 bin（chassis 装配，:8094，无 poller）
```

> 平台适配层 `cmx-rule-api`（keep-wired 内嵌 + 反代壳）将留在 cmx-container，经跨 workspace 路径引用本库 `cmx-rule-app`（R6，对标 `cmx-flow-api`）。

## 依赖策略

- **域内 rule crate**：纯 `path`。
- **基础设施**（`cmx-database-pg` / `cmx-core` / `cmx-web-chassis` / `cmx-web-monitor` / `cmx-service-base`）：以跨 workspace `path` 复用 cmx-container 的成员 crate——它们仍属 cmx-container workspace（对其根解析 `workspace=true` 与 `[patch.nora]`），故本库**无需 nora 私仓**、**不把 infra 纳入 members**。
- **外部 crate**：走 aliyun 镜像（见 `.cargo/config.toml`），版本与 cmx-container 根对齐以便 Cargo 合一。**禁用 `evalexpr`（AGPL）**。

> 因此：本库构建依赖 `../cmx-container/` 就在旁边（sibling 目录）。离线环境用 `--offline` 走本地缓存。

## 快速开始

```bash
# 编译全部 crate
cargo build

# 内核测试（纯函数，无需 PG）
cargo test -p cmx-rule-model -p cmx-rule-feel -p cmx-rule-engine

# 启动独立微服务（需本地 PG；默认 fico 库，cmx_rule_* 表首启自动建）
./rules.sh              # 开发模式（debug，增量编译）
./rules.sh --release    # 发布模式
./rules.sh --offline    # 离线模式（无网时用本地缓存）
# 等价：cargo run -p cmx-rule-server（bin 自读 .env）
```

起后访问：

| 地址 | 说明 |
|---|---|
| `http://127.0.0.1:8094/` | 决策引擎监控大盘（自包含 HTML） |
| `http://127.0.0.1:8094/api/rules/v1/stats` | 引擎聚合（定义数/求值数/成功率） |
| `http://127.0.0.1:8094/api/rules/v1/openapi.json` | OpenAPI 契约（免认证） |
| `http://127.0.0.1:8094/_mon` | 通用技术监控（系统/DB 池/请求遥测） |

## API 速览（R0）

```bash
B=http://127.0.0.1:8094

# 1) 存一张决策表（草稿）
curl -XPOST $B/api/rules/v1/definitions/draft -H 'Content-Type: application/json' -d '{
  "key":"credit_approval","name":"信贷审批","kind":"decisionTable","hitPolicy":"U",
  "inputs":[{"expression":"score"},{"expression":"region"}],
  "outputs":[{"name":"tier"},{"name":"maxLimit"}],
  "rules":[
    {"inputEntries":[">= 750","-"],           "outputEntries":["\"A\"","100000"]},
    {"inputEntries":["[650..750)","\"north\""],"outputEntries":["\"B\"","50000"]},
    {"inputEntries":["< 650","-"],            "outputEntries":["\"C\"","0"]}
  ]}'

# 2) 求值（按 key 装载 → 输出 + trace + logId）
curl -XPOST $B/api/rules/v1/decisions/credit_approval/evaluate -H 'Content-Type: application/json' \
  -d '{"input":{"score":800,"region":"south"},"options":{"trace":true}}'
#  → {"output":{"tier":"A","maxLimit":100000.0},"logId":"…","trace":[…]}

# 3) 内联求值（试算，不落库）
curl -XPOST $B/api/rules/v1/evaluate -H 'Content-Type: application/json' \
  -d '{"input":{"score":800},"definition":{…}}'

# 4) 决策日志下钻（可解释性）
curl $B/api/rules/v1/decisions/credit_approval/logs      # 列表
curl $B/api/rules/v1/logs/{logId}                        # 单次全量 trace

# 5) FEEL 试算 / 校验
curl -XPOST $B/api/rules/v1/feel/eval     -d '{"test":"[18..65)","value":18}'   # → true
curl -XPOST $B/api/rules/v1/feel/validate -d '{"test":"[bad..10]"}'             # → valid:false
```

## 命中策略（DMN 11 变体）

| 类 | 代号 | 语义 |
|---|---|---|
| 单命中 | **U** / **A** / **P** / **F** | 唯一（重叠即失败归因）/ 任意（输出须一致）/ 优先 / 首个 |
| 多命中 | **C** / **R** / **O** | 收集（无序列表）/ 规则序 / 输出序 |
| 聚合 | **C+** / **C&lt;** / **C&gt;** / **C#** | 求和 / 最小 / 最大 / 计数 |

序列化用 DMN 单字母代号（`hitPolicy: "U"`），利于与 DMN/Camunda/Drools 工具链互通。

## 数据模型（表前缀 `cmx_rule_`，无外键，DDL 幂等）

规则引擎**无 RU 运行表**（决策无长驻状态）——仅 4 表：

| 表 | 职责 |
|---|---|
| `cmx_rule_definition` | 决策定义（草稿态，body jsonb 存决策表 IR） |
| `cmx_rule_release` | 不可变发布（version + IR 快照 + rev 内容哈希） |
| `cmx_rule_decision_log` | 决策日志/审计（每次求值一条，trace jsonb + 失败归因） |
| `cmx_rule_test_case` | 测试用例（输入/期望，仿真回归） |

## 认证与多租户

- `auth.mode=off`（默认）：建 `default` 租户 scope 放行——单租户零回归。
- `auth.mode=jwt`：验 Bearer JWT（HS256），解 tenant/user/roles claim。
- API Key（`auth.api_keys=key:tenant`）：`X-API-Key` 命中 → 服务身份。
- 配置见 [`rules-server.toml.example`](rules-server.toml.example)：`[server]` 框架段 + `[[databases]]` 数据源 + `[auth]` 认证（ConfigManager 直读，env 覆盖 `SERVER__*` / `AUTH__*` 族）。

> per-tenant DB 物理隔离 + 委托用户令牌桥（对齐 flow S6）R3 落地。

## 端口约定

| 服务 | 端口 |
|---|---|
| 平台门户 web-server | 8080 |
| cmx-flowengine | 8091 |
| cmx-report | 8092 |
| **cmx-rulesengine** | **8094** |
