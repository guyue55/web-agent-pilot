/**
 * 真实站点回归：同一批站点，在「当前代码」与「上一版基线」上各跑一遍，比是否退化。
 *
 * 为什么不做「直连 vs 代理」的绝对比较：直连样本本身不可靠 —— 反爬页面（bing 189 字符）、
 * 无 JS 渲染的首页（百度 350 字符）、headless 差异（HN 一会 80 一会 4162）都会让比值乱跳，
 * 而且 taobao 这类站点在代理下本来就只有 589 字符（基线同样如此，是既有问题）。
 * 回归要回答的是「这次改动有没有把它弄坏」，所以拿基线做参照系。
 *
 * 用法：
 *   BASE=http://127.0.0.1:3211 BASELINE_DIR=/tmp/baseline node scripts/check-real-sites.mjs
 *   BASELINE_DIR 指向上一版代码目录时，脚本会自己拉起它、跑完再关掉
 *   （长期挂后台的服务在本机会被回收，不如让被测流程自己管理生命周期）。
 */
import { chromeExe } from './lib/chrome.mjs'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const pw = await import('playwright-core')
const chromium = pw.default?.chromium ?? pw.chromium
const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const BASELINE_DIR = process.env.BASELINE_DIR || ''
const BASELINE_PORT = Number(process.env.BASELINE_PORT || 3212)
const BASELINE = process.env.BASELINE || (BASELINE_DIR ? `http://127.0.0.1:${BASELINE_PORT}` : '')

/** 等基线服务真的能响应，最多 20s */
async function waitHealthy(base, ms = 20000) {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${base}/api/health`)
			if (r.ok) return true
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 300))
	}
	return false
}

let baselineProc = null
if (BASELINE_DIR) {
	baselineProc = spawn('node', ['server/index.js'], {
		cwd: BASELINE_DIR,
		env: { ...process.env, PORT: String(BASELINE_PORT), ALLOW_LOCALHOST: 'true' },
		stdio: 'ignore',
	})
	const healthy = await waitHealthy(BASELINE)
	if (!healthy) {
		console.log(`基线服务未能启动（${BASELINE}），跳过对比`)
		baselineProc.kill()
		baselineProc = null
	}
}

const cleanup = () => {
	try {
		baselineProc?.kill()
	} catch {
		/* ignore */
	}
}
process.on('exit', cleanup)

const SITES = (
	process.env.SITES ||
	[
		'https://example.com',
		'https://www.baidu.com',
		'https://news.ycombinator.com',
		'https://github.com',
		'https://www.bing.com',
		'https://news.qq.com',
		'https://www.taobao.com',
		'https://skillhub.cn',
	].join(',')
).split(',')

const browser = await chromium.launch({ executablePath: chromeExe() })

async function probe(url) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } })
	const page = await ctx.newPage()
	const errs = []
	page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 70)))
	let ok = false
	const t0 = Date.now()
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
		ok = true
	} catch {
		/* 记录为失败 */
	}
	await page.waitForTimeout(3500)
	const info = await page
		.evaluate(() => ({
			len: (document.body?.innerText || '').trim().length,
			pathname: location.pathname,
		}))
		.catch(() => ({ len: 0, pathname: '' }))
	await ctx.close()
	return { ...info, ok, ms: Date.now() - t0, errs: errs.slice(0, 2) }
}

const rows = []
for (const site of SITES) {
	const direct = await probe(site)
	const before = BASELINE ? await probe(`${BASELINE}/__pa/${site.replace('://', '/')}`) : null
	const now = await probe(`${BASE}/__pa/${site.replace('://', '/')}`)

	// 判据：当前必须真的渲染出内容；有基线时，正文不得比基线少一成（渲染抖动留余量）
	const shrunk = before && before.len > 0 && now.len < before.len * 0.9
	const pass = now.ok && now.len > 300 && !shrunk
	const delta = before ? now.len - before.len : 0
	const mark = pass ? 'PASS' : 'FAIL'
	const arrow = before ? (delta > 100 ? `↑${delta}` : delta < -100 ? `↓${delta}` : '=') : ''

	rows.push({ site, pass, direct, before, now })
	console.log(
		`${mark}  ${site.padEnd(34)} 直连 ${String(direct.len).padStart(5)} | 基线 ${
			before ? String(before.len).padStart(5) : '   - '
		} | 当前 ${String(now.len).padStart(5)} ${arrow.padEnd(6)} ${String(now.ms).padStart(5)}ms  err=${
			now.errs[0] || '-'
		}`
	)
}

await browser.close()
const failed = rows.filter((r) => !r.pass)
console.log(`\n${rows.length - failed.length}/${rows.length} 通过`)
if (failed.length) {
	console.log('失败站点：' + failed.map((f) => f.site).join(', '))
	process.exit(1)
}
