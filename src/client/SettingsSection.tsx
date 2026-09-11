/**
 * 设置页「模型峰谷倍率」——注册到 `settings.section`（list · `replaceRisk: none`，
 * 自有 id 做**纯追加**，不遮蔽任何自带页面）。
 *
 * 页面内容：
 * 1. **当前覆盖情况（实时）**：逐 provider 列出模型，标出是否命中 profile；
 *    **整组零命中且无已知理由的 provider 会被单独顶到前面并高亮**——
 *    这正是 2026-09-12 漏掉 OpenCode Go 的形态，目标是让遗漏**看得见**。
 * 2. **规则说明**：数据源、内置别名表、已知不映射的 provider 及其理由。
 * 3. **如何自定义**：config 片段。
 */
import * as React from 'react'
import {
  buildCoverage,
  suspiciousProviders,
  type CoverageGroup,
  type CoverageReport,
} from '../coverage.js'
import { DEFAULT_PROVIDER_ALIASES, UNMATCHED_BY_DESIGN, type MatchConfig, type RateProfile } from '../matching.js'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { RateIcon } from './icons.js'
import { currentPeriod, formatCountdown, type Period } from '../schedule.js'
import { periodBadge } from './rate.js'

/** 注入面。 */
export interface SettingsInjected {
  peakrate: {
    profiles: () => RateProfile[]
    config: () => MatchConfig
  }
  /** 只读的模型目录解析器（用于读取当前会话的 provider×model 列表）。 */
  modelDirectories?: {
    directoryFor: (sessionId: string) => {
      store: {
        getSnapshot: () => {
          groups: readonly CoverageGroup[]
          status: string
        }
        subscribe: (fn: () => void) => () => void
      }
    }
  }
  t: (key: string, params?: Record<string, unknown>) => string
}

/** 会话列表快照（只取本页需要的字段）。 */
interface SessionListLike {
  ids: readonly string[]
  current?: string
}

/** 组件完整属性：注入面 + 标准 props（本页用到 useSessions）。 */
export type PeakrateSettingsProps = SettingsInjected & {
  useSessions?: <S>(selector: (state: SessionListLike) => S) => S
}

/** 一行的展示单元：倍率徽章（复用菜单内样式，视觉一致）。 */
function RateTag({ state }: { state: ReturnType<typeof rateOf> }): React.ReactElement | null {
  if (state === undefined) return null
  const cd = formatCountdown(state.minutesUntilSwitch)
  return (
    <span className={`dsh-peakrate-ms-rate dsh-peakrate-${state.period}`}>
      <RateIcon period={state.period} size={13} />
      {state.badge}
      {cd === '' ? null : <span className="dsh-peakrate-ms-rateCountdown">{` · ${cd}`}</span>}
    </span>
  )
}

/** 单模型倍率（供设置页小徽章用）。 */
function rateOf(
  profile: RateProfile | undefined,
  now: Date,
): { period: Period; badge: string; minutesUntilSwitch: number } | undefined {
  if (profile === undefined) return undefined
  const { period, minutesUntilSwitch } = currentPeriod(profile.schedule, now)
  return { period, badge: periodBadge(profile, period), minutesUntilSwitch }
}

/** 设置页主体。
 *
 * @param props - 注入面与标准 props。
 */
export function PeakrateSettings(props: PeakrateSettingsProps): React.ReactElement {
  const { peakrate, t } = props
  // 折叠态（默认收起）——避免在官方「模型」页里喧宾夺主
  const [open, setOpen] = React.useState(false)
  const profiles = peakrate.profiles()
  const config = peakrate.config()

  // 取一个会话以读取实时模型目录（root 作用域的设置页没有 sessionId，
  // 故用 useSessions 的当前会话；没有会话时退化为「无实时数据」）。
  const sessionId = props.useSessions?.((s) => s.current ?? s.ids[0])

  const directory = React.useMemo(() => {
    if (sessionId === undefined || props.modelDirectories === undefined) return undefined
    try {
      return props.modelDirectories.directoryFor(sessionId)
    } catch {
      return undefined
    }
  }, [props.modelDirectories, sessionId])

  const state = React.useSyncExternalStore(
    (fn) => directory?.store.subscribe(fn) ?? (() => {}),
    () => directory?.store.getSnapshot(),
  )

  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const report: CoverageReport | undefined =
    state === undefined
      ? undefined
      : buildCoverage(state.groups ?? [], profiles, DEFAULT_PROVIDER_ALIASES, config)

  const suspicious = report === undefined ? [] : suspiciousProviders(report)

  // 折叠时的描述行（官方卡的 description 位置）：一句话说清这卡是干什么的，
  // 再附上覆盖概况。不在这里堆告警记号 —— 展开后由告警条承担。
  const summary =
    report === undefined
      ? t('settings.noSessionShort')
      : `${t('settings.desc')} ${t('settings.summary', {
          covered: report.matchedTotal,
          total: report.matchedTotal + report.unmatchedTotal,
        })}`

  return (
    // 结构对齐官方 PluginCard：<li class=card> + <button class=header>
    // （headText 取 flex:1，chevron 在**右**侧；展开时 card 换背景色）
    <li className={`dsh-peakrate-card${open ? ' dsh-peakrate-cardOpen' : ''}`}>
      <button
        type="button"
        className="dsh-peakrate-cardHeader"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dsh-peakrate-cardHeadText">
          <span className="dsh-peakrate-cardName">{t('settings.title')}</span>
          <span className="dsh-peakrate-cardDesc">{summary}</span>
        </span>
        <IconChevronDownOutline14
          className={`dsh-peakrate-cardChevron${open ? ' dsh-peakrate-cardChevronOpen' : ''}`}
        />
      </button>
      {open && (
      <div className="dsh-peakrate-cardBody">

      {suspicious.length > 0 && (
        <div className="dsh-peakrate-settings-alert">
          <strong>{t('settings.suspicious', { count: suspicious.length })}</strong>
          <ul>
            {suspicious.map((p) => (
              <li key={p.id}>
                {p.name}（{p.id}）— {t('settings.suspiciousHint')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h4 className="dsh-peakrate-settings-h">{t('settings.coverage')}</h4>
      {report === undefined ? (
        <p className="dsh-peakrate-settings-muted">{t('settings.noSession')}</p>
      ) : (
        <table className="dsh-peakrate-settings-table">
          <thead>
            <tr>
              <th>{t('settings.colProvider')}</th>
              <th>{t('settings.colCount')}</th>
              <th>{t('settings.colMissing')}</th>
            </tr>
          </thead>
          <tbody>
            {report.providers.map((p) => {
              const missing = p.rows.filter((r) => r.profileLabel === undefined)
              return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="dsh-peakrate-settings-count">{`${p.matched} / ${p.rows.length}`}</td>
                  <td className="dsh-peakrate-settings-muted">
                    {missing.length === 0
                      ? '—'
                      : missing.map((r) => r.modelName).join(', ')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      </div>
      )}
    </li>
  )
}
