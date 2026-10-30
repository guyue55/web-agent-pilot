/**
 * 极简 WebSocket 回显服务（零依赖），供 WS 隧道回归使用。
 * 只实现一个文本帧回显：收到 "hello" 回 "echo:hello"。
 */
import http from 'node:http'
import crypto from 'node:crypto'

const PORT = Number(process.env.WS_PORT || 3501)
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeText(text) {
	const payload = Buffer.from(text, 'utf8')
	const len = payload.length
	let header
	if (len < 126) {
		header = Buffer.from([0x81, len])
	} else {
		header = Buffer.alloc(4)
		header[0] = 0x81
		header[1] = 126
		header.writeUInt16BE(len, 2)
	}
	return Buffer.concat([header, payload])
}

const server = http.createServer((req, res) => {
	res.writeHead(426).end('upgrade required')
})

server.on('upgrade', (req, socket) => {
	const key = req.headers['sec-websocket-key']
	if (!key) {
		socket.destroy()
		return
	}
	const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
	socket.write(
		[
			'HTTP/1.1 101 Switching Protocols',
			'Upgrade: websocket',
			'Connection: Upgrade',
			`Sec-WebSocket-Accept: ${accept}`,
			'\r\n',
		].join('\r\n')
	)

	let buf = Buffer.alloc(0)
	socket.on('data', (chunk) => {
		buf = Buffer.concat([buf, chunk])
		// 逐帧解析（客户端帧一定带掩码）
		while (buf.length >= 2) {
			const opcode = buf[0] & 0x0f
			const masked = (buf[1] & 0x80) !== 0
			let len = buf[1] & 0x7f
			let offset = 2
			if (len === 126) {
				if (buf.length < 4) return
				len = buf.readUInt16BE(2)
				offset = 4
			} else if (len === 127) {
				if (buf.length < 10) return
				len = Number(buf.readBigUInt64BE(2))
				offset = 10
			}
			const maskLen = masked ? 4 : 0
			if (buf.length < offset + maskLen + len) return
			const mask = masked ? buf.subarray(offset, offset + 4) : null
			const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len))
			if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
			buf = buf.subarray(offset + maskLen + len)

			if (opcode === 0x8) {
				socket.end()
				return
			}
			if (opcode === 0x9) {
				socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]))
				continue
			}
			if (opcode === 0x1) {
				socket.write(encodeText(`echo:${payload.toString('utf8')}`))
			}
		}
	})
	socket.on('error', () => socket.destroy())
})

server.listen(PORT, '127.0.0.1', () => console.log(`[ws-echo] ws://127.0.0.1:${PORT}/echo`))
