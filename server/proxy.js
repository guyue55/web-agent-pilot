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
import { checkProxyTarget, resolveAddresses, isSafeIpForProxy, safeLookup } from './security.js'
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
	// alt-svc 会把「目标站支持 HTTP/3」的声明搬到我们的源上（h3=":443" 指向本服务），
	// 语义错位且可能让浏览器尝试连一个不存在的 h3 端点 —— 与 jsproxy 的处理一致，直接删掉。
	'alt-svc',
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

// 整体超时必须大于「连接超时 × (重试次数 + 1)」，否则整体计时器会先掐断重试，
// CONNECT_TIMEOUT_MS 调大就完全不起作用。当前：30s × 2 + 重试间隔 ≈ 61s < 70s。
const TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 70_000)
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

// 实测（托管沙箱）：到海外站点的 TCP 连接经常超过 20s，github 单次请求 25~50s 才能完成。
// 20s 的连接超时会把「慢但能通」的站点判成不可达，因此放宽到 30s。
const CONNECT_TIMEOUT = Number(process.env.CONNECT_TIMEOUT_MS || 30_000)

/**
 * 统一出口 fetch：
 *  - 若运行环境配置了 HTTPS_PROXY/HTTP_PROXY，则经由该代理出网（不少服务器 / 沙箱只有代理出口）
 *  - 连接超时放宽到 20s，降低海外站点偶发连接慢导致的失败
 */
const upstreamProxy =
	process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy

/** 直连优先；仅当直连在传输层失败时，才回退到环境里的代理出口 */
const directAgent = new Agent({
	connect: {
		timeout: CONNECT_TIMEOUT,
		// 建连时校验实际要连的 IP：预检解析与建连解析是两次独立查询，
		// 只信预检结果等于给 DNS rebinding 留门（实测可绕过）。
		lookup: safeLookup,
	},
})
const proxyAgent = upstreamProxy ? new ProxyAgent({ uri: upstreamProxy, connect: { timeout: CONNECT_TIMEOUT } }) : null

export const UPSTREAM_PROXY = upstreamProxy ? '<configured>' : null

/** 被安全策略在建连时拦下的错误：绝不能再回退到代理出口重试一遍 */
function isBlockedError(err) {
	let cur = err
	for (let depth = 0; cur && depth < 6; depth++) {
		if (cur.code === 'PA_BLOCKED_TARGET') return true
		cur = cur.cause || cur.errors?.[0] || null
	}
	return false
}

export async function paFetch(url, options = {}) {
	try {
		return await undiciFetch(url, { ...options, dispatcher: directAgent })
	} catch (err) {
		// 安全拦截不是「网络不通」，换条出口重试只会把拦下来的请求放过去
		if (!proxyAgent || isBlockedError(err)) throw err
		// 流式 body 无法二次发送，仅在字符串 body 时回退
		if (options.body != null && typeof options.body !== 'string') throw err
		return await undiciFetch(url, { ...options, dispatcher: proxyAgent })
	}
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

/**
 * 把 undici 的错误链摊平。
 *
 * 双栈环境下（本机有 ::1 与 127.0.0.1）连接失败得到的是 AggregateError，
 * 真正的 code 藏在 `errors[]` 里，`err.cause.code` 是 undefined ——
 * 只看 cause.code 会导致既判不出「可重试」，也只剩一句没有信息量的 `fetch failed`。
 */
function flattenError(err) {
	const seen = new Set()
	const out = []
	const walk = (e, depth) => {
		if (!e || typeof e !== 'object' || seen.has(e) || depth > 3) return
		seen.add(e)
		out.push(e)
		if (Array.isArray(e.errors)) e.errors.forEach((n) => walk(n, depth + 1))
		walk(e.cause, depth + 1)
	}
	walk(err, 0)
	return out
}

function describeNetError(err) {
	const chain = flattenError(err)
	// 取第一个带 code 的节点：它就是真正失败的原因（如 ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT）
	const withCode = chain.find((e) => typeof e?.code === 'string')
	const code = withCode?.code
	// 没有 code 时取最深层的那条 message —— 链条头部永远是笼统的 `fetch failed`，
	// 真正的信息在最内层（例如 `bad port`、`other side closed`）。
	const deepest = chain.filter((e) => typeof e?.message === 'string' && e.message).pop()
	const detail = withCode?.message || deepest?.message || String(err)
	return {
		retryable: Boolean(code) && RETRY_CODES.includes(code),
		message: code ? `${detail} (${code})` : detail,
	}
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/**
 * 目标站不可用时的落地页。
 *
 * 原先只 send 一行纯文本（`目标站点响应超时（>45000ms）`），用户在 iframe 里看到的是
 * 一行没有样式、也没有任何可操作项的灰字，只能自己去刷新。这里给出：发生了什么、
 * 目标站点是谁、以及「重试 / 在新标签页打开原站」两个可点的下一步。
 */
function sendProxyErrorPage(res, { kind, detail, attempts, targetUrl }) {
	const isTimeout = kind === 'timeout'
	const title = isTimeout ? '目标站点响应太慢' : '无法连接到目标站点'
	let host = targetUrl
	try {
		host = new URL(targetUrl).host
	} catch {
		/* targetUrl 不是合法 URL 时直接展示原文 */
	}
	const tried = attempts > 1 ? `已尝试 ${attempts} 次` : '仅尝试 1 次'
	const reason = isTimeout
		? `等待超过 ${Math.round(TIMEOUT_MS / 1000)} 秒仍未收到响应。`
		: '网络层连接失败，通常是目标站不可达或本机出网受限。'

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
	* { box-sizing: border-box; }
	body {
		margin: 0; min-height: 100vh; display: grid; place-items: center;
		background: #f6f7fb; color: #1f2330; padding: 24px;
		font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
	}
	.card { max-width: 520px; width: 100%; background: #fff; border-radius: 16px; padding: 28px 28px 24px;
		box-shadow: 0 12px 40px rgba(20, 24, 40, 0.08); }
	.icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
		color: #fff; font-weight: 700; font-size: 20px; background: linear-gradient(135deg, #ff8a4c, #f4527d); }
	h1 { margin: 16px 0 8px; font-size: 19px; letter-spacing: -0.2px; }
	p { margin: 0 0 6px; color: #5a6072; }
	.host { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #1f2330;
		background: #f2f4f9; border-radius: 6px; padding: 1px 6px; word-break: break-all; }
	.detail { margin-top: 14px; font-size: 12px; color: #8b90a0; word-break: break-all; }
	.actions { margin-top: 22px; display: flex; gap: 10px; flex-wrap: wrap; }
	button, a.btn { appearance: none; border: 0; cursor: pointer; font: inherit; font-size: 14px;
		padding: 9px 18px; border-radius: 10px; text-decoration: none; display: inline-flex; align-items: center; }
	button { background: linear-gradient(135deg, #6b7cff, #8f6bff); color: #fff; font-weight: 600; }
	a.btn { background: #eef0f7; color: #3b4157; }
</style>
</head>
<body>
	<div class="card">
		<div class="icon">!</div>
		<h1>${escapeHtml(title)}</h1>
		<p>目标站点 <span class="host">${escapeHtml(host)}</span> ${escapeHtml(reason)}</p>
		<p style="font-size:13px;color:#8b90a0">${escapeHtml(tried)}${isTimeout ? '' : '，每次连接上限 ' + Math.round(CONNECT_TIMEOUT / 1000) + ' 秒'}</p>
		<p class="detail">${escapeHtml(detail || '')}</p>
		<div class="actions">
			<button type="button" onclick="location.reload()">重试</button>
			<a class="btn" href="${escapeHtml(targetUrl)}" target="_blank" rel="noreferrer noopener">在新标签页打开原站</a>
		</div>
	</div>
</body>
</html>`

	res.status(502)
	res.setHeader('cache-control', 'no-store')
	res.type('text/html; charset=utf-8').send(html)
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

	let controller = new AbortController()
	let timedOut = false
	let method = req.method.toUpperCase()
	if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) method = 'GET'

	let body
	if (!['GET', 'HEAD'].includes(method)) {
		body = Readable.toWeb(req)
	}

	let upstream
	let attempt = 0
	let lastError = null
	// 每次重试都重建计时器与 AbortController：
	//  · 被 clear 的 Timeout 无法 refresh 复活（实测），重试会彻底失去超时保护；
	//  · 已经 abort 过的 signal 永久处于 aborted，复用同一个 controller 会让重试请求立刻失败。
	// timedOut 用显式标志而不是去猜 AbortError 的形状 —— 判定「谁掐断的」必须确定。
	const armTimer = () =>
		setTimeout(() => {
			timedOut = true
			controller.abort()
		}, TIMEOUT_MS)
	let timer = armTimer()
	while (attempt < RETRY_TIMES + 1) {
		attempt++
		timedOut = false
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
			// 整体超时不重试：两次都跑满 TIMEOUT_MS 会让用户干等两倍时长；
			// 真正需要靠重试救回的是「连接超时」（由 CONNECT_TIMEOUT_MS 控制、已计入 RETRY_CODES）。
			if (timedOut) {
				lastError = `等待响应超过 ${Math.round(TIMEOUT_MS / 1000)} 秒`
				break
			}
			const info = describeNetError(err)
			lastError = info.message
			if (!info.retryable || attempt > RETRY_TIMES || method !== 'GET') break
			clearTimeout(timer)
			await sleep(400 * attempt)
			// GET 重试：换一副新的 signal，重开超时窗口
			controller = new AbortController()
			timer = armTimer()
		}
	}
	clearTimeout(timer)
	if (!upstream) {
		sendProxyErrorPage(res, {
			kind: timedOut ? 'timeout' : 'network',
			detail: lastError,
			attempts: attempt,
			targetUrl: targetUrl.href,
		})
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

/**
 * 目标主机是否允许代理（预检：解析 DNS 后校验目标 IP）
 *
 * 注意这**不是**完整的 rebinding 防护：这里是第一次解析，真正建连时
 * Node / undici 会再解析一次。连接路径上的兜底在 security.safeLookup。
 */
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
