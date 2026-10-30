/** UI 冒烟：悬浮助手展开 / 设置面板 / 保存配置 / 打开站点 */
const pw = await import(
	process.env.PLAYWRIGHT_CORE_PATH ||
		'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
)
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://localhost:5577'
const SHARE = process.env.SHARECODE || ''
const KEY = process.env.PA_TEST_KEY || ''
const TARGET = process.env.TARGET || 'https://example.com'
const entry = SHARE ? `${BASE}/?sharecode=${SHARE}` : BASE

const browser = await chromium.launch({
	executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	headless: true,
	args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))

await page.goto(entry, { waitUntil: 'load' })

const results = {}
results.homeVisible = await page.isVisible('#home-guide')
await page.click('#fab')
await page.waitForTimeout(400)
results.chatOpen = await page.evaluate(() => document.getElementById('chat-panel').classList.contains('open'))

await page.click('#btn-settings-chat')
await page.waitForTimeout(300)
results.settingsVisible = await page.isVisible('#settings-mask')

if (KEY) {
	await page.fill('#cfg-baseurl', 'https://zenmux.ai/api/v1')
	await page.fill('#cfg-model', 'deepseek/deepseek-v4-flash')
	await page.fill('#cfg-apikey', KEY)
	await page.click('#btn-test')
	await page.waitForFunction(
		() => {
			const el = document.getElementById('test-result')
			return el && !/正在测试/.test(el.textContent)
		},
		{ timeout: 90_000 }
	)
	results.testResult = await page.textContent('#test-result')
	await page.click('#btn-save')
	await page.waitForTimeout(300)
	results.badge = await page.textContent('#status-badge')
	results.settingsClosed = !(await page.isVisible('#settings-mask'))
}

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
results.bridgeReady = true
results.frameTitle = await page.evaluate(() => {
	try {
		return document.getElementById('page-frame').contentDocument?.title
	} catch {
		return '(读不到)'
	}
})
results.pageErrors = errors

await page.screenshot({ path: process.env.SHOT || '/tmp/ui-check.png', fullPage: false })
console.log(JSON.stringify(results, null, 2))
await browser.close()
