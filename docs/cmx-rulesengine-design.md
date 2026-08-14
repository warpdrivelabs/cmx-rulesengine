# cmx-rulesengine · 独立规则引擎微服务 · 设计方案

> 对标全球最先进规则引擎（GoRules ZEN / Camunda DMN / Drools / IBM ODM），用 **Rust** 打造一个**可独立部署的决策规则引擎微服务**，架构范式**参照 `cmx-flowengine`（S0→S6）与 `cmx-report` 的"一芯多壳"**。
>
> **本文档只做方案设计，不动代码。** 版本 v1 · 2026-08-13
>
> 结论先行：**规则引擎与流程引擎是同一"能力中心"范式下的两个域** —— 前者管"**决策**（给定输入 → 产出结论）"，后者管"**流转**（人与节点的推进）"。`cmx-flowengine` 已把"独立微服务化"的所有**领域无关基建**（chassis / 多租户 / JWT / SSE / OpenAPI / center_client 反代 / distroless 部署）打磨成熟，规则引擎能**几乎原样站上去**，只把"BPMN 流程内核"换成"**决策图 + 决策表 + FEEL**"决策内核。且规则引擎**无长驻运行态**（无令牌/任务/定时器/poller），运行态比流程引擎更简单。

---

## 0. 一页速览

### 0.1 定位

`cmx-rulesengine` 是 CMX 平台 `metaKind` 分类学继 **DCT（字典）/ DOC（单据）/ FLX（流程表单）/ RPT（报表）** 之后的**第五元：RULE（决策规则）**。它对齐全球最先进的 Rust 规则引擎 **GoRules ZEN** 的形态（决策图 + 决策表 + 表达式 + 逃生舱、纯 Rust、嵌入式微秒级），并在两处**谋求超越**：

1. **表达式走 FEEL/DMN 标准**（ZEN 用私有方言，不与 DMN 工具链互通）—— 拿到"世界级"的标准可信度、可移植性、业务可读性。
2. **补齐 ZEN 缺失的两块世界级能力**：决策表 **gap/overlap 完整性分析**（空隙与重叠检测）+ 决策 **trace 记录失败归因**（ZEN 的 trace 不显示"哪个节点导致失败"）。

### 0.2 一句话架构

> **一芯多壳**：一个平台中立的决策内核 `cmx-rule-app`（`rule_routes::<S>()` 泛型路由对任意宿主 state 成立），既能**进程内嵌**进 CMXPortalManager 平台（`cmx-rule-api` 薄壳），又能**独立部署**为 headless 微服务（`cmx-rule-server` 独立 bin），切换只看平台 `[center_client.urls].rules` 配没配 —— 前端与装配**全零改**。**与 `cmx-flowengine` S6 的机制逐一对齐。**

```
                        ┌───────────────────── cmx-rule-app（平台中立"芯"）─────────────────────┐
                        │  rule_routes::<S>()  决策图求值 · 决策表命中 · FEEL · trace · 完整性分析  │
                        └──────────────┬──────────────────────────────────┬─────────────────────┘
             壳①内嵌（keep-wired）      │                                  │      壳②独立 bin（headless）
        ┌──────────────────────────────┴──────┐            ┌──────────────┴─────────────────────────┐
        │ cmx-rule-api（在 cmx-container 内）    │            │ cmx-rule-server（本 workspace，chassis 装配）│
        │  · RuleModule 内嵌                    │            │  · /api/rules/v1/*  + SSE + OpenAPI        │
        │  · RuleProxyModule 反代 → 远程         │            │  · JWT / API Key / 多租户 per-tenant DB    │
        └───────────────────────────────────────┘            └───────────────────────────────────────────┘
             平台 [center_client.urls].rules 空 = 内嵌（默认，零回归） │ 非空 = 独立（反代转发）
```

### 0.3 里程碑速览（对标 flowengine S0→S6）

| 里程碑 | 目标 | 对标 flow |
|---|---|---|
| **R0** | 决策内核 + 决策表求值 + 独立 bin 骨架（一芯双壳 + chassis 装配） | S0 |
| **R1** | FEEL 子集（S-FEEL）表达式引擎 + 决策表 **gap/overlap** 分析器 | —（规则特有） |
| **R2** | JDM 式决策图编排（多节点拓扑求值）+ DMN/JDM 导入导出 + 外部适配器 | S1 |
| **R3** | 多租户（per-tenant DB）+ JWT / API Key 认证 | S2 |
| **R4** | headless 契约（v1 前缀 + SSE 决策事件流 + OpenAPI/Swagger + 决策日志/审计 + trace） | S3 |
| **R5** | 前端一芯三壳（决策表编辑器 + 决策图设计器 + 仿真台 Web Components） | S4/S5 |
| **R6** | 平台 center_client 对接（RuleProxyModule + 认证桥）+ distroless 部署 | S6 |
| **R7+** | 进阶：Rete/前向链推理节点 + 全 FEEL(CL3) + 决策覆盖率 | —（择机） |

---

## 1. 对标全球最先进规则引擎 · 选型判断

> 本节是方案的**定调章**：范式选型直接决定 crate 划分、数据模型与 API 契约。所有事实经 2026-08 核实（详见 §1.5 来源与置信）。

### 1.1 范式全景（四大类）

规则引擎的"内核范式"本质是**如何组织规则、如何匹配、如何决定执行顺序**三件事的不同答案：

| 范式 | 核心数据结构 | 代表产品 | 适用场景 | 对本项目 |
|---|---|---|---|---|
| **① 产生式（Rete/PHREAK）** | 工作内存 + alpha/beta 网络 + 议程 + 冲突消解 | Drools(PHREAK)、CLIPS、NRules、Clara、IBM ODM RetePlus | 推理链 / 事实累积 / CEP / 专家系统 | **后置可选**（少数场景） |
| **② 决策表（DMN 标准）** | 输入列 × 规则行 × 输出列 + 命中策略 + DRD 图 | Camunda DMN、Drools/Kogito(kie-dmn)、OpenL Tablets | 无状态"输入→决策"（定价/资格/合规/风控） | **✅ 内核主体** |
| **③ 决策图（JDM，现代 JSON 化）** | JSON DAG + 节点类型枚举 | **GoRules ZEN**、DecisionRules.io | 编排多决策 + 可视化 + 嵌入式高性能 | **✅ 顶层编排** |
| **④ 表达式/评分卡** | 条件树 / 特征-分段-分值 | json-rules-engine、PMML Scorecard | 轻量条件 / 风控评分 / 模型交换 | 表达式层借鉴 |

**关键行业洞察（决定不以 Rete 为内核）**：**IBM ODM 同时提供三种执行算法** —— `RetePlus`（推理链）、`Sequential`（顺序、无推理链、高吞吐）、`FastPath`（高性能优化）。学术与厂商实践共识：**高吞吐无状态决策（信贷评分、核保、定价）主流走顺序/决策表执行，Rete 只在真需推理链的少数场景不可替代**。Rete 的代价是有状态、内存膨胀、可解释性差（"为什么烧了这条"要理解冲突消解）——与金融/ERP 域"审计压倒一切"的诉求相悖。

### 1.2 Rust 生态标杆：GoRules ZEN（最直接的参照物）

> ZEN 是当前 Rust 生态**唯一生产级、Drools 量级影响力**的业务规则引擎，也是本项目最直接的参照。

- **语言/许可**：纯 **Rust** 内核，**MIT**（全生态 MIT，可商用无限制）；`zen-engine` crate 版本约 **0.55.x**，GitHub `gorules/zen` 约 1.8k star。拆分为 `zen-engine`（编排）、`zen-expression`（表达式，独立可用）、`zen-types`、`zen-tmpl`。
- **JDM（JSON Decision Model）图结构**：数据从 **Input** 左→右流到 **Output**，中间 **5 类节点**：
  1. **Decision Table**（决策表，命中行输出决定返回）
  2. **Switch**（按表达式动态分叉图路径）
  3. **Expression**（把输入对象变换为另一对象，可引前一节点结果）
  4. **Function**（内嵌 **JavaScript** 经 QuickJS 执行，作逃生舱）
  5. **Decision**（调用子决策模型，`max_depth` 默认 5 防递归）
- **表达式语言**：**不是 FEEL** —— GoRules 自研的 business-first 方言（`#` 当前元素、`map/filter/some/all`、区间 `[1..10]`），与 DMN/FEEL **不互通**。
- **性能（务必用准确表述）**：官方基准 MacBook M3 单核 74 个真实决策 **平均 ~91K 次/秒**、纯决策表 **150K+/秒**、含 JS Function 节点降到 **3–50K/秒**（仅测纯求值，排除 I/O）。**营销措辞是"微秒/亚毫秒（microseconds/sub-millisecond）"，非"纳秒"** —— 方案中一律用"微秒级"。
- **编译执行**：`compile()` 预编译图中表达式/模板为**字节码**存 `compiled_cache`，避免每次重解析。
- **WASM**：`zen-expression` 一直可编 WASM；`zen-engine` 经 `rquickjs` bindgen 已能编 WASM，JDM Editor 可在浏览器内全量求值。
- **可视化 + 治理**：开源 **JDM Editor**（React，MIT，内置 GraphSimulator）；商用 **BRMS**（Git 式分支/合并、不可变 release、DEV→UAT→PROD 晋升、Change Requests 审批、Agent 轮询对象存储 etag → 内存原子零停机热切换）。
- **ZEN 的两处短板（我们的超越点）**：① **无 gap/overlap 完整性分析**；② decision **trace 不显示"哪个节点导致失败"**（官方确认 trace 是"如何做出决策"而非失败诊断）。

### 1.3 FEEL —— 决策逻辑的事实标准（表达式选型的锚）

**FEEL（Friendly Enough Expression Language）** 是 OMG DMN 标准内建的决策表达式语言，设计目标"业务人员够读懂、语义又严格无歧义"：

- **类型**：`number`（IEEE 754 Decimal128，34 位精度，无 int/float 之分，非法结果→`null` 不抛异常）、`string`、**三值 boolean**、`date/time/date-and-time`、两种 `duration`（年月 / 天时）、**1-indexed list**、`context`（有序键值、条目顺序求值可前引）、`function`、`null`（统一表示缺失与错误）。
- **区间**：`[1..10]` 闭 / `(1..10)` 开 / `[1..12)` 混合 / 反括号 `]1..10]`；可直接作决策表输入项（age 列填 `[18..65)`）或 `x in [1..100]`。
- **列表推导/量词**：`for x in list return e`、`some x in list satisfies c`、`every x in list satisfies c`、`list[predicate]` 过滤。
- **日期/时长运算**：date ± duration、两日期相减得 duration。
- **为什么是事实标准**：唯一被 OMG 标准化、厂商中立的决策表达式语言，被 Camunda、Drools/Kogito、IBM BAMOE、Oracle、SAP Signavio、Trisotech、Goldman Sachs jDMN、DecisionRules.io **广泛实现**；类英语可读（名字可含空格 `Applicant Age`）；纯函数/三值逻辑/null 不抛错 → 决策天然确定、可移植、单测友好。

**Rust 侧惊喜发现（决定 FEEL 路线可行）**：**`dsntk-rs`（Decision Toolkit，Apache-2.0 OR MIT）** 是完整的 Rust DMN + FEEL 实现，官方 **DMN TCK 榜通过 3374/3391 一致性测试**（超过 Go 的 QuantumDMN）。这意味着"在 Rust 走 FEEL 路线"**不再等于从零手写** —— 可复用或深度借鉴。

### 1.4 选型结论（本项目的三条硬判断）

**判断一 · 内核范式：以「JDM 式决策图 + DMN 决策表语义」为主，图优先多范式，Rete 后置可选。**

- 依据：① Rust 生态唯一生产级引擎 ZEN 正是此取舍且做到微秒级 MIT；② 企业高吞吐决策主流是顺序/决策表非推理（IBM ODM 佐证）；③ 本项目是无状态请求/响应微服务 + 金融/ERP 域，**决策图/表逐节点逐行 trace 天然可解释**，Rete 的冲突消解让"为什么"难说清；④ **gap/overlap 完整性分析在决策表模型上可做**（Rete 无对应物）。
- **留后门**：节点接口设计成可扩展，未来为少数需前向链/事实累积的场景（实时风控模式匹配）新增"推理节点"，底层可架在 `differential-dataflow`（Rust 最工业级增量计算基座）之上 —— **但内核不建在 Rete 上**。

**判断二 · 表达式：战略走 FEEL（S-FEEL 起步 → CL3），复用/借鉴 `dsntk-rs`；脚本逃生舱用 `rhai`/CEL；坚决避开 `evalexpr`。**

- 分层：**决策层**（决策表 unary test、boxed expression）**用 FEEL**（先 S-FEEL 覆盖比较/区间/枚举/`in`，即 CL2 决策表所需，Rust 可行；再按需长到全 FEEL CL3）→ 拿到 DMN 一致性 + 与 Camunda/Drools/IBM 工具链互通的世界级天花板。**编排/变换/逃生舱层**用 `rhai`（MIT/Apache，"Don't Panic"保证，可 no_std/WASM）或 `cel-interpreter`（MIT，沙箱策略语言，K8s 先例）。
- **法律红线**：**`evalexpr` 是 AGPL-3.0**，对闭源 SaaS 微服务是硬性法律阻断，**禁用**。
- **务实回退**：若上线时间压倒一切且暂不要 DMN 互通，可先复用 `zen-expression`（MIT/WASM）起步 —— 但**从一开始把表达式层做成可替换 trait**，别锁死。

**判断三 · 数据结构：类型化 DAG + 预编译字节码决策表 + 逐节点 trace（含失败归因）+ 内容寻址版本 + gap/overlap 分析。**（详见 §2）

### 1.5 来源与置信

- **高置信（多源交叉）**：范式分类、ZEN 的 JDM 5 节点/MIT/微秒级、FEEL 语义、evalexpr AGPL、dsntk-rs 过 TCK、IBM ODM 三算法、命中策略 11 变体、gap/overlap 是 OpenL/Drools 强项而 ZEN 缺。
- **集成前需复核（版本快照 2026-08-13）**：`zen-engine 0.55.x`、`rhai 1.25.x`、`cel-interpreter 0.10.x`、`datalogic-rs 5.1.x`、`differential-dataflow 0.25.x`、`dsntk-rs` 顶层 crate 精确版本与其**单一主维护者的长期维护风险**；`rust-rule-engine`（唯一声称 Rete 的通用 crate）**生产采用度无法核实，需独立安全/压测尽调**。
- **表述纪律**：ZEN 用"微秒级"非"纳秒级"；"FEEL 是事实标准"表述为"经广泛实现的事实标准"（基于采纳广度的合理论断，非直接引语）。

---

## 2. 领域内核设计（规则引擎的"BPMN 对等物"）

> 参照 `cmx-flow-model`（"语义中立内核"，不依赖任何 DB / cmx-* infra，可 wasm 复用）的组织方式，为规则引擎设计对等的 `cmx-rule-model`。

### 2.1 领域概念映射（flow → rule）

理解这张表 = 理解"为什么规则引擎能复用 flow 架构、又在哪里必须换血"：

| `cmx-flowengine`（流程） | `cmx-rulesengine`（规则） | 本质差异 |
|---|---|---|
| `ProcessDefinition`（流程定义） | `DecisionDefinition`（决策定义 = JDM 图 / 决策表 / 规则集） | 定义体换成决策图 |
| `FlowNode` / `NodeKind`（BPMN 节点） | `DecisionNode`（决策表 / 表达式 / Switch / Function / 子决策节点） | 节点语义换血 |
| BPMN XML 解析（`cmx-flow-bpmn`） | DMN XML + JDM JSON **双解析**（`cmx-rule-dmn`） | 决策模型标准 |
| `ProcessInstance` + `Token`（**长驻状态**，跨天/月） | `Evaluation`（**同步无状态求值**，微秒级） | **规则无长生命周期** |
| `Task` / 待办中心（人工等待） | **无**（决策全自动，无人工节点） | 运行态大幅简化 |
| `run_to_wait`（跑到人工等待态） | `evaluate`（跑到 Output，**永不等待**） | 一次求值到底 |
| `Timer` / poller（定时器轮询） | **无**（规则同步；可有"规则生效时间窗"作输入而非调度） | 无后台 poller |
| 会签/或签（多实例） | 决策表**命中策略**（COLLECT/RULE ORDER 等多结果聚合） | 概念平移 |
| `save_snapshot`（整实例快照事务） | `append decision_log`（**决策日志追加**，审计+可解释） | **重在追溯** |
| `AssigneeResolver`（候选人解析扩展点） | `DataSourceResolver` / `FunctionProvider`（事实/函数扩展点） | 同"可注入 trait"骨架 |
| RU/HI 表分离（11 张运行表 + 2 历史表） | **仅"定义 + 发布 + 决策日志 + 测试用例"**（无 RU 表） | 表数量锐减 |

**最重要的一条**：规则决策是**无状态、同步、微秒级**的"输入事实 → 输出决策"，**没有令牌、任务、等待态、定时器**。这让运行态比流程引擎**简单一个数量级**（无 poller、无令牌快照事务、无多实例记账），工程重心转移到：**可解释性（trace）、业务可维护（可视化决策表）、完整性（gap/overlap）、仿真测试**。

### 2.2 `cmx-rule-model` 语义中立内核（IR + 求值上下文 + trace + Store trait）

```
cmx-rule-model/src/
├── lib.rs            // 扁平化再导出稳定浅层 API（对标 cmx-flow-model/lib.rs）
├── ir/               // 编译产物（只读执行）
│   ├── graph.rs      //   DecisionGraph：类型化 DAG（nodes + edges），拓扑序求值
│   ├── node.rs       //   NodeKind 枚举 { Input, Output, DecisionTable, Expression, Switch, FunctionRef, DecisionRef, Custom }
│   ├── table.rs      //   DecisionTable：inputs[]/outputs[]/rules[]/hit_policy/aggregation
│   └── ruleset.rs    //   （R7+）产生式规则集 when-then（Rete 节点用）
├── feel/             // FEEL 表达式 AST + 值模型（见 §2.4；引擎在 cmx-rule-feel）
│   └── value.rs      //   FeelValue：number(Decimal128)/string/bool(三值)/date/duration/list/context/null
├── eval/             // 求值上下文与结果（driver 无关）
│   ├── context.rs    //   EvalContext：输入事实（零拷贝借 ZmcDataSet），左→右累积
│   ├── result.rs     //   EvalResult：输出 + 命中规则 + trace
│   └── trace.rs      //   TraceNode：{ node_id, inputs, outputs, matched_rules, timing_µs, failure? } —— 含失败归因（超越 ZEN）
├── analyze/          // 决策表完整性（世界级标志能力，ZEN 缺）
│   └── coverage.rs   //   gap（未覆盖输入组合）/ overlap（重叠规则）静态分析
├── error.rs          // Error / Result
└── store.rs          // DecisionStore trait（driver 无关持久化契约，对标 flow RuntimeStore）
```

**对外导出（稳定浅层 API）**：`DecisionGraph / NodeKind / DecisionTable / HitPolicy`（IR）；`EvalContext / EvalResult / TraceNode`（运行态）；`FeelValue`（值模型）；`CoverageReport`（gap/overlap）；`DecisionStore`（持久化契约）。**本 crate 不依赖任何 DB / cmx-* infra，可 wasm / 嵌入式复用** —— 与 `cmx-flow-model` 同纪律。

### 2.3 决策表求值 + 11 种命中策略

决策表是内核主体。`hit_policy` 求值器实现全部 11 变体：

| 类 | 策略 | 语义 |
|---|---|---|
| 单命中 | **U**nique | 不许重叠，命中唯一行 |
| 单命中 | **A**ny | 可重叠但输出须一致 |
| 单命中 | **P**riority | 按输出值优先级列表取最高 |
| 单命中 | **F**irst | 按行序取首个匹配（DMN 视为不良实践，慎用） |
| Collect 聚合 | **C+** / **C&lt;** / **C&gt;** / **C#** | 求和 / 最小 / 最大 / 计数 |
| 多命中 | **C**（Collect） | 无序结果列表 |
| 多命中 | **R**ule order | 按规则行序的列表 |
| 多命中 | **O**utput order | 按输出优先级序的列表 |

每个单元格的 unary test / 输出表达式**编译一次为 FEEL AST/字节码并缓存**（仿 ZEN `compile()`，按内容哈希键控），**绝不每次求值重解析**。

### 2.4 表达式引擎 `cmx-rule-feel`（对标 flow 的 expr / rpt 的 formula）

- **定位**：决策层的 FEEL 引擎。对标 `cmx-flow-model::expr`（自研 DSL，21 函数）与 `cmx-rpt-formula`（报表公式引擎），但**直接做 DMN 标准 FEEL 子集**，避开 flow "自研 DSL 再追 FEEL" 的弯路（flow gap-analysis §2.8 明确"应向 FEEL 靠拢"）。
- **分阶段**：R1 先 **S-FEEL 子集**（比较运算、区间 `[..]`、枚举列表、`in`、基本算术/字符串/布尔 —— CL2 决策表所需）；R7+ 长到**全 FEEL（CL3）**（列表推导 `for/some/every`、context、date/duration 运算、内置函数库）。
- **实现策略**：**优先评估直接复用/借鉴 `dsntk-rs`**（已过 TCK 3374/3391），而非从零手写。**表达式层封装为可替换 trait**（`ExprEngine`），保留"务实回退到 `zen-expression`"的能力，别锁死单一实现。
- **API**（对标 flow 的 `eval_condition/validate_syntax/builtin_catalog`）：`feel_eval(expr, ctx)` / `feel_validate(expr)` / `feel_functions()`（函数目录，供前端向导）。

### 2.5 求值引擎 `cmx-rule-engine`（对标 `cmx-flow-engine`）

- **图求值器**：`DecisionGraph` 拓扑排序求值（**复用 `cmx-hierarchy` 的 `topo_sort` 含环检测** —— 注意 memory 记录的"前缀误判成环"已修坑），一个 `EvalContext` 左→右流动累积；`DecisionRef` 子决策递归（`max_depth` 防护，仿 ZEN 默认 5）。
- **决策表求值器**：§2.3 的 11 命中策略。
- **完整性分析器**：§2.2 `analyze/coverage.rs`，对输入项区间/枚举做 gap（未覆盖组合）/ overlap（重叠规则）检测 —— **对标 OpenL `validateDT` / Drools `ANALYZE_DECISION_TABLE`，超越 ZEN**。
- **trace 生成**：每节点产 `TraceNode`（输入/输出/命中规则/微秒耗时/**失败归因**），汇成决策 trace 树。
- **（R7+）推理节点**：可选 Rete/前向链模块，**独立藏在"推理节点"后，不与核心图求值器纠缠**。

---

## 3. 目标架构：一芯多壳（逐一对齐 flowengine）

### 3.1 Workspace 与 crate 划分

独立 workspace `cmx-rulesengine/`（**非** cmx-container 成员，跨 workspace 用 `path` 复用 infra，与 `cmx-flowengine` / `cmx-report` 同策略）：

```
cmx-rulesengine/
├── Cargo.toml                 // [workspace] members + workspace.dependencies（版本对齐 cmx-container 根）
├── rust-toolchain.toml        // 锁工具链（与 cmx-container 对齐，避免"本机过 CI 不过"）
├── .cargo/config.toml         // nora registry 定义 + aliyun 镜像（跨 ws 解析 cmx-container infra 必需）
├── rules-server.toml(.example)// [auth]/[datasource] 段（对标 flow-server.toml）
├── .env                       // RULE_* 统一启动契约（dotenvy 自读）
├── crates/
│   ├── cmx-rule-model/        // 语义中立内核：IR(图/表/规则集) + FEEL 值 + 求值上下文 + trace + 完整性 + DecisionStore（§2.2）
│   ├── cmx-rule-feel/         // FEEL 表达式引擎（S-FEEL→CL3；复用/借鉴 dsntk-rs）   ← 对标 cmx-rpt-formula
│   ├── cmx-rule-dmn/          // DMN XML + JDM JSON 双解析/导入导出                  ← 对标 cmx-flow-bpmn
│   ├── cmx-rule-engine/       // 图求值 + 决策表命中 + gap/overlap 分析 + trace + (R7)推理 ← 对标 cmx-flow-engine
│   ├── cmx-rule-def/          // 定义持久化：草稿/发布/版本/不可变 release           ← 对标 cmx-flow-def
│   ├── cmx-rule-store-pg/     // PG 存储：决策日志/审计/测试用例                     ← 对标 cmx-flow-store-pg
│   ├── cmx-rule-adapters/     // 外部适配器：数据源/函数/子决策 loader（三注入 trait 实现）← 对标 cmx-flow-adapters
│   ├── cmx-rule-app/          // 平台中立装配核：handlers + rule_routes::<S>() + resp + auth + tenant + tenancy + engine + events + openapi + stats + dashboard + frontend_pages ← 对标 cmx-flow-app
│   ├── cmx-rule-server/       // 独立 bin（chassis 声明式装配 + banner + 钩子）      ← 对标 cmx-flow-server
│   ├── cmx-rule-demo/         // 独立可跑样板 + seed 决策集                          ← 对标 cmx-flow-demo
│   └── cmx-rule-tests/        // 引擎测试套件（单测 + PG 集成 + FEEL TCK 子集 + CDP） ← 对标 cmx-flow-tests
└── web/                       // 前端一芯三壳（无打包器纯静态 ESM，见 §5）
    ├── core/ · elements/ · ui-native/ · ui-html/ · demo/
    └── deploy/                // Dockerfile(distroless) + docker-compose + initdb
```

> **平台壳 `cmx-rule-api` 留在 `cmx-container`**（keep-wired，跨 ws `path` 引本库 `cmx-rule-app`）—— 与 `cmx-flow-api` 同位置同策略。它承载 `RuleModule`（内嵌）与 `RuleProxyModule`（反代），见 §10。

### 3.2 "一芯"：`rule_routes::<S>()` 泛型路由核

完全对齐 `cmx-flow-app::flow_routes::<S>()` 的做法 —— handler **丢弃绑定不用的 `State/Context` 提取器**，使路由表对**任意宿主 state 泛型 `S`** 成立：

```rust
// cmx-rule-app/src/lib.rs（镜像 cmx-flow-app/src/lib.rs）
pub fn rule_routes<S>() -> Router<S>            // 旧前缀 /rules/*（内嵌壳兼容）
where S: Clone + Send + Sync + 'static { Router::new().nest("/rules", rule_routes_inner::<S>()) }

pub fn rule_routes_v1<S>() -> Router<S>         // v1 正式契约 /rules/v1/*（headless）+ SSE
where S: Clone + Send + Sync + 'static {
    Router::new().nest("/rules/v1", rule_routes_inner::<S>().route("/events", get(events::sse_events)))
}

fn rule_routes_inner<S>() -> Router<S> { /* §6 全部端点 */ }
```

- **平台壳** `cmx-rule-api`：`rule_routes::<cmx_api::CmxAppState>()`
- **独立壳** `cmx-rule-server`：`rule_routes::<()>()`
- 两壳复用**同一 handler + 同一路由表**，**零业务漂移** —— flow S0 已验证此模式。

### 3.3 "壳②独立 bin"：chassis 声明式装配

`cmx-rule-server/src/main.rs` 镜像 `cmx-flow-server/src/main.rs`（约 200 行声明式）：

```rust
#[tokio::main]
async fn main() -> cmx_web_chassis::Result<()> {
    dotenvy::dotenv().ok();                              // .env → RULE_* 环境变量
    cmx_service_base::init_config_manager().ok();        // 全局 ConfigManager（各能力中心共用那段）
    let mut cfg = ChassisConfig::load("rules", "RULE", "rules-server.toml"); // 默认端口 8094（避开 8080/8091/8092）
    apply_toml_env();                                    // toml [auth]/[datasource] → RULE_* env（env 优先）

    let banner = BannerSpec::defaults("rules").art(RULES_ART)   // "MEGA RULES" 字符画 + 专属渐变
        .tagline("  MEGA Rules · 决策规则引擎微服务 · cmx-web-chassis ");

    let authed = rule_routes_v1::<()>().merge(rule_routes::<()>())
        .layer(from_fn(observe_middleware)).layer(from_fn(auth_middleware));
    let app_router = Router::new()
        .route("/", get(dashboard::dashboard))          // 根 = 决策引擎监控大盘（免认证，轮询 /stats）
        .nest("/api", Router::new().merge(authed)
            .merge(frontend_pages::routes::<()>())       // native + html 页只读投递（门户 F3 反代取页）
            .merge(SwaggerUi::new("/rules/v1/docs").url("/rules/v1/openapi.json", rule_openapi())));

    cmx_web_monitor::set_service_name("cmx-rules 决策引擎");    // /_mon 技术监控
    cmx_web_monitor::set_identity_provider(identity_snapshot);
    cmx_web_monitor::set_topology_provider(|| vec![/* rules embedded */]);

    let spec = ServiceSpec::<()>::new("rules", cfg).banner(banner).nest_api(false).router(app_router).state(())
        .init("datasources", |_| Box::pin(register_pg_datasources(...)))   // 钩子① 注册 RULE_PG_URL
        .init("engine", |_| Box::pin(async { warm_definitions().await.ok(); Ok(()) })); // 钩子② 预编译已发布决策（无 poller！）
    run(spec).await
}
```

**与 flow 的唯一实质差异**：钩子② **不起定时器 poller**（规则无定时器/长驻实例），改为**预编译已发布决策图到内存缓存**（仿 ZEN `compiled_cache`）。**运行态无后台线程** —— 纯请求驱动的无状态求值。

---

## 4. 外部适配器（可注入扩展点，对标 flow 三注入 trait）

`cmx-rule-adapters` 镜像 `cmx-flow-adapters` 的"env mode(mock|http|pg) 选择 + trait 注入"范式。规则引擎的三个扩展点：

| 适配器 trait | 职责 | mock | pg | http |
|---|---|---|---|---|
| **`DataSourceResolver`** | 决策求值时按需拉取**输入事实/维表**（如"查该客户信用等级"），零拷贝借 `ZmcDataSet` | 内存桩 | 直连库查询 | 回连平台数据服务 |
| **`FunctionProvider`** | 决策图 **Function 节点**的自定义函数（对标 ZEN 的 JS 逃生舱，但用 `rhai`/CEL 沙箱替代 JS） | 内置函数 | — | 回连外部函数服务 |
| **`DecisionLoader`** | 加载决策定义（对标 ZEN 三 loader `Filesystem/Memory/Closure`） | Memory | DB（`cmx-rule-def`） | 远程对象存储 + etag 热切换（仿 GoRules Agent） |

- **默认 mode**：`RULE_DATASOURCE_MODE=pg`（零回归内嵌姿态），env 切 mock（demo）/ http（回连平台）。
- **engine.rs `build()` 三 match 注入** —— 完全对齐 flow adapters 的 `HttpAssigneeResolver/SubflowRouter/Delegate` 注入位。

---

## 5. 前端一芯三壳（对标 flow web/ + S4/S5）

`web/` 无打包器纯静态 ESM（镜像 `cmx-flowengine/web/`），一芯（`core/`，从平台拷，遵 vendor 同步纪律 [[cmx-megasheet-vendor-dual-bundle]]）三壳：

| 壳 | 落点 | 说明 |
|---|---|---|
| **壳① 门户内嵌** | `ui-native/rule/` + `ui-html/` | 平台四区工作台：explorer（决策集树）+ content（决策表电子表格编辑 / 决策图画布）+ property（命中策略/输入输出列/gap-overlap 报告） |
| **壳② Web Component** | `elements/{rule-decision-table, rule-graph-designer, rule-simulator, base-element}.js` | 框架无关 custom element（对标 flow `flow-todo/flow-designer/flow-task-form`）：属性 `api-base/token/tenant` → `core.configure`；三区 shadow host；CustomEvent 塌缩回调链 |
| **壳③ headless** | 无前端 | 第三方自研 UI 直接调 `/api/rules/v1/*` |

**三个核心前端能力**（规则引擎特有，业务可维护是第一价值）：
1. **决策表编辑器**：电子表格式（可复用 `cmx-spreadsheet`/`cmx-megasheet` 内核！输入列/规则行/输出列 = 网格），FEEL 单元格 + 命中策略选择器 + **实时 gap/overlap 高亮**。
2. **决策图设计器**：DAG 画布（对标 flow 的 bpmn-js 四区，可用轻量图库或复用同款壳），节点拖拽 + 连线 + 子决策引用。
3. **仿真测试台**：输入 → 逐节点 trace 可视化（含**失败节点红标**，超越 ZEN）+ 测试用例批跑 + 覆盖率。

---

## 6. Headless API 契约（`/api/rules/v1/*`，对标 flow S3）

`rule_routes_inner::<S>()` 端点清单（v1 正式契约，破坏性变更进 v2）：

```
# —— 定义（设计器：草稿/发布/版本，对标 flow definitions） ——
GET    /rules/v1/definitions                     决策集列表
GET    /rules/v1/definitions/{key}               决策定义详情（JDM 图 / 决策表）
POST   /rules/v1/definitions/draft               存草稿
POST   /rules/v1/definitions/validate            结构 + FEEL 语法校验
POST   /rules/v1/definitions/{key}/publish       发布 → 不可变 release + version+1
GET    /rules/v1/definitions/{key}/versions      版本列表
POST   /rules/v1/definitions/{key}/versions/{v}/activate   激活某版本

# —— 求值（核心，无状态） ——
POST   /rules/v1/decisions/{key}/evaluate        按 key 求值：输入事实 → 输出 + trace
POST   /rules/v1/evaluate                        内联图求值（图 + 输入一起传，不落库，供试算）
POST   /rules/v1/decisions/{key}/evaluate/batch  批量求值（一次多组输入，高吞吐）

# —— 完整性 / 仿真 / 测试（世界级能力） ——
POST   /rules/v1/decisions/{key}/analyze         gap/overlap 完整性分析报告
POST   /rules/v1/decisions/{key}/simulate        仿真：输入 → 逐节点 trace（不落审计日志）
GET    /rules/v1/decisions/{key}/tests           测试用例列表
POST   /rules/v1/decisions/{key}/tests/run       跑测试套件（输入→期望 diff + 覆盖率）

# —— 决策日志 / 审计（可解释性下钻） ——
GET    /rules/v1/decisions/{key}/logs            决策日志列表（分页）
GET    /rules/v1/logs/{id}                        单次决策全量 trace（哪行命中/哪些输入/失败归因）

# —— FEEL 表达式（前端向导后端） ——
POST   /rules/v1/feel/eval                        表达式求值（试算）
POST   /rules/v1/feel/validate                    语法校验
GET    /rules/v1/feel/functions                   FEEL 函数目录（向导用）

# —— 监控大盘 + SSE ——
GET    /rules/v1/stats                            引擎聚合（决策集数/日均求值/命中率/热点决策/时延分布）
GET    /rules/v1/events                           SSE 决策事件流（第三方 UI 增量刷新替轮询）
GET    /rules/v1/openapi.json + /docs             OpenAPI + Swagger（免认证，公开文档）
```

**求值请求/响应信封**（自持 `resp.rs`，字节对齐 `cmx-api-types`，不借 cmx-api —— 对标 flow S0）：

```jsonc
// POST /rules/v1/decisions/credit_approval/evaluate
{ "input": { "amount": 50000, "creditScore": 720, "region": "north" },
  "options": { "trace": true } }
// → 200
{ "code": 0, "data": {
    "output": { "approved": true, "tier": "A", "maxLimit": 100000 },
    "trace": [ { "nodeId": "table_1", "matchedRules": [3], "timingUs": 12, "failure": null }, ... ],
    "logId": "…" } }         // logId → GET /logs/{id} 下钻可解释
```

---

## 7. 多租户 + 认证（几乎照搬 flow S2/S3）

规则引擎的多租户/认证是**领域无关**的，直接复用 flow 的成熟实现：

- **`tenant.rs`**：`task_local` TENANT scope（无 scope 回退 `default` = 零回归），镜像平台 `context_scope`。
- **`tenancy.rs`**：`RULE_TENANCY=single|multi`，租户 → `db_id` 派生 `rules_<tenant>`，URL 模板懒注册。
- **`engine.rs`**：`OnceCell-per-tenant` 编译缓存，`rules(tenant)` 返 `Arc<RuleRuntime>`，map 锁只护取 cell、昂贵 build 单飞。**注意 memory 记录的坑**：`flow()` 返 `Arc` 致 17 处助手需 `&rt`（编译 ICE 掩盖真错 E0308）；租户名 db 派生**须 lowercase**（flow S6 `tenantB → rules_tenantb` 大小写敏感坑）。
- **`auth.rs`**：`jsonwebtoken` 验 HS256/RS256，`RULE_AUTH_MODE=off|jwt`；API Key（`RULE_API_KEYS`）服务身份；**委托用户令牌**（`X-Delegated-User-Token`）—— 与 flow S6 认证桥逐字对齐（租户优先取委托 claim，验签失败退化纯服务不 401）。

---

## 8. 数据模型（表前缀 `cmx_rule_`，PG · schema public · 无外键）

**规则引擎无 RU 运行表**（决策无长驻状态）—— 这是相对 flow（11 RU + 2 HI 表）的最大简化。仅 **4 张表**：

| 表 | 职责 | 对标 flow |
|---|---|---|
| **`cmx_rule_definition`** | 决策定义（key/名称/`metaKind:RULE`/草稿态/当前版本），`JSONB` 存 JDM 图 IR + 决策表 | `cmx_flow_def` 定义表 |
| **`cmx_rule_release`** | **不可变发布**（key + version + 发布时 IR 快照 + `rev=xxhash64` 内容哈希 + 发布人/时刻），激活版本供求值装载 | flow 发布版本 |
| **`cmx_rule_decision_log`** | **决策日志/审计**（每次求值：决策 key+version / 输入 JSONB / 输出 JSONB / 命中规则 / trace JSONB / 时延 µs / 租户 / 调用方），可解释性 + 合规回溯 —— 规则引擎的"HI" | `cmx_flow_hi_*` 历史表 |
| **`cmx_rule_test_case`** | 测试用例（决策 key / 输入 / 期望输出 / 断言），仿真回归 + 覆盖率 | —（规则特有） |

- 主键 `VARCHAR(64)`（后端铸号，对齐 [[bigint-id-backend-generation]] / flow UUID）；时间 `TIMESTAMPTZ`；变量/图/trace 全 `JSONB`。
- **建表**：R0 引擎 `ensure_schema` 幂等建表（对标 flow，容错并发建表竞争）；平台内嵌姿态经 `model-deploy` 建（对标 cmx-report fico 建表 seed）。
- **决策日志生命周期**：R7+ 补 TTL/归档（高频求值日志会无限增长，flow gap-analysis §2.7 同款治理缺口，提前规划）。

---

## 9. 可复用公共库与 crate 清单

### 9.1 复用 cmx-container infra（跨 ws `path`，零重造）

| crate | 用途 |
|---|---|
| **`cmx-web-chassis`** | 通用服务骨架：启动/分层日志/中间件栈/优雅关闭/banner —— `run(spec)` 声明式装配 |
| **`cmx-service-base`**（`default-features=false`） | pg 数据源注册原语 `register_pg_datasources` + `init_config_manager`（不拉 Redis/sqlx，零负担） |
| **`cmx-web-monitor`** | `/_mon` 技术监控（系统/DB池/请求遥测）+ 拓扑面板，`set_*_provider` 注入 |
| **`cmx-database-pg`** | tokio-postgres 并行 DB 层（多源池 / `query_sql` / 事务门面） |
| **`cmx-core`** | `DataValue` 强类型写入 + `ZmcDataSet` 零拷贝读（决策输入事实零拷贝借入） |
| **`cmx-hierarchy`** | `topo_sort` 含环检测（决策图 DAG 求值序） |

### 9.2 新引外部 crate（版本对齐、许可合规）

| crate | 用途 | 许可 | 备注 |
|---|---|---|---|
| **`dsntk-rs`** 或自研 FEEL | FEEL 表达式引擎（S-FEEL→CL3） | Apache/MIT | 优先复用/借鉴（过 TCK）；封 `ExprEngine` trait 可替换 |
| **`rhai`** | Function 节点脚本逃生舱 | MIT/Apache | 沙箱、Don't Panic、可 WASM |
| （备选）`cel-interpreter` | 策略条件语言 | MIT | K8s 先例，沙箱 |
| （R7+）`differential-dataflow` | 推理节点增量匹配基座 | MIT | 仅当 Rete 场景成硬需求 |
| `jsonwebtoken` / `tokio-stream` / `utoipa` + `utoipa-swagger-ui` | 认证 / SSE / OpenAPI | 各自宽松 | 与 flow 同版本 |
| **`xxhash-rust`**（xxh64） | release `rev` 内容哈希 | — | 字节对齐门户 `content_rev` |

> **禁用 `evalexpr`（AGPL-3.0）** —— 闭源微服务法律阻断。

---

## 10. 部署 · 平台集成（center_client 对接，对标 flow S6）

### 10.1 平台内嵌 ↔ 独立切换（一行配置）

平台 `/api/rules/*` 由**配置**决定走哪条路（与 flow S6 逐一对齐）：

```toml
# 平台 dev-local.toml（空/不配 = 内嵌，零回归；非空 = 反代到独立 rules-server）
[center_client.urls]
rules = "http://localhost:8094"                 # 非空 → RuleProxyModule 转发
[service_auth]
outgoing_api_key = "cmx_sk_platform_to_rules"   # 注入 X-API-Key
```

- **`cmx-rule-api`（平台内）**：`RuleModule`（内嵌，`rule_routes::<CmxAppState>()`）与 `RuleProxyModule`（反代 `/api/rules/{rest}` → `{base}/api/rules/v1/{rest}`，双向流式 + SSE 透传 + 三层出站头注入）**并存**，`routes.rs` 按 `rules_remote_base()` 二选一。
- **认证桥**（`cmx-rule-app/auth.rs`）：API Key 命中服务身份 + 解 `X-Delegated-User-Token` 委托令牌取真实调用方 —— 与 flow S6 `decode_claims` 逐字对齐。
- **无 poller 差异**：规则内嵌姿态本就无后台线程，`rules_is_proxied()` 也无需跳 poller（比 flow 还简单）。

### 10.2 部署（`deploy/`，对标 flow S6）

- **`Dockerfile`**：多阶段 builder → **distroless**（无 shell、小攻击面），工具链锁定与 cmx-container 对齐。
- **`docker-compose.yml`**：postgres + rules-server 最小拓扑，演示"独立部署"姿态。
- **三姿态**：① 平台内嵌（不配 rules url）② 独立 + 平台反代 ③ 三方全 headless（只用 `/api/rules/v1/*` + SSE + OpenAPI，连平台都不要）。

---

## 11. 分阶段路线图（R0→R7）

| 里程碑 | 交付 | 验收 |
|---|---|---|
| **R0 · 内核骨架** | `cmx-rule-model`（IR + 决策表求值 + trace）+ `cmx-rule-engine` 单决策表求值 + `cmx-rule-server` chassis bin（一芯双壳）+ 4 表 schema | `curl /api/rules/v1/decisions/{key}/evaluate` 单表求值通；banner/日志/`/_mon` 起 |
| **R1 · FEEL + 完整性** | `cmx-rule-feel`（S-FEEL 子集，复用/借鉴 dsntk-rs）+ gap/overlap 分析器 + `/analyze` 端点 | FEEL TCK 子集测试绿；决策表空隙/重叠报告正确 |
| **R2 · 决策图 + 适配器** | JDM 图拓扑求值（多节点 + 子决策）+ DMN/JDM 导入导出 + `cmx-rule-adapters`（三注入 trait，mock/pg/http） | 多节点图端到端求值 + trace；导入一张 DMN 决策表求值等价 |
| **R3 · 多租户 + 认证** | `tenant.rs`/`tenancy.rs`/`engine.rs`(OnceCell-per-tenant)/`auth.rs`（照搬 flow S2） | 单租户零回归 + 多租户 API/DB 级物理隔离 + JWT 401 矩阵 |
| **R4 · headless 契约** | v1 前缀 + SSE 决策事件流 + OpenAPI/Swagger + 决策日志/审计 + 失败归因 trace | swagger 200；SSE 收决策事件；`/logs/{id}` 全量 trace 下钻 |
| **R5 · 前端一芯三壳** | 决策表编辑器（复用 spreadsheet 内核）+ 决策图设计器 + 仿真台；Web Components 壳 + 门户 native/html 页 | CDP 三区真机：编辑决策表→gap/overlap 高亮→仿真 trace→发布 |
| **R6 · 平台对接 + 部署** | `cmx-rule-api`（RuleModule + RuleProxyModule + 认证桥）+ 平台配置切换 + distroless deploy/ | 认证矩阵 7/7（对齐 flow S6）；内嵌↔独立切换零前端改；引擎零回归 |
| **R7+ · 进阶（择机）** | Rete/前向链推理节点（differential-dataflow）+ 全 FEEL(CL3) + 决策覆盖率报表 + 决策日志 TTL/归档 | 推理场景样例；CL3 TCK 子集；覆盖率% |

**关键顺序判断**：R0–R2 是**领域内核**（规则引擎的真正难点，无 flow 现成代码可搬）；R3–R6 是**基建复用**（几乎照搬 flow S2/S3/S6，工程量小、风险低）。**建议先集中攻 R0–R2 把决策内核做扎实，再快速套 R3–R6 的成熟基座。**

---

## 12. 诚实的结论

**这是一个"起点即对标世界级、且有明确超越路径"的项目 —— 因为它站在两个巨人的肩膀上。**

- **架构风险低**：`cmx-flowengine`（S0→S6）已把"Rust 能力中心独立微服务化"的所有领域无关基建（chassis / 多租户 / JWT / SSE / OpenAPI / center_client 反代 / distroless）验证通了，`cmx-report` 二次印证。规则引擎**几乎原样复用**，且运行态**更简单**（无令牌/任务/定时器/poller/RU 表）。R3–R6 是低风险的模式复制。

- **领域内核是真正的工作量**：R0–R2 的"决策图 + 决策表 + FEEL + 完整性分析"没有现成代码可搬，是本项目的**技术重心**。但选型已锚定：**对标 ZEN 的形态**（图 + 表 + 表达式 + 逃生舱，纯 Rust 微秒级），**用 FEEL/dsntk-rs 拿标准红利**（ZEN 没有的可移植性/业务可读/工具链互通），**用 gap/overlap + 失败归因 trace 超越 ZEN**（它恰缺这两块）。

- **战略取舍（诚实）**：**不以 Rete 为内核**（企业高吞吐决策主流是顺序/决策表，Rete 留作 R7+ 可选推理节点）；**不追分布式高吞吐**（无状态求值天然水平扩展，多副本 + 负载均衡即可，无需分区日志）；**不自研表达式方言**（走 FEEL 标准，别重蹈 flow "自研 DSL 再追 FEEL" 的弯路）。

- **与 CMX 平台的天然契合**：规则引擎是 `metaKind` 分类学的**第五元 RULE**，与 RPT 报表**高度同构**（都是"一张可视化编辑的模型 + model-deploy 建表 + rev 哈希 + DB 数据服务"），可直接复用报表的 spreadsheet 内核（决策表 = 网格）、`rev=xxhash64`、model-deploy 范式。它补上的是平台此前缺失的一环：**把频繁变更的业务决策逻辑（审批矩阵/定价/风控/资格）从代码和流程图里剥离出来，交给业务人员可视化维护** —— 这正是 flow gap-analysis §2.4 点名的"决策与规则（DMN）完全空白"的答案，且做成独立微服务后，flow 的 `businessRuleTask` 可直接调它。

一句话：**用 flow 验证过的独立微服务骨架，装一个对标 ZEN、以 FEEL/DMN 谋求标准可信度与完整性分析超越的决策内核 —— 架构确定、内核有锚、超越有据。**

---

## 13. 工作量与风险矩阵

| 模块 | 工作量 | 风险 | 缓解 |
|---|---|---|---|
| R0 决策表求值内核 | 中 | 低 | 语义清晰（DMN 标准），无并发状态 |
| R1 FEEL 引擎 | **高** | **中** | **优先复用/借鉴 `dsntk-rs`**（过 TCK），封 trait 可替换；先 S-FEEL 子集控范围 |
| R1 gap/overlap 分析 | 中 | 中 | 参照 OpenL `validateDT` 算法；区间/枚举覆盖是可判定问题 |
| R2 决策图编排 | 中 | 低 | 拓扑求值成熟（复用 `cmx-hierarchy::topo_sort`），子决策递归加 max_depth |
| R2 DMN/JDM 解析 | 中 | 中 | DMN XML 用 `roxmltree`（flow 同款）；JDM JSON 直 serde |
| R3–R6 基建复用 | 低 | **低** | **照搬 flow S2/S3/S6**，逐字对齐（含 memory 记录的租户 lowercase / Arc &rt 等坑） |
| R5 前端 | 中 | 中 | 决策表复用 spreadsheet 内核；图设计器复用 flow 四区壳；遵 vendor 三产物同步纪律 |
| 依赖尽调 | 低 | 中 | `dsntk-rs` 单一维护者 / `rust-rule-engine` 采用度 → 集成前独立安全/压测；**禁 evalexpr(AGPL)** |

---

*cmx-rulesengine 设计方案 · v1 · 2026-08-13 · 只做设计不动代码*
*对标 GoRules ZEN / Camunda DMN / Drools / IBM ODM · 参照 cmx-flowengine(S0→S6) 一芯多壳 · metaKind 第五元 RULE · R0→R7 路线*

