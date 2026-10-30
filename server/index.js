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
	paFetch,
	UPSTREAM_PROXY,
} from './proxy.js'
import { validateTargetUrl } from './security.js'

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
	req.cookies = {}
	const raw = req.headers.cookie
	if (raw) {
		for (const part of raw.split(';')) {
			const idx = part.indexOf('=')
			if (idx === -1) continue
			const key = part.slice(0, idx).trim()
			if (!key) continue
			const value = part.slice(idx + 1).trim()
			try {
				req.cookies[key] = value ? decodeURIComponent(value) : value
			} catch {
				req.cookies[key] = value
			}
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
	res.json({ ok: true, time: new Date().toISOString(), node: process.version, upstreamProxy: UPSTREAM_PROXY })
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
		console.warn(
			`[llm-proxy] ${targetUrl.href} -> HTTP ${upstream.status} reqBytes=${
				(req.headers['content-length'] ?? '?')
			}\n${body.slice(0, 600)}`
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


app.get(['/', '/index.html'], (_req, res) => {
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

/** 文档级导航（iframe / 主文档跳转），区别于 fetch / XHR 这类子资源请求 */
function isNavigationRequest(req) {
	const mode = String(req.headers['sec-fetch-mode'] || '')
	if (mode) return mode === 'navigate'
	const dest = String(req.headers['sec-fetch-dest'] || '')
	if (dest) return dest === 'document' || dest === 'iframe'
	// 无 Fetch Metadata（老浏览器）时按 Accept 兜底
	return String(req.headers.accept || '').includes('text/html')
}

/**
 * 兜底路由：目标站内 JS 动态提交 / 赋值的同源路径（如 /s?wd=xxx）。
 * 优先从 Referer（被代理页面）还原目标站点；Referer 缺失或不可解析时，
 * 回退到「该会话最近代理的目标站点」（见 resolveFallbackRequest），
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
	// 相对路径也会围绕本站根解析。子资源请求（fetch / XHR）不能重定向，否则会破坏调用方，
	// 因此只把导航类请求 307（保留方法与请求体）到代理路径。
	if (isNavigationRequest(req)) {
		const share = req.query?.[SHARE_PARAM] ? String(req.query[SHARE_PARAM]) : ''
		res.setHeader('cache-control', 'no-store')
		return res.redirect(307, encodeProxyUrl(result.url, share))
	}

	try {
		await proxyRequest(req, res, result.url)
	} catch (err2) {
		res.status(502).type('text/plain; charset=utf-8').send(`代理失败：${err2.message}`)
	}
})

app.use((req, res) => {
	res
		.status(404)
		.type('text/plain; charset=utf-8')
		.send(`404 Not Found（${req.method} ${req.path}）`)
})

// express 4 错误处理兜底
app.use((err, _req, res, _next) => {
	console.error('[server] error:', err)
	if (!res.headersSent) res.status(500).json({ error: err.message })
})

app.listen(PORT, '0.0.0.0', () => {
	console.log(`\n  🚀 万能网页操作 Agent 已启动： http://0.0.0.0:${PORT}\n`)
})
