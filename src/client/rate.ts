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
  const { period, minutesUntilSwitch } = currentPeriod(profile.schedule, now)
  return { profile, period, badge: periodBadge(profile, period), minutesUntilSwitch }
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
  if (countdown !== '') lines.push(`${countdown} 后切换`)
  if (profile.verifiedAt !== undefined) lines.push(`核验于 ${profile.verifiedAt}`)
  return lines.join('\n')
}
