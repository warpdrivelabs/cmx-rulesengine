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

pub mod expr;
pub use expr::eval_expression;

/// 表达式错误。
#[derive(Debug, thiserror::Error)]
pub enum FeelError {
    #[error("语法错误: {0}")]
    Syntax(String),
}

/// 求值一个 unary test：`cell` 文本针对输入值 `value` 判真假；`ctx` 为输入事实（供操作数/裸布尔
/// 表达式引用其它变量，如 `> avgScore` / `contains(?, "vip")`；`?` 绑定当前列值）。
///
/// 空/`-` 恒真；逗号分隔为 OR；`not(x)` 取反；区间 `[a..b]`；比较算子（操作数为完整 FEEL 表达式）；
/// 否则整体作 `?`-绑定表达式求值——布尔结果直接用，非布尔按等值测试。
pub fn eval_unary_test(cell: &str, value: &Value, ctx: &Value) -> Result<bool, FeelError> {
    let s = cell.trim();
    if s.is_empty() || s == "-" {
        return Ok(true); // 通配。
    }
    if let Some(inner) = s.strip_prefix("not(").and_then(|r| r.strip_suffix(')')) {
        return Ok(!eval_unary_test(inner, value, ctx)?);
    }
    if let Some(parts) = split_top_commas(s) {
        for p in parts {
            if eval_unary_test(&p, value, ctx)? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    if let Some(iv) = parse_interval(s)? {
        return Ok(iv.contains(value));
    }
    let (op, operand) = split_operator(s);
    if op != Op::Eq {
        // 显式比较算子：操作数走完整 FEEL 表达式（可引用变量/算术/函数）。
        let target = expr::eval_expression(operand, ctx)?;
        return compare(op, value, &target);
    }
    // 无显式算子（或显式 `=`）：含 `?` 的显式布尔表达式（contains(?,…) / ? > x / ? in […]）→ 直接
    // 用其真值；否则裸字面量/变量 → 等值测试（value == 其求值，如 `"vip"` / `avgScore` / `700`）。
    if operand.contains('?') {
        let ctx2 = with_question(ctx, value);
        return match expr::eval_expression(operand, &ctx2)? {
            Value::Bool(b) => Ok(b),
            other => Ok(json_eq(value, &other)),
        };
    }
    let target = expr::eval_expression(operand, ctx)?;
    Ok(json_eq(value, &target))
}

/// 在 ctx 基础上追加 `?`=当前列值（供裸布尔单测引用）。
fn with_question(ctx: &Value, value: &Value) -> Value {
    let mut m = match ctx {
        Value::Object(o) => o.clone(),
        _ => serde_json::Map::new(),
    };
    m.insert("?".to_string(), value.clone());
    Value::Object(m)
}

/// 求值输出格表达式（R1：完整 FEEL 表达式，可引用输入事实——如 `income * 5` / `if score>700 then "A" else "B"`）。
pub fn eval_output(src: &str, ctx: &Value) -> Result<Value, FeelError> {
    let s = src.trim();
    if s.is_empty() {
        return Ok(Value::Null);
    }
    expr::eval_expression(s, ctx)
}

/// 求值输出字面量表达式（纯字面量，不需上下文）——保留供无 ctx 场景。
pub fn eval_output_literal(expr: &str) -> Result<Value, FeelError> {
    parse_literal(expr.trim())
}

/// 语法校验（不需输入值）——供前端 /feel/validate。
pub fn validate_unary_test(cell: &str) -> Result<(), FeelError> {
    eval_unary_test(cell, &Value::Null, &Value::Null).map(|_| ())
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
    // 仅当真正拆出 ≥2 段才算顶层逗号列表；否则（逗号全在括号/区间内，如 `contains(?, "x")`）返回
    // None，让上层按单个表达式处理——否则单元素 `[s]` 会令 eval_unary_test 对同串无限递归。
    if parts.len() < 2 {
        None
    } else {
        Some(parts)
    }
}

// ═══════════════════════ 结构化约束（gap/overlap 分析用） ═══════════════════════
//
// eval_unary_test 是"点求值"（值→真假）；完整性分析需要"区域推理"（两约束是否相交、
// 输入空间是否被覆盖）。故此处把单元格文本解析成结构化 [`Constraint`]，供 cmx-rule-engine
// 的 gap/overlap 分析消费。eval 路径保持不变（不重构，避免回归）。

/// 数值区间 [lo, hi]（含开闭）。无界用 ±∞。
#[derive(Debug, Clone)]
pub struct NumRange {
    pub lo: f64,
    pub hi: f64,
    pub lo_incl: bool,
    pub hi_incl: bool,
}

impl NumRange {
    /// 是否包含点 x。
    pub fn contains(&self, x: f64) -> bool {
        let lo_ok = if self.lo_incl { x >= self.lo } else { x > self.lo };
        let hi_ok = if self.hi_incl { x <= self.hi } else { x < self.hi };
        lo_ok && hi_ok
    }
    /// 两区间是否有非空交集（含端点相触判定）。
    pub fn overlaps(&self, o: &NumRange) -> bool {
        let lo = self.lo.max(o.lo);
        let hi = self.hi.min(o.hi);
        if lo < hi - f64::EPSILON {
            true
        } else if (lo - hi).abs() <= f64::EPSILON {
            self.contains(lo) && o.contains(lo) // 相触点须两侧都闭
        } else {
            false
        }
    }
}

/// 单元格约束的结构化形态（R0 unary test 子集）。`Other` = not()/!= 等无法结构化 → 分析保守处理。
#[derive(Debug, Clone)]
pub enum Constraint {
    /// 通配 `-`（恒真）。
    Any,
    /// 数值：比较/区间/数值枚举的并集。
    Num(Vec<NumRange>),
    /// 字符串枚举/等值。
    Str(Vec<String>),
    /// 布尔。
    Bool(bool),
    /// 无法结构化分析（not()/!=/解析失败）。
    Other,
}

impl Constraint {
    /// 两约束是否可能同时命中。`None` = 含 Other，无法判定。
    pub fn intersects(&self, o: &Constraint) -> Option<bool> {
        use Constraint::*;
        match (self, o) {
            (Any, _) | (_, Any) => Some(true),
            (Other, _) | (_, Other) => None,
            (Num(a), Num(b)) => Some(a.iter().any(|ra| b.iter().any(|rb| ra.overlaps(rb)))),
            (Str(a), Str(b)) => Some(a.iter().any(|x| b.contains(x))),
            (Bool(x), Bool(y)) => Some(x == y),
            _ => Some(false), // 类型不同 → 不相交
        }
    }
    /// 是否为无法结构化的约束。
    pub fn is_other(&self) -> bool {
        matches!(self, Constraint::Other)
    }
    /// 有限数值边界点（gap 分段用）。
    pub fn num_bounds(&self) -> Vec<f64> {
        match self {
            Constraint::Num(rs) => rs
                .iter()
                .flat_map(|r| [r.lo, r.hi])
                .filter(|x| x.is_finite())
                .collect(),
            _ => Vec::new(),
        }
    }
    /// 提及的字符串（gap 枚举分段用）。
    pub fn str_values(&self) -> Vec<String> {
        match self {
            Constraint::Str(s) => s.clone(),
            _ => Vec::new(),
        }
    }
}

/// 把 unary test 单元格文本解析成结构化 [`Constraint`]。
pub fn parse_constraint(cell: &str) -> Constraint {
    let s = cell.trim();
    if s.is_empty() || s == "-" {
        return Constraint::Any;
    }
    if s.starts_with("not(") {
        return Constraint::Other; // 补集难结构化，保守。
    }
    // 顶层逗号 = 并集。
    if let Some(parts) = split_top_commas(s) {
        return merge_union(parts.iter().map(|p| parse_constraint(p)).collect());
    }
    // 区间。
    if let Ok(Some(iv)) = parse_interval(s) {
        return Constraint::Num(vec![NumRange {
            lo: iv.lo,
            hi: iv.hi,
            lo_incl: iv.lo_incl,
            hi_incl: iv.hi_incl,
        }]);
    }
    // 比较算子 / 裸字面量。
    let (op, operand) = split_operator(s);
    let lit = match parse_literal(operand) {
        Ok(v) => v,
        Err(_) => return Constraint::Other,
    };
    match op {
        Op::Eq => value_point_constraint(&lit),
        Op::Ne => Constraint::Other, // 补集。
        Op::Gt => num_ineq(&lit, f64::INFINITY, false, false),
        Op::Ge => num_ineq(&lit, f64::INFINITY, true, false),
        Op::Lt => num_ineq_lo(&lit, f64::NEG_INFINITY, false, false),
        Op::Le => num_ineq_lo(&lit, f64::NEG_INFINITY, false, true),
    }
}

/// `= 字面量` → 点约束。
fn value_point_constraint(v: &Value) -> Constraint {
    match v {
        Value::Number(_) => {
            let x = v.as_f64().unwrap_or(0.0);
            Constraint::Num(vec![NumRange {
                lo: x,
                hi: x,
                lo_incl: true,
                hi_incl: true,
            }])
        }
        Value::String(s) => Constraint::Str(vec![s.clone()]),
        Value::Bool(b) => Constraint::Bool(*b),
        _ => Constraint::Other,
    }
}

/// `> x` / `>= x`（下界 = x，上界 = +∞）。
fn num_ineq(v: &Value, hi: f64, lo_incl: bool, hi_incl: bool) -> Constraint {
    match v.as_f64() {
        Some(x) => Constraint::Num(vec![NumRange {
            lo: x,
            hi,
            lo_incl,
            hi_incl,
        }]),
        None => Constraint::Other,
    }
}

/// `< x` / `<= x`（下界 = -∞，上界 = x）。
fn num_ineq_lo(v: &Value, lo: f64, lo_incl: bool, hi_incl: bool) -> Constraint {
    match v.as_f64() {
        Some(x) => Constraint::Num(vec![NumRange {
            lo,
            hi: x,
            lo_incl,
            hi_incl,
        }]),
        None => Constraint::Other,
    }
}

/// 并集合并：全 Num → Num（含 Any 则 Any）；全 Str → Str；含 Other/混合 → Other。
fn merge_union(subs: Vec<Constraint>) -> Constraint {
    if subs.iter().any(|c| c.is_other()) {
        return Constraint::Other;
    }
    if subs.iter().any(|c| matches!(c, Constraint::Any)) {
        return Constraint::Any;
    }
    if subs.iter().all(|c| matches!(c, Constraint::Num(_))) {
        let ranges = subs
            .into_iter()
            .filter_map(|c| match c {
                Constraint::Num(r) => Some(r),
                _ => None,
            })
            .flatten()
            .collect();
        return Constraint::Num(ranges);
    }
    if subs.iter().all(|c| matches!(c, Constraint::Str(_))) {
        let ss = subs
            .into_iter()
            .filter_map(|c| match c {
                Constraint::Str(s) => Some(s),
                _ => None,
            })
            .flatten()
            .collect();
        return Constraint::Str(ss);
    }
    Constraint::Other
}

// ═══════════════════════ FEEL 函数/算子目录（设计器向导用） ═══════════════════════

/// 返回 unary test 支持的算子/形式目录（供前端函数向导；每项含语法 + 示例 + 说明）。
pub fn function_catalog() -> serde_json::Value {
    serde_json::json!([
        { "name": "大于",   "category": "比较", "syntax": "> 数值",     "example": "> 700",        "description": "该列值大于给定数值" },
        { "name": "大于等于","category": "比较", "syntax": ">= 数值",    "example": ">= 18",        "description": "大于或等于" },
        { "name": "小于",   "category": "比较", "syntax": "< 数值",     "example": "< 100",        "description": "小于" },
        { "name": "小于等于","category": "比较", "syntax": "<= 数值",    "example": "<= 65",        "description": "小于或等于" },
        { "name": "等于",   "category": "比较", "syntax": "= 值 / 值",  "example": "\"vip\"",      "description": "等于（可省略 =，裸值即等值测试）" },
        { "name": "不等于", "category": "比较", "syntax": "!= 值",      "example": "!= 0",         "description": "不等于（不参与空隙分析）" },
        { "name": "闭区间", "category": "区间", "syntax": "[下界..上界]", "example": "[0..100]",     "description": "含两端" },
        { "name": "半开区间","category": "区间", "syntax": "[下界..上界)", "example": "[18..65)",     "description": "含下界、不含上界" },
        { "name": "开区间", "category": "区间", "syntax": "(下界..上界)", "example": "(0..1)",       "description": "不含两端" },
        { "name": "枚举",   "category": "集合", "syntax": "值1, 值2, …",  "example": "\"north\",\"south\"", "description": "任一相等即命中（OR）" },
        { "name": "否定",   "category": "逻辑", "syntax": "not(测试)",   "example": "not(> 100)",   "description": "对内部测试取反（不参与空隙分析）" },
        { "name": "通配",   "category": "逻辑", "syntax": "-",          "example": "-",            "description": "恒真，该列不参与判定" },
        { "name": "布尔",   "category": "字面量","syntax": "true / false","example": "true",        "description": "布尔字面量" },
        { "name": "空值",   "category": "字面量","syntax": "null",       "example": "null",         "description": "null 字面量" }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wildcard_true() {
        assert!(eval_unary_test("", &json!(5), &json!({})).unwrap());
        assert!(eval_unary_test("-", &json!("x"), &json!({})).unwrap());
    }

    #[test]
    fn comparisons() {
        assert!(eval_unary_test("> 700", &json!(720), &json!({})).unwrap());
        assert!(!eval_unary_test("> 700", &json!(700), &json!({})).unwrap());
        assert!(eval_unary_test(">= 18", &json!(18), &json!({})).unwrap());
        assert!(eval_unary_test("< 100", &json!(99), &json!({})).unwrap());
        assert!(eval_unary_test("<= 65", &json!(65), &json!({})).unwrap());
        // 默认 = （无算子）。
        assert!(eval_unary_test("5", &json!(5), &json!({})).unwrap());
        assert!(eval_unary_test("= 5", &json!(5), &json!({})).unwrap());
        assert!(eval_unary_test("!= 3", &json!(5), &json!({})).unwrap());
        assert!(!eval_unary_test("!= 5", &json!(5), &json!({})).unwrap());
    }

    #[test]
    fn strings_and_bools() {
        assert!(eval_unary_test("\"north\"", &json!("north"), &json!({})).unwrap());
        assert!(!eval_unary_test("\"north\"", &json!("south"), &json!({})).unwrap());
        assert!(eval_unary_test("'vip'", &json!("vip"), &json!({})).unwrap());
        assert!(eval_unary_test("true", &json!(true), &json!({})).unwrap());
        assert!(!eval_unary_test("true", &json!(false), &json!({})).unwrap());
    }

    #[test]
    fn intervals() {
        assert!(eval_unary_test("[18..65)", &json!(18), &json!({})).unwrap());
        assert!(!eval_unary_test("[18..65)", &json!(65), &json!({})).unwrap());
        assert!(eval_unary_test("(0..100]", &json!(100), &json!({})).unwrap());
        assert!(!eval_unary_test("(0..100]", &json!(0), &json!({})).unwrap());
        assert!(eval_unary_test("[1..10]", &json!(10), &json!({})).unwrap());
        // 反括号开区间 ]1..5] ≡ (1..5]。
        assert!(!eval_unary_test("]1..5]", &json!(1), &json!({})).unwrap());
        assert!(eval_unary_test("]1..5]", &json!(5), &json!({})).unwrap());
    }

    #[test]
    fn list_or() {
        assert!(eval_unary_test("\"north\",\"south\"", &json!("south"), &json!({})).unwrap());
        assert!(!eval_unary_test("\"north\",\"south\"", &json!("east"), &json!({})).unwrap());
        assert!(eval_unary_test("1,2,3", &json!(2), &json!({})).unwrap());
        // 混合：> 100 OR < 0。
        assert!(eval_unary_test("> 100, < 0", &json!(150), &json!({})).unwrap());
        assert!(eval_unary_test("> 100, < 0", &json!(-5), &json!({})).unwrap());
        assert!(!eval_unary_test("> 100, < 0", &json!(50), &json!({})).unwrap());
    }

    #[test]
    fn negation() {
        assert!(eval_unary_test("not(> 100)", &json!(50), &json!({})).unwrap());
        assert!(!eval_unary_test("not(> 100)", &json!(150), &json!({})).unwrap());
    }

    #[test]
    fn missing_value_falsy_not_error() {
        // null 输入做序比较 → false（不报错）。
        assert!(!eval_unary_test("> 100", &json!(null), &json!({})).unwrap());
        // null = null → true。
        assert!(eval_unary_test("null", &json!(null), &json!({})).unwrap());
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

    #[test]
    fn constraint_parse_and_intersect() {
        // 数值区间相交。
        let a = parse_constraint(">= 700");
        let b = parse_constraint("[650..750)");
        assert_eq!(a.intersects(&b), Some(true)); // [700,∞) ∩ [650,750) = [700,750)
        let c = parse_constraint("< 600");
        assert_eq!(a.intersects(&c), Some(false)); // 不相交
        // 相触点：> 700 与 <= 700 不相交（开/闭）。
        assert_eq!(
            parse_constraint("> 700").intersects(&parse_constraint("<= 700")),
            Some(false)
        );
        assert_eq!(
            parse_constraint(">= 700").intersects(&parse_constraint("<= 700")),
            Some(true) // 相触点 700 两侧都闭
        );
        // 枚举相交。
        assert_eq!(
            parse_constraint("\"north\",\"south\"").intersects(&parse_constraint("\"south\"")),
            Some(true)
        );
        assert_eq!(
            parse_constraint("\"north\"").intersects(&parse_constraint("\"east\"")),
            Some(false)
        );
        // 通配与任何相交。
        assert_eq!(parse_constraint("-").intersects(&parse_constraint("> 5")), Some(true));
        // Other（!=）无法判定。
        assert_eq!(parse_constraint("!= 5").intersects(&parse_constraint("> 0")), None);
        // 类型不同 → 不相交。
        assert_eq!(parse_constraint("> 5").intersects(&parse_constraint("\"x\"")), Some(false));
    }

    #[test]
    fn function_catalog_nonempty() {
        let cat = function_catalog();
        assert!(cat.as_array().map(|a| a.len() >= 10).unwrap_or(false));
    }

    // ───────────────────── R1：全 FEEL 表达式引擎 ─────────────────────

    fn ev(src: &str, ctx: serde_json::Value) -> Value {
        eval_expression(src, &ctx).unwrap()
    }

    #[test]
    fn expr_arithmetic_precedence() {
        assert_eq!(ev("2 + 3 * 4", json!({})), json!(14.0));
        assert_eq!(ev("(2 + 3) * 4", json!({})), json!(20.0));
        assert_eq!(ev("2 ** 3 ** 2", json!({})), json!(512.0)); // 右结合 2^(3^2)
        assert_eq!(ev("-5 + 3", json!({})), json!(-2.0));
        assert_eq!(ev("10 / 0", json!({})), json!(null)); // 除零 → null
    }

    #[test]
    fn expr_variables_and_paths() {
        let ctx = json!({ "income": 5000, "order": { "amount": 12000 } });
        assert_eq!(ev("income * 5", ctx.clone()), json!(25000.0));
        assert_eq!(ev("order.amount > 10000", ctx.clone()), json!(true));
        assert_eq!(ev("missing", ctx), json!(null));
    }

    #[test]
    fn expr_if_and_boolean() {
        let ctx = json!({ "score": 720 });
        assert_eq!(ev("if score >= 700 then \"A\" else \"B\"", ctx.clone()), json!("A"));
        assert_eq!(ev("score > 600 and score < 750", ctx.clone()), json!(true));
        assert_eq!(ev("score < 600 or score >= 700", ctx), json!(true));
    }

    #[test]
    fn expr_string_concat_and_builtins() {
        assert_eq!(ev("\"tier-\" + \"A\"", json!({})), json!("tier-A"));
        assert_eq!(ev("upper(\"abc\")", json!({})), json!("ABC"));
        assert_eq!(ev("substring(\"hello\", 2, 3)", json!({})), json!("ell"));
        assert_eq!(ev("contains(\"hello\", \"ell\")", json!({})), json!(true));
        assert_eq!(ev("floor(3.7)", json!({})), json!(3.0));
        assert_eq!(ev("max(1, 9, 4)", json!({})), json!(9.0));
    }

    #[test]
    fn expr_lists_in_and_quantifiers() {
        assert_eq!(ev("sum([1, 2, 3, 4])", json!({})), json!(10.0));
        assert_eq!(ev("count([10, 20, 30])", json!({})), json!(3));
        assert_eq!(ev("5 in [1..10]", json!({})), json!(true));
        assert_eq!(ev("\"b\" in [\"a\", \"b\", \"c\"]", json!({})), json!(true));
        // 量词
        assert_eq!(ev("some x in [1, 2, 3] satisfies x > 2", json!({})), json!(true));
        assert_eq!(ev("every x in [1, 2, 3] satisfies x > 0", json!({})), json!(true));
        assert_eq!(ev("every x in [1, 2, 3] satisfies x > 2", json!({})), json!(false));
        // for 推导
        assert_eq!(ev("for x in [1, 2, 3] return x * 10", json!({})), json!([10.0, 20.0, 30.0]));
        // 过滤（item 绑定元素）
        assert_eq!(ev("[1, 2, 3, 4][item > 2]", json!({})), json!([3.0, 4.0]));
    }

    #[test]
    fn unary_test_references_variables() {
        let ctx = json!({ "avgScore": 650 });
        // 单测操作数引用变量。
        assert!(eval_unary_test("> avgScore", &json!(700), &ctx).unwrap());
        assert!(!eval_unary_test("> avgScore", &json!(600), &ctx).unwrap());
        // 裸布尔表达式 unary test（引用 ? = 当前列值 + 函数）。
        assert!(eval_unary_test("contains(?, \"vip\")", &json!("vip-user"), &json!({})).unwrap());
        assert!(!eval_unary_test("contains(?, \"vip\")", &json!("normal"), &json!({})).unwrap());
        assert!(eval_unary_test("? in [18..65)", &json!(30), &json!({})).unwrap());
    }

    #[test]
    fn eval_output_computed() {
        let ctx = json!({ "income": 8000, "level": "gold" });
        assert_eq!(eval_output("income * 5", &ctx).unwrap(), json!(40000.0));
        assert_eq!(eval_output("\"tier-\" + level", &ctx).unwrap(), json!("tier-gold"));
        assert_eq!(eval_output("if income > 5000 then \"high\" else \"low\"", &ctx).unwrap(), json!("high"));
    }
}
