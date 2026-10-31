# 参与开发

## 本地跑起来

```bash
npm install
npm start                 # 默认 http://localhost:3000
```

打开后输入任意网址即可。Agent 需要在设置里填模型服务商与 API Key（Key 存于浏览器 `localStorage`，见 SECURITY.md 的边界说明）。

调试常用两个开关：

```bash
DEBUG_PROXY=1 npm start   # 打印代理细节
DEBUG_LLM=1 npm start     # 打印 LLM 转发日志
```

## 跑回归

回归脚本分两类，前置条件不同。

**需要先起服务**（应用 + 夹具 + mock LLM）：

```bash
ALLOW_LOCALHOST=true PORT=3211 node server/index.js &
# 3214 是「短超时」实例，专门测超时与重试的时序约束；注意不要让它带上 HTTP_PROXY，
# 否则请求会走出网隧道，连接错误类型变了，回归会假失败
PORT=3214 ALLOW_LOCALHOST=true PROXY_TIMEOUT_MS=1200 PROXY_RETRY=1 CONNECT_TIMEOUT_MS=3000 node server/index.js &
MOCK_PORT=3400 node scripts/mock-llm.mjs &
node scripts/fixtures/fixtures-server.mjs &
node scripts/fixtures/ws-echo-server.mjs &
```

> `mock-llm` 占用**两个**端口：`MOCK_PORT`（模型接口）与 `MOCK_PORT+1`（`/__log`、`/__reset`
> 日志接口，续跑回归读的是它）。因此**只起一个实例**即可 —— 不要为了「隔离日志」再起一个
> `MOCK_PORT=3401`：后起的会抢占前一个的日志端口，前者崩溃后连 3400 都不可用。

`ALLOW_LOCALHOST=true` 是必需的 —— 夹具服务在 `127.0.0.1`，默认会被 SSRF 校验拦掉。

然后：

```bash
node scripts/check-syntax.mjs          # 语法（CI 第一道关）
node scripts/check-forward-headers.mjs # 请求头清洗
node scripts/check-proxy-timeout.mjs   # 超时与重试
node scripts/check-rebind.mjs          # DNS rebinding（自带替身 DNS，不用起服务）
node scripts/check-storage.mjs         # 存储隔离
node scripts/check-storage-fidelity.mjs
node scripts/check-ws.mjs              # WebSocket 隧道
node scripts/check-nav-loop.mjs        # 导航死循环保护
node scripts/check-resume.mjs          # 跨页面续跑
node scripts/check-panel-close.mjs     # 面板关闭与恢复
node scripts/check-stop.mjs            # 停止即断
node scripts/check-tool-alias.mjs      # 工具名别名
```

**依赖外网**的（真实站点，CI 上不稳定，本地手动跑）：

```bash
node scripts/check-spa-route.mjs   # SPA 路由还原（skillhub.cn）
node scripts/check-real-sites.mjs  # 真实站点；BASELINE_DIR=... 可与上一版逐站对比是否退化
node scripts/check-dns.mjs         # DoH 解析
```

浏览器脚本用 playwright-core 连**本机真实的 Chrome**：先读 `CHROME_PATH`，再按常见安装位置找（`scripts/lib/chrome.mjs`）。CI 上由 `browser-actions/setup-chrome` 提供。

## 写回归的要求

1. **判据要回答「这次改动有没有把它弄坏」**，而不是做绝对比较。真实站点受反爬、无 JS 渲染、headless 差异影响，`直连 vs 代理` 的比值会乱跳 —— 应当与上一版基线对比。
2. **做负向验证**：退回旧写法时，你新加的断言必须真的失败。写弱了的断言（谁都不改也通过）等于没写。
3. 先在**基线版本**上跑一遍再判定。很多"失败"其实是既有问题或环境差异（例如环境变量没清干净），先做对照能省大量时间。
4. 新增环境变量要同步补 `.env.example` 与 README 的表格。

## 提交与 PR

- 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：`fix(proxy): ...`、`feat(bridge): ...`、`docs: ...`。
- scope 建议用模块名：`proxy` / `bridge` / `storage` / `security` / `dns` / `llm` / `ui` / `test`。
- PR 请填模板里的「验证方式」，贴真实跑过的输出。
- `master` 上的 push 与 PR 都会触发 CI（语法 / 核心回归 / 浏览器回归 / 镜像健康检查）。

## 目录约定

```
server/     服务端：代理、重写、安全校验、WS 隧道、会话状态
public/     注入到被代理页面的脚本 + 主应用前端
scripts/    回归脚本与夹具（不进运行镜像）
```

`server/security.js`、`server/dnsResolver.js`、`server/proxy.js` 的改动由 CODEOWNERS 强制维护者审阅。
