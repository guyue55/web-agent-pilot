# 万能网页操作 Agent

输入任意网址 → 在右下角用自然语言下达任务 → AI 自动点击、输入、翻页、提取数据。  
底层由 [PageAgent](https://github.com/alibaba/page-agent) 驱动，全部操作发生在浏览器页面内，无需浏览器插件 / 无头浏览器 / VPN。

```
浏览器 ──打开──> http(s)://你的域名/
                 │
                 ├─ 主界面（地址栏 + iframe + 右下角悬浮助手）
                 │
                 └─ /__pa/<scheme>/<host>/<path>  ← 服务端反向代理（同源嵌入的关键）
                           │
                           └─> 目标网站（移除 X-Frame-Options / CSP、重写资源链接、维护 Cookie）
```

## 为什么必须有服务端（不能纯静态）

浏览器 Appendix 的 `X-Frame-Options` / `Content-Security-Policy: frame-ancestors` 由**浏览器自身**强制执行，  
任何前端 JS、iframe 属性都无法绕过 —— 唯一可行的方式是把目标站点的内容从**我们自己的域**重新吐出来，也就是服务端反向代理。  
所以本项目是「前端静态 + 一个极简 Node 服务」的组合：

| 能力                     | 静态托管能否做到                           |
| ---------------------- | ---------------------------------- |
| 任意站点嵌入（绕过 frame 拦截）    | ❌ 必须服务端代理                          |
| 页面内资源 / 表单 / XHR 回流    | ❌ 需要服务端重写与兜底路由                     |
| 登录态保持                  | ❌ 需要服务端 CookieJar                  |
| 大模型配置存浏览器 localStorage | ✅ 纯前端                              |
| 浏览器直连大模型 API           | ✅ 取决于服务商 CORS（本项目默认走服务端转发，规避 CORS） |

## 快速开始

```bash
npm install
npm start                 # 默认 http://localhost:3000
PORT=8080 npm start       # 自定义端口
ALLOW_LOCALHOST=true npm start   # 需要代理本机 / 内网站点时
```

1. 打开 `http://localhost:3000`
2. 点右上角齿轮，配置大模型（协议 / Base URL / 模型 / API Key），可点「测试连接」自检
3. 地址栏输入目标网址，回车
4. 点右下角图标展开助手，用自然语言下达任务

> 配置只存在你自己的浏览器 localStorage，服务端不保存密钥。

## 支持的大模型协议

PageAgent 原生只用 OpenAI Chat Completions 协议；本项目在它的 `customFetch` 钩子里做了一层 **协议翻译**，因此三种协议都能直接驱动：

| 协议                 | 端点                           | 说明                                                              |
| ------------------ | ---------------------------- | --------------------------------------------------------------- |
| OpenAI · Chat      | `{baseURL}/chat/completions` | 兼容 OpenAI 及所有兼容厂商（DeepSeek、通义、硅基流动…）                            |
| OpenAI · Responses | `{baseURL}/responses`        | 新版 Responses API，`input` / `function_call` 已与 chat 协议互转         |
| Anthropic          | `{baseURL}/messages`         | `x-api-key` + `anthropic-version`，`tool_use` ⇄ `tool_calls` 已互转 |

推荐配置示例（ZenMux + DeepSeek V4 Flash）：

| 协议                      | Base URL                             | 模型                           |
| ----------------------- | ------------------------------------ | ---------------------------- |
| OpenAI Chat / Responses | `https://zenmux.ai/api/v1`           | `deepseek/deepseek-v4-flash` |
| Anthropic               | `https://zenmux.ai/api/anthropic/v1` | `deepseek/deepseek-v4-flash` |

> GUI Agent 强依赖 **function calling**，请务必选支持工具调用的模型。

## 目录结构

```
server/
  index.js        Express 服务：静态资源、/__pa 代理路由、Referer 兜底路由、LLM 转发
  proxy.js        代理核心：请求转发、响应头清洗、Cookie、重定向改写、HTML/CSS 重写
  rewrite.js      URL 编解码、HTML/CSS 重写规则、bridge 注入
  cookieJar.js    按浏览器会话隔离的服务端 CookieJar（tough-cookie）
  security.js     SSRF 防护：协议白名单 + 私有网段 / DNS 二次校验
public/
  index.html      主界面
  css/app.css     样式
  js/app.js       悬浮助手、设置面板、地址栏、与 iframe 通信
  js/llm-adapter.js  三种协议的请求 / 响应互转 + 连通性自检
  bridge.js       注入到被代理页面内部：反 frame 拦截、网络请求回流、驱动 PageAgent
  vendor/         PageAgent IIFE 包（本地自托管，不依赖外部 CDN）
scripts/
  smoke-test.mjs  多站点代理冒烟测试
  e2e-test.mjs    浏览器端到端测试（真实 Chrome + 真实 LLM）
  debug-page.mjs  单站点深度诊断
```

## 实现要点

- **同源嵌入**：`/__pa/https/host/path` 由服务端抓取目标站点后重写输出，抹掉 `X-Frame-Options` / CSP frame-ancestors；iframe 与本应用同源，因此可以互相访问 DOM。
- **三重 URL 兜底**：① 服务端重写 HTML 属性（含无引号写法、srcset、CSS `url()`、meta refresh）；② 注入 `<base href>`，让未命中的相对路径自动落到代理；③ `bridge.js` 运行时接管 `fetch` / `XMLHttpRequest` / `sendBeacon` / `EventSource`，把动态请求改写回代理路径；服务端还有一层 Referer 兜底，处理 JS 动态赋值的表单 action / 绝对路径。
- **反 framebusting**：iframe `sandbox` 不授予 `allow-top-navigation`，并在 bridge 里把 `window.top`/`parent` 重定向到自身，`<a target=_blank|_top>` 统一改为 `_self`。
- **登录态**：按浏览器 cookie（`pa_sid`）在服务端各自维护 CookieJar，避免目标站 Cookie 的 Domain/Path 冲突，也不会泄漏给浏览器。
- **跨导航续跑**：Agent 执行过程中页面发生跳转时，新页面的 bridge 就绪后会自动带上原任务继续执行（最多 2 次），避免「点了搜索就中断」。
- **SSRF 防护**：仅允许 http(s)，解析 DNS 后再次校验目标 IP 不属于私有 / 保留网段。

## 已知限制

- 服务端抓取目标是「无浏览器」的 HTTP 请求，因此 Cloudflare 五秒盾、人机验证码、**浏览器指纹校验**类站点（如 stackoverflow.com）无法通过；这不是本项目能解决的问题，需要真实浏览器方案。
- WebSocket 暂未做服务端代理，相关功能（实时聊天、推送）在被代理页面中不可用。
- 部分站点会对数据中心出口 IP 限流（例如 Wikimedia 的 429）。
- 页面若注入 `<script>` 时目标站已 CSP 严格限制，可能出现资源加载不全（HTTP 层已尽量剥离限制，但 HTML `<meta http-equiv=Content-Security-Policy>` 由服务端重写处理不到时会残留）。
- 请遵守目标站点的服务条款，不要用它做未经授权的自动化操作。

## 环境变量

| 变量                 | 默认      | 说明              |
| ------------------ | ------- | --------------- |
| `PORT`             | `3000`  | 监听端口            |
| `ALLOW_LOCALHOST`  | `false` | 是否允许代理本机 / 内网地址 |
| `PROXY_TIMEOUT_MS` | `45000` | 单请求代理超时         |
| `DEBUG_LLM`        | 关闭      | 打印 LLM 转发日志     |
| `DEBUG_PROXY`      | 关闭      | 打印代理细节          |

## 测试

```bash
node scripts/smoke-test.mjs          # 代理层多站点冒烟（需先 npm start）
BASE=http://localhost:3000 node scripts/smoke-test.mjs

node scripts/e2e-test.mjs openai-chat        # 浏览器端到端（需 Chrome + API Key）
PA_TEST_KEY=sk-xxx PROTOCOL=anthropic node scripts/e2e-test.mjs
CASES='[{"target":"https://www.bing.com","task":"搜索 deepseek v4"}]' node scripts/e2e-test.mjs

BASE=https://<域名> SHARECODE=xxx node scripts/online-check.mjs   # 检查部署环境的站点可达率
```

## 部署

服务只用到 `express` + `tough-cookie`，监听 `PORT`，因此可以丢到任何 Node 主机上：

```bash
npm ci && NODE_ENV=production PORT=3000 npm start
```

> **出网能力决定可用率**：代理是服务端抓取目标站点，所以部署机器必须能访问外网。  
> 本地 / 自有服务器通常可访问所有站点；托管沙箱类环境可能对部分域名限制出网  
> （可用 `scripts/online-check.mjs` 先测一遍）。

## 调优小贴士

- 默认会给 LLM 4 次重试（`maxRetries`），用于自愈「工具名写错」这类幻觉。
- `scriptTool`（默认开）允许 Agent 用 JS 触发回车、拖拽等只有脚本才能做的交互。
- 追求更稳的指令遵循可以换更强的模型（如 `deepseek/deepseek-v4-pro`、`gpt-5`）。

## License

MIT
