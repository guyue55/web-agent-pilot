/**
 * URL 编解码 & 内容重写
 *
 * 代理路由格式：  /__pa/<scheme>/<host>/<path...>?<query>
 *   例： https://example.com/a/b?x=1  ->  /__pa/https/example.com/a/b?x=1
 *
 * 部署在某些带访问码校验的网关后面时，网关要求「每个请求」都带上访问码，
 * 而页面内部的 iframe / XHR / 静态资源不会自动携带，因此这里统一负责
 * 「重写时附加、转发给目标站前剔除」该参数。
 */
export const PROXY_PREFIX = '/__pa/'
export const SHARE_PARAM = 'sharecode'

/** 给 URL 追加查询参数（自动判断 ? 与 &） */
export function appendQuery(url, params) {
	const entries = Object.entries(params || {}).filter(
		([, v]) => v !== undefined && v !== null && v !== ''
	)
	if (!entries.length) return url
	const qs = entries
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
		.join('&')
	if (!url) return `?${qs}`
	const hashIdx = url.indexOf('#')
	if (hashIdx === -1) {
		return `${url}${url.includes('?') ? '&' : '?'}${qs}`
	}
	return `${url.slice(0, hashIdx)}${url.slice(0, hashIdx).includes('?') ? '&' : '?'}${qs}${url.slice(hashIdx)}`
}

/** 剔除网关访问码：转发给目标站点前必须调用，避免污染目标站 query */
export function stripShare(urlOrPath) {
	const raw = String(urlOrPath ?? '')
	const hashIdx = raw.indexOf('#')
	const hash = hashIdx === -1 ? '' : raw.slice(hashIdx)
	const body = hashIdx === -1 ? raw : raw.slice(0, hashIdx)
	const qIdx = body.indexOf('?')
	if (qIdx === -1) return raw
	const params = new URLSearchParams(body.slice(qIdx + 1))
	if (!params.has(SHARE_PARAM)) return raw
	params.delete(SHARE_PARAM)
	const qs = params.toString()
	return `${body.slice(0, qIdx)}${qs ? `?${qs}` : ''}${hash}`
}

const SKIP_PROTOCOLS = [
	'#',
	'javascript:',
	'mailto:',
	'tel:',
	'sms:',
	'data:',
	'blob:',
	'about:',
	'chrome:',
	'edge:',
	'file:',
	'ftp:',
	'ws:',
	'wss:',
	'view-source:',
]

export function encodeProxyUrl(target, share) {
	const t = target instanceof URL ? target : new URL(target)
	const path = `${PROXY_PREFIX}${t.protocol.replace(':', '')}/${t.host}${t.pathname}${t.search}`
	return share ? appendQuery(path, { [SHARE_PARAM]: share }) : path
}

/**
 * 从 /__pa/... 请求路径还原真实 URL（顺带剔除网关访问码）
 * @param {string} rawPathWithQuery 形如 /__pa/https/example.com/a/b?x=1&sharecode=XXX
 * @returns {URL|null}
 */
export function decodeProxyUrl(rawPathWithQuery) {
	let raw = rawPathWithQuery
	if (!raw.startsWith(PROXY_PREFIX)) return null
	raw = raw.slice(PROXY_PREFIX.length)

	const firstSlash = raw.indexOf('/')
	const scheme = firstSlash === -1 ? raw : raw.slice(0, firstSlash)
	if (scheme !== 'http' && scheme !== 'https') return null
	const rest = raw.slice(scheme.length + 1)
	if (!rest) return null

	const secondSlash = rest.indexOf('/')
	const host = secondSlash === -1 ? rest : rest.slice(0, secondSlash)
	const pathAndQuery = secondSlash === -1 ? '/' : rest.slice(secondSlash)
	if (!host) return null

	try {
		const u = new URL(`${scheme}://${host}${pathAndQuery}`)
		// 仅在确实存在时剔除，避免无谓的 query 重新编码
		if (u.searchParams.has(SHARE_PARAM)) u.searchParams.delete(SHARE_PARAM)
		return u
	} catch {
		return null
	}
}

/** 相对 / 绝对 URL -> 代理 URL */
export function toProxyUrl(value, base, share) {
	const v = value.trim()
	if (!v) return v
	const lower = v.toLowerCase()
	for (const p of SKIP_PROTOCOLS) {
		if (lower.startsWith(p)) return v
	}
	try {
		const abs = new URL(v, base)
		if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return v
		return encodeProxyUrl(abs, share)
	} catch {
		return v
	}
}

const URL_ATTRS = [
	'href',
	'src',
	'action',
	'formaction',
	'poster',
	'data',
	'background',
	'longdesc',
	'usemap',
	'cite',
	'manifest',
]

// 支持 双引号 / 单引号 / 无引号 三种 HTML 写法
// 捕获组：1=前导空白 2=属性名 3=等号 4=双引号值 5=单引号值 6=无引号值
const URL_ATTR_RE = new RegExp(
	`(\\s)(${URL_ATTRS.join('|')})(=)(?:"([^"]*)"|'([^']*)'|([^\\s"'\`=<>]+))`,
	'gi'
)
const SRCSET_RE = /(\ssrcset=)(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi
const STYLE_ATTR_RE = /(\sstyle=)(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi
/** 目标框架统一收回到当前 iframe，避免 popup / 跳出等问题 */
const TARGET_ATTR_RE = /(\starget=)("_blank"|'_blank'|_blank|"_parent"|'_parent'|_parent|"_top"|'_top'|_top)/gi
const STYLE_BLOCK_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi
const META_REFRESH_RE = /(<meta\b[^>]*\bhttp-equiv=("refresh"|'refresh'|\brefresh\b)[^>]*>)/gi
// 站点通过 <meta http-equiv="Content-Security-Policy"> 声明的 CSP 会拦截
// page-agent 面板的行内 <style>，代理层只剥离了响应头 CSP，这里补剥离 meta CSP。
const META_TAG_RE = /<meta\b[^>]*>/gi
const META_CSP_ATTR_RE = /\bhttp-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const CONTENT_ATTR_RE = /(\scontent=)("([^"]*)"|'([^']*)')/i
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi
const IMPORT_RE = /(@import\s+)(['"])([^'"]+)\2/gi

function rewriteCssUrls(css, base, share) {
	return css
		.replace(CSS_URL_RE, (match, quote, url) => {
			const trimmed = url.trim()
			if (!trimmed || trimmed.startsWith('data:')) return match
			return `url(${quote || '"'}${toProxyUrl(trimmed, base, share)}${quote || '"'})`
		})
		.replace(
			IMPORT_RE,
			(match, prefix, quote, url) => `${prefix}${quote}${toProxyUrl(url.trim(), base, share)}${quote}`
		)
}

function rewriteSrcset(value, base, share) {
	return value
		.split(',')
		.map((part) => {
			const trimmed = part.trim()
			if (!trimmed) return part
			const m = /^(\S+)(\s+[\d.]+[xw])?$/.exec(trimmed)
			if (!m) return part
			const url = toProxyUrl(m[1], base, share)
			return m[2] ? `${url}${m[2]}` : url
		})
		.join(', ')
}

/**
 * 重写 HTML：所有资源 / 链接走代理，注入 base 与 bridge 脚本
 * @param {string} html
 * @param {URL} base 当前页面真实 URL
 * @param {string} bridgeScript bridge 脚本 URL
 * @param {string} share 网关访问码（需要时自动附加到所有重写后的链接）
 */
export function rewriteHtml(html, base, bridgeScript = '/_app/bridge.js', share = '') {
	let out = html.replace(URL_ATTR_RE, (match, space, name, eq, dq, sq, bare) => {
		const quoted = dq !== undefined || sq !== undefined
		const value = dq !== undefined ? dq : sq !== undefined ? sq : bare
		const quote = quoted ? (dq !== undefined ? '"' : "'") : ''
		// 幂等：已代理不再处理
		if (value.startsWith(PROXY_PREFIX)) return match
		return `${space}${name}${eq}${quote}${toProxyUrl(value, base, share)}${quote}`
	})

	out = out.replace(SRCSET_RE, (match, prefix, dq, sq, bare) => {
		const quoted = dq !== undefined || sq !== undefined
		const value = dq !== undefined ? dq : sq !== undefined ? sq : bare
		const quote = quoted ? (dq !== undefined ? '"' : "'") : ''
		return `${prefix}${quote}${rewriteSrcset(value, base, share)}${quote}`
	})

	out = out.replace(STYLE_ATTR_RE, (match, prefix, dq, sq, bare) => {
		const quoted = dq !== undefined || sq !== undefined
		const value = dq !== undefined ? dq : sq !== undefined ? sq : bare
		const quote = quoted ? (dq !== undefined ? '"' : "'") : ''
		return `${prefix}${quote}${rewriteCssUrls(value, base, share)}${quote}`
	})

	out = out.replace(TARGET_ATTR_RE, (_match, prefix) => `${prefix}"_self"`)

	out = out.replace(STYLE_BLOCK_RE, (match, open, body, close) => {
		return `${open}${rewriteCssUrls(body, base, share)}${close}`
	})

	// <meta http-equiv="refresh" content="0;url=...">
	out = out.replace(META_REFRESH_RE, (match, tag) => {
		return tag.replace(CONTENT_ATTR_RE, (m, prefix, _full, dq, sq) => {
			const value = dq !== undefined ? dq : sq
			const quote = dq !== undefined ? '"' : "'"
			const urlMatch = /(url\s*=\s*)([^;]+)/i.exec(value)
			if (!urlMatch) return m
			const newUrl = toProxyUrl(urlMatch[2].trim(), base, share)
			return `${prefix}${quote}${value.replace(urlMatch[0], `${urlMatch[1]}${newUrl}`)}${quote}`
		})
	})

	// 剥离 meta CSP，确保 page-agent 面板的行内样式可在目标页注入
	out = out.replace(META_TAG_RE, (tag) => {
		const he = META_CSP_ATTR_RE.exec(tag)
		if (!he) return tag
		const val = (he[1] || he[2] || he[3] || '').toLowerCase()
		if (val.includes('content-security-policy')) return ''
		return tag
	})

	// <base href> 指向代理路径，未改写的相对 URL 也由浏览器自动解析到代理
	// storage shim 必须排在所有页面脚本之前：代理页共用同一个源，
	// 不先接管 localStorage / sessionStorage，不同站点的数据就会互相串味。
	const storageShim = appendQuery('/_app/storage-shim.js', {
		[SHARE_PARAM]: share,
	})
	// 目标站 origin 走 data 属性而不是 ?o=：线上网关会把「查询串里带 URL」的请求
	// 直接 403（实测 /_app/bridge.js?o=https%3A%2F%2F... 与 /app.js?u=https%3A%2F%2F...
	// 都被拦），那样 shim 脚本根本加载不到，跨站隔离会静默失效。
	const injection =
		`<script src="${escapeHtmlAttr(storageShim)}" data-pa-o="${escapeHtmlAttr(base.origin)}"></script>` +
		`<base href="${escapeHtmlAttr(encodeProxyUrl(base))}">` +
		`<script src="${escapeHtmlAttr(appendQuery(bridgeScript, { [SHARE_PARAM]: share }))}"></script>`

	const headMatch = /<head\b[^>]*>/i.exec(out)
	if (headMatch) {
		const idx = headMatch.index + headMatch[0].length
		return out.slice(0, idx) + injection + out.slice(idx)
	}
	const htmlMatch = /<html\b[^>]*>/i.exec(out)
	if (htmlMatch) {
		const idx = htmlMatch.index + htmlMatch[0].length
		return out.slice(0, idx) + `<head>${injection}</head>` + out.slice(idx)
	}
	return injection + out
}

export function rewriteCss(css, base, share) {
	return rewriteCssUrls(css, base, share)
}

function escapeHtmlAttr(str) {
	return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
