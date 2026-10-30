/**
 * 网页反向代理核心
 * 目标：
 *  1. 抹掉 X-Frame-Options / CSP frame-ancestors —— 让任意站点可 iframe 同源嵌入
 *  2. 重写资源链接，使页面内的 CSS/JS/图片/表单/XHR 全部回流到本服务
 *  3. 服务端 CookieJar，保留登录态
 */
import { Readable } from 'node:stream'
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { getJar, storeCookies, buildCookieHeader } from './cookieJar.js'
import {
	rewriteHtml,
	rewriteCss,
	encodeProxyUrl,
	decodeProxyUrl,
	stripShare,
	PROXY_PREFIX,
	SHARE_PARAM,
} from './rewrite.js'
import { checkProxyTarget, resolveAddresses, isSafeIpForProxy } from './security.js'
import { rememberTarget, getRememberedTarget } from './sessionState.js'

const HOP_BY_HOP = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]

/** 影响 / _pa 同源嵌入或已失效的响应头 */
const STRIP_RESPONSE_HEADERS = [
	'x-frame-options',
	'content-security-policy',
	'content-security-policy-report-only',
	'strict-transport-security',
	'cross-origin-opener-policy',
	'cross-origin-embedder-policy',
	'cross-origin-resource-policy',
	'clear-site-data',
	'content-length',
	'content-encoding',
	'set-cookie',
	'location',
	'public-key-pins',
	'expect-ct',
	'nel',
	'report-to',
]

const STRIP_REQUEST_HEADERS = [
	'host',
	'cookie',
	'x-frame-options',
	'sec-fetch-site', // 让目标站认为这是一次正常的 same-site 之外的直接访问
	'sec-fetch-dest', // 避免目标站据此判定"被嵌在 iframe 中"而降级或拒绝响应
	'accept-encoding', // 交由 node fetch 自行协商，避免二次压缩
]

const DEFAULT_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 45_000)
const RETRY_CODES = [
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET',
	'ECONNRESET',
	'ECONNREFUSED',
	'EAI_AGAIN',
	'ETIMEDOUT',
	'EPIPE',
]
const RETRY_TIMES = Number(process.env.PROXY_RETRY || 1)

const CONNECT_TIMEOUT = Number(process.env.CONNECT_TIMEOUT_MS || 20_000)

/**
 * 统一出口 fetch：
 *  - 若运行环境配置了 HTTPS_PROXY/HTTP_PROXY，则经由该代理出网（不少服务器 / 沙箱只有代理出口）
 *  - 连接超时放宽到 20s，降低海外站点偶发连接慢导致的失败
 */
const upstreamProxy =
	process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy

/** 直连优先；仅当直连在传输层失败时，才回退到环境里的代理出口 */
const directAgent = new Agent({ connect: { timeout: CONNECT_TIMEOUT } })
const proxyAgent = upstreamProxy ? new ProxyAgent({ uri: upstreamProxy, connect: { timeout: CONNECT_TIMEOUT } }) : null

export const UPSTREAM_PROXY = upstreamProxy ? '<configured>' : null

export async function paFetch(url, options = {}) {
	try {
		return await undiciFetch(url, { ...options, dispatcher: directAgent })
	} catch (err) {
		if (!proxyAgent) throw err
		// 流式 body 无法二次发送，仅在字符串 body 时回退
		if (options.body != null && typeof options.body !== 'string') throw err
		return await undiciFetch(url, { ...options, dispatcher: proxyAgent })
	}
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

function describeNetError(err) {
	const cause = err.cause || err
	const code = cause?.code || err.code
	return {
		retryable: Boolean(code) && RETRY_CODES.includes(code),
		message: code ? `${cause?.message || err.message} (${code})` : err.message,
	}
}

function pick(value) {
	return Array.isArray(value) ? value : [value]
}

function buildRequestHeaders(req, jar, cookieHeader) {
	const headers = new Headers()
	for (const [key, value] of Object.entries(req.headers)) {
		const lower = key.toLowerCase()
		if (STRIP_REQUEST_HEADERS.includes(lower)) continue
		if (HOP_BY_HOP.includes(lower)) continue
		if (value === undefined) continue
		headers.set(key, pick(value).join(', '))
	}
	if (cookieHeader) headers.set('cookie', cookieHeader)
	headers.set('accept', req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8')
	// 缺省 UA（脚本调用 / 老浏览器）时补齐，避免被目标站按空 UA 拒绝
	if (!headers.get('user-agent')) headers.set('user-agent', DEFAULT_UA)
	if (!headers.get('accept-language')) headers.set('accept-language', 'zh-CN,zh;q=0.9,en;q=0.8')
	return headers
}

function isTextHtml(contentType = '') {
	return /text\/html|application\/xhtml\+xml/i.test(contentType)
}
function isCss(contentType = '') {
	return /text\/css/i.test(contentType)
}

function detectCharset(contentType = '') {
	const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)
	return m ? m[1] : 'utf-8'
}

function applyResponseHeaders(res, upstream) {
	for (const [key, value] of upstream.headers.entries()) {
		const lower = key.toLowerCase()
		if (STRIP_RESPONSE_HEADERS.includes(lower)) continue
		if (HOP_BY_HOP.includes(lower)) continue
		try {
			res.setHeader(key, value)
		} catch {
			/* 忽略非法头 */
		}
	}
}

/**
 * 主代理入口
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {URL} targetUrl 真实目标 URL
 */
export async function proxyRequest(req, res, targetUrl) {
	const sessionId = req.cookies?.pa_sid || 'default'
	const jar = getJar(sessionId)
	// 部署在带访问码校验的网关后面时，子请求也必须带上访问码
	const share = req.query?.[SHARE_PARAM] ? String(req.query[SHARE_PARAM]) : ''

	const cookieHeader = await buildCookieHeader(jar, targetUrl.href)
	const headers = buildRequestHeaders(req, jar, cookieHeader)

	// Referer：让目标站看到真实来源
	const originalReferer = headers.get('referer')
	if (originalReferer) {
		const refererTarget = decodeProxyUrl(new URL(originalReferer).pathname + new URL(originalReferer).search)
		if (refererTarget) headers.set('referer', refererTarget.href)
		else headers.delete('referer')
	}
	const refererForBase = originalReferer ? new URL(originalReferer) : null

	const controller = new AbortController()
	let method = req.method.toUpperCase()
	if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) method = 'GET'

	let body
	if (!['GET', 'HEAD'].includes(method)) {
		body = Readable.toWeb(req)
	}

	let upstream
	let attempt = 0
	let lastError = null
	// 每次重试都重建计时器：
	// 此前在 catch 里 clearTimeout 后再 timer.refresh()，实测 Node 中被 clear 的 Timeout
	// 无法被 refresh 复活，导致重试请求没有任何超时保护（可无限挂起，直到客户端断开）。
	const armTimer = () => setTimeout(() => controller.abort(), TIMEOUT_MS)
	let timer = armTimer()
	while (attempt < RETRY_TIMES + 1) {
		attempt++
		try {
			upstream = await paFetch(targetUrl.href, {
				method,
				headers,
				body: attempt === 1 ? body : undefined, // 重试时请求流已消费，仅重试无 body 请求
				redirect: 'manual',
				duplex: 'half',
				signal: controller.signal,
			})
			break
		} catch (err) {
			if (err.name === 'AbortError' && Object.prototype.hasOwnProperty.call(err, 'cause') === false) {
				clearTimeout(timer)
				res.status(502).type('text/plain; charset=utf-8').send(`目标站点响应超时（>${TIMEOUT_MS}ms）`)
				return
			}
			const info = describeNetError(err)
			lastError = info.message
			if (!info.retryable || attempt > RETRY_TIMES || method !== 'GET') break
			await sleep(400 * attempt)
			// GET 重试：重开超时窗口
			clearTimeout(timer)
			timer = armTimer()
		}
	}
	clearTimeout(timer)
	if (!upstream) {
		res
			.status(502)
			.type('text/plain; charset=utf-8')
			.send(`无法连接目标站点：${lastError || '未知错误'}（已重试 ${attempt} 次）`)
		return
	}

	// Cookie 存入服务端 jar，浏览器侧无需感知
	const setCookies = upstream.headers.getSetCookie?.() ?? []
	await storeCookies(jar, setCookies, targetUrl.href)

	// 记住该会话最近代理的目标站点：目标站 JS 发出的同源绝对路径请求
	// （如 location.href='/s?wd=x'，无法在注入层改写）到达服务端时若缺少
	// 可解析 Referer，兜底路由可据此还原目标站点，避免 404
	rememberTarget(sessionId, targetUrl)

	// 重定向：改写 Location 交回浏览器，让 iframe 地址栏同步更新
	const location = upstream.headers.get('location')
	if (location) {
		try {
			const resolved = new URL(location, targetUrl.href)
			res.status(upstream.status)
			res.setHeader('location', encodeProxyUrl(resolved, share))
			applyResponseHeaders(res, upstream)
			res.end()
			return
		} catch {
			/* fallthrough */
		}
	}

	res.status(upstream.status)
	applyResponseHeaders(res, upstream)

	const contentType = upstream.headers.get('content-type') || ''
	if (isTextHtml(contentType) && method !== 'HEAD') {
		const charset = detectCharset(contentType)
		const buf = await upstream.arrayBuffer()
		let text
		try {
			text = new TextDecoder(charset).decode(buf)
		} catch {
			text = new TextDecoder('utf-8').decode(buf)
		}
		const rewritten = rewriteHtml(text, targetUrl, '/_app/bridge.js', share)
		res.setHeader('content-length', Buffer.byteLength(rewritten))
		res.type(contentType || 'text/html; charset=utf-8')
		res.send(rewritten)
		return
	}

	if (isCss(contentType) && method !== 'HEAD') {
		const buf = await upstream.arrayBuffer()
		const text = new TextDecoder(detectCharset(contentType)).decode(buf)
		const rewritten = rewriteCss(text, targetUrl, share)
		res.setHeader('content-length', Buffer.byteLength(rewritten))
		res.type(contentType)
		res.send(rewritten)
		return
	}

	if (method === 'HEAD' || !upstream.body) {
		res.end()
		return
	}
	Readable.fromWeb(upstream.body)
		.on('error', () => res.destroy())
		.pipe(res)
}

/**
 * 兜底路由：目标站内 JS 发出的同源绝对路径请求（如 fetch('/api/x')）
 * 通过 Referer 还原所属站点后补上代理前缀。
 */
export function resolveFallbackTarget(req) {
	const referer = req.headers.referer
	if (!referer) return null
	let refererUrl
	try {
		refererUrl = new URL(referer, `http://${req.headers.host}`)
	} catch {
		return null
	}
	const base = decodeProxyUrl(refererUrl.pathname + refererUrl.search)
	if (!base) return null
	const err = checkProxyTarget(base.protocol, base.hostname)
	if (err) return { error: err }
	try {
		// 页面内的同源绝对路径（如 /api/list?x=1）挂到目标站点根下；访问码不属于目标站，需剔除
		return { url: new URL(base.origin + stripShare(refererReqPath(req))) }
	} catch {
		return null
	}
}

function refererReqPath(req) {
	const p = req.originalUrl || '/'
	return p.startsWith('/') ? p : `/${p}`
}

/**
 * 统一兜底解析：优先用 Referer 还原目标站点；Referer 缺失或不可解析时，
 * 回退到「会话最近代理的目标 origin」+ 当前请求路径。
 *
 * 覆盖场景（此前均会 404）：
 *  - 目标站 JS `location.href = '/path?...'`（location 不可覆写，注入层拦不住）
 *  - 动态 form.submit()（如百度 virtual-form），且页面声明 no-referrer / 仅 origin
 */
export function resolveFallbackRequest(req) {
	const referer = req.headers.referer
	if (referer && referer.includes(PROXY_PREFIX)) {
		const viaReferer = resolveFallbackTarget(req)
		if (viaReferer) return viaReferer
	}
	const remembered = getRememberedTarget(req.cookies?.pa_sid || 'default')
	if (!remembered) return null
	try {
		// 访问码不属于目标站，需剔除；路径为站内同源绝对路径，直接挂到目标 origin
		return { url: new URL(remembered.origin + stripShare(refererReqPath(req))), via: 'session' }
	} catch {
		return null
	}
}

/** 目标主机是否允许代理（二次 DNS 校验，防 DNS rebinding） */
export async function assertTargetSafe(targetUrl) {
	const err = checkProxyTarget(targetUrl.protocol, targetUrl.hostname)
	if (err) return err
	const addresses = await resolveAddresses(targetUrl.hostname)
	if (addresses.length && !addresses.some((ip) => isSafeIpForProxy(ip))) {
		return '目标地址被安全策略拦截'
	}
	return null
}

export { PROXY_PREFIX }
