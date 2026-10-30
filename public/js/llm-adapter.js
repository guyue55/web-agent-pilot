/**
 * LLM 协议适配层
 *
 * page-agent 内部只认 OpenAI Chat Completions 协议。
 * 这里通过它的 customFetch 钩子做「协议翻译」，从而支持：
 *
 *   1. openai-chat      OpenAI /v1/chat/completions（含所有兼容厂商）
 *   2. openai-responses OpenAI Responses API (/v1/responses)
 *   3. anthropic        Anthropic Messages API (/v1/messages)
 *
 * 所有请求可走「直连」或「服务端代理」两种通道：
 *   route='direct' 浏览器直接请求模型服务（受 CORS 限制）
 *   route='proxy'  经本站 /api/llm/proxy 转发（无 CORS 问题，推荐）
 */

const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic']

export const DEFAULT_PRESETS = {
	'openai-chat': { baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
	'openai-responses': { baseURL: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
	anthropic: { baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
}

function stripTrailing(url = '') {
	return String(url).replace(/\/+$/, '')
}

function endpointFor(cfg) {
	const base = stripTrailing(cfg.baseURL)
	const protocol = PROTOCOLS.includes(cfg.protocol) ? cfg.protocol : 'openai-chat'
	if (protocol === 'openai-responses') return `${base}/responses`
	if (protocol === 'anthropic') return `${base}/messages`
	return `${base}/chat/completions`
}

function authHeaders(cfg) {
	const protocol = cfg.protocol
	const headers = { 'content-type': 'application/json' }
	if (protocol === 'anthropic') {
		if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey
		headers['anthropic-version'] = '2023-06-01'
		if (cfg.route !== 'proxy') headers['anthropic-dangerous-direct-browser-access'] = 'true'
	} else if (cfg.apiKey) {
		headers.authorization = `Bearer ${cfg.apiKey}`
	}
	// 透传用户自定义请求头
	if (cfg.extraHeaders) {
		for (const [k, v] of Object.entries(cfg.extraHeaders)) {
			if (!String(k).trim() || v === undefined || v === null || v === '') continue
			headers[String(k).toLowerCase()] = String(v)
		}
	}
	return headers
}

// ------------------------------------------------------------ 请求体转换

function openaiToolsToResponses(tools = []) {
	return tools
		.map((t) => {
			if (!t?.function) return null
			return {
				type: 'function',
				name: t.function.name,
				description: t.function.description || '',
				parameters: t.function.parameters ?? { type: 'object', properties: {} },
				strict: false,
			}
		})
		.filter(Boolean)
}

function openaiToolsToAnthropic(tools = []) {
	return tools
		.map((t) => {
			if (!t?.function) return null
			const p = t.function.parameters ?? {}
			return {
				name: t.function.name,
				description: t.function.description || '',
				input_schema: {
					type: 'object',
					properties: p.properties ?? {},
					required: p.required ?? [],
				},
			}
		})
		.filter(Boolean)
}

function messagesToResponsesInput(messages = []) {
	const input = []
	for (const m of messages) {
		const content = typeof m.content === 'string' ? m.content : (m.content ?? '').toString()
		if (m.role === 'system') {
			input.push({ role: 'developer', content: [{ type: 'input_text', text: content }] })
			continue
		}
		if (m.role === 'tool') {
			input.push({
				type: 'function_call_output',
				call_id: m.tool_call_id || '',
				output: content || '',
			})
			continue
		}
		if (m.role === 'assistant') {
			if (m.tool_calls?.length) {
				for (const call of m.tool_calls) {
					input.push({
						type: 'function_call',
						call_id: call.id || '',
						name: call.function?.name || '',
						arguments: call.function?.arguments || '{}',
					})
				}
			}
			if (content) {
				input.push({ role: 'assistant', content: [{ type: 'output_text', text: content }] })
			}
			continue
		}
		// user
		if (content || m.role === 'user') {
			input.push({ role: 'user', content: [{ type: 'input_text', text: content || ' ' }] })
		}
	}
	return input
}

function messagesToAnthropic(messages = []) {
	let systemText = ''
	const out = []
	const pushUserLike = (role, blocks) => {
		const last = out[out.length - 1]
		if (last && last.role === role) {
			last.content = [...last.content, ...blocks]
		} else {
			out.push({ role, content: [...blocks] })
		}
	}

	for (const m of messages) {
		const content = typeof m.content === 'string' ? m.content : (m.content ?? '').toString()
		if (m.role === 'system') {
			systemText += systemText ? `\n\n${content}` : content
			continue
		}
		if (m.role === 'tool') {
			pushUserLike('user', [
				{
					type: 'tool_result',
					tool_use_id: m.tool_call_id || '',
					content: content || '',
				},
			])
			continue
		}
		if (m.role === 'assistant') {
			const blocks = []
			if (content) blocks.push({ type: 'text', text: content })
			if (m.tool_calls?.length) {
				for (const call of m.tool_calls) {
					let input = {}
					try {
						input = JSON.parse(call.function?.arguments || '{}')
					} catch {
						input = {}
					}
					blocks.push({
						type: 'tool_use',
						id: call.id || '',
						name: call.function?.name || '',
						input,
					})
				}
			}
			if (out[out.length - 1]?.role === 'assistant') {
				out[out.length - 1].content.push(...blocks)
			} else {
				out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] })
			}
			continue
		}
		// user
		pushUserLike('user', [{ type: 'text', text: content || ' ' }])
	}

	const body = { messages: out }
	if (systemText) body.system = systemText
	return body
}

function convertToolChoice(toolChoice, protocol) {
	if (!toolChoice) return undefined
	if (typeof toolChoice === 'string') {
		if (protocol === 'openai-responses') return toolChoice
		if (protocol === 'anthropic') {
			if (toolChoice === 'required') return { type: 'any' }
			if (toolChoice === 'auto') return { type: 'auto' }
			if (toolChoice === 'none') return { type: 'none' }
			return { type: 'auto' }
		}
		return toolChoice
	}
	const name = toolChoice?.function?.name
	if (!name) return protocol === 'openai-responses' ? 'auto' : { type: 'auto' }
	if (protocol === 'openai-responses') return { type: 'function', name }
	return { type: 'tool', name }
}

function buildTargetRequest(cfg, openaiBody) {
	const protocol = cfg.protocol || 'openai-chat'
	if (protocol === 'openai-chat') {
		return openaiBody
	}
	if (protocol === 'openai-responses') {
		const input = messagesToResponsesInput(openaiBody.messages)
		const tools = openaiToolsToResponses(openaiBody.tools)
		const body = {
			model: openaiBody.model,
			input,
			store: false,
		}
		if (tools.length) body.tools = tools
		const tc = convertToolChoice(openaiBody.tool_choice, protocol)
		if (tc) body.tool_choice = tc
		if (openaiBody.temperature !== undefined) body.temperature = openaiBody.temperature
		if (openaiBody.max_tokens !== undefined) body.max_output_tokens = openaiBody.max_tokens
		return body
	}
	// anthropic
	const { messages, system } = messagesToAnthropic(openaiBody.messages)
	const tools = openaiToolsToAnthropic(openaiBody.tools)
	const body = {
		model: openaiBody.model,
		max_tokens: Number(cfg.maxTokens) || 8192,
		messages,
	}
	if (system) body.system = system
	if (tools.length) body.tools = tools
	const tc = convertToolChoice(openaiBody.tool_choice, protocol)
	if (tc) body.tool_choice = tc
	if (openaiBody.temperature !== undefined) body.temperature = openaiBody.temperature
	return body
}

// ------------------------------------------------------------ 访问码透传
const SHARE_PARAM = 'sharecode'
const SHARE_VALUE = (() => {
	try {
		return new URLSearchParams(location.search).get(SHARE_PARAM) || ''
	} catch {
		return ''
	}
})()

/** 给本站请求附加网关访问码 */
export function withShare(url) {
	if (!SHARE_VALUE || !url) return url
	const hashIdx = url.indexOf('#')
	const head = hashIdx === -1 ? url : url.slice(0, hashIdx)
	const hash = hashIdx === -1 ? '' : url.slice(hashIdx)
	const sep = head.includes('?') ? '&' : '?'
	return `${head}${sep}${SHARE_PARAM}=${encodeURIComponent(SHARE_VALUE)}${hash}`
}

// ------------------------------------------------------------ 响应体转换

function makeChoice(content, toolCalls, finishReason) {
	const message = { role: 'assistant' }
	if (content) message.content = content
	if (toolCalls?.length) message.tool_calls = toolCalls
	return {
		index: 0,
		finish_reason: finishReason || 'stop',
		message,
	}
}

function responsesToChatCompletion(data) {
	const output = data.output || []
	const toolCalls = []
	let text = ''

	for (const item of output) {
		if (item.type === 'function_call') {
			toolCalls.push({
				id: item.call_id || `call_${Math.random().toString(36).slice(2, 10)}`,
				type: 'function',
				function: {
					name: item.name,
					arguments: item.arguments && item.arguments !== '' ? item.arguments : '{}',
				},
			})
		} else if (item.type === 'message' && Array.isArray(item.content)) {
			for (const c of item.content) {
				if (c.type === 'output_text' && c.text) text += c.text
			}
		} else if (item.type === 'output_text' && item.text) {
			text += item.text
		}
	}

	const inputTokens = data.usage?.input_tokens ?? 0
	const outputTokens = data.usage?.output_tokens ?? 0
	return {
		id: data.id || `resp_${Date.now()}`,
		object: 'chat.completion',
		created: data.created_at ?? Math.floor(Date.now() / 1000),
		model: data.model,
		choices: [makeChoice(text, toolCalls, toolCalls.length ? 'tool_calls' : 'stop')],
		usage: {
			prompt_tokens: inputTokens,
			completion_tokens: outputTokens,
			total_tokens: inputTokens + outputTokens,
		},
	}
}

function anthropicToChatCompletion(data) {
	const blocks = data.content || []
	const toolCalls = []
	let text = ''
	for (const b of blocks) {
		if (b.type === 'tool_use') {
			toolCalls.push({
				id: b.id || `call_${Math.random().toString(36).slice(2, 10)}`,
				type: 'function',
				function: {
					name: b.name,
					arguments: JSON.stringify(b.input ?? {}),
				},
			})
		} else if (b.type === 'text') {
			text += b.text
		}
	}
	const inputTokens = data.usage?.input_tokens ?? 0
	const outputTokens = data.usage?.output_tokens ?? 0
	return {
		id: data.id || `msg_${Date.now()}`,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: data.model,
		choices: [makeChoice(text, toolCalls, toolCalls.length ? 'tool_calls' : 'stop')],
		usage: {
			prompt_tokens: inputTokens,
			completion_tokens: outputTokens,
			total_tokens: inputTokens + outputTokens,
		},
	}
}

function jsonResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

async function errorResponse(message, status = 502, extra) {
	return jsonResponse({ error: { message, ...extra } }, status)
}

/** 上一次成功的通道，避免每一步都白等一次超时 */
let preferredRoute = null

const LLM_TIMEOUT_MS = 45_000
// auto 模式下对「服务端代理」先做短探测：部署机出网受限（沙箱常见）时，
// 避免每次请求都白等满 45s 才发现代理通道不可达，从而尽快回退浏览器直连。
const PROBE_TIMEOUT_MS = 12_000
// 浏览器直连通道的硬超时：直连失败多为「域名不可达 / 防火墙拦截」，
// 把单次等待压到 25s，避免不可达提供方把每次调用都拖满 45s。
const DIRECT_TIMEOUT_MS = 25_000
// 这些域名在部署机的「服务端代理」通道被出网策略拦截（连接超时），
// 只能走浏览器直连。auto 模式下对它们跳过代理探测，直接优先直连。
const PROXY_UNREACHABLE_HOSTS = new Set(['zenmux.ai'])
function safeHost(u) {
	try { return new URL(u).host } catch { return '' }
}

/**
 * 区分「用户主动取消」与「请求超时」。
 * 两者都会让 fetch 抛出 AbortError，但只有前者必须立刻向上传递：
 * 超时属于调用失败，还需要继续尝试另一条通道。
 */
function isUserAbort(externalSignal) {
	return !!externalSignal?.aborted
}

/**
 * 合并「用户中止」与「超时」两个信号，避免无限挂起。
 *
 * externalSignal 是 page-agent 传进来的 abort 信号（用户点停止 / 关闭时才 abort）。
 * 之前这里只读 cfg.signal（配置项上根本不存在这个字段），等于把用户的中止意图
 * 丢掉了：点了停止之后，本次请求仍会跑满超时才结束，界面长时间卡在「执行中」。
 */
function makeSignal(timeoutMs, externalSignal) {
	const timeout = AbortSignal.timeout(timeoutMs || LLM_TIMEOUT_MS)
	if (!externalSignal) return timeout
	try {
		return AbortSignal.any([externalSignal, timeout])
	} catch {
		return timeout
	}
}

async function viaProxy(url, headers, body, timeoutMs, externalSignal) {
	const res = await sendWithRetry(withShare('/api/llm/proxy'), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-pa-target': encodeURIComponent(url),
			'x-pa-headers': btoa(unescape(encodeURIComponent(JSON.stringify(headers)))),
		},
		body: JSON.stringify(body),
		signal: makeSignal(timeoutMs, externalSignal),
	})
	return { ok: res.ok, status: res.status, text: await res.text(), channel: 'proxy' }
}

async function viaDirect(url, headers, body, timeoutMs, externalSignal) {
	const res = await sendWithRetry(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: makeSignal(timeoutMs, externalSignal),
	})
	return { ok: res.ok, status: res.status, text: await res.text(), channel: 'direct' }
}

/**
 * 统一出口：把请求送到真正的模型服务
 * route = 'auto'   | 自动：优先服务端代理（稳定规避 CORS），失败再试浏览器直连
 * route = 'proxy'  | 只走服务端转发（规避 CORS，但需要部署机器能出网）
 * route = 'direct' | 只走浏览器直连（需要服务商允许跨域）
 */
async function dispatch(cfg, url, headers, body, externalSignal) {
	// 用户已经取消：不必再发请求，直接让中止意图向上传递
	externalSignal?.throwIfAborted()

	const mode = cfg.route || 'auto'
	let order
	if (mode === 'proxy') order = ['proxy', 'direct']
	else if (mode === 'direct') order = ['direct']
	else {
		// auto：已知某些主机在部署机代理通道不可达（出网拦截），优先浏览器直连
		const host = safeHost(url)
		if (host && PROXY_UNREACHABLE_HOSTS.has(host)) order = ['direct', 'proxy']
		else order = preferredRoute === 'direct' ? ['direct', 'proxy'] : ['proxy', 'direct']
	}

	let last = null
	const failures = []
	for (const channel of order) {
		try {
			// auto 模式下先对代理通道做短探测，不可达则尽快回退浏览器直连
			const useProbe = mode === 'auto' && channel === 'proxy'
			const r = channel === 'proxy'
				? await viaProxy(url, headers, body, useProbe ? PROBE_TIMEOUT_MS : undefined, externalSignal)
				: await viaDirect(url, headers, body, DIRECT_TIMEOUT_MS, externalSignal)
			// 4xx 是模型服务的真实返回（key 无效 / 模型名错误…），换通道也不会变好，直接回传
			if (r.ok || (r.status >= 400 && r.status < 500)) {
				preferredRoute = channel
				return r
			}
			last = r
			failures.push({ channel, status: r.status, text: r.text })
		} catch (err) {
			// 用户中止不是「调用失败」：若在这里吞掉并包装成 502，
			// page-agent 会误判为可重试错误，再多发 2 次请求、更晚才停下
			if (isUserAbort(externalSignal)) throw err
			const rec = { ok: false, status: 0, text: String(err?.message || err), error: err, channel }
			last = rec
			failures.push({ channel, status: 0, text: rec.text })
		}
	}

	// 归类失败原因，给出可执行的提示（而不是笼统的「改用服务端代理」）
	const timedOut = failures.some((f) => f.status === 0 && /aborted|timeout/i.test(f.text || ''))
	const corsBlocked = failures.some((f) => /cors|cross-origin|blocked by|not allowed by|preflight/i.test(f.text || ''))

	if (mode === 'direct') {
		if (timedOut) {
			throw new Error(
				'浏览器直连超时：你的浏览器连不上该模型服务（多为网络/防火墙拦截或域名不可达）。请改用「自动」或「服务端代理」通道；若仍失败，请更换为国内可达的提供方（DeepSeek 官方 / 硅基流动）并确认已填写 API Key'
			)
		}
		if (corsBlocked) {
			throw new Error('浏览器直连被 CORS 拦截：该服务商不允许跨域请求。请在设置里切换为「自动」或「服务端代理」通道')
		}
		throw new Error('浏览器直连失败，可在设置里切换为「自动」或「服务端代理」通道')
	}

	if (timedOut) {
		throw new Error(
			'调用模型服务超时：两条通道都连不上该模型服务，可能是你的网络/防火墙拦截了该域名，或提供方（如 ZenMux）在你所在地区不可用。建议：① 改用 DeepSeek 官方 / 硅基流动 等国内可达提供方；② 确认已填写有效的 API Key；③ 切换请求通道重试'
		)
	}
	throw new Error(last?.text || '调用模型服务失败')
}

function parseJsonSafe(text) {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

/** 带超时的发送（单发，超时由调用方 signal 控制，避免无限挂起） */
async function sendWithRetry(url, options, maxAttempts = 1) {
	let lastError
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fetch(url, options)
		} catch (err) {
			lastError = err
			if (attempt === maxAttempts) break
			await new Promise((r) => setTimeout(r, 500 * attempt))
		}
	}
	throw lastError
}

/**
 * 生成 page-agent 需要的 customFetch
 * @param {Object} cfg {protocol, baseURL, apiKey, model, route, maxTokens, extraHeaders}
 */
export function createAgentFetch(cfg) {
	return async function paFetch(_url, init) {
		const protocol = cfg.protocol || 'openai-chat'
		const url = endpointFor(cfg)
		const headers = authHeaders(cfg)
		// page-agent 在用户点「停止 / 关闭」时 abort 这个信号，
		// 必须一路带到真正的请求上，否则点了停止也要等请求跑完才响应
		const externalSignal = init?.signal

		let openaiBody
		try {
			openaiBody = JSON.parse(init?.body ?? '{}')
		} catch {
			return errorResponse('无法解析上游请求体', 500)
		}
		if (!openaiBody.model) openaiBody.model = cfg.model

		const targetBody = buildTargetRequest(cfg, openaiBody)

		let upstream
		try {
			upstream = await dispatch(cfg, url, headers, targetBody, externalSignal)
		} catch (err) {
			// 用户取消：原样抛 AbortError，让 page-agent 判定为「已停止」而非「调用失败」
			if (isUserAbort(externalSignal) || err?.name === 'AbortError') throw err
			return errorResponse(
				`调用模型服务失败：${err?.message || err}（请检查提供方是否可达、API Key 是否有效，或在设置里切换请求通道）`,
				502
			)
		}

		const data = parseJsonSafe(upstream.text)

		// 某些网关在偶发故障时仍会带上有效 payload，容错放行，避免整条任务被打断
		const hasValidChoices = data && Array.isArray(data.choices) && data.choices[0]
		if ((!upstream.ok || !data) && !hasValidChoices) {
			const message =
				data?.error?.message ||
				data?.message ||
				data?.error ||
				(upstream.text || '').slice(0, 400) ||
				`HTTP ${upstream.status}`
			return errorResponse(
				`[${protocol}] ${typeof message === 'string' ? message : JSON.stringify(message)}`,
				upstream.status >= 400 ? upstream.status : 502
			)
		}
		if (!upstream.ok && hasValidChoices) {
			console.warn(`[llm-adapter] 上游返回 HTTP ${upstream.status} 但 payload 有效，已容错放行`)
		}

		if (protocol === 'openai-responses') {
			return jsonResponse(responsesToChatCompletion(data))
		}
		if (protocol === 'anthropic') {
			return jsonResponse(anthropicToChatCompletion(data))
		}
		// openai-chat：原样透传
		return jsonResponse(data, 200)
	}
}

/**
 * 设置面板里的连通性自检：发一次真实 function-calling 请求
 */
export async function testConnection(cfg) {
	const started = Date.now()
	const body = {
		model: cfg.model,
		messages: [
			{ role: 'system', content: 'You are a helpful assistant.' },
			{ role: 'user', content: 'Reply with a short greeting.' },
		],
		tools: [
			{
				type: 'function',
				function: {
					name: 'echo',
					description: 'Echo back a message',
					parameters: {
						type: 'object',
						properties: { message: { type: 'string' } },
						required: ['message'],
						additionalProperties: false,
					},
				},
			},
		],
		tool_choice: {
			type: 'function',
			function: { name: 'echo' },
		},
		parallel_tool_calls: false,
	}
	try {
		const fetchFn = createAgentFetch(cfg)
		const res = await fetchFn('', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
		const json = await res.json()
		if (!res.ok) {
			return { ok: false, message: json?.error?.message || `HTTP ${res.status}`, elapsed: Date.now() - started }
		}
		const toolName = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.name
		if (!toolName) {
			// 部分模型不支持强制工具调用，只要能正常返回即视为可用
			const content = json.choices?.[0]?.message?.content
			if (!content) return { ok: false, message: '返回内容为空，模型可能不支持工具调用', elapsed: Date.now() - started }
			return {
				ok: true,
				warning: '模型未返回工具调用（GUI Agent 依赖 function calling，请确认模型支持）',
				message: String(content).slice(0, 120),
				elapsed: Date.now() - started,
			}
		}
		return { ok: true, message: `工具调用正常（${toolName}）`, elapsed: Date.now() - started }
	} catch (err) {
		return { ok: false, message: err?.message || String(err), elapsed: Date.now() - started }
	}
}

export { endpointFor, authHeaders }
