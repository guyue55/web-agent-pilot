/**
 * 回归：存储按站点隔离（localStorage / sessionStorage / IndexedDB）
 *
 * 背景：所有被代理页面都落在同一个源（如 http://127.0.0.1:3211），浏览器只按源隔离存储，
 * 于是 A 站写的数据 B 站能读到，B 站一次 clear() 还会把 A 站的数据抹掉（实测）。
 * 修复：/_app/storage-shim.js 给 key 加 `${目标站 origin}$` 前缀。
 *
 * 断言（每组都带直连对照，避免把浏览器的正常行为当成修复效果）：
 *  A) A 站写入 → B 站读不到（LS / SS / IDB 各一条）
 *  B) B 站 clear() 之后，A 站数据仍在
 *  C) storage 事件：同站能收到（key 已还原），别站被过滤
 *  D) 主应用自己的键（pa.pendingTask）仍然跨站共享 —— 跨页面续跑依赖这个语义
 *
 * 前置：应用已启动（默认 BASE=http://127.0.0.1:3211）
 * 用法：BASE=http://127.0.0.1:3211 node scripts/check-storage.mjs
 */
import fs from 'node:fs'

const pw = await import(
	process.env.PLAYWRIGHT_CORE_PATH ||
		'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
)
const chromium = pw.default?.chromium ?? pw.chromium
const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const exe = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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

const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined })

const readIdb = (page, name) =>
	page.evaluate(
		(dbName) =>
			new Promise((resolve) => {
				const req = indexedDB.open(dbName, 1)
				req.onupgradeneeded = () => req.result.createObjectStore('kv')
				req.onsuccess = () => {
					const db = req.result
					if (!db.objectStoreNames.contains('kv')) return resolve(null)
					const g = db.transaction('kv').objectStore('kv').get('k')
					g.onsuccess = () => {
						db.close()
						resolve(g.result ?? null)
					}
				}
				req.onerror = () => resolve(null)
			}),
		name
	)

const writeIdb = (page, name, value) =>
	page.evaluate(
		([dbName, v]) =>
			new Promise((resolve) => {
				const req = indexedDB.open(dbName, 1)
				req.onupgradeneeded = () => req.result.createObjectStore('kv')
				req.onsuccess = () => {
					const db = req.result
					const tx = db.transaction('kv', 'readwrite')
					tx.objectStore('kv').put(v, 'k')
					tx.oncomplete = () => {
						db.close()
						resolve(true)
					}
				}
				req.onerror = () => resolve(false)
			}),
		[name, value]
	)

async function scenario(label, urlA, urlB) {
	const ctx = await browser.newContext()
	const page = await ctx.newPage()
	const out = { label }

	await page.goto(urlA, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.evaluate(() => {
		localStorage.setItem('token', 'AAA-of-A')
		sessionStorage.setItem('stoken', 'SS-of-A')
	})
	out.idbWrite = await writeIdb(page, 'shared-db', 'IDB-of-A')

	await page.goto(urlB, { waitUntil: 'domcontentloaded', timeout: 60000 })
	out.bLS = await page.evaluate(() => localStorage.getItem('token'))
	out.bSS = await page.evaluate(() => sessionStorage.getItem('stoken'))
	out.bIDB = await readIdb(page, 'shared-db')
	await page.evaluate(() => {
		localStorage.clear()
		sessionStorage.clear()
	})

	await page.goto(urlA, { waitUntil: 'domcontentloaded', timeout: 60000 })
	out.aLSAfter = await page.evaluate(() => localStorage.getItem('token'))
	out.aIDBAfter = await readIdb(page, 'shared-db')

	await ctx.close()
	return out
}

console.log('\n===== A/B) 跨站隔离与 clear() 影响 =====')
const proxied = await scenario('经代理', `${BASE}/__pa/https/example.com/`, `${BASE}/__pa/https/example.net/`)
const direct = await scenario('直连对照', 'https://example.com/', 'https://example.net/')

ok(proxied.bLS === null, 'B 站读不到 A 站的 localStorage', `读到 ${JSON.stringify(proxied.bLS)}`)
ok(proxied.bSS === null, 'B 站读不到 A 站的 sessionStorage', `读到 ${JSON.stringify(proxied.bSS)}`)
ok(proxied.bIDB === null, 'B 站读不到 A 站的 IndexedDB', `读到 ${JSON.stringify(proxied.bIDB)}`)
ok(proxied.aLSAfter === 'AAA-of-A', 'B 站 clear() 后 A 站 localStorage 仍在', `现在是 ${JSON.stringify(proxied.aLSAfter)}`)
ok(proxied.aIDBAfter === 'IDB-of-A', 'B 站 clear() 后 A 站 IndexedDB 仍在', `现在是 ${JSON.stringify(proxied.aIDBAfter)}`)
// 对照组：直连本来就隔离，用来证明「不是浏览器行为导致的结果」
ok(direct.bLS === null && direct.bIDB === null, '直连对照组同样互不可见（判据有效）')

console.log('\n===== C) storage 事件过滤 =====')
{
	const ctx = await browser.newContext()
	const t1 = await ctx.newPage()
	await t1.goto(`${BASE}/__pa/https/example.com/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await t1.evaluate(() => {
		window.__evts = []
		window.addEventListener('storage', (e) => window.__evts.push({ key: e.key, v: e.newValue }))
	})
	const t2 = await ctx.newPage()
	await t2.goto(`${BASE}/__pa/https/example.com/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await t2.evaluate(() => localStorage.setItem('cross-tab', 'A2'))
	await new Promise((r) => setTimeout(r, 700))
	const same = await t1.evaluate(() => window.__evts)

	const t3 = await ctx.newPage()
	await t3.goto(`${BASE}/__pa/https/example.net/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await t3.evaluate(() => localStorage.setItem('cross-tab', 'B'))
	await new Promise((r) => setTimeout(r, 700))
	const other = await t1.evaluate(() => window.__evts)

	ok(same.some((e) => e.key === 'cross-tab' && e.v === 'A2'), '同站另一个标签页写入能收到事件，key 已还原', JSON.stringify(same))
	ok(other.length === same.length, '别的站写入不会推给本站', `多了 ${other.length - same.length} 条`)
	await ctx.close()
}

console.log('\n===== D) 主应用自己的键仍然跨站共享 =====')
{
	// 注意：sessionStorage 是「每个标签页一份」，必须用同一个页面做跳转，
	// 新开标签页读不到原本就是浏览器语义，不能拿来判 bug。
	const ctx = await browser.newContext()
	const page = await ctx.newPage()
	await page.goto(`${BASE}/__pa/https/example.com/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.evaluate(() => sessionStorage.setItem('pa.pendingTask', '{"task":"x"}'))
	await page.goto(`${BASE}/__pa/https/example.net/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	const shared = await page.evaluate(() => sessionStorage.getItem('pa.pendingTask'))
	ok(shared === '{"task":"x"}', '切换站点后 pa.pendingTask 仍可读（续跑前提）', JSON.stringify(shared))
	await ctx.close()
}

console.log('\n===== E) document.cookie 按站点隔离 =====')
{
	// 被代理页 JS 写的 cookie 落在代理源上：不隔离的话 A 站的 token B 站直接能读。
	const ctx = await browser.newContext()
	const page = await ctx.newPage()
	await page.goto(`${BASE}/__pa/https/example.com/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	const aSet = await page.evaluate(() => {
		document.cookie = 'token=AAA-of-A; path=/; max-age=600'
		return document.cookie
	})
	ok(/token=AAA-of-A/.test(aSet), 'A 站写入后能读回自己的 cookie', JSON.stringify(aSet))

	await page.goto(`${BASE}/__pa/https/example.net/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	const bSees = await page.evaluate(() => document.cookie)
	ok(bSees === '', 'B 站读不到 A 站的 cookie', JSON.stringify(bSees))

	const bSet = await page.evaluate(() => {
		document.cookie = 'token=BBB-of-B; path=/'
		return document.cookie
	})
	ok(/BBB-of-B/.test(bSet) && !/AAA-of-A/.test(bSet), 'B 站同名 cookie 不覆盖 A 站', JSON.stringify(bSet))

	await page.goto(`${BASE}/__pa/https/example.com/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	const aBack = await page.evaluate(() => document.cookie)
	ok(/AAA-of-A/.test(aBack) && !/BBB-of-B/.test(aBack), '回到 A 站仍是自己的 cookie', JSON.stringify(aBack))

	// Cookie Store API（Chrome 有）
	const hasCS = await page.evaluate(() => typeof window.cookieStore === 'object' && !!window.cookieStore)
	if (hasCS) {
		const csSame = await page.evaluate(async () => {
			await cookieStore.set({ name: 'cs', value: 'CS-A' })
			const g = await cookieStore.get('cs')
			return g && g.value
		})
		ok(csSame === 'CS-A', 'Cookie Store: 同站可写可读', JSON.stringify(csSame))
		await page.goto(`${BASE}/__pa/https/example.net/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
		const csCross = await page.evaluate(async () => {
			const g = await cookieStore.get('cs')
			const all = (await cookieStore.getAll()).map((c) => c.name)
			return { got: g, all }
		})
		// B 站自己也写过 token，所以只断言「拿不到 A 站的 cs」，而不是「列表为空」
		ok(csCross.got === null && !csCross.all.includes('cs'), 'Cookie Store: 拿不到别站的 cookie', JSON.stringify(csCross))
	} else {
		console.log('  ⏭️  Cookie Store API 不可用，跳过该两项')
	}
	await ctx.close()
}

await browser.close()
console.log(`\n结果：${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
