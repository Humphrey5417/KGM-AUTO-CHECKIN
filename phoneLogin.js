import { printGreen, printRed, printYellow } from "./utils/colorOut.js";
import { sanitizeForLog, summarizeResponse } from "./utils/safeLog.js";
import { upsertUser, saveUserinfo, parseUserinfoJson } from "./utils/userinfo.js";
import { close_api, delay, send, startService, waitForApi } from "./utils/utils.js";
import { buildDeviceCookie, generateDevice, isValidDevice } from "./utils/device.js";
import fs from "node:fs";

// 与 sent.js 共用的设备标识文件：发码 step 写、登录 step 读，保证同一手机号
// 发验证码与登录用的是同一台「设备」（工作流里两个 step 共享 runner 工作区）。
const PHONE_DEVICE_FILE = process.env.PHONE_DEVICE_FILE || "./phone-device.json"
const PHONE_DEVICE_TTL = 10 * 60 * 1000

function readSentDevice(phone) {
  try {
    const cached = JSON.parse(fs.readFileSync(PHONE_DEVICE_FILE, "utf8"))
    if (cached?.phone !== phone || !isValidDevice(cached.device)) return null
    if (Date.now() - Number(cached.at || 0) > PHONE_DEVICE_TTL) return null
    return cached.device
  } catch {
    return null
  }
}

async function login() {

  const phone = process.env.PHONE
  const code = process.env.CODE
  const USERINFO = process.env.USERINFO
  const APPEND_USER = process.env.APPEND_USER
  const userinfo = (USERINFO && APPEND_USER == "是") ? (parseUserinfoJson(USERINFO) || []) : []

  // 不使用二维码登录并且没有手机号或验证码
  if (!phone || !code) {
    throw new Error("未配置")
  }
  // 启动服务并等待就绪（避免冷启动竞态）
  const api = startService()
  try {
    await waitForApi()
  } catch (e) {
    close_api(api)
    throw e
  }

  try {
    // 复用发送验证码时的那套设备标识（同工作流上一 step 落盘）；读不到才新生成一套
    const device = readSentDevice(phone) || generateDevice()
    const result = await send(`/login/cellphone?mobile=${phone}&code=${code}`, "GET", { cookie: buildDeviceCookie(device) })
    if (result.status === 1) {
      printGreen("登录成功！")
      upsertUser(userinfo, { userid: result.data.userid, token: result.data.token, device }, APPEND_USER == "是")
      saveUserinfo(userinfo)
      try { fs.rmSync(PHONE_DEVICE_FILE, { force: true }) } catch { /* 清理失败不影响登录结果 */ }
    } else if (result.error_code === 34175) {
      throw new Error("暂不支持多账号绑定手机登录")
    } else {
      printRed("响应内容")
      console.dir(summarizeResponse(result), { depth: null })
      throw new Error("登录失败！请检查")
    }
  } finally {
    close_api(api)
  }
}

login().then(() => { process.exitCode = 0 }).catch(e => { console.error(e); process.exitCode = 1 })
