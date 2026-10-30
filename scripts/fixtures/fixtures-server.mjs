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

http
	.createServer((req, res) => {
		const url = decodeURIComponent((req.url || '/').split('?')[0])
		const file = path.join(ROOT, url === '/' ? 'hostile-css.html' : url)
		if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404).end('not found')
			return
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(fs.readFileSync(file))
	})
	.listen(PORT, '127.0.0.1', () => {
		console.log(`[fixtures] http://127.0.0.1:${PORT}/  (hostile-css.html / ws-test.html)`)
	})
