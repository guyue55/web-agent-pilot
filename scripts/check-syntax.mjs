import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 语法检查：对仓库里所有被 git 跟踪的 .js / .mjs 跑 node --check。
 *
 * 为什么要单独一个脚本而不是 CI 里写一行 shell：
 *  - 跨平台（Windows 的 shell 循环写法不同，这里统一由 Node 处理）；
 *  - 只检查「被 git 跟踪」的文件，node_modules / 临时文件天然被排除；
 *  - 失败时一次性列出全部问题文件，而不是遇到第一个就停。
 *
 * node --check 会按最近的 package.json 的 "type" 判定模块类型，
 * 本项目 type=module，因此 server/*.js 里的 import 语法能被正确解析。
 */
const root = process.cwd()

function trackedFiles() {
	const out = execFileSync('git', ['ls-files', '*.js', '*.mjs'], {
		cwd: root,
		encoding: 'utf8',
	})
	return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

const files = trackedFiles()
if (files.length === 0) {
	console.error('没有找到被 git 跟踪的 .js / .mjs 文件')
	process.exit(1)
}

const failed = []
for (const rel of files) {
	const abs = path.join(root, rel)
	if (!fs.existsSync(abs)) continue
	try {
		execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' })
	} catch (err) {
		failed.push({ rel, msg: String(err.stderr || err.message).trim().split('\n')[0] })
	}
}

console.log(`语法检查：共 ${files.length} 个文件`)
if (failed.length) {
	for (const f of failed) console.error(`  ❌ ${f.rel}\n     ${f.msg}`)
	console.error(`\n${failed.length} 个文件语法不通过`)
	process.exit(1)
}
console.log('✅ 全部通过')
