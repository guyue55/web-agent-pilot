/**
 * 回归：目标站解析走 DoH（绕开被劫持的系统解析）
 *
 * 背景：线上（CloudStudio）访问 https://skillhub.cn/ 时，代理拿到的是 DNSPod 的
 * 错误页「糟糕，页面好像去火星了......」；把域名写成带尾点的 `skillhub.cn.` 再试，
 * TLS 证书是 `*.unionpayintl.com`。同一时刻用 DoH 查询却是稳定的 EdgeOne 节点。
 * 即：系统解析结果不可信，站点内容因此变成了别人的 404。
 *
 * 断言：
 *  A) DoH 能给出公网地址，且 stats 记录确实走了 DoH
 *  B) 第二次解析命中缓存，不再发起 DoH 查询（否则每个子资源都要多一次往返）
 *  C) 代理端到端：通过本服务访问该站点，拿到的是站点自己的 HTML（不是错误页）
 *  D) system 模式仍可用（DoH 不可达时的兜底路径）
 *
 * 前置：应用已启动（默认 BASE=http://127.0.0.1:3211）
 * 用法：BASE=http://127.0.0.1:3211 node scripts/check-dns.mjs
 */
import net from 'node:net'
import { execFileSync } from 'node:child_process'

const BASE = process.env.BASE || 'http://127.0.0.1:3211'
const TARGET = process.env.DNS_TARGET || 'skillhub.cn'

// 本脚本要验证的是 DoH 这条分支本身。AUTO 模式在 fake-ip 环境（本机常见）下会
// 主动放行系统解析，那样测不到 DoH，因此这里显式强制 doh 模式。
process.env.PROXY_DNS_MODE = process.env.PROXY_DNS_MODE || 'doh'

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

function isPublic(ip) {
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

const { resolveHost, getDnsStats } = await import('../server/dnsResolver.js')

console.log('\n===== A) DoH 解析 =====')
const before = getDnsStats()
const records = await resolveHost(TARGET)
const after = getDnsStats()
console.log(`  解析结果：${records.map((r) => r.address).join(', ') || '(空)'}`)
ok(records.length > 0, '拿到解析结果')
ok(records.every((r) => isPublic(r.address)), '结果都是公网地址（没有被解析到内网）')
ok(after.dohHits > before.dohHits, '确实走了 DoH（而不是系统解析）', `dohHits ${before.dohHits}→${after.dohHits}`)

console.log('\n===== B) 结果缓存 =====')
const hitsBefore = getDnsStats().dohHits
const again = await resolveHost(TARGET)
const hitsAfter = getDnsStats().dohHits
ok(again.length > 0 && again[0].address === records[0].address, '第二次结果一致')
ok(hitsAfter === hitsBefore, '第二次没有发起新的 DoH 查询（命中缓存）', `dohHits ${hitsBefore}→${hitsAfter}`)

console.log('\n===== C) 代理端到端 =====')
const res = await fetch(`${BASE}/__pa/https/${TARGET}/`, { signal: AbortSignal.timeout(60_000) })
const html = await res.text()
ok(res.status === 200, '代理返回 200', `状态 ${res.status}`)
ok(html.includes('__PAStorageShim') || html.includes('/_app/storage-shim.js'), '页面带上了本站注入（说明确实走了代理链路）')
ok(!html.includes('去火星'), '拿到的不是「页面未找到」错误页')
ok(!html.includes('tea-errorpage'), '拿到的不是平台错误模板')
ok(/skillhub/i.test(html), '内容与目标站一致')

console.log('\n===== D) system 模式兜底 =====')
const sysOut = execFileSync(
	process.execPath,
	[
		'--input-type=module',
		'-e',
		`process.env.PROXY_DNS_MODE='system';
		 const m = await import('${new URL('../server/dnsResolver.js', import.meta.url).pathname}');
		 const r = await m.resolveHost('${TARGET}');
		 console.log(JSON.stringify({ addrs: r.map(x => x.address), stats: m.getDnsStats() }));`,
	],
	{ encoding: 'utf8', timeout: 30_000 }
)
const sys = JSON.parse(sysOut.trim().split('\n').pop())
ok(Array.isArray(sys.addrs) && sys.addrs.length > 0, 'system 模式仍能解析出地址', sys.addrs.join(','))
ok(sys.stats.systemFallbacks > 0, 'system 模式确实走系统解析')

console.log('\n===== E) auto 模式下对 fake-ip 环境的放行 =====')
const autoOut = execFileSync(
	process.execPath,
	[
		'--input-type=module',
		'-e',
		`process.env.PROXY_DNS_MODE='auto';
		 const dnsMod = await import('node:dns');
		 const sys = await dnsMod.default.promises.lookup('${TARGET}', { all: true });
		 const fake = sys.every(x => /^198\\.(1[89])\\./.test(x.address));
		 const m = await import('${new URL('../server/dnsResolver.js', import.meta.url).pathname}');
		 const r = await m.resolveHost('${TARGET}');
		 console.log(JSON.stringify({ fake, addrs: r.map(x => x.address), stats: m.getDnsStats() }));`,
	],
	{ encoding: 'utf8', timeout: 30_000 }
)
const auto = JSON.parse(autoOut.trim().split('\n').pop())
if (!auto.fake) {
	console.log(`  ⏭  当前环境的系统解析不是 fake-ip（${auto.addrs.join(',')}），这一组不适用`)
} else {
	ok(
		auto.stats.fakeIpPassthrough > 0,
		'fake-ip 环境下 auto 模式直接放行系统解析（避免绕过本地代理）',
		JSON.stringify(auto.addrs)
	)
	ok(auto.addrs.every((a) => /^198\.(1[89])\./.test(a)), '返回的仍是系统解析结果')
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
