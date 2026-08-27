//! 请求级租户上下文——已收编至 `cmx-engine-kit::tenant`（唯一真源）。
//!
//! 本模块保留为 re-export shim：handlers / auth 既有 `crate::tenant::*` 引用零改动
//! （顺带获得 nickname 管道与 `current_display_nickname`，纯增量 API）。
//! 真源见 `../cmx-container/crates/libs/cmx-engine-kit/src/tenant.rs`。

pub use cmx_engine_kit::tenant::*;
