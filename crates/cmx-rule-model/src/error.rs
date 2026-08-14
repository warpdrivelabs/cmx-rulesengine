//! 内核错误类型（求值 / 解析 / 存储）。

/// 规则内核错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 决策定义结构非法（列数与规则项数不匹配、空表等）。
    #[error("决策定义错误: {0}")]
    Definition(String),
    /// unary test / 输出表达式解析或求值失败。
    #[error("求值错误: {0}")]
    Eval(String),
}

/// 内核结果别名。
pub type Result<T> = std::result::Result<T, Error>;

/// 存储契约错误（DecisionStore 实现产生）。
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// 后端错误（DB / 序列化）。
    #[error("存储后端错误: {0}")]
    Backend(String),
    /// 目标不存在。
    #[error("未找到: {0}")]
    NotFound(String),
}

/// 存储结果别名。
pub type StoreResult<T> = std::result::Result<T, StoreError>;
