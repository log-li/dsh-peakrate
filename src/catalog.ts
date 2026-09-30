/**
 * 数据源解析与校验 —— 纯函数，不碰网络与文件系统。
 *
 * 数据源：https://offpeakclock.com/pricing.json（schemaVersion 1）。
 * 校验失败时返回 undefined，由调用方沿用上一份可用数据（spec §8）。
 */
import type { RateProfile } from './matching.js'

/** 本实现支持的 schemaVersion。 */
export const SUPPORTED_SCHEMA_VERSION = 1

interface RawPeriod {
  name?: string
  badge?: string
  detail?: string
  tone?: string
}

interface RawOverride {
  period?: string
  startDate?: string
  endDate?: string
  /**
   * 时刻粒度的起止（ISO 带时区偏移，如 `2026-09-25T15:00:00+08:00`）。
   *
   * **当前未消费** —— override 的生效区间只按 `startDate`/`endDate`（日粒度、字符串比较）。
   * 声明出来是为了不再"静默丢弃未知键"：见到这两个字段就跳过该条 override，
   * 并由 `test/catalog.test.ts` 的形态守卫盯着这个已知未消费清单（spec §11）。
   */
  startAt?: string
  endAt?: string
  days?: number[]
  windows?: {
    start?: string
    end?: string
    /** `true` 表示**全天生效**（数据源用 `start:'00:00', end:'00:00'` 搭配此标记表达）。 */
    allDay?: boolean
  }[]
}

interface RawProfile {
  id?: string
  provider?: string
  model?: string
  schedule?: {
    timeZone?: string
    peakDays?: number[]
    peakWindows?: { start?: string; end?: string }[]
    offDayName?: string
    /**
     * 上游标注的法定节假日日期。**必须声明**：`parseProfile` 是显式挑字段构造
     * `RateProfile` 的，未声明的字段会被静默丢弃 —— 2026-09-30 前该字段就是这样
     * 丢了整整两周半，导致节假日的**工作日**被误标峰价。
     */
    publicHolidayDates?: unknown
    publicHolidayName?: unknown
    /**
     * 节假日所依据的日历时区（如 `deepseek-v4` 的 tz=UTC 但节假日按 `Asia/Shanghai` 判）。
     *
     * **已声明并消费**（`parseProfile` 会带进 `RateProfile.schedule`）：2026-09-30 随快照
     * 刷新发现该键存在却未被声明 —— 与 `publicHolidayDates` 当初被丢同一形态。
     */
    publicHolidayTimeZone?: unknown
    overrides?: RawOverride[]
  }
  /** 各时段态的定义。键名不止 `peak`/`offPeak`/`campaign` —— 促销类名字（promotion 等）也在此。 */
  periods?: Record<string, RawPeriod | undefined>
  source?: string
  verifiedAt?: string
}

export interface RawCatalog {
  schemaVersion?: number
  updatedAt?: string
  defaultProfile?: string
  profiles?: RawProfile[]
}

export interface ParsedCatalog {
  schemaVersion: number
  updatedAt?: string
  profiles: RateProfile[]
}

/**
 * "HH:mm" 是否为合法时刻。
 *
 * **必须与 `schedule.ts` 的 `parseMinutes` 用同一套边界（0-23 时 / 0-59 分）**：
 * 曾出现 `isClock` 放行 `"24:00"` 而 `parseMinutes` 判为 NaN 的错配——窗口被
 * 静默丢弃，profile 永久显示谷时且没有倒计时，用户完全看不出异常。
 * 时刻的合法性只在这一处定义，避免两套规则漂移。
 */
function isClock(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (m === null) return false
  return Number(m[1]) <= 23 && Number(m[2]) <= 59
}

/**
 * `YYYY-MM-DD` 是否为**真实存在的日历日**（`2026-02-30` / `2026-13-01` 一律否决）。
 *
 * 与 `isClock` 同一纪律：合法性只在这一处定义。节假日日期若被写错（如多一位、
 * 月份越界），静默收下会让「当天全天谷价」这条规则在某天悄悄失效。
 */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (m === null) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false
  const t = new Date(Date.UTC(y, mo - 1, d))
  // 往返一致才说明日期真实存在（Date.UTC 会把越界日期顺延，如 02-30 → 03-02）
  return (
    t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
  )
}

/** 把单个原始 profile 归一化为 RateProfile；字段不全则返回 undefined。 */
function parseProfile(raw: RawProfile): RateProfile | undefined {
  if (typeof raw.id !== 'string' || raw.id === '') return undefined
  if (typeof raw.provider !== 'string' || raw.provider === '') return undefined

  const schedule = raw.schedule
  if (schedule === undefined) return undefined
  if (typeof schedule.timeZone !== 'string' || schedule.timeZone === '') return undefined

  const peakDays = Array.isArray(schedule.peakDays)
    ? schedule.peakDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : []
  const peakWindows = Array.isArray(schedule.peakWindows)
    ? schedule.peakWindows
        .filter((w) => isClock(w?.start) && isClock(w?.end))
        // 零长度窗口（start === end）语义不明（是全天峰时？还是空？），
        // 且会让 schedule 层产生「全天峰时 + 次日溢出」的意外结果，直接丢弃。
        .filter((w) => w.start !== w.end)
        .map((w) => ({ start: w.start as string, end: w.end as string }))
    : []

  // 无峰时天或无窗口 → 该 profile 永远不会有峰时，对用户无意义，丢弃。
  if (peakDays.length === 0 || peakWindows.length === 0) return undefined

  // 时区必须能被 Intl 解析，否则计算会抛错。
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone })
  } catch {
    return undefined
  }

  // 活动/促销覆盖段。
  //
  // 2026-09-30（随内置快照刷新）发现数据源的形态比初版丰富得多，且**已映射的 zai 系
  // 当场受影响**：`promotion`（全天 0.5×）被丢弃 → 工作日 14:00-18:00 误报 peak 1×。
  // 三条形态差异：
  //   - `period` 名不止 `campaign`：还有 `promotion` / `campaign10` / `campaign30` / …，
  //     **每个名字在 `periods` 里有自己的一套 badge/name/detail**。故判定改为
  //     **数据驱动**：`periods` 里存在同名键就接受；状态统一落到三态里的 `campaign`，
  //     而倍率/名称取该 period 自己的（`ScheduleOverride.badge`/`name`，供 UI 直接展示）。
  //   - 窗口可写成 `{start:'00:00', end:'00:00', allDay:true}` 表示**全天生效**。
  //     常规 `peakWindows` 仍丢弃零长度窗口（其在跨午夜分支里会变成全天，属误输入）；
  //     override 的 `allDay` 是**显式声明**，保留并交给 schedule 层按全天展开
  //     （`normalizedWindowsOf` 把 `end <= start` 视作 +1440）。
  //   - `startAt`/`endAt`（ISO 带时刻）**尚未消费** → 显式跳过，并由形态守卫盯着（spec §11）。
  const periodsRaw = raw.periods ?? {}
  const overrides: NonNullable<RateProfile['schedule']['overrides']> = []
  for (const o of schedule.overrides ?? []) {
    const periodName = typeof o?.period === 'string' ? o.period : undefined
    if (periodName === undefined) continue
    // 用 override 表达 peak/offPeak 没有意义（等同无覆盖，且会破坏「窗口外即谷价」语义）
    if (periodName === 'peak' || periodName === 'offPeak') continue
    const periodDef = periodsRaw[periodName]
    // `== null` 而非 `=== undefined`：JSON 里写成 `null` 时 `periodDef.badge` 会抛 TypeError，
    // 而 parseCatalog 没有 try/catch → 一个坏 profile 会让**整份**解析抛错而不是降级为 undefined。
    if (periodDef == null) continue // 未知 period 名 → 跳过（形态守卫会盯住）
    if (o.startAt !== undefined || o.endAt !== undefined) continue // 时刻粒度未消费（spec §11）

    const wins = Array.isArray(o.windows)
      ? o.windows
          .filter((w) => isClock(w?.start) && isClock(w?.end))
          // 零长度窗口只在**显式 allDay** 时才保留（见上）
          .filter((w) => w.allDay === true || w.start !== w.end)
          .map((w) => ({ start: w.start as string, end: w.end as string }))
      : []
    if (wins.length === 0) continue

    // 日期必须是**真实存在的日历日**：schedule 层用字符串比较判区间，
    // 形状不对（`2026/09/03`、`2026-9-3`）或不存在的日子（`2026-02-30`）都会静默错判。
    const startDate = isIsoDate(o.startDate) ? o.startDate : undefined
    const endDate = isIsoDate(o.endDate) ? o.endDate : undefined
    overrides.push({
      period: 'campaign',
      periodName,
      ...(typeof periodDef.badge === 'string' ? { badge: periodDef.badge } : {}),
      ...(typeof periodDef.name === 'string' ? { name: periodDef.name } : {}),
      ...(typeof periodDef.detail === 'string' ? { detail: periodDef.detail } : {}),
      ...(startDate === undefined ? {} : { startDate }),
      ...(endDate === undefined ? {} : { endDate }),
      days: Array.isArray(o.days)
        ? o.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [],
      windows: wins,
    })
  }

  const peak = raw.periods?.peak
  const offPeak = raw.periods?.offPeak
  if (typeof peak?.badge !== 'string' || typeof offPeak?.badge !== 'string') return undefined

  // 法定节假日日期：逐条校验为**真实日历日**，去重后按字典序（等价时间序）。
  // 空数组不写入 —— 上游只在 4 个 DeepSeek 系 profile 上带此字段，其余保持对象最小。
  const holidayDates = Array.isArray(schedule.publicHolidayDates)
    ? [...new Set(schedule.publicHolidayDates.filter(isIsoDate))].sort()
    : []

  const profile: RateProfile = {
    id: raw.id,
    providerName: raw.provider,
    modelLabel: typeof raw.model === 'string' ? raw.model : '',
    schedule: {
      timeZone: schedule.timeZone,
      peakDays,
      peakWindows,
      ...(typeof schedule.offDayName === 'string' ? { offDayName: schedule.offDayName } : {}),
      ...(holidayDates.length === 0 ? {} : { publicHolidayDates: holidayDates }),
      ...(holidayDates.length > 0 && typeof schedule.publicHolidayName === 'string'
        ? { publicHolidayName: schedule.publicHolidayName }
        : {}),
      // 节假日所依据的日历时区（如 deepseek-v4：峰价按 UTC、节假日按 Asia/Shanghai）。
      // 必须带出来，否则「节假日日界」会按 profile 时区错判（当前数据巧合无差，见 spec §11）。
      ...(holidayDates.length > 0 && typeof schedule.publicHolidayTimeZone === 'string'
        ? { publicHolidayTimeZone: schedule.publicHolidayTimeZone }
        : {}),
      ...(overrides.length === 0 ? {} : { overrides }),
    },
    peakBadge: peak.badge,
    offPeakBadge: offPeak.badge,
    peakName: typeof peak.name === 'string' ? peak.name : 'Peak',
    offPeakName: typeof offPeak.name === 'string' ? offPeak.name : 'Off-peak',
  }
  // profile 级活动态槽位（初版只有这一个槽）。**当前生效 override 自己的 badge/name 优先**
  // （见 `ScheduleOverride.badge`），这里只作回落：取 `periods.campaign`；数据源没给
  // `campaign` 时（如 zai 只有 `promotion`）取第一个带 badge 的促销 period —— 数据驱动，不写死名字。
  if (overrides.length > 0) {
    const campaignDef = raw.periods?.campaign
    const useCampaignDef = typeof campaignDef?.badge === 'string'
    const first = overrides.find((o) => o.badge !== undefined)
    const badge = useCampaignDef ? campaignDef?.badge : first?.badge
    if (badge !== undefined) {
      profile.campaignBadge = badge
      profile.campaignName =
        (useCampaignDef ? campaignDef?.name : first?.name) ?? 'Campaign'
      const detail = useCampaignDef ? campaignDef?.detail : first?.detail
      if (typeof detail === 'string') profile.campaignDetail = detail
    }
  }
  if (typeof raw.source === 'string') profile.source = raw.source
  if (typeof raw.verifiedAt === 'string') profile.verifiedAt = raw.verifiedAt
  return profile
}

/**
 * 解析并校验整份数据源。
 *
 * @param raw - 已解析的 JSON 对象（来自内置快照、本地缓存或远端）。
 * @returns 校验通过的目录；schemaVersion 不支持或 profiles 为空时返回 undefined。
 */
export function parseCatalog(raw: unknown): ParsedCatalog | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const catalog = raw as RawCatalog

  if (catalog.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return undefined
  if (!Array.isArray(catalog.profiles)) return undefined

  const parsed = catalog.profiles
    .map(parseProfile)
    .filter((p): p is RateProfile => p !== undefined)

  // 按 id 去重，保留**首次出现**的条目。
  // `matchProfile` 用 `Array.find` 取第一个匹配，重复 id 会让后出现的条目
  // 永远无法命中（静默失效）；这里显式去重，行为可预期。
  const byId = new Map<string, RateProfile>()
  for (const p of parsed) if (!byId.has(p.id)) byId.set(p.id, p)
  const profiles = [...byId.values()]

  if (profiles.length === 0) return undefined

  return {
    schemaVersion: catalog.schemaVersion,
    ...(typeof catalog.updatedAt === 'string' ? { updatedAt: catalog.updatedAt } : {}),
    profiles,
  }
}
