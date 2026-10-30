/**
 * 验证：用户在 Panel 上点 X 之后，顶栏「AI 面板」按钮能否把面板叫回来，
 * 且新面板仍然可用（不是僵尸 Agent）。
 */
// playwright-core 不在项目依赖内，沿用 ui-check.mjs 的约定：可用 PLAYWRIGHT_CORE_PATH 覆盖
const pw = await import(
	process.env.PLAYWRIGHT_CORE_PATH ||
		'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
)
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const MOCK = 'http://127.0.0.1:3400/v1'

const SETTINGS = {
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

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const page = await browser.newPage()

// 配置必须在文档脚本执行前就位：addInitScript 每次导航前都会跑，
// 否则首次加载时 app.js 读不到配置、也不会自动创建 Agent。
await page.addInitScript((s) => {
	// 只在顶层文档写入，避免在 iframe（同源）里反复覆盖
	if (window.top === window.self) localStorage.setItem('pa.agent.settings.v1', JSON.stringify(s))
}, SETTINGS)

// 用带 query 的地址强制整页加载：仅改 hash 不会重新执行 app.js 的启动逻辑
await page.goto(`${BASE}/?e2e=${Date.now()}#url=https://example.com`, {
	waitUntil: 'domcontentloaded',
})

const frame = await page.waitForSelector('#page-frame')
const fr = await frame.contentFrame()
await fr.waitForSelector('#page-agent-runtime_agent-panel', { timeout: 40000 })
console.log('✅ 面板已显示')

// 在 iframe 内点 X（关闭）
const closeBtn = await fr.$('#page-agent-runtime_agent-panel button[title="关闭"]')
await closeBtn.click()
await page.waitForTimeout(800)

const closed = await fr.evaluate(() => ({
	panelGone: !document.querySelector('#page-agent-runtime_agent-panel'),
}))

// 注意：先读宿主 UI 状态。下面的 disposed 探测会调用 ensureAgent()，
// 那会重建 Agent 并重新 show 面板，读晚了就会看到被自己改过的状态。
const btnActive = await page.evaluate(() => ({
	active: document.querySelector('#btn-panel').classList.contains('active'),
	title: document.querySelector('#btn-panel').title,
	status: document.querySelector('#agent-status').textContent,
}))

// 只读探针：不触发重建，避免测试自己改变被测状态
const stateAfterClose = await fr.evaluate(() => {
	const a = window.__PABridge?.agent
	return { hasAgent: !!a, disposed: a ? !!a.disposed : null }
})
console.log(`   点 X 后: 面板消失=${closed.panelGone} 按钮active=${btnActive.active}`)
console.log(`   顶栏状态: "${btnActive.status}"`)
console.log(`   内部实例: ${stateAfterClose.hasAgent ? `存在, disposed=${stateAfterClose.disposed}` : '已清空'}`)

// 点顶栏按钮叫回面板
await page.click('#btn-panel')
await page.waitForTimeout(1500)

const revived = await fr.evaluate(async () => {
	const panel = document.querySelector('#page-agent-runtime_agent-panel')
	const a = window.__PABridge?.agent
	if (!a) return { hasPanel: !!panel, usable: 'NO_AGENT' }
	if (a.disposed) return { hasPanel: !!panel, usable: 'STILL_DISPOSED' }
	// 用真实面板背后的实例执行，验证不是「僵尸 Agent」
	let usable = 'ok'
	try {
		await a.execute('关闭后重新执行的任务')
	} catch (e) {
		usable = 'ERR:' + e.message
	}
	return { hasPanel: !!panel, usable }
})

// 等任务跑完
await page.waitForTimeout(2500)
const finalStatus = await page.evaluate(() => ({
	status: document.querySelector('#agent-status').textContent,
	btnActive: document.querySelector('#btn-panel').classList.contains('active'),
}))

console.log('\n===== 修复验证：点 X 后叫回面板 =====')
console.log(`  面板已恢复显示        : ${revived.hasPanel ? '是' : '否'}`)
console.log(`  新面板可执行任务      : ${revived.usable === 'ok' ? '✅ 可以' : '❌ ' + revived.usable}`)
console.log(`  顶栏最终状态          : "${finalStatus.status}" (按钮active=${finalStatus.btnActive})`)

await browser.close()
