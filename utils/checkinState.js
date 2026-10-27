/**
 * 当日签到状态持久化。
 *
 * 用于「手动触发立即签到时跳过当日已完成签到的账号」：
 *   - 每次签到运行结束时，把本轮无任何错误完成的账号写入当日状态文件
 *   - 手动触发（CHECKIN_SKIP_DONE=1）时，读取状态文件并直接跳过已完成的账号，
 *     避免对酷狗 API 的重复请求
 *   - 定时任务 / GitHub Actions 不设置该标记，行为与之前完全一致（仍会完整执行）
 *
 * 状态文件默认位于凭据文件同目录（Docker 中为挂载卷 /app/data/checkin_state.json），
 * 按"北京时间日期"滚动，跨天自动失效；文件内容形如：
 *   { "date": "2026-02-06", "done": ["123456789", "987654321"] }
 *
 * 契约：
 *   - loadDoneToday 始终返回 Set（异常/跨天时为空集合）
 *   - saveDoneToday 只接受可迭代集合；失败返回 false（调用方应告警，勿静默忽略）
 */

import fs from 'node:fs'
import path from 'node:path'

function stateFile() {
  if (process.env.CHECKIN_STATE_FILE) return process.env.CHECKIN_STATE_FILE
  const base = process.env.USERINFO_FILE
    ? path.dirname(process.env.USERINFO_FILE)
    : path.join(process.cwd(), 'data')
  return path.join(base, 'checkin_state.json')
}

/**
 * 读取今日已完成签到的账号 userid 集合。
 * 始终返回 Set（非当日 / 文件损坏 / 不存在时返回空集合），保证调用方可直接用 .add()/.has()。
 * @param {string} today 北京时间日期（YYYY-MM-DD）
 * @returns {Set<string>}
 */
export function loadDoneToday(today) {
  try {
    const text = fs.readFileSync(stateFile(), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    if (parsed?.date !== today || !Array.isArray(parsed.done)) return new Set()
    return new Set(parsed.done.map(String))
  } catch {
    return new Set()
  }
}

/**
 * 原子化写入当日状态（tmp + rename）。
 * 失败时返回 false（不影响签到流程），调用方应据此告警。
 * @param {string} today 北京时间日期（YYYY-MM-DD）
 * @param {Iterable<string>} doneSet 已完成签到的 userid 集合
 * @returns {boolean} 是否写入成功
 */
export function saveDoneToday(today, doneSet) {
  // 契约校验：必须可迭代。若误传 Map 会被展开成 [key,value] 而静默写出错误内容，
  // 因此显式拒绝，避免"看起来成功但内容不对"。
  if (!doneSet || typeof doneSet[Symbol.iterator] !== 'function') {
    throw new TypeError('saveDoneToday: doneSet 必须是可迭代的 userid 集合（如 Set）')
  }
  const file = stateFile()
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ date: today, done: [...doneSet] }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    return false
  }
}

/**
 * 是否应记录/读取签到状态。
 * 配置了状态文件路径（显式 CHECKIN_STATE_FILE，或凭据文件同目录）即启用；
 * 手动触发（skipDone）时也启用——此时若目录不可写，写入会失败并由调用方告警。
 * @param {boolean} skipDone 是否为手动触发
 * @returns {boolean}
 */
export function checkinStateEnabled(skipDone) {
  return Boolean(process.env.USERINFO_FILE || process.env.CHECKIN_STATE_FILE) || Boolean(skipDone)
}
