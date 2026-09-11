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
 */
function minutesUntilFlip(schedule: Schedule, weekday: number, minutes: number): number {
  const windows = normalizedWindows(schedule)
  if (windows.length === 0) return Number.POSITIVE_INFINITY

  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const day = (weekday + dayOffset) % 7
    const base = dayOffset * 1440
    const peakToday = isPeakDay(schedule, day)

    // 峰时天：窗口 start/end 都是翻转点；谷时天没有任何窗口。
    if (!peakToday) continue

    const candidates: number[] = []
    for (const w of windows) {
      candidates.push(w.start, w.end)
    }
    candidates.sort((a, b) => a - b)

    for (const c of candidates) {
      const delta = base + c - minutes
      if (delta > 0) return delta
    }
  }
  return Number.POSITIVE_INFINITY
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
  const minutesUntilSwitch = minutesUntilFlip(schedule, weekday, minutes)
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
