/** 任意部署环境的多站点代理可用率测试 */
const BASE = process.env.BASE || 'http://localhost:5577'
const SHARE = process.env.SHARECODE || ''
const q = (path) => `${BASE}${path}${path.includes('?') ? '&' : '?'}${SHARE ? `sharecode=${SHARE}` : ''}`.replace(/[?&]$/, '')

const SITES = (process.env.SITES || 'https://example.com,https://www.baidu.com,https://www.zhihu.com,https://news.qq.com,https://www.bing.com,https://github.com,https://news.ycombinator.com,https://zh.wikipedia.org/wiki/AI,https://www.taobao.com,https://www.w3.org').split(',')

async function check(t) {
	const t0 = Date.now()
	try {
		const r = await fetch(q(`/api/resolve?url=${encodeURIComponent(t)}`))
		const j = await r.json()
		if (!r.ok) return { t, ok: false, msg: j.error || `resolve ${r.status}` }
		const proxied = `${BASE}${j.proxyUrl}${j.proxyUrl.includes('?') ? '&' : '?'}${SHARE ? `sharecode=${SHARE}` : ''}`
		const res = await fetch(proxied, { signal: AbortSignal.timeout(40_000) })
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
