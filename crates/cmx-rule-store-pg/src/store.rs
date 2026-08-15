//! [`DecisionStore`] 的 tokio-postgres 实现。
//!
//! 严格类型纪律（对齐 flow store-pg，tokio-postgres 类型敏感）：
//! - jsonb 列写入用 `DataValue::Json(String)`，读回也是 `DataValue::Json(String)`。
//! - TIMESTAMPTZ 用 `DataValue::DateTime`；文本用 `DataValue::String`；整数用 `DataValue::Int`。
//! - 参数绑定统一走 `SqlParams::DataValues`（顺序对应 `$1..$n`）。

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use cmx_core::model::cell::DataValue;
use cmx_core::model::data::dataset::{DataSet, Row, Schema};
use cmx_database_pg::{execute_sql, execute_sql_with_params, query_sql_with_params, SqlParams};
use cmx_rule_model::{
    DecisionBody, DecisionDef, DecisionDefMeta, DecisionLog, DecisionStore, ReleaseMeta, StoreError,
    StoreResult, TestCase,
};
use serde_json::Value;

/// PG 决策存储。`db_id` 指向已注册的数据源（R3 多租户下按租户派生）。
#[derive(Clone)]
pub struct PgDecisionStore {
    db_id: String,
}

impl PgDecisionStore {
    /// 用数据源 id 构造。
    pub fn new(db_id: impl Into<String>) -> Self {
        Self { db_id: db_id.into() }
    }

    /// 幂等建表（启动钩子调用）。
    pub async fn ensure_schema(&self) -> StoreResult<()> {
        for stmt in crate::ddl::DDL_STATEMENTS {
            execute_sql(&self.db_id, None, stmt)
                .await
                .map_err(|e| StoreError::Backend(format!("建表失败: {e}")))?;
        }
        Ok(())
    }

    async fn exec(&self, sql: &str, params: Vec<DataValue>) -> StoreResult<u64> {
        execute_sql_with_params(&self.db_id, None, sql, SqlParams::DataValues(params))
            .await
            .map_err(|e| StoreError::Backend(format!("执行失败: {e}")))
    }

    async fn query(
        &self,
        sql: &str,
        params: Vec<DataValue>,
        ds_id: &str,
    ) -> StoreResult<DataSet> {
        query_sql_with_params(&self.db_id, None, sql, SqlParams::DataValues(params), ds_id)
            .await
            .map_err(|e| StoreError::Backend(format!("查询失败: {e}")))
    }

    // ─────────────────── 发布 / 版本（F1，inherent 方法，非 trait） ───────────────────

    /// 发布当前草稿：写不可变 release（version+1、rev 内容哈希、active=true，旧版失活）+ 置定义已发布。
    /// 返回新版本号。
    pub async fn publish(&self, key: &str, published_by: Option<String>) -> StoreResult<u32> {
        // 取当前草稿决策体。
        let dft = self
            .query(
                "SELECT body FROM cmx_rule_definition WHERE key = $1",
                vec![DataValue::String(key.to_string())],
                "rule_def_body",
            )
            .await?;
        let Some(row) = dft.iter().next() else {
            return Err(StoreError::NotFound(format!("决策 {key} 无草稿，无法发布")));
        };
        let body = get_json(row, dft.schema.as_ref(), "body")?;
        let body_str = body.to_string();
        let rev = format!("{:016x}", xxhash_rust::xxh64::xxh64(body_str.as_bytes(), 0));

        // 下一版本号 = 现有最大版本 + 1。
        let vds = self
            .query(
                "SELECT COALESCE(MAX(version), 0) AS mx FROM cmx_rule_release WHERE key = $1",
                vec![DataValue::String(key.to_string())],
                "rule_rel_maxver",
            )
            .await?;
        let cur_max = vds.iter().next().map(|r| get_i64(r, vds.schema.as_ref(), "mx")).unwrap_or(0);
        let next = (cur_max + 1) as u32;
        let now = Utc::now();
        let id = uuid::Uuid::new_v4().to_string();

        // 旧版失活 → 插新 active 版 → 置定义已发布（R0 顺序执行；R3 收进事务）。
        self.exec(
            "UPDATE cmx_rule_release SET active = FALSE WHERE key = $1",
            vec![DataValue::String(key.to_string())],
        )
        .await?;
        self.exec(
            "INSERT INTO cmx_rule_release (id, key, version, rev, body, active, published_by, published_at) \
             VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7)",
            vec![
                DataValue::String(id),
                DataValue::String(key.to_string()),
                DataValue::Int(next as i64),
                DataValue::String(rev),
                DataValue::Json(body_str),
                opt_str(&published_by),
                DataValue::DateTime(now),
            ],
        )
        .await?;
        self.exec(
            "UPDATE cmx_rule_definition SET published = TRUE, version = $2, updated_at = $3 WHERE key = $1",
            vec![
                DataValue::String(key.to_string()),
                DataValue::Int(next as i64),
                DataValue::DateTime(now),
            ],
        )
        .await?;
        Ok(next)
    }

    /// 列出某决策的全部发布版本（版本降序）。
    pub async fn list_versions(&self, key: &str) -> StoreResult<Vec<ReleaseMeta>> {
        let ds = self
            .query(
                "SELECT id, key, version, rev, active, published_by, published_at \
                 FROM cmx_rule_release WHERE key = $1 ORDER BY version DESC",
                vec![DataValue::String(key.to_string())],
                "rule_versions",
            )
            .await?;
        let schema = ds.schema.as_ref();
        let mut out = Vec::new();
        for row in ds.iter() {
            out.push(ReleaseMeta {
                id: get_string(row, schema, "id")?,
                key: get_string(row, schema, "key")?,
                version: get_i64(row, schema, "version") as u32,
                rev: get_opt_string(row, schema, "rev").unwrap_or_default(),
                active: get_bool(row, schema, "active"),
                published_by: get_opt_string(row, schema, "published_by"),
                published_at: get_opt_ts(row, schema, "published_at").unwrap_or_else(Utc::now),
            });
        }
        Ok(out)
    }

    /// 激活指定版本（其余失活）。版本不存在 → NotFound。
    pub async fn activate_version(&self, key: &str, version: u32) -> StoreResult<()> {
        self.exec(
            "UPDATE cmx_rule_release SET active = FALSE WHERE key = $1",
            vec![DataValue::String(key.to_string())],
        )
        .await?;
        let n = self
            .exec(
                "UPDATE cmx_rule_release SET active = TRUE WHERE key = $1 AND version = $2",
                vec![DataValue::String(key.to_string()), DataValue::Int(version as i64)],
            )
            .await?;
        if n == 0 {
            return Err(StoreError::NotFound(format!("决策 {key} 无版本 {version}")));
        }
        // 定义版本对齐激活版（列表/详情一致）。
        self.exec(
            "UPDATE cmx_rule_definition SET version = $2, updated_at = $3 WHERE key = $1",
            vec![
                DataValue::String(key.to_string()),
                DataValue::Int(version as i64),
                DataValue::DateTime(Utc::now()),
            ],
        )
        .await?;
        Ok(())
    }

    // ─────────────────── 测试用例（F1） ───────────────────

    /// upsert 一条测试用例。
    pub async fn save_test(&self, tc: &TestCase) -> StoreResult<()> {
        self.exec(
            "INSERT INTO cmx_rule_test_case (id, decision_key, name, input, expected, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, input = EXCLUDED.input, \
             expected = EXCLUDED.expected",
            vec![
                DataValue::String(tc.id.clone()),
                DataValue::String(tc.decision_key.clone()),
                DataValue::String(tc.name.clone()),
                DataValue::Json(tc.input.to_string()),
                DataValue::Json(tc.expected.to_string()),
                DataValue::DateTime(tc.created_at),
            ],
        )
        .await?;
        Ok(())
    }

    /// 列出某决策的测试用例。
    pub async fn list_tests(&self, key: &str) -> StoreResult<Vec<TestCase>> {
        let ds = self
            .query(
                "SELECT id, decision_key, name, input, expected, created_at \
                 FROM cmx_rule_test_case WHERE decision_key = $1 ORDER BY created_at",
                vec![DataValue::String(key.to_string())],
                "rule_tests",
            )
            .await?;
        let schema = ds.schema.as_ref();
        let mut out = Vec::new();
        for row in ds.iter() {
            out.push(TestCase {
                id: get_string(row, schema, "id")?,
                decision_key: get_string(row, schema, "decision_key")?,
                name: get_opt_string(row, schema, "name").unwrap_or_default(),
                input: get_json(row, schema, "input")?,
                expected: get_json(row, schema, "expected")?,
                created_at: get_opt_ts(row, schema, "created_at").unwrap_or_else(Utc::now),
            });
        }
        Ok(out)
    }

    /// 删除一条测试用例。
    pub async fn delete_test(&self, id: &str) -> StoreResult<()> {
        self.exec(
            "DELETE FROM cmx_rule_test_case WHERE id = $1",
            vec![DataValue::String(id.to_string())],
        )
        .await?;
        Ok(())
    }
}

#[async_trait]
impl DecisionStore for PgDecisionStore {
    async fn load_definition(&self, _tenant: &str, key: &str) -> StoreResult<Option<DecisionDef>> {
        // 优先取激活发布版本（求值以发布态为准）；无发布则回退草稿定义（设计期可试算）。
        let rel = self
            .query(
                "SELECT version, body FROM cmx_rule_release WHERE key = $1 AND active = TRUE \
                 ORDER BY version DESC LIMIT 1",
                vec![DataValue::String(key.to_string())],
                "rule_release",
            )
            .await?;
        if let Some(row) = rel.iter().next() {
            let schema = rel.schema.as_ref();
            let version = get_i64(row, schema, "version") as u32;
            let body = get_json(row, schema, "body")?;
            return Ok(Some(def_from_parts(key, version, body)?));
        }

        let dft = self
            .query(
                "SELECT name, version, body FROM cmx_rule_definition WHERE key = $1",
                vec![DataValue::String(key.to_string())],
                "rule_definition",
            )
            .await?;
        let Some(row) = dft.iter().next() else {
            return Ok(None);
        };
        let schema = dft.schema.as_ref();
        let version = get_i64(row, schema, "version") as u32;
        let body = get_json(row, schema, "body")?;
        Ok(Some(def_from_parts(key, version, body)?))
    }

    async fn save_definition(&self, _tenant: &str, def: &DecisionDef) -> StoreResult<()> {
        // 决策体 IR 单独序列化进 body（去掉顶层 key/name/version，避免与列重复）。
        let body = serde_json::to_value(&def.body)
            .map_err(|e| StoreError::Backend(format!("序列化决策体失败: {e}")))?;
        let now = Utc::now();
        self.exec(
            "INSERT INTO cmx_rule_definition (key, name, version, published, body, created_at, updated_at) \
             VALUES ($1, $2, $3, FALSE, $4, $5, $5) \
             ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, \
             body = EXCLUDED.body, updated_at = EXCLUDED.updated_at",
            vec![
                DataValue::String(def.key.clone()),
                DataValue::String(def.name.clone()),
                DataValue::Int(def.version as i64),
                DataValue::Json(body.to_string()),
                DataValue::DateTime(now),
            ],
        )
        .await?;
        Ok(())
    }

    async fn list_definitions(&self, _tenant: &str) -> StoreResult<Vec<DecisionDefMeta>> {
        let ds = self
            .query(
                "SELECT key, name, version, published, updated_at FROM cmx_rule_definition \
                 ORDER BY updated_at DESC",
                vec![],
                "rule_definition_list",
            )
            .await?;
        let schema = ds.schema.as_ref();
        let mut out = Vec::with_capacity(ds.iter().count());
        for row in ds.iter() {
            out.push(DecisionDefMeta {
                key: get_string(row, schema, "key")?,
                name: get_opt_string(row, schema, "name").unwrap_or_default(),
                version: get_i64(row, schema, "version") as u32,
                published: get_bool(row, schema, "published"),
                updated_at: get_opt_ts(row, schema, "updated_at"),
            });
        }
        Ok(out)
    }

    async fn append_log(&self, _tenant: &str, log: &DecisionLog) -> StoreResult<()> {
        self.exec(
            "INSERT INTO cmx_rule_decision_log \
             (id, decision_key, decision_version, input, output, trace, timing_us, caller, failure, created_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            vec![
                DataValue::String(log.id.clone()),
                DataValue::String(log.decision_key.clone()),
                DataValue::Int(log.decision_version as i64),
                DataValue::Json(log.input.to_string()),
                DataValue::Json(log.output.to_string()),
                DataValue::Json(log.trace.to_string()),
                DataValue::Int(log.timing_us as i64),
                opt_str(&log.caller),
                opt_str(&log.failure),
                DataValue::DateTime(log.created_at),
            ],
        )
        .await?;
        Ok(())
    }
}

// ————————————————————————— 组装 / 取值助手 —————————————————————————

/// 由列还原 [`DecisionDef`]：body 里含 kind 标签的决策体，拼回顶层 key/version。
fn def_from_parts(key: &str, version: u32, body: Value) -> StoreResult<DecisionDef> {
    let body: DecisionBody = serde_json::from_value(body)
        .map_err(|e| StoreError::Backend(format!("反序列化决策体失败: {e}")))?;
    Ok(DecisionDef {
        key: key.to_string(),
        name: String::new(),
        version,
        body,
    })
}

fn opt_str(v: &Option<String>) -> DataValue {
    match v {
        Some(s) => DataValue::String(s.clone()),
        None => DataValue::Null,
    }
}

fn get_string(row: &Row, schema: &Schema, col: &str) -> StoreResult<String> {
    match row.get_by_name(schema, col) {
        Some(DataValue::String(s)) => Ok(s.clone()),
        Some(DataValue::ShortStr(s)) | Some(DataValue::LongStr(s)) => Ok(s.to_string()),
        other => Err(StoreError::Backend(format!("列 {col} 期望文本，实际 {other:?}"))),
    }
}

fn get_opt_string(row: &Row, schema: &Schema, col: &str) -> Option<String> {
    match row.get_by_name(schema, col) {
        Some(DataValue::String(s)) => Some(s.clone()),
        Some(DataValue::ShortStr(s)) | Some(DataValue::LongStr(s)) => Some(s.to_string()),
        _ => None,
    }
}

fn get_bool(row: &Row, schema: &Schema, col: &str) -> bool {
    matches!(row.get_by_name(schema, col), Some(DataValue::Bool(true)))
}

fn get_i64(row: &Row, schema: &Schema, col: &str) -> i64 {
    match row.get_by_name(schema, col) {
        Some(DataValue::Int(v)) => *v,
        _ => 0,
    }
}

fn get_opt_ts(row: &Row, schema: &Schema, col: &str) -> Option<DateTime<Utc>> {
    match row.get_by_name(schema, col) {
        Some(DataValue::DateTime(dt)) => Some(*dt),
        _ => None,
    }
}

fn get_json(row: &Row, schema: &Schema, col: &str) -> StoreResult<Value> {
    match row.get_by_name(schema, col) {
        Some(DataValue::Json(s)) => serde_json::from_str(s)
            .map_err(|e| StoreError::Backend(format!("解析 {col} jsonb 失败: {e}"))),
        Some(DataValue::String(s)) => serde_json::from_str(s)
            .map_err(|e| StoreError::Backend(format!("解析 {col} 字符串为 json 失败: {e}"))),
        other => Err(StoreError::Backend(format!("列 {col} 期望 jsonb，实际 {other:?}"))),
    }
}
