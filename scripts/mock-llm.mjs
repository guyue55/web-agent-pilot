// Mock LLM：延迟 N 毫秒后返回 OpenAI 格式响应，用于验证请求是否被真正中断
//
// 注意：本服务占用**两个**端口 —— PORT（模型接口）与 PORT+1（/__log、/__reset 日志接口）。
// 因此同一台机器上不要起 MOCK_PORT 相邻的两个实例（例如 3400 与 3401），
// 否则后者的模型端口会抢占前者的日志端口，前者因 EADDRINUSE 崩溃，
// 连带 PORT 也一起不可用（实测表现：3400 一直连不上）。
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 3400)
const DELAY_MS = Number(process.env.MOCK_DELAY || 6000)

const log = []

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers': '*',
}

const server = http.createServer((req, res) => {
	if (req.method === 'OPTIONS') {
		res.writeHead(204, CORS).end()
		return
	}
	if (req.method !== 'POST') {
		res.writeHead(405, CORS).end('{"error":{"message":"method not allowed"}}')
		return
	}
	const id = `req_${log.length + 1}`
	const entry = { id, url: req.url, arrivedAt: Date.now(), state: 'pending' }
	log.push(entry)

	req.on('aborted', () => {
		if (entry.state !== 'pending') return
		entry.state = 'aborted'
		entry.closedAt = Date.now()
		entry.elapsed = entry.closedAt - entry.arrivedAt
		console.log(`[mock] ${id} ABORTED after ${entry.elapsed}ms`)
	})

	let body = ''
	req.on('data', (c) => (body += c))
	req.on('end', () => {
		// 记录请求体，便于断言「续跑提示词是否真的发出了」
		entry.body = body.slice(0, 20000)
		const timer = setTimeout(() => {
			if (entry.state !== 'pending') return
			entry.state = 'responded'
			entry.closedAt = Date.now()
			entry.elapsed = entry.closedAt - entry.arrivedAt
			// 只接受 AgentOutput 工具调用，模拟真实 LLM 输出
			const payload = {
				id: 'chatcmpl-mock',
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: 'mock-model',
				choices: [
					{
						index: 0,
						finish_reason: 'tool_calls',
						message: {
							role: 'assistant',
							tool_calls: [
								{
									id: 'call_mock',
									type: 'function',
									function: {
										name: 'AgentOutput',
										arguments: JSON.stringify({
											evaluation_previous_goal: 'mock',
											memory: 'mock',
											next_goal: 'finish',
											action: { done: { success: true, text: 'mock done' } },
										}),
									},
								},
							],
						},
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
			}
			res.writeHead(200, { 'content-type': 'application/json', ...CORS })
			res.end(JSON.stringify(payload))
			console.log(`[mock] ${id} responded after ${entry.elapsed}ms`)
		}, DELAY_MS)

		req.on('aborted', () => clearTimeout(timer))
	})
})

// 供实验脚本查询日志
const api = http.createServer((req, res) => {
	res.setHeader('access-control-allow-origin', '*')
	if (req.url === '/__log') {
		res.writeHead(200, { 'content-type': 'application/json' })
		res.end(JSON.stringify(log))
		return
	}
	if (req.url === '/__reset') {
		log.length = 0
		res.writeHead(200).end('ok')
		return
	}
	res.writeHead(404).end('nope')
})

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] llm on ${PORT} delay=${DELAY_MS}ms`))
api.listen(PORT + 1, '127.0.0.1', () => console.log(`[mock] log api on ${PORT + 1}`))
