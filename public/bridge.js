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

	// WebSocket：改写到服务端隧道 /__paws/<scheme>/<host>/<path>（握手后按字节透传）
	const WS_PREFIX = '/__paws/'
	function toWsProxyUrl(rawUrl) {
		let abs
		try {
			abs = new URL(String(rawUrl), location.href)
		} catch {
			return rawUrl
		}
		// 已经是代理路径 / 非 ws 协议：原样返回
		if (abs.pathname.startsWith(WS_PREFIX)) return rawUrl
		if (abs.protocol !== 'ws:' && abs.protocol !== 'wss:') return rawUrl
		const targetScheme = abs.protocol === 'wss:' ? 'https' : 'http'
		// 页面本身是 http，浏览器不允许连 wss 到同主机的明文端口，按页面协议选 ws/wss
		const localScheme = location.protocol === 'https:' ? 'wss' : 'ws'
		return `${localScheme}://${location.host}${WS_PREFIX}${targetScheme}/${abs.host}${abs.pathname}${abs.search}`
	}

	if (window.WebSocket) {
		const OriginalWS = window.WebSocket
		// 必须用 class extends：替换原型的写法会丢掉 CONNECTING/OPEN/CLOSING/CLOSED
		// 这些静态常量，站点用常量判断连接状态时会一直卡在「未连接」
		class PatchedWS extends OriginalWS {
			constructor(url, protocols) {
				const proxied = toWsProxyUrl(url)
				if (protocols === undefined) super(proxied)
				else super(proxied, protocols)
			}
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

	// ------------------------------------------------ 浮层隔离（防目标站 CSS 破坏定位）
	// 目标站若在 body/html 上使用了 transform / filter / perspective / contain，
	// 就会成为 position:fixed 的「包含块」：实测 body{transform} 的页面上，
	// 面板距视口底部从 100px 变成 519px、光标遮罩同样被带偏（指向错误位置）。
	// 把 page-agent 的浮层挪到 <html> 下的专用容器（脱离 body 子树）即可恢复视口定位；
	// 同时在容器上显式声明可继承属性，阻断目标站的字体/字距/颜色渗进面板。
	const OVERLAY_ROOT_ID = 'pa-overlay-root'
	const OVERLAY_ID_PREFIX = 'page-agent-runtime_'

	function ensureOverlayRoot() {
		let root = document.getElementById(OVERLAY_ROOT_ID)
		if (root) return root
		if (!document.documentElement) return null
		root = document.createElement('div')
		root.id = OVERLAY_ROOT_ID
		root.setAttribute('data-page-agent-ignore', '')
		root.setAttribute('data-browser-use-ignore', '')
		// 只写「阻断污染」必需的声明：不建立包含块，不改变子元素定位语义
		root.style.cssText = [
			'all: initial',
			'display: block',
			'position: static',
			'contain: none',
			'inset: auto',
			'font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
			'font-size: 16px',
			'font-weight: 400',
			'font-style: normal',
			'line-height: 1.5',
			'letter-spacing: normal',
			'word-spacing: normal',
			'text-transform: none',
			'text-indent: 0',
			'text-align: left',
			'white-space: normal',
			'direction: ltr',
			'color: #000',
		].join(';')
		document.documentElement.appendChild(root)

		// 目标站常写 `div { letter-spacing: 5px !important }` 这类全局规则：它是元素选择器
		// 带 !important，行内样式也压不住，会顺着继承把面板文字拉花。
		// 这四个属性 Panel 自身一处都没用到（已核对 Panel.module.css），强制归位零风险。
		try {
			const style = document.createElement('style')
			style.setAttribute('data-page-agent-ignore', '')
			style.textContent = `
				#${OVERLAY_ROOT_ID}, #${OVERLAY_ROOT_ID} * {
					letter-spacing: normal !important;
					word-spacing: normal !important;
					text-transform: none !important;
					text-indent: 0 !important;
				}
			`
			document.head.appendChild(style)
		} catch {
			/* 注入失败不影响主功能 */
		}

		return root
	}

	/** 把 page-agent 的浮层（Panel / SimulatorMask）统一收拢到隔离容器里 */
	function adoptOverlays() {
		const root = ensureOverlayRoot()
		if (!root) return
		for (const el of document.querySelectorAll(`[id^="${OVERLAY_ID_PREFIX}"]`)) {
			if (el.parentElement === root) continue
			try {
				root.appendChild(el)
			} catch {
				/* 极端情况下移动失败：保持原样，不影响功能 */
			}
		}
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
					// page-agent 的浮层（Panel / 遮罩）一出现就收拢到隔离容器，
					// 避免被目标站的 transform/filter 带偏定位、被全局 CSS 污染
					if (n.nodeType === 1 && typeof n.id === 'string' && n.id.startsWith(OVERLAY_ID_PREFIX)) {
						adoptOverlays()
						return
					}
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

	// 内部主动重建时也会触发 dispose 事件，用它抑制「面板被关闭」的误报
	let disposingInternally = false

	// ------------------------------------------------- 跨导航续跑（页面跳转后接着干）
	// 目标站一跳转，iframe 里的整个 JS 上下文就销毁了：Agent 实例、历史、进度全丢，
	// 任务半途而废（用户点「搜索」后最常见的断点）。这里把正在执行的任务记在
	// sessionStorage（与宿主同源、同标签页），新页面 Agent 就绪后自动接着跑。
	const PENDING_KEY = 'pa.pendingTask'
	const RESUME_TTL_MS = 90 * 1000
	const MAX_RESUMES = 2

	/**
	 * 当前文档对应的目标站 host。
	 * iframe 地址形如 /__pa/https/www.baidu.com/s?wd=x，第二个路径段之后就是 host。
	 */
	function currentProxiedHost() {
		const m = /^\/__pa\/[^/]+\/([^/?#]+)/.exec(location.pathname)
		return m ? m[1] : ''
	}

	function savePending(task, resumes = 0, steps = []) {
		try {
			sessionStorage.setItem(
				PENDING_KEY,
				JSON.stringify({ task, at: Date.now(), resumes, host: currentProxiedHost(), steps })
			)
		} catch {
			/* 隐私模式 / 存储被禁用：放弃续跑即可，不影响主流程 */
		}
	}

	/**
	 * 把「上一页已经做过的动作」压成短摘要存进待续跑记录。
	 *
	 * 注意：不能把旧 history 直接灌进新 Agent —— page-agent 会把 history 里的
	 * step/observation 拼进 <agent_history> 送给模型（已核对 PageAgentCore），
	 * 那等于给模型伪造「当前页面已经执行过」的记忆，会漏做步骤。
	 * 所以这里只保留一份纯文本参考，写进续跑提示词并明确标注「上一页」。
	 */
	function updatePendingSteps(history) {
		try {
			const raw = sessionStorage.getItem(PENDING_KEY)
			if (!raw) return
			const pending = JSON.parse(raw)
			if (!pending || typeof pending.task !== 'string') return
			const steps = []
			for (const e of history || []) {
				if (e?.type !== 'step') continue
				const goal = String(e.reflection?.next_goal || '').replace(/\s+/g, ' ').trim()
				const output = String(e.action?.output || '').replace(/\s+/g, ' ').trim()
				const line = [goal, output].filter(Boolean).join(' → ')
				if (line) steps.push(line.slice(0, 120))
			}
			pending.steps = steps.slice(-4)
			sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
		} catch {
			/* 摘要只是锦上添花，失败就退回仅凭任务文本续跑 */
		}
	}

	function clearPending() {
		try {
			sessionStorage.removeItem(PENDING_KEY)
		} catch {
			/* noop */
		}
	}

	/** 读取待续跑任务；过期或次数用尽时返回 null，避免陈旧任务被误跑 */
	function readPending() {
		try {
			const raw = sessionStorage.getItem(PENDING_KEY)
			if (!raw) return null
			const p = JSON.parse(raw)
			if (!p || typeof p.task !== 'string' || !p.task.trim()) return null
			if (Date.now() - Number(p.at || 0) > RESUME_TTL_MS) return null
			if (Number(p.resumes || 0) >= MAX_RESUMES) return null
			return p
		} catch {
			return null
		}
	}

	function disposeAgent() {
		if (state.agent) {
			disposingInternally = true
			try {
				state.agent.dispose()
			} catch {
				/* noop */
			}
			disposingInternally = false
			state.agent = null
		}
		// 旧实例已销毁，不能再拿它的 execute 去跑续跑任务
		state.executeRaw = null
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
		// 用户点 Panel 右上角的 X，page-agent 内部会直接 dispose 整个 Agent：
		// 实例对象还在、面板也消失了，但再下发任务会抛「PageAgent has been disposed」。
		// 演示站可以靠书签重新注入，本项目没有这个入口，因此这里识别出
		// 已销毁的实例并重建，否则用户点一下 X 之后就只能刷新页面。
		if (state.agent && !state.agent.disposed) return state.agent
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
			// 注意不能用 `Number(x) ?? 0.4`：Number(undefined) 是 NaN，而 NaN 不会被 ??
			// 兜住，会一路传到 waitFor 让「步骤间隔」彻底失效（变成立即执行）
			stepDelay: Number.isFinite(Number(cfg.stepDelay)) ? Number(cfg.stepDelay) : 0.4,
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
		// 面板刚创建时还在 body 里，立刻收拢到隔离容器（脱离 body 的 transform/filter）
		adoptOverlays()

		// 仅向宿主同步轻量状态，用于顶部状态徽标（聊天内容由 Panel 自身渲染）
		agent.addEventListener('statuschange', () => {
			post({ type: 'status', status: agent.status })
			// 任务已有明确结局就不该再续跑；被导航打断时状态会永远停在 running
			const st = agent.status
			if (st === 'completed' || st === 'stopped' || st === 'error') clearPending()
		})
		agent.addEventListener('activity', (e) => {
			post({ type: 'activity', detail: { type: e.detail?.type } })
		})
		// 每步结束都把「已做动作」写进待续跑记录，供跳转后的续跑提示参考
		agent.addEventListener('historychange', () => {
			updatePendingSteps(agent.history)
		})
		// 用户在 Panel 上点 X 时，page-agent 会自己 dispose 掉整个 Agent。
		// 通知宿主，让顶栏的「AI 面板」按钮能把它重新叫回来。
		agent.addEventListener('dispose', () => {
			if (disposingInternally) return
			post({ type: 'panel-state', visible: false })
		})

		// Panel 直接调用 agent.execute(task)。包一层以记下任务原文（导航打断后要用它续跑），
		// 同时把「原始 execute」留给续跑逻辑，避免续跑指令覆盖掉真正的任务文本。
		const rawExecute = agent.execute.bind(agent)
		state.executeRaw = rawExecute
		agent.execute = (task) => {
			if (typeof task === 'string' && task.trim()) savePending(task, 0)
			return rawExecute(task)
		}

		state.agent = agent
		post({ type: 'panel-state', visible: true })
		return agent
	}

	/**
	 * 新页面 Agent 就绪后，把上一个页面被打断的任务接着跑。
	 * 必须在 configure 之后调用 —— Agent 到那一刻才刚被重建完成。
	 */
	function tryResume(agent) {
		if (!agent || agent.disposed || agent.status === 'running') return
		const pending = readPending()
		if (!pending || typeof state.executeRaw !== 'function') return

		// 只有当「确实是上一个页面跳过来的」才续跑：
		//  · 同一目标站（搜索 → 结果页这类同站跳转，Referrer 可能被站点的
		//    referrer-policy 抹掉，靠 host 判断）
		//  · 或来源是本应用的代理页（点了链接跳到别的站，如百度 → 百科）
		// 用户在地址栏另开一个站，两个条件都不满足，不会把旧任务套到新站上。
		const inAppNav = (document.referrer || '').startsWith(`${location.origin}/__pa/`)
		const sameHost = !!pending.host && pending.host === currentProxiedHost()
		if (!inAppNav && !sameHost) return

		const priorSteps = Array.isArray(pending.steps) ? pending.steps.filter(Boolean) : []
		const hint = [
			`页面已跳转，请继续完成原任务：${pending.task}`,
			'',
			...(priorSteps.length
				? ['上一页（已经离开）执行过的动作，仅供参考：', ...priorSteps.map((s, i) => `${i + 1}. ${s}`), '']
				: []),
			'注意：当前页面已经是跳转后的新页面，请先观察页面的真实状态再动手；',
			'已经完成的步骤不要重复执行，如果任务目标已达成，直接结束并说明结果。',
		].join('\n')

		// 先记账再执行：万一这次又触发跳转，次数不会被重置成 0 而陷入死循环
		const attempt = Number(pending.resumes || 0) + 1
		savePending(pending.task, attempt, priorSteps)
		post({ type: 'resume', task: pending.task, attempt, steps: priorSteps.length })
		Promise.resolve(state.executeRaw(hint)).catch((err) => {
			post({ type: 'config-error', message: err?.message || String(err) })
		})
	}

	// ---------------------------------------------------------- 消息监听
	window.addEventListener('message', async (event) => {
		// 只认宿主（真正的父窗口）发来的指令。
		// 只校验 origin + source 标记是不够的：目标页脚本自己 window.postMessage 一条
		// {source:'pa-host'} 就能把 configure 塞进来（实测宿主会收到 configured）。
		// 加上 event.source 校验后，iframe 场景（生产路径）伪造立即失效。
		//
		// 顶层打开代理页时 REAL_PARENT === window，这条校验恒真 —— 但此时没有宿主，
		// 页面「自己配置自己」拿不到用户的模型配置（宿主页面的 key 在另一个文档里），
		// 不会多出任何能力，因此不为此再加一层会让真实宿主失效的拦截。
		if (event.source !== REAL_PARENT) return
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
					let agent = null
					try {
						agent = await ensureAgent()
					} catch (err) {
						post({ type: 'config-error', message: err?.message || String(err) })
					}
					post({ type: 'configured' })
					// 刚跳转过来的页面：把上一个页面被中断的任务接上
					tryResume(agent)
					break
				}
				case 'show-panel': {
					// 顶栏按钮：面板被关掉（或被目标页脚本误伤）时把它叫回来。
					// ensureAgent 会自动重建已被 dispose 的实例
					try {
						const a = await ensureAgent()
						a.panel.show()
						post({ type: 'panel-state', visible: true })
					} catch (err) {
						post({ type: 'config-error', message: err?.message || String(err) })
					}
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

	// ---------------------------------------------------------- 导航死循环保护
	// 有些站点会在「非官方域名」下反复自我跳转（实测知乎 /signin：直连 1 次即停，
	// 经代理 5 秒内跳 20 次），面板被反复冲掉、Agent 每次都重建，用户什么也做不了，
	// 还白白消耗模型调用。这里统计同一地址短时间内的重复加载次数，超阈值就交给宿主拦下。
	const NAV_LOOP_KEY = 'pa.navLoop'
	const NAV_LOOP_WINDOW_MS = 8000
	const NAV_LOOP_LIMIT = 5

	function trackLoad() {
		try {
			const key = location.pathname + location.search
			const now = Date.now()
			let prev = null
			try {
				prev = JSON.parse(sessionStorage.getItem(NAV_LOOP_KEY) || 'null')
			} catch {
				prev = null
			}
			const count = prev && prev.key === key && now - Number(prev.at || 0) < NAV_LOOP_WINDOW_MS
				? Number(prev.count || 0) + 1
				: 1
			sessionStorage.setItem(NAV_LOOP_KEY, JSON.stringify({ key, at: now, count }))
			return count
		} catch {
			// 存储不可用：不做保护，正常放行
			return 1
		}
	}

	window.__PABridge = {
		get ready() {
			return state.ready
		},
		// 只读探针：诊断/测试时想看一眼实例状态，又不想因为 ensureAgent 触发重建
		get agent() {
			return state.agent
		},
		ensureAgent,
	}

	// AI 执行前先确认 DOM 就绪，再通知宿主
	function boot() {
		const loads = trackLoad()
		if (loads >= NAV_LOOP_LIMIT) {
			// 不再创建 Agent / 面板：这个地址在反复重载，继续跑只会空烧调用额度
			post({ type: 'nav-loop', count: loads, url: location.pathname + location.search })
			return
		}
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
