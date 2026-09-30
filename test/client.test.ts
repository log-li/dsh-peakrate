/**
 * client 侧纯逻辑测试 —— rateFor 的判定与「未匹配不显示」。
 *
 * 不渲染 React（渲染走实机验收），只测可断言的数据面。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rateFor } from '../src/client/rate.js'
import { parseCatalog } from '../src/catalog.js'

const snapshotPath = fileURLToPath(new URL('../data/pricing.json', import.meta.url))
const profiles = parseCatalog(JSON.parse(readFileSync(snapshotPath, 'utf8')))!.profiles

describe('rateFor —— 匹配到的模型', () => {
  it('峰时返回 peak 徽章与倒计时', () => {
    // 周一 13:00 UTC：Ollama 处于 12:00-18:00 峰时
    const r = rateFor('ollama', 'deepseek-v4-flash:0731', profiles, {}, new Date('2026-09-14T13:00:00Z'))
    expect(r).toBeDefined()
    expect(r?.period).toBe('peak')
    expect(r?.badge).toBe('2×')
    expect(r?.minutesUntilSwitch).toBe(300)
  })

  it('谷时返回 offPeak 徽章', () => {
    const r = rateFor('ollama', 'deepseek-v4-flash:0731', profiles, {}, new Date('2026-09-14T20:00:00Z'))
    expect(r?.period).toBe('offPeak')
    expect(r?.badge).toBe('1×')
  })

  it('同一模型经不同 provider 得到不同结果（核心证据）', () => {
    const now = new Date('2026-09-14T13:00:00Z')
    const viaOfficial = rateFor('deepseek-official', 'deepseek-v4-flash', profiles, {}, now)
    const viaOllama = rateFor('ollama', 'deepseek-v4-flash:0731', profiles, {}, now)
    expect(viaOfficial?.period).toBe('offPeak')
    expect(viaOllama?.period).toBe('peak')
  })

  it('小米 token plan 的倍率文案原样取自数据源', () => {
    const r = rateFor('xiaomi-token-plan-cn', 'mimo', profiles, {}, new Date('2026-09-14T02:00:00Z'))
    // 北京时 10:00 → 标准倍率 1× credits
    expect(r?.badge).toBe('1× credits')
  })
})

describe('rateFor —— 未匹配必须返回 undefined（UI 什么都不显示）', () => {
  it('未收录 provider', () => {
    expect(rateFor('openrouter', 'stealth/ox-alpha', profiles, {}, new Date())).toBeUndefined()
  })

  it('provider 收录但模型不收录', () => {
    expect(rateFor('ollama', 'glm-5.3', profiles, {}, new Date())).toBeUndefined()
    expect(rateFor('ollama', 'kimi-k3', profiles, {}, new Date())).toBeUndefined()
  })
})

describe('rateFor —— config 覆盖生效', () => {
  it('providerAliases + modelMappings 可让自建路由显示倍率', () => {
    const config = {
      providerAliases: { ocg: 'Ollama' },
      modelMappings: [{ provider: 'ocg', match: 'deepseek-v4', profile: 'ollama-deepseek-v4' }],
    }
    const r = rateFor('ocg', 'deepseek-v4-pro', profiles, config, new Date('2026-09-14T13:00:00Z'))
    expect(r).toBeDefined()
    expect(r?.profile.id).toBe('ollama-deepseek-v4')
  })
})

/* ------------------------------------------------------------------ *
 * ★ 促销态徽章：必须用**当前生效那条活动自己的**倍率
 *
 * 2026-09-30 修：`periodBadge` 原先只读 profile 级单一 `campaignBadge` 槽位 ——
 * 同一 profile 有多个促销态（zai 的 campaign 与 promotion）时会显示成另一个活动的倍率。
 * 本组用自建 fixture（不依赖上游当天数据），并让 profile 级槽位与活动自己的倍率**故意不同**，
 * 以便「取错了」必然失败。
 * ------------------------------------------------------------------ */
describe('★ 促销态徽章取自活动自身', () => {
  /** 自建 profile：常规工作日 14:00-18:00 峰；另有一条全天 0.5× 的 promotion。 */
  const promoProfile = {
    id: 'promo-fixture',
    providerName: 'Vendor',
    modelLabel: 'Model',
    schedule: {
      timeZone: 'Asia/Shanghai',
      peakDays: [1, 2, 3, 4, 5],
      peakWindows: [{ start: '14:00', end: '18:00' }],
      overrides: [
        {
          period: 'campaign' as const,
          periodName: 'promotion',
          badge: '0.5×',
          name: 'All-day off-peak',
          days: [0, 1, 2, 3, 4, 5, 6],
          windows: [{ start: '00:00', end: '00:00' }],
        },
      ],
    },
    peakBadge: '1×',
    offPeakBadge: '0.5×',
    peakName: 'Peak',
    offPeakName: 'Off-peak',
    // profile 级槽位故意放**另一个**活动的倍率：取错就必然断言失败
    campaignBadge: '2× quota',
    campaignName: 'Another campaign',
  }
  const config = {
    providerAliases: { 'fixture-provider': 'Vendor' },
    modelMappings: [{ provider: 'fixture-provider', match: '', profile: 'promo-fixture' }],
  }

  it('促销窗内 → 用活动自己的 0.5×，而不是 profile 槽位的 2× quota', () => {
    // 2026-09-30（周三）北京 15:00 = UTC 07:00，落在常规峰窗内
    const r = rateFor('fixture-provider', 'any-model', [promoProfile], config, new Date('2026-09-30T07:00:00Z'))
    expect(r?.period).toBe('campaign')
    expect(r?.badge).toBe('0.5×')
    expect(r?.badge).not.toBe('2× quota')
  })

  it('无促销时不受 profile 槽位影响（常规峰/谷照旧）', () => {
    const bare = { ...promoProfile, schedule: { ...promoProfile.schedule, overrides: [] } }
    const peak = rateFor('fixture-provider', 'any-model', [bare], config, new Date('2026-09-30T07:00:00Z'))
    expect(peak?.period).toBe('peak')
    expect(peak?.badge).toBe('1×')
    const off = rateFor('fixture-provider', 'any-model', [bare], config, new Date('2026-09-30T13:00:00Z'))
    expect(off?.period).toBe('offPeak')
    expect(off?.badge).toBe('0.5×')
  })
})
