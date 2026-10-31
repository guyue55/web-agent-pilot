/**
 * 回归：DNS rebinding 打不穿 SSRF 防护（HTTP 与 WebSocket 两条路径）
 *
 * 背景：`validateTargetUrl` / `assertTargetSafe` 是「先解析、后建连」，
 * 而 Node / undici 建连时会**自己再解析一次**。攻击者控制的 DNS 第一次回答公网、
 * 第二次回答 127.0.0.1，预检就形同虚设（实测能读出内网数据）。
 * 修复：security.safeLookup 在建连那一刻校验真正要连的 IP。
 *
 * 本脚本在自己进程里模拟这种 DNS（改 dns.lookup / dns.promises.lookup），
 * 因此会另起一个应用实例（默认 3218），不影响你正在跑的那个。
 *
 * 断言：
 *  A) 对照组：直接写内网 IP 字面量 → 403（基线）
 *  B) 攻击组：域名 + 两次不同解析 + HTTP 路径 → 拿不到内网数据
 *  C) 攻击组：域名 + 两次不同解析 + WS 路径   → 拿不到内网数据
 *
 * 用法：node scripts/check-rebind.mjs
 */
import dns from 'node:dns'
import net from 'node:net'
import http from 'node:http'

const EVIL = 'evil-rebind.test'
const HTTP_PORT = 3511
const WS_PORT = 3512
const APP_PORT = Number(process.env.REBIND_APP_PORT || 3218)
const SECRET = 'INTERNAL-SECRET-DATA'

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

// ---------------- 伪造 DNS：校验侧说公网，连接侧说本机
//
// 注意计数方式：解析走 dnsResolver.resolveHost，其系统兜底分支用的是
// dns.promises.lookup。这里让第一次答复给公网、之后都给本机 ——
// 这正是 rebinding 的形态：预检放行，建连时才换成本机地址。
const origLookup = dns.lookup.bind(dns)
const origPromiseLookup = dns.promises.lookup.bind(dns.promises)
const hits = { verify: 0, connect: 0 }
let promiseCalls = 0

const resetRebind = () => {
	promiseCalls = 0
}

dns.promises.lookup = async (hostname, options) => {
	if (hostname === EVIL) {
		hits.verify++
		const address = promiseCalls++ === 0 ? '93.184.216.34' : '127.0.0.1'
		return options?.all ? [{ address, family: 4 }] : { address, family: 4 }
	}
	return origPromiseLookup(hostname, options)
}
dns.lookup = (hostname, options, callback) => {
	if (typeof options === 'function') {
		callback = options
		options = {}
	}
	if (hostname === EVIL) {
		hits.connect++
		// 注意 all: true 时必须回数组，否则 net 会抛错（本轮实测踩过）
		return process.nextTick(() =>
			options?.all
				? callback(null, [{ address: '127.0.0.1', family: 4 }])
				: callback(null, '127.0.0.1', 4)
		)
	}
	return origLookup(hostname, options, callback)
}

// ---------------- 内网受害者
const victimHttp = http.createServer((_q, res) => res.end(SECRET))
const victimWs = net.createServer((socket) => {
	socket.once('data', () =>
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n' + SECRET
		)
	)
})
await new Promise((r) => victimHttp.listen(HTTP_PORT, '127.0.0.1', r))
await new Promise((r) => victimWs.listen(WS_PORT, '127.0.0.1', r))

// ---------------- 应用（默认配置：不放行本机 / 内网）
process.env.PORT = String(APP_PORT)
process.env.ALLOW_LOCALHOST = 'false'
// 本用例要观察「预检解析」与「建连解析」是两次独立查询：
// 解析结果缓存会把两次合并成一次，那样就测不到建连路径了，这里关掉缓存。
process.env.DNS_CACHE_TTL_MS = '0'
// 本用例验证的是「IP 校验」这一层，DoH 与系统解析最后都走同一段校验代码；
// 用 system 模式可以避免每次解析都先等一轮 DoH 对不存在域名的 NXDOMAIN。
process.env.PROXY_DNS_MODE = 'system'
await import('../server/index.js')
await new Promise((r) => setTimeout(r, 800))

const get = (path) =>
	fetch(`http://127.0.0.1:${APP_PORT}${path}`)
		.then(async (r) => ({ status: r.status, body: await r.text() }))
		.catch((e) => ({ status: 0, body: String(e.message) }))

function upgrade(pathAndHost) {
	return new Promise((resolve) => {
		const s = net.connect({ host: '127.0.0.1', port: APP_PORT }, () =>
			s.write(
				[
					`GET ${pathAndHost} HTTP/1.1`,
					`Host: 127.0.0.1:${APP_PORT}`,
					'Upgrade: websocket',
					'Connection: Upgrade',
					'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
					'Sec-WebSocket-Version: 13',
					'',
					'',
				].join('\r\n')
			)
		)
		let buf = ''
		s.on('data', (d) => (buf += d.toString()))
		s.on('close', () => resolve(buf))
		setTimeout(() => {
			s.destroy()
			resolve(buf)
		}, 5000)
	})
}

console.log('\n===== A) 对照组：直接写内网 IP 字面量 =====')
const literal = await get(`/__pa/http/127.0.0.1:${HTTP_PORT}/`)
ok(literal.status === 403, 'IP 字面量被拦（基线）', `状态 ${literal.status}`)

console.log('\n===== B) HTTP 路径：域名 rebinding =====')
resetRebind()
const viaHttp = await get(`/__pa/http/${EVIL}:${HTTP_PORT}/`)
ok(!viaHttp.body.includes(SECRET), '没有读到内网数据', `状态 ${viaHttp.status}`)
ok(viaHttp.status !== 200, '请求没有被当成正常响应返回', `状态 ${viaHttp.status}`)

console.log('\n===== C) WebSocket 路径：域名 rebinding =====')
resetRebind()
const viaWs = await upgrade(`/__paws/http/${EVIL}:${WS_PORT}/echo`)
ok(!viaWs.includes(SECRET), '没有读到内网数据', (viaWs.split('\r\n')[0] || '').slice(0, 60))
ok(/40[134]|502/.test(viaWs.split('\r\n')[0] || ''), '连接被拒绝/失败而不是 101', (viaWs.split('\r\n')[0] || '').slice(0, 60))

console.log('\nDNS 打点（预检解析 / 建连侧 callback 解析）:', hits.verify, '/', hits.connect)
ok(
	hits.verify + hits.connect >= 2,
	'同一域名被解析了不止一次（说明确实走到了建连路径，并被当场拦下）'
)

victimHttp.close()
victimWs.close()
console.log(`\n结果：${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
