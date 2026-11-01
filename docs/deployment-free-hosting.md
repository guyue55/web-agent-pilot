# 免费托管选型与部署手册

> 适用项目：web-agent-pilot（服务端同源反代 + 页面内 Agent）
> 核实日期：2026-11-02　｜　数据来源见文末「10. 核实来源」
> 用途：① 本项目上线托管选型；② 以后新项目照此 checklist 快速选型与部署。

---

## 0. 结论速览（TL;DR）

| 场景 | 推荐平台 | 一句话理由 |
|------|----------|-----------|
| 默认首选、免绑卡、GitHub 一键部署 | **Render** | 免费 Web Service（750 实例小时/月），连仓库即部署，支持 WebSocket |
| 要求「常亮不休眠」 | **Northflank** | 免费 Sandbox 永不休眠，但**创建资源需绑卡验证** |
| 有 GCP 账号、要容器化 + 大免费额度 | **Cloud Run** | 免费额度大，支持 WS，但单连接最长 60 分钟 |
| 完全不想绑卡、能接受 48h 休眠 | **Hugging Face Spaces** | 免费 Docker Space（2vCPU/16GB），端口须 **7860**，无自定义域名 |
| ❌ 绝对不行 | GitHub Pages / Vercel / Netlify / Cloudflare / Deno Deploy | 纯静态或 Serverless，跑不了长驻 Node 与 WS upgrade |

> **核心判断**：本项目不是纯前端，`/api/resolve`、`/__pa/*` 反代、`/__paws/*` WebSocket、`/api/llm/proxy` 全部依赖**服务端运行时 + 任意出网**。任何「只托管静态文件」或「只跑函数」的平台都跑不起来。

---

## 1. 硬性要求（筛选平台的标尺）

| # | 需求 | 说明 | 不满足的后果 |
|---|------|------|-------------|
| 1 | 长驻 Node 进程 | Express 常驻，监听 `PORT`（默认 3000） | Serverless/静态平台直接不可用 |
| 2 | WebSocket 服务端 upgrade | `/__paws/*` 在 `http.Server` 上透传 | 目标站的实时功能（聊天/协作）断掉 |
| 3 | 任意出网抓取 | 服务端 fetch 目标站、重写 HTML | 代理无内容可返回 |
| 4 | 同源单服务 | 应用壳与代理必须同源（Agent 要读写 iframe DOM） | 拆前后端会跨源，Agent 失效 |
| 5 | 无需持久化 | 配置在浏览器 localStorage、会话在内存 | 临时盘/休眠无影响（本项目天然契合） |
| 6 | HTTPS | 浏览器安全上下文 + iframe 要求 | 需平台自动签发证书 |

> 内存/CPU 需求很低：镜像仅 `express + tough-cookie + undici`，512MB 足够。

---

## 2. 平台对比总表（2026-11 核实）

| 平台 | 免费额度 | 休眠 / 冷启动 | WebSocket / 长驻 | 绑卡 | GitHub 自动部署 | 自定义域名 | 适配度 |
|------|---------|--------------|-----------------|------|----------------|-----------|--------|
| **Render** | 750 实例小时/月，512MB / 0.1CPU | 15 分钟无入站流量休眠，唤醒 ~1 分钟 | ✅ 持久进程 + WS（WS 消息计入站流量，有活动连接不休眠） | 否 | ✅ 连仓库，push 即部署 | ✅ 免费支持 | ★★★★★ |
| **Northflank** | Sandbox：2 服务 + 2 任务 + 1 库，约 $20/月资源 | **不休眠** | ✅ | **是**（任何套餐创建资源都需付款方式验证） | ✅ Git / 镜像 | ✅ | ★★★★☆（要卡） |
| **Koyeb** | 1 个免费 Web 服务，512MB / 0.1vCPU | 1 小时空闲缩容到 0 | ✅ | 是（$29 预授权） | ✅ | ✅ | ★★★☆☆（要卡） |
| **Railway** | 首 30 天 $5 额度；之后 $1/月抵扣 | 不休眠 | ✅ | 否（试用） | ✅ 体验最佳 | ✅ | ★★★☆☆（额度紧，$1/月难撑 24h） |
| **Zeabur** | Free Trial：$5/月算力额度 | 空闲自动休眠 | ✅ | 否 | ✅ GitHub/Docker | ✅ | ★★★☆☆（额度烧得快） |
| **Cloud Run** | 200 万请求 + 18 万 vCPU·秒 + 36 万 GiB·秒 / 月 | 缩容到 0；`min-instances=1` 可保温（计费） | ✅ 但**单连接最长 60 分钟**（默认 5 分钟） | 需 GCP（要卡） | ✅ 源代码/容器 | ✅ | ★★★★☆（有 WS 上限） |
| **Hugging Face Spaces** | CPU basic：2vCPU / 16GB / 50GB 临时盘 | 48 小时无活动休眠，唤醒 ~30s–2min | ✅ 长驻容器 | 否 | ✅ 仓库同步，push 重建 | ❌ 免费不支持 | ★★★☆☆（端口 7860） |
| **Fly.io** | 自 2024-10 起**无免费层**，仅试用 | 试用期后停机 | ✅ | 是 | ✅ CLI/Docker | ✅ | ✗（不免费） |
| Vercel | Hobby 免费但仅 Serverless Functions | 按请求 | ❌ 不支持长驻/WS upgrade | 否 | ✅ | ✅ | ✗ |
| Netlify | 静态 + Functions | 按请求 | ❌ | 否 | ✅ | ✅ | ✗ |
| Cloudflare Pages/Workers | 静态 + 边缘函数 | 按请求 | ❌（Workers 无 WS 服务端 upgrade） | 否 | ✅ | ✅ | ✗ |
| GitHub Pages | 纯静态 | — | ❌ | 否 | ✅ | ✅ | ✗ |
| Deno Deploy | Deno 运行时 | 按请求 | ❌（非本 Node 服务） | 否 | ✅ | ✅ | ✗ |
| Glitch | 已于 2025-07 停止托管应用 | — | — | — | — | — | ✗（已停服） |
| Heroku | 免费层 2022-11 已取消 | — | — | — | — | — | ✗（无免费） |

---

## 3. 明确排除说明（为什么这些平台不行）

- **GitHub Pages / 纯静态托管**：只发文件，不执行服务端代码。`/api/resolve` 直接 404，代理与 WS 全部失效。
- **Vercel / Netlify / Cloudflare Workers**：模型是「按请求执行的函数」，没有常驻进程、没有 `http.Server` 的 `upgrade` 事件，WebSocket 隧道无法建立；本项目 512MB 常驻内存语义也对不上。
- **Fly.io**：自 2024-10 取消免费层，只剩短期试用，不再算「免费」。
- **Glitch / Heroku 免费层**：均已停止/取消，不要再用旧教程。

---

## 4. 推荐方案（按场景）

### 方案 A（默认）：Render —— 免绑卡、GitHub 一键部署
- **适合**：演示、个人项目、低流量生产。
- **代价**：15 分钟无入站流量休眠，首次访问冷启动 ~1 分钟；**服务主动出网过多可能被判滥用而暂停**（见 §7.1，本项目务必注意）。
- **步骤**：见 §5.1（Blueprint，最快）或 §5.2（手动）。

### 方案 B：Northflank —— 要「常亮」
- **适合**：需要随时秒开、可接受绑卡验证。
- **代价**：创建资源必须绑付款方式（仅验证，Sandbox 免费）；免费算力较小。
- **步骤**：app.northflank.com 注册 → 加付款方式 → 建 Project → 建 Service → 连 GitHub 仓库，Build `npm ci --omit=dev`、Run `npm start`、端口用注入的 `PORT`。

### 方案 C：Cloud Run —— 容器化 + 大额度
- **适合**：有 GCP 账号、想用 Docker 镜像、流量较大。
- **代价**：WS 单连接最长 60 分钟，需设请求超时；缩容到 0 有冷启动（可 `--min-instances=1`，但计费）。
- **步骤**：见 §5.5。

### 方案 D：Hugging Face Spaces —— 完全不绑卡
- **适合**：只想白嫖、能接受 48h 休眠、不介意无自定义域名。
- **代价**：**只能用 7860 端口**；免费无自定义域名；私有 Space 需登录查看。
- **步骤**：见 §5.4。

---

## 5. 部署步骤详解

### 5.1 Render Blueprint（推荐，一键）
仓库根目录已带 `render.yaml`。步骤：

1. 登录 [Render Dashboard](https://dashboard.render.com) → **New → Blueprint**。
2. 选 GitHub 仓库 `guyue55/web-agent-pilot`，分支 `master`。
3. Render 读取 `render.yaml`，自动建 **free** Web Service（`npm ci --omit=dev` → `npm start`，健康检查 `/api/health`）。
4. 首次构建 3–10 分钟；完成得 `https://<name>.onrender.com`。
5. 之后每次 push 到 `master` 自动重新部署。

> 关键：`plan: free` 必须显式写，否则默认落到付费套餐 `0.5c-512mb`。

### 5.2 Render 手动（不用 Blueprint）
New → **Web Service** → 连仓库，填：
- Runtime：`Node`
- Build Command：`npm ci --omit=dev`
- Start Command：`npm start`
- Instance Type：**Free**
- Health Check Path：`/api/health`
- 环境变量：`NODE_VERSION=22`（可选，`.nvmrc` 已声明 22）、`ALLOW_LOCALHOST=false`

### 5.3 通用 Docker（任何支持容器的平台）
仓库自带 `Dockerfile`（非 root、只装生产依赖、`HEALTHCHECK /api/health`）：

```bash
docker build -t web-agent-pilot .
docker run -d --name web-agent-pilot -p 3000:3000 web-agent-pilot
# 或
docker compose up -d
```

平台侧只需：构建仓库根 `Dockerfile`，容器端口读 `PORT`（平台注入），健康检查路径 `/api/health`。

### 5.4 Hugging Face Spaces（Docker，端口 7860）
1. huggingface.co → New Space → SDK 选 **Docker** → Hardware **CPU basic (free)** → Public。
2. Settings → Repository sync → 关联 GitHub 仓库，push 自动重建。
3. Space 的 `README.md` 顶部加 frontmatter（**必须**）：

```yaml
---
title: web-agent-pilot
sdk: docker
app_port: 7860
---
```

4. Space 的 Variables 里设 **`PORT=7860`**（本项目读 `process.env.PORT`，HF 只暴露 7860）。
5. 访问 `https://<user>-<space>.hf.space`。

> 注意：HF 免费无自定义域名；私有 Space 需 HF 登录；48h 无活动休眠。

### 5.5 Cloud Run（容器）
```bash
gcloud run deploy web-agent-pilot \
  --source . --region asia-east1 --allow-unauthenticated \
  --port 3000 --timeout 3600 --session-affinity
```
- `--timeout 3600`：把 WS 连接上限提到 60 分钟（默认仅 5 分钟）。
- 无需数据库；`--allow-unauthenticated` 对外公开。

---

## 6. 部署后验证清单（可直接复制）

> 以下命令已在本机容器实测通过（2026-11-02）。

```bash
BASE=https://<你的域名>

# 1) 健康检查 —— 期望 {"ok":true,...}
curl -s $BASE/api/health

# 2) 首页 —— 期望 HTTP 200，约 10KB
curl -s -o /dev/null -w 'HTTP=%{http_code} bytes=%{size_download}\n' $BASE/

# 3) SSRF 防护 —— 解析 localhost 应被拒（HTTP 400）
U=$(printf 'http://127.0.0.1:9999' | base64 | tr '+/' '-_' | tr -d '=')
curl -s -w '\nHTTP=%{http_code}\n' "$BASE/api/resolve?u=$U"

# 4) 正常解析 —— 期望 HTTP 200 + proxyUrl
U2=$(printf 'https://example.com' | base64 | tr '+/' '-_' | tr -d '=')
curl -s -w '\nHTTP=%{http_code}\n' "$BASE/api/resolve?u=$U2"

# 5) 真实代理抓取 —— 期望 HTTP 200，HTML 内含 path-shim.js / <base href="/__pa/...">
curl -s "$BASE/__pa/https/example.com/" | head -c 200
```

**浏览器端**：打开首页 → 输入网址 → 页面被嵌入 → 配置模型 → 让 Agent 点一下按钮。

> 冷启动平台（Render 免费 / HF）：**第一次请求会慢 ~1 分钟**，属正常，不是故障。

---

## 7. 本项目专属坑（上线前必读）

### 7.1 Render「服务主动出网」阈值 —— 本项目最大风险 ⚠️
Render 官方明确：免费 Web Service **若主动发起异常大量的公网流量（调用外部 API、传输数据等），可能被暂停**。而本项目的**代理本职就是大量出网抓取**，因此：
- 低流量演示没问题；**高并发/大流量代理使用可能触发暂停**。
- 需要稳定大量代理时，优先 **Northflank（常亮）** 或 **Cloud Run / VPS**，别硬扛 Render 免费层。

### 7.2 休眠与 WebSocket
- Render：15 分钟无**入站**流量即休眠；**WebSocket 消息也算入站流量**，所以有活跃 WS 连接时不会休眠。
- 但纯浏览（无 WS）页面闲置 15 分钟仍会休眠，下次访问冷启动 ~1 分钟。

### 7.3 数据中心 IP 反爬
所有云平台出口都是机房 IP：**Cloudflare 五秒盾 / 指纹校验类站点仍会被挡**——这是本项目 README 已写明的既有边界，换平台不改变。可先用 `scripts/online-check.mjs` 测目标站可达率。

### 7.4 端口与平台限制
- 平台通过环境变量注入 `PORT`，本项目已读 `process.env.PORT`，无需改代码。
- Render 免费实例**不能绑定保留端口** `18012/18013/19099`；SMTP 端口 `25/465/587` 被禁（本项目用不到）。
- HF Spaces **只能 7860**。

### 7.5 内存与临时盘
- 免费档普遍 512MB：本项目够用。
- 文件系统临时（重部署/休眠即清空）：本项目**无需持久化**（配置在浏览器、会话在内存），不受影响。
- Cloud Run 的 WS 单连接 60 分钟上限：目标站自身通常会重连；若发现异常可调大 `--timeout`。

---

## 8. 复用到新项目（通用 checklist）

1. **先判定是否需要服务端**：有没有代理 / 数据库 / 密钥保管 / 长连接？有 → 必须常驻运行时；纯静态才考虑 Pages/Vercel/Netlify。
2. **列硬性要求**（§1 那张表）：运行时、出网、WS、持久化、内存。
3. **按 §2 表选平台**：默认 Render；要常亮 Northflank；要额度 Cloud Run；要零绑卡 HF。
4. **加部署描述文件**：Node → `render.yaml`；容器 → `Dockerfile`；HF → README frontmatter + `PORT=7860`。
5. **本地先验**：`docker build` → `docker run` → 跑 §6 验证清单（别等上线才发现构建失败）。
6. **上线后复跑 §6**，并观察首日冷启动/内存/出网是否触发平台限制。
7. **记录到本文件**：新增平台或额度变化时更新 §2 表格与核实日期。

---

## 9. 配置文件模板

**`render.yaml`（仓库根，已提供）**
```yaml
services:
  - type: web
    name: web-agent-pilot
    runtime: node
    plan: free
    buildCommand: npm ci --omit=dev
    startCommand: npm start
    healthCheckPath: /api/health
    envVars:
      - key: NODE_VERSION
        value: "22"
      - key: ALLOW_LOCALHOST
        value: "false"
```

**`Dockerfile` 要点（仓库已有）**：`node:22-slim`、非 root 用户、`npm ci --omit=dev`、`HEALTHCHECK` 打 `/api/health`、`EXPOSE` 后由 `PORT` 决定监听。

---

## 10. 核实来源（2026-11-02）

| 平台 | 来源 |
|------|------|
| Render | 官方 https://render.com/docs/free 、https://render.com/docs/blueprint-spec |
| Northflank | 官方 https://northflank.com/pricing （Sandbox：2 服务/2 任务/1 库、永不睡眠、需付款方式） |
| Cloud Run | 官方 https://cloud.google.com/run/docs/triggering/websockets （WS 支持、超时默认 5 分钟/最长 60 分钟） |
| Hugging Face Spaces | 社区部署文档（Docker SDK、端口 7860、48h 休眠、免费无自定义域名） |
| Koyeb / Railway / Zeabur / Fly.io | 2026 免费额度横向评测（snapdeploy.dev、hostgage.com 等），细节以各平台控制台为准 |

> 免费额度/条款变动频繁，**上线前请以平台控制台当日显示为准**；本文件会在变更时更新。

---

## 附：本机实证记录（2026-11-02）

| 检查项 | 结果 |
|--------|------|
| `docker build` | 成功（node:22-slim，非 root） |
| 容器 `/api/health` | `200 {"ok":true,"node":"v22.23.4"}` |
| 首页 | `200`，10281 字节 |
| SSRF 拦截 localhost | `400`「禁止代理内网 / 本机地址」 |
| 解析 example.com | `200`，返回 proxyUrl |
| 真实代理抓取 example.com | `200`，注入 `path-shim.js` / `<base href="/__pa/https/example.com/">` |
| 容器 HEALTHCHECK | `healthy` |
| 项目语法自检 | 42 个文件全部通过 |
