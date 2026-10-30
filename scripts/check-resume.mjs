/**
 * 验证：任务执行中页面跳转，新页面能否自动接着跑（跨导航续跑）。
 *
 * 场景：用户下达任务 → Agent 正在请求模型 → 页面发生跳转（点了搜索/链接）
 * 期望：新页面 Agent 就绪后自动续跑原任务；续跑次数有上限；任务完成后记录被清除。
 */
// playwright-core 不在项目依赖内，沿用 ui-check.mjs 的约定：可用 PLAYWRIGHT_CORE_PATH 覆盖
const pw = await import(
	process.env.PLAYWRIGHT_CORE_PATH ||
		'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
)
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const MOCK = 'http://127.0.0.1:3400/v1'
const PAGE_A = `${BASE}/__pa/https/example.com/`
const PAGE_B = `${BASE}/__pa/https/example.com/?nav=1`

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mockLog = () => fetch('http://127.0.0.1:3401/__log').then((r) => r.json())
const mockReset = () => fetch('http://127.0.0.1:3401/__reset').then((r) => r.text())

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const page = await browser.newPage()

async function boot() {
	await page.waitForFunction(() => window.__PABridge?.ready === true, null, { timeout: 30000 })
	await page.evaluate((cfg) => {
		window.postMessage({ source: 'pa-host', type: 'configure', payload: cfg }, location.origin)
	}, CONFIG)
	await page.waitForFunction(() => !!document.querySelector('#page-agent-runtime_agent-panel'), null, {
		timeout: 30000,
	})
	await page.evaluate(async () => {
		window.__agent = await window.__PABridge.ensureAgent()
	})
}

const results = {}

// ---------- 场景 1：执行中跳转 → 自动续跑 ----------
await page.goto(PAGE_A, { waitUntil: 'domcontentloaded', timeout: 60000 })
await boot()
await mockReset()

// 起一个会长时间等待模型的任务（mock 延迟 4s），不等它结束
await page.evaluate(() => {
	window.__agent.execute('搜索 page agent 并打开第一个结果').catch(() => {})
})
await page.waitForFunction(() => window.__agent?.status === 'running', null, { timeout: 10000 })
const pendingBefore = await page.evaluate(() => sessionStorage.getItem('pa.pendingTask'))

// 模拟 Agent 点击链接导致导航（此时请求仍在飞）
await sleep(600)
await page.goto(PAGE_B, { waitUntil: 'domcontentloaded', timeout: 60000 })
await boot()

// 等续跑请求到达 mock
let resumedReq = null
for (let i = 0; i < 40; i++) {
	await sleep(500)
	const log = await mockLog()
	// 续跑请求体里含有提示词特征
	const hit = log.find((e) => JSON.stringify(e).includes('页面已跳转'))
	if (hit) {
		resumedReq = hit
		break
	}
}

results.pendingRecorded = !!pendingBefore && pendingBefore.includes('搜索 page agent')
results.resumeRequested = !!resumedReq
const pendingAfter = await page.evaluate(() => {
	const raw = sessionStorage.getItem('pa.pendingTask')
	return raw ? JSON.parse(raw) : null
})
results.resumeCount = pendingAfter?.resumes ?? null
results.taskTextKept = pendingAfter?.task ?? null

// ---------- 场景 2：续跑任务正常结束后，记录被清除 ----------
await page.waitForFunction(
	() => ['completed', 'stopped', 'error'].includes(window.__agent?.status),
	null,
	{ timeout: 30000 }
).catch(() => {})
const pendingAfterDone = await page.evaluate(() => sessionStorage.getItem('pa.pendingTask'))
results.clearedAfterDone = pendingAfterDone === null

// ---------- 场景 3：续跑次数用尽后不再续跑 ----------
await page.evaluate(() => {
	sessionStorage.setItem(
		'pa.pendingTask',
		JSON.stringify({ task: '这条不该被续跑', at: Date.now(), resumes: 2, host: 'example.com' })
	)
})
await mockReset()
await page.evaluate((cfg) => {
	window.postMessage({ source: 'pa-host', type: 'configure', payload: cfg }, location.origin)
}, CONFIG)
await sleep(4000)
const log3 = await mockLog()
results.capRespected = !log3.some((e) => JSON.stringify(e).includes('这条不该被续跑'))

// ---------- 场景 4：过期任务不续跑 ----------
await page.evaluate(() => {
	sessionStorage.setItem(
		'pa.pendingTask',
		JSON.stringify({
			task: '这条已经过期',
			at: Date.now() - 10 * 60 * 1000,
			resumes: 0,
			host: 'example.com',
		})
	)
})
await mockReset()
await page.evaluate((cfg) => {
	window.postMessage({ source: 'pa-host', type: 'configure', payload: cfg }, location.origin)
}, CONFIG)
await sleep(4000)
const log4 = await mockLog()
results.expiredIgnored = !log4.some((e) => JSON.stringify(e).includes('这条已经过期'))

// ---------- 场景 5：用户在地址栏另开别的站点，旧任务不能套上去 ----------
await page.evaluate(() => {
	sessionStorage.setItem(
		'pa.pendingTask',
		JSON.stringify({ task: '这条属于别的站点', at: Date.now(), resumes: 0, host: 'www.baidu.com' })
	)
})
await mockReset()
await page.evaluate((cfg) => {
	window.postMessage({ source: 'pa-host', type: 'configure', payload: cfg }, location.origin)
}, CONFIG)
await sleep(4000)
const log5 = await mockLog()
results.otherHostIgnored = !log5.some((e) => JSON.stringify(e).includes('这条属于别的站点'))

console.log('\n===== 跨导航续跑验证 =====')
const ok = (v) => (v ? '✅' : '❌')
console.log(`  执行中已记录任务原文      : ${ok(results.pendingRecorded)}`)
console.log(`  跳转后自动发起续跑请求    : ${ok(results.resumeRequested)}`)
console.log(`  续跑次数计数              : ${results.resumeCount}（期望 1）`)
console.log(`  保留的仍是原任务文本      : ${results.taskTextKept === '搜索 page agent 并打开第一个结果' ? '✅' : '❌ ' + results.taskTextKept}`)
console.log(`  任务结束后记录被清除      : ${ok(results.clearedAfterDone)}`)
console.log(`  次数用尽后不再续跑        : ${ok(results.capRespected)}`)
console.log(`  过期任务不续跑            : ${ok(results.expiredIgnored)}`)
console.log(`  开别的站点不套用旧任务    : ${ok(results.otherHostIgnored)}`)

await browser.close()
