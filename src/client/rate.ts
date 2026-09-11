/**
 * 倍率计算的共享层：工具行徽章与 fork 的模型选择器共用同一套判定，
 * 避免两处各算各的产生不一致。
 */
import { currentPeriod, type Period } from '../schedule.js'
import { matchProfile, type MatchConfig, type RateProfile } from '../matching.js'

/** 某模型在某时刻的倍率状态。 */
export interface RateState {
  profile: RateProfile
  /** 三态：峰 / 谷 / 活动。 */
  period: Period
  badge: string
  minutesUntilSwitch: number
  /** 翻转后的状态与其徽章 —— 用于回答「之后变贵还是变便宜」。 */
  nextPeriod?: Period
  nextBadge?: string
  /**
   * 翻转方向：`'up'` = 之后**变贵**、`'down'` = 之后**变便宜**、
   * `undefined` = 无法判定（任一侧徽章不含数字，如 `Campaign`）。
   */
  trend?: 'up' | 'down'
}

/**
 * 从徽章文案里抽取数字倍率，用于比较涨跌。
 *
 * 数据源的徽章形态混杂：`2×` / `1×` / `0.5×` / `1× credits` / `0.8× credits`，
 * 而活动态是**文字**（`Campaign`）—— 后者抽不出数字，涨跌无法判定，
 * 此时**不猜**，返回 undefined 让 UI 不显示方向箭头。
 *
 * @param badge - 徽章文案。
 * @returns 数字倍率；抽不出时 undefined。
 */
export function parseMultiplier(badge: string | undefined): number | undefined {
  if (badge === undefined) return undefined
  const m = /(\d+(?:\.\d+)?)\s*[×x]/.exec(badge)
  if (m === null) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/**
 * 计算某模型此刻的倍率状态；未匹配返回 undefined（UI 什么都不显示）。
 *
 * @param provider - DSH provider id。
 * @param model - provider 原始模型 id。
 * @param profiles - 可用 profile 列表。
 * @param config - 别名与归属覆盖。
 * @param now - 判定基准时刻。
 */
export function rateFor(
  provider: string,
  model: string,
  profiles: RateProfile[],
  config: MatchConfig,
  now: Date,
): RateState | undefined {
  const profile = matchProfile(provider, model, profiles, config)
  if (profile === undefined) return undefined
  const { period, minutesUntilSwitch, nextPeriod } = currentPeriod(profile.schedule, now)
  return {
    profile,
    period,
    badge: periodBadge(profile, period),
    minutesUntilSwitch,
    ...(nextPeriod === undefined
      ? {}
      : {
          nextPeriod,
          nextBadge: periodBadge(profile, nextPeriod),
          trend: trendOf(periodBadge(profile, period), periodBadge(profile, nextPeriod)),
        }),
  }
}

/**
 * 比较两侧徽章的数字倍率，得出涨跌方向。
 *
 * 任一侧抽不出数字（如活动态的 `Campaign`）→ 返回 undefined（**不猜**）。
 */
function trendOf(current: string, next: string): 'up' | 'down' | undefined {
  const a = parseMultiplier(current)
  const b = parseMultiplier(next)
  if (a === undefined || b === undefined) return undefined
  if (b > a) return 'up'
  if (b < a) return 'down'
  return undefined
}

/** 取某时段态的徽章文案（活动态缺数据时回退峰时文案，避免渲染出 undefined）。 */
export function periodBadge(profile: RateProfile, period: Period): string {
  if (period === 'campaign') return profile.campaignBadge ?? profile.peakBadge
  return period === 'peak' ? profile.peakBadge : profile.offPeakBadge
}

/** 取某时段态的展示名。 */
export function periodName(profile: RateProfile, period: Period): string {
  if (period === 'campaign') return profile.campaignName ?? 'Campaign'
  return period === 'peak' ? profile.peakName : profile.offPeakName
}

/**
 * 构建悬停详情：当前时段名 + 倍率对照 + 倒计时 + 核验日期。
 *
 * @param state - 该模型的倍率状态。
 * @param formatCountdown - 倒计时格式化函数（由调用方注入，避免重复实现）。
 */
export function detailText(
  state: RateState,
  formatCountdown: (minutes: number) => string,
): string {
  const { profile, period, badge } = state
  const currentName = periodName(profile, period)
  const lines = [
    `${profile.providerName} · ${profile.modelLabel}`,
    `当前：${currentName}（${badge}）`,
  ]
  if (period === 'campaign' && profile.campaignDetail !== undefined) {
    lines.push(profile.campaignDetail)
  }
  lines.push(`峰 ${profile.peakBadge} / 谷 ${profile.offPeakBadge}`)
  const countdown = formatCountdown(state.minutesUntilSwitch)
  if (countdown !== '') {
    const to =
      state.nextPeriod === undefined
        ? ''
        : `，转为 ${periodName(profile, state.nextPeriod)}（${state.nextBadge ?? ''}）`
    lines.push(`${countdown} 后${to === '' ? '' : '切换'}${to}`)
  }
  if (profile.verifiedAt !== undefined) lines.push(`核验于 ${profile.verifiedAt}`)
  return lines.join('\n')
}
