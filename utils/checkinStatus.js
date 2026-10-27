/**
 * 签到状态文件（data/checkin_status.json）读写。
 *
 * 用途：
 *   1. 记录每个账号最近一次查到的 VIP 到期时间，供 WebUI「账号管理」面板展示；
 *   2. 记录登录凭据已失效的账号（酷狗明确返回 error_code 20018），供面板提示「需重新登录」。
 * 由 main.js 在签到结束时写入，webui/server.js 在 GET /api/accounts 时读取。
 *
 * 文件内容形如：
 *   { "updatedAt": "2026-10-20T00:00:00.000Z", "date": "2026-10-20",
 *     "vipExpiry": { "123456789": "2026-12-31 23:59:59" },
 *     "vipExpiryAt": { "123456789": "2026-10-20" },
 *     "invalidCreds": { "987654321": "2026-10-21" } }
 *
 * 关键约束（这里出过 bug，勿回退）：
 *   1. 写盘必须与文件已有内容**合并**，不能整份覆盖。手动触发会跳过当日已签到的账号，
 *      被跳过的账号本轮不查询 VIP 详情，覆盖写会把之前写好的到期时间全部抹掉，
 *      面板随即退回「未获取」。
 *   2. 「未知」表示本轮没查到有效值，不能拿它覆盖已有的正确值。
 *   3. vipExpiryAt 记录该到期时间是哪天查到的，用于避免每次手动触发都对
 *      全部已签到账号重查一遍 VIP 详情（跳过机制本就是为了减少重复请求）。
 *   4. invalidCreds 只在明确判定凭据失效（error_code 20018）时写入。账号下次签到成功、
 *      或用户在 WebUI 重新登录后必须删除该条目，否则面板会一直挂着过期的「需重新登录」提示。
 *      像 error_code 20006 这类瞬时拒绝不能写入——同一 token 稍后重试就能成功。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 无效到期时间的占位值（main.js 查不到时使用），不写入状态文件、也不覆盖已有值 */
const UNKNOWN_EXPIRY = '未知'

/** 是否为可用的到期时间值（非空字符串且不是「未知」占位） */
function isValidExpiry(value) {
  return typeof value === 'string' && value.trim() !== '' && value !== UNKNOWN_EXPIRY
}

/** 是否为可用的普通对象（排除 null / 数组） */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 读取完整状态：到期时间映射、各映射的取得日期、凭据失效映射。
 * 文件缺失 / JSON 损坏 / 结构不符时返回空结构（不抛异常，调用方无需 try）。
 * @param {string} file 状态文件路径
 * @returns {{date: string, vipExpiry: Record<string,string>, vipExpiryAt: Record<string,string>, invalidCreds: Record<string,string>}}
 */
export function readCheckinStatus(file) {
  const empty = { date: '', vipExpiry: {}, vipExpiryAt: {}, invalidCreds: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return {
      date: typeof parsed?.date === 'string' ? parsed.date : '',
      vipExpiry: isPlainObject(parsed?.vipExpiry) ? parsed.vipExpiry : {},
      vipExpiryAt: isPlainObject(parsed?.vipExpiryAt) ? parsed.vipExpiryAt : {},
      invalidCreds: isPlainObject(parsed?.invalidCreds) ? parsed.invalidCreds : {},
    }
  } catch {
    return empty
  }
}

/**
 * 只读取到期时间映射（WebUI 账号管理面板只需要这一项）。
 * @param {string} file 状态文件路径
 * @returns {Record<string, string>} userid -> 到期时间
 */
export function readVipExpiries(file) {
  return readCheckinStatus(file).vipExpiry
}

/**
 * 合并本轮查到的到期时间与文件已有映射（新值覆盖同名旧值，未出现于本轮的旧值保留）。
 * fresh 里的空值 / 非字符串 / 「未知」会被忽略，避免把正确值抹成无效值。
 * @param {Record<string, string>} existing 文件里已有的映射
 * @param {Record<string, string>} fresh 本轮新查到的映射
 * @returns {Record<string, string>} 合并结果
 */
export function mergeVipExpiries(existing, fresh) {
  const merged = { ...(isPlainObject(existing) ? existing : {}) }
  for (const [uid, exp] of Object.entries(fresh || {})) {
    if (isValidExpiry(exp)) merged[uid] = exp
  }
  return merged
}

/**
 * 合并凭据失效映射。
 * fresh 中值为 null 表示「该账号本轮已恢复正常」→ 从结果中删除；非空字符串表示失效日期 → 写入。
 * 未出现于本轮的旧条目原样保留（本轮没检查过的账号不应被清掉）。
 * @param {Record<string, string>} existing 文件里已有的映射
 * @param {Record<string, string|null>} fresh 本轮的增量（null = 清除）
 * @returns {Record<string, string>} 合并结果
 */
export function mergeInvalidCreds(existing, fresh) {
  const merged = { ...(isPlainObject(existing) ? existing : {}) }
  for (const [uid, at] of Object.entries(fresh || {})) {
    if (at === null) {
      delete merged[uid]
    } else if (typeof at === 'string' && at.trim() !== '') {
      merged[uid] = at
    }
  }
  return merged
}

/**
 * 原子写入状态文件（tmp + rename）。
 * 到期时间与凭据失效两个映射都为空时不写盘（避免无意义地刷新 updatedAt / date）。
 * force=true 时忽略该判断强制写盘：删除最后一条失效标记后两个映射都会变空，
 * 若仍走「空则不写」就会把旧标记留在文件里，导致面板一直提示需重新登录。
 * @param {string} file 状态文件路径
 * @param {{date: string, vipExpiry: Record<string,string>, vipExpiryAt?: Record<string,string>, invalidCreds?: Record<string,string>}} payload
 * @param {boolean} [force] 两个映射都为空时是否仍写盘
 * @returns {{ok: true} | {ok: false, error: string}} 写入结果；失败不抛异常，由调用方决定是否告警
 */
export function writeCheckinStatus(file, { date, vipExpiry, vipExpiryAt, invalidCreds }, force = false) {
  const expiryMap = isPlainObject(vipExpiry) ? vipExpiry : {}
  const invalidMap = isPlainObject(invalidCreds) ? invalidCreds : {}
  if (!force && Object.keys(expiryMap).length === 0 && Object.keys(invalidMap).length === 0) return { ok: true }
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = { updatedAt: new Date().toISOString(), date: date || '' }
    if (Object.keys(expiryMap).length > 0) payload.vipExpiry = expiryMap
    if (isPlainObject(vipExpiryAt) && Object.keys(vipExpiryAt).length > 0) payload.vipExpiryAt = vipExpiryAt
    if (Object.keys(invalidMap).length > 0) payload.invalidCreds = invalidMap
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略清理失败 */ }
    return { ok: false, error: error?.message || String(error) }
  }
}

/**
 * 清除某个账号的「凭据失效」标记（用户重新登录成功后调用）。
 * 其余字段原样保留；该账号本来就没有标记时直接返回 changed=false，不写盘。
 * @param {string} file 状态文件路径
 * @param {string} userid 账号 userid
 * @returns {{ok: boolean, changed?: boolean, error?: string}}
 */
export function clearInvalidCredential(file, userid) {
  const status = readCheckinStatus(file)
  const key = String(userid)
  if (!Object.prototype.hasOwnProperty.call(status.invalidCreds, key)) return { ok: true, changed: false }
  const invalidCreds = { ...status.invalidCreds }
  delete invalidCreds[key]
  const result = writeCheckinStatus(file, {
    date: status.date,
    vipExpiry: status.vipExpiry,
    vipExpiryAt: status.vipExpiryAt,
    invalidCreds,
  }, true)
  return result.ok ? { ok: true, changed: true } : result
}

/** 导出给调用方做「今天是否已查过」判断，与写入时的有效值口径保持一致 */
export { isValidExpiry, UNKNOWN_EXPIRY }
