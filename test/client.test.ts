/**
 * client 侧纯逻辑测试 —— rateFor 的判定与「未匹配不显示」。
 *
 * 不渲染 React（渲染走实机验收），只测可断言的数据面。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rateFor } from '../src/client/index.js'
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
