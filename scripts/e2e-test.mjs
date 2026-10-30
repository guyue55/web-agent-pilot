/**
 * 浏览器端到端测试
 *   - 真实 Chrome 打开应用 -> 加载目标站点 -> 自然语言驱动 Agent
 * 用法：
 *   node scripts/e2e-test.mjs [protocol]
 *   PROTOCOL=openai-chat|openai-responses|anthropic
 */
const PW_PATH =
	process.env.PLAYWRIGHT_CORE_PATH ||
	'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
const pw = await import(PW_PATH)
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://localhost:5577'
/** 部署环境往往需要分享码才能进入，统一附加到所有请求上 */
const SHARE = process.env.SHARECODE || ''
const withShare = (path) => {
	const sep = path.includes('?') ? '&' : '?'
	return SHARE ? `${path}${sep}sharecode=${SHARE}` : path
}
const abs = (path) => (BASE + withShare(path)).replace(/[?&]$/, '')
const entry = abs('/')
const KEY = process.env.PA_TEST_KEY || process.env.ZENMUX_KEY || ''
const PROTOCOL = process.env.PROTOCOL || process.argv[2] || 'openai-chat'
const MODEL = process.env.MODEL || 'deepseek/deepseek-v4-flash'

const BASE_URLS = {
	'openai-chat': 'https://zenmux.ai/api/v1',
	'openai-responses': 'https://zenmux.ai/api/v1',
	anthropic: 'https://zenmux.ai/api/anthropic/v1',
}

const CASES = process.env.CASES
	? JSON.parse(process.env.CASES)
	: [{ target: 'https://news.ycombinator.com', task: '告诉我页面上第一条新闻的标题和链接' }]

if (!KEY) {
	console.error('缺少 API Key：请设置 PA_TEST_KEY 环境变量')
	process.exit(1)
}

const browser = await chromium.launch({
	executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	headless: true,
	args: ['--no-sandbox', '--disable-web-security=false'],
})

let failed = 0

for (const [index, c] of CASES.entries()) {
	console.log(`\n───────── 用例 ${index + 1}: ${c.target}`)
	console.log(`   任务：${c.task}`)
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
	const page = await context.newPage()
	const logs = []
	const errors = []
	const net = []
	page.on('console', (m) => {
		if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`)
	})
	page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)))
	if (process.env.NET_DEBUG === 'true') {
		page.on('response', async (res) => {
			if (!res.url().includes('/api/llm/proxy')) return
			let body = ''
			try {
				body = (await res.text()).slice(0, 600)
			} catch {
				body = '(读取失败)'
			}
			net.push(`HTTP ${res.status()} ${body}`)
		})
		page.on('request', (req) => {
			if (!req.url().includes('/api/llm/proxy')) return
			const raw = req.postData() || ''
			net.push(`REQ ${raw.length}B target=${decodeURIComponent(req.headers()['x-pa-target'] || '')}`)
			if (process.env.NET_DEBUG === 'full') net.push(raw.slice(0, 3000))
		})
	}

	try {
		await page.goto(entry, { waitUntil: 'domcontentloaded' })
		await page.evaluate(
			({ key, protocol, model, baseURL }) => {
				localStorage.setItem(
					'pa.agent.settings.v1',
					JSON.stringify({
						protocol,
						baseURL,
						model,
						apiKey: key,
						route: 'proxy',
						maxSteps: 25,
						stepDelay: 0.4,
						maxTokens: 8192,
						language: 'zh-CN',
						extraHeaders: {},
					})
				)
			},
			{ key: KEY, protocol: PROTOCOL, model: MODEL, baseURL: BASE_URLS[PROTOCOL] }
		)
		await page.reload({ waitUntil: 'domcontentloaded' })

		await page.fill('#url-input', c.target)
		await page.click('#btn-go')

		// 等待 bridge 就绪
		await page.waitForFunction(
			() => {
				const f = document.getElementById('page-frame')
				try {
					return f?.contentWindow?.__PABridge?.ready === true
				} catch {
					return false
				}
			},
			{ timeout: 60_000 }
		)
		console.log('   ✅ bridge 注入成功')

		// 页面标题（代理后应保留原站标题）
		const frame = await page.frameElement?.() // noop
		const title = await page.evaluate(() => {
			try {
				return document.getElementById('page-frame').contentDocument?.title
			} catch {
				return '(不可读)'
			}
		})
		console.log(`   ✅ 页面加载成功，标题：${title}`)

		await page.click('#fab')
		await page.fill('#task-input', c.task)
		await page.click('#btn-send')

		const t0 = Date.now()
		// 任务启动
		await page.waitForFunction(() => document.getElementById('btn-stop')?.hidden === false, {
			timeout: 30_000,
		})
		// 任务结束（无论成功失败）
		await page.waitForFunction(() => document.getElementById('btn-stop')?.hidden === true, {
			timeout: 240_000,
			polling: 1000,
		})

		const chatText = await page.evaluate(() => {
			const nodes = [...document.querySelectorAll('#chat-body .msg, #chat-body .step')]
			return nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join('\n')
		})
		console.log(`   ⏱  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
		console.log('   ── 输出 ──')
		console.log(
			chatText
				.split('\n')
				.map((l) => `      ${l.slice(0, 220)}`)
				.join('\n')
		)
		if (/❌|任务未能完成/.test(chatText)) {
			failed++
			console.log('   ❌ 任务未成功完成')
		} else {
			console.log('   ✅ 任务完成')
		}
	} catch (err) {
		failed++
		console.log(`   ❌ 失败：${err.message.slice(0, 300)}`)
		await page.screenshot({ path: `/tmp/pa-e2e-fail-${index}.png` }).catch(() => {})
	} finally {
		if (logs.length) console.log('   控制台：\n' + logs.slice(0, 8).map((l) => `      ${l}`).join('\n'))
		if (errors.length) console.log('   页面错误：\n' + errors.slice(0, 5).map((l) => `      ${l}`).join('\n'))
		if (net.length) console.log('   网络：\n' + net.slice(-6).map((l) => `      ${l}`).join('\n'))
		await context.close()
	}
}

await browser.close()
console.log(`\n用例数：${CASES.length}，失败：${failed}`)
process.exit(failed ? 1 : 0)
