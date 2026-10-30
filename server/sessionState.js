/**
 * 会话级「当前目标站点」记忆
 *
 * 背景：目标站 JS 通过 `location.href = '/path'` 或动态 form.submit() 发出的
 * 同源绝对路径请求无法在注入层改写（window.location 不可覆写）。这类请求
 * 到达服务端时可能缺少可解析的 Referer（站点声明 no-referrer / 仅 origin，
 * 或由无 Referer 的上下文发起），兜底路由便无法从 Referer 还原目标站点，
 * 最终表现为 "404 Not Found"。
 *
 * 因此在每个代理响应后记住「该会话最近一次代理的目标 origin」，供兜底路由
 * 在 Referer 缺失时回退使用，让这类漏网请求仍回流到目标站点。
 *
 * 仅存内存、按会话（pa_sid）隔离、带 TTL 与容量上限，重启即失效。
 */
const TTL_MS = 30 * 60 * 1000
const MAX_SESSIONS = 2000

/** sid -> { origin, href, ts } */
const store = new Map()

export function rememberTarget(sid, targetUrl) {
	if (!sid || !targetUrl) return
	try {
		if (store.size >= MAX_SESSIONS) {
			const cutoff = Date.now() - TTL_MS
			for (const [k, v] of store) {
				if (v.ts < cutoff) store.delete(k)
			}
			// 仍超限时淘汰最早写入的一条，保证内存有界
			if (store.size >= MAX_SESSIONS) {
				const oldest = store.keys().next().value
				if (oldest !== undefined) store.delete(oldest)
			}
		}
		store.set(sid, { origin: targetUrl.origin, href: targetUrl.href, ts: Date.now() })
	} catch {
		/* 忽略非 URL 输入 */
	}
}

export function getRememberedTarget(sid) {
	if (!sid) return null
	const hit = store.get(sid)
	if (!hit) return null
	if (Date.now() - hit.ts > TTL_MS) {
		store.delete(sid)
		return null
	}
	hit.ts = Date.now()
	return hit
}
