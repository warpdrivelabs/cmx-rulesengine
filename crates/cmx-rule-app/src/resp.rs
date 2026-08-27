//! 平台中立的响应信封 + 错误类型——已收编至 cmx-api-types（经 `cmx_engine_kit::resp`
//! re-export，唯一真源）。
//!
//! 受控变更（已拍板 2-B）：错误 code 值域从本 crate 自持的 1/4/5 迁至 api-types 的
//! 1/404/500——Business 不变；NotFound 4→404、Internal 5→500（HTTP 状态码均不变，
//! 仅 body 的 code 值对齐平台）。PageServeError 本地桥已删（cmx-form 内置 api-types
//! 转换：BadRequest→400、Io→500）。
//!
//! handlers 构造器替换基线：`business`→`business_error` 13 处、`internal`→`internal_error`
//! 22 处（not_found 9 同名零改）。

pub use cmx_engine_kit::resp::{ApiResp, Result};

/// 过渡期别名：handlers 既有 `RuleError::xxx` 引用零改动（构造器名已对齐 api-types）。
pub use cmx_engine_kit::resp::Error as RuleError;
