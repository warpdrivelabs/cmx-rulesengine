//! 规则引擎微服务自持的 native-pages 只读投递（F2：一芯双壳的前端页面壳）。
//!
//! 门户的 native page 是 **API-backed**（非静态文件）：源码存 `web/ui-native/<relPath>`，经
//! `GET /api/native-pages/{id}` 读出 `ApiResp<NativePageFull>` 返回，shell 用 API 取页面内容。
//! 本模块让 rules-server 用**字节对齐门户的信封**自投递规则那几个 native 页——门户 F3 反代
//! `/api/native-pages/{portal.rules.*}` 到本服务时，响应与门户内嵌路径逐字节一致，shell 零感知。
//!
//! 契约（对齐 cmx-common-api/portal/pages.rs + cmx-form/pages/native.rs + flow/report 自投递）：
//!   - `GET  /native-pages/{id}`  → ApiResp<NativePageFull>            单条含源码
//!   - `POST /native-pages/batch` → ApiResp<{items:[NativePageFull]}>  批量取源码（body:{ids:[]}）
//!   - `GET  /native-pages`       → ApiResp<{items,total,page,pageSize}> 分页列表（不含源码）
//!
//! rev = xxhash64(source_bytes, 0) → 16-hex（字节对齐门户 cmx-jsonstore::content_rev）。
//! 页面目录由 env `RULE_UI_DIR` 指定，默认 `web/ui-native`（相对 rules-server cwd，即 cmx-rulesengine/）。
//!
//! 规则引擎只有 native 页（无业务单据 html 表单），故本模块**只投递 native**（对齐 flow/report 的
//! native 分支，省去 html-pages）。

use std::path::PathBuf;

use axum::extract::{Path as AxPath, Query};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::resp::{ApiResp, Result, RuleError};

/// 与门户 `NativePageFull` 同字段同序（serde 驼峰 sourceType），保证反代响应逐字节一致。
#[derive(Debug, Clone, Serialize)]
pub struct NativePageFull {
    pub id: String,
    pub name: String,
    pub details: String,
    #[serde(rename = "sourceType")]
    pub source_type: String,
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub rev: String,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
struct IndexEntry {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    details: String,
    #[serde(default, rename = "sourceType")]
    source_type: String,
    #[serde(rename = "relPath")]
    rel_path: String,
}

#[derive(Debug, Deserialize)]
struct IndexFile {
    #[serde(default)]
    pages: Vec<IndexEntry>,
}

/// UI 目录（env `RULE_UI_DIR`，默认 `web/ui-native`）。
fn ui_dir() -> PathBuf {
    let d = std::env::var("RULE_UI_DIR").unwrap_or_else(|_| "web/ui-native".to_string());
    PathBuf::from(d)
}

/// 读页面索引（`<ui_dir>/index.json`）。失败 → 空集（降级，绝不 500 整个服务）。
fn read_index() -> Vec<IndexEntry> {
    let p = ui_dir().join("index.json");
    match std::fs::read_to_string(&p) {
        Ok(t) => serde_json::from_str::<IndexFile>(&t).map(|f| f.pages).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 安全拼接源文件路径（禁止 `..` 越界，relPath 只能落在 ui_dir 内）。
fn source_abs(rel: &str) -> Option<PathBuf> {
    if rel.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return None;
    }
    let mut p = ui_dir();
    for seg in rel.split('/') {
        p.push(seg);
    }
    Some(p)
}

/// rev = xxhash64(bytes, 0) → 16-hex（字节对齐门户 cmx-jsonstore::content_rev）。
fn content_rev(bytes: &[u8]) -> String {
    format!("{:016x}", xxhash_rust::xxh64::xxh64(bytes, 0))
}

fn source_type_from_rel(rel: &str) -> String {
    let l = rel.to_lowercase();
    if l.ends_with(".js") || l.ends_with(".mjs") {
        "js".into()
    } else if l.ends_with(".html") || l.ends_with(".htm") {
        "html".into()
    } else {
        String::new()
    }
}

/// 由索引项 + 源码组装 NativePageFull（源文件缺失 → NotFound）。
fn load_full(e: &IndexEntry) -> Result<NativePageFull> {
    let abs = source_abs(&e.rel_path)
        .ok_or_else(|| RuleError::business(format!("native page relPath 非法: {}", e.rel_path)))?;
    let source = std::fs::read_to_string(&abs)
        .map_err(|_| RuleError::not_found(format!("native page 源文件缺失: {}", e.rel_path)))?;
    let rev = content_rev(source.as_bytes());
    Ok(NativePageFull {
        id: e.id.clone(),
        name: e.name.clone(),
        details: e.details.clone(),
        source_type: if e.source_type.is_empty() {
            source_type_from_rel(&e.rel_path)
        } else {
            e.source_type.clone()
        },
        rel_path: e.rel_path.clone(),
        rev,
        source,
    })
}

/// `GET /native-pages/{id}` —— 单条含源码。
pub async fn get_native_page(AxPath(id): AxPath<String>) -> Result<Json<ApiResp<NativePageFull>>> {
    let idx = read_index();
    let e = idx
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| RuleError::not_found(format!("native page 不存在: {id}")))?;
    Ok(Json(ApiResp::ok(load_full(e)?)))
}

#[derive(Debug, Deserialize)]
pub struct BatchReq {
    #[serde(default)]
    pub ids: Vec<String>,
}

/// `POST /native-pages/batch` —— 批量取源码（body:{ids:[]}）。返回 {items:[NativePageFull]}。
pub async fn batch_native_pages(Json(req): Json<BatchReq>) -> Result<Json<ApiResp<Value>>> {
    let idx = read_index();
    let mut items = Vec::new();
    for id in &req.ids {
        if let Some(e) = idx.iter().find(|e| &e.id == id)
            && let Ok(full) = load_full(e)
        {
            items.push(serde_json::to_value(full).unwrap_or(Value::Null));
        }
    }
    Ok(Json(ApiResp::ok(json!({ "items": items }))))
}

#[derive(Debug, Deserialize)]
pub struct PageQuery {
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default, rename = "pageSize")]
    pub page_size: Option<u32>,
}

/// `GET /native-pages?page=&pageSize=` —— 分页列表（不含源码，对齐门户 list）。
pub async fn list_native_pages(Query(q): Query<PageQuery>) -> Result<Json<ApiResp<Value>>> {
    let idx = read_index();
    let total = idx.len();
    let page = q.page.unwrap_or(1).max(1) as usize;
    let size = q.page_size.unwrap_or(50).max(1) as usize;
    let start = (page - 1) * size;
    let items: Vec<Value> = idx
        .iter()
        .skip(start)
        .take(size)
        .map(|e| {
            json!({
                "id": e.id, "name": e.name, "details": e.details,
                "sourceType": if e.source_type.is_empty() { source_type_from_rel(&e.rel_path) } else { e.source_type.clone() },
                "relPath": e.rel_path,
            })
        })
        .collect();
    Ok(Json(ApiResp::ok(json!({
        "items": items, "total": total, "page": page, "pageSize": size,
    }))))
}

/// 前端页面只读路由（native；挂 rules-server /api 下，前缀与门户一致）。
/// 门户 F3 反代 rules 拥有的 native 页取页请求到本服务；独立运行时也自投递自己的界面。
pub fn frontend_pages_routes<S>() -> axum::Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/native-pages", get(list_native_pages))
        .route("/native-pages/batch", post(batch_native_pages))
        .route("/native-pages/{id}", get(get_native_page))
}
