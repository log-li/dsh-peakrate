/**
 * 时段判定 —— 纯函数，零依赖（只用原生 Intl + Date）。
 *
 * 全部计算都按 profile 自带的 timeZone 进行，与用户本地时区无关。
 * 灵感来源：future007s/dsh-peak-indicator（MIT）的 currentPeriod 思路，
 * 本实现将其从「DeepSeek 硬编码」泛化为「任意时区 + 任意窗口列表」。
 */

/** 一个时段窗口，"HH:mm" 于 profile 自己的时区；start 含、end 不含。 */
export interface PeakWindow {
  start: string
  end: string
}

/** 时段规则（profile 的子集，与数据源 schedule 字段同构）。 */
export interface Schedule {
  /** IANA 时区名，如 "UTC" / "Asia/Shanghai"。 */
  timeZone: string
  /** 0=周日 … 6=周六。 */
  peakDays: number[]
  peakWindows: PeakWindow[]
  offDayName?: string
}

export type Period = 'peak' | 'offPeak'

export interface PeriodResult {
  period: Period
  /** 距下一个状态翻转点的分钟数；总是 > 0。 */
  minutesUntilSwitch: number
}

/** 把 "HH:mm" 解析为当天分钟数；非法输入返回 NaN。 */
function parseMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (m === null) return Number.NaN
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return Number.NaN
  return h * 60 + min
}

/**
 * 取某时刻在目标时区下的「墙上时间」分量。
 * 用 formatToParts 而非解析字符串，避免 locale 差异导致的格式漂移。
 */
function wallClock(now: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)

  let weekday = 0
  let hour = 0
  let minute = 0
  for (const p of parts) {
    if (p.type === 'weekday') {
      const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.value)
      if (idx >= 0) weekday = idx
    } else if (p.type === 'hour') {
      // hour12:false 在部分环境返回 "24" 表示午夜，归一化到 0。
      hour = Number(p.value) % 24
    } else if (p.type === 'minute') {
      minute = Number(p.value)
    }
  }
  return { weekday, minutes: hour * 60 + minute }
}

/** 该星期是否属于峰时天。 */
function isPeakDay(schedule: Schedule, weekday: number): boolean {
  return schedule.peakDays.includes(weekday)
}

/** 当前分钟是否落在任一峰时窗口内（start 含、end 不含）。 */
function inPeakWindow(schedule: Schedule, minutes: number): boolean {
  for (const w of schedule.peakWindows) {
    const start = parseMinutes(w.start)
    const end = parseMinutes(w.end)
    if (Number.isNaN(start) || Number.isNaN(end)) continue
    if (end > start) {
      // 常规窗口，如 12:00-18:00
      if (minutes >= start && minutes < end) return true
    } else {
      // 跨午夜窗口，如 22:00-02:00
      if (minutes >= start || minutes < end) return true
    }
  }
  return false
}

/** 归一化窗口为当天的 [start, end) 分钟区间（end 跨午夜时按 +1440 处理）。 */
function normalizedWindows(schedule: Schedule): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const w of schedule.peakWindows) {
    const start = parseMinutes(w.start)
    const end = parseMinutes(w.end)
    if (Number.isNaN(start) || Number.isNaN(end)) continue
    out.push({ start, end: end > start ? end : end + 1440 })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * 计算从「当天的第 minutes 分钟」出发，到下一个状态翻转点还有多久。
 *
 * 翻转点只可能出现在：某个窗口的 start（谷→峰）或 end（峰→谷）。
 * 逐日向后扫描（最多 8 天，足以覆盖任意 peakDays 组合）以保证跨日、
 * 跨周末都正确。
 *
 * **DST 处理**：不能简单用 `dayOffset * 1440` 累加——夏令时切换当天只有
 * 1380 或 1500 分钟，那样算出的倒计时会整整差一小时。这里改为：先用
 * 墙上时间定位「翻转点所在的墙上时刻」，再用真实时间戳求差值，从而在
 * 任意时区、任意 DST 切换日都得到正确的实际等待时长。
 */
function minutesUntilFlip(schedule: Schedule, now: Date, weekday: number, minutes: number): number {
  const windows = normalizedWindows(schedule)
  if (windows.length === 0) return Number.POSITIVE_INFINITY

  // 翻转点在「第几天 + 当天第几分钟」的墙上坐标。
  type WallPoint = { dayOffset: number; minuteOfDay: number }

  const found: WallPoint[] = []
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const day = (weekday + dayOffset) % 7
    if (!isPeakDay(schedule, day)) continue
    for (const w of windows) {
      for (const c of [w.start, w.end]) {
        // 跨午夜的窗口 end 会 > 1440，归属到「次日」
        const extraDay = Math.floor(c / 1440)
        const minuteOfDay = c % 1440
        // 只有当该墙上时刻确实晚于「现在」，才可能是下一个翻转点
        if (dayOffset * 1440 + c > minutes) {
          found.push({ dayOffset: dayOffset + extraDay, minuteOfDay })
        }
      }
    }
  }
  if (found.length === 0) return Number.POSITIVE_INFINITY

  // 把墙上坐标转成真实时间戳，取最早的一个，再用真实毫秒差求分钟数。
  let best = Number.POSITIVE_INFINITY
  for (const p of found) {
    const ts = wallClockToTimestamp(schedule.timeZone, now, p.dayOffset, p.minuteOfDay)
    if (ts === undefined) continue
    const deltaMs = ts - now.getTime()
    if (deltaMs > 0 && deltaMs < best) best = deltaMs
  }
  return Number.isFinite(best) ? Math.round(best / 60000) : Number.POSITIVE_INFINITY
}

/**
 * 把「基准日 + N 天 + 当天第 M 分钟」的墙上坐标，解析为该时区下的真实时间戳。
 *
 * 做法：用基准日在该时区的墙上日期做日历加法，得到目标墙上日期，
 * 再解出对应的 UTC 时刻。这样即使目标日处于 DST 切换前后，也能得到
 * 正确的绝对时间。
 *
 * @returns 目标时间戳；无法解析时返回 undefined。
 */
function wallClockToTimestamp(
  timeZone: string,
  base: Date,
  dayOffset: number,
  minuteOfDay: number,
): number | undefined {
  // 基准日在该时区的墙上日期（年/月/日）
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base)
  let y = 0
  let mo = 0
  let d = 0
  for (const p of parts) {
    if (p.type === 'year') y = Number(p.value)
    else if (p.type === 'month') mo = Number(p.value)
    else if (p.type === 'day') d = Number(p.value)
  }
  if (y === 0 || mo === 0 || d === 0) return undefined

  // 目标墙上日期 = 基准墙上日期 + dayOffset 天（用 UTC 日历避免本地时区干扰）
  const target = new Date(Date.UTC(y, mo - 1, d))
  target.setUTCDate(target.getUTCDate() + dayOffset)
  const ty = target.getUTCFullYear()
  const tmo = target.getUTCMonth() + 1
  const td = target.getUTCDate()

  const hh = Math.floor(minuteOfDay / 60)
  const mm = minuteOfDay % 60

  // 解出该墙上时刻对应的 UTC 时间戳：先按 UTC 猜一个，再用该时区的实际偏移修正。
  const guess = Date.UTC(ty, tmo - 1, td, hh, mm)
  const offset1 = tzOffsetMs(timeZone, new Date(guess))
  let ts = guess - offset1
  // 再迭代一次，处理「猜测点恰好落在切换另一侧」的情况
  const offset2 = tzOffsetMs(timeZone, new Date(ts))
  if (offset2 !== offset1) ts = guess - offset2
  return ts
}

/** 求某时刻在指定时区相对 UTC 的偏移（毫秒）。 */
function tzOffsetMs(timeZone: string, at: Date): number {
  // 用 formatToParts 取该时区的墙上时间，与 UTC 墙上时间之差即偏移。
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUTC - at.getTime()
}

/**
 * 判定某时刻处于峰时还是谷时，并给出距切换的分钟数。
 *
 * @param schedule - profile 的时段规则（自带时区）。
 * @param now - 判定基准时刻。
 * @returns 当前时段与距切换分钟数（总为正）。
 */
export function currentPeriod(schedule: Schedule, now: Date): PeriodResult {
  const { weekday, minutes } = wallClock(now, schedule.timeZone)
  const peak = isPeakDay(schedule, weekday) && inPeakWindow(schedule, minutes)
  const period: Period = peak ? 'peak' : 'offPeak'
  const minutesUntilSwitch = minutesUntilFlip(schedule, now, weekday, minutes)
  return { period, minutesUntilSwitch }
}

/**
 * 格式化倒计时：<1h 用 "Xm"；<24h 用 "Xh Ym"；≥24h 用 "Xd Yh"。
 *
 * @param minutes - 分钟数。
 * @returns 供 UI 直接展示的字符串。
 */
export function formatCountdown(minutes: number): string {
  if (!Number.isFinite(minutes)) return ''
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total}m`
  if (total < 1440) {
    const h = Math.floor(total / 60)
    const m = total % 60
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  return h === 0 ? `${d}d` : `${d}d ${h}h`
}
