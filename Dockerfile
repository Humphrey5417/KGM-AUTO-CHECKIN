# syntax=docker/dockerfile:1
# kgcheckin —— 酷狗概念版自动签到（Docker 版）
FROM node:20-alpine

ENV NODE_ENV=production \
    TZ=UTC

WORKDIR /app

# ── 根目录依赖（express、qrcode、node-cron）──
# 注意：--ignore-scripts 跳过根 package.json 的 install 生命周期脚本
# （该脚本会执行 cd api && npm ci 全量安装，Dockerfile 中改为下方显式按需安装）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# ── API 服务生产依赖（先只拷贝清单文件，充分利用构建缓存）──
COPY api/package.json api/package-lock.json ./api/
RUN cd api \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /root/.npm

# ── 业务源码 ──
COPY main.js sent.js phoneLogin.js qrcodeLogin.js scheduler.js ./
COPY utils ./utils
COPY api ./api
COPY webui ./webui

# ── 运行时目录与权限 ──
# /app/data：挂载卷（userinfo.json 凭据、二维码输出）
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R node:node /app/data

USER node

# 凭据文件与二维码输出统一放到挂载卷内
ENV USERINFO_FILE=/app/data/userinfo.json \
    QR_DIR=/app/data/qr \
    QR_KEYS_FILE=/app/data/qrkeys.json \
    WEBUI_PORT=3000

# 容器内端口规划（无需对外全部暴露）：
#   3000 WebUI 控制台（compose 按需映射）
#   3010 登录用常驻 API 服务（webui/server.js 懒启动）
#   3020 签到子进程专用 API 服务（每次签到临时拉起）
#
# 健康检查：命中 WebUI 的免鉴权 /healthz（设了 WEBUI_PASSWORD 也返回 200）。
# 用 node 内置 fetch，无需额外安装 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEBUI_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "webui/server.js"]
