# 万能网页操作 Agent

输入任意网址 → 在页面底部的 AI 面板里用自然语言下达任务 → AI 自动点击、输入、翻页、提取数据。  
底层由 [PageAgent](https://github.com/alibaba/page-agent) 驱动，全部操作发生在浏览器页面内，无需浏览器插件 / 无头浏览器 / VPN。

```
浏览器 ──打开──> http(s)://你的域名/
                 │
                 ├─ 主界面（地址栏 + iframe，AI 面板由 PageAgent 渲染在 iframe 内）
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
4. 页面底部会自动出现 AI 面板，直接输入自然语言任务即可

> 配置只存在你自己的浏览器 localStorage，服务端不保存密钥。  
> 默认预填 DeepSeek 官方（服务端代理与浏览器直连均实测可用）；ZenMux 在部分托管环境服务端出网受限，请使用「浏览器直连」通道。

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
  index.js        Express 服务：静态资源、/__pa 代理路由、兜底路由、LLM 转发
  proxy.js        代理核心：请求转发、响应头清洗、Cookie、重定向改写、HTML/CSS 重写
  rewrite.js      URL 编解码、HTML/CSS 重写规则、bridge 注入
  cookieJar.js    按浏览器会话隔离的服务端 CookieJar（tough-cookie）
  sessionState.js 会话级「最近代理目标」记忆：Referer 缺失时兜底路由据此还原目标站点
  security.js     SSRF 防护：协议白名单 + 私有网段 / DNS 二次校验
public/
  index.html      主界面
  css/app.css     样式（含窄屏响应式）
  js/app.js       设置面板、地址栏、与 iframe 通信
  js/llm-adapter.js  三种协议的请求 / 响应互转 + 连通性自检
  bridge.js       注入到被代理页面内部：反 frame 拦截、网络请求回流、驱动 PageAgent
  vendor/         PageAgent IIFE 包（本地自托管，不依赖外部 CDN）
scripts/
  smoke-test.mjs  多站点代理冒烟测试
  ui-check.mjs    UI 冒烟（设置面板 / bridge 注入 / Panel 出现）
  e2e-test.mjs    浏览器端到端测试（真实 Chrome + 真实 LLM）
  online-check.mjs 部署环境站点可达率检查
  debug-page.mjs  单站点深度诊断
  mock-llm.mjs    本地 Mock 模型服务（可控延迟，供下面三个定点回归用）
  check-stop.mjs  回归：点「停止」是否立刻中断在飞的模型请求
  check-panel-close.mjs 回归：点 Panel 的 X 之后能否把面板叫回来并继续用
  check-resume.mjs 回归：跨页面跳转后任务能否自动续跑（含超时/次数/跨站守卫）
```

## 实现要点

- **同源嵌入**：`/__pa/https/host/path` 由服务端抓取目标站点后重写输出，抹掉 `X-Frame-Options` / CSP frame-ancestors；iframe 与本应用同源，因此可以互相访问 DOM。
- **三重 URL 兜底**：① 服务端重写 HTML 属性（含无引号写法、srcset、CSS `url()`、meta refresh）；② 注入 `<base href>`，让未命中的相对路径自动落到代理；③ `bridge.js` 运行时接管 `fetch` / `XMLHttpRequest` / `sendBeacon` / `EventSource`，把动态请求改写回代理路径；服务端还有一层 Referer + 会话记忆兜底，处理 JS 动态赋值的表单 action / 绝对路径。
- **导航兜底同步**：目标站 JS 触发的同源导航（如 `location.href='/s?wd=x'`）由兜底路由 307 重定向回代理路径 —— iframe 地址栏持续同步、Referer 始终可还原；子资源请求（fetch / XHR）则直接转发，不破坏调用方。
- **反 framebusting**：iframe `sandbox` 不授予 `allow-top-navigation`，并在 bridge 里把 `window.top`/`parent` 重定向到自身，`<a target=_blank|_top>` 统一改为 `_self`；转发时同时剥离 `Sec-Fetch-Dest`，避免目标站判定「被嵌在 iframe 里」而降级。
- **登录态**：按浏览器 cookie（`pa_sid`）在服务端各自维护 CookieJar，避免目标站 Cookie 的 Domain/Path 冲突，也不会泄漏给浏览器。
- **SSRF 防护（双路由全覆盖）**：代理路由与 LLM 转发路由均只允许 http(s)，且解析 DNS 后二次校验目标 IP 不属于私有 / 保留网段；兜底路由拒绝跨站（`Sec-Fetch-Site: cross-site`）请求，避免被第三方站点当作「以用户身份请求目标站」的中继。
- **Agent 单实例**：bridge 对并发到达的配置消息做初始化去重，任何时刻最多一个 Agent / 一套遮罩，避免「双输入框、重复光标、多个动画循环」。
- **停止即断**：page-agent 传入的中止信号会一路带到真正的 `fetch` 上；此前该信号被丢弃，点「停止」后要等本次模型请求跑满超时才响应（实测 5s vs 修复后 2ms）。
- **跨页面续跑**：目标页一跳转，iframe 里的 Agent / 历史会连根销毁。bridge 把「正在执行的任务」记进 `sessionStorage`，新页面就绪后自动接着执行（最多 2 次、90 秒内有效）；只有「同站跳转」或「来源是本应用代理页」才续跑，用户在地址栏另开站点不会把旧任务套上去。
- **面板可恢复**：点 Panel 右上角的 X 会连 Agent 一起销毁（演示站靠书签重新注入，本项目没有这个入口）。顶栏新增「AI 面板」按钮，可识别已销毁的实例并重建，不必刷新页面。

## 已知限制

- **API Key 存于 localStorage**：被代理页面的 JS 与主应用同源，理论上可读取它。请只在对该站点有基本信任的前提下使用本工具；介意的话可为每次会话使用独立的、低额度的 Key。

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

三个定点回归需要一个可控延迟的本地模型服务，另开两个终端：

```bash
# 终端 1：Mock 模型（延迟 4000ms，便于在「请求在飞」时做中断/跳转实验）
MOCK_PORT=3400 MOCK_DELAY=4000 npm run mock:llm

# 终端 2：本应用（放行本机地址，Mock 走 127.0.0.1）
ALLOW_LOCALHOST=true PORT=3211 npm start

# 终端 3：三个检查（浏览器路径可用 CHROME_PATH 覆盖）
npm run check:stop      # 点停止 → 立即中断（期望 <100ms）
npm run check:panel     # 点 X → 面板消失、顶栏按钮叫回、新实例可执行
npm run check:resume    # 跳转 → 自动续跑；次数/过期/跨站三种情况不续跑
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

- 模型调用默认重试 2 次（`maxRetries`），用于自愈「工具名写错」这类幻觉；通道不可达时不会长时间挂起。
- `scriptTool`（默认开）允许 Agent 用 JS 触发回车、拖拽等只有脚本才能做的交互。
- 追求更稳的指令遵循可以换更强的模型（如 `deepseek/deepseek-v4-pro`、`gpt-5`）。

## License

MIT
