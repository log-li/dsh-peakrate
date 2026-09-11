/**
 * matching.ts 单测 —— 覆盖 spec §10 要求的匹配规则。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_MAPPINGS,
  matchProfile,
  normalizeModelId,
  type RateProfile,
} from '../src/matching.js'

/** 构造一个最小可用 profile。 */
function profile(id: string, providerName: string): RateProfile {
  return {
    id,
    providerName,
    modelLabel: id,
    schedule: { timeZone: 'UTC', peakDays: [1], peakWindows: [{ start: '12:00', end: '18:00' }] },
    peakBadge: '2×',
    offPeakBadge: '1×',
    peakName: 'Peak',
    offPeakName: 'Off-peak',
  }
}

const PROFILES: RateProfile[] = [
  profile('deepseek-v4', 'DeepSeek'),
  profile('ollama-deepseek-v4', 'Ollama'),
  profile('xiaomi-mimo-v2-5-token-plan', 'Xiaomi MiMo'),
  profile('zai-glm-5-3', 'Z.ai'),
]

describe('normalizeModelId', () => {
  it('剥离 provider 侧 tag 后缀', () => {
    expect(normalizeModelId('deepseek-v4-flash:0731')).toBe('deepseek-v4-flash')
    expect(normalizeModelId('deepseek-v4-pro:0813')).toBe('deepseek-v4-pro')
  })

  it('小写化并去空白', () => {
    expect(normalizeModelId('  DeepSeek-V4.1-Flash  ')).toBe('deepseek-v4.1-flash')
  })

  it('剥离 @ 后缀', () => {
    expect(normalizeModelId('glm-5.3@latest')).toBe('glm-5.3')
  })
})

describe('matchProfile — provider 别名', () => {
  it('deepseek-official 命中 DeepSeek 系', () => {
    const hit = matchProfile('deepseek-official', 'deepseek-v4-flash', PROFILES)
    expect(hit?.id).toBe('deepseek-v4')
  })

  it('ollama 命中 Ollama 系（与 DeepSeek 同模型但不同 profile）', () => {
    const hit = matchProfile('ollama', 'deepseek-v4-flash:0731', PROFILES)
    expect(hit?.id).toBe('ollama-deepseek-v4')
  })

  it('未收录的 provider 返回 undefined', () => {
    expect(matchProfile('openrouter', 'stealth/ox-alpha', PROFILES)).toBeUndefined()
  })

  it('OpenCode Go 系归入 DeepSeek profile（其文档载明峰值窗口与官方一致）', () => {
    // 依据：https://opencode.ai/docs/go/ —— DeepSeek V4 系峰值 01:00-04:00 / 06:00-10:00 UTC
    // 周一至周五，与 DeepSeek 官方完全相同（转售上游定价）。
    expect(matchProfile('ocg', 'deepseek-v4-pro', PROFILES)?.id).toBe('deepseek-v4')
    expect(matchProfile('ocg', 'deepseek-v4-flash-vision-exp', PROFILES)?.id).toBe('deepseek-v4')
    expect(matchProfile('ocg-1', 'deepseek-v4-flash', PROFILES)?.id).toBe('deepseek-v4')
    expect(matchProfile('opencode-go', 'deepseek-v4-flash', PROFILES)?.id).toBe('deepseek-v4')
  })

  it('OpenCode Go 下的非 DeepSeek 模型不匹配（如 ocg-1-chat 的 omen-alpha）', () => {
    expect(matchProfile('ocg-1-chat', 'omen-alpha', PROFILES)).toBeUndefined()
  })
})

describe('matchProfile — V4 系宽松归属', () => {
  it('deepseek-v4* 前缀全系命中', () => {
    for (const m of [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4.1-flash',
      'deepseek-v4-flash-vision-exp',
    ]) {
      expect(matchProfile('deepseek-official', m, PROFILES)?.id, m).toBe('deepseek-v4')
    }
  })

  it('历史别名 deepseek-flash 同归 V4 系', () => {
    expect(matchProfile('deepseek-official', 'deepseek-flash', PROFILES)?.id).toBe('deepseek-v4')
  })

  it('带 tag 后缀的 ollama 模型命中', () => {
    expect(matchProfile('ollama', 'deepseek-v4-flash:0731', PROFILES)?.id).toBe('ollama-deepseek-v4')
    expect(matchProfile('ollama', 'deepseek-v4-pro:0813', PROFILES)?.id).toBe('ollama-deepseek-v4')
    expect(matchProfile('ollama', 'deepseek-v4.1-flash', PROFILES)?.id).toBe('ollama-deepseek-v4')
  })
})

describe('matchProfile — 未匹配返回 undefined（UI 不显示）', () => {
  it('ollama 下的非 DeepSeek 模型不显示', () => {
    for (const m of ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'minimax-m3', 'kimi-k3']) {
      expect(matchProfile('ollama', m, PROFILES), m).toBeUndefined()
    }
  })

  it('provider 命中但模型不命中时不显示', () => {
    expect(matchProfile('deepseek-official', 'some-other-model', PROFILES)).toBeUndefined()
  })
})

describe('matchProfile — token plan 整包命中', () => {
  it('空 match 视为该 provider 下全部模型命中', () => {
    expect(matchProfile('xiaomi-token-plan-cn', 'mimo-v2.5', PROFILES)?.id).toBe(
      'xiaomi-mimo-v2-5-token-plan',
    )
    expect(matchProfile('xiaomi-token-plan-cn', 'anything-at-all', PROFILES)?.id).toBe(
      'xiaomi-mimo-v2-5-token-plan',
    )
  })
})

describe('matchProfile — config 覆盖优先级', () => {
  it('config.modelMappings 优先于内置规则', () => {
    const hit = matchProfile('ollama', 'deepseek-v4-flash:0731', PROFILES, {
      modelMappings: [{ provider: 'ollama', match: 'deepseek-v4', profile: 'deepseek-v4' }],
    })
    expect(hit?.id).toBe('deepseek-v4')
  })

  it('config.providerAliases 可把自建路由指向某 profile provider', () => {
    const hit = matchProfile('ocg', 'deepseek-v4-pro', PROFILES, {
      providerAliases: { ocg: 'Ollama' },
      modelMappings: [{ provider: 'ocg', match: 'deepseek-v4', profile: 'ollama-deepseek-v4' }],
    })
    expect(hit?.id).toBe('ollama-deepseek-v4')
  })

  it('正则模式可用', () => {
    const hit = matchProfile('zai', 'glm-5.3-flash', PROFILES, {
      providerAliases: { zai: 'Z.ai' },
      modelMappings: [
        { provider: 'zai', match: '^glm-5\\.3', profile: 'zai-glm-5-3', matchIsRegex: true },
      ],
    })
    expect(hit?.id).toBe('zai-glm-5-3')
  })

  it('非法正则不抛错，只是不命中', () => {
    const hit = matchProfile('zai', 'glm-5.3', PROFILES, {
      providerAliases: { zai: 'Z.ai' },
      modelMappings: [{ provider: 'zai', match: '([', profile: 'zai-glm-5-3', matchIsRegex: true }],
    })
    expect(hit).toBeUndefined()
  })
})

describe('内置映射表自洽性', () => {
  it('每条内置映射的 profile id 都是合法的（无拼写漂移）', () => {
    const ids = new Set(DEFAULT_MODEL_MAPPINGS.map((m) => m.profile))
    expect(ids).toContain('deepseek-v4')
    expect(ids).toContain('ollama-deepseek-v4')
    expect(ids).toContain('xiaomi-mimo-v2-5-token-plan')
  })
})
