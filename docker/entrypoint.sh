#!/bin/sh
# kgcheckin 容器入口脚本：
# 1. 未直接提供 USERINFO 环境变量时，自动从挂载的凭据文件（USERINFO_FILE）读取；
# 2. exec 执行容器命令（默认：node scheduler.js 定时签到）。
#
# 安全说明：此处把凭据导出为环境变量，是为兼容 scheduler.js / main.js 的
# 独立运行方式（GitHub Actions 同样用环境变量）。环境变量可被同容器内的其他
# 进程读取（/proc/<pid>/environ），因此 WebUI 模式（webui/server.js）不再走该
# 路径，而是通过 stdin 把凭据传给签到子进程。
set -e

if [ -z "$USERINFO" ] && [ -n "$USERINFO_FILE" ] && [ -f "$USERINFO_FILE" ]; then
  USERINFO="$(cat "$USERINFO_FILE")"
  export USERINFO
  echo "[entrypoint] 已从 $USERINFO_FILE 读取登录凭据 (USERINFO)"
fi

exec "$@"
