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
  }
  periods?: {
    peak?: RawPeriod
    offPeak?: RawPeriod
  }
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

/** "HH:mm" 是否为合法时刻。 */
function isClock(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value)
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

  const peak = raw.periods?.peak
  const offPeak = raw.periods?.offPeak
  if (typeof peak?.badge !== 'string' || typeof offPeak?.badge !== 'string') return undefined

  const profile: RateProfile = {
    id: raw.id,
    providerName: raw.provider,
    modelLabel: typeof raw.model === 'string' ? raw.model : '',
    schedule: {
      timeZone: schedule.timeZone,
      peakDays,
      peakWindows,
      ...(typeof schedule.offDayName === 'string' ? { offDayName: schedule.offDayName } : {}),
    },
    peakBadge: peak.badge,
    offPeakBadge: offPeak.badge,
    peakName: typeof peak.name === 'string' ? peak.name : 'Peak',
    offPeakName: typeof offPeak.name === 'string' ? offPeak.name : 'Off-peak',
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

  const profiles = catalog.profiles
    .map(parseProfile)
    .filter((p): p is RateProfile => p !== undefined)

  if (profiles.length === 0) return undefined

  return {
    schemaVersion: catalog.schemaVersion,
    ...(typeof catalog.updatedAt === 'string' ? { updatedAt: catalog.updatedAt } : {}),
    profiles,
  }
}
