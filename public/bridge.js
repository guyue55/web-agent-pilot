/**
 * bridge.js —— 注入到被代理页面内部运行
 *
 * 职责：
 *  1. 反 iframe 拦截 / 反 framebusting
 *  2. 让页面 JS 的动态请求（fetch / XHR / sendBeacon / EventSource）回流到代理
 *  3. 注入并驱动 page-agent，向父窗口转发执行过程
 *
 * 由于 iframe 与主页面同源，这里可以直接使用 window.parent 通信。
 */
;(function () {
	if (window.__PABridge) return

	const REAL_PARENT = window.parent
	const REAL_TOP = window.top
	const PROXY_PREFIX = '/__pa/'
	const SELF_PATHS = ['/_app/', '/api/llm', '/api/resolve']
	const SHARE_PARAM = 'sharecode'

	// 部署在带访问码校验的网关后面时，iframe 内的每一次请求都要带上访问码
	const SHARE_VALUE = (() => {
		try {
			return new URLSearchParams(location.search).get(SHARE_PARAM) || ''
		} catch {
			return ''
		}
	})()

	function withShare(url) {
		if (!SHARE_VALUE || !url) return url
		const hashIdx = url.indexOf('#')
		const head = hashIdx === -1 ? url : url.slice(0, hashIdx)
		const hash = hashIdx === -1 ? '' : url.slice(hashIdx)
		const sep = head.includes('?') ? '&' : '?'
		return `${head}${sep}${SHARE_PARAM}=${encodeURIComponent(SHARE_VALUE)}${hash}`
	}

	const state = {
		ready: false,
		agent: null,
		config: null,
		// 极速模式：默认跳过图片，避免经代理回源慢 CDN 时整页卡死（操作类任务无需看图）
		fastMode: true,
	}

	// 大模型服务域名集合：这些域名不走「页面代理 /__pa/」，必须让浏览器真实出网。
	// 否则「浏览器直连」通道的请求会被 rewriteUrl 错误改写成 /__pa/https/<host>/...
	// 经部署机转发，而部署机往往出网受限（如连不上 zenmux.ai），导致 45s 级超时。
	// 服务端代理通道走 /api/llm/proxy，已在本文件 SELF_PATHS 中豁免，不受影响。
	const noProxyHosts = new Set()
	function refreshNoProxyHosts() {
		noProxyHosts.clear()
		if (state.config?.baseURL) {
			try {
				noProxyHosts.add(new URL(state.config.baseURL).host)
			} catch {
				/* 非法 URL 忽略 */
			}
		}
	}

	// 1x1 透明占位图，替代被跳过的图片请求
	const IMG_PLACEHOLDER =
		"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='1'%20height='1'%3E%3C/svg%3E"

	// ---------------------------------------------------------------- 工具
	function post(payload) {
		try {
			REAL_PARENT.postMessage({ source: 'pa-bridge', ...payload }, window.location.origin)
		} catch (err) {
			console.warn('[pa-bridge] postMessage failed', err)
		}
	}

	function targetBaseOrigin() {
		const fromLoc = matchProxy(location.pathname + location.search)
		if (fromLoc) return fromLoc
		const baseEl = document.querySelector('base[href]')
		if (!baseEl) return null
		try {
			const u = new URL(baseEl.getAttribute('href'), location.href)
			return matchProxy(u.pathname + u.search)
		} catch {
			return null
		}
	}

	function matchProxy(pathAndQuery) {
		if (!pathAndQuery.startsWith(PROXY_PREFIX)) return null
		const rest = pathAndQuery.slice(PROXY_PREFIX.length)
		const i = rest.indexOf('/')
		const scheme = i === -1 ? rest : rest.slice(0, i)
		if (scheme !== 'http' && scheme !== 'https') return null
		const hostRest = rest.slice(scheme.length + 1)
		const j = hostRest.indexOf('/')
		const host = j === -1 ? hostRest : hostRest.slice(0, j)
		if (!host) return null
		return `${scheme}://${host}`
	}

	function toProxyPath(abs) {
		return withShare(
			`${PROXY_PREFIX}${abs.protocol.replace(':', '')}/${abs.host}${abs.pathname}${abs.search}`
		)
	}

	function rewriteUrl(input) {
		if (typeof input !== 'string' && !(input instanceof URL)) return input
		const raw = String(input)
		if (!raw || /^(data:|blob:|about:|javascript:|mailto:|tel:|sms:|#|chrome-extension:)/i.test(raw)) return raw
		let abs
		try {
			abs = new URL(raw, document.baseURI)
		} catch {
			return raw
		}
		if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return raw
		if (abs.pathname.startsWith(PROXY_PREFIX)) return withShare(abs.href)
		if (abs.origin === location.origin) {
			if (SELF_PATHS.some((p) => abs.pathname.startsWith(p))) return withShare(raw)
			const t = targetBaseOrigin()
			if (t) {
				try {
					return toProxyPath(new URL(t + abs.pathname + abs.search))
				} catch {
					return raw
				}
			}
			return raw
		}
		// 大模型服务域名：浏览器直连需要真实出网，服务端代理走 /api/llm/proxy，
		// 若错误改写到 /__pa/ 页面代理会因部署机出网受限而超时。故直接放行。
		if (noProxyHosts.has(abs.host)) return raw
		return toProxyPath(abs)
	}

	// ----------------------------------------------------- 图片极速模式
	function neutralizeImage(img) {
		if (!img || (img.tagName !== 'IMG' && img.tagName !== 'IMAGE')) return
		const src = img.getAttribute('src')
		if (!src || /^(data:|blob:)/i.test(src)) return
		if (img.dataset.paOrig) return
		img.dataset.paOrig = src
		img.removeAttribute('src')
		img.src = IMG_PLACEHOLDER
	}

	function restoreImage(img) {
		if (!img || !img.dataset.paOrig) return
		img.src = img.dataset.paOrig
		delete img.dataset.paOrig
	}

	function neutralizeExistingImages() {
		if (!state.fastMode) return
		document.querySelectorAll('img[src]').forEach(neutralizeImage)
	}

	// 图片地址：极速模式下直接替换为占位图，其余场景走正常代理
	function imageSrcTransform(value) {
		if (state.fastMode) return IMG_PLACEHOLDER
		return rewriteUrl(value)
	}

	// ------------------------------------------------- 动态网络请求回流到代理
	const originalFetch = window.fetch.bind(window)
	window.fetch = function (input, init) {
		try {
			if (typeof input === 'string' || input instanceof URL) {
				input = rewriteUrl(input)
			}
		} catch {
			/* noop */
		}
		return originalFetch(input, init)
	}

	// 用 class extends 而不是替换原型：普通函数做补丁时，静态成员
	// （XMLHttpRequest.DONE / WebSocket.OPEN …）不会跟着搬到新构造器上。
	// 真实站点普遍用 `xhr.readyState === XMLHttpRequest.DONE` 判断完成，
	// 常量一旦变成 undefined，页面数据就永远加载不出来。
	const OriginalXHR = window.XMLHttpRequest
	class PatchedXHR extends OriginalXHR {
		open(method, url, ...rest) {
			try {
				url = rewriteUrl(url)
			} catch {
				/* noop */
			}
			return super.open(method, url, ...rest)
		}
	}
	window.XMLHttpRequest = PatchedXHR

	const originalBeacon = navigator.sendBeacon?.bind(navigator)
	if (originalBeacon) {
		navigator.sendBeacon = function (url, data) {
			try {
				return originalBeacon(rewriteUrl(url), data)
			} catch {
				return originalBeacon(url, data)
			}
		}
	}

	if (window.EventSource) {
		const OriginalES = window.EventSource
		class PatchedES extends OriginalES {
			constructor(url, init) {
				super(rewriteUrl(url), init)
			}
		}
		window.EventSource = PatchedES
	}

	// WebSocket 暂不支持服务端代理，显式降级避免页面反复重连
	if (window.WebSocket) {
		const OriginalWS = window.WebSocket
		class PatchedWS extends OriginalWS {
			constructor(url, protocols) {
				console.warn('[pa-bridge] WebSocket 代理暂不支持，已阻止连接：', String(url))
				try {
					super('ws://127.0.0.1:1', protocols)
				} catch {
					// 返回一个最小可用的假对象，避免调用方崩溃
					return {
						readyState: 3,
						CLOSED: 3,
						send() {},
						close() {},
						addEventListener() {},
						removeEventListener() {},
					}
				}
			}
			send() {}
			close() {}
		}
		window.WebSocket = PatchedWS
	}

	// Service Worker 会注册到我们的域上，必须禁用
	if (navigator.serviceWorker?.register) {
		navigator.serviceWorker.register = function () {
			return Promise.reject(new Error('service worker disabled in proxy'))
		}
	}

	// ------------------------------------------- 动态插入的节点也要走代理
	const URLISH_ATTRS = ['src', 'href', 'srcset', 'poster', 'data', 'action', 'formaction']

	// page-agent 自身的 UI（遮罩 SimulatorMask / Panel）都带这两个标记。
	// 它在运行期间高频增删 DOM（遮罩动画、光标 rAF 循环、元素高亮框），
	// 若被本文件的代理改写逻辑逐节点扫描，会明显掉帧 → 表现"不够丝滑/生硬"；
	// 且其资源全是 data URI / 内联样式，本来就不需要代理。故整体跳过。
	const PA_OWNED_SELECTOR = '[data-page-agent-ignore],[data-browser-use-ignore]'
	function isPageAgentOwned(node) {
		if (!node) return false
		const el = node.nodeType === 1 ? node : node.parentElement
		if (!el || typeof el.closest !== 'function') return false
		return el.closest(PA_OWNED_SELECTOR) !== null
	}

	function normalizeAttributes(node) {
		if (!node || node.nodeType !== 1 || !node.getAttribute) return
		if (isPageAgentOwned(node)) return
		// 图片在极速模式下直接 Neutralize，避免慢 CDN 拖垮整页
		if (node.tagName === 'IMG' || node.tagName === 'IMAGE') {
			if (state.fastMode) {
				neutralizeImage(node)
				return
			}
		}
		for (const attr of URLISH_ATTRS) {
			if (!node.hasAttribute(attr)) continue
			const value = node.getAttribute(attr)
			if (!value) continue
			if (value.startsWith(PROXY_PREFIX)) continue
			if (/^(data:|blob:|about:|javascript:|mailto:|tel:|#|srcdoc)/i.test(value)) continue
			if (node.tagName === 'IFRAME' && (value === 'about:blank' || node.hasAttribute('srcdoc'))) continue
			try {
				const next = attr === 'srcset' ? rewriteSrcsetNode(value) : rewriteUrl(value)
				if (next && next !== value) node.setAttribute(attr, next)
			} catch {
				/* noop */
			}
		}
	}

	function rewriteSrcsetNode(value) {
		return value
			.split(',')
			.map((part) => {
				const t = part.trim()
				if (!t) return part
				const m = /^(\S+)(\s+[\d.]+[xw])?$/.exec(t)
				if (!m) return part
				const u = rewriteUrl(m[1])
				return m[2] ? `${u}${m[2]}` : u
			})
			.join(', ')
	}

	// JS 动态赋值的资源地址（script.src = 'https://cdn/x.js' 这类不在 DOM 里也能命中）
	function patchUrlProperty(proto, prop, transform = rewriteUrl) {
		if (!proto) return
		const desc = Object.getOwnPropertyDescriptor(proto, prop)
		if (!desc?.set || !desc.get) return
		Object.defineProperty(proto, prop, {
			...desc,
			get() {
				return desc.get.call(this)
			},
			set(value) {
				desc.set.call(this, typeof value === 'string' ? transform(value) : value)
			},
		})
	}
	try {
		for (const [Ctor, props] of [
		[HTMLScriptElement, [['src']]],
		[HTMLImageElement, [['src', imageSrcTransform]]],
		[HTMLIFrameElement, [['src']]],
		[HTMLLinkElement, [['href']]],
		[HTMLSourceElement, [['src'], ['srcset', rewriteSrcsetNode]]],
		[HTMLVideoElement, [['src'], ['poster']]],
		[HTMLAudioElement, [['src']]],
		[HTMLTrackElement, [['src']]],
		[HTMLEmbedElement, [['src']]],
		// 锚点 / 表单：站点 JS 常通过属性赋值改写链接与提交地址
		// （如百度搜索框 virtual-form 提交 /s）。不拦截的话会以「本站同源路径」
		// 直接导航，绕过代理触发服务端 404
		[HTMLAnchorElement, [['href']]],
		[HTMLAreaElement, [['href']]],
		[HTMLFormElement, [['action']]],
		[HTMLButtonElement, [['formAction']]],
		[HTMLInputElement, [['formAction']]],
	]) {
			for (const [p, transform] of props) patchUrlProperty(Ctor.prototype, p, transform)
		}
	} catch {
		/* 原型不可改时忽略，不影响主流程 */
	}

	// 动态 form.submit()：站点常在运行时改写 action 后原生提交（百度 virtual-form）。
	// 提交前再规范化一次 action，确保请求回流代理而非落到本站路径导致 404
	try {
		const originalFormSubmit = HTMLFormElement.prototype.submit
		HTMLFormElement.prototype.submit = function () {
			try {
				normalizeAttributes(this)
			} catch {
				/* noop */
			}
			return originalFormSubmit.call(this)
		}
	} catch {
		/* noop */
	}

	try {
		const observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.type !== 'childList') continue
				m.addedNodes.forEach((n) => {
					// page-agent 自身 UI 的高频 DOM 变更直接跳过，避免逐节点扫描拖垮帧率
					if (isPageAgentOwned(n)) return
					normalizeAttributes(n)
					if (n.nodeType === 1 && n.querySelectorAll) {
						n.querySelectorAll('[src],[href],[srcset],[poster],[action]').forEach(normalizeAttributes)
					}
				})
			}
		})
		// 只监听新增节点；属性变更（如广告/统计脚本频繁改 class/style）极易引发死循环式开销，
		// 图片地址已由原型 setter 拦截，其余属性变更无需代理
		observer.observe(document.documentElement || document, {
			childList: true,
			subtree: true,
		})
	} catch {
		/* 某些环境不允许 observe，忽略 */
	}

	// ---------------------------------------------------------- 反 iframe 拦截
	try {
		Object.defineProperty(window, 'top', { get: () => window.self, configurable: true })
		Object.defineProperty(window, 'parent', { get: () => window.self, configurable: true })
		Object.defineProperty(window, 'frameElement', { get: () => null, configurable: true })
	} catch {
		/* 某些站点禁止改写，忽略 */
	}

	// ---------------------------------------------------------------- Agent
	async function loadScript(src) {
		return new Promise((resolve, reject) => {
			const s = document.createElement('script')
			s.src = src
			s.async = false
			s.onload = resolve
			s.onerror = () => reject(new Error(`加载失败：${src}`))
			document.head.appendChild(s)
		})
	}

	let adapterPromise = null
	function loadAdapter() {
		if (!adapterPromise) adapterPromise = import(withShare('/_app/js/llm-adapter.js'))
		return adapterPromise
	}

	async function ensureScriptLoaded() {
		if (typeof window.PageAgent === 'function') return
		await loadScript(withShare('/_app/vendor/page-agent.demo.js?autoInit=false'))
		if (typeof window.PageAgent !== 'function') throw new Error('PageAgent 未正确加载')
	}

	function disposeAgent() {
		if (state.agent) {
			try {
				state.agent.dispose()
			} catch {
				/* noop */
			}
			state.agent = null
		}
	}

	// 清理可能残留的 page-agent 遮罩 / 面板节点。
	// SimulatorMask 是「异步动态 import」创建的：若在 mask 建好之前就 dispose，
	// 那个迟到的 mask 会成为孤儿永远留在页面上。孤儿遮罩会叠加出
	// 「多个光标（看起来更大）+ 重复元素框 + 多个 rAF/动画循环 → 卡顿」。
	// 本函数在新建 Agent 前调用，此时不应存在任何遮罩/面板，存在的即为残留。
	function cleanupStaleOverlays() {
		try {
			document
				.querySelectorAll('#page-agent-runtime_simulator-mask, #page-agent-runtime_agent-panel')
				.forEach((el) => el.remove())
		} catch {
			/* noop */
		}
	}

	// 同一时间只允许一次 Agent 初始化在飞。
	// ensureAgent 内部有 await（加载脚本 / 动态 import），连续两条 configure 消息
	// 会并发跑到这里：各自都会通过 `if (state.agent) return` 的检查，
	// 最终创建两个 Agent，第二个覆盖 state.agent 后第一个成为孤儿 ——
	// 表现为「两个输入框 + 重复光标 / 元素框 + 多个动画循环」。
	let agentStarting = null

	async function ensureAgent() {
		if (state.agent) return state.agent
		if (agentStarting) return agentStarting
		agentStarting = (async () => {
			try {
				return await createAgent()
			} finally {
				agentStarting = null
			}
		})()
		return agentStarting
	}

	async function createAgent() {
		if (!state.config) throw new Error('尚未配置大模型，请先在设置面板填写 API 信息')
		await ensureScriptLoaded()
		const { createAgentFetch } = await loadAdapter()

		disposeAgent()
		// 清掉上一轮可能残留的孤儿遮罩/面板，避免视觉叠加与动画循环累积
		cleanupStaleOverlays()

		const cfg = state.config
		refreshNoProxyHosts()
		const baseURL = cfg.baseURL.replace(/\/+$/, '')
		const agent = new window.PageAgent({
			model: cfg.model,
			baseURL: cfg.baseURL,
			apiKey: cfg.apiKey,
			language: cfg.language || 'zh-CN',
			maxSteps: Number(cfg.maxSteps) || 40,
			stepDelay: Number(cfg.stepDelay) ?? 0.4,
			// 工具名幻觉（如把 execute_javascript 写成 script）多试几次通常能自愈；
			// 但通道不可达时重试只会长耗时挂起，故默认仅 2 次
			maxRetries: Number(cfg.maxRetries) || 2,
			customFetch: createAgentFetch({ ...cfg, baseURL, baseUrl: baseURL }),
			enableMask: true,
			// 允许 Agent 在页面内执行 JS（发送回车、绕过只有 JS 才能触发的交互）
			experimentalScriptExecutionTool: cfg.scriptTool !== false,
		})

		// 采用 page-agent 自带的 Panel 作为聊天 UI（直接渲染在 iframe 内的目标页上），
		// 它原生支持单输入框、Enter 发送、实时 thinking/executing 状态与 ask_user 问答。
		// 不再覆盖 onAskUser —— 交由 Panel 原生处理用户问答。
		try {
			agent.panel.show()
		} catch (err) {
			console.warn('[pa-bridge] Panel 显示失败', err)
		}

		// 仅向宿主同步轻量状态，用于顶部状态徽标（聊天内容由 Panel 自身渲染）
		agent.addEventListener('statuschange', () => {
			post({ type: 'status', status: agent.status })
		})
		agent.addEventListener('activity', (e) => {
			post({ type: 'activity', detail: { type: e.detail?.type } })
		})

		state.agent = agent
		return agent
	}

	// ---------------------------------------------------------- 消息监听
	window.addEventListener('message', async (event) => {
		if (event.origin !== window.location.origin) return
		const data = event.data
		if (!data || data.source !== 'pa-host') return

		const { type, payload } = data
		try {
			switch (type) {
				case 'configure': {
					state.config = payload
					refreshNoProxyHosts()
					state.fastMode = payload?.fastMode !== false
					// 应用极速模式到已存在的图片
					document.querySelectorAll('img').forEach((img) => {
						if (state.fastMode) neutralizeImage(img)
						else restoreImage(img)
					})
					// 重建并展示 page-agent 内置 Panel（聊天 UI 在 iframe 内），由 Panel 自己驱动任务
					disposeAgent()
					try {
						await ensureAgent()
					} catch (err) {
						post({ type: 'config-error', message: err?.message || String(err) })
					}
					post({ type: 'configured' })
					break
				}
				default:
					break
			}
		} catch (err) {
			post({ type: 'error', message: err?.stack || err?.message || String(err) })
		}
	})

	// 页面卸载时告知父窗口，避免 UI 卡在 running
	window.addEventListener('pagehide', () => {
		post({ type: 'pagehide' })
	})

	window.__PABridge = {
		get ready() {
			return state.ready
		},
		ensureAgent,
	}

	// AI 执行前先确认 DOM 就绪，再通知宿主
	function boot() {
		state.ready = true
		// 极速模式：先把已存在的图片换成占位图，避免慢 CDN 拖垮整页
		neutralizeExistingImages()
		post({ type: 'ready', url: location.pathname + location.search })
		// 若已配置模型，直接在 iframe 内创建并展示 Panel（聊天 UI）
		if (state.config) {
			ensureAgent().catch((err) =>
				post({ type: 'config-error', message: err?.message || String(err) })
			)
		}
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot, { once: true })
	} else {
		boot()
	}
})()
