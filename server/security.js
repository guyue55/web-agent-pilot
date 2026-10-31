/**
 * URL 解析 / 安全策略
 * - 只允许 http(s)
 * - SSRF 防护：解析 DNS 后校验目标 IP 不属于私有 / 保留网段
 */
import dns from 'node:dns'
import net from 'node:net'

const ALLOW_LOCALHOST = process.env.ALLOW_LOCALHOST === 'true'

/** localhost / 私有 / 链路本地 / 保留网段黑名单 */
function isPrivateHostname(hostname) {
	const host = hostname.toLowerCase().replace(/\.$/, '')
	if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') return true
	if (host.endsWith('.local') || host.endsWith('.internal')) return true
	return false
}

function isPrivateIP(ip) {
	if (net.isIP(ip)) {
		if (ip === '::1' || ip === '::' || ip === '0.0.0.0') return true
		// IPv4-mapped IPv6 ::ffff:127.0.0.1
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
		const v4 = mapped ? mapped[1] : ip
		if (net.isIPv4(v4)) {
			const parts = v4.split('.').map(Number)
			const [a, b] = parts
			if (a === 0) return true // 0.0.0.0/8
			if (a === 10) return true // 10.0.0.0/8
			if (a === 127) return true // 127.0.0.0/8 loopback
			if (a === 169 && b === 254) return true // link-local
			if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
			if (a === 192 && b === 168) return true // 192.168.0.0/16
			if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
			if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF 协议分配
			if (a >= 224) return true // multicast / reserved / broadcast
			// 注：198.18.0.0/15（RFC2544 基准测试段）被大量本地 DNS / fake-ip 方案占用，
			//     误拦会导致所有网站都无法代理，故不列入黑名单。
		} else {
			// IPv6 私有段
			if (/^f[cd]/.test(ip)) return true // fc00::/7 unique local
			if (/^fe[89ab]/.test(ip)) return true // fe80::/10 link-local
			if (/^ff/.test(ip)) return true // multicast
		}
	}
	return false
}

const dnsCache = new Map()
async function resolveAddresses(hostname) {
	if (net.isIP(hostname)) return [hostname]
	if (dnsCache.has(hostname)) return dnsCache.get(hostname)
	let addresses = []
	try {
		const results = await dns.promises.lookup(hostname, { all: true })
		addresses = results.map((r) => r.address)
		dnsCache.set(hostname, addresses)
		setTimeout(() => dnsCache.delete(hostname), 60_000).unref?.()
	} catch {
		addresses = []
	}
	return addresses
}

/**
 * 校验并规范化用户输入的目标 URL
 * @returns {Promise<{ok: true, url: URL} | {ok: false, reason: string}>}
 */
export async function validateTargetUrl(raw) {
	if (!raw || typeof raw !== 'string') return { ok: false, reason: 'URL 为空' }
	let input = raw.trim()
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) input = 'https://' + input

	let url
	try {
		url = new URL(input)
	} catch {
		return { ok: false, reason: 'URL 格式不合法' }
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, reason: `不支持的协议 ${url.protocol}` }
	}
	if (isPrivateHostname(url.hostname)) {
		if (!ALLOW_LOCALHOST) return { ok: false, reason: '禁止代理内网 / 本机地址（可设 ALLOW_LOCALHOST=true 放开）' }
		return { ok: true, url }
	}
	const addresses = await resolveAddresses(url.hostname)
	if (addresses.length === 0) {
		if (!ALLOW_LOCALHOST) return { ok: false, reason: `域名解析失败：${url.hostname}` }
		return { ok: true, url }
	}
	const privateOne = addresses.find(isPrivateIP)
	if (privateOne && !ALLOW_LOCALHOST) {
		return { ok: false, reason: '禁止代理内网 / 本机地址（可设 ALLOW_LOCALHOST=true 放开）' }
	}
	return { ok: true, url }
}

/** 无 DNS 校验版本：用于 __p 路径里已经解析过的 host（性能 + 已校验场景） */
export function checkProxyTarget(protocol, hostname) {
	if (protocol !== 'http:' && protocol !== 'https:') return '不支持的协议'
	if (isPrivateHostname(hostname) && !ALLOW_LOCALHOST) return '禁止代理内网 / 本机地址'
	return null
}

export function isSafeIpForProxy(ip) {
	return !isPrivateIP(ip) || ALLOW_LOCALHOST
}

/**
 * 建连时的 IP 校验（传给 net.connect / tls.connect / undici 的 `lookup`）。
 *
 * 为什么必须在这里再做一次：`assertTargetSafe` 是「先解析、后连接」，
 * 而真正建连时 Node / undici 会**自己再解析一次**。攻击者控制的 DNS 只要
 * 第一次回答公网、第二次回答 127.0.0.1，预检就白做了（实测可读出内网数据）。
 * 这个函数是连接路径上唯一还能拦住的地方 —— 它校验的就是即将被连接的那个 IP。
 */
export function safeLookup(hostname, options, callback) {
	let opts = options
	let cb = callback
	if (typeof opts === 'function') {
		cb = opts
		opts = {}
	}
	dns.lookup(hostname, opts || {}, (err, address, family) => {
		if (err) return cb(err)
		const list = Array.isArray(address) ? address : [{ address, family }]
		const bad = list.find((a) => a && !isSafeIpForProxy(a.address))
		if (bad) {
			const blocked = new Error(
				`目标地址解析到内网 / 保留地址（${bad.address}），已拒绝连接`
			)
			blocked.code = 'PA_BLOCKED_TARGET'
			return cb(blocked)
		}
		return Array.isArray(address) ? cb(null, address) : cb(null, address, family)
	})
}

export { resolveAddresses }
