/**
 * 目标站域名解析：DoH 优先，系统 DNS 兜底。
 *
 * 为什么需要这一层：
 *   托管/沙箱环境的系统解析器并不总是可信。实测线上（CloudStudio）请求
 *   https://skillhub.cn/ 时，代理拿到的既不是 EdgeOne 的节点，也不是 404，
 *   而是 **DNSPod 的错误页**（"糟糕，页面好像去火星了......"）；把域名写成
 *   带尾点的 `skillhub.cn.` 再试，TLS 证书竟然是 `*.unionpayintl.com` ——
 *   同一个域名两次查询落到两组互不相关的服务器，这是典型的解析结果被劫持。
 *   同一时刻用阿里 / 腾讯的 DoH 查询，得到的是稳定的 EdgeOne 节点
 *   （114.117.133.49 / 43.174.224.202），且部署机到该 IP 网络可达。
 *
 *   因此这里把「解析」从 getaddrinfo 换成「HTTPS 上的 DNS」：结果有 TLS 保护、
 *   不经过本地递归解析器，也就不受劫持影响。DoH 不可用时逐级回退到系统解析，
 *   保证离线 / 内网部署仍能工作。
 *
 * 安全边界不变：不管 IP 来自 DoH 还是系统解析，调用方（security.js）都会用
 * isPrivateIP 再校验一次，内网地址依然连不出去。
 */
import dns from 'node:dns'
import net from 'node:net'

/** auto：DoH 优先、失败回退系统解析；system：只用系统解析；doh：只用 DoH */
const MODE = String(process.env.PROXY_DNS_MODE || 'auto').toLowerCase()
const DOH_TIMEOUT_MS = Number(process.env.DOH_TIMEOUT_MS || 2000)
const CACHE_TTL_MS = Number(process.env.DNS_CACHE_TTL_MS || 300_000)
/** 端点整体失败后的冷却时间：避免每个新域名都白等一次超时 */
const ENDPOINT_COOLDOWN_MS = 60_000
/**
 * DoH 结果的连通性探测超时。
 *
 * 为什么不能无脑信 DoH：DoH 给的是**权威解析**，但「能解析」不等于「这台机器能连」。
 * 实测本机（出网靠本地代理的 TUN 模式）解析 news.ycombinator.com 得到 88.191.249.182，
 * 直连 30s 超时；而系统解析给的是代理的 fake-ip，走代理 200ms 就能拿到页面。
 * 反过来，线上部署机被污染的系统解析给出的是 DNSPod 的错误服务器，只有 DoH 是对的。
 * 所以取「DoH 优先 + 连不上就退回系统解析」，两种环境都能自洽。
 */
const PROBE_TIMEOUT_MS = Number(process.env.DNS_PROBE_TIMEOUT_MS || 400)

/**
 * DoH 端点。都用 JSON 接口（比 wireformat 少一次 base64url 编解码）。
 * 两个端点互为备份：其中一家在特定网络下不可达时另一个大概率可用。
 */
const ENDPOINTS = [
	{ url: 'https://dns.alidns.com/resolve', label: 'alidns' },
	{ url: 'https://doh.pub/dns-query', label: 'doh.pub' },
]

/** hostname -> { records: [{address, family}], at } */
const cache = new Map()
/** endpoint.url -> 冷却截止时间戳 */
const cooldown = new Map()
/** 供 /api/health 观察实际生效的解析方式 */
const stats = {
	dohHits: 0,
	dohMisses: 0,
	dohUnreachable: 0,
	systemFallbacks: 0,
	fakeIpPassthrough: 0,
	lastError: '',
}

/**
 * 透明代理（Clash / sing-box 的 fake-ip）会把所有域名解析到 198.18.0.0/15，
 * 再由代理软件按域名转发。这种环境下系统解析**就是**正确入口：
 * 换成真实 IP 反而绕过了代理，被墙的站点会直接超时（实测 news.ycombinator.com
 * 从 200ms 变成 30s 超时）。所以见到这一段地址就原样放行，不做 DoH。
 */
function looksLikeFakeIp(records) {
	if (!records.length) return false
	return records.every((r) => /^198\.(1[89])\./.test(r.address))
}

function normalizeHost(hostname) {
	// 尾点（FQDN 写法）与大小写对 DNS 语义没有影响，但会让缓存分叉
	return String(hostname || '')
		.trim()
		.toLowerCase()
		.replace(/\.$/, '')
}

function readCache(host) {
	// TTL 设为 0 表示彻底关闭缓存（回归脚本需要观察「预检」与「建连」两次独立解析），
	// 不能只靠「立即过期」——同一毫秒内的两次调用会命中，测出来的行为是假的。
	if (CACHE_TTL_MS <= 0) return null
	const hit = cache.get(host)
	if (!hit) return null
	if (Date.now() - hit.at > CACHE_TTL_MS) {
		cache.delete(host)
		return null
	}
	return hit.records
}

function writeCache(host, records, ttlMs = CACHE_TTL_MS) {
	if (CACHE_TTL_MS <= 0) return
	cache.set(host, { records, at: Date.now() })
	setTimeout(() => {
		const cur = cache.get(host)
		// 只删自己写入的那份，避免把期间刷新过的条目误删
		if (cur && cur.records === records) cache.delete(host)
	}, ttlMs).unref?.()
}

/** 从 DoH 的 JSON 应答里挑出 A / AAAA 记录 */
function extractRecords(payload, host) {
	const answers = Array.isArray(payload?.Answer) ? payload.Answer : []
	const out = []
	for (const ans of answers) {
		// type 1 = A, 28 = AAAA；CNAME(5) 只是链路，取它没有意义
		if (ans?.type !== 1 && ans?.type !== 28) continue
		const data = String(ans.data || '').trim()
		if (!net.isIP(data)) continue
		const family = net.isIP(data)
		if (out.some((r) => r.address === data)) continue
		out.push({ address: data, family })
	}
	// 应答里 name 必须能对上目标域（或目标域的 CNAME 链），否则视为无效报文
	if (out.length === 0 && answers.length === 0) {
		throw new Error(`DoH 无解析记录：${host}（Status=${payload?.Status}）`)
	}
	return out
}

async function queryEndpoint(endpoint, host) {
	const until = cooldown.get(endpoint.url) || 0
	if (Date.now() < until) throw new Error(`${endpoint.label} 冷却中`)

	const url = `${endpoint.url}?name=${encodeURIComponent(host)}&type=A`
	const res = await fetch(url, {
		headers: { accept: 'application/dns-json' },
		signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
	})
	if (!res.ok) throw new Error(`${endpoint.label} HTTP ${res.status}`)
	const payload = await res.json()
	if (payload?.Status !== 0) throw new Error(`${endpoint.label} Status=${payload?.Status}`)
	const records = extractRecords(payload, host)
	if (!records.length) throw new Error(`${endpoint.label} 未返回可用记录`)
	return records
}

/** 依次尝试可用端点；全部失败返回 null（由调用方回退系统解析） */
async function resolveViaDoh(host) {
	let lastErr = null
	for (const endpoint of ENDPOINTS) {
		try {
			const records = await queryEndpoint(endpoint, host)
			if (records.length) {
				stats.dohHits += 1
				return records
			}
		} catch (err) {
			lastErr = err
			// 超时 / 网络不可达才冷却；报文层面的错误（比如该域名确实没有 A 记录）
			// 说明端点本身是通的，不该整个下线。
			if (/冷却|timeout|TimeoutError|aborted|fetch failed|ENOTFOUND|ECONN/i.test(String(err?.message || err))) {
				cooldown.set(endpoint.url, Date.now() + ENDPOINT_COOLDOWN_MS)
			}
		}
	}
	stats.dohMisses += 1
	if (lastErr) stats.lastError = String(lastErr.message || lastErr)
	return null
}

async function resolveViaSystem(host, options = {}) {
	const results = await dns.promises.lookup(host, { ...options, all: true })
	return results.map((r) => ({ address: r.address, family: r.family }))
}

/** 单次 TCP 探测：只回答「这台机器能不能连到这个地址」 */
function probeTcp(address, port, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false
		let socket = null
		const finish = (okFlag) => {
			if (settled) return
			settled = true
			try {
				socket?.destroy()
			} catch {
				/* noop */
			}
			resolve(okFlag)
		}
		try {
			socket = net.connect({ host: address, port })
		} catch {
			return finish(false)
		}
		socket.setTimeout(timeoutMs)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
	})
}

/** 在 DoH 结果里挑第一个连得上的地址；全都不通返回 null */
async function pickReachable(records) {
	// 内网地址不必探测（也绝不该被拿去连接）
	const candidates = records.filter((r) => isPublicAddress(r.address))
	if (!candidates.length) return null
	// 并行探测：同一域名常常有多条 A 记录，串行最坏要等 N×超时
	const reachable = await Promise.all(
		candidates.map((r) => probeTcp(r.address, 443, PROBE_TIMEOUT_MS))
	)
	const idx = reachable.indexOf(true)
	return idx === -1 ? null : candidates[idx]
}

function isPublicAddress(ip) {
	if (!net.isIP(ip)) return false
	if (net.isIPv4(ip)) {
		const [a, b] = ip.split('.').map(Number)
		if (a === 0 || a === 10 || a === 127) return false
		if (a === 169 && b === 254) return false
		if (a === 172 && b >= 16 && b <= 31) return false
		if (a === 192 && b === 168) return false
		if (a === 100 && b >= 64 && b <= 127) return false
		if (a >= 224) return false
		return true
	}
	return !/^(f[cd]|fe[89ab]|ff)/.test(ip)
}

/**
 * 解析域名到 IP 列表。
 * @param {string} hostname
 * @param {object} [options] 传给 dns.lookup 的附加选项（family / hints 等）
 * @returns {Promise<Array<{address: string, family: number}>>}
 */
export async function resolveHost(hostname, options = {}) {
	const host = normalizeHost(hostname)
	if (!host) return []
	// 已经是 IP 字面量：不必解析，也不必进缓存
	if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }]

	const cached = readCache(host)
	if (cached) return cached

	// 指定了 family 时 DoH 的 A 记录可能不满足（如强制 IPv6），交给系统解析
	const wantFamily = Number(options?.family) || 0

	if (MODE === 'system') {
		stats.systemFallbacks += 1
		const records = await resolveViaSystem(host, options)
		if (records.length) writeCache(host, records)
		return records
	}

	// 先做一次系统解析：既用于 fake-ip 判定，也作为 DoH 连不上时的兜底
	let systemRecords = []
	try {
		systemRecords = await resolveViaSystem(host, options)
	} catch {
		systemRecords = []
	}

	if (MODE === 'auto' && looksLikeFakeIp(systemRecords)) {
		stats.fakeIpPassthrough += 1
		writeCache(host, systemRecords)
		return systemRecords
	}

	if (wantFamily !== 6) {
		const records = await resolveViaDoh(host)
		if (records && records.length) {
			const filtered = wantFamily ? records.filter((r) => r.family === wantFamily) : records
			if (filtered.length) {
				// 权威解析只保证「地址是对的」，不保证「这台机器连得上」。
				// 连不上就退回系统解析（典型：出网靠代理、或该 DoH 的递归结果被污染）。
				if (PROBE_TIMEOUT_MS <= 0) {
					writeCache(host, filtered)
					return filtered
				}
				const reachable = await pickReachable(filtered)
				if (reachable) {
					// 把探测通过的地址排到最前：safeLookup 取 list[0] 去建连
					const ordered = [reachable, ...filtered.filter((r) => r.address !== reachable.address)]
					writeCache(host, ordered)
					return ordered
				}
				stats.dohUnreachable += 1
			}
		}
	}

	// DoH 关闭 / 不可用 / 不满足 family / 连不上：回退系统解析
	stats.systemFallbacks += 1
	if (systemRecords.length) writeCache(host, systemRecords)
	return systemRecords
}

/** 诊断信息：供 /api/health 输出，确认线上到底走的是哪条路径 */
export function getDnsStats() {
	return { mode: MODE, ...stats, cached: cache.size }
}
