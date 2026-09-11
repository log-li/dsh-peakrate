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
  /**
   * 翻转后的状态与其徽章 —— 只用于 **tooltip**（精确、无歧义）。
   *
   * 曾据此算过紧凑的 `↑`/`↓` 方向箭头，**已删除**（2026-09-12 用户判断）：
   * 除活动态外所有转换本就是二态翻转（在那个对称机制上标方向信息量低），
   * 而真正需要方向的活动态**算不出来**（徽章是文字，无数字可比）——
   * **一个时有时无的指示反而制造困惑**。精确信息保留在 tooltip 里。
   */
  nextPeriod?: Period
  nextBadge?: string
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
        }),
  }
}

/** 取某时段态的徽章文案（活动态缺数据时回退峰时文案，避免渲染出 undefined）。 */
export function periodBadge(profile: RateProfile, period: Period): string {
  if (period === 'campaign') return profile.campaignBadge ?? profile.peakBadge
  return period === 'peak' ? profile.peakBadge : profile.offPeakBadge
}


/**
 * 构建悬停详情：当前时段名 + 倍率对照 + 倒计时 + 核验日期。
 *
 * @param state - 该模型的倍率状态。
 * @param formatCountdown - 倒计时格式化函数（由调用方注入，避免重复实现）。
 */
/** 翻译函数签名（与 harness locale 的 `t` 一致）。 */
export type Translate = (key: string, params?: Record<string, unknown>) => string

export function detailText(
  state: RateState,
  formatCountdown: (minutes: number) => string,
  t: Translate,
  subject?: string,
): string {
  return detailLines(state, formatCountdown, t, subject).join('\n')
}

/**
 * 详情**分行**输出 —— 供点击展开的面板按行渲染（比整块文本更好排版）。
 *
 * @param state - 倍率状态。
 * @param formatCountdown - 倒计时格式化函数。
 * @returns 每行一条的详情。
 */
export function detailLines(
  state: RateState,
  formatCountdown: (minutes: number) => string,
  t: Translate,
  subject?: string,
): string[] {
  const { profile, period, badge } = state
  const scope = `${profile.providerName} · ${profile.modelLabel}`
  const lines = [subject ?? scope]

  // 只讲**当前这个模型**：此刻什么态、什么倍率，以及多久之后变成什么。
  // 刻意不列：profile 的覆盖模型族（那是别的模型，对使用者没用）、
  // 峰谷对照表（与「此刻 + 下一刻」重复）、数据核验日期（属覆盖面板的职责）。
  const countdown = formatCountdown(state.minutesUntilSwitch)
  // 时段名走**字典**，不用数据源的英文 `peakName`/`offPeakName` ——
  // 否则中文界面里会冒出 `Off-peak rate`。
  const now = `${t(`period.${period}`)} ${badge}`
  if (countdown === '' || state.nextPeriod === undefined) {
    lines.push(now)
    return lines
  }
  lines.push(
    t('detail.now', { now }),
    t('detail.next', {
      countdown,
      next: `${t(`period.${state.nextPeriod}`)} ${state.nextBadge ?? ''}`.trim(),
    }),
  )
  return lines
}
