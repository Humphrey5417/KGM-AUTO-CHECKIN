import { spawn } from 'child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../api')

/**
 * 本地 api 服务端口。
 * 通过环境变量 API_PORT 覆盖（默认 3000），供 Docker WebUI 等场景
 * 在同一容器内并行运行多个 api 服务实例（登录服务 / 签到子进程各用一个端口）。
 * 注意需在调用时读取（而非模块加载时），调用方可能在导入后才设置该变量。
 */
function apiPort() {
  return process.env.API_PORT || '3000'
}

function apiBase() {
  return `http://127.0.0.1:${apiPort()}`
}

/** 延时 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 等待本地 api 服务就绪（启动竞态修复）。
 * 原先各脚本在 startService() 后盲目 delay(2000)，
 * 在冷启动的 Actions runner 上可能因服务未就绪导致首个请求失败/超时。
 *
 * 探测 /healthz：该端点不触发任何上游请求、不参与缓存，返回 200 即表示服务已就绪。
 * 若服务为未包含 /healthz 的旧版本，则回退为"端口可响应任意 HTTP 即视为就绪"。
 * @param {string} base 服务地址
 * @param {number} timeoutMs 最长等待毫秒
 */
async function waitForApi(base = apiBase(), timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const resp = await fetch(base + '/healthz', { method: 'GET', signal: controller.signal })
      clearTimeout(timer)
      if (resp.ok) return true
      // 旧版本 api 无 /healthz（404）：退化为"端口已在监听"判定
      if (resp.status === 404) return true
    } catch (err) {
      // 连接被拒（ECONNREFUSED）等服务尚未就绪，稍后重试
      await delay(500)
    }
  }
  throw new Error(`本地 API 服务在 ${timeoutMs}ms 内未就绪`)
}

/**
 * api 子进程需要的环境变量白名单。
 * 原先 `{ ...process.env }` 会把 MAIL_PASS、PAT、各通知渠道密钥等一并复制给
 * api 子进程（同容器进程可经 /proc/<pid>/environ 读取），这里收敛为必需项。
 * api/server.js 仍会自行读取工作目录下的 .env，故白名单不影响其功能。
 */
const API_ENV_ALLOW = [
  'PATH', 'HOME', 'TZ', 'LANG', 'LC_ALL', 'NODE_ENV', 'PORT', 'HOST',
  'KUGOU_API_GUID', 'KUGOU_API_MID', 'KUGOU_API_DEV', 'KUGOU_API_MAC',
  'KUGOU_API_WEBGL', 'KUGOU_API_PLATFORM', 'platform', 'CORS_ALLOW_ORIGIN',
]

/** 按白名单筛选环境变量（另附显式覆盖项） */
function pickApiEnv(overrides = {}) {
  const out = {}
  for (const key of API_ENV_ALLOW) {
    if (process.env[key] !== undefined) out[key] = process.env[key]
  }
  return { ...out, ...overrides }
}

/**
 * 转发 api 子进程 stdout 里的 [ERR] 日志块（含多行续行）。
 *
 * api 用 `console.log('[ERR]', url, { status, body })` 记录失败：第一行只有 URL，
 * 酷狗返回的 error_code / msg 在随后由 Node 展开的多行对象里。只按行过滤含
 * [ERR] 的行会把这部分丢掉，日志里照样看不到失败原因。因此这里把 [ERR] 之后
 * 直到下一条 [OK]/[ERR] 标记之前的行都归入同一块，整体输出。
 *
 * 之所以不全量转发：[OK] 每个请求都打一行，签到高峰期会刷屏。
 *
 * @param {NodeJS.ReadableStream} stream 子进程 stdout
 * @param {(block: string) => void} [write] 输出函数（便于测试替换）
 */
function pipeApiErrors(stream, write = (block) => console.log('[api]', block)) {
  stream.setEncoding('utf8')
  let buffer = ''
  let block = null // 当前 [ERR] 日志块（数组，按行）
  const flush = () => {
    if (!block) return
    const text = block.join('\n').trimEnd()
    block = null
    if (text) write(text)
  }
  const handleLine = (line) => {
    if (line.startsWith('[ERR]')) {
      flush()
      block = [line]
    } else if (line.startsWith('[OK]')) {
      flush()
    } else if (block) {
      block.push(line) // [ERR] 块内的续行
    }
  }
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() // 末尾可能是半行，留到下一块
    for (const line of lines) handleLine(line)
  })
  stream.on('end', () => {
    if (buffer) handleLine(buffer)
    buffer = ''
    flush()
  })
}

/** 启动 api 服务（detached 使其成为独立进程组，便于整组强杀） */
function startService() {
  // 直接以 node 运行 api/app.js（与 npm run apiService → node app.js 等价）：
  // 1. 兼容 Windows：新版 Node 禁止无 shell 直接 spawn npm.cmd（EINVAL）；
  // 2. 少一层 npm 中间进程，close_api 强杀更干净（npm 不向子进程转发信号）。
  const api = spawn(process.execPath, ['app.js'], {
    cwd: apiDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // api 服务监听端口与客户端 base 保持一致（api/server.js 读取 PORT）
    env: pickApiEnv({ PORT: apiPort() }),
  })

  api.stderr.on('data', data => {
    const msg = String(data).trim()
    if (msg) console.log('[api stderr]', msg)
  })
  pipeApiErrors(api.stdout)
  api.on('close', code => console.log(`[api] 子进程退出，code=${code}`))

  return api
}

/**
 * 关闭 api 服务。
 * detached 使 api 服务运行在独立进程组：
 * - Linux（Actions/Docker）：process.kill(-pid, 'SIGKILL') 强杀整组；
 * - Windows：进程组不可用，降级为 api.kill() 直接结束服务进程。
 */
function close_api(api) {
  if (!api || !api.pid) return
  try {
    process.kill(-api.pid, 'SIGKILL') // 杀掉整个进程组（Linux/macOS）
  } catch (e) {
    try { api.kill('SIGKILL') } catch (_) { /* 已退出 */ }
  }
}

/**
 * 发送请求到本地 api 服务（带超时 + 重试）
 * 超时 10 秒，失败后指数退避重试最多 3 次
 * @param {string} apiPath api 服务路径（如 "/user/detail"）——
 *   参数名刻意避开模块顶部的 path 导入，避免遮蔽
 * @param {string} method HTTP 方法
 * @param {Record<string,string>} headers 请求头
 */
async function send(apiPath, method, headers) {
  const MAX_RETRIES = 3
  const TIMEOUT_MS = 10000
  let lastError

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const resp = await fetch(apiBase() + apiPath, {
        method,
        headers,
        signal: controller.signal,
      })
      clearTimeout(timer)
      return await resp.json()
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      if (attempt < MAX_RETRIES - 1) {
        const waitMs = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
        console.log(`[send] 第 ${attempt + 1} 次请求失败，${waitMs}ms 后重试: ${err.message}`)
        await delay(waitMs)
      }
    }
  }
  throw lastError
}

export { delay, startService, close_api, send, waitForApi }
