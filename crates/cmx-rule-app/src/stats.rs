//! 决策日志查询（可解释性下钻）+ 大盘统计聚合。

use crate::engine::RULE_DB_ID;
use crate::resp::{ApiResp, Result, RuleError};
use axum::extract::Path;
use axum::Json;
use cmx_database_pg::{query_sql, query_sql_with_params, SqlParams};
use cmx_core::model::cell::DataValue;
use serde_json::{json, Value};

/// GET /decisions/{key}/logs —— 该决策的日志列表（最近 100 条）。
pub async fn list_logs(Path(key): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let ds = query_sql_with_params(
        RULE_DB_ID,
        None,
        "SELECT id, decision_key, decision_version, output, timing_us, caller, failure, created_at \
         FROM cmx_rule_decision_log WHERE decision_key = $1 ORDER BY created_at DESC LIMIT 100",
        SqlParams::DataValues(vec![DataValue::String(key)]),
        "rule_log_list",
    )
    .await
    .map_err(|e| RuleError::internal(format!("查询决策日志失败: {e}")))?;

    let schema = ds.schema.as_ref();
    let mut rows = Vec::new();
    for row in ds.iter() {
        let get_s = |c: &str| match row.get_by_name(schema, c) {
            Some(DataValue::String(s)) => Some(s.clone()),
            _ => None,
        };
        let get_json = |c: &str| match row.get_by_name(schema, c) {
            Some(DataValue::Json(s)) => serde_json::from_str::<Value>(s).ok(),
            _ => None,
        };
        let get_i = |c: &str| match row.get_by_name(schema, c) {
            Some(DataValue::Int(v)) => *v,
            _ => 0,
        };
        rows.push(json!({
            "id": get_s("id"),
            "decisionKey": get_s("decision_key"),
            "decisionVersion": get_i("decision_version"),
            "output": get_json("output"),
            "timingUs": get_i("timing_us"),
            "caller": get_s("caller"),
            "failure": get_s("failure"),
        }));
    }
    Ok(Json(ApiResp::ok(json!(rows))))
}

/// GET /logs/{id} —— 单次决策全量 trace（可解释性）。
pub async fn get_log(Path(id): Path<String>) -> Result<Json<ApiResp<Value>>> {
    let ds = query_sql_with_params(
        RULE_DB_ID,
        None,
        "SELECT id, decision_key, decision_version, input, output, trace, timing_us, caller, failure \
         FROM cmx_rule_decision_log WHERE id = $1",
        SqlParams::DataValues(vec![DataValue::String(id.clone())]),
        "rule_log_one",
    )
    .await
    .map_err(|e| RuleError::internal(format!("查询决策日志失败: {e}")))?;

    let Some(row) = ds.iter().next() else {
        return Err(RuleError::not_found(format!("决策日志 {id} 不存在")));
    };
    let schema = ds.schema.as_ref();
    let get_s = |c: &str| match row.get_by_name(schema, c) {
        Some(DataValue::String(s)) => Some(s.clone()),
        _ => None,
    };
    let get_json = |c: &str| match row.get_by_name(schema, c) {
        Some(DataValue::Json(s)) => serde_json::from_str::<Value>(s).ok(),
        _ => None,
    };
    let get_i = |c: &str| match row.get_by_name(schema, c) {
        Some(DataValue::Int(v)) => *v,
        _ => 0,
    };
    Ok(Json(ApiResp::ok(json!({
        "id": get_s("id"),
        "decisionKey": get_s("decision_key"),
        "decisionVersion": get_i("decision_version"),
        "input": get_json("input"),
        "output": get_json("output"),
        "trace": get_json("trace"),
        "timingUs": get_i("timing_us"),
        "caller": get_s("caller"),
        "failure": get_s("failure"),
    }))))
}

/// GET /stats —— 大盘聚合（决策集数 / 日志总数 / 失败数 / 热点决策）。降级：任一子查询失败取 0。
pub async fn stats() -> Result<Json<ApiResp<Value>>> {
    let count = |sql: &'static str| async move {
        query_sql(RULE_DB_ID, None, sql, "rule_stat")
            .await
            .ok()
            .and_then(|ds| {
                let schema = ds.schema.as_ref();
                ds.iter().next().and_then(|row| {
                    schema.fields.first().and_then(|f| {
                        match row.get_by_name(schema, &f.name) {
                            Some(DataValue::Int(v)) => Some(*v),
                            _ => None,
                        }
                    })
                })
            })
            .unwrap_or(0)
    };

    let definitions = count("SELECT COUNT(*) FROM cmx_rule_definition").await;
    let published = count("SELECT COUNT(*) FROM cmx_rule_definition WHERE published = TRUE").await;
    let evaluations = count("SELECT COUNT(*) FROM cmx_rule_decision_log").await;
    let failures = count("SELECT COUNT(*) FROM cmx_rule_decision_log WHERE failure IS NOT NULL").await;

    Ok(Json(ApiResp::ok(json!({
        "definitions": definitions,
        "published": published,
        "evaluations": evaluations,
        "failures": failures,
        "successRate": if evaluations > 0 {
            ((evaluations - failures) as f64 / evaluations as f64 * 1000.0).round() / 10.0
        } else { 100.0 },
    }))))
}
