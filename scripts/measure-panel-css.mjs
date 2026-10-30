/**
 * 测量：目标站 CSS 对注入的 page-agent Panel 的污染程度。
 *
 * 做法：同一个 Panel，在「干净页（example.com）」与若干「重样式页」上分别采集关键元素的
 * 计算样式，逐属性对比。差异即污染证据；全部一致说明当前样式足够抗污染。
 *
 * 用法：BASE=http://127.0.0.1:3211 node scripts/measure-panel-css.mjs
 */
// playwright-core 不在项目依赖内，沿用 ui-check.mjs 的约定：可用 PLAYWRIGHT_CORE_PATH 覆盖
const pw = await import(
	process.env.PLAYWRIGHT_CORE_PATH ||
		'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
)
const chromium = pw.default?.chromium ?? pw.chromium

const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const MOCK = process.env.MOCK || 'http://127.0.0.1:3400/v1'

const TARGETS = (process.env.TARGETS || '')
	.split(',')
	.filter(Boolean)

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
	fastMode: false,
	extraHeaders: {},
}

const PANEL = '#page-agent-runtime_agent-panel'
const WRAPPER_PROPS = [
	'position', 'zIndex', 'display', 'width', 'height', 'opacity',
	'transform', 'fontFamily', 'fontSize', 'lineHeight', 'color',
	'letterSpacing', 'textTransform', 'bottom', 'left', 'overflow',
]

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})

async function measure(target) {
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
	await page.addInitScript((s) => {
		if (window.top === window.self) localStorage.setItem('pa.agent.settings.v1', JSON.stringify(s))
	}, CONFIG)

	const url = target.startsWith('http')
		? `${BASE}/?m=${Date.now()}#url=${encodeURIComponent(target)}`
		: target // 允许直接传本地夹具的代理路径

	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
	const handle = await page.waitForSelector('#page-frame', { timeout: 20000 })
	const fr = await handle.contentFrame()

	const result = { target, ok: false }
	try {
		await fr.waitForSelector(PANEL, { timeout: 45000 })
		// 等过渡结束，避免读到动画中间态
		await page.waitForTimeout(900)

		result.data = await fr.evaluate((panelSel) => {
			const root = document.querySelector(panelSel)
			if (!root) return null
			// Panel.ts: wrapper.id = 'page-agent-runtime_agent-panel'，根节点本身就是 .wrapper
			const wrapper = root
			const cs = getComputedStyle(wrapper)
			const pick = (el, props) => {
				if (!el) return null
				const s = getComputedStyle(el)
				const out = {}
				for (const p of props) out[p] = s[p]
				return out
			}

			const btn = root.querySelector('button')
			const input = root.querySelector('input, textarea, [contenteditable]')
			const rect = wrapper.getBoundingClientRect()

			return {
				wrapper: pick(wrapper, [
					'position', 'zIndex', 'display', 'width', 'height', 'opacity',
					'transform', 'fontFamily', 'fontSize', 'lineHeight', 'color',
					'letterSpacing', 'textTransform', 'bottom', 'left', 'overflow',
				]),
				button: pick(btn, [
					'backgroundColor', 'color', 'borderStyle', 'borderWidth', 'borderRadius',
					'padding', 'fontSize', 'fontFamily', 'letterSpacing', 'textTransform',
				]),
				input: pick(input, [
					'backgroundColor', 'color', 'borderStyle', 'borderWidth',
					'fontSize', 'fontFamily', 'padding', 'height',
				]),
				rect: {
					x: Math.round(rect.x), y: Math.round(rect.y),
					w: Math.round(rect.width), h: Math.round(rect.height),
					// 视口内是否可见（越界说明被 fixed 包含块带偏）
					insideViewport:
						rect.top >= -2 &&
						rect.bottom <= window.innerHeight + 2 &&
						rect.left >= -2 &&
						rect.right <= window.innerWidth + 2,
					// 正常应贴视口底部上方 100px；祖先有 transform/filter 会让 fixed 失效、此值乱掉
					bottomGap: Math.round(window.innerHeight - rect.bottom),
					viewportH: window.innerHeight,
				},
				// Panel 自己设置的关键不变量
				panelOwnVars: {
					cursorSize: getComputedStyle(document.documentElement).getPropertyValue('--pa-cursor-size') || '',
				},
			}
		}, PANEL)
		result.ok = !!result.data
	} catch (e) {
		result.error = e.message
	}

	// 截一张 Panel 区域附近的图，便于人工复核
	try {
		await page.screenshot({ path: `/tmp/panel-css-${result.target.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png` })
	} catch {
		/* 截图失败不影响测量 */
	}

	await page.close()
	return result
}

const targets = TARGETS.length
	? TARGETS
	: [
			'https://example.com',
			'https://www.taobao.com',
			'https://www.zhihu.com',
			'https://www.bing.com',
		]

const all = []
for (const t of targets) {
	const r = await measure(t)
	all.push(r)
	console.log(`\n===== ${t} =====`)
	if (!r.ok) {
		console.log('  ❌ 未取到 Panel：', r.error || 'panel 不存在')
		continue
	}
	console.log('  wrapper:', JSON.stringify(r.data.wrapper))
	console.log('  rect   :', JSON.stringify(r.data.rect))
	console.log('  button :', JSON.stringify(r.data.button))
	console.log('  input  :', JSON.stringify(r.data.input))
}

// ---------- 与基线对比 ----------
const base = all.find((r) => r.ok && r.target.includes('example.com'))
if (base) {
	console.log('\n\n########## 相对基线（example.com）的差异 ##########')
	for (const r of all) {
		if (!r.ok || r === base) continue
		const diffs = []
		for (const section of ['wrapper', 'button', 'input']) {
			const a = base.data[section]
			const b = r.data[section]
			if (!a || !b) continue
			for (const k of Object.keys(a)) {
				if (a[k] !== b[k]) diffs.push(`${section}.${k}: ${a[k]} → ${b[k]}`)
			}
		}
		if (!r.data.rect.insideViewport) diffs.push('rect: 超出可视区（fixed 定位被破坏）')
		// Panel CSS 里 bottom:100px；偏离超过 4px 说明定位包含块不是视口
		if (Math.abs(r.data.rect.bottomGap - 100) > 4)
			diffs.push(`rect.bottomGap: 100 → ${r.data.rect.bottomGap}（fixed 定位失效，被祖先 transform/filter 带偏）`)
		console.log(`\n${r.target}: ${diffs.length} 处差异`)
		for (const d of diffs) console.log('   ·', d)
	}
} else {
	console.log('\n⚠️ 没有基线（example.com 测量失败），无法对比')
}

await browser.close()
