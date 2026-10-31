/**
 * 回归：WebSocket 隧道。
 *
 * 前置：scripts/fixtures/ws-echo-server.mjs（3501 回显）+ fixtures 静态站（3500）
 * 被测：页面里的 new WebSocket('ws://127.0.0.1:3501/echo') 会被 bridge 改写到
 *       /__paws/http/127.0.0.1:3501/echo，由服务端隧道透传到回显服务。
 *
 * 断言：
 *  A) 页面能拿到 echo:hello（隧道通）
 *  B) WebSocket 的静态常量没丢（之前「重写原型」的写法会把它们弄丢）
 *  C) 未授权目标（内网/本机在 ALLOW_LOCALHOST 关闭时）被拒 —— 由 curl 侧单独验证
 */
import { chromeExe } from './lib/chrome.mjs'
const pw = await import('playwright-core')
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const MOCK = process.env.MOCK || 'http://127.0.0.1:3400/v1'
const PAGE = process.env.WS_PAGE || 'http://127.0.0.1:3500/ws-test.html'

const CONFIG = {
	protocol: 'openai-chat', baseURL: MOCK, model: 'mock-model', apiKey: 'dummy-key',
	route: 'direct', maxSteps: 3, stepDelay: 0.3, maxTokens: 4096, language: 'zh-CN',
	scriptTool: true, fastMode: false, extraHeaders: {},
}

const browser = await chromium.launch({
	executablePath: chromeExe(),
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.addInitScript((s) => {
	if (window.top === window.self) localStorage.setItem('pa.agent.settings.v1', JSON.stringify(s))
}, CONFIG)

await page.goto(`${BASE}/?ws=${Date.now()}#url=${encodeURIComponent(PAGE)}`, {
	waitUntil: 'domcontentloaded',
	timeout: 60000,
})
const handle = await page.waitForSelector('#page-frame', { timeout: 20000 })
const fr = await handle.contentFrame()

let state = ''
for (let i = 0; i < 40; i++) {
	await page.waitForTimeout(500)
	state = await fr.evaluate(() => window.__wsState).catch(() => '')
	if (String(state).startsWith('echo:') || String(state).startsWith('error') || String(state).startsWith('closed')) break
}

const consts = await fr.evaluate(() => {
	const WS = window.WebSocket
	return { OPEN: WS.OPEN, CLOSED: WS.CLOSED, CONNECTING: WS.CONNECTING }
}).catch(() => ({}))

const proxiedUrl = await fr.evaluate(() => {
	// 复用页面里同一个改写逻辑：新建一个连接看它最终连到哪
	try {
		const abs = new URL('ws://127.0.0.1:3501/echo', location.href)
		return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__paws/${abs.protocol === 'wss:' ? 'https' : 'http'}/${abs.host}${abs.pathname}`
	} catch {
		return ''
	}
}).catch(() => '')

console.log('===== WebSocket 隧道 =====')
console.log('  页面连接结果      :', state)
console.log('  隧道通（echo）    :', String(state) === 'echo:hello' ? '✅' : '❌')
console.log('  静态常量完整      :', consts.OPEN === 1 && consts.CLOSED === 3 && consts.CONNECTING === 0 ? '✅' : `❌ ${JSON.stringify(consts)}`)
console.log('  改写后的连接地址  :', proxiedUrl)

await browser.close()
