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
  /**
   * 上游标注的**法定节假日**（`YYYY-MM-DD`，按本 schedule 的时区）。
   *
   * 语义（2026-09-30 补）：当天**全天谷价** —— 依据上游价目页
   * 「All other hours are off-peak, including weekends and Chinese public holidays **in full**」。
   * 数据源当前只在 4 个 DeepSeek 系 profile 上带此字段（`deepseek-v4` /
   * `alibaba-model-studio-deepseek-v4` / `bai-deepseek-v4` / `bai-deepseek-v4-pro`），
   * 且这 4 个的窗口都**不跨午夜**；跨午夜的交互仍按下述规则处理。
   */
  publicHolidayDates?: string[]
  /** 节假日的展示名（如 "Chinese public holiday"）；目前仅透传，UI 未消费（同 `offDayName`）。 */
  publicHolidayName?: string
  /**
   * 节假日所依据的**日历时区**（如 `deepseek-v4` 峰价按 `UTC`、节假日按 `Asia/Shanghai`）。
   *
   * 声明它是因为数据源明确带此字段；不消费会让节假日日界按 profile 时区错判
   * （当前数据窗口小时在两套解释下重合，故无实害，但边界小时会差 8 小时）。
   */
  publicHolidayTimeZone?: string
  /** 优先级高于常规峰谷的覆盖段（活动窗口等）。 */
  overrides?: ScheduleOverride[]
}

/**
 * 时段状态。`campaign` 是**第三态**：限时活动窗口（来自 profile 的
 * `schedule.overrides`，带日期区间），优先级高于常规峰谷。
 */
export type Period = 'peak' | 'offPeak' | 'campaign'

/** 带日期区间与星期过滤的时段覆盖（活动/促销窗口）。 */
export interface ScheduleOverride {
  /** 归一化后的三态：`peak` / `offPeak` / `campaign`（一切促销类 period 都落到 `campaign`）。 */
  period: Period
  /** 数据源里的**原始 period 名**（如 `promotion` / `campaign10`），仅用于展示与排查。 */
  periodName?: string
  /**
   * 该活动**自己的**倍率徽章（取自数据源 `periods[<periodName>].badge`）。
   *
   * 必须有：同一 profile 里可能有多个促销态（如 zai 的 `campaign` 与 `promotion`），
   * 各有各的倍率 —— 只用 profile 级的单一 `campaignBadge` 槽位会显示错。
   */
  badge?: string
  /** 该活动的显示名（取自 `periods[<periodName>].name`）。 */
  name?: string
  /** 该活动的补充说明（取自 `periods[<periodName>].detail`）。 */
  detail?: string
  /** 起止日期（`YYYY-MM-DD`，按 profile 自身时区，闭区间）；缺省表示不限日期。 */
  startDate?: string
  endDate?: string
  /** 0=周日 … 6=周六；空/缺省表示每天。 */
  days: number[]
  /** 生效窗口；全天生效写作 `{start:'00:00', end:'00:00'}`（`normalizedWindowsOf` 会展开为 1440）。 */
  windows: PeakWindow[]
}

export interface PeriodResult {
  period: Period
  /** 距下一个状态翻转点的分钟数；总是 > 0。 */
  minutesUntilSwitch: number
  /**
   * 翻转后的状态 —— 让调用方能回答「之后是变贵还是变便宜」。
   *
   * 单看 `minutesUntilSwitch` 只知道**何时**变，不知道**变成什么**：
   * `2× → 1×`（降价）与 `1× → 2×`（涨价）的倒计时数字没区别。
   * 无下一个翻转点（如永不切换的规则）时为 undefined。
   */
  nextPeriod?: Period
  /**
   * 当前生效的活动/促销的展示信息（仅在 `period === 'campaign'` 时有值）。
   *
   * 为什么不复用 profile 级的 `campaignBadge`：同一 profile 可有多个促销态
   * （如 zai 的 `campaign` 与 `promotion`），各有各的倍率 —— 必须给出**当前生效那条**
   * 自己的 badge/name，否则 UI 会显示另一个活动的倍率。
   */
  activePromo?: {
    periodName?: string
    badge?: string
    name?: string
    detail?: string
  }
  /**
   * 翻转点之后生效的活动信息（仅当那一刻确实落进另一条 override 时有值）。
   *
   * 与 `activePromo` 同理：倒计时说"多久之后变成什么倍率"，那个倍率也必须是**那一刻那条活动
   * 自己的**。否则两个促销态相邻时（如 zai 的 campaign 23:00-09:00 与 promotion 全天），
   * 倒计时会显示另一个活动的倍率。
   */
  nextActivePromo?: {
    periodName?: string
    badge?: string
    name?: string
    detail?: string
  }
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
function wallClock(
  now: Date,
  timeZone: string,
): { weekday: number; minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)

  let weekday = 0
  let hour = 0
  let minute = 0
  let y = ''
  let mo = ''
  let d = ''
  for (const p of parts) {
    if (p.type === 'weekday') {
      const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.value)
      if (idx >= 0) weekday = idx
    } else if (p.type === 'hour') {
      // hour12:false 在部分环境返回 "24" 表示午夜，归一化到 0。
      hour = Number(p.value) % 24
    } else if (p.type === 'minute') {
      minute = Number(p.value)
    } else if (p.type === 'year') {
      y = p.value
    } else if (p.type === 'month') {
      mo = p.value
    } else if (p.type === 'day') {
      d = p.value
    }
  }
  return { weekday, minutes: hour * 60 + minute, date: `${y}-${mo}-${d}` }
}

/**
 * 某个 override 此刻是否生效。
 *
 * 三个条件同时成立才算：① 当前日期在 `[startDate, endDate]` 闭区间内（按
 * profile 时区）；② 当天星期在 `days` 内（空表示每天）；③ 当前时间落在任一
 * `windows` 内（start 含、end 不含）。
 *
 * @param override - 覆盖段定义。
 * @param weekday - 当前星期（0=周日）。
 * @param minutes - 当天第几分钟。
 * @param date - 当前日期（`YYYY-MM-DD`，profile 时区）。
 */
function overrideActive(
  override: ScheduleOverride,
  weekday: number,
  minutes: number,
  date: string,
  prevWeekday: number,
  prevDate: string,
): boolean {
  const inRange = (d: string): boolean => {
    // 日期区间为**闭区间**（字符串比较对 YYYY-MM-DD 有效）
    if (override.startDate !== undefined && d < override.startDate) return false
    if (override.endDate !== undefined && d > override.endDate) return false
    return true
  }
  const dayOk = (w: number): boolean =>
    override.days.length === 0 || override.days.includes(w)

  // ① 当天：窗口的**晚段**（含整个非跨午夜窗口）
  if (inRange(date) && dayOk(weekday)) {
    for (const w of override.windows) {
      const start = parseMinutes(w.start)
      const end = parseMinutes(w.end)
      if (Number.isNaN(start) || Number.isNaN(end)) continue
      if (end > start) {
        if (minutes >= start && minutes < end) return true
      } else if (minutes >= start) {
        // 跨午夜窗口的当天部分：`start` 到午夜
        return true
      }
    }
  }

  // ② 前一天的**跨午夜溢出段**（`[0, end)`）—— 必须归属**开始日**，
  //    与常规窗口的 `isPeakAt` 语义保持一致。
  //
  //    2026-09-12 修正（独立 review 指出）：原实现把凌晨段按**落点日**过滤
  //    days/日期区间，导致两处偏差 ——
  //    (a) `days` 为子集时，跨午夜活动的后半段静默失效；
  //    (b) 真实数据（23:00-09:00，09-03~09-20）实际生效成
  //        09-03 00:00 ~ 09-21 00:00，两端各偏一天。
  if (inRange(prevDate) && dayOk(prevWeekday)) {
    for (const w of override.windows) {
      const start = parseMinutes(w.start)
      const end = parseMinutes(w.end)
      if (Number.isNaN(start) || Number.isNaN(end)) continue
      // 仅跨午夜窗口有溢出段
      if (end <= start && minutes < end) return true
    }
  }
  return false
}

/** 该星期是否属于峰时天。 */
function isPeakDay(schedule: Schedule, weekday: number): boolean {
  return schedule.peakDays.includes(weekday)
}

/**
 * 该日期（`YYYY-MM-DD`，profile 自身时区）是否为上游标注的法定节假日。
 *
 * 节假日**全天谷价**（上游明示 "in full"）→ 常规星期/窗口判定一律作废。
 */
function isPublicHoliday(schedule: Schedule, date: string): boolean {
  return (schedule.publicHolidayDates ?? []).includes(date)
}

/**
 * 求某时刻对应的**节假日日历日**。
 *
 * 数据源里节假日有自己的时区（`publicHolidayTimeZone`，如 `deepseek-v4` 峰价按 `UTC`
 * 而节假日按 `Asia/Shanghai`）。峰价窗口与节假日日界分属两个时区时，必须各自按本时区
 * 取"当天"，否则节假日边界会整体偏移（当前数据巧合无差 —— 窗口小时在两套解释下重合，
 * 但边界小时会差 8 小时，倒计时跟着错）。
 *
 * @param schedule - 时段规则。
 * @param now - 基准时刻。
 * @param localDate - 已算好的 profile 时区日期（无节假日或未声明时区时直接沿用）。
 */
function holidayDateFor(schedule: Schedule, now: Date, localDate: string): string {
  const tz = schedule.publicHolidayTimeZone
  if (tz === undefined || (schedule.publicHolidayDates?.length ?? 0) === 0) return localDate
  try {
    return wallClock(now, tz).date
  } catch {
    return localDate
  }
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
function minutesUntilFlip(
  schedule: Schedule,
  now: Date,
  weekday: number,
  minutes: number,
): { minutes: number; period: Period; override?: ScheduleOverride } | undefined {
  const windows = normalizedWindows(schedule)
  if (windows.length === 0) return undefined

  const baseDate = wallClock(now, schedule.timeZone).date
  const currentState = stateAt(
    schedule,
    windows,
    weekday,
    minutes,
    baseDate,
    holidayDateFor(schedule, now, baseDate),
  )

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
  // override（活动）窗口的边界同样是翻转点，必须一并作为候选。
  const overrideWindows = (schedule.overrides ?? []).flatMap((o) =>
    normalizedWindowsOf(o.windows),
  )
  for (let dayOffset = 0; dayOffset <= 9; dayOffset++) {
    pushAbs(dayOffset * 1440) // 每天 00:00：前一天的跨午夜段 / 活动日期区间可能在此结束
    for (const w of [...windows, ...overrideWindows]) {
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
    const candidateDate = addDays(baseDate, p.dayOffset)
    // **先解析时间戳再判状态**：节假日日界可能属于另一个时区（`publicHolidayTimeZone`），
    // 必须按候选时刻的真实时间戳换算，否则边界小时会偏移（见 holidayDateFor）。
    const ts = wallClockToTimestamp(schedule.timeZone, now, p.dayOffset, p.minuteOfDay)
    if (ts === undefined) continue
    const stateAfter = stateAt(
      schedule,
      windows,
      dayAt,
      p.minuteOfDay,
      candidateDate,
      holidayDateFor(schedule, new Date(ts), candidateDate),
    )
    if (stateAfter === currentState) continue

    const deltaMs = ts - now.getTime()
    if (deltaMs > 0) {
      // 一并给出翻转点上生效的 override（若翻过去也是促销态）—— 让倒计时能显示**那个**活动的
      // 倍率，而不是 profile 级回落槽位里另一个活动的。
      const flipOverride = activeOverrideAt(schedule, dayAt, p.minuteOfDay, candidateDate)
      return {
        minutes: Math.round(deltaMs / 60000),
        period: stateAfter,
        ...(flipOverride === undefined ? {} : { override: flipOverride }),
      }
    }
  }
  return undefined
}

/** 在 `YYYY-MM-DD` 上加天数（按 UTC 日历，避免本地时区干扰）。 */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
  t.setUTCDate(t.getUTCDate() + days)
  const yy = t.getUTCFullYear()
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(t.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** 把任意窗口数组归一化（end 跨午夜时 +1440，按 start 升序）。 */
function normalizedWindowsOf(list: PeakWindow[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const w of list) {
    const start = parseMinutes(w.start)
    const end = parseMinutes(w.end)
    if (Number.isNaN(start) || Number.isNaN(end)) continue
    out.push({ start, end: end > start ? end : end + 1440 })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * 判定某时刻的**完整时段状态**（含活动覆盖与法定节假日）。
 *
 * 优先级：**override（活动/促销） > 法定节假日 > 常规峰谷**。
 *
 * @param schedule - 时段规则。
 * @param windows - 已归一化的常规窗口。
 * @param weekday - 当天星期。
 * @param minutes - 当天第几分钟。
 * @param date - 当天日期（profile 时区，`YYYY-MM-DD`）。
 * @param holidayDate - 该时刻对应的节假日日历日（见 `holidayDateFor`；缺省同 `date`）。
 */
function stateAt(
  schedule: Schedule,
  windows: { start: number; end: number }[],
  weekday: number,
  minutes: number,
  date: string,
  /**
   * 该时刻对应的**节假日日历日**（可能来自另一个时区，见 `holidayDateFor`）。
   * 缺省等于 `date`（无 `publicHolidayTimeZone` 时的退化行为）。
   */
  holidayDate: string = date,
): Period {
  const override = activeOverrideAt(schedule, weekday, minutes, date)
  if (override !== undefined) return override.period
  // 法定节假日：**全天谷价**（按节假日自己的日历时区判定）。优先级低于显式 override
  // （override 是同一份数据源里日期/窗口级更具体的规则），高于常规星期/窗口判定。
  // 注意：这里先判 holiday 再算 isPeakAt，故「非节假日傍晚起的跨午夜窗口溢出到节假日凌晨」
  // 会被本条直接拦成谷价（正确：节假日整天都便宜）。
  if (isPublicHoliday(schedule, holidayDate)) return 'offPeak'
  // 反过来：前一天是节假日 → 它的跨午夜窗口整体作废，不得溢出到今日。
  return isPeakAt(
    schedule,
    windows,
    weekday,
    minutes,
    isPublicHoliday(schedule, addDays(holidayDate, -1)),
  )
    ? 'peak'
    : 'offPeak'
}

/**
 * 取某时刻**生效的那条 override**（无则 undefined）。
 *
 * 抽成独立函数是为了让三处共用同一判定：`stateAt`（判态）、`currentPeriod`（当前活动的
 * badge/name）、`minutesUntilFlip`（**下一个**活动的 badge）—— 三处各写一遍必然漂移。
 */
function activeOverrideAt(
  schedule: Schedule,
  weekday: number,
  minutes: number,
  date: string,
): ScheduleOverride | undefined {
  const prevWeekday = (weekday + 6) % 7
  const prevDate = addDays(date, -1)
  return (schedule.overrides ?? []).find((o) =>
    overrideActive(o, weekday, minutes, date, prevWeekday, prevDate),
  )
}

/** 把一条 override 的展示信息转成 `PeriodResult.activePromo` 形态。 */
function promoInfoOf(o: ScheduleOverride | undefined): PeriodResult['activePromo'] {
  if (o === undefined) return undefined
  return {
    ...(o.periodName === undefined ? {} : { periodName: o.periodName }),
    ...(o.badge === undefined ? {} : { badge: o.badge }),
    ...(o.name === undefined ? {} : { name: o.name }),
    ...(o.detail === undefined ? {} : { detail: o.detail }),
  }
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
  /**
   * 前一天是否为法定节假日。为 true 时**跳过「前一天跨午夜窗口的溢出」** ——
   * 节假日当天全天谷价，其窗口（含跨午夜那部分）整体作废，不能靠溢出把次日照样判成峰时。
   */
  prevDayIsHoliday = false,
): boolean {
  // 前一天的跨午夜窗口溢出到今天的部分（今天 00:00 起）
  const prevDay = (weekday + 6) % 7
  if (isPeakDay(schedule, prevDay) && !prevDayIsHoliday) {
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
  const { weekday, minutes, date } = wallClock(now, schedule.timeZone)
  const holidayDate = holidayDateFor(schedule, now, date)
  // 与 minutesUntilFlip 共用同一判定函数，保证「时段」与「倒计时」语义一致
  // （两者若各算各的，跨午夜窗口处会出现「说自己是 peak 却倒计时到明天」的矛盾）。
  const period = stateAt(schedule, normalizedWindows(schedule), weekday, minutes, date, holidayDate)
  const flip = minutesUntilFlip(schedule, now, weekday, minutes)

  // 促销态：把**当前 / 下一个生效的那条 override 自己的** period 名与 badge/name 一并外露，
  // 让 UI 显示该活动自己的倍率（而非 profile 级那个单一回落槽位 —— 同一 profile 可有多个
  // 促销态且倍率不同，只靠它必然对不上其中之一）。
  const activePromo = period === 'campaign' ? promoInfoOf(activeOverrideAt(schedule, weekday, minutes, date)) : undefined
  // 下一个状态若也是促销态，同样要给它自己的 badge（否则倒计时会显示另一个活动的倍率）
  const nextActivePromo = promoInfoOf(flip?.override)

  return {
    period,
    minutesUntilSwitch: flip?.minutes ?? Number.POSITIVE_INFINITY,
    ...(flip === undefined ? {} : { nextPeriod: flip.period }),
    ...(activePromo === undefined ? {} : { activePromo }),
    ...(nextActivePromo === undefined ? {} : { nextActivePromo }),
  }
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
