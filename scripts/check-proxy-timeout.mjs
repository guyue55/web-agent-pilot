/**
 * 回归：目标站慢 / 连不上时的行为。
 *
 * 背景：线上（托管沙箱）实测 github 单次 25~50s 才完成，而连接超时只有 20s，
 * 导致「慢但能通」的站点被判成不可达，返回的还是一行没有样式的纯文本。
 *
 * 本脚本验证三件事：
 *  A) 正常站点不受影响（不因为调大超时而变慢/出错）
 *  B) 整体超时（PROXY_TIMEOUT_MS）到点即收场，且只发一次请求（不重试，避免双倍等待）
 *  C) 连接失败（ECONNREFUSED 等）会重试一次，最终给出可操作的 HTML 落地页
 *
 * 前置：应用需以较小超时启动，便于快速验证
 *   PORT=3214 ALLOW_LOCALHOST=true PROXY_TIMEOUT_MS=1200 PROXY_RETRY=1 CONNECT_TIMEOUT_MS=3000 \
 *     node server/index.js
 *   以及夹具服务：npm run fixtures
 *
 * 用法：BASE=http://127.0.0.1:3214 node scripts/check-proxy-timeout.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3214'
const FIX = process.env.FIXTURES || 'http://127.0.0.1:3500'
let pass = 0
let fail = 0

function ok(cond, label, extra = '') {
	if (cond) {
		pass++
		console.log(`  ✅ ${label}${extra ? `  ${extra}` : ''}`)
	} else {
		fail++
		console.log(`  ❌ ${label}${extra ? `  ${extra}` : ''}`)
	}
}

/** 把目标地址拼成本应用的代理路径：/__pa/<scheme>/<host><path> */
const proxy = (target) => {
	const u = new URL(target)
	return `${BASE}/__pa/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}`
}

async function hit(url, init) {
	const t0 = Date.now()
	const res = await fetch(url, { ...init, redirect: 'manual' })
	const text = await res.text()
	return { status: res.status, type: res.headers.get('content-type') || '', text, ms: Date.now() - t0 }
}

// ---------------------------------------------------------------- A) 正常站点
{
	console.log('\n===== A) 正常站点（不应受超时调整影响） =====')
	const r = await hit(proxy(`${FIX}/fast`))
	ok(r.status === 200, '状态 200', `(${r.ms}ms)`)
	ok(r.text.includes('fast-ok'), '内容正确注入')
	ok(r.ms < 1000, '响应很快（未被超时设置拖慢）', `${r.ms}ms`)
}

// ------------------------------------------------- B) 整体超时：只发一次请求
{
	console.log('\n===== B) 目标站迟迟不响应（整体超时） =====')
	// k 是轮次隔离用的 nonce：夹具里同一 k 的第一次请求才会慢，避免重复跑时测到「不慢」
	const k = `t${Date.now()}`
	const r = await hit(proxy(`${FIX}/slow-once?ms=4000&k=${k}`))
	ok(r.status === 502, '返回 502', `(${r.ms}ms)`)
	ok(r.type.includes('text/html'), '是 HTML 而不是纯文本', r.type)
	ok(r.text.includes('目标站点响应太慢'), '标题说明是「太慢」而非笼统失败')
	ok(r.text.includes('127.0.0.1:3500'), '点出目标站点是哪一个')
	ok(r.text.includes('location.reload()'), '提供「重试」按钮')
	ok(r.text.includes('在新标签页打开原站'), '提供「打开原站」出口')
	ok(r.ms >= 1100 && r.ms < 2600, '在超时（1.2s）附近收场，没有翻倍等待', `${r.ms}ms`)

	// 关键复检：上一步若发生了重试，夹具的计数会跳到 2；同 k 再请求一次应拿到 attempt-2
	const again = await hit(proxy(`${FIX}/slow-once?ms=4000&k=${k}`))
	ok(again.status === 200 && again.text.includes('attempt-2'), '超时只打了一次目标站（未重试）', `第二次 ${again.status} ${again.text.match(/attempt-\d/)?.[0] || ''}`)
}

// ------------------------------------------- C) 连接失败：重试一次 + 落地页
{
	console.log('\n===== C) 目标站连不上（连接层失败） =====')
	// 用空闲高端口制造 ECONNREFUSED（属于可重试错误）。
	// 注意不能用 9/25 这类端口：它们在 Fetch 规范的「禁用端口」表里，undici 直接报 bad port，根本不会发起连接。
	const r = await hit(proxy('http://127.0.0.1:45999/'))
	ok(r.status === 502, '返回 502', `(${r.ms}ms)`)
	ok(r.type.includes('text/html'), '是 HTML 落地页', r.type)
	ok(r.text.includes('无法连接到目标站点'), '标题说明是「连不上」而非「太慢」')
	ok(r.text.includes('已尝试 2 次'), '确实重试过（PROXY_RETRY=1）')
	ok(r.text.includes('每次连接上限'), '给出连接上限，便于用户判断')
	ok(r.text.includes('ECONNREFUSED'), '保留底层错误码便于排查')
	ok(r.ms >= 300, '包含重试间隔', `${r.ms}ms`)
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
