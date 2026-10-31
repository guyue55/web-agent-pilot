/** UI 冒烟：设置面板 / 打开站点 / bridge 注入 / page-agent Panel 出现 */
import { chromeExe } from './lib/chrome.mjs'
const pw = await import('playwright-core')
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://localhost:3000'
const SHARE = process.env.SHARECODE || ''
const KEY = process.env.PA_TEST_KEY || ''
const TARGET = process.env.TARGET || 'https://example.com'
const entry = SHARE ? `${BASE}/?sharecode=${SHARE}` : BASE

const browser = await chromium.launch({
	executablePath: chromeExe(),
	headless: true,
	args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))

await page.goto(entry, { waitUntil: 'load' })

const results = {}
results.homeVisible = await page.isVisible('#home-guide')
results.statusBadge = (await page.textContent('#status-badge')).trim()

await page.click('#btn-settings-top')
await page.waitForTimeout(300)
results.settingsVisible = await page.isVisible('#settings-mask')

if (KEY) {
	await page.fill('#cfg-baseurl', process.env.PA_BASEURL || 'https://api.deepseek.com/v1')
	await page.fill('#cfg-model', process.env.PA_MODEL || 'deepseek-chat')
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
} else {
	await page.click('#btn-cancel')
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

// page-agent 内置 Panel 应自动出现在 iframe 内
await page.waitForFunction(
	() => {
		try {
			const d = document.getElementById('page-frame').contentDocument
			return !!d?.querySelector('#page-agent-runtime_agent-panel')
		} catch {
			return false
		}
	},
	{ timeout: 20_000 }
).catch(() => {})
results.panelCount = await page.evaluate(() => {
	try {
		return document
			.getElementById('page-frame')
			.contentDocument.querySelectorAll('#page-agent-runtime_agent-panel').length
	} catch {
		return 0
	}
})
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
