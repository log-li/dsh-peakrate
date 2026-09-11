/**
 * schedule.ts 单测 —— 纯函数，不依赖 DSH 运行时。
 *
 * 覆盖 spec §10 要求的五类边界 + UTC / Asia/Shanghai 双时区判定。
 */
import { describe, expect, it } from 'vitest'
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
