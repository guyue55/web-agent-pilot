const SITES = [
	'https://www.baidu.com',
	'https://github.com',
	'https://zh.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD',
	'https://www.taobao.com',
	'https://news.qq.com',
	'https://www.bing.com',
	'https://stackoverflow.com',
	'https://www.zhihu.com',
	'https://example.com',
	'https://news.ycombinator.com',
]

const BASE = process.env.BASE || 'http://localhost:3000'

async function check(target) {
	const t0 = Date.now()
	try {
		const r = await fetch(`${BASE}/api/resolve?url=${encodeURIComponent(target)}`)
		const j = await r.json()
		if (!r.ok) return { target, ok: false, msg: `resolve: ${j.error}` }
		const pr = await fetch(BASE + j.proxyUrl, { redirect: 'follow' })
		const text = await pr.text()
		const blocked = ['x-frame-options', 'content-security-policy'].filter((h) => pr.headers.get(h))
		const injected = text.includes('<base href="') && text.includes('/bridge.js')
		const title = (/<title[^>]*>([\s\S]{0,80}?)<\/title>/i.exec(text) || [])[1] || '(无)'
		return {
			target,
			ok: pr.ok,
			status: pr.status,
			ms: Date.now() - t0,
			size: text.length,
			title: title.trim().slice(0, 40),
			injected: injected ? '√' : '×',
			blockedHeaders: blocked.length ? blocked.join(',') : '√已移除',
		}
	} catch (err) {
		return { target, ok: false, msg: err.message }
	}
}

const results = await Promise.all(SITES.map(check))
let fail = 0
for (const r of results) {
	if (!r.ok) {
		fail++
		console.log(`❌ ${r.target} -> ${r.msg || r.status}`)
		continue
	}
	console.log(
		`✅ ${String(r.status).padEnd(3)} ${String(r.ms + 'ms').padEnd(7)} ${String(r.size).padStart(7)}B  注入:${r.injected}  拦截头:${r.blockedHeaders}  ${r.target}\n      title: ${r.title}`
	)
}
console.log(`\n结果：${results.length - fail}/${results.length} 通过`)
process.exit(fail > 0 ? 1 : 0)
