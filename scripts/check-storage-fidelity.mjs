/**
 * 回归：存储 / cookie 的**语义保真度**
 *
 * 隔离本身由 check-storage.mjs 覆盖；这里回答另一个问题：
 * shim 有没有把原生行为改坏（顺序无关，只比语义）。
 *
 * 做法：同一个代理页跑两遍 —— 关组用路由拦截摘掉 shim 脚本标签（原生），
 * 开组正常注入（shim），跑同一段操作脚本，逐项比对。
 * 唯一允许的差异：key(i) 的枚举顺序（Chrome 原生顺序随键名变化，实测同一批
 * 带前缀键名在原生下也返回 b,a），因此比对时把键列表排序后再比。
 */
import fs from 'node:fs'
const pw = await import(
	process.env.PLAYWRIGHT_CORE_PATH ||
		'/Users/guyue/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
)
const chromium = pw.default?.chromium ?? pw.chromium
const exe = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const SITE = process.env.SITE || '/__pa/https/example.com/'

const OPS = () => {
	const out = {}
	const L = localStorage
	const S = sessionStorage
	const safe = (name, fn) => {
		try {
			out[name] = fn()
		} catch (e) {
			out[name] = 'ERR:' + (e && e.name)
		}
	}
	safe('clear', () => { L.clear(); S.clear(); return Object.keys(L) })
	safe('write', () => { L.setItem('a', '1'); L.setItem('b', '2'); return Object.keys(L).sort() })
	safe('length', () => L.length)
	safe('keyType', () => [typeof L.key(0), L.key(99), L.key(-1)])
	safe('coerce', () => {
		L.setItem('n', 123)
		L.setItem('o', {})
		L.setItem(null, 'x')
		return [L.getItem('n'), L.getItem('o'), L.getItem('null')]
	})
	safe('prop', () => { L.foo = 'bar'; const v = L.foo; delete L.foo; return [v, 'foo' in L, L.foo] })
	safe('types', () => [typeof L.getItem, L instanceof Storage, Object.prototype.toString.call(L)])
	safe('ownKeys', () => Object.getOwnPropertyNames(L).sort())
	safe('forIn', () => { const ks = []; for (const k in L) ks.push(k); return ks.sort() })
	safe('descriptor', () => JSON.stringify(Object.getOwnPropertyDescriptor(L, 'a')))
	safe('proto', () => Object.getPrototypeOf(L) === Storage.prototype)
	safe('session', () => { S.setItem('s1', 'x'); return [S.length, Object.keys(S).sort()] })
	safe('clearScope', () => { L.clear(); return [L.length, S.length] })
	// 边界：原生 length 是只读访问器，赋值应当无效
	safe('lengthAssign', () => { L.clear(); L.length = 5; return [L.length, Object.keys(L)] })
	// 边界：给原型方法赋值是「自有属性遮蔽」，不是写一条存储项
	safe('methodShadow', () => {
		L.clear()
		L.getItem = () => 'shadowed'
		const r = [typeof L.getItem, L.getItem(), Object.keys(L)]
		delete L.getItem
		L.clear()
		return r
	})
	// 边界：与接口属性同名的存储项，原生不枚举 length
	safe('itemNamedLength', () => {
		L.setItem('length', 'x')
		const r = [L.length, Object.keys(L), L.getItem('length')]
		L.clear()
		return r
	})
	// cookie 基本语义（跨站隔离不在这里测，见 check-storage）
	safe('cookie', () => {
		document.cookie = 'kd=1; path=/'
		const before = document.cookie
		document.cookie = 'kd=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
		return [before, document.cookie]
	})
	return out
}

const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined })
async function run(withShim) {
	const ctx = await browser.newContext()
	const page = await ctx.newPage()
	if (!withShim) {
		await page.route('**/__pa/**', async (route) => {
			try {
				const res = await route.fetch()
				const body = (await res.text()).replace(/<script[^>]*storage-shim\.js[^>]*><\/script>/, '')
				await route.fulfill({ response: res, body })
			} catch {
				try { await route.continue() } catch {}
			}
		})
	}
	await page.goto(`${BASE}${SITE}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	const ops = await page.evaluate(OPS)
	const idb = await page.evaluate(async () => {
		const wait = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error) })
		try {
			const open = indexedDB.open('fid', 1)
			open.onupgradeneeded = () => open.result.createObjectStore('kv')
			const db = await wait(open)
			const name = db.name
			await wait(db.transaction('kv', 'readwrite').objectStore('kv').put('v', 'k'))
			const got = await wait(db.transaction('kv').objectStore('kv').get('k'))
			db.close()
			const dbs = (await indexedDB.databases()).map((d) => `${d.name}@${d.version}`).sort()
			const del = indexedDB.deleteDatabase('fid')
			const deleted = await new Promise((res) => { del.onsuccess = () => res(true); del.onerror = () => res(false) })
			return { name, got, dbs, deleted }
		} catch (e) {
			return { err: String(e).slice(0, 60) }
		}
	})
	await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
	await ctx.close()
	return { ops, idb }
}

const native = await run(false)
const shimed = await run(true)
let pass = 0
let fail = 0
for (const k of Object.keys(native.ops)) {
	const a = JSON.stringify(native.ops[k])
	const b = JSON.stringify(shimed.ops[k])
	if (a === b) pass++
	else {
		fail++
		console.log(`⚠️  ${k}\n   原生: ${a}\n   shim: ${b}`)
	}
}
const idbSame = JSON.stringify(native.idb) === JSON.stringify(shimed.idb)
if (idbSame) pass++
else { fail++; console.log(`⚠️  indexeddb\n   原生: ${JSON.stringify(native.idb)}\n   shim: ${JSON.stringify(shimed.idb)}`) }

await browser.close()
console.log(`\n保真度：${pass} 项一致，${fail} 项不同`)
process.exit(fail === 0 ? 0 : 1)
