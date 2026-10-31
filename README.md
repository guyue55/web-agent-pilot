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
  security.js     SSRF 防护：协议白名单 + 私有网段 + 建连时校验实际 IP（safeLookup）
public/
  index.html      主界面
  css/app.css     样式（含窄屏响应式）
  js/app.js       设置面板、地址栏、与 iframe 通信
  js/llm-adapter.js  三种协议的请求 / 响应互转 + 连通性自检
  bridge.js       注入到被代理页面内部：反 frame 拦截、网络请求回流、驱动 PageAgent
  path-shim.js    注入到页面最前面：把 location.pathname 还原成目标站真实路径（前端路由据此匹配）
  storage-shim.js 注入到页面最前面：localStorage / sessionStorage / IndexedDB / document.cookie 按站点隔离
  vendor/         PageAgent IIFE 包（本地自托管，不依赖外部 CDN）
scripts/
  smoke-test.mjs  多站点代理冒烟测试
  ui-check.mjs    UI 冒烟（设置面板 / bridge 注入 / Panel 出现）
  e2e-test.mjs    浏览器端到端测试（真实 Chrome + 真实 LLM）
  online-check.mjs 部署环境站点可达率检查
  debug-page.mjs  单站点深度诊断
  mock-llm.mjs    本地 Mock 模型服务（可控延迟，供下面几个定点回归用）
  check-stop.mjs  回归：点「停止」是否立刻中断在飞的模型请求
  check-panel-close.mjs 回归：点 Panel 的 X 之后能否把面板叫回来并继续用
  check-resume.mjs 回归：跨页面跳转后任务能否自动续跑（含超时/次数/跨站守卫）
  check-nav-loop.mjs 回归：目标站反复自我重定向时能否被拦下且不误伤正常站点
  check-ws.mjs   回归：WebSocket 隧道是否端到端可用
  check-proxy-timeout.mjs 回归：目标站太慢/连不上时的超时、重试与落地页
  check-storage.mjs 回归：按站点隔离（含 cookie、clear() 互删、storage 事件、续跑键共享）
  check-storage-fidelity.mjs 回归：shim 开/关两组对照，确认没把原生存储语义改坏
  check-rebind.mjs 回归：DNS rebinding 打不穿 HTTP / WS（自带替身 DNS 与内网受害者）
  check-spa-route.mjs 回归：纯前端站点（skillhub）的路径还原、站内页、刷新回跳
  check-real-sites.mjs 回归：多个真实站点与上一版基线逐站对比（自带基线服务生命周期）
  measure-panel-css.mjs 测量：目标站 CSS 对 Panel 的污染（与干净页逐属性对比）
  fixtures/      测试夹具：敌意样式页、WebSocket 测试页、回显服务、静态服务
```

`server/wsProxy.js` 是 WebSocket 隧道，`server/sessionState.js` 记会话的最近代理目标。

## 实现要点

- **同源嵌入**：`/__pa/https/host/path` 由服务端抓取目标站点后重写输出，抹掉 `X-Frame-Options` / CSP frame-ancestors；iframe 与本应用同源，因此可以互相访问 DOM。
- **三重 URL 兜底**：① 服务端重写 HTML 属性（含无引号写法、srcset、CSS `url()`、meta refresh）；② 注入 `<base href>`，让未命中的相对路径自动落到代理；③ `bridge.js` 运行时接管 `fetch` / `XMLHttpRequest` / `sendBeacon` / `EventSource`，把动态请求改写回代理路径；服务端还有一层 Referer + 会话记忆兜底，处理 JS 动态赋值的表单 action / 绝对路径。
- **导航兜底同步**：目标站 JS 触发的同源导航（如 `location.href='/s?wd=x'`）由兜底路由 307 重定向回代理路径 —— iframe 地址栏持续同步、Referer 始终可还原；子资源请求（fetch / XHR）则直接转发，不破坏调用方。
- **反 framebusting**：iframe `sandbox` 不授予 `allow-top-navigation`，并在 bridge 里把 `window.top`/`parent` 重定向到自身，`<a target=_blank|_top>` 统一改为 `_self`；转发时同时剥离 `Sec-Fetch-Dest`，避免目标站判定「被嵌在 iframe 里」而降级。
- **登录态**：按浏览器 cookie（`pa_sid`）在服务端各自维护 CookieJar，避免目标站 Cookie 的 Domain/Path 冲突，也不会泄漏给浏览器。
- **页面 JS 写的 cookie 也按站点隔离**：目标站脚本用 `document.cookie` 写下的 cookie 会落进代理源（所有站共用），不加处理时 A 站写的 token B 站能直接读到、同名还会互相覆盖（实测）。shim 给 cookie 名加 `pa_<目标站 origin base64>_` 前缀，`document.cookie` 与 Cookie Store API（`cookieStore.get/getAll/set/delete`）的读写都按前缀拆装；`domain` 属性会被丢弃（代理源下无意义，还会让浏览器整条拒写），`path` / `max-age` / `expires` / `SameSite` 等照常生效。这些 cookie 只存在于浏览器侧，发往目标站的 `Cookie` 头始终来自服务端 CookieJar，因此不影响目标站登录态。
- **存储按站点隔离**：所有代理页都落在同一个源，浏览器只按源隔离存储 —— 实测 A 站写的 `localStorage` 会被 B 站读到，B 站一次 `clear()` 还会把 A 站的数据抹掉，IndexedDB 同理。`/_app/storage-shim.js` 在页面第一个脚本位置接管 `localStorage` / `sessionStorage`（key 加 `${目标站 origin}$` 前缀）与 `indexedDB.open/deleteDatabase/databases`（库名加前缀），`length` / `key()` / `Object.keys` / `clear()` / 属性式访问 / `storage` 事件全部按本站过滤。主应用自己的键（`pa.pendingTask`、`pa.navLoop`）刻意**不加**前缀，保留跨站共享语义，否则「跳转后接着跑」会断。注意这是**正确性**层面的隔离，不是安全边界（同源文档仍可拿到原始存储 / 原始 cookie）。
- **SSRF 防护（双路由全覆盖 + 建连时校验）**：代理路由与 LLM 转发路由均只允许 http(s)，解析 DNS 后校验目标 IP 不属于私有 / 保留网段；兜底路由拒绝跨站（`Sec-Fetch-Site: cross-site`）请求，避免被第三方站点当作「以用户身份请求目标站」的中继。**关键是建连那一刻再校验一次**：预检解析与 `undici` / `net.connect` 真正建连时的解析是两次独立查询，只信预检等于给 DNS rebinding 留门（实测域名第一次答公网、第二次答 `127.0.0.1` 就能读出内网数据），因此 HTTP 走 `Agent.connect.lookup`、WS 走 `net/tls.connect({ lookup })`，统一由 `security.safeLookup` 校验实际要连的 IP，且被拦截的请求**不会**再回退到出口代理重试。
- **响应头清洗**：除 `X-Frame-Options` / CSP / HSTS / COOP / COEP / CORP / `clear-site-data` 外，也删掉 `alt-svc` —— 否则目标站的「支持 HTTP/3」声明会指向我们的源（`h3=":443"`），语义错位。
- **Agent 单实例**：bridge 对并发到达的配置消息做初始化去重，任何时刻最多一个 Agent / 一套遮罩，避免「双输入框、重复光标、多个动画循环」。
- **浮层隔离**：目标站若在 `body`/`html` 上用 `transform`/`filter`/`contain`，会成为 `position: fixed` 的包含块 —— 实测面板距视图底部从 100px 变成 519px、光标遮罩同样被带偏（指向错误元素）。bridge 把 Panel 与 SimulatorMask 收拢到 `<html>` 下的 `#pa-overlay-root`（不建立包含块、显式声明可继承属性），定位与排版恢复稳定。
- **WebSocket 隧道**：`/__paws/<scheme>/<host>/<path>` 在 `http.Server` 的 `upgrade` 事件里把客户端与目标站双向透传（不做帧解析），permessage-deflate、子协议、二进制帧端到端保持原样；与原 HTTP 代理共用同一套 SSRF 校验。`Sec-WebSocket-Key` 原样透传，`Origin` 改写为目标站自身源，Cookie 从会话 CookieJar 补发。
- **导航死循环保护**：个别站点在不属于自己的域名下会反复自我跳转（实测知乎 `/signin`：直连 1 次即停，经代理 5 秒内 20 次），面板被反复冲掉、Agent 每次重建。bridge 统计同一地址 8 秒内的加载次数，达到 5 次即停止创建 Agent 并通知宿主，由宿主断开 iframe 并展示说明卡片（可「在新标签页打开原站」或「仍然继续」）。
- **停止即断**：page-agent 传入的中止信号会一路带到真正的 `fetch` 上；此前该信号被丢弃，点「停止」后要等本次模型请求跑满超时才响应（实测 5s vs 修复后 2ms）。
- **跨页面续跑**：目标页一跳转，iframe 里的 Agent / 历史会连根销毁。bridge 把「正在执行的任务」记进 `sessionStorage`，新页面就绪后自动接着执行（最多 2 次、90 秒内有效）；只有「同站跳转」或「来源是本应用代理页」才续跑，用户在地址栏另开站点不会把旧任务套上去。
- **面板可恢复**：点 Panel 右上角的 X 会连 Agent 一起销毁（演示站靠书签重新注入，本项目没有这个入口）。顶栏新增「AI 面板」按钮，可识别已销毁的实例并重建，不必刷新页面。
- **目标站不可用时的落地页**：此前只 `send` 一行纯文本（`目标站点响应超时（>45000ms）`），在 iframe 里既没样式也没有可操作项。现在返回一张说明卡片：区分「太慢」与「连不上」、点出目标站点、给出重试按钮与「在新标签页打开原站」。同时把错误信息摊平到最内层原因（undici 双栈下连接失败是 `AggregateError`，只看 `cause.code` 会退化成 `fetch failed`），并保留错误码便于排查。
- **超时与重试的时序约束**：`PROXY_TIMEOUT_MS` 必须大于 `CONNECT_TIMEOUT_MS × (重试次数 + 1)` —— 否则整体计时器会先掐断重试，把连接超时调大完全不起作用。整体超时不重试（两次跑满会让用户干等双倍时长），只有连接层失败才重试一次。

## 已知限制

- **API Key 存于 localStorage**：被代理页面的 JS 与主应用同源，理论上可读取它。请只在对该站点有基本信任的前提下使用本工具；介意的话可为每次会话使用独立的、低额度的 Key。存储与 cookie 隔离只解决「不同站点之间互相串数据」，**不改变**这一点 —— 页面仍可用 `src` 为空的同源 iframe / `srcdoc` 拿到未加前缀的原始存储和 cookie（实测可读出）。

- 服务端抓取目标是「无浏览器」的 HTTP 请求，因此 Cloudflare 五秒盾、人机验证码、**浏览器指纹校验**类站点（如 stackoverflow.com）无法通过；这不是本项目能解决的问题，需要真实浏览器方案。
- **会校验域名的站点**：少数站点发现 `location.hostname` 不是自己时会在页面里反复自我跳转（实测知乎 `/signin`）。这类行为在客户端，代理层无法修正；已做「导航死循环保护」，到阈值后断开并提示改用新标签页打开。
- **`!important` 的全局元素样式仍可能影响面板控件**：目标站若写 `button { background: red !important }`，它会压过 Panel 的类选择器样式（本项目已把定位、字体继承、字距/大小写等隔离掉，但控件外观无法在不引入 Shadow DOM 的前提下完全隔离）。实测淘宝/知乎等主流站点无可见影响；极端样式的站点可能让面板「变丑」，功能不受影响。
- 部分站点会对数据中心出口 IP 限流（例如 Wikimedia 的 429）。
- 页面若注入 `<script>` 时目标站已 CSP 严格限制，可能出现资源加载不全（HTTP 层已尽量剥离限制，但 HTML `<meta http-equiv=Content-Security-Policy>` 由服务端重写处理不到时会残留）。
- 请遵守目标站点的服务条款，不要用它做未经授权的自动化操作。

## 环境变量

| 变量                 | 默认      | 说明              |
| ------------------ | ------- | --------------- |
| `PORT`             | `3000`  | 监听端口            |
| `ALLOW_LOCALHOST`  | `false` | 是否允许代理本机 / 内网地址 |
| `PROXY_TIMEOUT_MS` | `70000` | 单请求代理超时（需大于 `CONNECT_TIMEOUT_MS × (重试次数+1)`） |
| `CONNECT_TIMEOUT_MS` | `30000` | 与目标站建连超时       |
| `WS_CONNECT_TIMEOUT_MS` | `15000` | WebSocket 隧道建连超时 |
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

浮层隔离、导航死循环、WebSocket 这三项还需要夹具服务：

```bash
npm run fixtures        # 3500：敌意样式页 + WS 测试页 + fast / slow-once / hang
npm run mock:ws         # 3501：WebSocket 回显

npm run check:ws        # WS 隧道是否端到端可用（含静态常量完整性）
npm run check:nav-loop  # 知乎类「自我重定向」站点被拦下，正常站不误伤

npm run check:storage   # 按站点隔离：LS/SS/IDB/cookie 不串味、clear() 不互删、续跑键仍共享
npm run check:fidelity  # 语义保真：shim 开/关两组跑同一段操作，确认没把原生行为改坏
npm run check:rebind    # DNS rebinding 打不穿 HTTP 与 WS 两条路径（脚本自带替身 DNS）
npm run check:dns       # 目标站解析：DoH 优先 / 连不上回退系统解析 / fake-ip 环境放行
npm run check:alias     # 模型把 execute_javascript 写成 script 时不会整轮报废
npm run check:forward-headers  # 转发给目标站的头里不能混进 x-forwarded-* / via / cdn-loop 等代理链元信息
```

# 测量目标站 CSS 对 Panel 的污染（默认对比 example / 淘宝 / 知乎 / 必应）
BASE=http://127.0.0.1:3211 npm run measure:css
TARGETS="https://example.com,http://127.0.0.1:3500/hostile-css.html" BASE=http://127.0.0.1:3211 npm run measure:css
```

代理超时与落地页的回归要**另起一个实例**（把超时调小才验证得动），并清掉环境的代理变量 ——
否则 `paFetch` 会回退到 `HTTP_PROXY`，把「连不上」的真实错误盖成 `HTTP Tunneling` 失败：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  PORT=3214 ALLOW_LOCALHOST=true PROXY_TIMEOUT_MS=1200 PROXY_RETRY=1 CONNECT_TIMEOUT_MS=3000 npm start

BASE=http://127.0.0.1:3214 npm run check:proxy
# A 正常站不受影响 / B 整体超时到点即收场且不重试 / C 连接失败重试一次并给出落地页
```

## 部署

服务只用到 `express` + `tough-cookie`，监听 `PORT`，因此可以丢到任何 Node 主机上：

```bash
npm ci && NODE_ENV=production PORT=3000 npm start
```

> **出网能力决定可用率**：代理是服务端抓取目标站点，所以部署机器必须能访问外网。  
> 本地 / 自有服务器通常可访问所有站点；托管沙箱类环境可能对部分域名限制出网  
> （可用 `scripts/online-check.mjs` 先测一遍）。

### 目标站域名解析（`server/dnsResolver.js`）

线上（CloudStudio）实测过一个很坑的现象：访问 `https://skillhub.cn/` 时页面显示
「糟糕，页面好像去火星了......，错误原因：页面未找到」，把域名写成带尾点的
`skillhub.cn.` 再试，TLS 证书竟是 `*.unionpayintl.com` —— 同一个域名两次查询落到
两组互不相关的服务器，而 DoH 查询稳定给出 EdgeOne 节点。根因是部署机的系统解析
不可信，代理连到了别人的 404 页。

因此解析改成三级策略：

1. **fake-ip 直通**：系统解析落在 `198.18.0.0/15`（Clash / sing-box 的 fake-ip）时
   原样放行 —— 这种环境下系统解析就是代理入口，换成真实 IP 反而绕过代理、被墙站点直接超时。
2. **DoH 优先**：其余情况走 `dns.alidns.com` → `doh.pub`，并对结果做一次 443 连通性
   探测（400ms）。能连才用，地址会排到列表最前。
3. **回退系统解析**：DoH 不可达 / 查不到 / 连不上一律退回系统解析。

相关环境变量：`PROXY_DNS_MODE=auto|system|doh`（默认 `auto`）、`DOH_TIMEOUT_MS`、
`DNS_PROBE_TIMEOUT_MS`、`DNS_CACHE_TTL_MS`（设 0 可彻底关缓存，回归脚本用）。
`GET /api/health` 的 `dns` 字段会给出实际走了哪条分支（`dohHits` / `fakeIpPassthrough` /
`systemFallbacks` / `dohUnreachable`），排查「站点解析到错误服务器」时先看这里。

## 调优小贴士

- 模型调用默认重试 2 次（`maxRetries`），用于自愈「工具名写错」这类幻觉；通道不可达时不会长时间挂起。
- `scriptTool`（默认开）允许 Agent 用 JS 触发回车、拖拽等只有脚本才能做的交互。
- 追求更稳的指令遵循可以换更强的模型（如 `deepseek/deepseek-v4-pro`、`gpt-5`）。

## License

MIT
