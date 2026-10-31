/**
 * 浏览器可执行文件解析（测试脚本共用）
 *
 * 回归脚本用 playwright-core 连接本机真实的 Chrome —— core 版不带浏览器，
 * 必须自己给出 executablePath。此前每个脚本各自写死 macOS 路径，在 Linux
 * （含 GitHub Actions）上必然找不到浏览器。
 *
 * 优先级：CHROME_PATH 环境变量 → 本机常见安装位置。
 * 全部取不到时返回 undefined，由 playwright 报出明确的「找不到浏览器」错误，
 * 而不是让调用方拿到一个不存在的路径后失败得更隐晦。
 */
import fs from 'node:fs'

const CANDIDATES = [
	process.env.CHROME_PATH,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/snap/bin/chromium',
].filter(Boolean)

export function chromeExe() {
	return CANDIDATES.find((p) => fs.existsSync(p))
}
