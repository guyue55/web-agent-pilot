/**
 * path-shim.js —— 在页面脚本执行前，把被代理页的 location.pathname 还原成
 * 目标站的真实路径。
 *
 * 为什么需要：
 *   代理把目标站挂在 /__pa/https/example.com/xxx 下，页面 JS 读到的
 *   location.pathname 就带着这个前缀。纯前端渲染的站点（React + wouter、
 *   Vue Router…）都拿 pathname 直接匹配路由表，前缀会让它匹配不到任何路由，
 *   于是渲染出站点自己的 "page not found" —— 其实内容已经加载成功了，只是
 *   被路由判死。实测 skillhub.cn：不还原时正文 381 字符（page not found），
 *   还原后 2792 字符（正常首页），站内 /skills 页 8265 字符。
 *
 * 做法：只改「地址里对页面可见的那部分」，不动真实请求路径。
 *   1. history.replaceState 成目标站真实路径 → 页面路由能正常匹配
 *   2. 真实资源请求仍走代理：<base href="/__pa/..."> 保证相对 URL 不变，
 *      bridge 的 rewriteUrl 保证同源绝对路径不变（实测 fetch('/api/health')
 *      仍被改写成 /__pa/https/skillhub.cn/api/health）
 *   3. 搜索串原样保留 —— bridge 要在首屏读取 sharecode（线上网关要求每个
 *      请求都带访问码），丢了它整页资源都会 403
 *   4. 把「目标站 + 完整站内地址」写进 sessionStorage 的 pa.docTarget：
 *      刷新 / location.href 跳转这类浏览器真的会发请求的场景，服务端兜底
 *      路由读不到会话记忆时靠它精确回跳（sessionStorage 按标签页隔离，
 *      多标签同时开不同站点也不会串）
 */
;(function () {
	'use strict'

	const PROXY_PREFIX = '/__pa/'

	// 只有落在代理路径里才需要还原；本站页面（宿主 UI）直接跳过
	function parseProxyPath(pathname) {
		if (!pathname || !pathname.startsWith(PROXY_PREFIX)) return null
		const rest = pathname.slice(PROXY_PREFIX.length)
		const i = rest.indexOf('/')
		const scheme = i === -1 ? rest : rest.slice(0, i)
		if (scheme !== 'http' && scheme !== 'https') return null
		const hostRest = rest.slice(scheme.length + 1)
		const j = hostRest.indexOf('/')
		const host = j === -1 ? hostRest : hostRest.slice(0, j)
		if (!host) return null
		// 没有尾路径时目标就是站点根
		const inner = j === -1 ? '/' : hostRest.slice(j)
		return { origin: `${scheme}://${host}`, inner }
	}

	const hit = parseProxyPath(window.location.pathname)
	if (!hit) return
	if (window.__PAPathShim) return
	window.__PAPathShim = true

	const proxyHref = window.location.href
	const search = window.location.search
	const hash = window.location.hash
	const targetPath = hit.inner + search + hash

	// 供 bridge / 诊断读取：页面被还原成了哪个站点、哪个路径
	window.__PA_PATH__ = {
		proxyHref,
		targetOrigin: hit.origin,
		innerPath: hit.inner,
		search,
		hash,
	}

	// 标签页级的「这一帧到底在看哪个站」记录，兜底回跳页只认这个
	try {
		sessionStorage.setItem('pa.docTarget', hit.origin + search)
		// 成功进入一个正常文档，说明之前那轮回跳已经结束
		sessionStorage.removeItem('pa.hop')
	} catch {
		/* 隐私模式 / 存储被禁用：只是少一层兜底，不影响主流程 */
	}

	try {
		// 保留 history.state：wouter / react-router 把滚动位置等状态存在这里，
		// 换成 null 会让它们在回退时读到空状态
		window.history.replaceState(window.history.state, '', targetPath)
	} catch {
		// 极少数环境禁止改地址（如沙箱 iframe）：保持前缀原样，
		// 页面退化为「路由 404」的旧行为，不会比现在更差
	}
})()
