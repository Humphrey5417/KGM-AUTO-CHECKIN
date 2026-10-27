/**
 * 按账号发送邮件通知（复用现有 SMTP 配置）。
 *
 * 背景：签到脚本原本只把结果通知给「配置者本人」（MAIL_TO）。但登录凭据失效
 * （酷狗返回 error_code 20018）这件事只有对应账号的主人能处理——必须由本人重新
 * 扫码/短信登录。因此需要在 WebUI 里让每个账号先绑定并验证自己的邮箱，
 * 失效时按账号各发一封邮件。
 *
 * 本模块负责两件事：
 *   1. 组织并发送邮件内容（验证码邮件 / 凭据失效提醒邮件）
 *   2. 失效提醒的去重：同一账号邮件提醒后 N 天内不再重复发送（默认 7 天），
 *      避免定时任务每天跑、用户每天收一封同样的信。
 *
 * 去重状态单独存文件（不进 userinfo.json）：userinfo 是凭据文件，内容会被
 * 签到流程整份写回、也常被手工编辑，混入通知时间戳容易在迁移/覆盖时丢失。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { printGreen, printRed, printYellow } from './colorOut.js'
import { maskEmail, maskIdentifier } from './safeLog.js'
import { sendMailSMTP } from './notify.js'

// 提醒间隔（天）：默认 7 天。用户明确要求「每 7 天最多提醒一次」。
const DEFAULT_COOLDOWN_DAYS = 7
// 状态文件里超过这个天数的记录会被清理，防止文件无限增长
const STATE_KEEP_DAYS = 90

/** 邮箱格式校验（够用即可：不追求 RFC 全集，只挡住明显错误与脏输入）。 */
export function isValidEmail(value) {
  const s = String(value ?? '').trim()
  if (s.length === 0 || s.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)
}

/** 是否已配置可用的发件能力（收件人由调用方逐个指定，这里只看发件三要素）。 */
export function mailConfigReady() {
  return Boolean(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS)
}

/** 是否启用「凭据失效按账号发邮件」（默认开启，可用 MAIL_INVALID_NOTIFY 关闭）。 */
export function invalidNotifyEnabled() {
  const raw = String(process.env.MAIL_INVALID_NOTIFY ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'no', 'off', '否'].includes(raw)
}

/** 提醒间隔毫秒数（MAIL_NOTICE_COOLDOWN_DAYS，默认 7 天，最小 1 天）。 */
export function noticeCooldownMs() {
  const raw = Number(process.env.MAIL_NOTICE_COOLDOWN_DAYS)
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COOLDOWN_DAYS
  return Math.max(1, days) * 24 * 60 * 60 * 1000
}

/** 去重状态文件路径：与凭据文件同目录（Docker 中是挂载卷 /app/data）。 */
export function mailNoticeFile() {
  const base = process.env.USERINFO_FILE
    ? path.dirname(process.env.USERINFO_FILE)
    : path.join(process.cwd(), 'data')
  return path.join(base, 'mail_notice.json')
}

/**
 * 读取去重状态。文件缺失/损坏一律当作空状态，不能让通知功能把签到流程带崩。
 * @returns {{ notified: Record<string, string> }} userid -> 上次成功发信时间（ISO）
 */
export function readMailNoticeState() {
  try {
    const text = fs.readFileSync(mailNoticeFile(), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    const notified = parsed && typeof parsed.notified === 'object' && parsed.notified !== null ? parsed.notified : {}
    return { notified }
  } catch {
    return { notified: {} }
  }
}

/**
 * 原子写入去重状态（tmp + rename）。
 * @param {{notified: Record<string,string>}} state
 * @returns {boolean} 是否写入成功
 */
export function writeMailNoticeState(state) {
  const file = mailNoticeFile()
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ notified: state.notified || {} }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (error) {
    printRed(`邮件提醒状态写入失败 (${file})`)
    printYellow(`  ${error?.message || error}`)
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略清理失败 */ }
    return false
  }
}

/** 清理过期记录（超过 STATE_KEEP_DAYS 的条目），返回是否发生了删除。 */
function pruneNotified(notified, now) {
  const cutoff = now - STATE_KEEP_DAYS * 24 * 60 * 60 * 1000
  let changed = false
  for (const [key, at] of Object.entries(notified)) {
    const ts = Date.parse(at)
    if (!Number.isFinite(ts) || ts < cutoff) {
      delete notified[key]
      changed = true
    }
  }
  return changed
}

/**
 * 清除某账号的提醒记录。
 * 用户重新绑定/更换邮箱后应该能立刻收到下一封（旧地址已经收不到了）。
 * @param {string} userid
 * @returns {boolean} 是否写入成功
 */
export function clearMailNotice(userid) {
  const state = readMailNoticeState()
  const key = String(userid)
  if (!Object.prototype.hasOwnProperty.call(state.notified, key)) return true
  delete state.notified[key]
  return writeMailNoticeState(state)
}

/**
 * 发送单封邮件。成功返回 true，失败返回 false 并打印脱敏后的原因。
 * @param {{to: string, subject: string, content: string}} mail
 * @returns {Promise<boolean>}
 */
export async function sendAccountMail({ to, subject, content }) {
  if (!isValidEmail(to)) {
    printYellow(`跳过无效收件邮箱: ${maskEmail(to)}`)
    return false
  }
  if (!mailConfigReady()) {
    printYellow('未配置 MAIL_HOST / MAIL_USER / MAIL_PASS，无法发送账号邮件')
    return false
  }
  try {
    await sendMailSMTP(subject, content, {
      host: process.env.MAIL_HOST,
      port: process.env.MAIL_PORT || 465,
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
      to,
      from: process.env.MAIL_USER,
      fromName: process.env.MAIL_FROM_NAME || '酷狗签到助手',
    })
    return true
  } catch (error) {
    printYellow(`邮件发送失败 (${maskEmail(to)}): ${error?.message || error}`)
    return false
  }
}

/** 生成 6 位数字验证码（用 crypto 而非 Math.random，避免可预测）。 */
export function genEmailCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

/**
 * 邮箱验证码邮件内容。
 * @param {{code: string, expireMinutes: number, accountLabel: string}} p
 */
export function buildEmailCodeMail({ code, expireMinutes, accountLabel }) {
  const subject = `【酷狗签到助手】邮箱验证码 ${code}`
  const content = [
    '你正在为酷狗签到助手的账号绑定通知邮箱。',
    '',
    `账号: ${accountLabel}`,
    `验证码: ${code}`,
    `有效期: ${expireMinutes} 分钟（仅可使用一次）`,
    '',
    '这个邮箱用于在该账号登录凭据失效时通知你重新登录，不会用于其他用途。',
    '若并非你本人操作，请忽略本邮件，你的账号不会发生任何变化。',
    '',
    '—— 此邮件由系统自动发送，请勿直接回复。',
  ].join('\n')
  return { subject, content }
}

/**
 * 凭据失效提醒邮件内容。
 * @param {{accountLabel: string, date: string, siteHint?: string}} p
 */
export function buildInvalidCredentialMail({ accountLabel, date, siteHint }) {
  const subject = '【酷狗签到助手】账号登录已失效，请重新登录'
  const content = [
    '你的酷狗账号登录凭据已失效，签到任务已无法继续执行。',
    '',
    `账号: ${accountLabel}`,
    `发现时间: ${date}`,
    '',
    '原因通常是：在其他设备登录导致 token 失效，或账号登录状态过期。',
    '处理方式：打开酷狗签到助手的 WebUI，用「扫码登录」或「手机号登录」重新登录该账号即可恢复。',
    ...(siteHint ? ['', `入口: ${siteHint}`] : []),
    '',
    '重新登录成功后，系统会自动清除「登录已失效」标记；本提醒不会重复打扰你。',
    '',
    '—— 此邮件由系统自动发送，请勿直接回复。',
  ].join('\n')
  return { subject, content }
}

/**
 * 给「凭据已失效且邮箱已验证」的账号逐个发送提醒邮件。
 *
 * 只对已验证邮箱的账号发信是硬性要求：未验证的邮箱可能是别人随手填的，
 * 拿它做通知通道等于把某个账号的失效状态告诉第三方。
 *
 * @param {Array<{userid: string|number, nickname?: string, email?: string, emailVerified?: boolean}>} accounts
 *        待检查的账号列表（通常直接传 userinfo 数组）
 * @param {{date?: string, siteHint?: string, cooldownMs?: number, dryRun?: boolean}} [opts]
 * @returns {Promise<{sent: number, skipped: number, invalid: number, failed: number}>}
 */
export async function sendInvalidCredentialNotices(accounts, opts = {}) {
  const result = { sent: 0, skipped: 0, invalid: 0, failed: 0 }
  if (!Array.isArray(accounts) || accounts.length === 0) return result
  if (!invalidNotifyEnabled()) {
    printYellow('MAIL_INVALID_NOTIFY 已关闭，跳过按账号的失效邮件提醒')
    return result
  }
  if (!mailConfigReady()) {
    printYellow('未配置 SMTP（MAIL_HOST / MAIL_USER / MAIL_PASS），跳过按账号的失效邮件提醒')
    return result
  }

  const now = Date.now()
  const cooldownMs = opts.cooldownMs ?? noticeCooldownMs()
  const state = readMailNoticeState()
  let stateChanged = pruneNotified(state.notified, now)
  const dateStr = opts.date || new Date().toISOString().slice(0, 10)

  for (const account of accounts) {
    const userid = String(account?.userid ?? '')
    if (!userid) continue
    const email = String(account?.email ?? '').trim()
    // 未绑定邮箱 / 未验证：属于「本来就不该发」，不计入失败
    if (!email || account?.emailVerified !== true || !isValidEmail(email)) {
      result.invalid++
      continue
    }
    const lastAt = Date.parse(state.notified[userid] || '')
    if (Number.isFinite(lastAt) && now - lastAt < cooldownMs) {
      result.skipped++
      continue
    }
    const accountLabel = `${account?.nickname ? String(account.nickname) : '未命名账号'}（${maskIdentifier(userid)}）`
    const mail = buildInvalidCredentialMail({ accountLabel, date: dateStr, siteHint: opts.siteHint })
    // dryRun 只用于自检，不实际发信也不写状态
    if (opts.dryRun) {
      printYellow(`[dry-run] 将发送失效提醒 -> ${maskEmail(email)} (${maskIdentifier(userid)})`)
      result.sent++
      continue
    }
    const ok = await sendAccountMail({ to: email, ...mail })
    if (ok) {
      state.notified[userid] = new Date(now).toISOString()
      stateChanged = true
      result.sent++
      printGreen(`  ✓ 已发送失效提醒至 ${maskEmail(email)}（账号 ${maskIdentifier(userid)}）`)
    } else {
      result.failed++
      printRed(`  ✗ 失效提醒发送失败（账号 ${maskIdentifier(userid)}）`)
    }
  }

  // 只有真的发出过至少一封才值得写盘；否则每轮空跑都会刷新文件时间
  if (stateChanged) {
    if (!writeMailNoticeState(state)) result.warn = 'mail_notice_write_failed'
  }
  return result
}
