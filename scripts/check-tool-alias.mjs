/**
 * 回归：模型把工具名写错时，不会整轮任务报废。
 *
 * 背景：线上实测日志
 *   ❌ InvokeError: Unknown action "script". Available: done, wait, ... execute_javascript
 *   🔄 LLM retry attempt 1 of 2
 *   ❌ InvokeError: Unknown action "script"
 *   ❌ InvokeError: Unknown action "index"
 * 重试两次都还是同一个错名 —— 说明单纯加大重试次数并不能自愈，任务直接失败。
 *
 * 修法：bridge 在构造 Agent 后给「明确指向某个真工具」的错名注册别名
 * （script → execute_javascript、index → click_element_by_index），
 * schema 与实现都复用真工具，不新增能力。
 *
 * 断言：
 *  A) bridge 暴露的别名表与注册函数存在
 *  B) 注册后工具表里出现别名（且真工具缺失时不会凭空造）
 *  C) 端到端：模型吐出 {"action":{"script":"..."}}，任务能继续跑完而不是抛 Unknown action
 *
 * 前置：应用已启动（默认 BASE=http://127.0.0.1:3211）
 * 用法：BASE=http://127.0.0.1:3211 node scripts/check-tool-alias.mjs
 */
import { chromeExe } from './lib/chrome.mjs'
const pw = await import('playwright-core')
const chromium = pw.default?.chromium ?? pw.chromium
const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const MOCK_PORT = Number(process.env.ALIAS_MOCK_PORT || 3405)
const CHROME = chromeExe()

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
	if (cond) {
		pass++
		console.log(`  ✅ ${label}${extra ? `  ${extra}` : ''}`)
	} else {
		fail++
		console.log(`  ❌ ${label}${extra ? `  ${extra}` : ''}`)
	}
}

// ---------------- 按脚本吐动作的假模型：第一次故意写错工具名，第二次正常收尾
//
// 不走真实端口：bridge 会把页面里的 fetch 统一改写成 /__pa/ 代理路径（这是让
// 目标站 XHR 回流的设计），打到 127.0.0.1:3405 的请求会被代理的 SSRF 校验拦掉。
// 用 route 拦截直接给出应答，既不依赖端口，也不受这条改写规则影响。
// 连续两次都写错名（线上日志就是这样：retry 1 of 2、retry 2 of 2 还是同一个错名），
// 第三次才正常收尾 —— 修复前这条链路会直接把任务判失败，且前两步被静默丢弃。
const scripted = [
	{ action: { script: 'document.title' } },
	{ action: { script: 'document.title' } },
	{ action: { done: { success: true, text: 'alias-ok' } } },
]
let turn = 0

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-proxy-server'] })
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))

await page.route('**/v1/chat/completions', async (route) => {
	const plan = scripted[Math.min(turn, scripted.length - 1)]
	turn++
	const payload = {
		id: `chatcmpl-${turn}`,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: 'mock',
		choices: [
			{
				index: 0,
				finish_reason: 'tool_calls',
				message: {
					role: 'assistant',
					tool_calls: [
						{
							id: `call_${turn}`,
							type: 'function',
							function: {
								name: 'AgentOutput',
								arguments: JSON.stringify({
									evaluation_previous_goal: 'mock',
									memory: 'mock',
									next_goal: 'mock',
									...plan,
								}),
							},
						},
					],
				},
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
	}
	await route.fulfill({
		status: 200,
		contentType: 'application/json',
		headers: { 'access-control-allow-origin': '*' },
		body: JSON.stringify(payload),
	})
})

await page.goto(`${BASE}/__pa/https/example.com/`, { waitUntil: 'domcontentloaded' })
// bridge 只在拿到配置后才去加载 page-agent；这里直接引同一个文件，避免依赖完整配置流程
await page.evaluate(
	() =>
		new Promise((resolve, reject) => {
			const s = document.createElement('script')
			s.src = '/_app/vendor/page-agent.demo.js?autoInit=false'
			s.onload = resolve
			s.onerror = reject
			document.head.appendChild(s)
		})
)

console.log('\n===== A) bridge 暴露的别名能力 =====')
const exposed = await page.evaluate(() => ({
	aliases: window.__PAToolAliases || null,
	hasAugment: typeof window.__PAAugmentTools === 'function',
}))
ok(exposed.hasAugment, '注册函数存在')
ok(exposed.aliases && exposed.aliases.script === 'execute_javascript', 'script 映射到 execute_javascript')
ok(exposed.aliases && exposed.aliases.index === 'click_element_by_index', 'index 映射到 click_element_by_index')

console.log('\n===== B) 注册效果 =====')
const registered = await page.evaluate((port) => {
	if (typeof window.__PAAugmentTools !== 'function') return { missing: true }
	const mk = (scriptTool) =>
		new window.PageAgent({
			model: 'mock',
			baseURL: `http://127.0.0.1:${port}/v1`,
			apiKey: 'x',
			maxSteps: 3,
			enableMask: false,
			experimentalScriptExecutionTool: scriptTool,
		})
	const agent = mk(true)
	const before = [...agent.tools.keys()]
	const added = window.__PAAugmentTools(agent)
	const after = [...agent.tools.keys()]
	// 关掉脚本执行工具时，script 别名不应被凭空造出来
	const offAgent = mk(false)
	const offAdded = window.__PAAugmentTools(offAgent)
	const offHasScript = offAgent.tools.has('script')
	try {
		agent.dispose()
		offAgent.dispose()
	} catch {}
	return { before, added, after, offAdded, offHasScript }
}, MOCK_PORT)
ok(!registered.missing && registered.added.includes('script'), '执行 JS 工具存在时注册了 script', registered.missing ? '注册函数缺失' : JSON.stringify(registered.added))
ok(!registered.missing && (registered.after || []).includes('script'), '工具表里确实出现了 script')
ok(!registered.missing && !registered.offHasScript && !(registered.offAdded || []).includes('script'), '真工具不存在时不会凭空造别名')

console.log('\n===== C) 端到端：模型吐出 {"action":{"script":...}} =====')
const run = await page.evaluate(async (port) => {
	const agent = new window.PageAgent({
		model: 'mock',
		baseURL: `http://127.0.0.1:${port}/v1`,
		apiKey: 'x',
		maxSteps: 4,
		stepDelay: 0,
		enableMask: false,
		experimentalScriptExecutionTool: true,
		customFetch: (u, i) => fetch(u, i),
	})
	// 修复前这里没有注册函数，故意让流程继续，好让「Unknown action」真实暴露出来
	window.__PAAugmentTools && window.__PAAugmentTools(agent)
	const errors = []
	const onErr = (e) => errors.push(String(e?.detail ?? e))
	agent.addEventListener('error', onErr)
	let result
	try {
		result = await agent.execute('把页面标题读出来')
	} catch (e) {
		errors.push(String(e?.message || e))
	}
	const steps = (agent.history || []).filter((h) => h.type === 'step').map((h) => ({
		name: h.action?.name,
		output: String(h.action?.output ?? '').slice(0, 160),
	}))
	try {
		agent.dispose()
	} catch {}
	return { result: result ? { success: result.success, data: String(result.data).slice(0, 120) } : null, steps, errors }
}, MOCK_PORT)

const scriptStep = run.steps.find((s) => s.name === 'script')
if (process.env.DEBUG_ALIAS === '1') console.log('  [debug] run =', JSON.stringify(run).slice(0, 1200))
ok(Boolean(scriptStep), '模型写的 script 被当成一次真实动作执行', scriptStep ? scriptStep.output : JSON.stringify(run.steps))
ok(!/Unknown action/i.test(JSON.stringify(run)), '全过程没有出现 Unknown action')
ok(run.result && run.result.success === true, '任务正常收尾', run.result ? `success=${run.result.success}` : '无结果')

console.log(`\n结果：${pass} 项通过，${fail} 项失败`)
if (pageErrors.length) console.log('页面异常：', pageErrors.join(' | ').slice(0, 300))

await browser.close()
process.exit(fail === 0 ? 0 : 1)
