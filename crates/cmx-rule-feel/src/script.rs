//! Rhai 脚本求值（SC0：脚本能力接缝）——FEEL 之外的**过程式逃生舱**。
//!
//! 当声明式的决策表 / 单表达式 FEEL 表达不动（阶梯累进、多步过程、带状态迭代）时，规则作者用一段
//! **受控、沙箱、可审计**的 Rhai 脚本兜底。本模块是四载体（Script 节点 / 脚本单元格 / 函数库 /
//! 脚本决策）**共用的求值内核**：把 `serde_json::Value` 上下文桥进 Rhai，跑脚本，桥回 `Value`。
//!
//! **设计取向**（对齐 cmx-rule-feel 的"受控、可静态校验、无副作用"）：
//! - **沙箱**：`max_operations` 限操作数（防死循环 / CPU 耗尽）、`max_call_levels` 限递归深度、
//!   string/array/map 尺寸上限（防内存爆炸）。刻意**用操作数而非 wall-clock 超时**做 CPU 闸门——
//!   与本 crate "不引 Instant，保 wasm/确定性友好" 纪律一致（见 lib.rs），求值确定、可复现。
//! - **无 IO/OS**：Rhai 默认纯计算，不注册任何文件/网络/时间/随机函数——保确定性与沙箱。
//! - **Don't-Panic**：Rhai 官方保证脚本永不 panic 宿主，错误以 `Result` 返回 → 落 [`FeelError::Script`]
//!   （带行号），完美契合引擎"永不 panic，失败落 trace 的 failure"纪律。
//!
//! 求值主流程（决策表 / 决策图）**一行不改**：调用点按 `lang` 标签分派（feel → 现有引擎，
//! rhai → 本模块），见 [`crate::eval_scripted`]。

use crate::FeelError;
use rhai::{Dynamic, Engine, EvalAltResult, Scope};
use serde_json::{Map, Value};
use std::cell::RefCell;

// ————————————————————————— 脚本函数库（SC3） —————————————————————————
// 可复用 Rhai 函数：求值前注册进引擎，决策表/图/脚本决策皆可 `name(args)` 调用。
// feel crate 保持 model 无关，故用本地轻量类型 [`ScriptFn`]（app 层从 ScriptFunction 映射过来）。

/// 一个脚本函数定义（name + 完整 Rhai 源，含 `fn name(...) {...}` 声明）。
#[derive(Debug, Clone)]
pub struct ScriptFn {
    /// 函数名（调用标识）。
    pub name: String,
    /// 完整源码：应含 `fn name(params) { ... }`。若为裸表达式/语句块，用 [`ScriptFn::wrap_body`] 包装。
    pub source: String,
}

impl ScriptFn {
    /// 由函数名 + 参数名 + 函数体裸源构造：若源码未含 `fn` 声明则包装成 `fn name(params) { body }`。
    pub fn from_parts(name: &str, params: &[String], body: &str) -> Self {
        let trimmed = body.trim_start();
        let source = if trimmed.starts_with("fn ") || trimmed.contains(&format!("fn {name}")) {
            body.to_string()
        } else {
            format!("fn {}({}) {{\n{}\n}}", name, params.join(", "), body)
        };
        Self { name: name.to_string(), source }
    }
}

thread_local! {
    /// 当前求值上下文的脚本函数库（app 层在**同步** evaluate 前设置）。
    /// 求值全程同步无 await，故 thread_local 在整次 evaluate 稳定；用后清理避免跨请求泄漏。
    static CURRENT_FUNCS: RefCell<Vec<ScriptFn>> = const { RefCell::new(Vec::new()) };
}

/// 设置当前线程的脚本函数库（返回旧值供恢复；app 层求值前后成对调用，见 [`with_functions`]）。
pub fn set_current_functions(fns: Vec<ScriptFn>) -> Vec<ScriptFn> {
    CURRENT_FUNCS.with(|c| c.replace(fns))
}

/// 在给定函数库下执行闭包（求值），执行后恢复旧库——RAII 式，防泄漏 + 支持嵌套（子决策）。
pub fn with_functions<T>(fns: Vec<ScriptFn>, f: impl FnOnce() -> T) -> T {
    let prev = set_current_functions(fns);
    let out = f();
    set_current_functions(prev);
    out
}

/// 把函数库编译成一个全局 Rhai 模块，注册进引擎（函数可跨调用 + 被主脚本调用）。
/// 编译失败的单个函数**跳过**（不整体崩），保稳健——坏函数在其 CRUD 校验时已应拦下。
fn register_functions(engine: &mut Engine, fns: &[ScriptFn]) {
    if fns.is_empty() {
        return;
    }
    // 合并所有函数源为一个 AST（彼此可互调），编译成 Module 注册全局。
    let combined: String = fns.iter().map(|f| f.source.as_str()).collect::<Vec<_>>().join("\n\n");
    if let Ok(ast) = engine.compile(&combined) {
        let scope = Scope::new();
        if let Ok(module) = rhai::Module::eval_ast_as_new(scope, &ast, engine) {
            engine.register_global_module(module.into());
        }
    }
}

// ————————————————————————— 沙箱默认闸门 —————————————————————————
// 保守默认，覆盖"业务人员写的计算脚本"绰绰有余；高级场景由上层放宽（SC5 env/toml 化）。

/// 操作数上限（防死循环 / CPU 耗尽）。~10 万步足够任何合理决策计算。
const MAX_OPERATIONS: u64 = 100_000;
/// 函数调用 / 递归深度上限（防爆栈）。
const MAX_CALL_LEVELS: usize = 32;
/// 字符串最大字节数（防内存爆炸）。
const MAX_STRING_SIZE: usize = 64 * 1024;
/// 数组最大元素数。
const MAX_ARRAY_SIZE: usize = 10_000;
/// 对象（map）最大键数。
const MAX_MAP_SIZE: usize = 10_000;

/// 构造一个沙箱化的 Rhai 引擎（每次求值新建，脚本间不共享可变状态 → 无跨请求污染）。
///
/// 自动注册当前线程的脚本函数库（SC3，[`set_current_functions`]/[`with_functions`] 设置）——
/// 决策表/图/脚本决策的脚本即可 `calcTax(income)` 调用。
pub fn sandboxed_engine() -> Engine {
    let mut engine = Engine::new();
    engine.set_max_operations(MAX_OPERATIONS);
    engine.set_max_call_levels(MAX_CALL_LEVELS);
    engine.set_max_string_size(MAX_STRING_SIZE);
    engine.set_max_array_size(MAX_ARRAY_SIZE);
    engine.set_max_map_size(MAX_MAP_SIZE);
    CURRENT_FUNCS.with(|c| register_functions(&mut engine, &c.borrow()));
    engine
}

/// 求值一段 Rhai 脚本：以 `ctx`（输入事实 / 累积上下文）的各字段为**顶层变量**，返回脚本结果值。
///
/// - `ctx` 为对象时，其每个键作为脚本可读变量（`income` / `level` / …）；非对象则脚本无自由变量。
/// - 脚本返回值经 serde 桥回 `serde_json::Value`：Rhai `#{...}` map → JSON 对象，数值 → f64
///   （与 FEEL 引擎同偏差，一致），unit `()` → `null`。
/// - 出错（解析 / 运行 / 超沙箱闸门）→ [`FeelError::Script`]，附**行号**（Rhai 错误带位置，比 FEEL 更精确）。
///
/// 永不 panic（Rhai Don't-Panic 保证 + 本函数不 unwrap）。
pub fn eval_script(src: &str, ctx: &Value) -> Result<Value, FeelError> {
    let engine = sandboxed_engine();
    let mut scope = scope_from_ctx(ctx)?;
    eval_script_in(&engine, &mut scope, src)
}

/// 在给定引擎 + 作用域上求值脚本（SC3 函数库注入后复用同一引擎的入口）。
pub fn eval_script_in(engine: &Engine, scope: &mut Scope, src: &str) -> Result<Value, FeelError> {
    let s = src.trim();
    if s.is_empty() {
        return Ok(Value::Null);
    }
    // eval_with_scope::<Dynamic> 取脚本最后一个表达式的值（脚本习惯：末尾裸表达式即返回值）。
    match engine.eval_with_scope::<Dynamic>(scope, s) {
        Ok(dynamic) => dynamic_to_value(dynamic),
        Err(e) => Err(FeelError::Script(format_eval_error(&e))),
    }
}

/// 语法预检（只解析不执行）——供 validate 端点在落库前暴露脚本语法错（SC5 /script/eval 亦用）。
pub fn check_script(src: &str) -> Result<(), FeelError> {
    let s = src.trim();
    if s.is_empty() {
        return Ok(());
    }
    let engine = sandboxed_engine();
    engine
        .compile(s)
        .map(|_| ())
        .map_err(|e| FeelError::Script(format!("脚本语法错误{}: {}", pos_suffix_parse(&e), e)))
}

// ————————————————————————— serde 桥接 —————————————————————————

/// 把上下文对象的各字段推入 Rhai 作用域作为顶层变量。
fn scope_from_ctx(ctx: &Value) -> Result<Scope<'static>, FeelError> {
    let mut scope = Scope::new();
    if let Value::Object(map) = ctx {
        for (k, v) in map {
            // `?` 是 FEEL 的当前列绑定，非合法 Rhai 标识符 → 跳过（脚本载体不使用 `?`）。
            if k == "?" {
                continue;
            }
            let dynamic = value_to_dynamic(v)?;
            scope.push_dynamic(k.clone(), dynamic);
        }
    }
    Ok(scope)
}

/// `serde_json::Value` → `rhai::Dynamic`（经 rhai::serde 桥）。
fn value_to_dynamic(v: &Value) -> Result<Dynamic, FeelError> {
    rhai::serde::to_dynamic(v.clone())
        .map_err(|e| FeelError::Script(format!("上下文值无法转入脚本: {e}")))
}

/// `rhai::Dynamic` → `serde_json::Value`（经 rhai::serde 桥）。unit `()` → `null`。
///
/// **数值归一化为 f64**：Rhai 有独立的 i64/f64 类型（`1+1`→整数 `2`），而 FEEL 引擎算术统一
/// f64（`2.0`）。若不归一，同一决策表里 FEEL 输出格 `income*5`（40000.0）与脚本格 `=rhai: income*5`
/// （40000）会产出**不等的 JSON**（serde_json `Number(i) != Number(f)`），破坏测试用例 expected
/// 匹配与下游相等判定。故此处把脚本返回值树中所有整数归一为 f64（对齐设计方案"数值统一 f64"）。
fn dynamic_to_value(d: Dynamic) -> Result<Value, FeelError> {
    if d.is_unit() {
        return Ok(Value::Null);
    }
    let v = rhai::serde::from_dynamic(&d)
        .map_err(|e| FeelError::Script(format!("脚本返回值无法转出: {e}")))?;
    Ok(normalize_numbers(v))
}

/// 递归把 Value 树中的整数 Number 归一为 f64（与 FEEL 引擎算术输出一致）。
fn normalize_numbers(v: Value) -> Value {
    match v {
        Value::Number(n) => {
            // 已是 f64 则原样；整数 → f64。
            match n.as_f64() {
                Some(f) => Value::from(f),
                None => Value::Number(n),
            }
        }
        Value::Array(a) => Value::Array(a.into_iter().map(normalize_numbers).collect()),
        Value::Object(m) => {
            Value::Object(m.into_iter().map(|(k, val)| (k, normalize_numbers(val))).collect())
        }
        other => other,
    }
}

/// 脚本返回值须是对象时的辅助：非对象 → 错误归因（Script 节点 / 脚本决策要求返回 map）。
pub fn value_as_object(v: Value, role: &str) -> Result<Map<String, Value>, FeelError> {
    match v {
        Value::Object(m) => Ok(m),
        other => Err(FeelError::Script(format!(
            "{role}须返回一个对象（Rhai #{{...}} map），实得: {other}"
        ))),
    }
}

// ————————————————————————— 错误格式化（行号级归因） —————————————————————————

/// 把 Rhai 运行期错误格式化成带行号的归因文案。
fn format_eval_error(e: &EvalAltResult) -> String {
    let pos = e.position();
    let suffix = match pos.line() {
        Some(line) => format!("（第 {line} 行）"),
        None => String::new(),
    };
    format!("脚本求值错误{suffix}: {e}")
}

/// 解析错误的行号后缀。
fn pos_suffix_parse(e: &rhai::ParseError) -> String {
    match e.position().line() {
        Some(line) => format!("（第 {line} 行）"),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn eval_basic_arithmetic() {
        // 末尾裸表达式即返回值。
        assert_eq!(eval_script("let x = 1; x + 1", &json!({})).unwrap(), json!(2.0));
        assert_eq!(eval_script("40 + 2", &json!({})).unwrap(), json!(42.0));
    }

    #[test]
    fn reads_context_variables() {
        let ctx = json!({ "income": 8000, "level": "gold" });
        assert_eq!(eval_script("income * 5", &ctx).unwrap(), json!(40000.0));
        assert_eq!(eval_script("\"tier-\" + level", &ctx).unwrap(), json!("tier-gold"));
    }

    #[test]
    fn returns_map_object() {
        let ctx = json!({ "income": 30000 });
        let out = eval_script("#{ tax: income * 0.1, net: income * 0.9 }", &ctx).unwrap();
        assert_eq!(out, json!({ "tax": 3000.0, "net": 27000.0 }));
    }

    #[test]
    fn multi_statement_with_loop() {
        // 阶梯累进：脚本能力的招牌场景（FEEL 表达不动）。
        let ctx = json!({ "income": 30000 });
        let src = "let taxable = income - 5000;\n\
                   let t = 0.0;\n\
                   let brackets = [[25000.0, 0.25], [12000.0, 0.20], [3000.0, 0.10], [0.0, 0.03]];\n\
                   let b = taxable;\n\
                   for br in brackets { if b > br[0] { t += (b - br[0]) * br[1]; b = br[0]; } }\n\
                   #{ tax: t, taxable: taxable }";
        let out = eval_script(src, &ctx).unwrap();
        let obj = out.as_object().unwrap();
        assert_eq!(obj.get("taxable"), Some(&json!(25000.0)));
        assert!(obj.get("tax").unwrap().as_f64().unwrap() > 0.0);
    }

    #[test]
    fn sandbox_blocks_infinite_loop() {
        // 死循环 → 超操作数上限报错（不挂起、不 panic）。
        let r = eval_script("let i = 0; while true { i += 1; } i", &json!({}));
        assert!(r.is_err(), "死循环应被沙箱 kill");
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("脚本"), "错误应归因到脚本: {msg}");
    }

    #[test]
    fn panic_does_not_escape() {
        // 运行期错误（未定义变量 / 类型错）落 Result，不穿透。
        let r = eval_script("undefined_var + nope", &json!({}));
        assert!(r.is_err());
    }

    #[test]
    fn error_carries_line_number() {
        // 第 2 行故意报错（调用不存在的函数）。
        let r = eval_script("let a = 1;\nno_such_fn(a)", &json!({}));
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("行"), "错误应含行号: {msg}");
    }

    #[test]
    fn serde_roundtrip_nested() {
        // 嵌套结构双向桥接。数值归一为 f64（与 FEEL 算术一致）：len()→3 归一为 3.0。
        let ctx = json!({ "order": { "items": [1, 2, 3], "vip": true } });
        let out = eval_script("#{ n: order.items.len(), vip: order.vip }", &ctx).unwrap();
        assert_eq!(out, json!({ "n": 3.0, "vip": true }));
    }

    #[test]
    fn empty_script_is_null() {
        assert_eq!(eval_script("", &json!({})).unwrap(), json!(null));
        assert_eq!(eval_script("   ", &json!({})).unwrap(), json!(null));
    }

    #[test]
    fn check_script_catches_syntax_error() {
        assert!(check_script("let x = ;").is_err());
        assert!(check_script("#{ tax: income * 0.1 }").is_ok());
    }

    #[test]
    fn value_as_object_guards_non_map() {
        assert!(value_as_object(json!({ "a": 1 }), "Script 节点").is_ok());
        assert!(value_as_object(json!(42), "Script 节点").is_err());
    }

    // ───────────────────── SC3：脚本函数库 ─────────────────────

    #[test]
    fn script_fn_from_parts_wraps_bare_body() {
        let f = ScriptFn::from_parts("dbl", &["x".to_string()], "x * 2");
        assert!(f.source.contains("fn dbl(x)"));
        // 已含 fn 声明则不重复包装。
        let g = ScriptFn::from_parts("t", &["a".to_string()], "fn t(a) { a + 1 }");
        assert_eq!(g.source.matches("fn t").count(), 1);
    }

    #[test]
    fn library_function_callable_from_script() {
        let fns = vec![
            ScriptFn::from_parts("gradeScore", &["raw".to_string()],
                "if raw >= 90 { \"优\" } else if raw >= 60 { \"中\" } else { \"差\" }"),
        ];
        let out = with_functions(fns, || eval_script("#{ g: gradeScore(score) }", &json!({ "score": 95 })));
        assert_eq!(out.unwrap(), json!({ "g": "优" }));
    }

    #[test]
    fn library_functions_cross_call() {
        let fns = vec![
            ScriptFn::from_parts("base", &["x".to_string()], "x * 10"),
            ScriptFn::from_parts("total", &["x".to_string()], "base(x) + 5"),
        ];
        let out = with_functions(fns, || eval_script("total(4)", &json!({})));
        assert_eq!(out.unwrap(), json!(45.0));
    }

    #[test]
    fn functions_cleared_after_scope() {
        let fns = vec![ScriptFn::from_parts("f", &[], "1")];
        with_functions(fns, || {
            assert!(eval_script("f()", &json!({})).is_ok());
        });
        // 作用域外函数库已恢复空 → 调用未定义函数报错（无跨请求泄漏）。
        assert!(eval_script("f()", &json!({})).is_err());
    }
}
