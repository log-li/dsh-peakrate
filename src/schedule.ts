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
 * **关键语义（2026-09-12 修正）**：窗口边界**不等于**状态翻转点。
 * 一个边界是否翻转，取决于「边界两侧是否处于不同状态」：
 * - 相邻窗口 `[09:00-12:00, 12:00-18:00]` 在 12:00 处两侧都是 peak → **不是翻转点**；
 * - 跨午夜窗口 `22:00-02:00` 在次日 01:00 时，当前仍处于该窗口内，
 *   真正的翻转点是 **02:00**（窗口结束），而不是次日 22:00（下一次开始）。
 *
 * 因此这里不再枚举「边界」，而是**直接向后搜索第一个状态发生变化的最早墙上时刻**：
 * 以分钟为粒度推进候选点，用 `isPeakAt` 判定两侧状态，取第一个不同者。
 *
 * **DST 处理**：不按 `dayOffset * 1440` 累加（夏令时切换日只有 1380/1500 分钟），
 * 而是把墙上坐标解析为真实时间戳后再求差（见 `wallClockToTimestamp`）。
 */
function minutesUntilFlip(schedule: Schedule, now: Date, weekday: number, minutes: number): number {
  const windows = normalizedWindows(schedule)
  if (windows.length === 0) return Number.POSITIVE_INFINITY

  const currentState = isPeakAt(schedule, windows, weekday, minutes)

  // 只在「候选时刻」上判定状态变化即可——相邻候选之间的状态恒定。
  //
  // 候选一律以「距基准日 00:00 的绝对分钟数」表示，再拆成 (dayOffset, minuteOfDay)。
  // **不要**用窗口自己的 extraDay 去加天数：跨午夜窗口的 end 相对「窗口起点日」
  // 是 +1 天，但相对「基准日」可能仍是当天（当窗口起点日就是基准日时），
  // 直接相加会把翻转点整整推后一天（实测：周二 01:00 的倒计时被算成 1500min
  // 而非正确的 60min）。
  // 候选点同时记录「绝对分钟」与「用于判定状态的星期/当天分钟」。
  // 这两者**不能**由同一个数推出来：跨午夜窗口 22:00-02:00 的 end 绝对落点是
  // 次日 02:00，但判定该点状态时要问的是「窗口所属日（即前一天）是否 peakDay」，
  // 而 isPeakAt 内部已按「前一天溢出」规则处理，因此这里只需传入**实际落点**的
  // 星期与当天分钟即可（00:00 与 02:00 都在溢出段内，结果一致）。
  type WallPoint = { absolute: number; dayOffset: number; minuteOfDay: number }
  const points: WallPoint[] = []
  const pushAbs = (absolute: number): void => {
    if (absolute < 0) return
    points.push({
      absolute,
      dayOffset: Math.floor(absolute / 1440),
      minuteOfDay: absolute % 1440,
    })
  }
  // 遍历「窗口所属日」，把该日所有窗口的 start/end 以其绝对分钟加入候选。
  // 跨午夜窗口的 end 已归一化为 > 1440（如 22:00-02:00 → end=1560），
  // 加到 dayOffset*1440 上自然落到次日，无需额外 +1 天。
  for (let dayOffset = 0; dayOffset <= 9; dayOffset++) {
    pushAbs(dayOffset * 1440) // 每天 00:00：前一天的跨午夜段可能在此结束
    for (const w of windows) {
      // 窗口起点（当天）
      pushAbs(dayOffset * 1440 + w.start)
      // 窗口终点：跨午夜时 end > 1440，其「当天 02:00」形式同样要加入候选。
      // 例：22:00-02:00 且基准日即窗口所属日时，真正的翻转点是**当天** 02:00
      // （绝对 120），而 dayOffset*1440+1560 = 1560 只会得到次日 02:00。
      // 两者都要进候选，由 isPeakAt 判定哪个才是真正的状态变化点。
      pushAbs(dayOffset * 1440 + (w.end % 1440))
      pushAbs(dayOffset * 1440 + w.end)
    }
  }
  points.sort((a, b) => a.absolute - b.absolute)

  // 找到第一个「状态与当前不同」的候选时刻。
  for (const p of points) {
    // 未来性判定：候选的绝对分钟数须晚于「现在」（今天是 0 基准）。
    if (p.absolute <= minutes) continue
    const dayAt = (weekday + p.dayOffset) % 7
    const stateAfter = isPeakAt(schedule, windows, dayAt, p.minuteOfDay)
    if (stateAfter === currentState) continue

    const ts = wallClockToTimestamp(schedule.timeZone, now, p.dayOffset, p.minuteOfDay)
    if (ts === undefined) continue
    const deltaMs = ts - now.getTime()
    if (deltaMs > 0) return Math.round(deltaMs / 60000)
  }
  return Number.POSITIVE_INFINITY
}

/**
 * 判定「某天的第 minutes 分钟」是否处于峰时（窗口内），考虑跨午夜窗口。
 *
 * 语义（2026-09-12 修正）：状态必须**沿真实时间连续**——跨午夜窗口
 * `22:00-02:00` 在 00:00 处不应发生状态跳变（那只是日期翻页，不是窗口边界）。
 * 因此：
 * - 当天窗口：`start <= minutes < end`（end 已归一化，跨午夜时 > 1440）
 * - **前一天的溢出**：若前一天在 peakDays 且有跨午夜窗口，则其次日溢出段
 *   `[0, end - 1440)` 也属于峰时。
 *
 * @param schedule - 时段规则。
 * @param windows - 已归一化的窗口（end 跨午夜时 > 1440）。
 * @param weekday - 该天的星期。
 * @param minutes - 当天第几分钟。
 */
function isPeakAt(
  schedule: Schedule,
  windows: { start: number; end: number }[],
  weekday: number,
  minutes: number,
): boolean {
  // 前一天的跨午夜窗口溢出到今天的部分（今天 00:00 起）
  const prevDay = (weekday + 6) % 7
  if (isPeakDay(schedule, prevDay)) {
    for (const w of windows) {
      if (w.end > 1440 && minutes < w.end - 1440) return true
    }
  }
  // 今天自己的窗口
  if (isPeakDay(schedule, weekday)) {
    for (const w of windows) {
      if (minutes >= w.start && minutes < w.end) return true
    }
  }
  return false
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
  // 与 minutesUntilFlip 共用同一判定函数，保证「时段」与「倒计时」语义一致
  // （两者若各算各的，跨午夜窗口处会出现「说自己是 peak 却倒计时到明天」的矛盾）。
  const peak = isPeakAt(schedule, normalizedWindows(schedule), weekday, minutes)
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
