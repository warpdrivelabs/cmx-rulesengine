//! 全部 axum handler（对任意 state 泛型 S 成立——不绑 State 提取器）。
//!
//! R0 端点：决策定义 CRUD + 发布、核心 evaluate（含 trace + 决策日志落库）、决策日志下钻、
//! FEEL 试算/校验。求值流程：装载定义 → [`cmx_rule_engine::evaluate`] → 落决策日志 → 回
//! 输出+trace+logId（logId 供 /logs/{id} 可解释性下钻）。

use crate::engine::store;
use crate::resp::{ApiResp, Result, RuleError};
use crate::tenant::{current_tenant, current_user};
use axum::extract::Path;
use axum::Json;
use chrono::Utc;
use cmx_rule_model::{DecisionBody, DecisionDef, DecisionLog, DecisionStore, EvalContext, RuleCategory, TestCase};
use serde::Deserialize;
use serde_json::{json, Value};

// ————————————————————————— 定义 —————————————————————————

/// GET /definitions —— 决策定义列表。
pub async fn list_definitions() -> Result<Json<ApiResp<Value>>> {
    let tenant = current_tenant();
    let metas = store()
        .list_definitions(&tenant)
        .await
        .map_err(|e| RuleError::internal(format!("列出定义失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!(metas))))
}

/// GET /definitions/{key} —— 决策定义详情（激活发布版或草稿）。
pub async fn get_definition(Path(key): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let tenant = current_tenant();
    let def = store()
        .load_definition(&tenant, &key)
        .await
        .map_err(|e| RuleError::internal(format!("装载定义失败: {e}")))?
        .ok_or_else(|| RuleError::not_found(format!("决策 {key} 不存在")))?;
    Ok(Json(ApiResp::ok(json!(def))))
}

/// POST /definitions/draft —— 存草稿（结构校验后 upsert）。
pub async fn save_draft(Json(def): Json<DecisionDef>) -> Result<Json<ApiResp<Value>>> {
    def.validate()
        .map_err(|e| RuleError::business(format!("决策定义非法: {e}")))?;
    check_scripts(&def).map_err(RuleError::business)?;
    let tenant = current_tenant();
    store()
        .save_definition(&tenant, &def)
        .await
        .map_err(|e| RuleError::internal(format!("保存草稿失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "key": def.key, "saved": true }))))
}

// ————————————————————————— 分类字典（受管） —————————————————————————

/// GET /categories —— 受管分类字典（按 ord 升序）。
pub async fn list_categories() -> Result<Json<ApiResp<Value>>> {
    let tenant = current_tenant();
    let cats = store()
        .list_categories(&tenant)
        .await
        .map_err(|e| RuleError::internal(format!("列出分类失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!(cats))))
}

/// POST /categories —— upsert 一个分类（按 code）。
pub async fn save_category(Json(cat): Json<RuleCategory>) -> Result<Json<ApiResp<Value>>> {
    if cat.code.trim().is_empty() {
        return Err(RuleError::business("分类 code 不能为空".to_string()));
    }
    let tenant = current_tenant();
    store()
        .save_category(&tenant, &cat)
        .await
        .map_err(|e| RuleError::internal(format!("保存分类失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "code": cat.code, "saved": true }))))
}

/// DELETE /categories/{code} —— 删除分类（引用它的决策集自动归「未分类」）。
pub async fn delete_category(Path(code): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let tenant = current_tenant();
    store()
        .delete_category(&tenant, &code)
        .await
        .map_err(|e| RuleError::internal(format!("删除分类失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "code": code, "deleted": true }))))
}

/// POST /definitions/validate —— 结构 + 单元格 + 脚本语法校验（不落库）。
pub async fn validate_definition(Json(def): Json<DecisionDef>) -> Result<Json<ApiResp<Value>>> {
    if let Err(e) = def.validate() {
        return Ok(Json(ApiResp::ok(
            json!({ "valid": false, "error": e.to_string() }),
        )));
    }
    if let Err(e) = check_scripts(&def) {
        return Ok(Json(ApiResp::ok(json!({ "valid": false, "error": e }))));
    }
    Ok(Json(ApiResp::ok(json!({ "valid": true }))))
}

/// 编译校验定义内的全部脚本（SC0–SC4）——落库/校验前暴露语法错（带行号），不执行。
/// 覆盖三载体：脚本决策（kind:script）、决策图 script 节点、决策表 `=rhai:` 输出格。
fn check_scripts(def: &DecisionDef) -> std::result::Result<(), String> {
    match &def.body {
        DecisionBody::Script(s) => cmx_rule_feel::check_script(&s.script)
            .map_err(|e| format!("脚本决策语法错误: {e}")),
        DecisionBody::Graph(g) => {
            for n in &g.nodes {
                if n.node_type == "script"
                    && let Some(src) = &n.script
                {
                    cmx_rule_feel::check_script(src)
                        .map_err(|e| format!("脚本节点 {}: {e}", n.id))?;
                }
                if let Some(t) = &n.table {
                    check_table_scripts(t).map_err(|e| format!("[{}] {e}", n.id))?;
                }
            }
            Ok(())
        }
        DecisionBody::DecisionTable(t) => check_table_scripts(t),
    }
}

/// 校验决策表输出格里的 `=rhai:` 脚本单元格（SC2）。
fn check_table_scripts(t: &cmx_rule_model::DecisionTable) -> std::result::Result<(), String> {
    for (ri, rule) in t.rules.iter().enumerate() {
        for cell in &rule.output_entries {
            if let Some(src) = cell.trim_start().strip_prefix(cmx_rule_feel::RHAI_PREFIX) {
                cmx_rule_feel::check_script(src)
                    .map_err(|e| format!("规则行 {ri} 脚本输出格: {e}"))?;
            }
        }
    }
    Ok(())
}

// ————————————————————————— 求值（核心） —————————————————————————

/// evaluate 请求体。
#[derive(Deserialize)]
pub struct EvaluateReq {
    /// 输入事实。
    pub input: Value,
    /// 可选：内联决策定义（试算，不落库、不需已保存）。给定则优先于按 key 装载。
    #[serde(default)]
    pub definition: Option<DecisionDef>,
    #[serde(default)]
    pub options: EvaluateOpts,
}

#[derive(Deserialize)]
#[serde(default)]
pub struct EvaluateOpts {
    /// 是否返回 trace（默认 true）。
    pub trace: bool,
    /// 是否落决策日志（默认 true；试算/仿真可传 false）。
    pub log: bool,
}

// 手写 Default：options 整体缺省时 log/trace 也为 true（derive Default 会给 false，与字段语义相悖）。
impl Default for EvaluateOpts {
    fn default() -> Self {
        Self { trace: true, log: true }
    }
}

/// POST /decisions/{key}/evaluate —— 按 key 装载定义并求值。
pub async fn evaluate_by_key(
    Path(key): Path<String>,
    Json(req): Json<EvaluateReq>,
) -> Result<Json<ApiResp<Value>>> {
    let tenant = current_tenant();
    let def = store()
        .load_definition(&tenant, &key)
        .await
        .map_err(|e| RuleError::internal(format!("装载定义失败: {e}")))?
        .ok_or_else(|| RuleError::not_found(format!("决策 {key} 不存在")))?;
    run_and_respond(&tenant, def, req).await
}

/// POST /evaluate —— 内联决策定义求值（试算，不落库）。
pub async fn evaluate_inline(Json(req): Json<EvaluateReq>) -> Result<Json<ApiResp<Value>>> {
    let tenant = current_tenant();
    let def = req
        .definition
        .clone()
        .ok_or_else(|| RuleError::business("内联求值需提供 definition"))?;
    def.validate()
        .map_err(|e| RuleError::business(format!("决策定义非法: {e}")))?;
    // 内联求值默认不落库。
    let mut req = req;
    req.options.log = false;
    run_and_respond(&tenant, def, req).await
}

/// 求值 + 落日志 + 组装响应（evaluate_by_key / evaluate_inline 共用）。
async fn run_and_respond(
    tenant: &str,
    def: DecisionDef,
    req: EvaluateReq,
) -> Result<Json<ApiResp<Value>>> {
    let started = Utc::now();
    let ctx = EvalContext::new(req.input.clone());
    // 决策图含子决策时预加载解析器（BFS）；决策表则空解析器。
    let resolver = build_resolver(tenant, &def).await;
    // SC3：预取租户已发布脚本函数，注入本次求值（同步 evaluate 全程 thread_local 稳定，用后自动恢复）。
    let funcs = load_script_functions(tenant).await;
    let result = cmx_rule_feel::with_functions(funcs, || {
        cmx_rule_engine::evaluate_with(&def, &ctx, &resolver, 0)
    });
    let elapsed_us = (Utc::now() - started).num_microseconds().unwrap_or(0).max(0) as u64;

    // 失败归因（若有任一节点失败）。
    let failure = result
        .trace
        .iter()
        .find_map(|t| t.failure.clone());

    let log_id = uuid_v4();
    if req.options.log {
        let log = DecisionLog {
            id: log_id.clone(),
            decision_key: def.key.clone(),
            decision_version: def.version,
            input: req.input.clone(),
            output: result.output.clone(),
            trace: json!(result.trace),
            timing_us: elapsed_us,
            caller: current_user(),
            failure: failure.clone(),
            created_at: started,
        };
        if let Err(e) = store().append_log(tenant, &log).await {
            tracing::warn!(error = %e, "决策日志落库失败（不阻断求值返回）");
        }
    }

    let mut data = json!({
        "output": result.output,
        "logId": log_id,
        "timingUs": elapsed_us,
    });
    if req.options.trace {
        data["trace"] = json!(result.trace);
    }
    if let Some(f) = failure {
        data["failure"] = json!(f);
    }
    Ok(Json(ApiResp::ok(data)))
}

// ————————————————————————— FEEL 试算 —————————————————————————

#[derive(Deserialize)]
pub struct FeelEvalReq {
    /// unary test 单元格文本（如 "> 700" / "[18..65)" / "contains(?, \"vip\")"）。
    pub test: String,
    /// 被测输入值。
    pub value: Value,
    /// 可选：输入事实上下文（供操作数/裸布尔单测引用其它变量，如 "> avgScore"）。
    #[serde(default)]
    pub context: Option<Value>,
}

/// POST /feel/eval —— unary test 试算。
pub async fn feel_eval(Json(req): Json<FeelEvalReq>) -> Result<Json<ApiResp<Value>>> {
    let ctx = req.context.unwrap_or_else(|| json!({}));
    let r = cmx_rule_feel::eval_unary_test(&req.test, &req.value, &ctx)
        .map_err(|e| RuleError::business(format!("表达式错误: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "result": r }))))
}

#[derive(Deserialize)]
pub struct FeelExprReq {
    /// 完整 FEEL 表达式（如 "income * 5" / "if score > 700 then \"A\" else \"B\"" / "sum([1,2,3])"）。
    pub expression: String,
    /// 输入事实上下文（表达式里的变量）。
    #[serde(default)]
    pub context: Option<Value>,
}

/// POST /feel/expression —— 完整 FEEL 表达式求值（R1）。
pub async fn feel_expression(Json(req): Json<FeelExprReq>) -> Result<Json<ApiResp<Value>>> {
    let ctx = req.context.unwrap_or_else(|| json!({}));
    let v = cmx_rule_feel::eval_expression(&req.expression, &ctx)
        .map_err(|e| RuleError::business(format!("表达式错误: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "result": v }))))
}

#[derive(Deserialize)]
pub struct FeelValidateReq {
    pub test: String,
}

/// POST /feel/validate —— unary test 语法校验。
pub async fn feel_validate(Json(req): Json<FeelValidateReq>) -> Result<Json<ApiResp<Value>>> {
    match cmx_rule_feel::validate_unary_test(&req.test) {
        Ok(()) => Ok(Json(ApiResp::ok(json!({ "valid": true })))),
        Err(e) => Ok(Json(ApiResp::ok(
            json!({ "valid": false, "error": e.to_string() }),
        ))),
    }
}

// 生成 UUID v4（避开在 model 层引 uuid，集中在 app 层）。
fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 为决策图预加载子决策解析器（BFS 沿 decision 节点递归装载被引用决策；决策表返回空解析器）。
async fn build_resolver(tenant: &str, def: &DecisionDef) -> cmx_rule_engine::MapResolver {
    use std::collections::{HashMap, HashSet, VecDeque};
    let mut map: HashMap<String, DecisionDef> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = keys_of(def).into_iter().collect();
    let mut guard = 0usize;
    while let Some(key) = queue.pop_front() {
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key.clone());
        guard += 1;
        if guard > 128 {
            break; // 防引用炸裂
        }
        if let Ok(Some(sub)) = store().load_definition(tenant, &key).await {
            for k in keys_of(&sub) {
                if !seen.contains(&k) {
                    queue.push_back(k);
                }
            }
            map.insert(key, sub);
        }
    }
    cmx_rule_engine::MapResolver(map)
}

/// 定义引用的子决策 key（仅决策图的 decision 节点）。
fn keys_of(def: &DecisionDef) -> Vec<String> {
    match &def.body {
        DecisionBody::Graph(g) => cmx_rule_engine::collect_decision_keys(g),
        // 决策表 / 脚本决策不引用子决策。
        DecisionBody::DecisionTable(_) | DecisionBody::Script(_) => Vec::new(),
    }
}

// ————————————————————————— 脚本函数库（SC3） —————————————————————————

/// 预取租户已发布脚本函数，映射为 feel 层的 [`cmx_rule_feel::ScriptFn`]（求值前注入）。
/// 失败降级为空库（不阻断求值——函数缺失时脚本会以"未定义函数"归因，可诊断）。
async fn load_script_functions(tenant: &str) -> Vec<cmx_rule_feel::ScriptFn> {
    match store().list_published_functions().await {
        Ok(list) => list
            .into_iter()
            .map(|f| cmx_rule_feel::ScriptFn::from_parts(&f.name, &f.params, &f.body))
            .collect(),
        Err(e) => {
            tracing::warn!(tenant, error = %e, "预取脚本函数失败，本次求值不注入函数库");
            Vec::new()
        }
    }
}

/// GET /functions —— 脚本函数列表。
pub async fn list_functions() -> Result<Json<ApiResp<Value>>> {
    let list = store()
        .list_functions()
        .await
        .map_err(|e| RuleError::internal(format!("列出脚本函数失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!(list))))
}

/// GET /functions/{name} —— 函数详情。
pub async fn get_function(Path(name): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let f = store()
        .get_function(&name)
        .await
        .map_err(|e| RuleError::internal(format!("装载脚本函数失败: {e}")))?
        .ok_or_else(|| RuleError::not_found(format!("脚本函数 {name} 不存在")))?;
    Ok(Json(ApiResp::ok(json!(f))))
}

/// POST /functions/draft —— 存草稿（含 Rhai 编译校验）。
pub async fn save_function(Json(f): Json<cmx_rule_model::ScriptFunction>) -> Result<Json<ApiResp<Value>>> {
    if f.name.trim().is_empty() {
        return Err(RuleError::business("脚本函数名不可为空"));
    }
    // 编译校验（把函数体包装成 fn 声明后 compile，暴露语法错带行号）。
    let sf = cmx_rule_feel::ScriptFn::from_parts(&f.name, &f.params, &f.body);
    cmx_rule_feel::check_script(&sf.source)
        .map_err(|e| RuleError::business(format!("脚本函数语法错误: {e}")))?;
    store()
        .save_function(&f)
        .await
        .map_err(|e| RuleError::internal(format!("保存脚本函数失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "name": f.name, "saved": true }))))
}

/// POST /functions/{name}/publish —— 发布（求值只注册已发布函数）。
pub async fn publish_function(Path(name): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let version = store()
        .publish_function(&name)
        .await
        .map_err(|e| RuleError::business(format!("发布脚本函数失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "name": name, "version": version, "published": true }))))
}

/// DELETE /functions/{name} —— 删除。
pub async fn delete_function(Path(name): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let n = store()
        .delete_function(&name)
        .await
        .map_err(|e| RuleError::internal(format!("删除脚本函数失败: {e}")))?;
    if n == 0 {
        return Err(RuleError::not_found(format!("脚本函数 {name} 不存在")));
    }
    Ok(Json(ApiResp::ok(json!({ "name": name, "deleted": true }))))
}

/// POST /script/eval —— 脚本试算（沙箱执行，供设计器调试；对标 /feel/expression）。
pub async fn script_eval(Json(req): Json<ScriptEvalReq>) -> Result<Json<ApiResp<Value>>> {
    let ctx = req.context.unwrap_or_else(|| json!({}));
    let tenant = current_tenant();
    let funcs = load_script_functions(&tenant).await;
    let out = cmx_rule_feel::with_functions(funcs, || cmx_rule_feel::eval_script(&req.script, &ctx))
        .map_err(|e| RuleError::business(format!("脚本错误: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "result": out }))))
}

/// script/eval 请求体。
#[derive(Deserialize)]
pub struct ScriptEvalReq {
    /// Rhai 脚本源。
    pub script: String,
    /// 可选：输入上下文（脚本变量）。
    #[serde(default)]
    pub context: Option<Value>,
}

// ————————————————————————— 发布 / 版本（F1） —————————————————————————

/// POST /definitions/{key}/publish —— 发布当前草稿 → 不可变 release + version+1。
pub async fn publish_definition(Path(key): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let version = store()
        .publish(&key, current_user())
        .await
        .map_err(|e| RuleError::business(format!("发布失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "key": key, "version": version, "published": true }))))
}

/// DELETE /definitions/{key} —— 彻底删除决策集（连带清理发布/日志/用例四表）。
pub async fn delete_definition(Path(key): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let deleted = store()
        .delete_definition(&key)
        .await
        .map_err(|e| RuleError::internal(format!("删除失败: {e}")))?;
    if deleted == 0 {
        return Err(RuleError::not_found(format!("决策 {key} 不存在")));
    }
    Ok(Json(ApiResp::ok(json!({ "key": key, "deleted": true }))))
}

/// GET /definitions/{key}/versions —— 发布版本列表。
pub async fn list_versions(Path(key): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let versions = store()
        .list_versions(&key)
        .await
        .map_err(|e| RuleError::internal(format!("查询版本失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!(versions))))
}
/// POST /definitions/{key}/versions/{v}/activate —— 激活某版本。
pub async fn activate_version(
    Path((key, version)): Path<(String, u32)>,
) -> Result<Json<ApiResp<Value>>> {
    store()
        .activate_version(&key, version)
        .await
        .map_err(|e| RuleError::business(format!("激活失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "key": key, "version": version, "active": true }))))
}

// ————————————————————————— 仿真（求值不落库） —————————————————————————

/// POST /decisions/{key}/simulate —— 按 key 求值但**不落审计日志**（设计期试算）。
pub async fn simulate_by_key(
    Path(key): Path<String>,
    Json(mut req): Json<EvaluateReq>,
) -> Result<Json<ApiResp<Value>>> {
    let tenant = current_tenant();
    let def = store()
        .load_definition(&tenant, &key)
        .await
        .map_err(|e| RuleError::internal(format!("装载定义失败: {e}")))?
        .ok_or_else(|| RuleError::not_found(format!("决策 {key} 不存在")))?;
    req.options.log = false;
    req.options.trace = true;
    run_and_respond(&tenant, def, req).await
}

// ————————————————————————— 完整性分析（gap/overlap，超越 ZEN） —————————————————————————

#[derive(Deserialize, Default)]
pub struct AnalyzeReq {
    /// 可选内联定义（设计器分析未保存的在编表）；缺则按 key 装载。
    #[serde(default)]
    pub definition: Option<DecisionDef>,
}

/// POST /decisions/{key}/analyze —— gap/overlap 完整性分析报告。
pub async fn analyze_decision(
    Path(key): Path<String>,
    Json(req): Json<AnalyzeReq>,
) -> Result<Json<ApiResp<Value>>> {
    let def = match req.definition {
        Some(d) => d,
        None => {
            let tenant = current_tenant();
            store()
                .load_definition(&tenant, &key)
                .await
                .map_err(|e| RuleError::internal(format!("装载定义失败: {e}")))?
                .ok_or_else(|| RuleError::not_found(format!("决策 {key} 不存在")))?
        }
    };
    let report = cmx_rule_engine::analyze_def(&def);
    Ok(Json(ApiResp::ok(json!({
        "complete": report.is_complete(),
        "hasOverlap": report.has_overlap(),
        "gaps": report.gaps,
        "overlaps": report.overlaps,
    }))))
}

// ————————————————————————— 测试用例 —————————————————————————

/// GET /decisions/{key}/tests —— 测试用例列表。
pub async fn list_tests(Path(key): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let tests = store()
        .list_tests(&key)
        .await
        .map_err(|e| RuleError::internal(format!("查询测试用例失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!(tests))))
}

#[derive(Deserialize)]
pub struct SaveTestReq {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    pub input: Value,
    pub expected: Value,
}

/// POST /decisions/{key}/tests —— 保存（新增/更新）测试用例。
pub async fn save_test(
    Path(key): Path<String>,
    Json(req): Json<SaveTestReq>,
) -> Result<Json<ApiResp<Value>>> {
    let tc = TestCase {
        id: req.id.filter(|s| !s.is_empty()).unwrap_or_else(uuid_v4),
        decision_key: key,
        name: req.name,
        input: req.input,
        expected: req.expected,
        created_at: Utc::now(),
    };
    store()
        .save_test(&tc)
        .await
        .map_err(|e| RuleError::internal(format!("保存测试用例失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "id": tc.id, "saved": true }))))
}

/// DELETE /decisions/{key}/tests/{id} —— 删除测试用例。
pub async fn delete_test(Path((_key, id)): Path<(String, String)>) -> Result<Json<ApiResp<Value>>> {
    store()
        .delete_test(&id)
        .await
        .map_err(|e| RuleError::internal(format!("删除测试用例失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "id": id, "deleted": true }))))
}

/// POST /decisions/{key}/tests/run —— 跑测试套件：逐例求值 diff 期望 + 覆盖率 + 完整性。
pub async fn run_tests(Path(key): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let tenant = current_tenant();
    let def = store()
        .load_definition(&tenant, &key)
        .await
        .map_err(|e| RuleError::internal(format!("装载定义失败: {e}")))?
        .ok_or_else(|| RuleError::not_found(format!("决策 {key} 不存在")))?;
    let tests = store()
        .list_tests(&key)
        .await
        .map_err(|e| RuleError::internal(format!("查询测试用例失败: {e}")))?;

    let mut passed = 0usize;
    let mut cases = Vec::new();
    let resolver = build_resolver(&tenant, &def).await;
    for tc in &tests {
        let r = cmx_rule_engine::evaluate_with(
            &def,
            &EvalContext::new(tc.input.clone()),
            &resolver,
            0,
        );
        let pass = json_deep_eq(&r.output, &tc.expected);
        if pass {
            passed += 1;
        }
        cases.push(json!({
            "id": tc.id, "name": tc.name, "pass": pass,
            "actual": r.output, "expected": tc.expected,
            "failure": r.trace.iter().find_map(|t| t.failure.clone()),
        }));
    }
    let total = tests.len();
    let cov = cmx_rule_engine::analyze_def(&def);
    Ok(Json(ApiResp::ok(json!({
        "total": total,
        "passed": passed,
        "failed": total - passed,
        "cases": cases,
        "coverage": { "complete": cov.is_complete(), "gaps": cov.gaps.len(), "overlaps": cov.overlaps.len() },
    }))))
}

// ————————————————————————— FEEL 函数目录 —————————————————————————

/// GET /feel/functions —— unary test 算子/形式目录（前端函数向导用）。
pub async fn feel_functions() -> Result<Json<ApiResp<Value>>> {
    Ok(Json(ApiResp::ok(cmx_rule_feel::function_catalog())))
}

/// JSON 深度相等：数值按 f64 比较（消除 int/float 表示差异），对象/数组递归。
fn json_deep_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => a.as_f64() == b.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_deep_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter().all(|(k, pv)| y.get(k).is_some_and(|qv| json_deep_eq(pv, qv)))
        }
        _ => a == b,
    }
}
