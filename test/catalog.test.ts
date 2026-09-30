/**
 * catalog.ts 单测 —— 解析、校验与降级行为（spec §8）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

describe('★ override 校验（独立 review #3 #4）', () => {
  /** 构造最小合法 catalog，只改 override。 */
  const withOverride = (override: unknown) => ({
    schemaVersion: 1,
    updatedAt: '2026-09-11T00:00:00Z',
    profiles: [
      {
        id: 'demo',
        provider: 'Z.ai',
        model: 'GLM',
        source: 'https://example.com',
        schedule: {
          timeZone: 'UTC',
          peakDays: [1],
          peakWindows: [{ start: '12:00', end: '18:00' }],
          overrides: [override],
        },
        periods: {
          peak: { badge: '1×' },
          offPeak: { badge: '0.5×' },
          campaign: { badge: 'Campaign' },
        },
      },
    ],
  })

  it('#3 零长度窗口（start === end）被丢弃，不产生全天生效', () => {
    const r = parseCatalog(withOverride({
      period: 'campaign',
      days: [0, 1, 2, 3, 4, 5, 6],
      windows: [{ start: '10:00', end: '10:00' }],
    }))
    expect(r, 'catalog 应解析成功').toBeDefined()
    // 窗口被丢 → override 整体被跳过（wins 为空）
    expect(r?.profiles[0]?.schedule.overrides ?? []).toHaveLength(0)
  })

  it('#4 非 YYYY-MM-DD 的日期被拒绝（避免字符串比较静默错判）', () => {
    const r = parseCatalog(withOverride({
      period: 'campaign',
      startDate: '2026/09/03',
      endDate: '2026-9-3',
      days: [],
      windows: [{ start: '23:00', end: '09:00' }],
    }))
    const o = r?.profiles[0]?.schedule.overrides?.[0]
    expect(o, 'override 本身应保留（窗口合法）').toBeDefined()
    // 非法日期被丢弃 → 变成「不限日期」，但**不会**留下无法比较的字符串
    expect(o?.startDate).toBeUndefined()
    expect(o?.endDate).toBeUndefined()
  })

  it('#4 合法日期正常保留', () => {
    const r = parseCatalog(withOverride({
      period: 'campaign',
      startDate: '2026-09-03',
      endDate: '2026-09-20',
      days: [],
      windows: [{ start: '23:00', end: '09:00' }],
    }))
    const o = r?.profiles[0]?.schedule.overrides?.[0]
    expect(o?.startDate).toBe('2026-09-03')
    expect(o?.endDate).toBe('2026-09-20')
  })
})

/* ------------------------------------------------------------------ *
 * ★ 法定节假日字段（2026-09-30）
 *
 * 教训：`parseProfile` 是**显式挑字段**构造 `RateProfile` 的，未在
 * `RawProfile.schedule` 里声明的字段会被**静默丢弃** —— `publicHolidayDates`
 * 就这样丢了两周半，导致节假日的**工作日**被误标峰价。
 * 本组用例把「必须带出来 + 必须校验」固化成断言。
 * ------------------------------------------------------------------ */

describe('★ 法定节假日字段：白名单与校验', () => {
  /** 往最小合法数据源的 schedule 里塞字段后解析。 */
  function withSchedule(extra: Record<string, unknown>) {
    const raw = minimal()
    const profile = raw.profiles[0] as { schedule: Record<string, unknown> }
    Object.assign(profile.schedule, extra)
    return parseCatalog(raw)?.profiles[0]?.schedule
  }

  it('★ 必须带出来（曾因未声明而静默丢弃）', () => {
    const s = withSchedule({
      publicHolidayDates: ['2026-10-01', '2026-10-02'],
      publicHolidayName: 'Chinese public holiday',
    })
    expect(s?.publicHolidayDates).toEqual(['2026-10-01', '2026-10-02'])
    expect(s?.publicHolidayName).toBe('Chinese public holiday')
  })

  it('去重 + 升序（等价时间序，便于断言与展示）', () => {
    const s = withSchedule({ publicHolidayDates: ['2026-10-05', '2026-10-01', '2026-10-05'] })
    expect(s?.publicHolidayDates).toEqual(['2026-10-01', '2026-10-05'])
  })

  it('非法日期逐条丢弃，合法的保留', () => {
    const s = withSchedule({
      publicHolidayDates: [
        '2026-10-01', // 合法
        '2026-02-30', // 不存在的日历日（Date.UTC 会顺延到 03-02）
        '2026-13-01', // 月份越界
        '2026-1-1', // 形状不对（未补零）
        'garbage',
        '',
        20261001, // 数字
        null,
        { date: '2026-10-02' },
      ],
    })
    expect(s?.publicHolidayDates).toEqual(['2026-10-01'])
  })

  it('字段缺失或全非法 → 不写入该键（保持对象最小）', () => {
    expect(withSchedule({})).not.toHaveProperty('publicHolidayDates')
    expect(withSchedule({ publicHolidayDates: ['bad'] })).not.toHaveProperty('publicHolidayDates')
    expect(withSchedule({ publicHolidayDates: 'not-an-array' })).not.toHaveProperty(
      'publicHolidayDates',
    )
  })

  it('没有合法日期时不带 publicHolidayName（避免死字段）', () => {
    expect(withSchedule({ publicHolidayDates: [], publicHolidayName: 'X' })).not.toHaveProperty(
      'publicHolidayName',
    )
  })
})

/* ------------------------------------------------------------------ *
 * ★ 形态守卫：数据源里的每个键/取值，必须**已被消费**或**显式忽略（附理由）**
 *
 * 为什么需要它（2026-09-30）：本插件已两次栽在同一形态 ——
 *   ① `publicHolidayDates` 未声明 → 静默丢弃两周半 → 节假日的工作日误报峰价；
 *   ② 刷新快照后 `promotion` 等 period 名 + `allDay` 窗口未消费 → 已映射的 zai 系
 *      当场显示错倍率（promotion 全天 0.5× 被当成 peak 1×）。
 * 两次都不是逻辑写错，而是**数据源形态演进 + 显式挑字段构造 → 静默丢弃**。
 * 本组把「静默」变成「必须登记」：数据源新增键/新 period 名/新被丢 profile 时测试即失败，
 * 逼一次有意识的选择（去消费它，或写清为什么忽略）。
 * 与运行时的 `scripts/audit-coverage.mjs`（provider×model 覆盖穷举）互补：一个管形态，一个管映射。
 * ------------------------------------------------------------------ */

describe('★ 形态守卫：schedule / override / 窗口键与 period 名都必须有归属', () => {
  const snapshotPath = fileURLToPath(new URL('../data/pricing.json', import.meta.url))
  const raw = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
    profiles: {
      id: string
      schedule?: Record<string, unknown>
      periods?: Record<string, unknown>
    }[]
  }

  /** 已被 `parseProfile` 消费并进入 RateProfile 的 schedule 子键。 */
  const CONSUMED_SCHEDULE_KEYS = new Set([
    'timeZone',
    'peakDays',
    'peakWindows',
    'offDayName',
    'publicHolidayDates',
    'publicHolidayName',
    'publicHolidayTimeZone',
    'overrides',
  ])
  /** 已知但**有意不消费**的 schedule 子键 —— 每条必须写清理由。 */
  const IGNORED_SCHEDULE_KEYS: Record<string, string> = {
    sourceWindows: '数据源自带 widget 的展示串（"01:00–04:00 · 06:00–10:00"），插件自行渲染倍率，不需要。',
    windowName: '同上：数据源的窗口标签（"peak"），仅其 widget 用。',
    sourceTitle: '同上：数据源的标题文案（"Peak hours (UTC):"）。',
    sourceNote: '同上：数据源的说明文案（含 "except Chinese public holidays" 等）。',
    publicHolidaySource:
      '节假日清单的出处链接（gov.cn）。属溯源信息 —— profile 已有 source/verifiedAt 两个字段，UI 未展示，暂不透传。',
    dayTimeZone:
      '**语义非平凡**：它表示「星期几按哪个时区判」，可与 timeZone（窗口时区）不同 —— ' +
      '当前仅 above-deepseek-v4 带它（dayTimeZone=Asia/Shanghai、timeZone=UTC），而该 profile 无 provider 别名（未映射）→ 无用户影响。' +
      '消费它需要把「weekday 的来源时区」也参数化（改动触及 stateAt 与倒计时扫描），记 spec §11。',
  }
  /** 已被消费的 override 键。 */
  const CONSUMED_OVERRIDE_KEYS = new Set(['period', 'startDate', 'endDate', 'days', 'windows'])
  /** 已知但有意不消费的 override 键。 */
  const IGNORED_OVERRIDE_KEYS: Record<string, string> = {
    startAt: 'ISO 带时刻的起点。override 目前只按**日粒度**（startDate/endDate 字符串比较）生效；时刻粒度见 spec §11。',
    endAt: '同上：ISO 带时刻的终点。',
  }
  /** 已被消费的窗口键。 */
  const CONSUMED_WINDOW_KEYS = new Set(['start', 'end', 'allDay'])
  /** 允许被 `parseCatalog` 整体丢弃的 profile（id → 理由）。 */
  const ALLOWED_DROPPED: Record<string, string> = {
    'baidu-qianfan-glm53': '峰窗写成 00:00-00:00（零长度，无峰谷可言）',
    'bai-mimo26-flash': '同上',
    'bai-glm53-flash': '同上',
    'bai-qwen38-flash': '同上',
    'bai-mimo26-pro': '同上',
    'bai-glm52': '同上',
    'bai-glm53': '同上',
  }

  it('schedule 子键：全部有归属（消费或显式忽略）', () => {
    const unknown = new Set<string>()
    for (const p of raw.profiles) {
      for (const k of Object.keys(p.schedule ?? {})) {
        if (!CONSUMED_SCHEDULE_KEYS.has(k) && IGNORED_SCHEDULE_KEYS[k] === undefined) unknown.add(k)
      }
    }
    expect(
      [...unknown],
      '数据源出现未登记的 schedule 子键：要么在 parseProfile 里消费它，要么在 IGNORED_SCHEDULE_KEYS 写清理由',
    ).toEqual([])
  })

  it('override 键与窗口键：全部有归属', () => {
    const unknownOverride = new Set<string>()
    const unknownWindow = new Set<string>()
    for (const p of raw.profiles) {
      for (const o of (p.schedule?.overrides as Record<string, unknown>[] | undefined) ?? []) {
        for (const k of Object.keys(o)) {
          if (!CONSUMED_OVERRIDE_KEYS.has(k) && IGNORED_OVERRIDE_KEYS[k] === undefined) {
            unknownOverride.add(k)
          }
        }
        for (const w of (o.windows as Record<string, unknown>[] | undefined) ?? []) {
          for (const k of Object.keys(w)) if (!CONSUMED_WINDOW_KEYS.has(k)) unknownWindow.add(k)
        }
      }
    }
    expect([...unknownOverride], '未登记的 override 键').toEqual([])
    expect([...unknownWindow], '未登记的窗口键').toEqual([])
  })

  it('★ 每个 override 的 period 名都必须在该 profile 的 periods 里能解析', () => {
    // 未解析 = parseProfile 会静默跳过该条 override（正是 zai promotion 的失败形态）
    const unresolved: string[] = []
    for (const p of raw.profiles) {
      for (const o of (p.schedule?.overrides as { period?: string }[] | undefined) ?? []) {
        if (typeof o.period !== 'string') continue
        if (p.periods?.[o.period] === undefined) unresolved.push(`${p.id}: ${o.period}`)
      }
    }
    expect(unresolved, '数据源新增了 periods 里没有的 period 名').toEqual([])
  })

  it('★ 被丢弃的 profile 必须全在允许清单里（附理由）', () => {
    const parsed = parseCatalog(raw)
    expect(parsed).toBeDefined()
    const kept = new Set(parsed?.profiles.map((p) => p.id))
    const dropped = raw.profiles.map((p) => p.id).filter((id) => !kept.has(id))
    const unexpected = dropped.filter((id) => ALLOWED_DROPPED[id] === undefined)
    expect(
      unexpected,
      '出现新被丢弃的 profile：要么消费其形态，要么在 ALLOWED_DROPPED 登记理由',
    ).toEqual([])
    // 清单非空 → 说明这条守卫确实在看真实数据（而非空转）
    expect(dropped.length).toBeGreaterThan(0)
  })

  it('守卫本身在看真实数据（键集与 profile 数非空）', () => {
    expect(raw.profiles.length).toBeGreaterThan(0)
    expect(CONSUMED_SCHEDULE_KEYS.size).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ *
 * ★ 形态守卫（续）—— 第三轮独立 review 指出的三处"守卫判据不够"
 *
 * M1｜守卫判据单向：原来只断言 override 的 period 名「能在 periods 里**解析**」，
 *     但 `peak`/`offPeak` 恒在 periods 里 → 这类 override 会**过守卫又被静默跳过**
 *     （见 catalog.ts 里对 peak/offPeak 的显式 continue）。**能解析 ≠ 会被消费。**
 * M3｜守卫只遍历 schedule.* / overrides[] / 窗口键，漏了 **period 定义体内的键**与
 *     **profile 顶层键** —— 两层都在静默丢弃且无登记。
 * M4｜守卫只看**键**不看**取值**：`publicHolidayDates` 的元素若格式漂移会被逐条滤掉，
 *     节假日保护无声消失（与本插件修掉的「静默丢两周半」同类）；tz 串无效也只靠运行时兜底。
 * ------------------------------------------------------------------ */
describe('★ 形态守卫（续）：消费判定、period 定义体、profile 顶层键、节假日取值', () => {
  const snapshotPath = fileURLToPath(new URL('../data/pricing.json', import.meta.url))
  const raw = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
    profiles: Record<string, unknown>[]
  }

  /** 没有任何 override 应该用 `peak`/`offPeak` 表达（那样等于无覆盖，parseProfile 会跳过）。 */
  it('M1：不存在 period 为 peak/offPeak 的 override（守卫判据必须与消费条件一致）', () => {
    const offenders: string[] = []
    for (const p of raw.profiles) {
      const schedule = p.schedule as { overrides?: { period?: string }[] } | undefined
      for (const o of schedule?.overrides ?? []) {
        if (o.period === 'peak' || o.period === 'offPeak') {
          offenders.push(`${String(p.id)}: ${o.period}`)
        }
      }
    }
    expect(
      offenders,
      'override 用 peak/offPeak 表达等于无覆盖，parseProfile 会静默跳过：请改写数据源语义，或在 IGNORED 清单登记',
    ).toEqual([])
  })

  it('M3：period 定义体内的每个键都要有归属', () => {
    /** 已被消费（`periodDef.badge/name/detail` 会带进 ScheduleOverride）。 */
    const CONSUMED = new Set(['badge', 'name', 'detail'])
    /** 已知但有意不消费 —— 每条附理由。 */
    const IGNORED: Record<string, string> = {
      status: '数据源 widget 的实时状态文案（如 "B.AI campaign rate is active now"），插件自行渲染，不需要。',
      tone: '同上：状态文案的配色提示（当前仅 "special"），属其 widget 视觉。',
    }
    const unknown = new Set<string>()
    for (const p of raw.profiles) {
      for (const def of Object.values((p.periods as Record<string, unknown>) ?? {})) {
        if (def === null || typeof def !== 'object') continue
        for (const k of Object.keys(def)) {
          if (!CONSUMED.has(k) && IGNORED[k] === undefined) unknown.add(k)
        }
      }
    }
    expect([...unknown], 'period 定义体出现未登记的键').toEqual([])
  })

  it('M3：profile 顶层键都要有归属', () => {
    /** 已被 `parseProfile` 消费。 */
    const CONSUMED = new Set([
      'id',
      'provider',
      'model',
      'schedule',
      'periods',
      'source',
      'verifiedAt',
    ])
    /** 已知但有意不消费 —— 每条附理由。 */
    const IGNORED: Record<string, string> = {
      title: '数据源 widget 的标题（如 "DeepSeek Flash / Pro pricing clock"），插件不使用。',
      subtitle: '同上：副标题文案。',
      kicker: '同上：kicker 文案。',
      shortName: '同上：两字母缩写（如 "DS"），属其 widget 徽标。',
      slug: '同上：URL slug，属其站点路由。',
      product: '同上：产品分类文案（如 "API"）。',
      temporary: '同上：标记该 profile 是否临时条目，插件不按此过滤。',
      accountBenefit:
        'Z.ai 账号权益的说明文案（原文明确 "this is not a price multiplier"）—— 不参与倍率判定，插件不展示。',
    }
    const unknown = new Set<string>()
    for (const p of raw.profiles) {
      for (const k of Object.keys(p)) {
        if (!CONSUMED.has(k) && IGNORED[k] === undefined) unknown.add(k)
      }
    }
    expect([...unknown], 'profile 顶层出现未登记的键').toEqual([])
  })

  it('M4：节假日取值必须有效（键存在 ≠ 元素能用）', () => {
    for (const p of raw.profiles) {
      const schedule = p.schedule as
        | { publicHolidayDates?: unknown; publicHolidayTimeZone?: unknown }
        | undefined
      if (schedule?.publicHolidayDates !== undefined) {
        expect(Array.isArray(schedule.publicHolidayDates), `${String(p.id)}: 应为数组`).toBe(true)
        const list = schedule.publicHolidayDates as unknown[]
        // 声明了该字段就必须有可解析的日期 —— 否则「全天谷价」保护会无声消失
        expect(list.length, `${String(p.id)}: 节假日列表为空`).toBeGreaterThan(0)
        for (const d of list) {
          expect(isIsoDateShape(d), `${String(p.id)}: 非法节假日日期 ${String(d)}`).toBe(true)
        }
      }
      if (schedule?.publicHolidayTimeZone !== undefined) {
        expect(typeof schedule.publicHolidayTimeZone, `${String(p.id)}: tz 应为字符串`).toBe('string')
        expect(
          () => new Intl.DateTimeFormat('en-US', { timeZone: String(schedule.publicHolidayTimeZone) }),
          `${String(p.id)}: tz 不能被 Intl 解析（会静默回落 profile 时区）`,
        ).not.toThrow()
      }
    }
  })
})

/** 与 `catalog.ts` 的 `isIsoDate` 同形的形状+真实日历日校验（测试侧独立实现，避免自证）。 */
function isIsoDateShape(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (m === null) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}
