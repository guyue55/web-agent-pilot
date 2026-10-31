# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 改进

- **Release 流程闭环**：打 tag 现在除构建推送 GHCR 镜像外，还会在镜像健康检查通过后自动创建 GitHub Release；说明优先取 CHANGELOG 对应版本段落，找不到则退回 GitHub 自动生成。

## [1.0.0] - 2026-10-31

首个正式版本。核心能力：服务端同源反代把任意站点嵌入本应用，页面内 Agent 直接操作真实 DOM —— 不依赖浏览器插件，也不依赖无头浏览器。

### 新增

- **同源反代**：`/__pa/<scheme>/<host>/<path>` 由服务端抓取并重写输出，抹掉 `X-Frame-Options` / CSP frame-ancestors，使任意站点可被嵌入且与主应用同源。
- **三重 URL 兜底**：服务端重写 HTML 属性（含无引号写法、`srcset`、CSS `url()`、meta refresh）；注入 `<base href>`；`bridge.js` 运行时接管 `fetch` / `XHR` / `sendBeacon` / `EventSource`。
- **WebSocket 隧道**：`/__paws/...` 在 `upgrade` 事件里双向透传，不做帧解析 —— permessage-deflate、子协议、二进制帧端到端保持原样。
- **存储与 cookie 按站点隔离**：`localStorage` / `sessionStorage` / IndexedDB / `document.cookie` 与 Cookie Store API 全部按目标站加前缀，修掉「A 站读到 B 站 token」「B 站 `clear()` 抹掉 A 站数据」。
- **页面内 Agent**：点击、输入、翻页、提取；支持跨页面续跑（跳转后自动接着执行，并带上「上一页已做过的动作」摘要）。
- **导航死循环保护**：统计同一地址 8 秒内的加载次数，达到 5 次即停止接管并给出说明卡片。
- **目标站不可用时的落地页**：区分「太慢」与「连不上」，给出重试与「在新标签页打开原站」。
- Docker 镜像（非 root、自带健康检查）、GitHub Actions CI、打 tag 自动发布 GHCR 镜像。

### 修复

**代理与加载**

- 不再把网关注入的请求头转发给目标站 —— 修掉 EdgeOne 因 `Host` 与 `X-Forwarded-Host` 不一致返回的错误页，以及一处平台 JWT 被转发给第三方站点的问题。
- 还原被代理页的路径：纯前端站点（React + wouter）读到的 `location.pathname` 带 `/__pa/...` 前缀会渲染自家 `page not found`（skillhub.cn 实测正文 381 字符 → 还原后 2792）。
- `<base href>` 改为目录而非页面本身，修掉站内页相对地址被解析到上一级。
- 目标站 JS 触发的同源导航（如 `location.href='/s?wd=x'`）不再逃逸出代理导致 404：Referer + 会话记忆双重兜底。
- 会话记忆只在文档导航时更新，修掉「每张 CDN 图片都刷新当前目标站」导致刷新被送到错误站点。
- 目标站解析增加 DoH 能力，修掉「连到别人服务器」的假 404。
- 建连超时放宽、失败页给出真正可操作的内容；错误信息摊平到最内层原因（undici 双栈下 `AggregateError` 只读一层会退化成 `fetch failed`）。

**安全**

- 建连那一刻再校验 IP，堵住 DNS rebinding 的「预检与建连两次解析」窗口。
- LLM 转发接口补齐 SSRF 校验；兜底路由拒绝跨站请求。
- 删除响应头里的 `alt-svc`，避免目标站的 HTTP/3 声明指向本应用的源。

**Agent**

- 「停止」不再等模型请求跑完，中止信号一路穿透到 `fetch`（实测 5s → 2ms）。
- 工具名写成 `script` / `index` 等别名时不再整轮报废，自动映射到真实工具。
- 只接受父窗口发来的配置指令，目标页无法自己给自己配模型。
- 并发到达的配置消息做初始化去重，避免「双输入框、重复光标、多个动画循环」。
- 直连通道的模型请求不再被 bridge 错误改写到页面代理（此前导致超时）。
- Agent 生命周期三处断裂：面板关掉变僵尸、跳页任务全丢、步骤间隔失效。

**存储**

- 页面 JS 写的 cookie 也按站点隔离（此前 A 站写的 token B 站能直接读到）。
- 补齐 shim 与原生存储的语义差异（`length` / `key()` / `Object.keys` / `clear()` / 属性式访问 / `storage` 事件）。
- 目标站 origin 改走 `data` 属性传递，绕开网关对「URL 进查询串」的 403。

**UI**

- Panel 与光标遮罩收拢到 `<html>` 下的隔离容器，修掉被目标站 `transform` / `filter` / `contain` 带偏的定位（实测面板距底部 100px → 519px）。
- 窄屏适配，修掉设置面板在手机端溢出被裁切。
- 顶栏新增「AI 面板」按钮，可重建已销毁的 Agent，不必刷新页面。

### 已知限制

详见 README 的「已知限制」：反爬站点（Cloudflare 五秒盾、指纹校验）无法通过；API Key 存于 `localStorage`，被代理页面同源可读（这是设计边界，不是缺陷）。

[Unreleased]: https://github.com/guyue55/web-agent-pilot/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guyue55/web-agent-pilot/releases/tag/v1.0.0
