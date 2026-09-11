/**
 * 覆盖率计算单测 —— 防静默遗漏的核心逻辑。
 */
import { describe, expect, it } from 'vitest'
import { buildCoverage, suspiciousProviders, type CoverageGroup } from '../src/coverage.js'
import { DEFAULT_PROVIDER_ALIASES, type RateProfile } from '../src/matching.js'

function profile(id: string, providerName: string, modelLabel: string): RateProfile {
  return {
    id,
    providerName,
    modelLabel,
    schedule: { timeZone: 'UTC', peakDays: [1], peakWindows: [{ start: '12:00', end: '18:00' }] },
    peakBadge: '2×',
    offPeakBadge: '1×',
    peakName: 'Peak',
    offPeakName: 'Off-peak',
  }
}

const PROFILES = [profile('deepseek-v4', 'DeepSeek', 'V4 系'), profile('ollama-deepseek-v4', 'Ollama', 'V4 系')]

const GROUPS: CoverageGroup[] = [
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'V4-Flash' }] },
  { id: 'ocg', name: 'Open code go', models: [{ id: 'deepseek-v4-flash-vision-exp', name: 'Vision' }] },
  {
    id: 'ollama',
    name: 'Ollama',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'V4.1 Flash' },
      { id: 'glm-5.3', name: 'GLM 5.3' },
    ],
  },
]

describe('buildCoverage', () => {
  it('逐 provider 统计命中/未命中', () => {
    const rep = buildCoverage(GROUPS, PROFILES, DEFAULT_PROVIDER_ALIASES)
    const byId = Object.fromEntries(rep.providers.map((p) => [p.id, p]))

    expect(byId['deepseek-official']?.matched).toBe(1)
    expect(byId['deepseek-official']?.unmatched).toBe(0)
    // ocg 现在有映射 → 应命中
    expect(byId['ocg']?.matched).toBe(1)
    // ollama：DeepSeek 命中、GLM 不命中（正常的部分覆盖）
    expect(byId['ollama']?.matched).toBe(1)
    expect(byId['ollama']?.unmatched).toBe(1)

    expect(rep.matchedTotal).toBe(3)
    expect(rep.unmatchedTotal).toBe(1)
  })

  it('命中的行带上 profile 展示名', () => {
    const rep = buildCoverage(GROUPS, PROFILES, DEFAULT_PROVIDER_ALIASES)
    const ocg = rep.providers.find((p) => p.id === 'ocg')
    expect(ocg?.rows[0]?.profileLabel).toBe('DeepSeek · V4 系')
  })

  it('未映射的 provider 带上 UNMATCHED_BY_DESIGN 的理由', () => {
    const groups: CoverageGroup[] = [
      { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'stealth/ox-alpha', name: 'ox-alpha' }] },
    ]
    const rep = buildCoverage(groups, PROFILES, DEFAULT_PROVIDER_ALIASES)
    expect(rep.providers[0]?.reason).toContain('聚合网关')
    expect(rep.providers[0]?.knownProvider).toBe(false)
  })
})

describe('★ suspiciousProviders —— 只挑「整组都没命中」的，避免噪音', () => {
  it('部分命中不算可疑（如 ollama 混有 GLM）', () => {
    const rep = buildCoverage(GROUPS, PROFILES, DEFAULT_PROVIDER_ALIASES)
    expect(suspiciousProviders(rep).map((p) => p.id)).toEqual([])
  })

  it('整组零命中且无已知理由 → 可疑（这正是 ocg 当初的形态）', () => {
    const groups: CoverageGroup[] = [
      { id: 'my-unknown-gateway', name: 'My Gateway', models: [{ id: 'deepseek-v4-flash', name: 'V4' }] },
    ]
    const rep = buildCoverage(groups, PROFILES, DEFAULT_PROVIDER_ALIASES)
    expect(suspiciousProviders(rep).map((p) => p.id)).toEqual(['my-unknown-gateway'])
  })

  it('整组零命中但已在 UNMATCHED_BY_DESIGN 写明理由 → 不算可疑', () => {
    const groups: CoverageGroup[] = [
      { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'stealth/ox-alpha', name: 'x' }] },
    ]
    const rep = buildCoverage(groups, PROFILES, DEFAULT_PROVIDER_ALIASES)
    expect(suspiciousProviders(rep)).toEqual([])
  })
})
