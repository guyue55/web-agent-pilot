/**
 * 实验：点击「停止」时，LLM 请求是否真的被中断？
 *
 * 官方契约：OpenAIClient 调用 customFetch 时会传 signal（用户 abort 信号）。
 * 若我们的 customFetch 忽略该 signal，用户点停止后请求仍会跑满超时，
 * 表现为「点了停止，界面却长时间卡在执行中」。
 */
// playwright-core 不在项目依赖内，沿用 ui-check.mjs 的约定：可用 PLAYWRIGHT_CORE_PATH 覆盖
import { chromeExe } from './lib/chrome.mjs'
const pw = await import('playwright-core')
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const MOCK = 'http://127.0.0.1:3400/v1'
const PAGE = process.env.TARGET_PAGE || `${BASE}/__pa/https/example.com/`
const STOP_AFTER_MS = Number(process.env.STOP_AFTER_MS || 1500)

const CONFIG = {
	protocol: 'openai-chat',
	baseURL: MOCK,
	model: 'mock-model',
	apiKey: 'dummy-key',
	route: 'direct',
	maxSteps: 5,
	stepDelay: 0.4,
	maxTokens: 8192,
	language: 'zh-CN',
	scriptTool: true,
	fastMode: true,
	extraHeaders: {},
}

const browser = await chromium.launch({ executablePath: chromeExe() })
const page = await browser.newPage()
page.on('console', (m) => {
	const t = m.text()
	if (/pa-bridge|llm-adapter|PageAgent/.test(t)) console.log('  [page]', t.slice(0, 160))
})

await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__PABridge?.ready === true, null, { timeout: 30000 })
console.log('✅ bridge ready')

// 下发配置，创建 Agent
await page.evaluate((cfg) => {
	window.postMessage({ source: 'pa-host', type: 'configure', payload: cfg }, location.origin)
}, CONFIG)

await page.waitForFunction(() => window.__PABridge && !!document.querySelector('#page-agent-runtime_agent-panel'), null, {
	timeout: 30000,
})
console.log('✅ Panel 已渲染')

// 拿到 agent 实例，挂到 window 便于轮询
await page.evaluate(async () => {
	const agent = await window.__PABridge.ensureAgent()
	window.__agent = agent
	window.__t = { stopCalledAt: 0, stoppedAt: 0, history: [] }
	agent.addEventListener('statuschange', () => {
		if (agent.status === 'stopped') window.__t.stoppedAt = Date.now()
	})
	return true
})

const mockLogBefore = await (await fetch('http://127.0.0.1:3401/__reset')).text()

// 启动任务，1.5s 后停止
await page.evaluate(async (waitMs) => {
	const agent = window.__agent
	const p = agent.execute('mock task for stop experiment').catch(() => {})
	setTimeout(async () => {
		window.__t.stopCalledAt = Date.now()
		await agent.stop()
	}, waitMs)
	return p
}, STOP_AFTER_MS)

// 等待状态变为 stopped
const t0 = Date.now()
await page.waitForFunction(() => window.__t.stoppedAt > 0, null, { timeout: 30000 })
const stopLatency = Date.now() - t0 + STOP_AFTER_MS

const result = await page.evaluate(() => ({
	status: window.__agent.status,
	stopLatencyMs: window.__t.stoppedAt - window.__t.stopCalledAt,
	historyLen: window.__agent.history.length,
}))

// 读 mock 日志
const log = await (await fetch('http://127.0.0.1:3401/__log')).json()

console.log('\n===== 实验结果：停止响应 =====')
console.log(`点停止 -> 状态变 stopped 耗时: ${result.stopLatencyMs}ms`)
for (const e of log) {
	console.log(`  mock 请求 ${e.id}: ${e.state} (${e.elapsed ?? '?'}ms)`)
}
console.log(`\n判定: ${result.stopLatencyMs > 2000 ? '❌ 停止被阻塞（请求未随 signal 中断）' : '✅ 停止即时生效'}`)

await browser.close()
