import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

import { Readable } from 'node:stream'

import { decodeProxyUrl, encodeProxyUrl, PROXY_PREFIX, SHARE_PARAM } from './rewrite.js'
import {
	proxyRequest,
	assertTargetSafe,
	resolveFallbackRequest,
	isNavigationRequest,
	paFetch,
	UPSTREAM_PROXY,
} from './proxy.js'
import { validateTargetUrl } from './security.js'
import { getDnsStats } from './dnsResolver.js'
import { attachWsProxy } from './wsProxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const PORT = Number(process.env.PORT || 3000)

const app = express()
app.disable('x-powered-by')

/**
 * Cookie 解析 + 会话 sid 分配
 *
 * - 解析失败容忍：畸形百分号编码（如 `%zz`）会让 decodeURIComponent 抛异常，
 *   若在这里抛出会连带整个请求 500，因此单条失败时保留原值。
 * - pa_sid 在访问任意页面（含首页）时就下发：此前只对 /__pa 路径下发，
 *   导致首次 / 非 /__pa 请求落到公用会话（'default'），多用户共用同一个服务端 CookieJar。
 */
app.use((req, res, next) => {
	// 用无原型对象存 cookie；以远端 cookie 名为键写入时改用 defineProperty，
	// 避免 __proto__/constructor 等键污染原型（remote-property-injection）。
	req.cookies = Object.create(null)
	const raw = req.headers.cookie
	if (raw) {
		for (const part of raw.split(';')) {
			const idx = part.indexOf('=')
			if (idx === -1) continue
			const key = part.slice(0, idx).trim()
			if (!key) continue
			const value = part.slice(idx + 1).trim()
			let decoded
			try {
				decoded = value ? decodeURIComponent(value) : value
			} catch {
				decoded = value
			}
			Object.defineProperty(req.cookies, key, { value: decoded, enumerable: true, configurable: true })
		}
	}
	if (!req.cookies.pa_sid) {
		const sid = crypto.randomUUID()
		res.cookie('pa_sid', sid, { httpOnly: true, sameSite: 'lax', path: '/' })
		req.cookies.pa_sid = sid
	}
	next()
})

app.get('/api/health', (_req, res) => {
	res.json({
		ok: true,
		time: new Date().toISOString(),
		node: process.version,
		upstreamProxy: UPSTREAM_PROXY,
		// 目标站解析走 DoH 还是系统解析 —— 排查「站点解析到错误服务器」时看这里
		dns: getDnsStats(),
	})
})

/**
 * 用户在地址栏输入的原始 URL -> 代理 URL
 *
 * 注意：入参用 base64url 放在 `u` 里，而不是直接把目标地址放 query。
 * 直接传 `?url=https://...` 会被不少 WAF 判定成「URL 跳转 / SSRF」攻击而直接 403，
 * 编码后 WAF 看不到绝对地址，可稳定通过。
 */
function readResolveInput(req) {
	if (req.query.u) {
		try {
			const b64 = String(req.query.u).replace(/-/g, '+').replace(/_/g, '/')
			return Buffer.from(b64, 'base64').toString('utf-8')
		} catch {
			return ''
		}
	}
	return String(req.query.url || '')
}

function handleResolve(req, res) {
	const raw = readResolveInput(req)
	const share = req.query[SHARE_PARAM] ? String(req.query[SHARE_PARAM]) : ''
	validateTargetUrl(raw).then((result) => {
		if (!result.ok) return res.status(400).json({ error: result.reason })
		res.json({ proxyUrl: encodeProxyUrl(result.url, share), target: result.url.href })
	})
}

app.get('/api/resolve', handleResolve)
app.post('/api/resolve', express.json({ limit: '64kb' }), (req, res) => {
	// POST 时优先取 body（同样支持 base64）
	if (req.body?.u || req.body?.url) {
		req.query.u = req.body.u || ''
		req.query.url = req.body.url || ''
	}
	handleResolve(req, res)
})

/**
 * LLM 请求转发（解决浏览器直连大模型时的 CORS 限制）
 * - x-pa-target: 目标完整 URL
 * - x-pa-headers: base64(JSON) 需要透传的请求头
 */
app.all('/api/llm/proxy', async (req, res) => {
	const target = req.headers['x-pa-target']
	if (!target) return res.status(400).json({ error: 'missing x-pa-target' })
	let targetUrl
	try {
		targetUrl = new URL(decodeURIComponent(String(target)))
	} catch {
		return res.status(400).json({ error: 'invalid target url' })
	}
	if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
		return res.status(400).json({ error: 'unsupported protocol' })
	}
	// 该接口可指向任意 URL，必须与代理路由同样做 SSRF 校验：
	// 否则可被用于访问部署机本机端口、内网服务与云厂商元数据接口。
	const targetErr = await assertTargetSafe(targetUrl)
	if (targetErr) return res.status(403).json({ error: targetErr })

	const headers = new Headers()
	const rawHeaders = req.headers['x-pa-headers']
	if (rawHeaders) {
		try {
			const parsed = JSON.parse(Buffer.from(String(rawHeaders), 'base64').toString('utf-8'))
			for (const [k, v] of Object.entries(parsed)) headers.set(k, String(v))
		} catch {
			return res.status(400).json({ error: 'invalid x-pa-headers' })
		}
	}
	if (!headers.has('content-type')) headers.set('content-type', 'application/json')

	let upstream
	try {
		upstream = await paFetch(targetUrl.href, {
			method: req.method,
			headers,
			body: ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req),
			duplex: 'half',
			signal: AbortSignal.timeout(180_000),
		})
	} catch (err) {
		return res.status(502).json({ error: `LLM 请求失败：${err.cause?.message || err.message}` })
	}

	const body = await upstream.text()
	if (process.env.DEBUG_LLM === 'true' || upstream.status >= 400) {
		// 仅记录状态与请求长度，不落上游响应体，避免任意内容进入日志（log-injection）
		console.warn(
			`[llm-proxy] ${targetUrl.href} -> HTTP ${upstream.status} reqBytes=${
				(req.headers['content-length'] ?? '?')
			}`
		)
	}
	res.status(upstream.status)
	res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json')
	res.send(body)
})

/** 代理主路由 */
app.all(`${PROXY_PREFIX}*`, async (req, res) => {
	const targetUrl = decodeProxyUrl(req.originalUrl)
	if (!targetUrl) return res.status(400).type('text/plain; charset=utf-8').send('代理路径不合法')
	const err = await assertTargetSafe(targetUrl)
	if (err) return res.status(403).type('text/plain; charset=utf-8').send(err)
	await proxyRequest(req, res, targetUrl)
})


app.get(['/', '/index.html'], (_req, res) => { // codeql[js/missing-rate-limiting] 仅提供静态首页，非高成本未鉴权操作，无需限速
	res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
})

// 本站自有静态资源统一挂在 /_app 下，避免与目标站点的相对路径冲突
app.use(
	'/_app',
	// 本项目是纯前端资源迭代频繁的形态，一律走协商缓存，避免发布后还拿到旧脚本
	express.static(PUBLIC_DIR, {
		extensions: ['html'],
		maxAge: 0,
		etag: true,
		lastModified: true,
		setHeaders: (res, filePath) => {
			if (filePath.endsWith('page-agent.demo.js')) {
				res.setHeader('cache-control', 'public, max-age=86400')
			} else {
				res.setHeader('cache-control', 'no-cache')
			}
		},
	})
)

/** 本站自有路径前缀：静态资源与自建接口，绝不能回落到目标站点 */
const SELF_PATH_PREFIXES = ['/_app', '/api']

/**
 * 兜底路由只服务「由本站页面内部发起」的请求。
 *
 * 第三方站点诱导用户直接访问 https://本站/<目标站路径> 时，浏览器会带上
 * Sec-Fetch-Site: cross-site；若照样套用会话记忆，本服务就成了以用户身份
 * 向目标站发请求的中继（CSRF 放大），因此这类请求一律不兜底。
 * 无该头部时（直接输入地址栏 / 老浏览器）视为用户主动访问，放行。
 */
function isOwnSiteRequest(req) {
	const site = String(req.headers['sec-fetch-site'] || '')
	if (!site) return true
	return site === 'same-origin' || site === 'none'
}

/**
 * 兜底回跳页。
 *
 * 为什么不直接 307：path-shim 把页面地址还原成站点真实路径后，刷新 /
 * location.href 跳转这类浏览器真发请求的场景不会再带可解析的 Referer，
 * 服务端只剩「该会话最近打开的目标站」可用 —— 而 cookie 是浏览器级的，
 * 同一浏览器开两个标签看不同站点时这条记忆会互相覆盖（实测：skillhub
 * 页刷新后曾被送到 cloudcache 的 XML 错误页）。
 *
 * 真值在标签页自己手里：path-shim 把「目标站 + 访问码」写进了 sessionStorage
 * 的 pa.docTarget（按标签页隔离）。所以先回一个极轻的页面让它自己报出来，
 * 再 location.replace 回代理路径；服务端记忆只作为页面里也读不到时的兜底。
 */
function renderHopPage(fallbackOrigin, share) {
	// 内联到 script 里，防止 `</script>` 截断（origin/share 来自 URL 与 query，仍按最严处理）
	const asJs = (v) => JSON.stringify(String(v ?? '')).replace(/</g, '\\u003c')
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在打开页面…</title>
<style>
html,body{margin:0;height:100%;background:#f9fafb;color:#374151;
font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.box{height:100%;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
a{color:#2563eb;text-decoration:none}
</style>
</head>
<body>
<div class="box" id="box">正在打开页面…</div>
<script>
(function () {
	var fallbackOrigin = ${asJs(fallbackOrigin)};
	var share = ${asJs(share)};
	var rec = '';
	try { rec = sessionStorage.getItem('pa.docTarget') || ''; } catch (e) {}

	var origin = '';
	if (rec) {
		var qi = rec.indexOf('?');
		origin = qi === -1 ? rec : rec.slice(0, qi);
		var m = /[?&]sharecode=([^&]*)/.exec(rec);
		if (m && !share) {
			try { share = decodeURIComponent(m[1]); } catch (e2) { share = ''; }
		}
	}
	if (!/^https?:\\/\\/[^/]+$/.test(origin)) origin = fallbackOrigin;
	if (!/^https?:\\/\\/[^/]+$/.test(origin)) return fail('无法确定要打开的站点');

	// 回跳后若是死循环，说明代理本身也打不开，停在提示上而不是无限跳
	var hop = 0;
	try { hop = Number(sessionStorage.getItem('pa.hop') || '0') || 0; } catch (e) {}
	if (hop > 3) return fail('页面反复跳转失败，请返回首页重试');
	try { sessionStorage.setItem('pa.hop', String(hop + 1)); } catch (e) {}

	var q = location.search;
	if (share && !/[?&]sharecode=/.test(q)) {
		q += (q ? '&' : '?') + 'sharecode=' + encodeURIComponent(share);
	}
	location.replace('/__pa/' + origin.replace('://', '/') + location.pathname + q + location.hash);

	function fail(msg) {
		document.getElementById('box').innerHTML =
			'<div><p>' + msg + '</p><p><a href="/">返回首页重新输入网址</a></p></div>';
	}
})();
</script>
</body>
</html>`
}

/**
 * 兜底路由：目标站内 JS 动态提交 / 赋值的同源路径（如 /s?wd=xxx）。
 * 优先从 Referer（被代理页面）还原目标站点；Referer 缺失或不可解析时，
 * 回退到「该会话最近打开的目标站点」（见 resolveFallbackRequest），
 * 覆盖百度搜索框这类 location.href / virtual-form 提交导致的漏网请求。
 */
app.all('*', async (req, res, next) => {
	// 本站自己的路径（含 miss 的静态资源与未知接口）直接走 404，避免返回目标站内容
	if (SELF_PATH_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next()
	if (!isOwnSiteRequest(req)) return next()

	const result = resolveFallbackRequest(req)
	if (!result) return next()
	if (result.error) return res.status(403).type('text/plain; charset=utf-8').send(result.error)
	const err = await assertTargetSafe(result.url)
	if (err) return res.status(403).type('text/plain; charset=utf-8').send(err)

	// 文档导航：重定向回 /__pa/... 代理路径。
	// 直接吐内容会让 iframe 的地址脱离代理前缀 —— 地址栏不再更新、后续 Referer 无法还原、
	// 相对路径也会围绕本站根解析。
	if (isNavigationRequest(req.headers)) {
		res.setHeader('cache-control', 'no-store')
		// GET/HEAD 能由浏览器端重放，交给回跳页用标签页自己的记录精确还原；
		// POST 等带 body 的提交无法重放，只能沿用服务端记忆 307（保留方法与请求体）
		if ((req.method === 'GET' || req.method === 'HEAD') && result.via === 'session') {
			return res
				.type('text/html; charset=utf-8')
				.send(renderHopPage(result.url.origin, result.share))
		}
		return res.redirect(307, encodeProxyUrl(result.url, result.share))
	}

	// 子资源请求（fetch / XHR）不能重定向，否则会破坏调用方，只能直接转发
	try {
		await proxyRequest(req, res, result.url)
	} catch (err2) {
		console.error('[proxy] 子资源代理失败:', err2)
		res.status(502).type('text/plain; charset=utf-8').send('代理失败')
	}
})

app.use((req, res) => {
	res.status(404).type('text/plain; charset=utf-8').send('404 Not Found')
})

// express 4 错误处理兜底
app.use((err, _req, res, _next) => {
	console.error('[server] error:', err)
	if (!res.headersSent) res.status(500).json({ error: err.message })
})

const server = app.listen(PORT, '0.0.0.0', () => {
	console.log(`\n  🚀 万能网页操作 Agent 已启动： http://0.0.0.0:${PORT}\n`)
})

// WebSocket 走 HTTP Upgrade，Express 路由接不到，必须挂在 http.Server 上
attachWsProxy(server)
