/**
 * client 半边：在 composer 工具行左侧**追加**一个紧凑倍率徽章，显示**当前模型**
 * 的峰谷状态、倍率与切换倒计时。
 *
 * **为什么是追加而不是替换**（2026-09-12 事故修订）：
 * `conversation.input.model` 是 `single` + `replaceRisk: shadows-shipped-ui` 槽位，
 * 注册即**遮蔽自带模型选择器**。本插件曾用它做「替换选择器」，但替换实现残缺
 * （无 effort 选择、无加载/错误态），**直接导致用户无法切换模型**。
 * 现改为注册到 `conversation.input.left`——list 槽位、`replaceRisk: none`、
 * 用自有 `id` 做纯追加，**完全不碰自带 UI**。
 *
 * 数据来源也从「构建期快照」改为**只读共享的 `ctx.modelDirectories`**（官方
 * client 服务，与自带选择器同一实例），因此当前模型的判定天然与选择器一致。
 */
import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { currentPeriod, formatCountdown } from '../schedule.js'
import { matchProfile, type MatchConfig, type RateProfile } from '../matching.js'

/** 当前模型在某时刻的倍率状态。 */
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
export function badgeIcon(period: 'peak' | 'offPeak'): string {
  return period === 'peak' ? '⚡' : '🌙'
}

/**
 * 构建悬停详情：当前时段名 + 倍率对照 + 倒计时 + 核验日期。
 *
 * @param state - 该模型的倍率状态。
 */
export function detailText(state: RateState): string {
  const { profile, period, badge } = state
  const currentName = period === 'peak' ? profile.peakName : profile.offPeakName
  const lines = [
    `${profile.providerName} · ${profile.modelLabel}`,
    `当前：${currentName}（${badge}）`,
    `峰 ${profile.peakBadge} / 谷 ${profile.offPeakBadge}`,
  ]
  const countdown = formatCountdown(state.minutesUntilSwitch)
  if (countdown !== '') lines.push(`${countdown} 后切换`)
  if (profile.verifiedAt !== undefined) lines.push(`核验于 ${profile.verifiedAt}`)
  return lines.join('\n')
}

/** 注入面：构建期打包进 client 的数据。 */
interface PeakrateFace {
  profiles: () => RateProfile[]
  config: () => MatchConfig
}

/**
 * 默认注入面：**构建期打包进 client 的 profile 快照**。
 *
 * 为什么不是从 host 服务读：DSH 的 host 树与 client 树是两套独立 cordis 实例，
 * client 侧拿不到 host 的 `ctx.get('peakrate')`。因此 client 自带一份快照
 * （由 `scripts/build-client.mjs` 用 `define` 注入），保证 UI 立即可用。
 *
 * ⚠️ **已知限制**：`config.providerAliases` / `modelMappings` / `customProfiles`
 * 目前只在 host 侧生效（影响 CatalogStore），**不影响 client 渲染**——client
 * 用的是打包快照 + 内置映射。详见 README「已知限制」与 spec §6。
 */
declare const __PEAKRATE_PROFILES__: RateProfile[] | undefined

function bundledProfiles(): RateProfile[] {
  return typeof __PEAKRATE_PROFILES__ === 'undefined' ? [] : __PEAKRATE_PROFILES__
}

const DEFAULT_FACE: PeakrateFace = {
  profiles: () => bundledProfiles(),
  config: () => ({}),
}

/** 组件注入面：来自官方 `modelDirectories` 服务的**只读**句柄。 */
interface ChipProps {
  /** 该 session 是否支持 Agent 绑定的模型操作（子代理会话为 false）。 */
  available: boolean
  /** 会话共享的模型目录 store（与自带选择器同一实例）。 */
  directory: {
    getSnapshot: () => {
      current: { provider: string; model: string } | null
    }
    subscribe: (fn: () => void) => () => void
  }
  /** 构建期注入的数据面。 */
  peakrate?: PeakrateFace
}

/**
 * 紧凑倍率徽章：显示**当前模型**的倍率与倒计时。
 *
 * 未匹配的模型**什么都不渲染**（返回 null，无占位、无灰字）。
 *
 * @param props - 注入面 + 共享模型目录。
 */
export function PeakrateChip(props: ChipProps): React.ReactElement | null {
  const state = React.useSyncExternalStore(
    (fn) => props.directory.subscribe(fn),
    () => props.directory.getSnapshot(),
  )
  // 每 30 秒重算一次，让倒计时保持新鲜
  const [now, setNow] = React.useState(() => new Date())

  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  if (!props.available) return null

  const current = state.current
  if (current === null) return null

  const face = props.peakrate ?? DEFAULT_FACE
  const rate = rateFor(current.provider, current.model, face.profiles(), face.config(), now)
  if (rate === undefined) return null

  const countdown = formatCountdown(rate.minutesUntilSwitch)
  return React.createElement(
    'span',
    {
      className: `dsh-peakrate-chip dsh-peakrate-${rate.period}`,
      title: detailText(rate),
    },
    React.createElement(
      'span',
      { className: 'dsh-peakrate-chip-badge' },
      `${badgeIcon(rate.period)}${rate.badge}`,
    ),
    countdown === ''
      ? null
      : React.createElement(
          'span',
          { className: 'dsh-peakrate-chip-countdown' },
          ` · ${countdown}`,
        ),
  )
}

/** client 侧 `ctx` 上本插件用到的服务的最小结构。 */
interface ClientScope {
  get: (name: string) => unknown
}

/**
 * client 插件入口：在 composer 工具行左侧**追加**倍率徽章。
 *
 * 注册要点（决定「追加」还是「替换」）：
 * - `conversation.input.left` 是 **list** 槽位 → 用 `id` 注册；
 * - `id: 'peakrate'` 是**自有 id** → 纯追加，不占用任何既有单元格；
 * - **绝不**注册到 `conversation.input.model`（single + shadows-shipped-ui）。
 *
 * @param ctx - client cordis 上下文。
 */
export function apply(ctx: Context): void {
  ctx.inject(['slots', 'modelDirectories'], (scope: ClientScope) => {
    const slots = scope.get('slots') as
      | {
          inject: (key: string, cb: () => () => void) => void
          register: (options: Record<string, unknown>, component: unknown) => () => void
        }
      | undefined
    const models = scope.get('modelDirectories') as
      | { directoryFor: (sessionId: string) => { store: ChipProps['directory'] } }
      | undefined
    const sessions = scope.get('sessions') as
      | { subagentAddress: (sessionId: string) => unknown }
      | undefined

    if (slots === undefined || models === undefined || sessions === undefined) return

    slots.inject('conversation.input.left', () =>
      slots.register(
        {
          // `name` = 槽位键；`id` = **自己的** cell 键。
          // 两者都必需：只给 id 时 register 不知道注册到哪个槽位。
          // 写法对照了三个真实插件的产物（dsh-plugin-memory / dsh-mcp-manager /
          // dshmarket 注册 settings.section 时均同时传 name + id）。
          // 自有 id 意味着「加在既有条目旁边」，不会占用别人的单元格。
          name: 'conversation.input.left',
          id: 'peakrate',
          // 排在既有控件之后，避免挤占原生位置
          order: 50,
          inject: (sessionId: string) => {
            const directory = models.directoryFor(sessionId)
            return {
              available: sessions.subagentAddress(sessionId) === undefined,
              directory: directory.store,
              peakrate: DEFAULT_FACE,
            }
          },
        },
        PeakrateChip,
      ),
    )
  })
}

export const name = 'dsh-peakrate-client'
export const inject = ['slots', 'modelDirectories']
