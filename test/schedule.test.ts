/**
 * schedule.ts 单测 —— 纯函数，不依赖 DSH 运行时。
 *
 * 覆盖 spec §10 要求的五类边界 + UTC / Asia/Shanghai 双时区判定。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCatalog } from '../src/catalog.js'
import { currentPeriod, formatCountdown, type Schedule } from '../src/schedule.js'

/** 数据源里的 ollama-deepseek-v4：UTC 周一–五 12:00-18:00。 */
const OLLAMA: Schedule = {
  timeZone: 'UTC',
  peakDays: [1, 2, 3, 4, 5],
  peakWindows: [{ start: '12:00', end: '18:00' }],
  offDayName: 'Weekend',
}

/** 数据源里的 deepseek-v4：UTC 周一–五 01:00-04:00 + 06:00-10:00。 */
const DEEPSEEK: Schedule = {
  timeZone: 'UTC',
  peakDays: [1, 2, 3, 4, 5],
  peakWindows: [
    { start: '01:00', end: '04:00' },
    { start: '06:00', end: '10:00' },
  ],
}

/** 数据源里的 xiaomi-mimo-v2-5-token-plan：北京时每天 08:00-00:00。 */
const XIAOMI: Schedule = {
  timeZone: 'Asia/Shanghai',
  peakDays: [0, 1, 2, 3, 4, 5, 6],
  peakWindows: [{ start: '08:00', end: '00:00' }],
}

/** 构造一个 UTC 时刻，便于按 UTC 直读。 */
const utc = (iso: string) => new Date(iso)

describe('currentPeriod — 峰时窗口内', () => {
  it('窗口正中判为 peak', () => {
    // 2026-09-14 是周一
    const r = currentPeriod(OLLAMA, utc('2026-09-14T15:00:00Z'))
    expect(r.period).toBe('peak')
    expect(r.minutesUntilSwitch).toBe(180) // 到 18:00
  })

  it('窗口起点含、终点不含', () => {
    expect(currentPeriod(OLLAMA, utc('2026-09-14T12:00:00Z')).period).toBe('peak')
    expect(currentPeriod(OLLAMA, utc('2026-09-14T18:00:00Z')).period).toBe('offPeak')
  })
})

describe('currentPeriod — 窗口间隙', () => {
  it('DeepSeek 两窗口之间判为 offPeak，并指向下一窗口', () => {
    // 04:30 处于 01:00-04:00 与 06:00-10:00 之间
    const r = currentPeriod(DEEPSEEK, utc('2026-09-14T04:30:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.minutesUntilSwitch).toBe(90) // 到 06:00
  })

  it('第一窗口结束后指向第二窗口而非次日', () => {
    const r = currentPeriod(DEEPSEEK, utc('2026-09-14T05:00:00Z'))
    expect(r.minutesUntilSwitch).toBe(60)
  })
})

describe('currentPeriod — 周末全天谷', () => {
  it('周六判为 offPeak，倒计时指向周一首个窗口', () => {
    // 2026-09-19 是周六
    const r = currentPeriod(OLLAMA, utc('2026-09-19T12:00:00Z'))
    expect(r.period).toBe('offPeak')
    // 周六 12:00 → 周一 12:00 = 48h
    expect(r.minutesUntilSwitch).toBe(48 * 60)
  })

  it('周日判为 offPeak，倒计时指向周一', () => {
    // 2026-09-20 是周日
    const r = currentPeriod(OLLAMA, utc('2026-09-20T23:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.minutesUntilSwitch).toBe(13 * 60) // 到周一 12:00
  })
})

describe('currentPeriod — 周五末段跨周末', () => {
  it('周五窗口内判为 peak，倒计时指向本窗口结束', () => {
    // 2026-09-18 是周五
    const r = currentPeriod(OLLAMA, utc('2026-09-18T17:00:00Z'))
    expect(r.period).toBe('peak')
    expect(r.minutesUntilSwitch).toBe(60) // 到 18:00
  })

  it('周五窗口结束后倒计时跨周末指向周一', () => {
    // 周五 18:00 谷时开始 → 下周一 12:00 才回峰时 = 66h
    const r = currentPeriod(OLLAMA, utc('2026-09-18T18:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.minutesUntilSwitch).toBe(66 * 60)
  })

  it('周五深夜跨周末倒计时仍然正确', () => {
    const r = currentPeriod(OLLAMA, utc('2026-09-18T20:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.minutesUntilSwitch).toBe(64 * 60) // 到周一 12:00
  })
})

describe('currentPeriod — 周日结束回峰时', () => {
  it('周日最后一分钟指向周一窗口起点', () => {
    const r = currentPeriod(OLLAMA, utc('2026-09-20T23:59:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.minutesUntilSwitch).toBe(12 * 60 + 1)
  })
})

describe('currentPeriod — 时区差异（本插件核心价值）', () => {
  it('同一时刻在 UTC 与北京时下判定各自正确', () => {
    // 2026-09-14T13:00:00Z = UTC 周一 13:00 = 北京时周一 21:00
    const now = utc('2026-09-14T13:00:00Z')

    // Ollama：UTC 12:00-18:00 → 此刻峰时
    expect(currentPeriod(OLLAMA, now).period).toBe('peak')

    // 小米：北京时 08:00-00:00 → 21:00 也在「标准倍率」内
    expect(currentPeriod(XIAOMI, now).period).toBe('peak')

    // 但两者距切换的时间完全不同：Ollama 到 18:00 UTC（5h），小米到 00:00 北京时（3h）
    expect(currentPeriod(OLLAMA, now).minutesUntilSwitch).toBe(300)
    expect(currentPeriod(XIAOMI, now).minutesUntilSwitch).toBe(180)
  })

  it('北京时凌晨谷段判定正确', () => {
    // 北京时 03:00（= UTC 前一日 19:00）→ 小米谷段
    const r = currentPeriod(XIAOMI, utc('2026-09-14T19:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.minutesUntilSwitch).toBe(5 * 60) // 到北京时 08:00
  })

  it('北京时周日的星期归属按该时区计算，而非 UTC', () => {
    // 2026-09-20T16:00:00Z = 北京时 2026-09-21 00:00（周一）
    // 小米每天都算峰时天，此处验证跨时区日期边界不串位
    const r = currentPeriod(XIAOMI, utc('2026-09-20T16:00:00Z'))
    expect(r.period).toBe('offPeak') // 北京时 00:00 是谷段起点（end 不含）
    expect(r.minutesUntilSwitch).toBe(8 * 60) // 到 08:00
  })
})

describe('currentPeriod — 边界与健壮性', () => {
  it('无窗口的 schedule 不抛错', () => {
    const empty: Schedule = { timeZone: 'UTC', peakDays: [1], peakWindows: [] }
    const r = currentPeriod(empty, utc('2026-09-14T12:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.minutesUntilSwitch).toBe(Number.POSITIVE_INFINITY)
  })

  it('跨午夜窗口判定正确', () => {
    // peakDays 含周一与周二，才能覆盖 22:00→次日 02:00 的跨日段
    const overnight: Schedule = {
      timeZone: 'UTC',
      peakDays: [1, 2],
      peakWindows: [{ start: '22:00', end: '02:00' }],
    }
    // 周一 23:00 与周二 01:00 都落在「周一 22:00 起的跨夜窗口」内
    expect(currentPeriod(overnight, utc('2026-09-14T23:00:00Z')).period).toBe('peak')
    expect(currentPeriod(overnight, utc('2026-09-15T01:00:00Z')).period).toBe('peak')
    // 02:00 结束（end 不含）
    expect(currentPeriod(overnight, utc('2026-09-15T02:00:00Z')).period).toBe('offPeak')
  })

  it('minutesUntilSwitch 总为正数', () => {
    for (let h = 0; h < 24; h++) {
      for (const day of ['2026-09-14', '2026-09-18', '2026-09-19', '2026-09-20']) {
        const t = new Date(`${day}T${String(h).padStart(2, '0')}:30:00Z`)
        const r = currentPeriod(OLLAMA, t)
        if (Number.isFinite(r.minutesUntilSwitch)) {
          expect(r.minutesUntilSwitch).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('formatCountdown', () => {
  it('<1h 用 Xm', () => {
    expect(formatCountdown(45)).toBe('45m')
    expect(formatCountdown(0)).toBe('0m')
  })

  it('<24h 用 Xh Ym', () => {
    expect(formatCountdown(150)).toBe('2h 30m')
    expect(formatCountdown(120)).toBe('2h')
  })

  it('≥24h 用 Xd Yh', () => {
    expect(formatCountdown(48 * 60)).toBe('2d')
    expect(formatCountdown(66 * 60)).toBe('2d 18h')
  })

  it('无穷大返回空串', () => {
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('DST（夏令时）—— 倒计时必须按真实时间差计算', () => {
  /** 真值：逐分钟向前找第一个时段翻转点。 */
  function groundTruth(schedule: Schedule, now: Date): number {
    const start = currentPeriod(schedule, now).period
    for (let i = 1; i <= 60 * 24 * 4; i++) {
      if (currentPeriod(schedule, new Date(now.getTime() + i * 60_000)).period !== start) return i
    }
    return Number.POSITIVE_INFINITY
  }

  /** 每天 12:00-18:00，用于暴露 DST 日的日长偏差。 */
  const DAILY: Schedule = {
    timeZone: 'America/New_York',
    peakDays: [0, 1, 2, 3, 4, 5, 6],
    peakWindows: [{ start: '12:00', end: '18:00' }],
  }

  it('春季前跳（2026-03-08）各时刻与真值一致', () => {
    for (const h of [0, 1, 2, 3, 10, 11]) {
      const now = new Date(Date.UTC(2026, 2, 8, h, 0))
      expect(currentPeriod(DAILY, now).minutesUntilSwitch, `UTC ${h}:00`).toBe(groundTruth(DAILY, now))
    }
  })

  it('秋季回拨（2026-11-01）各时刻与真值一致', () => {
    for (const h of [0, 1, 2, 3, 10, 11]) {
      const now = new Date(Date.UTC(2026, 10, 1, h, 0))
      expect(currentPeriod(DAILY, now).minutesUntilSwitch, `UTC ${h}:00`).toBe(groundTruth(DAILY, now))
    }
  })

  it('数据源里真实的 DST 时区 profile（America/Los_Angeles）也正确', () => {
    // swarms-swarm-completions：每天 06:00-20:00，America/Los_Angeles
    const swarms: Schedule = {
      timeZone: 'America/Los_Angeles',
      peakDays: [0, 1, 2, 3, 4, 5, 6],
      peakWindows: [{ start: '06:00', end: '20:00' }],
    }
    // 2026-03-08 是 DST 切换日
    for (const h of [0, 6, 12, 18, 22]) {
      const now = new Date(Date.UTC(2026, 2, 8, h, 0))
      expect(currentPeriod(swarms, now).minutesUntilSwitch, `UTC ${h}:00`).toBe(
        groundTruth(swarms, now),
      )
    }
  })

  it('非 DST 时区（Asia/Shanghai）行为不变', () => {
    const sh: Schedule = {
      timeZone: 'Asia/Shanghai',
      peakDays: [0, 1, 2, 3, 4, 5, 6],
      peakWindows: [{ start: '08:00', end: '00:00' }],
    }
    for (const h of [0, 4, 8, 15, 23]) {
      const now = new Date(Date.UTC(2026, 5, 15, h, 0))
      expect(currentPeriod(sh, now).minutesUntilSwitch, `UTC ${h}:00`).toBe(groundTruth(sh, now))
    }
  })
})

describe('★ 穷举：8 天扫描上界对任意 peakDays 子集都充分', () => {
  it('127 种非空 peakDays 组合 × 8 天（每 2 小时采样），均不返回 Infinity', () => {
    const days = [0, 1, 2, 3, 4, 5, 6]
    const bad: string[] = []
    for (let mask = 1; mask < 128; mask++) {
      const peakDays = days.filter((_, i) => (mask & (1 << i)) !== 0)
      const schedule: Schedule = {
        timeZone: 'UTC',
        peakDays,
        peakWindows: [{ start: '12:00', end: '18:00' }],
      }
      for (let d = 0; d < 8; d++) {
        for (let m = 0; m < 1440; m += 120) {
          const t = new Date(Date.UTC(2026, 8, 14 + d, 0, m))
          if (!Number.isFinite(currentPeriod(schedule, t).minutesUntilSwitch)) {
            bad.push(`${peakDays.join('/')} @ ${t.toISOString()}`)
          }
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('★ 回归：窗口边界 ≠ 状态翻转点', () => {
  /** 真值：逐分钟向前找第一个时段翻转点。 */
  function groundTruth(schedule: Schedule, now: Date): number {
    const start = currentPeriod(schedule, now).period
    // 最大真实翻转间隔约 7 天（如仅周一峰时、周日后半夜起算），8 天足够
    for (let i = 1; i <= 60 * 24 * 8; i++) {
      if (currentPeriod(schedule, new Date(now.getTime() + i * 60_000)).period !== start) return i
    }
    return Number.POSITIVE_INFINITY
  }

  it('相邻窗口 [09:00-12:00, 12:00-18:00] 在 12:00 处不翻转', () => {
    // 12:00 两侧都是 peak，真正的翻转点是 18:00。
    // 修复前：10:00 误报 120min（指向 12:00），实际应 480min。
    const adjacent: Schedule = {
      timeZone: 'UTC',
      peakDays: [1],
      peakWindows: [
        { start: '09:00', end: '12:00' },
        { start: '12:00', end: '18:00' },
      ],
    }
    for (const h of [10, 12, 13, 17]) {
      const now = new Date(Date.UTC(2026, 8, 14, h, 0)) // 周一
      expect(currentPeriod(adjacent, now).minutesUntilSwitch, `${h}:00`).toBe(
        groundTruth(adjacent, now),
      )
    }
    // 明确断言修复前会错的那个点
    expect(currentPeriod(adjacent, new Date(Date.UTC(2026, 8, 14, 10, 0))).minutesUntilSwitch).toBe(
      480,
    )
  })

  it('跨午夜窗口 22:00-02:00：次日 01:00 的翻转点是 02:00，不是次日 22:00', () => {
    // 修复前：周二 01:00 误报 1260min（指向次日 22:00），实际应 60min。
    const spill: Schedule = {
      timeZone: 'UTC',
      peakDays: [1, 2],
      peakWindows: [{ start: '22:00', end: '02:00' }],
    }
    expect(currentPeriod(spill, new Date(Date.UTC(2026, 8, 15, 1, 0))).period).toBe('peak')
    expect(currentPeriod(spill, new Date(Date.UTC(2026, 8, 15, 1, 0))).minutesUntilSwitch).toBe(60)

    for (const [d, h] of [[14, 23], [15, 1], [15, 2], [15, 12]] as const) {
      const now = new Date(Date.UTC(2026, 8, d, h, 0))
      expect(currentPeriod(spill, now).minutesUntilSwitch, `09-${d} ${h}:00`).toBe(
        groundTruth(spill, now),
      )
    }
  })

  it('状态沿真实时间连续：跨午夜窗口在 00:00 处不跳变', () => {
    // 00:00 只是日期翻页，不是窗口边界——状态必须连续。
    const spill: Schedule = {
      timeZone: 'UTC',
      peakDays: [1, 2],
      peakWindows: [{ start: '22:00', end: '02:00' }],
    }
    // 周一 23:59 与周二 00:01 应同为 peak
    expect(currentPeriod(spill, new Date(Date.UTC(2026, 8, 14, 23, 59))).period).toBe('peak')
    expect(currentPeriod(spill, new Date(Date.UTC(2026, 8, 15, 0, 1))).period).toBe('peak')
    // 周二 01:59 仍 peak，02:01 转 offPeak
    expect(currentPeriod(spill, new Date(Date.UTC(2026, 8, 15, 1, 59))).period).toBe('peak')
    expect(currentPeriod(spill, new Date(Date.UTC(2026, 8, 15, 2, 1))).period).toBe('offPeak')
  })

  it('真实数据源的全部 profile × 一周逐小时，倒计时均与真值一致', () => {
    // 端到端护栏：把真实快照里每个 profile 都过一遍
    const snapshot = JSON.parse(
      readFileSync(fileURLToPath(new URL('../data/pricing.json', import.meta.url)), 'utf8'),
    )
    const parsed = parseCatalog(snapshot)
    expect(parsed).toBeDefined()
    const bad: string[] = []
    for (const p of parsed!.profiles) {
      for (let d = 0; d < 4; d++) {
        for (let h = 0; h < 24; h += 6) {
          const now = new Date(Date.UTC(2026, 8, 14 + d, h, 0))
          const got = currentPeriod(p.schedule, now).minutesUntilSwitch
          const want = groundTruth(p.schedule, now)
          if (got !== want) bad.push(`${p.id} @ ${now.toISOString()} got=${got} want=${want}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('★ campaign 活动态（schedule.overrides）', () => {
  /** 复刻真实数据：zai-glm-5-3-flash —— 新加坡时，活动 2026-09-03~20 每天 23:00-09:00。 */
  const ZAI: Schedule = {
    timeZone: 'Asia/Shanghai',
    peakDays: [1, 2, 3, 4, 5],
    peakWindows: [{ start: '14:00', end: '18:00' }],
    overrides: [
      {
        period: 'campaign',
        startDate: '2026-09-03',
        endDate: '2026-09-20',
        days: [0, 1, 2, 3, 4, 5, 6],
        windows: [{ start: '23:00', end: '09:00' }],
      },
    ],
  }
  /** 由北京时构造时刻（北京时 = UTC+8）。 */
  const bj = (s: string) => new Date(s.replace(' ', 'T') + '+08:00')

  it('活动窗口内（23:30）判为 campaign', () => {
    expect(currentPeriod(ZAI, bj('2026-09-10 23:30')).period).toBe('campaign')
  })

  it('活动窗口跨午夜延续段（次日 02:00）仍为 campaign', () => {
    expect(currentPeriod(ZAI, bj('2026-09-10 23:30')).period).toBe('campaign')
    expect(currentPeriod(ZAI, bj('2026-09-11 02:00')).period).toBe('campaign')
  })

  it('活动结束了（09:00 起）退回常规判定', () => {
    // 09:00 是窗口终点（不含）；周四 09:00 不落在常规峰时窗口（14:00-18:00）→ offPeak
    expect(currentPeriod(ZAI, bj('2026-09-10 09:00')).period).toBe('offPeak')
    // 14:30 落在常规峰时窗口 → peak
    expect(currentPeriod(ZAI, bj('2026-09-10 14:30')).period).toBe('peak')
  })

  it('日期区间之外不生效（活动 9-03 ~ 9-20）', () => {
    // 9-02（区间前）与 9-21（区间后）的 23:30 都应是常规态
    expect(currentPeriod(ZAI, bj('2026-09-02 23:30')).period).toBe('offPeak')
    expect(currentPeriod(ZAI, bj('2026-09-21 23:30')).period).toBe('offPeak')
  })

  it('区间边界为闭区间（9-03 与 9-20 当天生效）', () => {
    expect(currentPeriod(ZAI, bj('2026-09-03 23:30')).period).toBe('campaign')
    expect(currentPeriod(ZAI, bj('2026-09-20 23:30')).period).toBe('campaign')
  })

  it('倒计时指向活动窗口结束（而非下一个常规翻转点）', () => {
    // 23:30 → 次日 09:00 = 9h30m = 570min
    expect(currentPeriod(ZAI, bj('2026-09-10 23:30')).minutesUntilSwitch).toBe(570)
  })

  it('活动开始前的倒计时指向活动开始', () => {
    // 22:50 → 23:00 = 10min（这正是用户实测看到的「9m」）
    const r = currentPeriod(ZAI, bj('2026-09-10 22:50'))
    expect(r.period).toBe('offPeak')
    expect(r.minutesUntilSwitch).toBe(10)
  })

  it('无 overrides 的 schedule 行为不变', () => {
    const plain: Schedule = {
      timeZone: 'UTC',
      peakDays: [1],
      peakWindows: [{ start: '12:00', end: '18:00' }],
    }
    expect(currentPeriod(plain, utc('2026-09-14T13:00:00Z')).period).toBe('peak')
  })
})
