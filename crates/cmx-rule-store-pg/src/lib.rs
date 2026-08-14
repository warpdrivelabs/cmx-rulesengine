//! cmx-rule-store-pg —— DecisionStore 契约的 tokio-postgres 实现（4 表，无 RU）。

pub mod ddl;
pub mod store;

pub use store::PgDecisionStore;
