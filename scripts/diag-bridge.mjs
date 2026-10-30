/** 在 iframe 内直接驱动 bridge，捕获异常细节 */
const pw = await import(
	process.env.PLAYWRIGHT_CORE_PATH ||
		'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
)
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://localhost:5577'
const SHARE = process.env.SHARECODE || ''
const TARGET = process.env.TARGET || 'https://example.com'
const KEY = process.env.PA_TEST_KEY
const PROTOCOL = process.env.PROTOCOL || 'openai-chat'
const MODEL = process.env.MODEL || 'deepseek/deepseek-v4-flash'
const BASE_URLS = {
	'openai-chat': 'https://zenmux.ai/api/v1',
	'openai-responses': 'https://zenmux.ai/api/v1',
	anthropic: 'https://zenmux.ai/api/anthropic/v1',
}
const entry = SHARE ? `${BASE}/?sharecode=${SHARE}` : BASE

const browser = await chromium.launch({
	executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	headless: true,
	args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => {
	if (m.type() === 'error') console.log(`[iframe-error] ${m.text().slice(0, 200)}`)
})
page.on('pageerror', (e) => console.log(`[iframe-pageerror] ${String(e.message).slice(0, 200)}`))

await page.goto(entry, { waitUntil: 'domcontentloaded' })
await page.fill('#url-input', TARGET)
await page.click('#btn-go')
await page.waitForFunction(
	() => {
		try {
			return !!document.getElementById('page-frame')?.contentWindow?.__PABridge?.ready
		} catch {
			return false
		}
	},
	{ timeout: 60_000 }
)

const frames = page.frames().filter((f) => f !== page.mainFrame())
const frame = frames[frames.length - 1]
console.log('frames:', page.frames().length)

const out = await frame.evaluate(
	async ({ key, model, protocol, baseURL }) => {
		const log = []
		window.__PA_LOG = log
		const cfg = {
			protocol,
			baseURL,
			model,
			apiKey: key,
			route: 'proxy',
			maxSteps: 10,
			stepDelay: 0.4,
			maxTokens: 2048,
			language: 'zh-CN',
			scriptTool: true,
			extraHeaders: {},
		}
		try {
			window.postMessage({ source: 'pa-host', type: 'configure', payload: cfg }, window.location.origin)
			await new Promise((r) => setTimeout(r, 200))
			const agent = await window.__PABridge.ensureAgent(true)
			log.push('agent created: ' + !!agent)
			const res = await agent.execute('告诉我这个页面的标题')
			log.push('result: ' + JSON.stringify(res).slice(0, 400))
		} catch (e) {
			log.push('ERROR: ' + (e?.message || String(e)))
			log.push('STACK: ' + String(e?.stack || '').slice(0, 500))
		}
		return log
	},
	{ key: KEY, model: MODEL, protocol: PROTOCOL, baseURL: BASE_URLS[PROTOCOL] }
)

console.log(out.join('\n'))
await browser.close()
