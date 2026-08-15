//! 决策表完整性分析（gap 空隙 / overlap 重叠）—— 世界级标志能力，对标 OpenL `validateDT`，
//! 超越 GoRules ZEN（其无此能力）。
//!
//! - **overlap（重叠）**：两两规则，若每一输入列的结构化约束都相交，则可能同时命中（UNIQUE 下即冲突）。
//!   用 [`cmx_rule_feel::Constraint`] 做**区域相交**推理（非点求值）。含 not()/!= 的列判为"未知"、不误报。
//! - **gap（空隙）**：把每列按边界分段 → 笛卡尔积代表点 → 逐组合用**真实求值器**（[`crate::any_rule_matches`]）
//!   查是否被任一规则覆盖，未覆盖即空隙。组合数超上限则**显式告知未分析**（不静默截断）。

use cmx_rule_feel::{parse_constraint, Constraint};
use cmx_rule_model::{CoverageReport, DecisionTable, EvalContext, Gap, Overlap};
use serde_json::{json, Map, Value};

/// 笛卡尔积上限（超出则跳过 gap，显式告知）。
const CELL_CAP: usize = 20_000;
/// gap 展示条数上限（超出附"另有 N 处"）。
const GAP_SHOW: usize = 50;

/// 分析一张决策表，产出 gap/overlap 报告。
pub fn analyze_table(table: &DecisionTable) -> CoverageReport {
    let mut report = CoverageReport::default();
    let ncol = table.inputs.len();
    if ncol == 0 || table.rules.is_empty() {
        return report;
    }

    // 每规则每列的结构化约束（缓存）。
    let constraints: Vec<Vec<Constraint>> = table
        .rules
        .iter()
        .map(|r| {
            (0..ncol)
                .map(|ci| parse_constraint(r.input_entries.get(ci).map(String::as_str).unwrap_or("-")))
                .collect()
        })
        .collect();

    // ── overlap：两两规则，全列相交则重叠 ──
    for i in 0..table.rules.len() {
        for j in (i + 1)..table.rules.len() {
            let mut all_intersect = true;
            let mut unknown = false;
            for (ca, cb) in constraints[i].iter().zip(&constraints[j]) {
                match ca.intersects(cb) {
                    Some(true) => {}
                    Some(false) => {
                        all_intersect = false;
                        break;
                    }
                    None => unknown = true, // 含 Other 列：不因此否决，但整体判"未知"不误报
                }
            }
            if all_intersect && !unknown {
                report.overlaps.push(Overlap {
                    rules: vec![i, j],
                    description: format!("规则行 {i} 与 {j} 可能同时命中（重叠）"),
                });
            }
        }
    }

    // ── gap：含 Other 列无法可靠分段 → 显式说明后返回 ──
    if constraints.iter().flatten().any(Constraint::is_other) {
        report.gaps.push(Gap {
            description: "决策表含 not()/!= 等无法结构化的单元格，未做空隙分析".into(),
        });
        return report;
    }

    // 每列代表值集合。
    let col_reps: Vec<Vec<Value>> = (0..ncol)
        .map(|ci| column_representatives(&constraints, ci))
        .collect();
    let total: usize = col_reps.iter().map(|v| v.len().max(1)).product();
    if total > CELL_CAP {
        report.gaps.push(Gap {
            description: format!("输入组合数 {total} 超上限 {CELL_CAP}，未做空隙分析（决策表过大，建议拆分）"),
        });
        return report;
    }

    // 笛卡尔积（里程表编码）：逐组合查覆盖。
    let sizes: Vec<usize> = col_reps.iter().map(Vec::len).collect();
    let mut gap_count = 0usize;
    for lin in 0..total {
        let mut rem = lin;
        let mut obj = Map::new();
        for ci in 0..ncol {
            let size = sizes[ci].max(1);
            let digit = rem % size;
            rem /= size;
            let v = col_reps[ci].get(digit).cloned().unwrap_or(Value::Null);
            // flat key = 列表达式（EvalContext::get_path 平坦 key 优先，任意 expression 皆可命中）。
            obj.insert(table.inputs[ci].expression.clone(), v);
        }
        let ctx = EvalContext::new(Value::Object(obj.clone()));
        if !crate::any_rule_matches(table, &ctx) {
            if gap_count < GAP_SHOW {
                report.gaps.push(Gap {
                    description: format!("输入组合 {} 未被任何规则覆盖", describe_cell(table, &obj)),
                });
            }
            gap_count += 1;
        }
    }
    if gap_count > GAP_SHOW {
        report.gaps.push(Gap {
            description: format!("… 另有 {} 处未覆盖组合（已截断展示）", gap_count - GAP_SHOW),
        });
    }
    report
}

/// 某列的代表值集合：数值列取边界点 + 边界间中点 + 界外哨兵；字符串列取枚举值 + 界外哨兵；
/// 布尔列取 {true,false}；全通配列取单一哨兵。
fn column_representatives(constraints: &[Vec<Constraint>], ci: usize) -> Vec<Value> {
    let col: Vec<&Constraint> = constraints.iter().map(|row| &row[ci]).collect();
    let is_num = col.iter().any(|c| matches!(c, Constraint::Num(_)));
    let is_str = col.iter().any(|c| matches!(c, Constraint::Str(_)));
    let is_bool = col.iter().any(|c| matches!(c, Constraint::Bool(_)));

    if is_num {
        let mut bounds: Vec<f64> = col.iter().flat_map(|c| c.num_bounds()).collect();
        bounds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        bounds.dedup_by(|a, b| (*a - *b).abs() < f64::EPSILON);
        let mut reps: Vec<f64> = Vec::new();
        if bounds.is_empty() {
            reps.push(0.0);
        } else {
            reps.push(bounds[0] - 1.0); // 界下
            for w in bounds.windows(2) {
                reps.push(w[0]); // 边界点（测开/闭）
                reps.push((w[0] + w[1]) / 2.0); // 区间内
            }
            reps.push(*bounds.last().unwrap()); // 最后边界
            reps.push(bounds.last().unwrap() + 1.0); // 界上
        }
        reps.into_iter().map(|x| json!(x)).collect()
    } else if is_str {
        let mut ss: Vec<String> = col.iter().flat_map(|c| c.str_values()).collect();
        ss.sort();
        ss.dedup();
        ss.push("\u{0}__other__".into()); // 哨兵：不等于任何列出的字符串
        ss.into_iter().map(Value::String).collect()
    } else if is_bool {
        vec![json!(true), json!(false)]
    } else {
        vec![json!(0)] // 全通配列：单一代表足矣
    }
}

/// 人类可读地描述一个输入组合（哨兵字符串显示为"其它"）。
fn describe_cell(table: &DecisionTable, obj: &Map<String, Value>) -> String {
    let parts: Vec<String> = table
        .inputs
        .iter()
        .map(|c| {
            let label = if c.label.is_empty() { &c.expression } else { &c.label };
            let v = obj.get(&c.expression).cloned().unwrap_or(Value::Null);
            let vs = match &v {
                Value::String(s) if s.starts_with('\u{0}') => "其它".to_string(),
                other => other.to_string(),
            };
            format!("{label}={vs}")
        })
        .collect();
    format!("{{{}}}", parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table(rules: Value) -> DecisionTable {
        serde_json::from_value(json!({
            "hitPolicy": "U",
            "inputs": [ { "expression": "score" } ],
            "outputs": [ { "name": "tier" } ],
            "rules": rules
        }))
        .unwrap()
    }

    #[test]
    fn detects_gap() {
        // < 600 → C, >= 700 → A ；600..700 是空隙。
        let t = table(json!([
            { "inputEntries": ["< 600"], "outputEntries": ["\"C\""] },
            { "inputEntries": [">= 700"], "outputEntries": ["\"A\""] }
        ]));
        let r = analyze_table(&t);
        assert!(!r.is_complete(), "应检出空隙");
        assert!(r.gaps.iter().any(|g| g.description.contains("未被任何规则覆盖")));
    }

    #[test]
    fn detects_overlap() {
        // > 700 与 > 750 在 (750,∞) 重叠。
        let t = table(json!([
            { "inputEntries": ["> 700"], "outputEntries": ["\"A\""] },
            { "inputEntries": ["> 750"], "outputEntries": ["\"B\""] }
        ]));
        let r = analyze_table(&t);
        assert!(r.has_overlap(), "应检出重叠");
        assert_eq!(r.overlaps[0].rules, vec![0, 1]);
    }

    #[test]
    fn complete_no_gap_no_overlap() {
        // < 600 / [600..700) / >= 700 —— 全覆盖且互斥。
        let t = table(json!([
            { "inputEntries": ["< 600"], "outputEntries": ["\"C\""] },
            { "inputEntries": ["[600..700)"], "outputEntries": ["\"B\""] },
            { "inputEntries": [">= 700"], "outputEntries": ["\"A\""] }
        ]));
        let r = analyze_table(&t);
        assert!(r.is_complete(), "应无空隙: {:?}", r.gaps);
        assert!(!r.has_overlap(), "应无重叠: {:?}", r.overlaps);
    }

    #[test]
    fn other_column_skips_gap_gracefully() {
        // != 含补集 → 不做 gap，但也不 panic。
        let t = table(json!([
            { "inputEntries": ["!= 0"], "outputEntries": ["\"x\""] }
        ]));
        let r = analyze_table(&t);
        assert!(r.gaps.iter().any(|g| g.description.contains("未做空隙分析")));
    }
}
