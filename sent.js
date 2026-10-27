import fs from "node:fs";
import { close_api, delay, send, startService, waitForApi } from "./utils/utils.js";
import { summarizeResponse } from "./utils/safeLog.js";
import { buildDeviceCookie, generateDevice, isValidDevice } from "./utils/device.js";

// 「发送验证码」和「登录」是工作流里两个独立 step，靠文件把设备标识带到下一步，
// 否则发码设备与登录设备不一致，等于设备漂移（与二维码登录的 KEYS_FILE 同一思路）。
const PHONE_DEVICE_FILE = process.env.PHONE_DEVICE_FILE || "./phone-device.json"

async function login() {

  const phone = process.env.PHONE

  if (!phone) {
    throw new Error("参数错误！请检查")
  }
  // 启动服务并等待就绪（避免冷启动竞态）
  const api = startService()
  try {
    await waitForApi()
  } catch (e) {
    close_api(api)
    throw e
  }

  console.log("开始发送验证码")
  try {
    // 同一手机号已有未过期的设备标识时复用它（重复发送验证码不切换设备）
    let device = null
    try {
      const cached = JSON.parse(fs.readFileSync(PHONE_DEVICE_FILE, "utf8"))
      if (cached?.phone === phone && isValidDevice(cached.device)) device = cached.device
    } catch { /* 无缓存或损坏，重新生成 */ }
    if (!device) device = generateDevice()
    try {
      fs.writeFileSync(PHONE_DEVICE_FILE, JSON.stringify({ phone, device, at: Date.now() }))
    } catch { /* 写盘失败不影响发码，最坏情况是下一步换设备 */ }

    const result = await send(`/captcha/sent?mobile=${phone}`, "GET", { cookie: buildDeviceCookie(device) })
    if (result.status === 1) {
      console.log("发送成功")
    } else {
      console.log("响应内容")
      console.dir(summarizeResponse(result), { depth: null })
      throw new Error("发送失败！请检查")
    }
  } finally {
    close_api(api)
  }
}

login().then(() => { process.exitCode = 0 }).catch(e => { console.error(e); process.exitCode = 1 })
