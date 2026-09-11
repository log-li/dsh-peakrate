/**
 * client 半边：替换模型选择器（`conversation.input.model`），在每一行渲染
 * 倍率徽章，当前选中行额外显示切换倒计时，hover 显示精简详情。
 *
 * 载体选择依据（spec §5）：该 slot 是 single 且 replaceRisk = shadows-shipped-ui，
 * 注册即遮蔽自带选择器——这正是 spec 要的「替换而非 overlay」。
 */
import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { currentPeriod, formatCountdown } from '../schedule.js'
import { matchProfile, type MatchConfig, type RateProfile } from '../matching.js'

/** 一个可选项（与自带 ModelSelect 的 choices 结构对齐）。 */
interface Choice {
  provider: string
  model: string
  label: string
}

/** 单个模型在某时刻的倍率状态。 */
export interface RateState {
  profile: RateProfile
  period: 'peak' | 'offPeak'
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
  return {
    profile,
    period,
    badge: period === 'peak' ? profile.peakBadge : profile.offPeakBadge,
    minutesUntilSwitch,
  }
}

/** 徽章图标：峰时闪电、谷时月亮。 */
function badgeIcon(period: 'peak' | 'offPeak'): string {
  return period === 'peak' ? '⚡' : '🌙'
}

/**
 * 行内倍率徽章。未匹配时不渲染任何内容（无占位、无灰字）。
 *
 * @param props - 该行的倍率状态；undefined 表示未匹配。
 */
export function RateBadge({ state }: { state: RateState | undefined }): React.ReactElement | null {
  if (state === undefined) return null
  return React.createElement(
    'span',
    {
      className: `dsh-peakrate-badge dsh-peakrate-${state.period}`,
      title: `${state.profile.providerName} · ${
        state.period === 'peak' ? state.profile.peakName : state.profile.offPeakName
      }`,
    },
    `${badgeIcon(state.period)}${state.badge}`,
  )
}

/**
 * 当前选中行的倒计时后缀，如 "2h30m 后切换"。
 *
 * @param props - 该行的倍率状态。
 */
export function RateCountdown({ state }: { state: RateState | undefined }): React.ReactElement | null {
  if (state === undefined) return null
  const text = formatCountdown(state.minutesUntilSwitch)
  if (text === '') return null
  return React.createElement('span', { className: 'dsh-peakrate-countdown' }, `${text} 后切换`)
}

/**
 * hover 精简详情：当前时段名 + 倍率对照 + 倒计时。
 *
 * @param props - 该行的倍率状态。
 */
export function RateDetail({ state }: { state: RateState | undefined }): React.ReactElement | null {
  if (state === undefined) return null
  const { profile, period, minutesUntilSwitch } = state
  const currentName = period === 'peak' ? profile.peakName : profile.offPeakName
  const countdown = formatCountdown(minutesUntilSwitch)

  const rows = [
    `${profile.providerName} · ${profile.modelLabel}`,
    `当前：${currentName}（${state.badge}）`,
    `峰 ${profile.peakBadge} / 谷 ${profile.offPeakBadge}`,
    countdown === '' ? '' : `${countdown} 后切换`,
    profile.verifiedAt === undefined ? '' : `核验于 ${profile.verifiedAt}`,
  ].filter((line) => line !== '')

  return React.createElement(
    'div',
    { className: 'dsh-peakrate-detail', role: 'tooltip' },
    rows.map((line, i) => React.createElement('div', { key: i }, line)),
  )
}

/** 注入面：由 `inject` 提供给组件的 profile 数据。 */
interface PeakrateFace {
  profiles: () => RateProfile[]
  updatedAt: () => string | undefined
  config: () => MatchConfig
}

/**
 * 默认注入面：**构建期打包进 client 的数据**。
 *
 * 为什么不是从 host 服务读：DSH 的 host 树与 client 树是两套独立 cordis 实例，
 * client 侧插件拿不到 host 的 `ctx.get('peakrate')`。因此 client 半边自带一份
 * profile 快照（由 `scripts/build-client.mjs` 在打包时注入），保证 UI 立即可用；
 * host 侧仍负责远端刷新与缓存（供将来经 RPC 下发用）。
 *
 * `scripts/build-client.mjs` 会把 `__PEAKRATE_PROFILES__` 替换为实际数据。
 */
declare const __PEAKRATE_PROFILES__: RateProfile[] | undefined

function bundledProfiles(): RateProfile[] {
  // 打包器未注入时（如单测直接 import）回退空数组，不抛错。
  return typeof __PEAKRATE_PROFILES__ === 'undefined' ? [] : __PEAKRATE_PROFILES__
}

const DEFAULT_FACE: PeakrateFace = {
  profiles: () => bundledProfiles(),
  updatedAt: () => undefined,
  config: () => ({}),
}

/**
 * 模型选择器（替换自带实现）。
 *
 * 保持与自带实现相同的交互骨架：根菜单 → 模型列表；本插件在每个模型行追加
 * 倍率徽章，并在当前选中行追加倒计时。
 */
export function PeakrateModelSelect(props: {
  available: boolean
  directory: {
    getSnapshot: () => {
      groups: readonly {
        id: string
        name?: string
        models: readonly { id: string; name?: string }[]
      }[]
      current: { provider: string; model: string } | null
      status: string
      error: string | null
    }
    subscribe: (fn: () => void) => () => void
  }
  select: (selection: { provider: string; model: string }) => Promise<boolean>
  locked?: boolean
  /** 由注册时的 `inject` 提供；缺省时用构建期打包的内置快照。 */
  peakrate?: PeakrateFace
}): React.ReactElement | null {
  const state = React.useSyncExternalStore(
    (fn) => props.directory.subscribe(fn),
    () => props.directory.getSnapshot(),
  )
  const [open, setOpen] = React.useState(false)
  // 每分钟重算一次，让倒计时保持新鲜
  const [now, setNow] = React.useState(() => new Date())

  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const peakrate = props.peakrate ?? DEFAULT_FACE
  const profiles = peakrate.profiles()
  const config = peakrate.config()

  const choices: Choice[] = React.useMemo(
    () =>
      state.groups.flatMap((group) =>
        group.models.map((model) => ({
          provider: group.id,
          model: model.id,
          label: model.name ?? model.id,
        })),
      ),
    [state.groups],
  )

  const current = state.current

  if (!props.available) return null

  return React.createElement(
    'div',
    { className: 'dsh-peakrate-root' },
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-peakrate-trigger',
        disabled: props.locked === true,
        onClick: () => setOpen((v) => !v),
        'aria-expanded': open,
      },
      current === null ? '选择模型' : current.model,
    ),
    open
      ? React.createElement(
          'div',
          { className: 'dsh-peakrate-menu', role: 'menu' },
          choices.map((choice) => {
            const rate = rateFor(choice.provider, choice.model, profiles, config, now)
            const isCurrent =
              current !== null &&
              current.provider === choice.provider &&
              current.model === choice.model
            return React.createElement(
              'button',
              {
                key: `${choice.provider}/${choice.model}`,
                type: 'button',
                role: 'menuitem',
                className: `dsh-peakrate-item${isCurrent ? ' dsh-peakrate-item-current' : ''}`,
                onClick: () => {
                  void props.select({ provider: choice.provider, model: choice.model })
                  setOpen(false)
                },
              },
              React.createElement('span', { className: 'dsh-peakrate-item-label' }, choice.label),
              // 当前选中行：徽章 + 倒计时
              isCurrent
                ? React.createElement(RateCountdown, { state: rate })
                : null,
              React.createElement(RateBadge, { state: rate }),
              rate === undefined ? null : React.createElement(RateDetail, { state: rate }),
            )
          }),
        )
      : null,
  )
}

/**
 * client 插件入口：注册到 `conversation.input.model`，遮蔽自带选择器。
 *
 * @param ctx - client cordis 上下文。
 */
export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as
    | {
        inject: (
          key: string,
          cb: () => () => void,
        ) => void
        register: (options: Record<string, unknown>, component: unknown) => () => void
      }
    | undefined
  if (slots === undefined) return

  slots.inject('conversation.input.model', () =>
    slots.register(
      {
        name: 'conversation.input.model',
        // 与官方插件同构：inject 返回组件的注入面。
        inject: () => ({ peakrate: DEFAULT_FACE }),
      },
      PeakrateModelSelect,
    ),
  )
}

export const name = 'dsh-peakrate-client'
export const inject = ['slots']
