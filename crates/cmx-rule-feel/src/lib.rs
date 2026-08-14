//! S-FEEL **unary test** 求值（决策表单元格语义）+ 输出字面量求值。
//!
//! unary test 针对"当前输入列值"判真假。DMN S-FEEL 单元格文法（R0 子集）：
//! - 通配：`-` 或空串 → 恒真。
//! - 比较：`> 700` / `>= 18` / `< 100` / `<= 65` / `= 5` / `!= 3`（缺算子默认 `=`，即 `700` ≡ `= 700`）。
//! - 区间：`[1..10]` 闭 / `(1..10)` 开 / `[1..10)` 混合 / `]1..10]` 反括号开（≡ `(1..10]`）。
//! - 列表（OR）：`"north","south"` / `1,2,3` / `> 100, < 0`（逗号分隔，任一真则真）。
//! - 否定：`not(...)`（对内部 unary test 取反）。
//! - 字面量：数字、`"带引号字符串"`、`true`/`false`、`null`。
//!
//! 设计取向对齐 cmx-flow-model::expr：**受控、可静态校验、无副作用**（决策安全友好）。

use serde_json::Value;

/// 表达式错误。
#[derive(Debug, thiserror::Error)]
pub enum FeelError {
    #[error("语法错误: {0}")]
    Syntax(String),
}

/// 求值一个 unary test：`cell` 文本针对输入值 `value` 判真假。
///
/// 空/`-` 恒真；逗号分隔为 OR；`not(x)` 取反；否则解析为比较/区间/字面量单测。
pub fn eval_unary_test(cell: &str, value: &Value) -> Result<bool, FeelError> {
    let s = cell.trim();
    if s.is_empty() || s == "-" {
        return Ok(true); // 通配。
    }
    // not(...) 否定。
    if let Some(inner) = s.strip_prefix("not(").and_then(|r| r.strip_suffix(')')) {
        return Ok(!eval_unary_test(inner, value)?);
    }
    // 顶层逗号分隔 = OR（区间内的 .. 不含逗号，故顶层 split 安全）。
    if let Some(parts) = split_top_commas(s) {
        for p in parts {
            if eval_unary_test(&p, value)? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    // 区间。
    if let Some(iv) = parse_interval(s)? {
        return Ok(iv.contains(value));
    }
    // 比较算子（含默认 =）。
    let (op, operand) = split_operator(s);
    let target = parse_literal(operand)?;
    compare(op, value, &target)
}

/// 求值输出字面量表达式（R0：数字 / 带引号字符串 / true/false/null）。
/// R1 起为完整 FEEL 表达式（可引用输入）。
pub fn eval_output_literal(expr: &str) -> Result<Value, FeelError> {
    parse_literal(expr.trim())
}

/// 语法校验（不需输入值）——供前端 /feel/validate。
pub fn validate_unary_test(cell: &str) -> Result<(), FeelError> {
    // 用一个哑值跑一遍：能解析即语法 OK（区间/字面量/算子都会被触及）。
    eval_unary_test(cell, &Value::Null).map(|_| ())
}

// ————————————————————————— 内部 —————————————————————————

#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
}

/// 拆比较算子；无显式算子默认 `=`。
fn split_operator(s: &str) -> (Op, &str) {
    let s = s.trim();
    for (tok, op) in [
        (">=", Op::Ge),
        ("<=", Op::Le),
        ("!=", Op::Ne),
        (">", Op::Gt),
        ("<", Op::Lt),
        ("=", Op::Eq),
    ] {
        if let Some(rest) = s.strip_prefix(tok) {
            return (op, rest.trim());
        }
    }
    (Op::Eq, s)
}

/// 解析字面量：数字 / "字符串" / 'string' / true / false / null。
fn parse_literal(s: &str) -> Result<Value, FeelError> {
    let s = s.trim();
    if s == "true" {
        return Ok(Value::Bool(true));
    }
    if s == "false" {
        return Ok(Value::Bool(false));
    }
    if s == "null" {
        return Ok(Value::Null);
    }
    // 带引号字符串（双或单）。
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        return Ok(Value::String(s[1..s.len() - 1].to_string()));
    }
    // 数字。
    if let Ok(n) = s.parse::<f64>() {
        return Ok(serde_json::json!(n));
    }
    Err(FeelError::Syntax(format!("无法解析字面量: {s:?}")))
}

/// 数值比较 / 相等比较。类型不匹配时相等按 JSON 相等、不等/序比较为 false（不 panic）。
fn compare(op: Op, lhs: &Value, rhs: &Value) -> Result<bool, FeelError> {
    // 相等/不等：支持任意 JSON 值。
    match op {
        Op::Eq => return Ok(json_eq(lhs, rhs)),
        Op::Ne => return Ok(!json_eq(lhs, rhs)),
        _ => {}
    }
    // 序比较：仅数值有意义。
    match (as_f64(lhs), as_f64(rhs)) {
        (Some(a), Some(b)) => Ok(match op {
            Op::Gt => a > b,
            Op::Ge => a >= b,
            Op::Lt => a < b,
            Op::Le => a <= b,
            _ => unreachable!(),
        }),
        // 非数值做序比较 → false（缺失/类型不符不命中，不报错）。
        _ => Ok(false),
    }
}

/// JSON 相等：数值按 f64 容差、其余按结构相等。
fn json_eq(a: &Value, b: &Value) -> bool {
    match (as_f64(a), as_f64(b)) {
        (Some(x), Some(y)) => (x - y).abs() < f64::EPSILON,
        _ => a == b,
    }
}

fn as_f64(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// 区间 [a..b] / (a..b) / 混合 / 反括号 ]a..b]。
struct Interval {
    lo: f64,
    hi: f64,
    lo_incl: bool,
    hi_incl: bool,
}

impl Interval {
    fn contains(&self, v: &Value) -> bool {
        let Some(x) = v.as_f64() else { return false };
        let lo_ok = if self.lo_incl { x >= self.lo } else { x > self.lo };
        let hi_ok = if self.hi_incl { x <= self.hi } else { x < self.hi };
        lo_ok && hi_ok
    }
}

/// 解析区间；非区间返回 Ok(None)。
fn parse_interval(s: &str) -> Result<Option<Interval>, FeelError> {
    let s = s.trim();
    let lo_incl = match s.chars().next() {
        Some('[') => true,
        Some('(') | Some(']') => false, // ']' 反括号开区间起始
        _ => return Ok(None),
    };
    let hi_incl = match s.chars().last() {
        Some(']') => true,
        Some(')') | Some('[') => false, // '[' 反括号开区间结束
        _ => return Ok(None),
    };
    let inner = &s[1..s.len() - 1];
    let Some((a, b)) = inner.split_once("..") else {
        return Ok(None);
    };
    let lo = a
        .trim()
        .parse::<f64>()
        .map_err(|_| FeelError::Syntax(format!("区间下界非数值: {a:?}")))?;
    let hi = b
        .trim()
        .parse::<f64>()
        .map_err(|_| FeelError::Syntax(format!("区间上界非数值: {b:?}")))?;
    Ok(Some(Interval {
        lo,
        hi,
        lo_incl,
        hi_incl,
    }))
}

/// 顶层逗号拆分（区间内无逗号，故无需括号深度跟踪；但需避开 `not(a,b)` —— R0 not 内不支持逗号）。
/// 返回 None 表示无顶层逗号（单测本身）。
fn split_top_commas(s: &str) -> Option<Vec<String>> {
    if !s.contains(',') {
        return None;
    }
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for ch in s.chars() {
        match ch {
            '[' | '(' | ']' => {
                // 注意 ']' 既可能是区间开始也可能是结束；用 depth 粗略跟踪足够 R0（区间内无逗号）。
                if ch == ']' {
                    depth -= 1;
                } else {
                    depth += 1;
                }
                cur.push(ch);
            }
            ')' => {
                depth -= 1;
                cur.push(ch);
            }
            ',' if depth <= 0 => {
                parts.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        parts.push(cur.trim().to_string());
    }
    Some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wildcard_true() {
        assert!(eval_unary_test("", &json!(5)).unwrap());
        assert!(eval_unary_test("-", &json!("x")).unwrap());
    }

    #[test]
    fn comparisons() {
        assert!(eval_unary_test("> 700", &json!(720)).unwrap());
        assert!(!eval_unary_test("> 700", &json!(700)).unwrap());
        assert!(eval_unary_test(">= 18", &json!(18)).unwrap());
        assert!(eval_unary_test("< 100", &json!(99)).unwrap());
        assert!(eval_unary_test("<= 65", &json!(65)).unwrap());
        // 默认 = （无算子）。
        assert!(eval_unary_test("5", &json!(5)).unwrap());
        assert!(eval_unary_test("= 5", &json!(5)).unwrap());
        assert!(eval_unary_test("!= 3", &json!(5)).unwrap());
        assert!(!eval_unary_test("!= 5", &json!(5)).unwrap());
    }

    #[test]
    fn strings_and_bools() {
        assert!(eval_unary_test("\"north\"", &json!("north")).unwrap());
        assert!(!eval_unary_test("\"north\"", &json!("south")).unwrap());
        assert!(eval_unary_test("'vip'", &json!("vip")).unwrap());
        assert!(eval_unary_test("true", &json!(true)).unwrap());
        assert!(!eval_unary_test("true", &json!(false)).unwrap());
    }

    #[test]
    fn intervals() {
        assert!(eval_unary_test("[18..65)", &json!(18)).unwrap());
        assert!(!eval_unary_test("[18..65)", &json!(65)).unwrap());
        assert!(eval_unary_test("(0..100]", &json!(100)).unwrap());
        assert!(!eval_unary_test("(0..100]", &json!(0)).unwrap());
        assert!(eval_unary_test("[1..10]", &json!(10)).unwrap());
        // 反括号开区间 ]1..5] ≡ (1..5]。
        assert!(!eval_unary_test("]1..5]", &json!(1)).unwrap());
        assert!(eval_unary_test("]1..5]", &json!(5)).unwrap());
    }

    #[test]
    fn list_or() {
        assert!(eval_unary_test("\"north\",\"south\"", &json!("south")).unwrap());
        assert!(!eval_unary_test("\"north\",\"south\"", &json!("east")).unwrap());
        assert!(eval_unary_test("1,2,3", &json!(2)).unwrap());
        // 混合：> 100 OR < 0。
        assert!(eval_unary_test("> 100, < 0", &json!(150)).unwrap());
        assert!(eval_unary_test("> 100, < 0", &json!(-5)).unwrap());
        assert!(!eval_unary_test("> 100, < 0", &json!(50)).unwrap());
    }

    #[test]
    fn negation() {
        assert!(eval_unary_test("not(> 100)", &json!(50)).unwrap());
        assert!(!eval_unary_test("not(> 100)", &json!(150)).unwrap());
    }

    #[test]
    fn missing_value_falsy_not_error() {
        // null 输入做序比较 → false（不报错）。
        assert!(!eval_unary_test("> 100", &json!(null)).unwrap());
        // null = null → true。
        assert!(eval_unary_test("null", &json!(null)).unwrap());
    }

    #[test]
    fn output_literal() {
        assert_eq!(eval_output_literal("\"A\"").unwrap(), json!("A"));
        assert_eq!(eval_output_literal("true").unwrap(), json!(true));
        assert_eq!(eval_output_literal("null").unwrap(), json!(null));
        assert_eq!(eval_output_literal("100").unwrap(), json!(100.0));
    }

    #[test]
    fn validate_syntax() {
        assert!(validate_unary_test("[1..10]").is_ok());
        assert!(validate_unary_test("> 700").is_ok());
        assert!(validate_unary_test("\"a\",\"b\"").is_ok());
        assert!(validate_unary_test("[bad..10]").is_err());
    }
}
