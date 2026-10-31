/** 任意部署环境的多站点代理可用率测试 */
const BASE = process.env.BASE || 'http://localhost:5577'
const SHARE = process.env.SHARECODE || ''
const q = (path) => `${BASE}${path}${path.includes('?') ? '&' : '?'}${SHARE ? `sharecode=${SHARE}` : ''}`.replace(/[?&]$/, '')

// 两处量具修正（线上复检时踩到的，都会把「可用的站」误判成失败）：
//  1. 真实客户端传的是 base64url 的 ?u=，不是 ?url=<明文 URL>；
//     网关会拦掉「查询串里带 URL 字面量」的请求（example.com 会被 403），
//     用 ?url= 测等于在测一条产品根本不走的路径。
//  2. 必须带上分享门禁发的 cookie：目标站一旦 302，重写后的 Location 不会带
//     ?sharecode=，没有 cookie 就会拿到「链接不完整」403。
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

let COOKIE = ''
async function primeCookie() {
	if (!SHARE) return
	try {
		const res = await fetch(`${BASE}/?sharecode=${SHARE}`)
		const list = res.headers.getSetCookie ? res.headers.getSetCookie() : []
		COOKIE = list.map((c) => c.split(';')[0]).join('; ')
	} catch {
		COOKIE = ''
	}
}
const withCookie = COOKIE ? { cookie: COOKIE } : {}

const SITES = (process.env.SITES || 'https://example.com,https://www.baidu.com,https://www.zhihu.com,https://news.qq.com,https://www.bing.com,https://github.com,https://news.ycombinator.com,https://zh.wikipedia.org/wiki/AI,https://www.taobao.com,https://www.w3.org').split(',')

async function check(t) {
	const t0 = Date.now()
	try {
		const r = await fetch(q(`/api/resolve?u=${b64url(t)}`), { headers: withCookie })
		const j = await r.json()
		if (!r.ok) return { t, ok: false, msg: j.error || `resolve ${r.status}` }
		const proxied = `${BASE}${j.proxyUrl}${j.proxyUrl.includes('?') ? '&' : '?'}${SHARE ? `sharecode=${SHARE}` : ''}`
		// 客户端超时必须大于服务端的代理预算（PROXY_TIMEOUT_MS，默认 70s），
		// 否则测到的是「量具先超时」，会把「服务端还在努力」误报成站点不可用。
		const res = await fetch(proxied, { signal: AbortSignal.timeout(85_000), headers: withCookie })
		const text = await res.text()
		return {
			t,
			ok: res.ok,
			status: res.status,
			ms: Date.now() - t0,
			size: text.length,
			injected: text.includes('/_app/bridge.js'),
			err: res.ok ? '' : text.slice(0, 120).replace(/\s+/g, ' '),
		}
	} catch (e) {
		return { t, ok: false, msg: `${e.name}: ${e.message}` }
	}
}

await primeCookie()
const rs = await Promise.all(SITES.map(check))
let ok = 0
for (const r of rs) {
	if (r.ok) {
		ok++
		console.log(`✅ ${String(r.status)} ${String(r.ms + 'ms').padEnd(6)} ${String(r.size).padStart(7)}B 注入:${r.injected ? '√' : '×'}  ${r.t}`)
	} else {
		console.log(`❌ ${r.t} -> ${r.status || ''} ${r.err || r.msg || ''}`.slice(0, 160))
	}
}
console.log(`\n可用率：${ok}/${rs.length}`)
