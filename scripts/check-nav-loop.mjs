/**
 * 回归：目标站反复自我重定向时的保护。
 *
 *  A) 知乎（实测会自我跳转 20+ 次）：应被拦下 —— iframe 断开、显示说明卡片、导航停止增长
 *  B) 正常站（example.com）：不应误伤 —— 不显示卡片、面板正常、无 nav-loop
 *  C) 点「仍然继续」后计数被清空，可以再次尝试
 */
const pw = await import(
	process.env.PLAYWRIGHT_CORE_PATH ||
		'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
)
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const MOCK = process.env.MOCK || 'http://127.0.0.1:3400/v1'
const LOOP_URL = process.env.LOOP_URL || 'https://www.zhihu.com'

const CONFIG = {
	protocol: 'openai-chat', baseURL: MOCK, model: 'mock-model', apiKey: 'dummy-key',
	route: 'direct', maxSteps: 3, stepDelay: 0.3, maxTokens: 4096, language: 'zh-CN',
	scriptTool: true, fastMode: false, extraHeaders: {},
}

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})

async function openHost(page, target) {
	await page.addInitScript((s) => {
		if (window.top === window.self) localStorage.setItem('pa.agent.settings.v1', JSON.stringify(s))
	}, CONFIG)
	await page.goto(`${BASE}/?nl=${Date.now()}#url=${encodeURIComponent(target)}`, {
		waitUntil: 'domcontentloaded',
		timeout: 60000,
	})
}

// ---------------- A) 死循环站点应被拦下 ----------------
{
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
	await openHost(page, LOOP_URL)

	// 等提示卡片出现（bridge 连续 5 次加载后才触发）
	let shown = false
	try {
		await page.waitForSelector('#blocked-notice:not([hidden])', { timeout: 40000 })
		shown = true
	} catch {
		/* 下面统一输出 */
	}

	const navsBefore = await page.evaluate(() => window.__navCount || 0)
	const snapshot = await page.evaluate(() => ({
		hidden: document.getElementById('blocked-notice').hidden,
		desc: document.getElementById('blocked-desc').textContent,
		openHref: document.getElementById('blocked-open').href,
		status: document.getElementById('agent-status').textContent,
		frameSrc: document.getElementById('page-frame').src,
	}))
	await page.waitForTimeout(4000)
	const frameSrcLater = await page.$eval('#page-frame', (el) => el.src)

	console.log('===== A) 死循环站点 =====')
	console.log('  提示卡片出现      :', shown ? '✅ 是' : '❌ 否')
	console.log('  说明文案          :', snapshot.desc.slice(0, 60))
	console.log('  iframe 已断开     :', frameSrcLater.startsWith('about:blank') ? '✅ 是' : '❌ ' + frameSrcLater.slice(0, 50))
	console.log('  顶栏状态          :', snapshot.status)
	console.log('  原站链接          :', snapshot.openHref.slice(0, 60))
	console.log('  navCount 变量     :', navsBefore)

	// ---------------- C) 「仍然继续」清空计数并重新加载 ----------------
	// 用 force 点击：此前的非强制点击会被 Playwright 的可操作性检查拦成「空点击」
	// （页面刚从死循环里停下，滚动/布局仍在抖动），并非按钮不可用。
	// 注意断言要看「过程」：知乎会立即再次循环、5 次后又被拦下，这正是守卫在复位。
	await page.click('#blocked-retry', { force: true })

	let sawCleared = false
	let sawReload = false
	for (let i = 0; i < 25; i++) {
		await page.waitForTimeout(200)
		const snap = await page.evaluate(() => ({
			loop: sessionStorage.getItem('pa.navLoop'),
			src: document.getElementById('page-frame').src,
		}))
		if (snap.loop === null) sawCleared = true
		if (snap.src.includes('/__pa/')) sawReload = true
		if (sawCleared && sawReload) break
	}

	const afterRetry = await page.evaluate(() => ({
		hidden: document.getElementById('blocked-notice').hidden,
		loop: sessionStorage.getItem('pa.navLoop'),
		src: document.getElementById('page-frame').src,
	}))
	console.log('\n===== C) 点「仍然继续」 =====')
	console.log('  计数曾被清空      :', sawCleared ? '✅' : '❌')
	console.log('  iframe 重新加载   :', sawReload ? '✅' : '❌')
	console.log('  守卫再次生效      :', afterRetry.hidden === false ? '✅ 又被拦下' : 'ℹ️ 观测窗口内未再次触发（循环需重新累积到 5 次，属正常）')
	await page.close()
}

// ---------------- B) 正常站不误伤 ----------------
{
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
	await openHost(page, 'https://example.com')
	const handle = await page.waitForSelector('#page-frame', { timeout: 20000 })
	const fr = await handle.contentFrame()
	let panel = false
	try {
		await fr.waitForSelector('#page-agent-runtime_agent-panel', { timeout: 40000 })
		panel = true
	} catch {
		/* ignore */
	}
	const state = await page.evaluate(() => ({
		hidden: document.getElementById('blocked-notice').hidden,
		loopKey: sessionStorage.getItem('pa.navLoop'),
	}))
	console.log('\n===== B) 正常站（不应误伤） =====')
	console.log('  提示卡片隐藏      :', state.hidden ? '✅' : '❌')
	console.log('  面板正常出现      :', panel ? '✅' : '❌')
	console.log('  pa.navLoop 计数   :', state.loopKey || '（无，符合预期）')
	await page.close()
}

await browser.close()
