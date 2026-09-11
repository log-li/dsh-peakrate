/**
 * 真实快照集成测试 —— 用 data/pricing.json 验证 spec §4.3 的命中表。
 *
 * 这是本插件的核心证据：同一模型经不同 provider 路由时，时段规则并不相同。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCatalog } from '../src/catalog.js'
import { matchProfile } from '../src/matching.js'
import { currentPeriod } from '../src/schedule.js'

const snapshotPath = fileURLToPath(new URL('../data/pricing.json', import.meta.url))
const catalog = parseCatalog(JSON.parse(readFileSync(snapshotPath, 'utf8')))

describe('内置快照本身合法', () => {
  it('能被 parseCatalog 解析', () => {
    expect(catalog).toBeDefined()
    expect(catalog?.profiles.length).toBeGreaterThan(0)
  })

  it('包含本机需要的三个 profile', () => {
    const ids = catalog?.profiles.map((p) => p.id) ?? []
    expect(ids).toContain('deepseek-v4')
    expect(ids).toContain('ollama-deepseek-v4')
    expect(ids).toContain('xiaomi-mimo-v2-5-token-plan')
  })
})

describe('spec §4.3 命中表 —— 应显示的行', () => {
  const profiles = catalog?.profiles ?? []

  it('deepseek-official 的 4 个模型 → deepseek-v4', () => {
    for (const m of [
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
    ]) {
      expect(matchProfile('deepseek-official', m, profiles)?.id, m).toBe('deepseek-v4')
    }
  })

  it('ollama 的 3 个 DeepSeek 模型 → ollama-deepseek-v4', () => {
    for (const m of ['deepseek-v4-flash:0731', 'deepseek-v4-pro:0813', 'deepseek-v4.1-flash']) {
      expect(matchProfile('ollama', m, profiles)?.id, m).toBe('ollama-deepseek-v4')
    }
  })

  it('xiaomi-token-plan-cn → xiaomi-mimo-v2-5-token-plan', () => {
    expect(matchProfile('xiaomi-token-plan-cn', 'mimo-v2.5', profiles)?.id).toBe(
      'xiaomi-mimo-v2-5-token-plan',
    )
  })
})

describe('spec §4.3 命中表 —— 不应显示的行', () => {
  const profiles = catalog?.profiles ?? []

  it('ollama 下的 GLM / MiniMax / Kimi 不显示', () => {
    for (const m of ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'minimax-m3', 'kimi-k3']) {
      expect(matchProfile('ollama', m, profiles), m).toBeUndefined()
    }
  })

  it('ocg 系 provider 的 deepseek 模型不显示', () => {
    for (const p of ['ocg', 'opencode-go', 'ocg-1']) {
      expect(matchProfile(p, 'deepseek-v4-pro', profiles), p).toBeUndefined()
    }
  })

  it('ocg-1-chat 的 omen-alpha 与 openrouter 的 stealth 不显示', () => {
    expect(matchProfile('ocg-1-chat', 'omen-alpha', profiles)).toBeUndefined()
    expect(matchProfile('openrouter', 'stealth/ox-alpha', profiles)).toBeUndefined()
  })
})

describe('核心证据：同模型不同 provider，时段规则不同', () => {
  const profiles = catalog?.profiles ?? []
  const deepseek = matchProfile('deepseek-official', 'deepseek-v4-flash', profiles)
  const ollama = matchProfile('ollama', 'deepseek-v4-flash:0731', profiles)

  it('两者是不同 profile', () => {
    expect(deepseek?.id).toBe('deepseek-v4')
    expect(ollama?.id).toBe('ollama-deepseek-v4')
    expect(deepseek?.id).not.toBe(ollama?.id)
  })

  it('同一时刻判定可以不同（UTC 13:00 = 北京时 21:00）', () => {
    const now = new Date('2026-09-14T13:00:00Z') // 周一
    // Ollama：UTC 12:00-18:00 → 峰时
    expect(currentPeriod(ollama!.schedule, now).period).toBe('peak')
    // DeepSeek：UTC 01:00-04:00 / 06:00-10:00 → 谷时
    expect(currentPeriod(deepseek!.schedule, now).period).toBe('offPeak')
  })

  it('倒计时各自正确（这是区别于 DeepSeek 专用插件的证据）', () => {
    const now = new Date('2026-09-14T13:00:00Z')
    // Ollama：峰时中，到本窗口结束 18:00 UTC = 5h
    expect(currentPeriod(ollama!.schedule, now).minutesUntilSwitch).toBe(300)
    // DeepSeek：谷时中，当天窗口已全部结束 → 下一个翻转点是次日 01:00 = 12h
    expect(currentPeriod(deepseek!.schedule, now).minutesUntilSwitch).toBe(720)
    // 两者不同，证明各自按自己的时区与窗口计算
    expect(currentPeriod(ollama!.schedule, now).minutesUntilSwitch).not.toBe(
      currentPeriod(deepseek!.schedule, now).minutesUntilSwitch,
    )
  })

  it('北京时窗口换算与 spec 记载一致', () => {
    // 数据源记 UTC 01:00-04:00 / 06:00-10:00，换算北京时应为 09:00-12:00 / 14:00-18:00
    const toBeijing = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number)
      return `${String((h! + 8) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
    const windows = deepseek!.schedule.peakWindows
      .map((w) => `${toBeijing(w.start)}-${toBeijing(w.end)}`)
      .join(' / ')
    expect(windows).toBe('09:00-12:00 / 14:00-18:00')
  })
})
