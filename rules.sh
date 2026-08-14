#!/usr/bin/env bash
#
# 启动决策规则引擎微服务（MEGA Rules · :8094）。
#
# 统一启动契约（门户/流程/报表/主数据/规则各服务同一套）：
#   1) cd 到本 workspace 根（.env / *-server.toml 的相对路径基准）
#   2) cargo run 对应 bin（bin 自动读 .env → 配置生效，无需手动 source）
#
# 用法：
#   ./rules.sh                # 开发模式（debug，增量编译，改代码自动重编）
#   ./rules.sh --release      # 发布模式（透传给 cargo run）
#   ./rules.sh --offline      # 离线模式（无网时用本地缓存；透传给 cargo run）
#
# 依赖：PostgreSQL（fico 库，含 cmx_rule_* 决策定义/发布/日志/测试表，首启自动建）。
# 起后访问：
#   http://127.0.0.1:8094/                        决策引擎监控大盘
#   http://127.0.0.1:8094/api/rules/v1/stats      引擎聚合
#   http://127.0.0.1:8094/api/rules/v1/definitions 决策定义列表
#   http://127.0.0.1:8094/_mon                    技术监控
set -euo pipefail
cd "$(dirname "$0")"
exec cargo run -p cmx-rule-server "$@"
