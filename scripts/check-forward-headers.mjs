/**
 * 回归：转发给目标站的请求头不得带「代理链元信息」与「平台身份凭证」
 *
 * 背景（线上实测，两个都是真 bug）：
 *  1) CloudStudio 网关给每个请求加 `x-forwarded-host=<沙箱域名>`。代理层此前
 *     「除黑名单外全量转发」，把 x-forwarded-host 送给了目标站；目标站前置的
 *     EdgeOne 看到 Host 与 X-Forwarded-Host 不一致，直接返回默认错误页
 *     （"糟糕，页面好像去火星了......错误原因：页面未找到"）。表现为目标站 404，
 *     实际是代理自己造成的 —— 线上 skillhub.cn 打不开就是这个。
 *     二分验证：28 个网关头里仅 x-forwarded-host 一个就能稳定触发（1/1）。
 *  2) 更要命的是 `Authorization: Bearer <JWT>`（payload: iss=cloudstudio.net,
 *     space=<沙箱 ID>, user_id=..., exp=3 天后）也被原样转发，等于把用户的平台
 *     身份令牌交给任意第三方网站。
 *
 * 断言（三组请求分别覆盖三种来路）：
 *  A) 代理链 / 平台身份头一律不上送（x-forwarded-* / x-wb-* / x-space-* / eo-* / …）
 *  B) 平台签发的 JWT 不上送；站点自己的 Authorization 照常上送
 *  C) 业务头（x-csrf-token / x-requested-with / content-type / 自定义头）照常上送
 *     —— 收紧不能收成「什么都不转发」，否则站点登录态、CSRF 校验会一起坏掉
 *
 * 前置：夹具服务在 3500（node scripts/fixtures/fixtures-server.mjs）
 *      应用以 ALLOW_LOCALHOST=true 启动（默认 BASE=http://127.0.0.1:3214）
 * 用法：BASE=http://127.0.0.1:3214 node scripts/check-forward-headers.mjs
 */
import http from 'node:http'

const BASE = process.env.BASE || 'http://127.0.0.1:3214'
const FIXTURE = process.env.FIXTURE || 'http://127.0.0.1:3500'

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

const target = new URL(FIXTURE)
const proxyUrl = `${BASE}/__pa/${target.protocol.replace(':', '')}/${target.host}/headers`

/** 造一枚「平台签发」的 JWT：iss=cloudstudio.net、space 与 x-space-key 一致 */
const SPACE = 'efe67938712b491a90c7a70590e40e4c'
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const platformJwt = `Bearer ${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
	iss: 'cloudstudio.net',
	space: SPACE,
	user_id: 367294,
	exp: 1793711522,
})}.sig`

/** 站点自己的 JWT（iss 不是平台）—— 必须照常上送 */
const siteJwt = `Bearer ${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
	iss: 'acme.example',
	sub: 'u-42',
})}.sig`

async function call(extraHeaders) {
	// 用原生 http 而不是 fetch：Fetch 规范把 `Sec-*` 列为禁止设置的头，
	// 用 fetch 根本发不出 sec-fetch-mode，导航场景会测不到（实测踩过）。
	const u = new URL(proxyUrl)
	return await new Promise((resolve) => {
		const req = http.request(
			{ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { accept: 'application/json', ...extraHeaders } },
			(res) => {
				let text = ''
				res.setEncoding('utf8')
				res.on('data', (c) => (text += c))
				res.on('end', () => {
					if (res.statusCode !== 200) return resolve({ status: res.statusCode, body: text.slice(0, 120) })
					try {
						resolve({ status: res.statusCode, headers: JSON.parse(text).headers || {} })
					} catch {
						// 最常见原因：夹具没起（502 落地页）/ 应用没开 ALLOW_LOCALHOST（403）
						resolve({ status: res.statusCode, body: text.slice(0, 120) })
					}
				})
			}
		)
		req.on('error', (e) => resolve({ status: 0, body: String(e.message) }))
		req.setTimeout(20000, () => req.destroy(new Error('timeout')))
		req.end()
	})
}

// ---------------- 场景 1：页面自己的 XHR（sec-fetch-mode: cors），带站点令牌 ----------------
const xhr = await call({
	// 网关加的（必须被剥掉）
	'x-forwarded-host': 'web-agent-pilot.app.workbuddy.host',
	'x-forwarded-for': '203.0.113.9',
	'x-forwarded-proto': 'https',
	'x-forwarded-port': '443',
	'x-real-ip': '203.0.113.9',
	'x-client-ip': '203.0.113.9',
	'x-cluster-client-ip': '203.0.113.9',
	'x-original-forwarded-for': '203.0.113.9',
	'x-wb-share-code': 'IDPXOMY27M',
	'x-wb-base-url': 'https://web-agent-pilot.app.workbuddy.host/?sharecode=IDPXOMY27M',
	'x-space-key': SPACE,
	'eo-log-uuid': '7428284651887556393',
	'eo-connecting-ip': '43.143.132.81',
	'stgw-request-id': 'bc6a0a42290ae85b5aa2477e145689cd',
	'x-stgw-time': '1793453416.720',
	'x-client-proto': 'https',
	'x-client-proto-ver': 'HTTP/1.1',
	traceparent: '00-e5336e8d7f37216ded6ba7c94e082f87-b7fe7912aed7a8e0-01',
	'x-pa-target': 'https://evil.example/',
	'x-pa-headers': 'e30=',
	forwarded: 'for=203.0.113.9;proto=https',
	via: '1.1 cloudstudio-gateway',
	'cdn-loop': 'cloudstudio',
	// 业务自己的（必须保留）
	'sec-fetch-mode': 'cors',
	'accept-language': 'zh-CN,zh;q=0.9',
	'user-agent': 'check-forward-headers/1.0',
	authorization: 'Bearer site-token-abc',
	'x-csrf-token': 'csrf-xyz',
	'x-requested-with': 'XMLHttpRequest',
	'x-app-custom': 'keep-me',
	'content-type': 'application/json',
})

ok(xhr.status === 200, '代理路由返回 200', `status=${xhr.status}`)
if (!xhr.headers) console.log('     ↑ 上游回显不是 JSON：', xhr.body)

if (xhr.headers) {
	const h = xhr.headers
	console.log('\n===== A) 代理链 / 平台身份头必须被剥掉 =====')
	for (const name of [
		'x-forwarded-host',
		'x-forwarded-for',
		'x-forwarded-proto',
		'x-forwarded-port',
		'x-real-ip',
		'x-client-ip',
		'x-cluster-client-ip',
		'x-original-forwarded-for',
		'x-wb-share-code',
		'x-wb-base-url',
		'x-space-key',
		'eo-log-uuid',
		'eo-connecting-ip',
		'stgw-request-id',
		'x-stgw-time',
		'x-client-proto',
		'x-client-proto-ver',
		'traceparent',
		'x-pa-target',
		'x-pa-headers',
		'forwarded',
		'via',
		'cdn-loop',
	]) {
		ok(!(name in h), `${name} 未上送`, name in h ? `实际=${String(h[name]).slice(0, 40)}` : '')
	}

	console.log('\n===== B) Host 指向目标站 =====')
	ok(String(h.host || '') === target.host, `Host = ${target.host}`, `实际=${h.host || '(无)'}`)
	ok(!String(JSON.stringify(h)).includes('app.workbuddy.host'), '上游任何头里都不出现本站域名')

	console.log('\n===== C) 业务头照常上送 =====')
	for (const [name, expect] of [
		['authorization', 'Bearer site-token-abc'],
		['x-csrf-token', 'csrf-xyz'],
		['x-requested-with', 'XMLHttpRequest'],
		['x-app-custom', 'keep-me'],
		['content-type', 'application/json'],
		['accept-language', 'zh-CN,zh;q=0.9'],
		['user-agent', 'check-forward-headers/1.0'],
	]) {
		ok(String(h[name] || '') === expect, `${name} 原样上送`, `实际=${h[name] || '(缺)'}`)
	}
}

// ---------------- 场景 2：平台 JWT（XHR 路径） ----------------
console.log('\n===== D) 平台签发的 JWT 不得外泄 =====')
const withPlatform = await call({
	'x-space-key': SPACE,
	'sec-fetch-mode': 'cors',
	authorization: platformJwt,
})
ok(!('authorization' in (withPlatform.headers || {})), '平台 JWT 未上送', `实际=${(withPlatform.headers || {}).authorization || '(无)'}`)

// ---------------- 场景 3：文档导航 + 站点令牌 ----------------
// 导航请求上浏览器不会带 Authorization，带上的一定是环境注入的
const nav = await call({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', authorization: 'Bearer site-token-abc' })
ok(!('authorization' in (nav.headers || {})), '导航请求上的 Authorization 未上送', `实际=${(nav.headers || {}).authorization || '(无)'}`)

// ---------------- 场景 4：站点自己的 JWT 仍要放行 ----------------
const siteTok = await call({ 'sec-fetch-mode': 'cors', authorization: siteJwt })
ok(
	(siteTok.headers || {}).authorization === siteJwt,
	'站点自己的 JWT 照常上送（未误伤）',
	`实际=${(siteTok.headers || {}).authorization || '(缺)'}`
)

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
