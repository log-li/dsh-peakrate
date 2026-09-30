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

describe('★ nextPeriod —— 让调用方能回答「之后是变贵还是变便宜」', () => {
  it('峰时窗口内 → 翻转后是谷', () => {
    const r = currentPeriod(OLLAMA, utc('2026-09-14T15:00:00Z'))
    expect(r.period).toBe('peak')
    expect(r.nextPeriod).toBe('offPeak')
  })

  it('谷时（当天还有窗口）→ 翻转后是峰', () => {
    const r = currentPeriod(OLLAMA, utc('2026-09-14T11:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.nextPeriod).toBe('peak')
  })

  it('campaign 窗口内 → 翻转后回到常规态', () => {
    const zai: Schedule = {
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
    const r = currentPeriod(zai, new Date('2026-09-10T23:30:00+08:00'))
    expect(r.period).toBe('campaign')
    // 活动窗口 09:00 结束；周四 09:00 不落在常规峰时窗口 → offPeak
    expect(r.nextPeriod).toBe('offPeak')
  })

  it('活动开始前 → nextPeriod 是 campaign（能预告「要进活动了」）', () => {
    const zai: Schedule = {
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
    const r = currentPeriod(zai, new Date('2026-09-10T22:50:00+08:00'))
    expect(r.period).toBe('offPeak')
    expect(r.nextPeriod).toBe('campaign')
    expect(r.minutesUntilSwitch).toBe(10)
  })

  it('无窗口的规则没有翻转点 → nextPeriod 为 undefined', () => {
    const empty: Schedule = { timeZone: 'UTC', peakDays: [1], peakWindows: [] }
    expect(currentPeriod(empty, utc('2026-09-14T12:00:00Z')).nextPeriod).toBeUndefined()
  })
})


describe('★ 跨午夜 override 归属「开始日」（独立 review #5 修正）', () => {
  /** 真实 Z.ai 数据形态：23:00-09:00 跨午夜，日期区间 09-03 ~ 09-20。 */
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
  const bj = (s: string) => new Date(s.replace(' ', 'T') + '+08:00')

  it('区间首日凌晨不算活动（首个活动夜才从当天 23:00 开始）', () => {
    expect(currentPeriod(ZAI, bj('2026-09-03 00:30')).period).toBe('offPeak')
    expect(currentPeriod(ZAI, bj('2026-09-03 23:30')).period).toBe('campaign')
  })

  it('末夜的溢出段仍算活动（归属开始日，不被午夜截断）', () => {
    expect(currentPeriod(ZAI, bj('2026-09-20 23:30')).period).toBe('campaign')
    expect(currentPeriod(ZAI, bj('2026-09-21 02:00')).period).toBe('campaign')
    // 区间结束后的下一夜不再是活动
    expect(currentPeriod(ZAI, bj('2026-09-21 23:30')).period).toBe('offPeak')
  })

  it('days 为子集时，跨午夜活动的凌晨段仍生效（按开始日的星期判定）', () => {
    // 仅周五开始的活动窗口；周五 23:30 与周六 02:00 都应生效
    const friOnly: Schedule = {
      timeZone: 'Asia/Shanghai',
      peakDays: [],
      peakWindows: [],
      overrides: [
        {
          period: 'campaign',
          days: [5], // 仅周五
          windows: [{ start: '23:00', end: '09:00' }],
        },
      ],
    }
    // 2026-09-04 是周五
    expect(currentPeriod(friOnly, bj('2026-09-04 23:30')).period).toBe('campaign')
    // 周六凌晨属于周五那一段
    expect(currentPeriod(friOnly, bj('2026-09-05 02:00')).period).toBe('campaign')
    // 周六晚上则不应生效（周六不在 days 内）
    expect(currentPeriod(friOnly, bj('2026-09-05 23:30')).period).toBe('offPeak')
  })

  it('零长度 override 窗口被丢弃（否则跨午夜分支会变成全天生效）', () => {
    const bad: Schedule = {
      timeZone: 'UTC',
      peakDays: [1],
      peakWindows: [],
      overrides: [{ period: 'campaign', days: [], windows: [{ start: '10:00', end: '10:00' }] }],
    }
    // schedule 层不做过滤（过滤在 catalog 层），此处直接验证它会全天生效——
    // 因此 catalog 层的过滤是必要的；见 test/catalog.test.ts
    expect(currentPeriod(bad, utc('2026-09-14T03:00:00Z')).period).toBe('campaign')
  })
})

/* ------------------------------------------------------------------ *
 * ★ 法定节假日（schedule.publicHolidayDates）
 *
 * 依据上游价目页：「All other hours are off-peak, including weekends and
 * **Chinese public holidays in full**」。
 * 2026-09-30 前的缺陷：catalog 层没声明该字段 → 被静默丢弃 → 节假日的**工作日**
 * 被误标峰价（用户 2026-09-30 实测报告：「下一次峰价应该是 10.8」）。
 * ------------------------------------------------------------------ */

/** 数据源 deepseek-v4 的节假日集合（截取与本组用例相关的一段）。 */
const CN_HOLIDAYS = [
  '2026-09-25',
  '2026-09-26',
  '2026-09-27',
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
]

/** deepseek-v4 + 法定节假日。 */
const DEEPSEEK_CN: Schedule = {
  ...DEEPSEEK,
  publicHolidayDates: CN_HOLIDAYS,
  publicHolidayName: 'Chinese public holiday',
}

describe('★ 法定节假日 —— 当天全天谷价', () => {
  it('用户场景：10/1（周四）在常规窗口内，应为谷价而不是峰价', () => {
    // 不带节假日 → 周四 01:00-04:00 是峰时
    expect(currentPeriod(DEEPSEEK, utc('2026-10-01T02:00:00Z')).period).toBe('peak')
    // 带节假日 → 全天谷价
    expect(currentPeriod(DEEPSEEK_CN, utc('2026-10-01T02:00:00Z')).period).toBe('offPeak')
  })

  it('节假日覆盖全部常规窗口（两个窗口都要被压制）', () => {
    for (const iso of [
      '2026-10-01T02:00:00Z', // 01:00-04:00 窗口
      '2026-10-02T08:00:00Z', // 06:00-10:00 窗口
      '2026-10-05T02:30:00Z', // 周一
    ]) {
      expect(currentPeriod(DEEPSEEK_CN, utc(iso)).period, iso).toBe('offPeak')
    }
  })

  it('用户场景：从 10/1 起算，下一个峰价是 10/8 01:00 UTC', () => {
    // 7 天（10/1 00:00 → 10/8 00:00） + 1 小时（00:00 → 01:00 窗口起点）
    const r = currentPeriod(DEEPSEEK_CN, utc('2026-10-01T00:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.nextPeriod).toBe('peak')
    expect(r.minutesUntilSwitch).toBe(7 * 24 * 60 + 60)
  })

  it('假期最后一天：从 10/7 中午起算，13 小时后回到峰价', () => {
    const r = currentPeriod(DEEPSEEK_CN, utc('2026-10-07T12:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.nextPeriod).toBe('peak')
    expect(r.minutesUntilSwitch).toBe(13 * 60) // 10/8 01:00 UTC
  })

  it('10/8 恢复常规：01:00-04:00 峰、04:00-06:00 谷、06:00-10:00 峰', () => {
    expect(currentPeriod(DEEPSEEK_CN, utc('2026-10-08T02:00:00Z')).period).toBe('peak')
    expect(currentPeriod(DEEPSEEK_CN, utc('2026-10-08T05:00:00Z')).period).toBe('offPeak')
    expect(currentPeriod(DEEPSEEK_CN, utc('2026-10-08T08:00:00Z')).period).toBe('peak')
  })

  it('进入假期的那一天边界即翻转（9/30 23:59 → 10/1 00:00）', () => {
    const before = currentPeriod(DEEPSEEK_CN, utc('2026-09-30T23:59:00Z'))
    expect(before.period).toBe('offPeak')
    // 下一个翻转点就是假期开始（10/1 00:00），此后连续谷价 → 真正的下一次翻转是 10/8 01:00
    expect(before.nextPeriod).toBe('peak')
    expect(before.minutesUntilSwitch).toBe(1 + 7 * 24 * 60 + 60)
  })

  it('★ 跨午夜窗口：节假日当天的窗口整体作废，不得溢出到次日', () => {
    // 合成：周四 22:00-02:00 跨午夜；次日周五为法定节假日
    const sched: Schedule = {
      timeZone: 'UTC',
      peakDays: [4], // 仅周四
      peakWindows: [{ start: '22:00', end: '02:00' }],
    }
    const withHoliday: Schedule = { ...sched, publicHolidayDates: ['2026-10-09'] } // 周五
    // 无节假日：周五 01:00 处于「周四窗口溢出」→ 峰时
    expect(currentPeriod(sched, utc('2026-10-09T01:00:00Z')).period).toBe('peak')
    // 有节假日：周五整天谷价，溢出一并作废
    expect(currentPeriod(withHoliday, utc('2026-10-09T01:00:00Z')).period).toBe('offPeak')
    // 周四晚上本身仍按常规判峰（节假日是**次日**）
    expect(currentPeriod(withHoliday, utc('2026-10-08T23:00:00Z')).period).toBe('peak')
  })

  it('未配置节假日时行为与改动前完全一致（回归护栏）', () => {
    // 只在**非节假日**日期上比对：节假日日期本就该不同，不属本护栏范围。
    for (const iso of [
      '2026-09-24T02:00:00Z', // 假期前的周四
      '2026-09-30T02:00:00Z', // 假期前的周三
      '2026-10-08T02:00:00Z', // 假期后的周四
      '2026-10-10T12:00:00Z', // 假期后的周六
    ]) {
      expect(currentPeriod(DEEPSEEK_CN, utc(iso)), iso).toEqual(
        currentPeriod(DEEPSEEK, utc(iso)),
      )
    }
  })
})

/* ------------------------------------------------------------------ *
 * ★ 促销/活动覆盖的"新形态"（2026-09-30 接通）
 *
 * 数据源的 override 形态比初版丰富：`period` 名不止 `campaign`（还有 `promotion` /
 * `campaign10` / …），**每个名字在 `periods` 里各有自己的 badge**；窗口可用 `allDay`
 * 表示全天（写作 00:00-00:00）。
 * 此前只认 `campaign` 且把零长度窗口一律丢弃 → **已映射的 zai 系当场显示错倍率**：
 * promotion（9/25-10/7 全天 0.5×）被丢 → 工作日 14:00-18:00 误报 `peak 1×`。
 * ------------------------------------------------------------------ */

describe('★ 促销态：每个活动带自己的倍率与名称', () => {
  /** 合成 zai 形态：北京时工作日 14:00-18:00 为峰，另有 9/25-10/7 全天 0.5× promotion。 */
  const ZAI_LIKE: Schedule = {
    timeZone: 'Asia/Shanghai',
    peakDays: [1, 2, 3, 4, 5],
    peakWindows: [{ start: '14:00', end: '18:00' }],
    overrides: [
      {
        period: 'campaign',
        periodName: 'promotion',
        badge: '0.5×',
        name: 'All-day off-peak',
        startDate: '2026-09-25',
        endDate: '2026-10-07',
        days: [0, 1, 2, 3, 4, 5, 6],
        // 全天窗（schedule 层把 end <= start 展开为 +1440）
        windows: [{ start: '00:00', end: '00:00' }],
      },
    ],
  }

  it('★ 促销窗内的常规峰时段应为活动态，且带该活动自己的 badge', () => {
    // 2026-09-30 是周三；07:00Z = 北京 15:00，落在常规峰窗 14:00-18:00 内
    const r = currentPeriod(ZAI_LIKE, utc('2026-09-30T07:00:00Z'))
    expect(r.period).toBe('campaign')
    expect(r.activePromo?.badge).toBe('0.5×')
    expect(r.activePromo?.periodName).toBe('promotion')
    expect(r.activePromo?.name).toBe('All-day off-peak')
  })

  it('同一时刻去掉 override 即为 peak（证明是 override 在起作用）', () => {
    const outside: Schedule = { ...ZAI_LIKE, overrides: [] }
    expect(currentPeriod(outside, utc('2026-09-30T07:00:00Z')).period).toBe('peak')
    // 10-08 已出促销区间
    expect(currentPeriod(ZAI_LIKE, utc('2026-10-08T07:00:00Z')).period).toBe('peak')
  })

  it('全天窗口（00:00-00:00）确实覆盖整日', () => {
    for (const iso of [
      '2026-09-30T00:30:00Z', // 北京 08:30
      '2026-09-30T07:00:00Z', // 北京 15:00
      '2026-09-30T15:30:00Z', // 北京 23:30
    ]) {
      expect(currentPeriod(ZAI_LIKE, utc(iso)).period, iso).toBe('campaign')
    }
  })

  it('非活动态不带 activePromo（避免 UI 拿到无关徽章）', () => {
    expect(currentPeriod(ZAI_LIKE, utc('2026-10-08T07:00:00Z')).activePromo).toBeUndefined()
  })

  it('同一 profile 有两个促销态时，各带自己的 badge（不串用）', () => {
    const two: Schedule = {
      timeZone: 'Asia/Shanghai',
      peakDays: [1, 2, 3, 4, 5],
      peakWindows: [{ start: '14:00', end: '18:00' }],
      overrides: [
        {
          period: 'campaign',
          periodName: 'campaign',
          badge: '2× quota',
          days: [0, 1, 2, 3, 4, 5, 6],
          windows: [{ start: '23:00', end: '09:00' }], // 跨午夜
        },
        {
          period: 'campaign',
          periodName: 'promotion',
          badge: '0.5×',
          days: [0, 1, 2, 3, 4, 5, 6],
          windows: [{ start: '00:00', end: '00:00' }],
        },
      ],
    }
    // 北京 02:00 落在第一条（23:00-09:00）→ 第一条优先，取它的 badge
    expect(currentPeriod(two, utc('2026-09-30T18:00:00Z')).activePromo?.badge).toBe('2× quota')
    // 北京 15:00 只落第二条
    expect(currentPeriod(two, utc('2026-09-30T07:00:00Z')).activePromo?.badge).toBe('0.5×')
  })
})

/* ------------------------------------------------------------------ *
 * ★ 节假日 × 跨午夜窗口：两个方向都要有**能变红**的用例
 *
 * `stateAt` 的顺序是 overrides → 节假日早退 → isPeakAt(..., prevDayIsHoliday)。
 * 因此两个方向由不同分支负责：
 *   ① 「非节假日傍晚起的窗口溢出**落进**节假日」→ 由节假日早退拦截（不经过参数）
 *   ② 「节假日**当天**的跨午夜窗口溢出到次日」→ 只能由 `prevDayIsHoliday` 参数拦住
 * 独立 review（2026-09-30）指出：此前只有 ① 的用例，删掉该参数测试依然全绿 —— ② 缺真护栏。
 * ------------------------------------------------------------------ */

describe('★ 节假日当天的跨午夜窗口不得溢出到次日（prevDayIsHoliday 的真红绿）', () => {
  /** 合成：仅周四有 22:00-02:00 跨午夜窗；把某个周四设为法定节假日（次日周五非节假日）。 */
  const sched: Schedule = {
    timeZone: 'UTC',
    peakDays: [4],
    peakWindows: [{ start: '22:00', end: '02:00' }],
    publicHolidayDates: ['2026-10-08'], // 2026-10-08 是周四
  }

  it('节假日当天 22:00 之后的窗口段仍是谷价', () => {
    expect(currentPeriod(sched, utc('2026-10-08T23:00:00Z')).period).toBe('offPeak')
  })

  it('★ 次日凌晨 01:00 也是谷价（该窗口随节假日整体作废，不得溢出）', () => {
    expect(currentPeriod(sched, utc('2026-10-09T01:00:00Z')).period).toBe('offPeak')
  })

  it('对照组：去掉节假日，同一次日凌晨 01:00 就是 peak（证明上一条靠该参数成立）', () => {
    const noHoliday: Schedule = { ...sched, publicHolidayDates: [] }
    expect(currentPeriod(noHoliday, utc('2026-10-09T01:00:00Z')).period).toBe('peak')
  })

  it('非节假日的那一周四，跨午夜窗照常生效（护栏：别把常规跨午夜也废掉）', () => {
    expect(currentPeriod(sched, utc('2026-10-01T23:00:00Z')).period).toBe('peak')
    expect(currentPeriod(sched, utc('2026-10-02T01:00:00Z')).period).toBe('peak')
  })
})

/* ------------------------------------------------------------------ *
 * ★ 倒计时指向"另一个促销态"时，必须用**那一刻那条**活动的倍率
 *
 * 曾是缺陷：`nextBadge` 走 profile 级 `campaignBadge`（单一槽位），
 * 当两个促销态相邻（zai：campaign 23:00-09:00 与 promotion 全天）时会显示另一个活动的倍率。
 * ------------------------------------------------------------------ */
describe('★ nextActivePromo：翻转点落在某条活动上时用它自己的倍率', () => {
  // 两个**时段不重叠**的活动（周六 / 周日各一段），从常规态翻转进入时必须取对应那条的 badge。
  // 曾有的缺陷：`nextBadge` 走 profile 级单一 `campaignBadge`，两个活动会串用。
  const two: Schedule = {
    timeZone: 'Asia/Shanghai',
    peakDays: [1, 2, 3, 4, 5],
    peakWindows: [{ start: '14:00', end: '18:00' }],
    overrides: [
      {
        period: 'campaign',
        periodName: 'campaignA',
        badge: 'A',
        days: [6], // 周六
        windows: [{ start: '09:00', end: '12:00' }],
      },
      {
        period: 'campaign',
        periodName: 'campaignB',
        badge: 'B',
        days: [0], // 周日
        windows: [{ start: '09:00', end: '12:00' }],
      },
    ],
  }

  it('周六 08:00（常规谷价）→ 下一个翻转点是活动 A，取其自己的 badge', () => {
    // 2026-10-03 是周六；北京 08:00 = UTC 00:00
    const r = currentPeriod(two, utc('2026-10-03T00:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.activePromo).toBeUndefined()
    expect(r.nextPeriod).toBe('campaign')
    expect(r.nextActivePromo?.badge, '应取周六那条活动的倍率').toBe('A')
  })

  it('周日 08:00 → 下一个翻转点是活动 B，取其自己的 badge（不串用）', () => {
    // 2026-10-04 是周日
    const r = currentPeriod(two, utc('2026-10-04T00:00:00Z'))
    expect(r.period).toBe('offPeak')
    expect(r.nextPeriod).toBe('campaign')
    expect(r.nextActivePromo?.badge).toBe('B')
  })

  it('活动内：当前与下一个都是同一活动（不误报 nextActivePromo）', () => {
    // 周六 10:00（活动 A 内）→ 12:00 结束后回到常规谷价，故无 nextActivePromo
    const r = currentPeriod(two, utc('2026-10-03T02:00:00Z'))
    expect(r.activePromo?.badge).toBe('A')
    expect(r.nextActivePromo).toBeUndefined()
  })
})
