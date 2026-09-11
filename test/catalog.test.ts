/**
 * catalog.ts 单测 —— 解析、校验与降级行为（spec §8）。
 */
import { describe, expect, it } from 'vitest'
import { parseCatalog, SUPPORTED_SCHEMA_VERSION } from '../src/catalog.js'

/** 一份最小合法数据源。 */
function minimal(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    profiles: [
      {
        id: 'p1',
        provider: 'Vendor',
        model: 'Model A',
        schedule: {
          timeZone: 'UTC',
          peakDays: [1, 2, 3, 4, 5],
          peakWindows: [{ start: '12:00', end: '18:00' }],
        },
        periods: { peak: { name: 'Peak', badge: '2×' }, offPeak: { name: 'Off', badge: '1×' } },
      },
    ],
    ...overrides,
  }
}

describe('parseCatalog — 合法输入', () => {
  it('解析出归一化 profile', () => {
    const out = parseCatalog(minimal())
    expect(out).toBeDefined()
    expect(out?.profiles).toHaveLength(1)
    const p = out?.profiles[0]
    expect(p?.id).toBe('p1')
    expect(p?.providerName).toBe('Vendor')
    expect(p?.peakBadge).toBe('2×')
    expect(p?.offPeakBadge).toBe('1×')
    expect(p?.schedule.timeZone).toBe('UTC')
  })

  it('保留可选字段', () => {
    const raw = minimal({ updatedAt: '2026-09-11' })
    ;(raw.profiles[0] as Record<string, unknown>).source = 'https://example.com'
    ;(raw.profiles[0] as Record<string, unknown>).verifiedAt = '2026-09-10'
    const out = parseCatalog(raw)
    expect(out?.updatedAt).toBe('2026-09-11')
    expect(out?.profiles[0]?.source).toBe('https://example.com')
    expect(out?.profiles[0]?.verifiedAt).toBe('2026-09-10')
  })
})

describe('parseCatalog — 校验失败一律返回 undefined（调用方沿用上一份）', () => {
  it('schemaVersion 不支持', () => {
    expect(parseCatalog(minimal({ schemaVersion: 99 }))).toBeUndefined()
    expect(parseCatalog(minimal({ schemaVersion: undefined }))).toBeUndefined()
  })

  it('profiles 非数组或为空', () => {
    expect(parseCatalog(minimal({ profiles: 'nope' }))).toBeUndefined()
    expect(parseCatalog(minimal({ profiles: [] }))).toBeUndefined()
  })

  it('全部 profile 都不合法时整体丢弃', () => {
    expect(parseCatalog(minimal({ profiles: [{ id: 'x' }] }))).toBeUndefined()
  })

  it('非对象输入', () => {
    expect(parseCatalog(null)).toBeUndefined()
    expect(parseCatalog('str')).toBeUndefined()
    expect(parseCatalog(undefined)).toBeUndefined()
  })
})

describe('parseCatalog — 逐条丢弃坏 profile，保留好 profile', () => {
  it('缺 provider 的条目被丢弃', () => {
    const raw = minimal()
    raw.profiles.push({ id: 'bad', schedule: {} } as never)
    const out = parseCatalog(raw)
    expect(out?.profiles).toHaveLength(1)
    expect(out?.profiles[0]?.id).toBe('p1')
  })

  it('时区非法（Intl 无法解析）的条目被丢弃', () => {
    const raw = minimal()
    ;(raw.profiles[0] as Record<string, unknown>).schedule = {
      timeZone: 'Not/AZone',
      peakDays: [1],
      peakWindows: [{ start: '12:00', end: '18:00' }],
    }
    expect(parseCatalog(raw)).toBeUndefined()
  })

  it('无峰时天或无窗口的条目被丢弃（永远无峰时，对用户无意义）', () => {
    const noDays = minimal()
    ;(noDays.profiles[0] as Record<string, unknown>).schedule = {
      timeZone: 'UTC',
      peakDays: [],
      peakWindows: [{ start: '12:00', end: '18:00' }],
    }
    expect(parseCatalog(noDays)).toBeUndefined()

    const noWindows = minimal()
    ;(noWindows.profiles[0] as Record<string, unknown>).schedule = {
      timeZone: 'UTC',
      peakDays: [1],
      peakWindows: [],
    }
    expect(parseCatalog(noWindows)).toBeUndefined()
  })

  it('缺 badge 的条目被丢弃', () => {
    const raw = minimal()
    ;(raw.profiles[0] as Record<string, unknown>).periods = { peak: { name: 'P' } }
    expect(parseCatalog(raw)).toBeUndefined()
  })

  it('非法时刻字符串被过滤，剩余窗口仍可用', () => {
    const raw = minimal()
    ;(raw.profiles[0] as Record<string, unknown>).schedule = {
      timeZone: 'UTC',
      peakDays: [1],
      peakWindows: [{ start: 'oops', end: '18:00' }, { start: '12:00', end: '18:00' }],
    }
    const out = parseCatalog(raw)
    expect(out?.profiles[0]?.schedule.peakWindows).toHaveLength(1)
  })

  it('非法 peakDays 值被过滤', () => {
    const raw = minimal()
    ;(raw.profiles[0] as Record<string, unknown>).schedule = {
      timeZone: 'UTC',
      peakDays: [1, 9, -1, 5],
      peakWindows: [{ start: '12:00', end: '18:00' }],
    }
    const out = parseCatalog(raw)
    expect(out?.profiles[0]?.schedule.peakDays).toEqual([1, 5])
  })
})

describe('★ 回归：校验规则必须与 schedule 层一致', () => {
  it('拒绝 "24:00"（曾放行但被 schedule 层静默丢弃 → 永久谷时无倒计时）', () => {
    const raw = minimal()
    ;(raw.profiles[0] as Record<string, unknown>).schedule = {
      timeZone: 'UTC',
      peakDays: [1],
      peakWindows: [{ start: '08:00', end: '24:00' }],
    }
    // 唯一窗口非法 → 该 profile 被丢弃
    expect(parseCatalog(raw)).toBeUndefined()
  })

  it('拒绝 start === end 的零长度窗口', () => {
    const raw = minimal()
    ;(raw.profiles[0] as Record<string, unknown>).schedule = {
      timeZone: 'UTC',
      peakDays: [1],
      peakWindows: [{ start: '09:00', end: '09:00' }],
    }
    expect(parseCatalog(raw)).toBeUndefined()
  })

  it('接受合法边界 00:00 与 23:59', () => {
    const raw = minimal()
    ;(raw.profiles[0] as Record<string, unknown>).schedule = {
      timeZone: 'UTC',
      peakDays: [1],
      peakWindows: [{ start: '00:00', end: '23:59' }],
    }
    expect(parseCatalog(raw)?.profiles[0]?.schedule.peakWindows).toEqual([
      { start: '00:00', end: '23:59' },
    ])
  })

  it('拒绝非法分钟（如 09:60）', () => {
    const raw = minimal()
    ;(raw.profiles[0] as Record<string, unknown>).schedule = {
      timeZone: 'UTC',
      peakDays: [1],
      peakWindows: [{ start: '09:60', end: '10:00' }],
    }
    expect(parseCatalog(raw)).toBeUndefined()
  })

  it('重复 profile id 去重，保留首个', () => {
    const raw = minimal()
    raw.profiles.push({ ...raw.profiles[0], model: 'Second' } as never)
    const out = parseCatalog(raw)
    expect(out?.profiles).toHaveLength(1)
    expect(out?.profiles[0]?.modelLabel).toBe('Model A')
  })
})
