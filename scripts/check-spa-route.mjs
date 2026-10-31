/**
 * 回归：被代理页的「路径还原」是否让纯前端站点正常工作
 *
 * 背景：代理把目标站挂在 /__pa/https/<host>/ 下，页面 JS 读到的 pathname
 * 带前缀，React/wouter、Vue Router 这类按 pathname 匹配的站点会直接渲染
 * 自家的 "page not found"（skillhub.cn 实测正文 381 字符）。path-shim 在
 * 页面脚本前把 pathname 还原成站点真实路径解决它，本脚本守住四件事：
 *
 *  1. 首页真的渲染出内容，且地址栏是干净的站点路径
 *  2. document.baseURI 仍指向代理 —— 相对资源不能因此跑出代理
 *  3. 站内页能直接打开（/skills 不是 404）
 *  4. 还原后的地址刷新，能精确回跳到代理路径（不是落到别的站点/404）
 *
 * 依赖本机 Chrome。默认跑本地 3211，可用 BASE 覆盖。
 */
import { chromeExe } from './lib/chrome.mjs'
import fs from 'node:fs'

const pw = await import('playwright-core')
const chromium = pw.default?.chromium ?? pw.chromium
const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const PROXY = `${BASE}/__pa/https/skillhub.cn`

const results = []
const ok = (cond, name, extra = '') => {
	results.push({ pass: !!cond, name })
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const browser = await chromium.launch({ executablePath: chromeExe() })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await ctx.newPage()
const docReqs = []
page.on('request', (r) => {
	if (r.resourceType() === 'document') docReqs.push(r.url().replace(BASE, ''))
})

const bodyText = () => page.evaluate(() => document.body.innerText.trim())

// ---- 1. 首页：路径被还原、内容真的渲染出来
await page.goto(`${PROXY}/?sharecode=TESTCODE`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(6000)
const home = await page.evaluate(() => ({
	pathname: location.pathname,
	search: location.search,
	baseURI: document.baseURI,
	len: document.body.innerText.trim().length,
	text: document.body.innerText.trim().slice(0, 200),
}))
ok(home.pathname === '/', '首页 pathname 还原为站点根路径', home.pathname)
ok(home.len > 1500, '首页渲染出真实内容（非 page not found）', `${home.len} 字符`)
ok(!/page not found/i.test(home.text), '首页不含 page not found')
ok(home.baseURI === `${PROXY}/`, 'baseURI 仍指向代理（相对资源不跑出代理）', home.baseURI)
ok(home.search.includes('sharecode=TESTCODE'), '首屏 sharecode 被保留（线上网关要求）', home.search)

// ---- 2. 站内页：直接打开也必须是真页面
await page.goto(`${PROXY}/skills`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
const skills = await page.evaluate(() => ({
	pathname: location.pathname,
	len: document.body.innerText.trim().length,
	text: document.body.innerText.trim(),
}))
ok(skills.pathname === '/skills', '站内页 pathname 为 /skills', skills.pathname)
ok(skills.len > 1500 && !/page not found/i.test(skills.text.slice(0, 400)), '站内 /skills 不是 404', `${skills.len} 字符`)

// ---- 3. 刷新：地址已是站点真实路径，必须能回到代理继续打开同一页
const beforeReload = docReqs.length
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
const afterReload = await page.evaluate(() => ({
	href: location.href,
	pathname: location.pathname,
	len: document.body.innerText.trim().length,
	text: document.body.innerText.trim().slice(0, 200),
}))
// 刷新的请求先落到裸路径 /skills，服务端回跳页再把它送回 /__pa/...：
// 页面上看到的地址是还原后的站点路径，链路里必须出现代理请求
const hopped = docReqs.slice(beforeReload).some((u) => u.startsWith('/__pa/https/skillhub.cn/skills'))
ok(hopped, '刷新经代理回跳后重新请求了同一页', docReqs.slice(beforeReload).join(' → '))
ok(afterReload.pathname === '/skills', '刷新后仍停在站内路径', afterReload.pathname)
ok(afterReload.len > 1500 && !/page not found/i.test(afterReload.text), '刷新后内容正常', `${afterReload.len} 字符`)
ok(docReqs.length > beforeReload, '刷新确实发起了新的文档请求')

// ---- 4. 站内前端路由跳转：地址变化后仍是同一文档、内容更新
const beforePush = await page.evaluate(() => document.body.innerText.trim().length)
await page.evaluate(() => {
	history.pushState(history.state, '', '/')
	window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
})
await page.waitForTimeout(2500)
const afterPush = await page.evaluate(() => ({
	pathname: location.pathname,
	len: document.body.innerText.trim().length,
	baseURI: document.baseURI,
}))
ok(afterPush.pathname === '/', '前端路由 pushState 后 pathname 正确')
ok(afterPush.len > 1000, '前端路由跳转后仍有内容', `${afterPush.len} 字符（跳转前 ${beforePush}）`)
ok(afterPush.baseURI === `${PROXY}/`, 'pushState 后 baseURI 未漂移', afterPush.baseURI)

// ---- 5. 没有裸路径资源泄漏（除刷新那次文档请求外，全部走 /__pa/）
const bare = docReqs.filter((u) => !u.startsWith('/__pa/') && !u.startsWith('/_app/'))
ok(bare.length <= 1, '没有多余的裸路径文档请求', bare.join(', ') || '无')

// ---- 6. 宿主 UI 侧：iframe 内发生真实站内导航后，地址栏要跟着更新
//
// 关键在「导航后」而不只是「首次打开」：首次打开的地址栏由 resolveAndOpen 直接
// 写好，谁都不改也对；但用户点进站内第二页后，宿主读的是 iframe 的 pathname ——
// 它被 path-shim 还原成了 /skills，宿主若还按 /__pa/ 前缀解析就会解析失败，
// 地址栏停在上一页（父窗口读同源 iframe，拿得到 __PA_PATH__ 才能拼回代理地址）
await page.goto(`${BASE}/?e2e=${Date.now()}#url=https://skillhub.cn`, {
	waitUntil: 'domcontentloaded',
	timeout: 60000,
})
await page.waitForTimeout(9000)
const openedHome = await page.evaluate(() => document.getElementById('url-input')?.value || '')
ok(openedHome.includes('skillhub.cn'), '宿主先打开站点首页', openedHome)

// 让 iframe 真的加载站内第二页（等价于用户点了页内链接）
await page.evaluate((u) => {
	document.getElementById('page-frame').src = u
}, `${PROXY}/skills`)
await page.waitForTimeout(9000)
const hostUi = await page.evaluate(() => {
	const fr = document.getElementById('page-frame')
	let framePath = null
	try {
		framePath = fr?.contentWindow?.location?.pathname ?? null
	} catch {
		framePath = null
	}
	return {
		framePath,
		input: document.getElementById('url-input')?.value || '',
		newTab: document.getElementById('btn-newtab')?.getAttribute('href') || '',
	}
})
ok(hostUi.framePath === '/skills', '宿主内的页面路径同样被还原', String(hostUi.framePath))
ok(
	hostUi.input.includes('skillhub.cn/skills'),
	'站内导航后地址栏跟着更新（不是停在首页）',
	hostUi.input,
)
ok(
	hostUi.newTab.includes('skillhub.cn/skills'),
	'「新标签打开」同步更新到站内页',
	hostUi.newTab,
)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
	console.log('失败项：' + failed.map((f) => f.name).join(' / '))
	process.exit(1)
}
