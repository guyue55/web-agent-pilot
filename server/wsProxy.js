/**
 * WebSocket 隧道：/__paws/<scheme>/<host>/<path>
 *
 * 为什么单独做：WebSocket 走 HTTP Upgrade，Express 的普通路由接不到，
 * 必须在 http.Server 的 'upgrade' 事件上处理。
 *
 * 实现思路（零依赖）：WebSocket 握手完成后就是一条普通 TCP 字节流，
 * 所以这里不解析帧、不做协议感知，只把客户端与目标站之间的字节双向透传。
 * 好处是 permessage-deflate / 子协议 / 二进制帧全都端到端保持原样，
 * 不需要引入 ws 之类的库，也不会因为帧处理出错而破坏协议。
 *
 * 安全：与 HTTP 代理共用同一套 SSRF 校验（协议白名单 + 私网/本机地址限制）。
 */
import net from 'node:net'
import tls from 'node:tls'

import { decodeProxyUrl, PROXY_PREFIX } from './rewrite.js'
import { validateTargetUrl } from './security.js'
import { getJar, buildCookieHeader } from './cookieJar.js'

export const WS_PREFIX = '/__paws/'

const CONNECT_TIMEOUT_MS = Number(process.env.WS_CONNECT_TIMEOUT_MS) || 15000

/** 需要从客户端头部里剔除的：逐跳头部与本应用内部头部 */
const DROP_HEADERS = new Set([
	'host',
	'origin',
	'cookie',
	'connection',
	'upgrade',
	'keep-alive',
	'proxy-connection',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'sec-websocket-extensions',
	'x-forwarded-for',
	'x-forwarded-host',
	'x-forwarded-proto',
])

/** 从原始 Cookie 头里取 pa_sid（upgrade 不走 Express 中间件，拿不到 req.cookies） */
function readSessionId(rawCookie) {
	if (!rawCookie) return null
	for (const part of String(rawCookie).split(';')) {
		const idx = part.indexOf('=')
		if (idx === -1) continue
		if (part.slice(0, idx).trim() !== 'pa_sid') continue
		try {
			return decodeURIComponent(part.slice(idx + 1).trim())
		} catch {
			return part.slice(idx + 1).trim()
		}
	}
	return null
}

function reject(socket, status, text) {	try {
		socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
	} catch {
		/* noop */
	}
	try {
		socket.destroy()
	} catch {
		/* noop */
	}
}

/**
 * 用「客户端原始握手」拼出到目标站的握手请求：
 * Sec-WebSocket-Key 必须原样保留，否则目标站算出的 Accept 与客户端对不上，握手直接失败。
 */
function buildHandshake(req, target, cookieHeader) {
	const path = `${target.pathname}${target.search}` || '/'
	const lines = [`GET ${path} HTTP/1.1`]

	const raw = req.rawHeaders || []
	for (let i = 0; i < raw.length; i += 2) {
		const name = raw[i]
		const value = raw[i + 1]
		if (DROP_HEADERS.has(name.toLowerCase())) continue
		lines.push(`${name}: ${value}`)
	}

	lines.push(`Host: ${target.host}`)
	// 部分站点校验 Origin，改写成目标站自己的源，避免被判定为跨站而拒绝
	lines.push(`Origin: ${target.protocol}//${target.host}`)
	if (cookieHeader) lines.push(`Cookie: ${cookieHeader}`)
	lines.push('Connection: Upgrade')
	lines.push('Upgrade: websocket')

	return lines.join('\r\n') + '\r\n\r\n'
}

function pipeOnce(target, req, socket, head) {
	const secure = target.protocol === 'https:'
	const port = Number(target.port || (secure ? 443 : 80))
	const hostname = target.hostname.replace(/^\[|\]$/g, '')

	let upstream
	try {
		upstream = secure
			? tls.connect({
					host: hostname,
					port,
					servername: target.hostname, // SNI 必须是域名，否则很多站点直接断
					rejectUnauthorized: false, // 代理场景不校验上游证书（目标站证书问题不该挡住用户）
				})
			: net.connect({ host: hostname, port })
	} catch {
		return reject(socket, 502, 'Bad Gateway')
	}

	const timer = setTimeout(() => {
		try {
			upstream.destroy()
		} catch {
			/* noop */
		}
		reject(socket, 504, 'Gateway Timeout')
	}, CONNECT_TIMEOUT_MS)

	const onReady = async () => {
		clearTimeout(timer)
		try {
			socket.setNoDelay(true)
			upstream.setNoDelay(true)
		} catch {
			/* noop */
		}

		let cookieHeader = ''
		try {
			// 注意：upgrade 事件不经过 Express 中间件，req.cookies 此时是空的，
			// 必须自己从原始 Cookie 头里取 pa_sid，否则登录态在这个页面上会「消失」
			const sid = readSessionId(req.headers.cookie)
			if (sid) cookieHeader = await buildCookieHeader(getJar(sid), target.href)
		} catch {
			/* Cookie 只是加分项，取不到就匿名握手 */
		}

		try {
			upstream.write(buildHandshake(req, target, cookieHeader))
			if (head && head.length) upstream.write(head)
		} catch {
			reject(socket, 502, 'Bad Gateway')
			return
		}

		// 握手之后就是纯字节流：双向直通
		upstream.pipe(socket)
		socket.pipe(upstream)
	}

	upstream.once(secure ? 'secureConnect' : 'connect', onReady)
	upstream.on('error', () => reject(socket, 502, 'Bad Gateway'))
	socket.on('error', () => upstream.destroy())
	// 客户端主动断开时，及时释放到目标站的连接，避免连接泄漏
	socket.on('close', () => upstream.destroy())
	upstream.on('close', () => socket.destroy())
}

/**
 * 挂到 http.Server 上。非 /__paws 的升级请求一律拒绝（本应用不提供其它 WS 服务）。
 */
export function attachWsProxy(server) {
	server.on('upgrade', (req, socket, head) => {
		if (!req.url || !req.url.startsWith(WS_PREFIX)) {
			return reject(socket, 404, 'Not Found')
		}
		let target = null
		try {
			target = decodeProxyUrl(req.url.replace(WS_PREFIX, PROXY_PREFIX))
		} catch {
			target = null
		}
		if (!target) return reject(socket, 400, 'Bad Request')

		validateTargetUrl(target.href)
			.then((result) => {
				if (!result?.ok) return reject(socket, 403, 'Forbidden')
				pipeOnce(target, req, socket, head)
			})
			.catch(() => reject(socket, 403, 'Forbidden'))
	})
}
