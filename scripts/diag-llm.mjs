/** 诊断部署环境下 LLM 请求的两种通道：本站代理 vs 浏览器直连 */
import { chromeExe } from './lib/chrome.mjs'
const pw = await import('playwright-core')
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://localhost:5577'
const SHARE = process.env.SHARECODE || ''
const KEY = process.env.PA_TEST_KEY
const MODEL = process.env.MODEL || 'deepseek/deepseek-v4-flash'

const entry = SHARE ? `${BASE}/?sharecode=${SHARE}` : BASE

const browser = await chromium.launch({
	executablePath: chromeExe(),
	headless: true,
	args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(entry, { waitUntil: 'domcontentloaded' })

const result = await page.evaluate(
	async ({ key, model }) => {
		const body = {
			model,
			messages: [
				{ role: 'system', content: 'You are helpful.' },
				{ role: 'user', content: 'say ok' },
			],
			tools: [
				{
					type: 'function',
					function: {
						name: 'echo',
						description: 'echo',
						parameters: { type: 'object', properties: { t: { type: 'string' } }, required: ['t'] },
					},
				},
			],
			tool_choice: { type: 'function', function: { name: 'echo' } },
			parallel_tool_calls: false,
		}

		const out = {}

		// 通道 1：经本站 /api/llm/proxy 转发
		try {
			const r = await fetch('/api/llm/proxy', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-pa-target': encodeURIComponent('https://zenmux.ai/api/v1/chat/completions'),
					'x-pa-headers': btoa(unescape(encodeURIComponent(JSON.stringify({ authorization: `Bearer ${key}` })))),
				},
				body: JSON.stringify(body),
			})
			out.proxy = { status: r.status, body: (await r.text()).slice(0, 200) }
		} catch (e) {
			out.proxy = { error: String(e) }
		}

		// 通道 2：浏览器直连模型服务
		try {
			const r = await fetch('https://zenmux.ai/api/v1/chat/completions', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
				body: JSON.stringify(body),
			})
			out.direct = { status: r.status, body: (await r.text()).slice(0, 200) }
		} catch (e) {
			out.direct = { error: String(e) }
		}

		return out
	},
	{ key: KEY, model: MODEL }
)

console.log(JSON.stringify(result, null, 2))
await browser.close()
