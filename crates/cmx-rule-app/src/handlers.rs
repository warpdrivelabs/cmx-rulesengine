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
use cmx_rule_model::{DecisionDef, DecisionLog, DecisionStore, EvalContext};
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
    let tenant = current_tenant();
    store()
        .save_definition(&tenant, &def)
        .await
        .map_err(|e| RuleError::internal(format!("保存草稿失败: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "key": def.key, "saved": true }))))
}

/// POST /definitions/validate —— 结构 + 单元格语法校验（不落库）。
pub async fn validate_definition(Json(def): Json<DecisionDef>) -> Result<Json<ApiResp<Value>>> {
    if let Err(e) = def.validate() {
        return Ok(Json(ApiResp::ok(
            json!({ "valid": false, "error": e.to_string() }),
        )));
    }
    Ok(Json(ApiResp::ok(json!({ "valid": true }))))
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

#[derive(Deserialize, Default)]
pub struct EvaluateOpts {
    /// 是否返回 trace（默认 true）。
    #[serde(default = "default_true")]
    pub trace: bool,
    /// 是否落决策日志（默认 true；试算/仿真可传 false）。
    #[serde(default = "default_true")]
    pub log: bool,
}

fn default_true() -> bool {
    true
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
    let result = cmx_rule_engine::evaluate(&def, &ctx);
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
    /// unary test 单元格文本（如 "> 700" / "[18..65)"）。
    pub test: String,
    /// 被测输入值。
    pub value: Value,
}

/// POST /feel/eval —— unary test 试算。
pub async fn feel_eval(Json(req): Json<FeelEvalReq>) -> Result<Json<ApiResp<Value>>> {
    let r = cmx_rule_feel::eval_unary_test(&req.test, &req.value)
        .map_err(|e| RuleError::business(format!("表达式错误: {e}")))?;
    Ok(Json(ApiResp::ok(json!({ "result": r }))))
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
