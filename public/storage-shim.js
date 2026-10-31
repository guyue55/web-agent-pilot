/**
 * storage-shim.js —— 注入到被代理页面的**最前面**，把 localStorage / sessionStorage
 * 按「目标站点」隔离。
 *
 * 为什么需要：代理页全部落在同一个源（如 http://127.0.0.1:3211），浏览器只按源隔离
 * 存储，于是 A 站写的 localStorage 会被 B 站读到，B 站一次 localStorage.clear()
 * 还会把 A 站的数据一起抹掉（实测）。
 *
 * 做法：给 key 加 `${目标站 origin}$` 前缀，页面看到的是不带前缀的逻辑 key。
 *  - getItem / setItem / removeItem / clear / key / length / 属性式访问（storage.foo）全部走包装
 *  - StorageEvent 只把「本站的」事件交给页面，并把 key 还原成逻辑 key
 *  - document.cookie 同理改名隔离：被代理页 JS 写的 cookie 落在代理源上，
 *    不加前缀的话 A 站写的 token B 站能直接读到（实测）
 *  - 主应用自己的键（pa.pendingTask / pa.navLoop）例外：它们要跨站共享，
 *    否则「页面跳转后接着跑」会断（bridge 依赖这个语义）
 *
 * 目标站 origin 由注入方通过 `data-pa-o` 属性带进来（兼容旧的 ?o=，并以
 * location.pathname 反推兜底）—— bridge 在页面里拿到的 location.origin
 * 是代理的源，没法自己推出目标站。
 */
;(function () {
	'use strict'

	// 目标站 origin 有三条来源，按「显式 → 隐含」优先级取第一个可用的：
	//  1. 注入时写在标签上的 data-pa-o（服务端已知，最准）
	//  2. 代理路径自身：location.pathname 形如 /__pa/https/example.com/xxx，
	//     由它反推 origin —— 线上网关会拦掉「查询串里带 URL」的请求（实测 403），
	//     所以不能只依赖 URL 参数，这条兜底让注入参数彻底丢失时也能工作
	//  3. 兼容旧参数 ?o=
	let targetOrigin = ''
	try {
		const el = document.currentScript
		targetOrigin = (el && el.getAttribute && el.getAttribute('data-pa-o')) || ''
		if (!targetOrigin) {
			const m = /^\/__pa\/(https?)\/([^/?#]+)/.exec(window.location.pathname)
			if (m) targetOrigin = `${m[1]}://${m[2]}`
		}
		if (!targetOrigin && el && el.src) targetOrigin = new URL(el.src).searchParams.get('o') || ''
	} catch {
		targetOrigin = ''
	}
	// 拿不到目标站就不做隔离：宁可保持原行为，也不要让页面存储直接坏掉
	if (!targetOrigin) return
	if (window.__PAStorageShim) return
	window.__PAStorageShim = true

	// 主应用自己的键：跨站共享（续跑 / 导航死循环计数）
	const INTERNAL_KEYS = new Set(['pa.pendingTask', 'pa.navLoop'])
	const PREFIX = `${targetOrigin}$`

	let real
	try {
		real = { local: window.localStorage, session: window.sessionStorage }
	} catch {
		return
	}
	if (!real.local || !real.session) return

	const storageProto = Object.getPrototypeOf(real.local)
	const isInternal = (k) => INTERNAL_KEYS.has(k)
	const physKey = (k) => (isInternal(k) ? k : PREFIX + k)

	/** 物理 key → 页面可见 key；不属于本站（或属于主应用）返回 null */
	function logicKey(k) {
		if (typeof k !== 'string') return null
		if (isInternal(k)) return null
		return k.startsWith(PREFIX) ? k.slice(PREFIX.length) : null
	}

	function allRawKeys(raw) {
		const out = []
		for (let i = 0; i < raw.length; i++) out.push(raw.key(i))
		return out
	}

	function visibleKeys(raw) {
		return allRawKeys(raw).filter((k) => logicKey(k) !== null)
	}

	function makeStorage(raw) {
		const proxy = new Proxy(Object.create(storageProto), {
			get(_target, prop) {
				switch (prop) {
					case 'length':
						return visibleKeys(raw).length
					case 'key':
						return (index) => {
							const keys = visibleKeys(raw)
							const k = keys[Number(index)]
							return k === undefined ? null : logicKey(k)
						}
					case 'getItem':
						return (key) => raw.getItem(physKey(String(key)))
					case 'setItem':
						return (key, value) => raw.setItem(physKey(String(key)), String(value))
					case 'removeItem':
						return (key) => raw.removeItem(physKey(String(key)))
					case 'clear':
						return () => {
							// 只清本站的键：别站的 clear() 不该被我们带跑
							for (const k of allRawKeys(raw)) {
								if (logicKey(k) !== null) raw.removeItem(k)
							}
						}
					default:
						break
				}
				if (typeof prop === 'symbol') {
					// 符号属性走原型：否则 Object.prototype.toString.call(localStorage)
					// 会从 [object Storage] 变成 [object Object]（实测差异）
					const sv = storageProto[prop]
					return typeof sv === 'function' ? sv.bind(proxy) : sv
				}
				// 属性式访问：localStorage.foo / localStorage.foo = 1
				if (prop in storageProto) {
					const v = storageProto[prop]
					return typeof v === 'function' ? v.bind(proxy) : v
				}
				const v = raw.getItem(physKey(prop))
				return v === null ? undefined : v
			},
			set(_target, prop, value) {
				if (typeof prop === 'symbol') return true
				raw.setItem(physKey(prop), String(value))
				return true
			},
			has(_target, prop) {
				if (typeof prop === 'symbol') return false
				if (prop in storageProto) return true
				return raw.getItem(physKey(prop)) !== null
			},
			deleteProperty(_target, prop) {
				if (typeof prop === 'symbol') return true
				raw.removeItem(physKey(prop))
				return true
			},
			ownKeys() {
				return visibleKeys(raw).map((k) => logicKey(k))
			},
			getOwnPropertyDescriptor(_target, prop) {
				if (typeof prop === 'symbol') return undefined
				if (prop in storageProto) return undefined
				const v = raw.getItem(physKey(prop))
				if (v === null) return undefined
				return { value: v, writable: true, enumerable: true, configurable: true }
			},
			defineProperty(_target, prop, desc) {
				if (typeof prop === 'symbol' || !('value' in desc)) return true
				raw.setItem(physKey(prop), String(desc.value))
				return true
			},
		})
		return proxy
	}

	const localProxy = makeStorage(real.local)
	const sessionProxy = makeStorage(real.session)

	// 覆盖 window 上的访问器：页面拿到的就是包装后的对象
	try {
		Object.defineProperty(window, 'localStorage', { get: () => localProxy, configurable: true })
		Object.defineProperty(window, 'sessionStorage', { get: () => sessionProxy, configurable: true })
	} catch {
		return
	}
	// 覆盖失败时保持原生行为（不抛错、不影响页面）

	// ------------------------------------------------------------ document.cookie
	// 浏览器按「源」存 cookie，而所有被代理站点共用同一个源：
	// A 站 JS 写下的 cookie，B 站的 JS 能直接读到（实测），同名还会互相覆盖。
	// 做法与 Storage 一致 —— 给 cookie 名加前缀，读写时再摘掉。
	// 这些 cookie 只存在于浏览器侧；发往目标站的 Cookie 头由服务端 CookieJar 生成
	// （server/cookieJar.js），所以加前缀不会影响目标站的登录态。
	const originTag = (() => {
		try {
			return btoa(targetOrigin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
		} catch {
			return 'x'
		}
	})()
	const COOKIE_PREFIX = `pa_${originTag}_`
	const splitCookie = (s) => String(s || '').split(';').map((x) => x.trim()).filter(Boolean)

	try {
		const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
		if (cookieDesc && cookieDesc.get && cookieDesc.set) {
			Object.defineProperty(Document.prototype, 'cookie', {
				configurable: true,
				get() {
					const raw = cookieDesc.get.call(this)
					if (!raw) return ''
					const out = []
					for (const pair of splitCookie(raw)) {
						const eq = pair.indexOf('=')
						const name = eq === -1 ? pair : pair.slice(0, eq)
						if (!name.startsWith(COOKIE_PREFIX)) continue
						out.push(name.slice(COOKIE_PREFIX.length) + (eq === -1 ? '' : pair.slice(eq)))
					}
					return out.join('; ')
				},
				set(value) {
					const parts = splitCookie(String(value))
					if (!parts.length) return
					const head = parts.shift()
					const eq = head.indexOf('=')
					const name = (eq === -1 ? head : head.slice(0, eq)).trim()
					if (!name) return
					const attrs = []
					for (const a of parts) {
						// domain 在代理下没有意义，还可能让浏览器拒写整条 cookie
						if (a.split('=')[0].trim().toLowerCase() === 'domain') continue
						attrs.push(a)
					}
					const renamed = COOKIE_PREFIX + name + (eq === -1 ? '' : head.slice(eq))
					cookieDesc.set.call(this, renamed + (attrs.length ? '; ' + attrs.join('; ') : ''))
				},
			})
		}
	} catch {
		// 隔离失败不影响页面：退回浏览器原生行为
	}

	// Cookie Store API（Chrome 有）：同一套前缀规则，避免被绕开
	try {
		const cs = window.cookieStore
		if (cs && typeof cs.get === 'function' && !cs.__paPatched) {
			const strip = (o) => (o && typeof o.name === 'string' && o.name.startsWith(COOKIE_PREFIX)
				? { ...o, name: o.name.slice(COOKIE_PREFIX.length) }
				: o)
			const nameOf = (arg) => (typeof arg === 'string' ? arg : arg && typeof arg.name === 'string' ? arg.name : null)
			const wrapQuery = (arg) => {
				const n = nameOf(arg)
				if (n === null) return typeof arg === 'object' ? arg : [arg]
				return typeof arg === 'string' ? COOKIE_PREFIX + n : { ...arg, name: COOKIE_PREFIX + n }
			}
			const origGet = cs.get.bind(cs)
			const origGetAll = cs.getAll.bind(cs)
			const origSet = cs.set.bind(cs)
			const origDelete = cs.delete.bind(cs)
			// 只交出本站的条目：getAll() 不带参数会返回同一个源下的**全部** cookie，
			// 不过滤就等于把别站的 cookie（连名带值）直接交给页面（实测）。
			const mineOnly = (list) => list.filter((c) => c && typeof c.name === 'string' && c.name.startsWith(COOKIE_PREFIX)).map(strip)
			const mineOrNull = (c) => (c && typeof c.name === 'string' && c.name.startsWith(COOKIE_PREFIX) ? strip(c) : null)
			Object.defineProperties(cs, {
				get: { configurable: true, writable: true, value: (arg) => origGet(wrapQuery(arg)).then(mineOrNull) },
				getAll: {
					configurable: true,
					writable: true,
					value: (arg) => (arg === undefined ? origGetAll() : origGetAll(wrapQuery(arg))).then(mineOnly),
				},
				set: {
					configurable: true,
					writable: true,
					value: (a, b) => (typeof a === 'string'
						? origSet(COOKIE_PREFIX + a, b)
						: origSet({ ...a, name: COOKIE_PREFIX + String(a && a.name) })),
				},
				delete: { configurable: true, writable: true, value: (arg) => origDelete(wrapQuery(arg)) },
				__paPatched: { value: true, configurable: true },
			})
		}
	} catch {
		/* Cookie Store API 不可用就算了，document.cookie 已覆盖绝大多数场景 */
	}

	// ------------------------------------------------------------ IndexedDB
	// 同一个源下 IndexedDB 也是共享的，A 站建的库 B 站能直接打开（实测读到了 A 的数据）。
	// 这里只做「库名加前缀」，不碰对象仓库与索引，语义不变。
	try {
		const idb = window.indexedDB
		if (idb && typeof idb.open === 'function' && !idb.__paPatched) {
			const origOpen = idb.open.bind(idb)
			const origDelete = typeof idb.deleteDatabase === 'function' ? idb.deleteDatabase.bind(idb) : null
			const origList = typeof idb.databases === 'function' ? idb.databases.bind(idb) : null

			Object.defineProperty(idb, 'open', {
				configurable: true,
				writable: true,
				value: function (name, version) {
					const args = [PREFIX + String(name)]
					if (version !== undefined) args.push(version)
					return origOpen(...args)
				},
			})
			if (origDelete) {
				Object.defineProperty(idb, 'deleteDatabase', {
					configurable: true,
					writable: true,
					value: (name) => origDelete(PREFIX + String(name)),
				})
			}
			if (origList) {
				Object.defineProperty(idb, 'databases', {
					configurable: true,
					writable: true,
					value: async () => {
						const all = await origList()
						return all
							.filter((d) => typeof d.name === 'string' && d.name.startsWith(PREFIX))
							.map((d) => ({ ...d, name: d.name.slice(PREFIX.length) }))
					},
				})
			}
			Object.defineProperty(idb, '__paPatched', { value: true, configurable: true })

			// 页面拿到的 IDBDatabase.name 应该是它请求的名字，而不是内部加过前缀的
			const resultDesc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result')
			if (resultDesc && resultDesc.get) {
				Object.defineProperty(IDBRequest.prototype, 'result', {
					configurable: true,
					get() {
						const value = resultDesc.get.call(this)
						try {
							if (
								value instanceof IDBDatabase &&
								typeof value.name === 'string' &&
								value.name.startsWith(PREFIX)
							) {
								Object.defineProperty(value, 'name', {
									value: value.name.slice(PREFIX.length),
									configurable: true,
								})
							}
						} catch {
							/* name 只读，忽略 */
						}
						return value
					},
				})
			}
		}
	} catch {
		// 隔离失败也不影响页面：退回浏览器原生行为
	}

	// ------------------------------------------------------------ StorageEvent
	const nativeAdd = window.addEventListener
	const nativeRemove = window.removeEventListener
	const wrappedListeners = new WeakMap()

	function toLogicEvent(ev) {
		if (!ev || ev.type !== 'storage') return ev
		const key = ev.key
		// key === null 表示「某个文档调了 clear()」，与本站无关，直接吞掉
		if (key === null) return null
		if (isInternal(key)) return ev
		const next = logicKey(key)
		if (next === null) return null
		try {
			return new StorageEvent('storage', {
				key: next,
				oldValue: ev.oldValue,
				newValue: ev.newValue,
				url: ev.url,
				// 这里必须传**原生** Storage 对象：StorageEvent 初始化器对 storageArea
				// 做 brand check，传包装后的 Proxy 会直接抛 TypeError（实测）。
				// 代价是 `e.storageArea === localStorage` 为 false，比「key 带着前缀交出去」影响小。
				storageArea: ev.storageArea === real.local ? real.local : real.session,
			})
		} catch {
			// 极端情况下至少把原始事件交出去
			return ev
		}
	}

	try {
		window.addEventListener = function (type, listener, options) {
			if (type !== 'storage' || typeof listener !== 'function') {
				return nativeAdd.call(this, type, listener, options)
			}
			const wrapped = function (ev) {
				const mapped = toLogicEvent(ev)
				if (!mapped) return
				return listener.call(this, mapped)
			}
			wrappedListeners.set(listener, wrapped)
			return nativeAdd.call(this, type, wrapped, options)
		}
		window.removeEventListener = function (type, listener, options) {
			const wrapped = type === 'storage' && typeof listener === 'function'
				? wrappedListeners.get(listener)
				: null
			if (wrapped) {
				wrappedListeners.delete(listener)
				return nativeRemove.call(this, type, wrapped, options)
			}
			return nativeRemove.call(this, type, listener, options)
		}
		let onStorage = null
		Object.defineProperty(window, 'onstorage', {
			configurable: true,
			get: () => onStorage,
			set: (fn) => {
				if (onStorage) window.removeEventListener('storage', onStorage)
				onStorage = typeof fn === 'function' ? fn : null
				if (onStorage) window.addEventListener('storage', onStorage)
			},
		})
	} catch {
		// 事件包装失败不影响存储隔离本身
	}
})()
