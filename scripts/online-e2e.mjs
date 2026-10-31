/**
 * 线上 E2E：在真实发布环境里验证
 *  1) 宿主页正常加载、无致命错误
 *  2) 代理页注入 shim（带正确 o=）与 bridge
 *  3) 跨站存储隔离：A 站键 B 站读不到；B 站 clear() 不影响 A 站
 *  4) 宿主自己的 pa.agent.settings.v1 不被被代理页读到
 *
 * 全部条目都带对照（同站往返必须能读回，否则说明是 shim 把存储写坏了）
 */
import fs from 'node:fs'
const pw = await import('/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js')
const chromium = pw.default?.chromium ?? pw.chromium
const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = 'https://web-agent-pilot.app.workbuddy.host/?sharecode=IDPXOMY27M'

const results = []
const ok = (cond, name, extra = '') => {
	results.push({ pass: !!cond, name, extra })
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}

const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)))
const badStatics = []
page.on('response', (r) => {
	const u = r.url()
	// 304 是重新发布后的正常协商缓存，不算被拒
	if (u.includes('/_app/') && r.status() >= 400) badStatics.push(`${r.status()} ${u.replace(BASE.split('?')[0], '')}`)
})

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 })
const title = await page.title()
ok(/万能网页操作/.test(title), '宿主页加载', title)

// 宿主自己的配置
await page.evaluate(() => {
	localStorage.setItem('pa.agent.settings.v1', JSON.stringify({ apiKey: 'SECRET-KEY-123' }))
	localStorage.setItem('host-only-flag', 'HOST')
})

// 1) 打开 A 站（iframe），检查注入
const inject = await page.evaluate(async () => {
	const f = document.createElement('iframe')
	f.style.cssText = 'width:600px;height:400px'
	f.src = '/__pa/https/example.com/'
	document.body.appendChild(f)
	await new Promise((res, rej) => {
		f.onload = res
		setTimeout(() => rej(new Error('iframe A 加载超时')), 60000)
	})
	const w = f.contentWindow
	const d = w.document
	const scripts = [...d.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))
	return {
		shimFlag: w.__PAStorageShim === true,
		hasShim: scripts.some((s) => s.includes('storage-shim.js')),
		shimParam: scripts.find((s) => s.includes('storage-shim.js')) || '',
		hasBridge: scripts.some((s) => s.includes('bridge.js')),
		title: d.title,
	}
})
ok(inject.shimFlag, 'A 站 shim 已激活', JSON.stringify({ title: inject.title, bridge: inject.hasBridge }))
ok(inject.hasShim && inject.hasBridge, 'A 站同时注入 shim 与 bridge', inject.shimParam)

// 2) A 站写，B 站读（隔离）
const iso = await page.evaluate(async () => {
	const load = async (host) => {
		let f = document.getElementById('pa-probe-' + host)
		if (!f) {
			f = document.createElement('iframe')
			f.id = 'pa-probe-' + host
			f.style.cssText = 'width:300px;height:200px'
			f.src = `/__pa/https/${host}/`
			document.body.appendChild(f)
			await new Promise((res, rej) => {
				f.onload = res
				setTimeout(() => rej(new Error(host + ' 加载超时')), 60000)
			})
		}
		return f.contentWindow
	}
	const a = await load('example.com')
	const hostLeak = a.localStorage.getItem('pa.agent.settings.v1')
	a.localStorage.setItem('token', 'AAA-of-example')
	a.sessionStorage.setItem('stoken', 'SS-of-example')
	const aKeys = Object.keys(a.localStorage)

	const b = await load('example.net')
	const crossRead = b.localStorage.getItem('token')
	const crossSession = b.sessionStorage.getItem('stoken')
	const bKeys = Object.keys(b.localStorage)
	b.localStorage.setItem('theme', 'dark')
	b.localStorage.clear()

	const aBack = a.localStorage.getItem('token')
	const aTheme = a.localStorage.getItem('theme')
	return { hostLeak, crossRead, crossSession, aKeys, bKeys, aBack, aTheme, aShim: a.__PAStorageShim === true, bShim: b.__PAStorageShim === true }
})
ok(iso.aShim === true, 'A 站 shim 已激活（否则隔离是假通过）')
ok(iso.bShim === true, 'B 站 shim 已激活')
ok(!iso.aKeys.includes('host-only-flag'), 'A 站看不到宿主自己的键', JSON.stringify(iso.aKeys.slice(0, 5)))
ok(iso.hostLeak === null, '被代理页读不到宿主配置', JSON.stringify(iso.hostLeak))
ok(iso.aKeys.includes('token'), '对照：A 站能读回自己写的键', JSON.stringify(iso.aKeys))
ok(iso.crossRead === null, 'A 站 localStorage 不串到 B 站', JSON.stringify(iso.crossRead))
ok(iso.crossSession === null, 'A 站 sessionStorage 不串到 B 站', JSON.stringify(iso.crossSession))
ok(!iso.bKeys.includes('token'), 'B 站 key 列表不含 A 站键', JSON.stringify(iso.bKeys))
ok(iso.aBack === 'AAA-of-example', 'B 站 clear() 不影响 A 站数据', JSON.stringify(iso.aBack))
ok(iso.aTheme === null, 'A 站读不到 B 站写的键', JSON.stringify(iso.aTheme))

// 3) 宿主自身存储仍正常（没被 shim 误伤）
const hostStore = await page.evaluate(() => ({
	settings: localStorage.getItem('pa.agent.settings.v1'),
	keys: Object.keys(localStorage).slice(0, 6),
}))
ok(!!hostStore.settings && hostStore.settings.includes('SECRET-KEY-123'), '宿主自身存储正常', JSON.stringify(hostStore.keys))

ok(pageErrors.length === 0, '宿主页无 pageerror', pageErrors.slice(0, 2).join(' | '))
if (badStatics.length === 0) ok(true, '无 /_app/ 资源返回非 2xx')
else ok(false, '/_app/ 资源被拒', badStatics.slice(0, 3).join(' | '))

const passed = results.filter((r) => r.pass).length
console.log(`\n===== 线上 E2E：${passed}/${results.length} 通过 =====`)
if (passed !== results.length) console.log('失败项：', results.filter((r) => !r.pass).map((r) => r.name).join(', '))
await browser.close()
process.exit(passed === results.length ? 0 : 1)
