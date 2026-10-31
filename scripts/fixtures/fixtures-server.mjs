/**
 * 夹具静态服务：把 scripts/fixtures 下的测试页暴露出来（默认 3500）。
 * 用于「敌意样式」「WebSocket 隧道」等回归，页面需经本应用代理访问才有意义。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.FIXTURE_PORT || 3500)

/** 每个路径被请求过几次：用来做「第一次很慢、重试就快」的可控抖动 */
const hits = new Map()
const send = (res, delay, body) => {
	setTimeout(() => {
		if (res.writableEnded || res.destroyed) return
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(body)
	}, delay)
}

http
	.createServer((req, res) => {
		const u = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
		const url = decodeURIComponent(u.pathname)

		// ---- 供「代理超时/重试」回归使用的动态站点 ----
		if (url === '/fast') {
			send(res, 0, '<!doctype html><title>fast</title><p id="ok">fast-ok</p>')
			return
		}
		if (url === '/slow-once') {
			// 同一 k 的第一次请求拖 ms 毫秒（把响应窗口拖到超时之外），之后立刻返回。
			// 用 k 隔离轮次：否则跑第二遍时计数已经累加过，测出来的「慢」就不存在了。
			const ms = Number(u.searchParams.get('ms') || 2000)
			const key = `${url}?k=${u.searchParams.get('k') || ''}`
			const n = (hits.get(key) || 0) + 1
			hits.set(key, n)
			send(res, n === 1 ? ms : 0, `<!doctype html><title>slow-once</title><p id="ok">attempt-${n}</p>`)
			return
		}
		if (url === '/hang') {
			// 永不响应：只能由整体超时（PROXY_TIMEOUT_MS）收场
			hits.set(url, (hits.get(url) || 0) + 1)
			req.on('close', () => {})
			return
		}

		// ---- 供「请求头透传」回归使用的回显端点 ----
		// 返回 JSON（非 text/html），代理层不做重写，能原样看到上游真正收到了什么头。
		if (url === '/headers') {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
			res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }))
			return
		}

		// ---- 供「导航死循环保护」回归使用的自跳转站 ----
		// 必须是「文档级」重复加载：每轮都是完整的新文档，bridge 会重新执行并累加计数。
		// 用 302 模拟不出来 —— 302 链只在最后一个响应上落地一个文档，中间跳转不产生文档。
		if (url === '/loop') {
			send(
				res,
				0,
				`<!doctype html><title>loop</title><p id="loop">loop</p><script>
document.addEventListener('DOMContentLoaded', function () {
	setTimeout(function () { location.replace('/loop') }, 10)
})
</script>`
			)
			return
		}

		const file = path.join(ROOT, url === '/' ? 'hostile-css.html' : url)
		if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404).end('not found')
			return
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(fs.readFileSync(file))
	})
	.listen(PORT, '127.0.0.1', () => {
		console.log(`[fixtures] http://127.0.0.1:${PORT}/  (hostile-css / ws-test / fast / slow-once / hang)`)
	})
