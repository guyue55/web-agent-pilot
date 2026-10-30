/**
 * 服务端 Cookie Jar
 *
 * 为什么不把目标站点的 Cookie 透传给浏览器？
 *   目标 Set-Cookie 的 Domain/Path 属于 example.com，浏览器不会写进我们的域；
 *   即使把 Domain 抹掉，多站点 Cookie 也会在同一个域下互相覆盖。
 *   因此：会话维度（浏览器 cookie: pa_sid）在服务端各自维护一个 CookieJar，
 *   既天然隔离又不会出现同域冲突。
 */
import { CookieJar } from 'tough-cookie'

const MAX_SESSIONS = 200
const SESSION_TTL = 1000 * 60 * 60 * 6 // 6h

/** @type {Map<string, {jar: CookieJar, lastAccess: number}>} */
const jars = new Map()

export function getJar(sessionId) {
	let entry = jars.get(sessionId)
	if (!entry) {
		entry = { jar: new CookieJar(null, { looseMode: true }), lastAccess: Date.now() }
		jars.set(sessionId, entry)
		evictIfNeeded()
	}
	entry.lastAccess = Date.now()
	return entry.jar
}

function evictIfNeeded() {
	const now = Date.now()
	// 先清理过期
	for (const [sid, entry] of jars) {
		if (now - entry.lastAccess > SESSION_TTL) jars.delete(sid)
	}
	// 再按容量淘汰最久未使用
	while (jars.size > MAX_SESSIONS) {
		const oldest = jars.keys().next().value
		jars.delete(oldest)
	}
}

export async function storeCookies(jar, setCookieHeaders, targetUrl) {
	if (!setCookieHeaders || setCookieHeaders.length === 0) return
	for (const raw of setCookieHeaders) {
		try {
			await jar.setCookie(raw, targetUrl)
		} catch (err) {
			// 忽略无法解析的单条 cookie，不影响整体
			if (process.env.DEBUG_PROXY === 'true') console.warn('[cookie] skip:', raw, err.message)
		}
	}
}

export async function buildCookieHeader(jar, targetUrl) {
	try {
		return await jar.getCookieString(targetUrl)
	} catch {
		return ''
	}
}
