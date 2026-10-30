/** 单站点深度诊断：记录所有失败资源、iframe 控制台、任务过程 */
const pw = await import(
	process.env.PLAYWRIGHT_CORE_PATH ||
		'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
)
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://localhost:5577'
const SHARECODE = process.env.SHARECODE || ''
const entry = SHARECODE ? `${BASE}/?sharecode=${SHARECODE}` : BASE
const TARGET = process.env.TARGET || 'https://www.baidu.com'
const TASK = process.env.TASK || '在搜索框输入 deepseek v4，然后点击百度一下按钮进行搜索'
const KEY = process.env.PA_TEST_KEY

const browser = await chromium.launch({
	executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

page.on('response', async (r) => {
	if (r.status() >= 400) {
		let body = ''
		try {
			body = (await r.text()).slice(0, 300)
		} catch {}
		console.log(`HTTP ${r.status()} ${r.url().slice(0, 150)}\n     ${body.replace(/\n/g, ' ')}`)
	}
})
page.on('requestfailed', (r) => console.log(`REQFAIL ${r.url().slice(0, 120)} ${r.failure()?.errorText}`))
page.on('console', (m) => {
	const t = m.text()
	if (process.env.VERBOSE === 'true' || m.type() === 'error') console.log(`[${m.type()}] ${t.slice(0, 300)}`)
})
page.on('framenavigated', (frame) => {
	if (frame !== page.mainFrame()) {
		console.log(`FRAME-NAV -> ${frame.url().slice(0, 160)}`)
	}
})

await page.goto(entry, { waitUntil: 'domcontentloaded' })
await page.evaluate(
	(key) => {
		localStorage.setItem(
			'pa.agent.settings.v1',
			JSON.stringify({
				protocol: 'openai-chat',
				baseURL: 'https://zenmux.ai/api/v1',
				model: 'deepseek/deepseek-v4-flash',
				apiKey: key,
				route: 'proxy',
				maxSteps: 20,
				stepDelay: 0.4,
				maxTokens: 8192,
				language: 'zh-CN',
				extraHeaders: {},
			})
		)
	},
	KEY
)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.fill('#url-input', TARGET)
await page.click('#btn-go')
await page.waitForFunction(
	() => {
		try {
			return document.getElementById('page-frame')?.contentWindow?.__PABridge?.ready === true
		} catch {
			return false
		}
	},
	{ timeout: 60_000 }
)
console.log('bridge ready ✓')
console.log('subtitle:', await page.textContent('#chat-subtitle'))

await page.click('#fab')
await page.fill('#task-input', TASK)
await page.click('#btn-send')

for (let i = 0; i < 40; i++) {
	await page.waitForTimeout(4000)
	const snap = await page.evaluate(() => ({
		stopHidden: document.getElementById('btn-stop')?.hidden,
		subtitle: document.getElementById('chat-subtitle')?.textContent,
		toast: document.getElementById('toast')?.hidden ? '' : document.getElementById('toast')?.textContent,
		frameReady: (() => {
			try {
				return !!document.getElementById('page-frame')?.contentWindow?.__PABridge?.ready
			} catch {
				return false
			}
		})(),
		frameHtml: (() => {
			try {
				return (document.getElementById('page-frame')?.contentDocument?.documentElement?.outerHTML || '').slice(0, 200)
			} catch {
				return '(读不到)'
			}
		})(),
		lastSteps: [...document.querySelectorAll('#chat-body .step, #chat-body .msg')]
			.slice(-3)
			.map((n) => n.textContent.replace(/\s+/g, ' ').slice(0, 160)),
	}))
	console.log(
		`[${i * 4}s] stop=${!snap.stopHidden ? 'RUNNING' : 'idle'} bridge=${snap.frameReady} | ${snap.subtitle} | toast=${snap.toast}`
	)
	if (!snap.frameReady) console.log('     frame html:', snap.frameHtml.replace(/\n/g, ' '))
	for (const s of snap.lastSteps) console.log('     ', s)
	if (snap.stopHidden === true && i >= 8) break
}

await browser.close()
