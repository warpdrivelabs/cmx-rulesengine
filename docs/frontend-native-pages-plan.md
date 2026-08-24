# cmx-rulesengine 功能缺口分析 + 前端 native-pages 落地方案

> 在 R0（决策表内核 + 独立 bin 真机跑通）之上，对规则引擎做一次**全面缺口盘点**，并给出**前端（定义设计 + 应用仿真）的 native-pages 落地方案**。前端页面**归本仓 `cmx-rulesengine/web/ui-native/`**、由微服务自投递、门户 CMXPortalManager 经 F3 反代——**与 cmx-flowengine / cmx-report 逐一对齐**（一芯双壳）。
>
> **本文档只做分析与方案，除必要时不动代码。** 版本 v1 · 2026-08-15
>
> 结论先行：**R0 打通了"引擎能求值"，但距离"可交付的规则引擎产品"还差三块——① 后端支撑前端的端点（发布/版本/analyze/simulate/tests/feel-functions）② 前端两套工作台（决策表设计器 + 决策仿真/应用台，native-pages 四页两层）③ 门户接入管道（自投递路由 + F3 反代 + 菜单落库）。** 三块都有 flow/report 的成熟先例可照搬。

---

## 0. 一页速览：现状 vs 完整规则引擎

图例：🟢 已落地　🟡 部分/骨架　🔴 缺失

| 维度 | 现状 | 缺口级别 | 补法来源 |
|---|---|:--:|---|
| **决策表求值内核** | 单表 + 11 命中策略 + trace（含失败归因） | 🟢 | R0 已落地 |
| **FEEL 表达式** | S-FEEL unary test 子集 | 🟡 | R1（复用 dsntk-rs） |
| **发布 / 版本管理** | `cmx_rule_release` 表已建，**无端点** | 🔴 | 补 3 端点 |
| **gap/overlap 完整性分析** ⭐ | `CoverageReport` 类型已建，**无算法+端点** | 🔴 | R1 内核 + 1 端点（超越 ZEN） |
| **仿真 / 测试用例** | `cmx_rule_test_case` 表已建，**无端点** | 🔴 | 补 3 端点 |
| **FEEL 函数目录** | 无（前端向导刚需） | 🔴 | 补 1 端点 |
| **决策图（JDM）** | `DecisionBody` enum 预留 Graph 变体 | 🔴 | R2 |
| **DMN XML 导入导出** | 无 | 🔴 | R2 |
| **native-pages 投递** ⭐ | 无 `native_pages.rs`、无 `web/` | 🔴 | 镜像 flow `frontend_pages.rs` |
| **前端：决策表设计器** ⭐ | **无**（无 `web/` 目录） | 🔴 | 镜像 rpt designer 双工作台 |
| **前端：决策仿真/应用台** ⭐ | **无** | 🔴 | 镜像 rpt applier |
| **门户接入（F3 反代 + 菜单）** | cmx-container 无 `cmx-rule-api`、`CenterUrlsConfig` 无 `rules`、无菜单迁移 | 🔴 | 照抄 rpt proxy 管道 |
| **多租户 / 认证** | off/jwt/apikey + 租户 scope | 🟡 | R3 补 per-tenant DB |
| **SSE / Swagger UI / 批量** | 仅 openapi.json | 🟡 | R4 |
| **监控大盘 / _mon** | 已有 | 🟢 | R0 已落地 |

**一句话定位**：后端引擎"能算"已成立，**产品化的两大主线是"前端两套工作台"和"支撑它们的后端端点 + 门户接入管道"**——本方案聚焦这两条主线。

---

## 1. 后端功能缺口（按支撑前端的优先级）

当前实际路由 **11 个**（`cmx-rule-app/src/lib.rs`），方案 §6 规划 **~22 个**。缺口分三档：

### 1.1 🔴 P0 —— 前端刚需的端点（不补则设计器/仿真台做不出来）

| # | 端点 | 前端消费者 | 后端工作量 | 依赖 |
|---|---|---|---|---|
| B1 | `POST /definitions/{key}/publish` | 设计器"发布"按钮 | 小（写 `cmx_rule_release` + rev 哈希 + `published=true`） | 表已建 |
| B2 | `GET /definitions/{key}/versions` | 设计器/仿真台版本切换 | 小（查 release 表） | 表已建 |
| B3 | `POST /definitions/{key}/versions/{v}/activate` | 版本激活 | 小（`active` 列翻转） | 表已建 |
| B4 | `POST /decisions/{key}/analyze` ⭐ | 设计器**实时空隙/重叠高亮** | 中（gap/overlap 算法，R1 内核） | `CoverageReport` 类型已建 |
| B5 | `POST /decisions/{key}/simulate` | 仿真台（求值但不落审计日志） | 小（`evaluate` 加 `log=false` 变体） | 已有 evaluate |
| B6 | `GET /decisions/{key}/tests` + `POST /decisions/{key}/tests`（存） | 测试用例列表/保存 | 小（CRUD `cmx_rule_test_case`） | 表已建 |
| B7 | `POST /decisions/{key}/tests/run` | 测试批跑（输入→期望 diff + 覆盖率） | 中（批量 evaluate + diff） | 依赖 B6 |
| B8 | `GET /feel/functions` | 设计器**函数向导**（不手写表达式） | 小（返回内置函数目录 + 元数据） | feel crate 补目录 |
| B9 | **native-pages 投递**：镜像 `frontend_pages.rs` → `cmx-rule-app/src/native_pages.rs` + 挂 `/native-pages/*` | **门户 F3 反代取页的前提** | 小（照抄 flow） | 见 §4.1 |

### 1.2 🟡 P1 —— 内核能力（决定"世界级"深度）

| # | 能力 | 说明 |
|---|---|---|
| B10 | **gap/overlap 分析算法** | `analyze.rs` 类型已建，R1 实现区间/枚举覆盖检测（对标 OpenL `validateDT`，超越 ZEN）——B4 端点的内核 |
| B11 | **全 FEEL（CL3）** | S-FEEL → 全 FEEL（列表推导/context/date/duration），优先复用/借鉴 dsntk-rs |
| B12 | **决策图（JDM）编排** | `DecisionBody::Graph` 变体 + 拓扑求值 + 子决策递归（R2） |
| B13 | **DMN XML 导入导出** | 与 Camunda/Drools 工具链互通（R2） |

### 1.3 🟡 P2 —— 治理/契约（可后置）

| # | 能力 | 说明 |
|---|---|---|
| B14 | `GET /events` SSE 决策事件流 | 前端增量刷新替轮询 |
| B15 | `POST /decisions/{key}/evaluate/batch` | 批量高吞吐 |
| B16 | Swagger UI `/docs` | 目前仅 openapi.json |
| B17 | 决策日志 TTL / 归档 | 高频求值日志无限增长治理 |

---

## 2. 前端缺口 + native-pages 架构

### 2.1 定位：一芯双壳，页面归本仓，门户 F3 反代（参照 flow/report）

**关键事实**（经门户源码核实）：native page 是 **API-backed**（非静态文件）——门户前端外壳只发 `GET /api/native-pages/:id`，页面**源码 + 投递在后端**。两处壳：

```
┌─ 前端外壳 CMXPortalManager ─┐   只发 GET /api/native-pages/:id，零感知页面来自哪
│  四区工作台 + native_pages   │   （运行时已注册，新增页不碰前端）
│  运行时（fetch/缓存/挂载）    │
└──────────────┬───────────────┘
               │ /api/native-pages/portal.rules.*
        ┌──────┴──────────────────────────────┐
        │ 门户「一芯」cmx-container             │  F3 反代：id 归属 is_rules_owned_page
        │  is_rules_owned_page? → 反代          │  → 转发 rules-server；否则落门户自持
        └──────┬──────────────────────────────┘
               │ {rules_base}/api/native-pages/...
        ┌──────┴──────────────────────────────┐
        │ 微服务壳 cmx-rulesengine             │  web/ui-native/rule/*.js 自投递
        │  native_pages.rs（字节对齐门户信封）  │  rev=xxhash64，端口 8094
        └──────────────────────────────────────┘
```

**页面存放位置 = `cmx-rulesengine/web/ui-native/rule/`**（**遵你的指示：参照 flow/report**——两者都把页放各自 `web/ui-native/` 自投递）。门户 `[center_client.urls].rules` 配了地址 → F3 反代到 rules-server；没配 → 回退门户自持（Option A 快速兜底）。

### 2.2 页面清单：四页两层（设计 / 应用双工作台，镜像 rpt）

报表的"设计/应用双工作台"是最贴切的参照：**两个列表工作台进菜单（入口）+ 两个真正干活的页不进菜单（`openWorkNode` 动态开成 Tab、`instances` Map 按 `instanceKey` 隔离多实例）**。

```
定义态（写决策表/命中策略/表达式）          应用态（按 version+facts 求值/仿真/审计）
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ 决策集设计工作台               │  进菜单   │ 决策应用工作台                 │  进菜单
│ portal.rules.design-workbench │  (列表)   │ portal.rules.sim-workbench    │  (列表)
│ explorer 决策分类/kind         │          │ explorer 决策集 + 版本/场景     │
│ content  决策表列表            │          │ content  决策表列表            │
│ property 定义详情              │          │ property 应用说明              │
└──────────┬───────────────────┘          └──────────┬───────────────────┘
           │ 双击 openWorkNode                          │ 双击 openWorkNode（带 version+scenario）
           ▼                                            ▼
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ 决策表设计器                   │  多实例   │ 决策仿真台/应用器              │  多实例
│ portal.rules.designer         │  不进菜单 │ portal.rules.simulator        │  不进菜单
│ explorer 输入/输出字段+函数目录 │          │ content  输入 facts 表单        │
│ content  决策表网格（可编辑）   │          │         + 「求值」→ 命中行高亮   │
│ property 命中策略/列类型/单元格  │          │         + trace 逐节点归因      │
│         + gap/overlap 实时报告  │          │ property 决策状态/统计          │
│ key=defKey@@version            │          │ key=defKey@@version@@scenario  │
└──────────────────────────────┘          └──────────────────────────────┘
     写定义（POST draft / publish）              按上下文求值（POST evaluate）+ 可解释
```

**可选第 5 页** `portal.rules.logs`（决策日志/审计中心，进菜单）：决策日志列表 + trace 下钻——把"失败归因/可解释性"做成独立审计视图（金融合规刚需）。

### 2.3 native 页模块契约（骨架，所有页同构）

每个页 JS = 一个**模块级单例**，`export default { defaultView, views:{explorer,content,property} }`：

```js
// ── 可被壳覆盖的接缝 ──
const CFG = { apiBase:'', fetchInit:{credentials:'same-origin'}, authHeaders:()=>({}),
              onOpenTask:null, onClose:null }
function configure(o){ Object.assign(CFG, o||{}); return CFG }

// ── 信封解包 fetch（{code,msg,data}，code!==0 抛，成功返 data）──
async function apiJson(url, options={}){ /* 见 flow design-workbench.js:91 */ }

// ── 四区分派 + 整区重渲染 + 事件委托 ──
function mount(ctx, view){ /* host=ctx.host; requestAnimationFrame(render); 返回首屏 HTML */ }
function viewHtml(view){ if(view==='explorer')return explorerHtml(); if(view==='property')return propertyHtml(); return contentHtml() }

export { configure, mount }
export default { defaultView:'content', views:{
  async explorer(ctx){ return mount(ctx,'explorer') },
  async content (ctx){ return mount(ctx,'content') },
  async property(ctx){ return mount(ctx,'property') },
}}
```

- **URL 一律写 `/api/rules/v1/...`**（门户壳 `apiBase=''` 同源；可嵌壳指远程）。
- **多实例页**（designer/simulator）：`const instances = new Map()` + `instanceKey(props)`（`defKey@@version` / `defKey@@version@@scenario`），`props` 来自菜单 view 的 `props` 字段（`ctx.props`）。
- **跨区通信**：`host.workspace.context.set/get/on('change')`（门户 `ContextHost` 总线）。
- **列表页开工作页**：`openWorkNode(menu, sourceEl)` 5 级兜底链（`CFG.onOpenTask` → `openTab` → `portal-help-action` inlineNode → `POST /api/workspace-nodes` → `postMessage`）。

### 2.4 可复用组件清单（`packages/cmx-data-comp`，取类走 `globalThis.__cmxDataComp`）

| 用途 | 组件 | 规则引擎用在哪 |
|---|---|---|
| **决策表网格** ⭐ | `<cmx-revo-grid>` + `CmxColumnModel` | 设计器 content：结构化输入列/输出列/规则行（**首选**，比 SpreadJS 更贴决策表语义） |
| **单元格表达式编辑** ⭐ | `<cmx-fx-editor>` | 决策表格内编 FEEL/S-FEEL unary test（`configure({fetchFunctions})` 注入 `GET /feel/functions`，零域概念，完美承载） |
| Excel 感网格（备选） | `<cmx-spreadjs-sheet>` | 若要公式栏/Excel 体验；R2 决策图另议 |
| 树形表格 | `<cmx-tabulator>` | 决策集/决策图层级、trace 树 |
| facts 输入表单 | `<cmx-ui5-form>` | 仿真台输入事实 |
| 版本/场景选择器 | `<cmx-combo-box>` | 仿真台选版本/场景 |
| 命中徽标 | `<cmx-status-tag>` | 仿真台命中/未命中/失败 |
| 统计卡 | `<cmx-kpi-card>` | 仿真台求值统计、覆盖率 |
| 属性详情 | `<cmx-desc-list>` | trace 逐节点归因、定义详情 |
| 对话框 | `<cmx-floating-dialog>` / `cmxConfirm` | 发布确认、版本管理弹窗 |
| 布局/命令栏 | `<cmx-toolbar>`/`<cmx-filter-bar>`/`<cmx-split-pane>`/`<cmx-view-tabs>`/`<cmx-pager>` | 各页骨架 |

### 2.5 两个必踩陷阱（决策表编辑器）

1. **Shadow DOM 懒加载陷阱**：`cmx-data-comp` 的 MutationObserver 用 `document.querySelector` 探组件标签，**穿不透 native 页 shadowRoot** → 网格永不注册、空白。**解法**：网格标签挂载后主动调 `globalThis.__cmxDataComp.preloadSheetComponents()` 再 `customElements.whenDefined(...).then(applyModel)`（见 rpt `designer.js:4439`）。
2. **画布/网格保护**：content 区含网格实例时**绝不** `refreshView('content')`（会销毁网格），只就地换工具栏/对话框 DOM（见 flow `design-workbench.js:150`）。

---

## 3. 门户接入管道（cmx-container，照抄 rpt proxy）

「三处注册」——缺一页加载不出来：

### 3.1 微服务自投递（cmx-rulesengine，B9）

- 新建 `cmx-rulesengine/crates/cmx-rule-app/src/native_pages.rs`（照抄 `cmx-report/crates/cmx-rpt-app/src/native_pages.rs` 或 flow `frontend_pages.rs`）：读 `[assets].ui_native_dir`（默认 `web/ui-native`；env 覆盖 `ASSETS__UI_NATIVE_DIR`）的 `index.json` + 源文件，`/native-pages`、`/native-pages/{id}`、`/native-pages/batch`，信封用本仓 `crate::resp::{ApiResp,RuleError}`，rev=xxhash64。
- `cmx-rule-app/src/lib.rs` 加 `pub mod native_pages;`。
- `cmx-rule-server/src/main.rs` 的 `api_router` 上 `.merge(cmx_rule_app::native_pages::frontend_pages_routes::<()>())`（免认证，与 swagger 同层）。

### 3.2 门户 F3 反代（cmx-container，目前缺，需新建）

| # | 改动 | 照抄 |
|---|---|---|
| P1 | 新建反代 crate `cmx-container/crates/libs/cmx-rule/cmx-rule-api/src/proxy.rs`：`RulesProxyModule` + `is_rules_owned_page(id)=id.starts_with("portal.rules.")` + `with_rules_page_proxy(...)` | `cmx-rpt-api/src/proxy.rs` |
| P2 | `CenterUrlsConfig`（`cmx-plugin/src/center_client/config.rs`）增 `pub rules: Option<String>` | 已有 flow/report 字段 |
| P3 | `cmx-platform-app/src/routes.rs` 增 `rules_remote_base()` + `merge_rules()`，`routes()` 链上 `merge_rules(...)`；`service_topology()` 加一条 | `merge_report` |
| P4 | 门户 `dev.toml` `[center_client.urls]` 加 `rules = "http://localhost:8094"` + `[service_auth].outgoing_api_key` | flow/report 配置 |

> 反代出站三层头：`X-API-Key` + `X-Delegated-User-Token: Bearer <JWT>` + `X-Request-Id`（与 flow S6 认证桥对齐——rules 的 `auth.rs` R3 补委托令牌解析）。

### 3.3 菜单落库（cmx_menu 迁移）

- 授权源（规范副本）：`cmx-rulesengine/web/menu-source/<domain>/<app>/<module>/rule-menu.json` + `web/menu-manifest.json`（照抄 report）。
- **真正生效 = SQL 迁移**：`cmx-container/docs/sql/migrations/<date>_rules_menu.up.sql`，`INSERT INTO cmx_menu(...)`（模板 = flow `20260720_001_cmx_flow_engine.up.sql:414`），`definition` JSONB 内嵌 workspace-node：

```json
{"type":"workspace-node","caption":"决策规则设计",
 "workspace":{"id":"rule_design_workbench",
   "explorer":{"caption":"规则库","views":[{"type":"native_pages","native_page":"portal.rules.design-workbench","view":"explorer"}]},
   "content":{"caption":"决策集","views":[{"type":"native_pages","native_page":"portal.rules.design-workbench","view":"content"}]},
   "property":{"caption":"定义详情","views":[{"type":"native_pages","native_page":"portal.rules.design-workbench","view":"property"}]}}}
```

两个列表工作台（design-workbench / sim-workbench，+ 可选 logs）各一行 `cmx_menu`；两个多实例页（designer / simulator）**不进菜单**，由列表页 `openWorkNode` 动态开。

---

## 4. 分阶段落地路线（F1→F5）

| 阶段 | 交付 | 依赖 | 验收 |
|---|---|---|---|
| **F1 · 后端补端点** | B1–B3 发布/版本 + B5 simulate + B6/B7 tests + B8 feel/functions（B4 analyze 随 R1 gap/overlap 算法） | R0 | curl 发布→版本列表→激活；tests 批跑；feel/functions 返目录 |
| **F2 · native-pages 管道** | B9 自投递（`native_pages.rs` + 挂载 + `web/ui-native/index.json`）+ §3.2 门户反代（P1–P4）+ §3.3 菜单迁移 | F1 | 门户点菜单 → `GET /api/native-pages/portal.rules.*` 命中反代 → 空壳页渲染 |
| **F3 · 决策表设计器** | `portal.rules.design-workbench`（列表）+ `portal.rules.designer`（多实例）：决策表网格（`cmx-revo-grid`）+ 单元格 `cmx-fx-editor` + 命中策略/列类型 property + gap/overlap 实时报告 + 发布/版本 | F2 + B1–B4 | 真机：建表→编规则→gap/overlap 高亮→发布→版本切换 |
| **F4 · 决策仿真/应用台** | `portal.rules.sim-workbench`（列表）+ `portal.rules.simulator`（多实例）：facts 表单 → 求值 → 命中行高亮 + trace 逐节点归因（失败节点红标）+ 测试用例批跑 + 覆盖率 | F2 + B5–B7 | 真机：输入 facts→求值→trace 可视化→失败归因红标→测试批跑 |
| **F5 · 审计中心 + 可嵌壳（可选）** | `portal.rules.logs`（决策日志/可解释性审计）+ `web/elements/` Web Component 壳（对标 flow，第三方可嵌） | F3/F4 | 日志下钻；custom element 独立演示 |

**关键顺序**：F1（后端端点）→ F2（管道打通，空壳能加载）→ F3/F4（两套工作台，可并行）→ F5（可选）。F1/F2 是**低风险照搬**（端点小、管道有 flow/report 逐行先例）；F3/F4 是**真正的前端工作量**（决策表网格交互 + trace 可视化）。

---

## 5. 工作量与风险矩阵

| 模块 | 工作量 | 风险 | 缓解 |
|---|---|---|---|
| F1 发布/版本/simulate/tests/feel-functions | 小 | 低 | 表已建，端点是 CRUD + 已有 evaluate 变体 |
| B4/B10 gap/overlap 算法 | 中 | 中 | 区间/枚举覆盖是可判定问题，参照 OpenL `validateDT` |
| F2 自投递 `native_pages.rs` | 小 | 低 | 逐字节照抄 flow `frontend_pages.rs` |
| F2 门户反代管道（P1–P4） | 中 | 低 | 照抄 `cmx-rpt-api/proxy.rs` + `routes.rs merge_report`；**跨 cmx-container 改动需一并编译验证** |
| F2 菜单迁移 | 小 | 中 | 模板= flow 迁移；`cmx_menu` 列多，`definition` JSONB 要对齐 |
| F3 决策表设计器 | **大** | 中 | 决策表网格 `cmx-revo-grid` + `cmx-fx-editor`；**必踩 Shadow DOM 懒加载 + 网格保护两坑** |
| F4 仿真台 + trace 可视化 | 中 | 低 | facts 表单 + evaluate 已有；trace 结构已含 failure，可视化直接映射 |
| 命名规范 | 小 | 中 | native_page id `portal.rules.*`、菜单 DAM 三元组（domain/app/module）需与团队规范对齐，`is_rules_owned_page` 前缀须一致 |

---

## 6. 诚实结论

- **后端不是瓶颈**：R0 内核扎实，F1 缺的端点都是"表已建、逻辑已有"的补齐（发布/版本/simulate/tests 是 CRUD + evaluate 变体），**唯一有内核含量的是 gap/overlap 算法**（B4/B10，也正是超越 ZEN 的世界级点）。
- **前端是主战场**：规则引擎的产品价值一半在"**业务人员可视化维护决策表**"——决策表设计器（`cmx-revo-grid` + `cmx-fx-editor`）是核心；另一半在"**可解释的决策**"——仿真台把 R0 已产出的 trace + 失败归因**可视化**，这是相对 ZEN 的差异化。
- **接入零新基建**：门户 native-pages / F3 反代 / 菜单机制**已完备**，flow/report 走通两遍，rules 是"第三个壳"——照抄即可，无需门户前端改动（`native_pages` 视图类型已全局注册）。
- **战略取舍**：F3/F4 决策表设计器 + 仿真台是"**坐实赛道**"的必做项；决策图（JDM）设计器（画布）留 R2/F5+ 择机——R0/R1 的决策表（网格）已覆盖企业绝大多数无状态决策场景。

一句话：**后端补一圈小端点 + 一个 gap/overlap 算法，前端照 rpt 双工作台骨架搭决策表设计器与仿真台，门户照 rpt 管道接一遍——规则引擎就从"能算"变成"能用、能维护、能解释"的完整产品。**

---

*cmx-rulesengine 缺口分析 + 前端 native-pages 方案 · v1 · 2026-08-15*
*前端归本仓 web/ui-native（参照 flow/report 一芯双壳）· 四页两层（设计器 + 仿真台）· 门户 F3 反代 · F1→F5 路线*
