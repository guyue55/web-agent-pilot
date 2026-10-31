/**
 * 会话级「当前目标站点」记忆
 *
 * 背景：目标站 JS 通过 `location.href = '/path'` 或动态 form.submit() 发出的
 * 同源绝对路径请求无法在注入层改写（window.location 不可覆写）。这类请求
 * 到达服务端时可能缺少可解析的 Referer（站点声明 no-referrer / 仅 origin，
 * 或由无 Referer 的上下文发起），兜底路由便无法从 Referer 还原目标站点，
 * 最终表现为 "404 Not Found"。
 *
 * 因此在每个**文档导航**响应后记住「该会话最近一次打开的目标 origin」，
 * 供兜底路由在 Referer 缺失时回退使用。
 *
 * 只记导航、不记子资源：一个页面的图片 / 上报 / 接口往往来自其他域名
 * （实测 skillhub 首页会把 cloudcache.tencent-cloud.com、beacon.qq.com
 * 一并拉一遍），若每张图都刷新记忆，刷新页面时兜底就会把人送到 CDN 域名上，
 * 拿到一个 XML 错误页而不是原站点。
 *
 * 同时记住访问码：还原后的站内路径（如 /skills?sortBy=score）通常不带
 * sharecode，回跳到代理路径时要补回去，否则线上网关会把整页资源全判 403。
 *
 * 仅存内存、按会话（pa_sid）隔离、带 TTL 与容量上限，重启即失效。
 */
const TTL_MS = 30 * 60 * 1000
const MAX_SESSIONS = 2000

/** sid -> { origin, href, share, ts } */
const store = new Map()

export function rememberTarget(sid, targetUrl, share) {
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
		store.set(sid, {
			origin: targetUrl.origin,
			href: targetUrl.href,
			share: share || '',
			ts: Date.now(),
		})
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
