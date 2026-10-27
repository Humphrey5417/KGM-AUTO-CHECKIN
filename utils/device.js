/**
 * 每账号独立设备标识
 *
 * 机制：userinfo 条目携带 device 字段（{ guid, mid, dev }），登录/签到请求
 * 以请求级 cookie 覆盖 api 进程的全局设备标识（api/server.js 的 ensureCookie
 * 只在键不存在时注入，见 KUGOU_API_MID 相关修复）。
 * - 存量账号：启动迁移时补上「固定标识」（.env 里已配置的 KUGOU_API_* ，未配置则用内置常量），
 *   保持历史行为，避免设备漂移触发风控。
 * - 新登录账号：登录流程用预生成的一套新标识，成功后写入条目；老账号重新登录
 *   也同样换用登录时预生成的标识（统一方案）。
 * - 三项必须一起传，且分隔符必须是 "; "（分号+空格），否则 api 端 cookie 解析
 *   会把整串当一个键。
 */

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// api/ 是 CommonJS 包（独立 package.json + node_modules），主仓库为 ESM，
// 不能直接 import 其内部模块，用 createRequire 惰性加载并降级。
let apiUtil = null
function loadApiUtil() {
  if (apiUtil !== null) return apiUtil
  try {
    const util = require('../api/util/util.js')
    apiUtil = { getGuid: util.getGuid, calculateMid: util.calculateMid, randomString: util.randomString, isUUIDv4: util.isUUIDv4 }
  } catch {
    apiUtil = false
  }
  return apiUtil
}

/** 内置的存量账号固定设备标识（.env 未配置 KUGOU_API_* 时使用，与作者已固定的值一致） */
export const GLOBAL_DEVICE = Object.freeze({
  guid: '57bcc306-72a0-48ab-a9e0-c09eee3e325d',
  mid: '77509015806163810263172495831007889499',
  dev: 'I2F9RVGTF6',
})

/** 设备标识字段是否完整有效 */
export function isValidDevice(device) {
  return Boolean(
    device && typeof device === 'object' &&
    typeof device.guid === 'string' && device.guid.trim() &&
    typeof device.mid === 'string' && device.mid.trim() &&
    typeof device.dev === 'string' && device.dev.trim()
  )
}

/**
 * 生成一套全新设备标识（与 api/server.js 进程级随机构造完全同构：
 * guid=UUIDv4，mid=calculateMid(md5(guid))，dev=randomString(10) 大写）。
 * util 加载失败时抛错——宁可登录失败也不要落一套残缺标识。
 * @returns {{guid:string, mid:string, dev:string}}
 */
export function generateDevice() {
  const util = loadApiUtil()
  if (!util) throw new Error('无法加载 api/util/util.js，生成设备标识失败')
  const guid = util.getGuid()
  const mid = util.calculateMid(
    require('node:crypto').createHash('md5').update(guid).digest('hex')
  )
  const dev = util.randomString(10).toUpperCase()
  return { guid, mid, dev }
}

/**
 * 从「userinfo 条目」或「裸 device 对象」中取出设备标识。
 * 调用方两种写法都常见（buildDeviceCookie(user) / buildDeviceCookie(device)），统一在这里兼容。
 * @param {object} [input]
 * @returns {{guid:string, mid:string, dev:string}|null}
 */
function pickDevice(input) {
  if (!input || typeof input !== 'object') return null
  if (isValidDevice(input)) return input // 裸 device 对象
  if (isValidDevice(input.device)) return input.device // userinfo 条目
  return null
}

/**
 * 把设备标识拼进请求 cookie（三项必须一起传，分隔符 "; "）。
 * @param {object} input userinfo 条目（含 device 字段）或裸 device 对象
 * @param {string} [baseCookie] 已有的 cookie 串（如 token=...; userid=...）
 * @returns {string} 拼接后的 cookie 串；无有效设备标识时原样返回 baseCookie
 */
export function buildDeviceCookie(input, baseCookie = '') {
  const device = pickDevice(input)
  if (!device) return baseCookie
  const parts = [
    `KUGOU_API_GUID=${device.guid}`,
    `KUGOU_API_MID=${device.mid}`,
    `KUGOU_API_DEV=${device.dev}`,
  ]
  return baseCookie ? `${baseCookie}; ${parts.join('; ')}` : parts.join('; ')
}

/**
 * 存量账号使用的「固定设备标识」。
 *
 * 优先取 .env 里已固定的 KUGOU_API_GUID / KUGOU_API_MID / KUGOU_API_DEV（推导方式与
 * api/server.js 完全一致：GUID 为 UUIDv4 时先取 md5，MID 未显式配置时由 GUID 派生）；
 * 未配置时回退到内置常量，保证升级后老账号仍用同一套设备、不会出现设备漂移。
 * @returns {{guid:string, mid:string, dev:string}}
 */
export function legacyDevice() {
  const read = (key) => {
    const raw = process.env[key]
    return typeof raw === 'string' && raw.trim() ? raw.trim() : ''
  }
  const rawGuid = read('KUGOU_API_GUID')
  if (!rawGuid) return { ...GLOBAL_DEVICE }
  const util = loadApiUtil()
  const isUuid = util ? util.isUUIDv4(rawGuid) : false
  const guid = isUuid ? require('node:crypto').createHash('md5').update(rawGuid).digest('hex') : rawGuid
  const mid = read('KUGOU_API_MID') || (util ? util.calculateMid(guid) : GLOBAL_DEVICE.mid)
  const dev = (read('KUGOU_API_DEV') || GLOBAL_DEVICE.dev).toUpperCase()
  return { guid, mid, dev }
}

/**
 * 一次性迁移：给所有缺少有效 device 的 userinfo 条目补上固定标识（见 legacyDevice）。
 * 幂等：已有有效 device 的条目不动；返回本次补齐的条目数（由调用方决定是否落盘）。
 * @param {Array} userinfo
 * @returns {number} 本次补齐的条目数
 */
export function migrateUserinfoDevice(userinfo) {
  if (!Array.isArray(userinfo)) return 0
  let legacy = null
  let changed = 0
  for (const user of userinfo) {
    if (!user || typeof user !== 'object') continue
    if (isValidDevice(user.device)) continue
    legacy = legacy || legacyDevice()
    user.device = { ...legacy }
    changed++
  }
  return changed
}
