/**
 * 主应用逻辑
 *  - 地址栏 / iframe 导航
 *  - 大模型配置面板（localStorage 持久化）
 *  - 与注入到 iframe 内的 bridge.js 通信
 *
 * 聊天 UI 由 page-agent 自带的 Panel 承载（直接渲染在 iframe 内的目标页上），
 * 这里只负责：地址栏、设置、顶部状态，以及在页面就绪后把配置下发到 bridge。
 */
import { testConnection } from './llm-adapter.js'

const STORAGE_KEY = 'pa.agent.settings.v1'
const PROXY_PREFIX = '/__pa/'
const SHARE_PARAM = 'sharecode'

/**
 * 某些部署网关要求每个请求都带访问码（sharecode）。
 * 首次打开带 code 的链接后网关会下发 Cookie，后续同源请求会自动带上；
 * 这里再显式透传一次，双保险，避免 iframe / fetch 被网关 403。
 */
const SHARE_VALUE = new URLSearchParams(location.search).get(SHARE_PARAM) || ''

export function withShare(url) {
	if (!SHARE_VALUE || !url) return url
	const hashIdx = url.indexOf('#')
	const head = hashIdx === -1 ? url : url.slice(0, hashIdx)
	const hash = hashIdx === -1 ? '' : url.slice(hashIdx)
	const qIdx = head.indexOf('?')
	// 幂等：服务端重写时可能已经带上了访问码
	if (qIdx !== -1 && new URLSearchParams(head.slice(qIdx + 1)).has(SHARE_PARAM)) return url
	const sep = qIdx === -1 ? '?' : '&'
	return `${head}${sep}${SHARE_PARAM}=${encodeURIComponent(SHARE_VALUE)}${hash}`
}

/** base64url：把目标地址编码后再放进 query，规避 WAF 的 URL 跳转规则 */
function b64urlEncode(str) {
	const bytes = new TextEncoder().encode(str)
	let bin = ''
	for (const b of bytes) bin += String.fromCharCode(b)
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const $ = (sel) => document.querySelector(sel)
const els = {
	navForm: $('#nav-form'),
	urlInput: $('#url-input'),
	frame: $('#page-frame'),
	homeGuide: $('#home-guide'),
	loadingBar: $('#loading-bar'),
	btnBack: $('#btn-back'),
	btnForward: $('#btn-forward'),
	btnReload: $('#btn-reload'),
	btnNewTab: $('#btn-newtab'),
	statusBadge: $('#status-badge'),
	agentStatus: $('#agent-status'),
	btnPanel: $('#btn-panel'),
	blockedNotice: $('#blocked-notice'),
	blockedDesc: $('#blocked-desc'),
	blockedOpen: $('#blocked-open'),
	blockedRetry: $('#blocked-retry'),
	settingsMask: $('#settings-mask'),
	toast: $('#toast'),
}

const state = {
	targetUrl: '',
	settings: null,
	bridgeReady: false,
	loadTimer: null,
}

// ------------------------------------------------------------------ 设置
const PRESETS = {
	zenmux: {
		label: 'ZenMux',
		config: {
			'openai-chat': { baseURL: 'https://zenmux.ai/api/v1', model: 'deepseek/deepseek-v4-flash' },
			'openai-responses': { baseURL: 'https://zenmux.ai/api/v1', model: 'deepseek/deepseek-v4-flash' },
			anthropic: { baseURL: 'https://zenmux.ai/api/anthropic/v1', model: 'deepseek/deepseek-v4-flash' },
		},
	},
	openai: {
		label: 'OpenAI',
		config: {
			'openai-chat': { baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
			'openai-responses': { baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
			anthropic: { baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
		},
	},
	anthropic: {
		label: 'Anthropic',
		config: {
			'openai-chat': { baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
			'openai-responses': { baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
			anthropic: { baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
		},
	},
	deepseek: {
		label: 'DeepSeek 官方',
		config: {
			'openai-chat': { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
			'openai-responses': { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
			anthropic: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
		},
	},
	siliconflow: {
		label: '硅基流动',
		config: {
			'openai-chat': { baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
			'openai-responses': { baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
			anthropic: { baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
		},
	},
}

const QUICK_MODELS = {
	'openai-chat': ['deepseek/deepseek-v4-flash', 'gpt-5-mini', 'deepseek-chat', 'qwen3-max'],
	'openai-responses': ['deepseek/deepseek-v4-flash', 'gpt-5-mini', 'o4-mini'],
	anthropic: ['deepseek/deepseek-v4-flash', 'claude-sonnet-4-5', 'claude-3-5-sonnet-latest'],
}

function defaultSettings() {
	// 默认走 DeepSeek 官方：服务端代理可达（部署机实测 401/1.1s），且浏览器直连时
	// 其 CORS 返回本站点 origin，故「自动」模式下两条通道都可用、最稳。
	// 注意：DeepSeek 需要自备 API Key（密钥仅存浏览器本地）。
	return {
		protocol: 'openai-chat',
		baseURL: PRESETS.deepseek.config['openai-chat'].baseURL,
		model: PRESETS.deepseek.config['openai-chat'].model,
		apiKey: '',
		route: 'auto',
		maxSteps: 40,
		stepDelay: 0.4,
		maxTokens: 8192,
		language: 'zh-CN',
		scriptTool: true,
		fastMode: true,
		extraHeaders: {},
	}
}

function loadSettings() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) return defaultSettings()
		return { ...defaultSettings(), ...JSON.parse(raw) }
	} catch {
		return defaultSettings()
	}
}

function saveSettings(next) {
	state.settings = next
	localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
	updateStatusBadge()
	configureBridge()
}

function updateStatusBadge() {
	const s = state.settings
	if (!s?.apiKey || !s.model || !s.baseURL) {
		els.statusBadge.textContent = '模型未配置'
		els.statusBadge.className = 'badge warn'
		return
	}
	const names = { 'openai-chat': 'OpenAI Chat', 'openai-responses': 'OpenAI Responses', anthropic: 'Anthropic' }
	els.statusBadge.textContent = `${names[s.protocol] || s.protocol} · ${s.model}`
	els.statusBadge.className = 'badge ok'
	els.statusBadge.title = `${s.baseURL}`
}

function setAgentStatus(text, kind = '') {
	if (!els.agentStatus) return
	els.agentStatus.textContent = text || ''
	els.agentStatus.className = `agent-status${kind ? ` ${kind}` : ''}`
}

// ------------------------------------------------------------------ toast
let toastTimer = null
function toast(message, duration = 2600) {
	els.toast.textContent = message
	els.toast.hidden = false
	clearTimeout(toastTimer)
	toastTimer = setTimeout(() => {
		els.toast.hidden = true
	}, duration)
}

// ------------------------------------------------------------------ 工具
function decodeProxyPath(pathAndQuery) {
	if (!pathAndQuery.startsWith(PROXY_PREFIX)) return null
	const rest = pathAndQuery.slice(PROXY_PREFIX.length)
	const i = rest.indexOf('/')
	const scheme = i === -1 ? rest : rest.slice(0, i)
	if (scheme !== 'http' && scheme !== 'https') return null
	const hostRest = rest.slice(scheme.length + 1)
	const j = hostRest.indexOf('/')
	const host = j === -1 ? hostRest : hostRest.slice(0, j)
	const path = j === -1 ? '/' : hostRest.slice(j)
	return `${scheme}://${host}${path}`
}

// ------------------------------------------------------------------ 网页加载
async function resolveAndOpen(rawUrl) {
	const input = String(rawUrl || '').trim()
	if (!input) return
	els.loadingBar.classList.add('on')
	setAgentStatus('解析地址中…')
	try {
		const res = await fetch(withShare(`/api/resolve?u=${encodeURIComponent(b64urlEncode(input))}`))
		const data = await res.json()
		if (!res.ok) throw new Error(data.error || '无法解析该地址')
		state.targetUrl = data.target
		state.bridgeReady = false
		els.homeGuide.hidden = true
		els.blockedNotice.hidden = true
		els.frame.src = withShare(data.proxyUrl) || data.proxyUrl
		els.urlInput.value = data.target
		els.btnNewTab.href = data.target
		els.btnNewTab.removeAttribute('aria-disabled')
		setAgentStatus('页面加载中…')
	} catch (err) {
		els.loadingBar.classList.remove('on')
		setAgentStatus('')
		toast(err.message)
	}
}

els.navForm.addEventListener('submit', (e) => {
	e.preventDefault()
	resolveAndOpen(els.urlInput.value)
})

// ------------------------------------------------------------------ 导航死循环
// bridge 检测到「同一地址短时间内被反复加载」会发 nav-loop，这里主动断开 iframe 并说明原因。
// 计数存在 sessionStorage 的 pa.navLoop 键上，与 iframe 同源共享，可直接清掉。
const NAV_LOOP_KEY = 'pa.navLoop'

function showBlockedNotice(data) {
	try {
		// 站点还在不停自我跳转，不断开 iframe 就永远停不下来
		els.frame.src = 'about:blank'
	} catch {
		/* noop */
	}
	els.loadingBar.classList.remove('on')
	const times = Number(data?.count) || 0
	els.blockedDesc.textContent = times
		? `它在打开后反复自我重定向（已连续 ${times} 次），页面无法稳定停留，AI 也就无法接管。`
		: '它在打开后反复自我重定向，页面无法稳定停留，AI 也就无法接管。'
	els.blockedOpen.href = state.targetUrl || '#'
	els.blockedNotice.hidden = false
	setAgentStatus('目标站反复重定向，已暂停', 'err')
}

els.blockedRetry.addEventListener('click', () => {
	try {
		sessionStorage.removeItem(NAV_LOOP_KEY)
	} catch {
		/* noop */
	}
	els.blockedNotice.hidden = true
	if (state.targetUrl) resolveAndOpen(state.targetUrl)
})

els.frame.addEventListener('load', () => {
	els.loadingBar.classList.remove('on')
	const pathPlus = safeFramePath()
	if (!pathPlus) {
		setAgentStatus('')
		return
	}
	const real = decodeProxyPath(pathPlus)
	if (real) {
		state.targetUrl = real
		els.urlInput.value = real
		els.btnNewTab.href = real
	}
	// 给 bridge 充足的启动时间；若超时仍未就绪再提示
	clearTimeout(state.loadTimer)
	state.loadTimer = setTimeout(() => {
		if (!state.bridgeReady && els.frame.src && String(els.frame.src) !== location.href) {
			setAgentStatus('当前页面未注入 Agent（非 HTML 内容或站点拦截）', 'warn')
		}
	}, 4000)
})

function safeFramePath() {
	try {
		const p = els.frame.contentWindow?.location?.pathname
		const q = els.frame.contentWindow?.location?.search
		if (!p) return null
		return `${p}${q || ''}`
	} catch {
		return null
	}
}

els.btnBack.addEventListener('click', () => {
	try {
		els.frame.contentWindow?.history.back()
	} catch {
		toast('无法后退')
	}
})
els.btnForward.addEventListener('click', () => {
	try {
		els.frame.contentWindow?.history.forward()
	} catch {
		toast('无法前进')
	}
})
els.btnReload.addEventListener('click', () => {
	try {
		els.frame.contentWindow?.location.reload()
	} catch {
		toast('无法刷新')
	}
})

document.querySelectorAll('.chip').forEach((chip) => {
	chip.addEventListener('click', () => {
		resolveAndOpen(chip.dataset.url)
	})
})

// 用户在 Panel 上点 X 会连 Agent 一起销毁，且 Panel 随之消失。
// 演示站可以靠书签重新注入，这里用顶栏按钮把面板叫回来
els.btnPanel.addEventListener('click', () => {
	if (!postToBridge({ type: 'show-panel' })) {
		toast('请先打开一个网页，再显示 AI 面板')
	}
})

// ------------------------------------------------------------------ 设置面板入口
$('#btn-settings-top').addEventListener('click', openSettings)
$('#btn-settings-close').addEventListener('click', closeSettings)
$('#btn-cancel').addEventListener('click', closeSettings)
els.settingsMask.addEventListener('click', (e) => {
	if (e.target === els.settingsMask) closeSettings()
})

// ------------------------------------------------------------------ bridge 通信
function postToBridge(message, needReady = true) {
	const win = els.frame.contentWindow
	if (!win) return false
	if (needReady && !state.bridgeReady) return false
	win.postMessage({ source: 'pa-host', ...message }, window.location.origin)
	return true
}

function configureBridge() {
	if (!state.bridgeReady) return
	postToBridge({ type: 'configure', payload: state.settings })
}

window.addEventListener('message', (event) => {
	if (event.origin !== window.location.origin) return
	const data = event.data
	if (!data || data.source !== 'pa-bridge') return

	switch (data.type) {
		case 'ready': {
			state.bridgeReady = true
			clearTimeout(state.loadTimer)
			const real = data.url ? decodeProxyPath(data.url) : null
			if (real) {
				state.targetUrl = real
				els.urlInput.value = real
				els.btnNewTab.href = real
			}
			configureBridge()
			setAgentStatus(state.settings?.apiKey ? 'Agent 已就绪' : '请先配置大模型')
			els.loadingBar.classList.remove('on')
			break
		}
		case 'configured':
			setAgentStatus('Agent 已就绪')
			break
		case 'resume':
			// 页面跳转打断了任务，新页面已自动接着跑
			setAgentStatus(
				`页面已跳转，继续执行任务${data.attempt > 1 ? `（第 ${data.attempt} 次续跑）` : ''}…`,
				'busy'
			)
			break
		case 'status': {
			const s = data.status
			if (s === 'running') setAgentStatus('执行中…', 'busy')
			else if (s === 'completed') setAgentStatus('任务完成', 'ok')
			else if (s === 'error') setAgentStatus('执行出错', 'err')
			else if (s === 'stopped') setAgentStatus('已停止', '')
			else setAgentStatus('空闲')
			break
		}
		case 'activity': {
			const d = data.detail || {}
			if (d.type === 'thinking') setAgentStatus('思考中…', 'busy')
			else if (d.type === 'executing') setAgentStatus('操作中…', 'busy')
			else if (d.type === 'retrying') setAgentStatus('重试中…', 'busy')
			break
		}
		case 'config-error':
			toast(`模型配置无效：${data.message || '请检查 API Key / Base URL'}`)
			setAgentStatus('模型配置无效', 'err')
			break
		case 'error':
			setAgentStatus('出错', 'err')
			toast(data.message || '未知错误')
			break
		case 'panel-state': {
			const visible = !!data.visible
			els.btnPanel.classList.toggle('active', visible)
			els.btnPanel.title = visible
				? 'AI 面板已显示'
				: 'AI 面板已关闭，点击重新显示'
			if (!visible) setAgentStatus('AI 面板已关闭，点右上角按钮可重新显示', '')
			break
		}
		case 'pagehide':
			state.bridgeReady = false
			break
		case 'nav-loop': {
			// 目标站在反复自我重定向（实测知乎：5 秒内 20 次），继续跑只会空烧调用额度
			state.bridgeReady = false
			showBlockedNotice(data)
			break
		}
		default:
			break
	}
})

// ------------------------------------------------------------------ 设置面板
let extraHeaderRows = 0

function openSettings() {
	fillSettingsForm(loadSettings())
	els.settingsMask.hidden = false
}

function closeSettings() {
	els.settingsMask.hidden = true
}

function fillSettingsForm(s) {
	setActiveSeg('#protocol-seg', 'protocol', s.protocol)
	setActiveSeg('#route-seg', 'route', s.route)
	$('#cfg-baseurl').value = s.baseURL
	$('#cfg-model').value = s.model
	$('#cfg-apikey').value = s.apiKey
	$('#cfg-maxsteps').value = s.maxSteps
	$('#cfg-stepdelay').value = s.stepDelay
	$('#cfg-maxtokens').value = s.maxTokens
	$('#cfg-scripttool').checked = s.scriptTool !== false
	$('#cfg-fastmode').checked = s.fastMode !== false
	renderExtraHeaders(s.extraHeaders || {})
	renderQuickModels(s.protocol)
	$('#test-result').textContent = ''
	$('#test-result').className = 'test-result'
	updateBaseHint()
}

function setActiveSeg(selector, key, value) {
	document.querySelectorAll(`${selector} button`).forEach((btn) => {
		btn.classList.toggle('active', btn.dataset[key] === value)
	})
}

function renderQuickModels(protocol) {
	const box = $('#quick-models')
	box.innerHTML = ''
	for (const m of QUICK_MODELS[protocol] || []) {
		const btn = document.createElement('button')
		btn.className = 'chip'
		btn.textContent = m
		btn.addEventListener('click', () => {
			$('#cfg-model').value = m
		})
		box.appendChild(btn)
	}
}

function renderExtraHeaders(headers) {
	const box = $('#extra-headers')
	box.innerHTML = ''
	extraHeaderRows = 0
	for (const [k, v] of Object.entries(headers)) {
		addHeaderRow(k, v)
	}
}

function addHeaderRow(key = '', value = '') {
	const box = $('#extra-headers')
	const row = document.createElement('div')
	row.className = 'header-row'
	const keyInput = document.createElement('input')
	keyInput.placeholder = 'Header 名'
	keyInput.value = key
	const valInput = document.createElement('input')
	valInput.placeholder = 'Header 值'
	valInput.value = value
	const del = document.createElement('button')
	del.className = 'ghost-btn sm'
	del.textContent = '删除'
	del.type = 'button'
	del.addEventListener('click', () => row.remove())
	row.append(keyInput, valInput, del)
	box.appendChild(row)
	extraHeaderRows++
}

$('#btn-add-header').addEventListener('click', () => addHeaderRow())

function collectForm() {
	const extraHeaders = {}
	document.querySelectorAll('#extra-headers .header-row').forEach((row) => {
		const [k, v] = row.querySelectorAll('input')
		if (k.value.trim()) extraHeaders[k.value.trim()] = v.value
	})
	return {
		protocol: document.querySelector('#protocol-seg button.active')?.dataset.protocol || 'openai-chat',
		route: document.querySelector('#route-seg button.active')?.dataset.route || 'auto',
		baseURL: $('#cfg-baseurl').value.trim(),
		model: $('#cfg-model').value.trim(),
		apiKey: $('#cfg-apikey').value.trim(),
		maxSteps: Number($('#cfg-maxsteps').value) || 40,
		stepDelay: Number($('#cfg-stepdelay').value) ?? 0.4,
		maxTokens: Number($('#cfg-maxtokens').value) || 8192,
		language: 'zh-CN',
		scriptTool: $('#cfg-scripttool').checked,
		fastMode: $('#cfg-fastmode').checked,
		extraHeaders,
	}
}

$('#btn-save').addEventListener('click', () => {
	const s = collectForm()
	if (!s.baseURL || !s.model || !s.apiKey) {
		toast('Base URL / 模型 / API Key 都需要填写')
		return
	}
	saveSettings(s)
	closeSettings()
	toast('配置已保存到本地浏览器')
})

document.querySelectorAll('#protocol-seg button').forEach((btn) => {
	btn.addEventListener('click', () => {
		setActiveSeg('#protocol-seg', 'protocol', btn.dataset.protocol)
		renderQuickModels(btn.dataset.protocol)
		updateBaseHint()
	})
})
document.querySelectorAll('#route-seg button').forEach((btn) => {
	btn.addEventListener('click', () => setActiveSeg('#route-seg', 'route', btn.dataset.route))
})

document.querySelectorAll('[data-preset]').forEach((btn) => {
	btn.addEventListener('click', () => {
		const preset = PRESETS[btn.dataset.preset]
		if (!preset) return
		const protocol = document.querySelector('#protocol-seg button.active')?.dataset.protocol || 'openai-chat'
		const conf = preset.config[protocol]
		$('#cfg-baseurl').value = conf.baseURL
		$('#cfg-model').value = conf.model
		updateBaseHint()
		toast(`已填充 ${preset.label} 的 ${protocol} 配置`)
	})
})

function updateBaseHint() {
	const protocol = document.querySelector('#protocol-seg button.active')?.dataset.protocol
	const hints = {
		'openai-chat': '例如 https://zenmux.ai/api/v1、https://api.openai.com/v1（不含 /chat/completions）',
		'openai-responses': '例如 https://zenmux.ai/api/v1、https://api.openai.com/v1（不含 /responses）',
		anthropic: '例如 https://api.anthropic.com/v1、https://zenmux.ai/api/anthropic/v1（不含 /messages）',
	}
	$('#baseurl-hint').textContent = hints[protocol] || ''
}

$('#btn-test').addEventListener('click', async () => {
	const cfg = collectForm()
	const resultEl = $('#test-result')
	if (!cfg.baseURL || !cfg.model) {
		resultEl.textContent = '请先填写 Base URL 和模型'
		resultEl.className = 'test-result err'
		return
	}
	resultEl.textContent = '正在测试…'
	resultEl.className = 'test-result'
	const res = await testConnection(cfg)
	resultEl.textContent = `${res.ok ? '✅' : '❌'} ${res.message}${res.elapsed ? `（${res.elapsed}ms）` : ''}`
	resultEl.className = `test-result ${res.ok ? (res.warning ? 'warn' : 'ok') : 'err'}`
})

// ------------------------------------------------------------------ 启动
state.settings = loadSettings()
updateStatusBadge()
setAgentStatus(state.settings.apiKey ? '等待打开网页' : '请先配置大模型')

// 支持 /#url=... 直接打开
const hash = location.hash.replace(/^#/, '')
if (hash) {
	const params = new URLSearchParams(hash)
	const target = params.get('url')
	if (target) setTimeout(() => resolveAndOpen(target), 60)
}
