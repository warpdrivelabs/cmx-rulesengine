# cmx-rulesengine 决策 / 规则引擎 · 实现方案与开源全景对比

> Rust 原生业务决策引擎 · 图优先 JDM 决策图 + 决策表(11 命中策略) + 自研 FEEL · 无状态微秒级同步求值 · 一芯多壳
> 版本 v0.1.0 · edition 2024 · 工具链 1.97.1 · Apache-2.0 · 报告日期 2026-09-01（能力口径为当前实测源码）

{{FIG:overview}}

---

## 摘要

**cmx-rulesengine** 是一套用 **Rust** 从零构建的**业务决策 / 规则引擎**，对标 GoRules ZEN 与 Camunda DMN——以 **JDM（JSON Decision Model）决策图**为顶层编排、**DMN 决策表**为核心体、**自研 FEEL 子集**为判定表达式语言。它是**无状态、同步、微秒级**的求值引擎：每次决策无副作用、无运行态落库，水平扩展 = 多副本 + 负载均衡（与流程引擎 cmx-flowengine 的持久化令牌模型形成鲜明对照）。它是 CMX 统一建模平台的**第五元 `metaKind`：RULE**（继 DCT/DOC/FLX/RPT 之后）。

- **规模**：6 个 crate、**5,642** 行域代码（约 2,405 行为测试）、27 个源文件；**63** 个 Rust 单测（0 失败、0 ignored）+ 三大 shell E2E 套件。
- **决策模型**：JDM 决策图（6 节点类型、Kahn 拓扑排序 + 防环、子决策递归 ≤8）+ 决策表（**11 DMN 命中策略**）+ 自研 **Pratt FEEL 引擎**（S-FEEL 一元测试覆盖全 FEEL 表达式、25 内建函数）。
- **两点「超越 ZEN」**（引擎自陈的差异化）：① **FEEL/DMN 标准表达式**（vs ZEN 私有方言，不可 DMN 互操作）；② ZEN 缺失的两项世界级能力——**决策表 gap/overlap 完备性分析** + **逐节点失败归因 trace**。
- **平台能力**：发布/版本/激活 · simulate 仿真 · db-per-tenant 多租户 · JWT/API-Key 认证 · Headless v1 + SSE + OpenAPI/Swagger · Rhai 脚本四载体（判定侧永远 FEEL）· 决策表设计器 + 决策图可视设计器 + 仿真台 + 审计中心 + 可嵌组件 `@cmx/decision-graph`。
- **业务落地**：单据转会计凭证（智能记账，P1 13/13 + P2 16/16）+ 财务风控双案例（费用报销 + 反洗钱）。
- **定位**：一套**图优先、标准可信、可解释、完备性可分析**的轻量决策引擎，以真 Apache-2.0 开源、一体化微服务形态交付（设计器/仿真/审计/多租户/headless 全内置）。

---

## 一、引言与定位

企业决策/规则技术大致分四种范式，cmx-rulesengine 的定位在此坐标中清晰：

| 范式 | 代表 | 核心数据结构 | cmx 的取舍 |
| --- | --- | --- | --- |
| **① 产生式 / Rete** | Drools · CLIPS · NRules · IBM ODM RetePlus | 工作内存 + alpha/beta 网络 + agenda | **后置可选**（R7+，企业高频决策多为序列/表） |
| **② 决策表 DMN** | Drools kie-dmn · OpenL Tablets · Camunda DMN | 输入列 × 规则行 × 输出列 + 命中策略 | **✅ 内核体** |
| **③ 决策图 JDM** | GoRules ZEN · DecisionRules.io | JSON DAG + 节点类型枚举 | **✅ 顶层编排** |
| **④ 表达式 / 评分卡** | json-rules-engine · PMML Scorecard | 条件树 / 特征分档打分 | 表达式层借鉴 |

**核心论断**：以「JDM 式决策图 + DMN 决策表语义」为主，**图优先、多范式，Rete 后置可选**。表达式层坚持 **FEEL 标准**（判定侧可静态分析），Rhai 作为计算/副作用侧的逃生舱。不自造表达式方言（避免流程引擎「先自研 DSL 再追 FEEL」的弯路）。

与几乎所有传统 BRMS（Drools/OpenL/IBM ODM 均为 **Java/JVM**）不同，cmx 与 GoRules ZEN 同属**罕见的 Rust 决策引擎**——无 GC、单静态二进制、微秒级、可 wasm 嵌入。

---

## 二、总体架构（一芯多壳）

{{FIG:arch}}

引擎遵循严格分层，核心内核 `cmx-rule-model` 是 **leaf**（零 DB/infra、可 wasm/嵌入）；平台耦合与基础设施均通过 trait 注入与单向 `path` 借用隔离在外围。架构复用 flowengine 验证过的「一芯多壳」骨架，但**运行时比流程更简单**——无令牌/任务/定时器/poller/运行态表。

| Crate | 层 | 职责 | 源 LOC |
| --- | --- | --- | ---: |
| `cmx-rule-model` | L0 内核 | 语义中立 IR：决策表 IR（11 策略）+ 决策图 + eval 上下文/trace + gap/overlap 类型 + `DecisionStore` 契约。leaf，可 wasm | 771 |
| `cmx-rule-feel` | L1 | FEEL 表达式引擎：S-FEEL 一元测试 over 全 FEEL Pratt 求值器（25 内建）+ Rhai 脚本沙箱（SC0） | 1,749 |
| `cmx-rule-engine` | L1 | 求值内核：逐行 unary test → 11 命中策略裁决 → 逐节点 trace + 失败归因 · 决策图拓扑求值 + 子决策递归 · gap/overlap 分析 | 1,167 |
| `cmx-rule-store-pg` | L2 | tokio-postgres 持久化，`impl DecisionStore` 于 6 表（无运行态表——无状态引擎） | 681 |
| `cmx-rule-app` | **L3 芯** | 平台中立应用核：store 单例 + 32 handler + 状态泛型路由 `rule_routes::<S>()` + 租户/认证 + OpenAPI + 大盘（JSON-API-only） | 1,136 |
| `cmx-rule-server` | L4 壳 | 独立微服务二进制（chassis `ServiceSpec`，:8094，无 poller） | 138 |

**依赖方向**：`server → app → {store-pg, engine, model}`；`engine → feel → model`；`feel → rhai`。第二个壳在 workspace 外——`cmx-container` 内的 `cmx-rule-api` 调 `rule_routes::<CmxAppState>()`（handler 不绑 `State`，故路由对 `S` 泛型）。

**两个可注入 trait**（刻意最小契约面）：`DecisionStore`（7 方法，租户作用域 → `PgDecisionStore`）与 `DecisionResolver`（子决策递归加载，`MAX_DEPTH=8`，`NoResolver`/`MapResolver`，app 层 BFS 预取）。脚本宿主 `ScriptFn`/Rhai 沙箱是可插拔的过程逃生舱。

---

## 三、决策模型与求值语义

{{FIG:model}}

**JDM 决策图**（`cmx-rule-model/src/ir.rs`）：`DecisionGraph{nodes, edges}`，节点扁平（`type` 字符串 + 类型专属可选字段，作者友好 + serde 稳健）。**6 种节点类型**：`input`（事实入口）/ `output`（结果快照）/ `decisionTable`（内嵌决策表）/ `expression`（N 个 FEEL 字段映射）/ `decision`（子决策递归引用）/ `script`（Rhai）。无 `switch`、无独立 `function` 节点（函数是注册进引擎的可复用 Rhai，非节点）。

**求值遍历**（`evaluate_graph`）：深度守卫 → 校验 → **`topo_order` = Kahn 算法** → 按拓扑序迭代，上下文以 `Map<String,Value>` **左→右累积**（每节点输出 `merge()` 回共享上下文）。**防环**：`order.len() != n` → 报「决策图存在环」。子决策经 `DecisionResolver`（app 层 BFS 预取所有可达子决策后注入 `MapResolver`）。永不 panic——每个节点失败落各自 `TraceNode.failure`。

**11 DMN 命中策略**（`HitPolicy` 枚举，单字母 serde 码）：`U 唯一`（>1 匹配报错）/ `A 任一`（须全等）/ `P 优先` / `F 首命中` / `C 收集` / `R 规则序` / `O 输出序` / `C+ 求和` / `C< 最小` / `C> 最大` / `C# 计数`。**9 个完整实现；Priority(P)/OutputOrder(O) 当前降级为首命中**（R1 优先级列表待补）。聚合 `C+/C</C>` 要求单一数值输出列。**关键纪律：判定侧永远纯 FEEL**——`row_matches` 恒调 `eval_unary_test`（纯 FEEL），仅 `row_output` 走 `eval_scripted`（FEEL 或 `=rhai:`），以保 gap/overlap 分析有效。

**自研 FEEL 引擎**（`cmx-rule-feel/src/expr.rs`）：**手写 Pratt 解析器**（分词 → Pratt `parse_expr(min_bp)` → 树遍历 eval），值复用 `serde_json::Value`。支持：数/串/布尔/null/列表字面量、算术 `+ - * / **`、比较、`and/or/not`、`if/then/else`、`for…return` 推导式、`some/every…satisfies` 量词、区间 `[a..b]`、`in` 成员、列表过滤 `l[predicate]`、点式嵌套路径、25 内建函数。**离线自研**（无法拉取 `dsntk-rs`），数用 f64（非设计的 Decimal128）。**缺（vs 完整 DMN FEEL）**：时间/日期/时段类型、上下文字面量 `{a:1}`、自定义 FEEL 函数、正则/统计内建、Decimal128。历史坑：`contains(?, "vip")` 逗号在括号内致 `split_top_commas` 无限递归——已用「拆分 <2 段则返 `None`」守卫修复。

**可解释性 + 完备性（两点超越 ZEN）**：① 每节点 `TraceNode{matched_rules, input, output, timing_us, failure}`，精确到规则行/输入列/表达式 + Rhai 行号，落 `DecisionLog` 审计——ZEN 的 trace 只显示「如何决策」，不显示「哪个节点致失败/为何」。② **gap/overlap 完备性分析**：overlap = 结构化 `Constraint` 两两区间求交；gap = 边界分段笛卡尔积代表点回代真匹配器（`CELL_CAP=20000`）——对标 OpenL `validateDT` / Drools `ANALYZE_DECISION_TABLE`，ZEN 无此能力。

**Rhai 脚本四载体**（共用求值内核，判定侧永远 FEEL）：脚本节点 / 脚本格 `=rhai:` / 函数库（发布·线程本地 RAII 安装） / 脚本决策（整体）。沙箱 `max_operations=10万`（CPU 闸门用操作数非墙钟，为确定性/wasm）、`max_call_levels=32`、**无 IO/OS/时钟/随机**，整数归一 f64 以对齐 FEEL 算术与测试用例稳定。脚本决策是黑盒——**显式不参与 gap/overlap**（返回「脚本决策黑盒，不参与」而非假完备）。

---

## 四、企业 / 平台能力

{{FIG:features}}

| 能力 | 机制 | 状态 |
| --- | --- | --- |
| **发布 / 版本 / 激活** | 定义草稿 → 发布（版本+1，不可变 release）→ 激活；`cmx_rule_definition/_release` | 实现 + 后端回归 |
| **simulate 仿真 + 归因** | facts → 求值 → 输出 + 逐节点 trace；存测试用例、套件 diff | 实现 + CDP |
| **gap / overlap 分析** | 决策表完备性：重叠区间求交 + 空隙笛卡尔积回代 | 实现 + 单测/后端 |
| **决策表设计器** | 可编辑网格 + 11 命中策略 + 格内 FEEL + fx 向导 + 热注册入库 | 实现 + CDP |
| **决策图可视设计器** | 手搓 SVG DAG + 拖拽节点/拉线 + 防环 `wouldCycle`/Kahn + 新建类型选择 | 实现 + CDP |
| **可嵌组件** | `@cmx/decision-graph`（sibling 仓 TS + esbuild ESM，自注册 `<cmx-decision-graph>`）+ `RuleElementBase` 自定义元素 | 组件 CDP 测；元素 demo 挂载 |
| **审计中心** | `DecisionLog`（input/output/trace/timing/caller/failure）落库；查找/刷新/分页 | 实现 |
| **分类分组** | `cmx_rule_category` 决策集分类；三页分组折叠、「未分类」置末 | 实现 + CDP |
| **多租户** | db-per-tenant（`cmx-service-base` 数据源注册，`db_id=rule_pg`）；租户由头/JWT 解析 | 实现 |
| **认证** | JWT 中间件（默认 `mode=off` 单租户零回归）+ 服务 API-Key | 实现 |
| **Headless v1** | `/api/rules/v1/*` REST + SSE + OpenAPI + SwaggerUi；`X-Tenant`/`X-User` | 实现 + 后端 |
| **平台对接** | native-pages 自投递（`cmx-form::serve`）+ 门户 F3 反代 + `center_client` + Nacos 自注册 | 实现 |
| **单据转凭证** | 声明式适配器 → 会计事件 → 两步决策（Collect 分录模板 → 科目表 Unique 定科目）→ 平衡凭证 | 实现 + E2E P1 13/13 · P2 16/16 |
| **Rhai 脚本能力 SC0–SC4** | 四载体 + 沙箱 + 语法检查 + 完备性黑盒 + trace + f64 归一 + 错误归因 | 实现 + qa-script 55/55 |

> `cmx-rule-app` 是 **JSON-API-only** 后端；静态页由 `cmx-form::serve` 投递、门户 F3 反代——与 flowengine 同盘的一芯多壳。

---

## 五、部署姿态

{{FIG:deploy}}

同一引擎核，多种落地：① **独立微服务**（`cmx-rule-server` :8094，门户经 `RuleProxy` 纯 HTTP 反代 `/api/rules/*`，db-per-tenant）；② **可嵌组件**（宿主 App 直嵌 `<rule-designer>` / `<cmx-decision-graph>`，直连 v1 API）；③ **Headless / 库**（自建系统消费 REST+SSE+OpenAPI，或把 `model+engine+feel` 作**内存态同步库/wasm** 嵌入——可被 flowengine 的 `businessRuleTask` 直接调用）。**无状态优势**：无令牌/任务/定时器/poller/运行态表，每次求值 µs 级、无副作用，水平扩展仅需多副本 + 负载均衡。

---

## 六、与主流开源决策 / 规则引擎全方位对比

这是本报告的核心。对比一律以 cmx **当前实测能力**为准。

{{FIG:compare}}

### 6.1 对比对象

- **GoRules ZEN**（Rust，**MIT**）：cmx 最近的同类——同为 Rust + JDM 决策图 + 决策表 + 表达式。微秒级、多语言原生绑定（Node/Python/Go/Java/Kotlin/.NET/iOS/Android）。但表达式是 **ZEN 私有方言**（非 DMN 互操作）；形态为**可嵌引擎库 + 独立 React JDM Editor + 商业 GoRules BRMS**（引擎 MIT，BRMS 另售）；无 gap/overlap 完备性分析、无失败归因 trace。
- **Drools / KIE / Kogito**（Java，**Apache-2.0**）：20+ 年最成熟 BRMS。**RETE 算法** + DRL 规则语言 + **完整 DMN Level 3 一致性** + 决策表 + Business Central。权衡：复杂、学习曲线陡、运维重、默认无业务用户 UI、每次改规则需开发介入。
- **Camunda DMN**（Java）：OMG DMN 标准引擎，**完整 FEEL** + DRD，与 BPMN 统一。但绑定 Camunda 平台——CE（Camunda 7）**已于 2025-10 EOL**；Camunda 8 DMN **源码可得、8.6+ 生产需付费**。
- **OpenL Tablets**（Java，**LGPL**）：**Excel 为决策表编写面**，分析师友好；WebStudio + Rules Repository + Eclipse 插件。niche 定位，非完整 BRMS。
- 另：**json-rules-engine / easy-rules**（JS/Java，轻量 JSON/POJO 规则）；**IBM ODM / DecisionRules / Nected**（商业 BRMS/SaaS）。

### 6.2 逐维度详解

- **语言与运行时**：cmx 与 ZEN 同为 **Rust**（无 GC/单二进制/µs 级）；Drools/OpenL/Camunda 均 JVM。这是 cmx 相对 JVM 阵营的天然优势。
- **模型/范式**：cmx = **JDM 决策图 + DMN 决策表 + FEEL**（图优先多范式）；ZEN = JDM 图 + 表 + ZEN 表达式；Drools = RETE + DRL（产生式推理）；Camunda = DMN 标准；OpenL = Excel 决策表。
- **表达式语言（cmx 的核心差异 vs ZEN）**：cmx 坚持 **FEEL（DMN 血统）**——标准可信、可移植、业务可读、跨工具链互操作（Camunda/Drools/IBM）；ZEN 用私有方言，**不可 DMN 互操作**。代价是 cmx 目前是 **S-FEEL 子集**（缺时间类型/上下文字面量/自定义函数/Decimal128），非完整 DMN Level 3。
- **决策表 + 命中策略**：cmx **11 策略**（9 完整、P/O 部分），与 DMN 对齐；各家均有决策表。
- **决策图 DAG 编排**：cmx（拓扑 + 防环）与 ZEN（JDM 图）为图优先；Drools 有规则集/DRD 但非可视 DAG 编排；OpenL 无图。
- **产生式推理（RETE）**：**Drools 独有**（前向/后向链、大规模规则集）；cmx / ZEN / Camunda / OpenL 均无——cmx 是决策表/图求值，非产生式推理（企业高频决策以序列/表为主，Rete 后置可选 R7+）。
- **可解释 trace + 完备性（cmx 两点超越 ZEN）**：cmx 有**逐节点失败归因** + **gap/overlap 完备性分析**；ZEN 仅有「如何决策」的 trace，无失败归因、无完备性分析。Drools/Camunda 有 trace，OpenL 有部分校验。
- **设计器**：cmx 把**决策表 + 决策图设计器 + 仿真台 + 审计中心内置**于开源微服务；ZEN 是独立 React 编辑器组件；Drools 是重型 Business Central；OpenL 是 Excel + WebStudio。
- **脚本扩展**：cmx = **Rhai 沙箱**（判定侧仍 FEEL）；Drools = Java/MVEL；Camunda = FEEL/Java；ZEN = 表达式/函数。
- **多租户**：cmx **db-per-tenant** 原生；其余多依赖宿主/平台层。
- **部署/可嵌形态** ★：cmx = **库 + 服务 + Web 组件 + headless** 四形态；ZEN = 库 + 编辑器组件（服务化/多租户/审计需自建）；Drools = 库 + Workbench；OpenL = 服务 + WebStudio。
- **多语言 SDK**：**ZEN 领先**（8+ 语言原生绑定）；cmx 走 REST/headless + 可嵌 WC（Rust 内可直接作库）。
- **生态成熟度（诚实差距）**：Drools（20+ 年）与 ZEN 生态/社区远比 cmx 成熟；cmx 年轻，但作为**一体化 Rust 平台**（决策 + 流程 + 本体 + 数据权限 + 报表同栈）另有集成优势。

### 6.3 许可与开放性

{{FIG:openness}}

- **cmx-rulesengine = 真 Apache-2.0（OSI）**，一体化微服务（设计器/仿真/审计/多租户/headless 全内置），无生产许可门槛。
- **GoRules ZEN = MIT**（引擎 + React 编辑器全开源；商业 BRMS 另售）；**Drools/Kogito = Apache-2.0**；**OpenL = LGPL**；**json-rules-engine/easy-rules = ISC/MIT**——均真开源。
- **Camunda DMN** 随 Camunda 平台受限（CE 已 EOL；8.6+ 生产收费）；**IBM ODM / DecisionRules / Nected** 为商业/SaaS（按坐席或用量计费）。「许可 $0 ≠ 拥有成本 $0」——决策逻辑自持 vs 外购是关键抉择。

### 6.4 差异化优势 vs 诚实差距

**cmx 的差异化优势**：① 与 ZEN 并列的 **Rust** µs 级引擎，但把决策图 + 决策表 + 可视设计器 + 仿真台 + 审计 + 多租户 + headless + 可嵌组件**一体化**成 Apache-2.0 微服务（ZEN 是库+编辑器+商业BRMS）；② **FEEL/DMN 标准**判定（vs ZEN 私有方言），标准可信可移植；③ **gap/overlap 完备性分析 + 逐节点失败归因**（两点超越 ZEN）；④ Rhai 副作用与 FEEL 判定分离（判定可解释、可移植）；⑤ 与流程/本体/数据权限/报表同栈的**一体化平台**（metaKind 第五元）；⑥ **带业务落地案例**（单据转凭证、财务风控）。

**诚实差距**：① FEEL 是 **S-FEEL 子集**，非完整 DMN Level 3（Drools/Camunda 有认证 DMN/DRD；cmx 缺时间类型/自定义函数/Decimal128）；② **无 RETE**（Drools 的产生式推理/大规模规则集）；③ 多语言 SDK 少于 ZEN（走 REST/headless + WC，Rust 内可作库）；④ 生态/社区成熟度远逊 Drools/ZEN；⑤ P/O 命中策略与决策日志 TTL/归档尚为部分/待补。

---

## 七、测试与质量

{{FIG:tests}}

| 类别 | 数量 | 说明 |
| --- | ---: | --- |
| Rust 单测 | **63** | feel 35 · engine 24 · model 4；0 失败、0 ignored |
| 后端回归断言 | **146** | `qa-backend-1.sh`(98) + `qa-backend-2.sh`(48)：CRUD/发布/求值/11 策略/FEEL/图/gap-overlap/仿真/错误/删除级联/监控 |
| 脚本能力 SC0–SC4 | **55/55** | `qa-script.sh`：Rhai 接缝/四载体/沙箱/语法检查/黑盒完备性/trace/f64 归一/错误归因 |
| 数据保留 E2E | **11/11** | `e2e-script-preserve.sh`：每载体一代表决策/函数供设计器/仿真/审计查看 |
| 单据转凭证 | **13/13 · 16/16** | `p1/run.mjs`（3 单据类型 → 会计事件 → 两步决策 → 平衡凭证）+ `p2/run.mjs`（`cv_*` 四层装配） |
| 前端 CDP | **~20 · ~12** | `decision_graph_component.cjs`（图设计器 load→拖拽→连线→防环）+ `category_grouping.cjs`（分类分组） |
| clippy | **0 警告** | `--all-targets` |

文档口径：`测试报告-2026-08-17` 记 **223 断言 / 98.7%**；`脚本能力测试报告-2026-08-19` 记 **209/209 全绿**（单测 63 + 后端 146）。以上为历史快照，随迭代增长；当前实测 63 单测为准。

---

## 八、能力演进时间线

{{FIG:timeline}}

六条能力轨全部已交付并纳入回归：引擎核心（R0–R7，↔ flow S0–S6）、FEEL 引擎（R1）、决策图 JDM（R2）、脚本能力（SC0–SC4）、前端（F1–F5）、业务落地。里程碑代号取自源码/测试文件命名。

---

## 九、路线图 Now / Next / Later

{{FIG:roadmap}}

**Now（已交付并测试）**：决策表 11 策略、JDM 决策图 + 拓扑防环、自研 S-FEEL、gap/overlap 完备性、逐节点归因、Rhai 四载体、多租户、Headless、决策表 + 决策图设计器、仿真台 + 审计中心、单据转凭证 P1/P2、财务风控双案例。
**Next（标准完整度）**：全 FEEL CL3（时间/上下文/自定义函数）、Priority/OutputOrder 优先级列表、DMN 1.x 导入导出对齐、决策日志 TTL/归档。
**Later（世界级·择机）**：Rete/前向链推理节点、Switch 节点、`dsntk-rs` 全 FEEL 集成（评估）、Decimal128、PMML/评分卡、更多语言 SDK。

策略：把「决策表 + 决策图 + 可解释 + 完备性」做透并生产可靠，而非盲目追全 DMN/Rete 广度；企业高频决策以决策表/序列求值为主，Rete 后置可选。*Next/Later 为规划项，非承诺排期。*

---

## 十、结语

cmx-rulesengine 是一套**图优先、标准可信、可解释、完备性可分析**的 Rust 决策引擎：从 JDM 决策图（拓扑 + 防环）、决策表（11 命中策略）、自研 FEEL 引擎，到两点超越 ZEN 的 gap/overlap 完备性分析与逐节点失败归因，再到多租户、Headless 契约、内置决策表/决策图设计器与仿真/审计，端到端可用且经 63 Rust 单测 + 多层 E2E 真机验证，并有单据转凭证、财务风控等业务落地。它与 GoRules ZEN 并列为少数 Rust 决策引擎，却以 **FEEL 标准** + **完备性/可解释** + **一体化 Apache-2.0 微服务**形成差异化；同时诚实地把全 DMN FEEL、RETE 推理、更多语言 SDK 留在路线图上——**把决策做透、做可信、做可解释，而非什么都做但都浅**。

---

## 附录：来源与方法

- **能力/代码事实**：均来自对当前工作树的直接核对（`crates/cmx-rule-*/src`、根级 `qa-*.sh`/`e2e-*.sh`、`docs/full-test/`）。关键文件：`cmx-rule-model/src/{ir.rs,eval.rs}`、`cmx-rule-feel/src/{expr.rs,lib.rs,script.rs}`、`cmx-rule-engine/src/{lib.rs,graph.rs,analyze.rs}`、`cmx-rule-store-pg/src/{store.rs,ddl.rs}`、`cmx-rule-app/src/handlers.rs`。
- **规模/测试口径**：`cargo`/grep 实测——6 crate、5,642 src LOC、63 Rust 单测（0 ignored）；E2E qa-backend 146 · qa-script 55/55 · e2e-preserve 11/11 · 单据转凭证 P1 13/13 · P2 16/16；文档记 223 断言 98.7% / 209 全绿（历史快照）。
- **竞品事实**（2026-08 核对）：GoRules ZEN = Rust/MIT/JDM（引擎 + React 编辑器全开源，商业 BRMS 另售，8+ 语言绑定，ZEN 私有表达式方言）；Drools = Java/Apache-2.0/完整 DMN L3 + RETE；Camunda DMN 随平台（CE 已 EOL / 8.6+ 生产收费）；OpenL Tablets = Java/LGPL/Excel 决策表。
- **图表**：全部为自绘、内嵌 base64 的 SVG（CVD-安全调色板、状态以「图标+文字」编码不靠色区分）；工具链见 `docs/report/assets/`（`gen.mjs` 生成 · `shot.mjs` Chrome 渲图查版 · `build.mjs` base64 内嵌为 `<img>`）。
