# ============================================================
# 运行时镜像：仅含运行所需内容（不含 scripts/ 与 devDependencies）
# ============================================================
FROM node:22-slim

# 运行期依赖 openssl 仅用于生成证书等场景，这里不需要，保持镜像最小
LABEL org.opencontainers.image.title="web-agent-pilot" \
      org.opencontainers.image.description="任意网页的 AI 操作 Agent：服务端同源反代嵌入任意站点，页面内 Agent 自动点击、输入、翻页、提取数据" \
      org.opencontainers.image.source="https://github.com/guyue55/web-agent-pilot" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    # Node 22 起官方建议显式设置，避免容器内时区/ICU 差异带来的告警
    NODE_OPTIONS="--no-warnings"

WORKDIR /app

# 先只复制清单文件：源码变动时不会让依赖层缓存失效
COPY package.json package-lock.json ./
# --omit=dev：镜像里不需要 playwright-core 等仅测试用的依赖
# --ignore-scripts：本项目的依赖无原生构建步骤，避免执行不受控的安装脚本
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

COPY server/ ./server/
COPY public/ ./public/
COPY README.md LICENSE ./

# 以非 root 用户运行：node 官方镜像已内置 uid/gid 1000 的 node 用户
USER node

EXPOSE 3000

# 健康检查：/api/health 由应用自带，无需额外装 curl / wget
# start-period 给首次冷启动（依赖加载）留出缓冲
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
