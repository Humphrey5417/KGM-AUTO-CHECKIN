/**
 * 北京时间（UTC+8）日期工具。
 *
 * 背景：原实现假定运行环境为 UTC（GitHub Actions runner），
 * 通过 new Date() 加 8 小时偏移得到北京时间。
 * Docker / 本地部署时容器时区不可控（可能是 UTC、Asia/Shanghai 或其他），
 * 固定偏移会导致日期重复偏移或偏移不足。
 *
 * 这里改用 Intl 按固定时区 Asia/Shanghai 换算，与宿主/容器时区无关，
 * 在 GitHub Actions、Docker、本地开发等任意环境下结果一致。
 */

const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
})

/**
 * 获取当前（或指定时刻）的北京时间日期字符串，格式 YYYY-MM-DD
 * @param {Date} [d=new Date()]
 * @returns {string}
 */
function beijingDateStr(d = new Date()) {
  // en-CA 的数字日期格式恰好是 YYYY-MM-DD
  return DATE_FORMATTER.format(d)
}

/**
 * 判断当前（或指定时刻）的北京时间是否为周日（token 每周日刷新）
 * @param {Date} [d=new Date()]
 * @returns {boolean}
 */
function isBeijingSunday(d = new Date()) {
  return WEEKDAY_FORMATTER.format(d) === 'Sun'
}

/**
 * 计算指定 IANA 时区在某一时刻相对 UTC 的偏移量（毫秒）。
 * 利用 Intl.DateTimeFormat 将 UTC 时刻格式化为目标时区的本地时间，
 * 再按 UTC 重新解析，差值即为偏移量。正确处理夏令时。
 */
function timezoneOffsetMs(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  })
  const map = {}
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value
  const asUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second)
  return asUtc - date.getTime()
}

/**
 * 预览 "分 时 * * *" 形式的 cron 接下来 n 次执行时间（按指定时区）。
 * 仅支持简单的 "M H * * *" 格式（每天固定时刻），复杂表达式返回空数组。
 * 结果按格式化字符串返回（如 "10/16 01:10"），与调度器实际触发时刻一致。
 *
 * @param {string} schedule  cron 表达式（5 段式）
 * @param {string} timeZone  IANA 时区名（如 "Asia/Shanghai"）
 * @param {number} [n=3]     返回的未来执行次数
 * @returns {string[]}       格式化后的执行时间列表；表达式过于复杂时返回空数组
 */
function nextCronRuns(schedule, timeZone, n = 3) {
  const fields = schedule.trim().split(/\s+/)
  const [minute, hour] = fields
  // 步进/区间/列举/指定星期等复杂写法无法在此预览，返回空数组由调用方给出提示
  if (
    fields.length !== 5 ||
    !/^\d+$/.test(minute) || !/^\d+$/.test(hour) ||
    fields.slice(2).some(f => f !== '*')
  ) return []

  const targetMinute = Number(minute)
  const targetHour = Number(hour)

  const now = new Date()
  const results = []

  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const displayFmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })

  for (let day = 0; results.length < n && day < 366; day++) {
    // 该天在目标时区的日期
    const dayDate = new Date(now.getTime() + day * 86400000)
    const [y, m, d] = dateFmt.format(dayDate).split('-').map(Number)
    // 先按 UTC 构造目标时刻，再减去目标时区在该时刻的偏移，得到真实 UTC 时间戳
    const naiveUtc = Date.UTC(y, m - 1, d, targetHour, targetMinute)
    const offsetMs = timezoneOffsetMs(timeZone, new Date(naiveUtc))
    const actualUtc = naiveUtc - offsetMs
    if (actualUtc > now.getTime()) {
      results.push(displayFmt.format(new Date(actualUtc)))
    }
  }
  return results
}

export { beijingDateStr, isBeijingSunday, nextCronRuns }
