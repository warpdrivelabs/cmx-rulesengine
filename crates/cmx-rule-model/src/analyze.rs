//! 决策表完整性分析报告类型（gap = 空隙 / overlap = 重叠）。
//!
//! **世界级标志能力**（对标 OpenL Tablets `validateDT` / Drools `ANALYZE_DECISION_TABLE`，
//! GoRules ZEN 恰缺此）。本文件 R0 定义报告类型；求值/检测算法 R1 在 cmx-rule-engine 实现。

use serde::{Deserialize, Serialize};

/// 决策表完整性报告。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CoverageReport {
    /// 未被任何规则覆盖的输入组合。
    #[serde(default)]
    pub gaps: Vec<Gap>,
    /// 可被多条规则同时命中的组合（U 策略下即冲突）。
    #[serde(default)]
    pub overlaps: Vec<Overlap>,
}

impl CoverageReport {
    /// 无空隙（输入空间被规则完整覆盖）。
    pub fn is_complete(&self) -> bool {
        self.gaps.is_empty()
    }
    /// 存在重叠。
    pub fn has_overlap(&self) -> bool {
        !self.overlaps.is_empty()
    }
}

/// 一处空隙（未覆盖的输入组合）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gap {
    /// 人类可读描述（如 "creditScore ∈ (750..∞) 未被任何规则覆盖"）。
    pub description: String,
}

/// 一处重叠（多规则可同时命中）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Overlap {
    /// 可同时命中的规则行号（0-based）。
    pub rules: Vec<usize>,
    /// 人类可读描述。
    pub description: String,
}
