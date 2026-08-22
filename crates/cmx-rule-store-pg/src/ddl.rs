//! 规则引擎 PG 表结构 DDL（幂等）。
//!
//! 硬约束（对齐 flow store-pg）：`cmx_rule_` 前缀；禁外键，用索引替代；DDL 幂等（IF NOT EXISTS）。
//! 六表——无 RU 运行表（规则决策无长驻状态）：定义 / 发布 / 决策日志 / 测试用例 / 脚本函数库（SC3）/ 分类字典。
//! 多租户（R3）：per-tenant DB 隔离，故表内不带 tenant 列（库即租户边界）。

/// 建表 DDL（幂等）。按顺序执行。
pub const DDL_STATEMENTS: &[&str] = &[
    // —— 决策定义（草稿态；body 含 kind 标签的决策体 IR）——
    r#"CREATE TABLE IF NOT EXISTS cmx_rule_definition (
        key         VARCHAR(128) PRIMARY KEY,
        name        VARCHAR(256) NOT NULL DEFAULT '',
        version     INTEGER      NOT NULL DEFAULT 1,
        published   BOOLEAN      NOT NULL DEFAULT FALSE,
        category_code VARCHAR(128),
        body        JSONB        NOT NULL,
        created_at  TIMESTAMPTZ  NOT NULL,
        updated_at  TIMESTAMPTZ  NOT NULL
    )"#,
    // 补列（老库平滑升级；本 workspace 首个 ADD COLUMN IF NOT EXISTS）。
    "ALTER TABLE cmx_rule_definition ADD COLUMN IF NOT EXISTS category_code VARCHAR(128)",
    "CREATE INDEX IF NOT EXISTS idx_cmx_rule_definition_published ON cmx_rule_definition (published)",
    "CREATE INDEX IF NOT EXISTS idx_cmx_rule_definition_category ON cmx_rule_definition (category_code)",
    // —— 受管分类字典（决策集的「分类」；无外键，删分类不动引用它的决策集）——
    r#"CREATE TABLE IF NOT EXISTS cmx_rule_category (
        code        VARCHAR(128) PRIMARY KEY,
        name        VARCHAR(256) NOT NULL DEFAULT '',
        ord         INTEGER      NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ  NOT NULL,
        updated_at  TIMESTAMPTZ  NOT NULL
    )"#,
    // —— 不可变发布（key+version 唯一；rev = 内容哈希；body 为发布时快照）——
    r#"CREATE TABLE IF NOT EXISTS cmx_rule_release (
        id          VARCHAR(64)  PRIMARY KEY,
        key         VARCHAR(128) NOT NULL,
        version     INTEGER      NOT NULL,
        rev         VARCHAR(32)  NOT NULL,
        body        JSONB        NOT NULL,
        active      BOOLEAN      NOT NULL DEFAULT TRUE,
        published_by VARCHAR(128),
        published_at TIMESTAMPTZ NOT NULL
    )"#,
    "CREATE UNIQUE INDEX IF NOT EXISTS uk_cmx_rule_release_key_ver ON cmx_rule_release (key, version)",
    "CREATE INDEX IF NOT EXISTS idx_cmx_rule_release_key_active ON cmx_rule_release (key, active)",
    // —— 决策日志/审计（每次求值一条；trace jsonb；failure 非空=失败决策）——
    r#"CREATE TABLE IF NOT EXISTS cmx_rule_decision_log (
        id               VARCHAR(64)  PRIMARY KEY,
        decision_key     VARCHAR(128) NOT NULL,
        decision_version INTEGER      NOT NULL,
        input            JSONB        NOT NULL,
        output           JSONB        NOT NULL,
        trace            JSONB        NOT NULL,
        timing_us        BIGINT       NOT NULL DEFAULT 0,
        caller           VARCHAR(128),
        failure          TEXT,
        created_at       TIMESTAMPTZ  NOT NULL
    )"#,
    "CREATE INDEX IF NOT EXISTS idx_cmx_rule_log_key ON cmx_rule_decision_log (decision_key)",
    "CREATE INDEX IF NOT EXISTS idx_cmx_rule_log_created ON cmx_rule_decision_log (created_at)",
    "CREATE INDEX IF NOT EXISTS idx_cmx_rule_log_failure ON cmx_rule_decision_log (failure)",
    // —— 测试用例（仿真回归；input/expected jsonb）——
    r#"CREATE TABLE IF NOT EXISTS cmx_rule_test_case (
        id           VARCHAR(64)  PRIMARY KEY,
        decision_key VARCHAR(128) NOT NULL,
        name         VARCHAR(256) NOT NULL DEFAULT '',
        input        JSONB        NOT NULL,
        expected     JSONB        NOT NULL,
        created_at   TIMESTAMPTZ  NOT NULL
    )"#,
    "CREATE INDEX IF NOT EXISTS idx_cmx_rule_test_key ON cmx_rule_test_case (decision_key)",
    // —— 脚本函数库（SC3）：可复用 Rhai 函数，决策表/图/脚本决策/FEEL 皆可调；求值前注册进引擎 ——
    r#"CREATE TABLE IF NOT EXISTS cmx_rule_script_function (
        name         VARCHAR(128) PRIMARY KEY,
        params       JSONB        NOT NULL DEFAULT '[]',
        body         TEXT         NOT NULL,
        lang         VARCHAR(16)  NOT NULL DEFAULT 'rhai',
        version      INTEGER      NOT NULL DEFAULT 1,
        published    BOOLEAN      NOT NULL DEFAULT FALSE,
        description  TEXT         NOT NULL DEFAULT '',
        created_at   TIMESTAMPTZ  NOT NULL,
        updated_at   TIMESTAMPTZ  NOT NULL
    )"#,
    "CREATE INDEX IF NOT EXISTS idx_cmx_rule_scriptfn_published ON cmx_rule_script_function (published)",
];
