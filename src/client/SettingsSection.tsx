/**
 * 本插件的**配置页**：覆盖情况面板 + 可界面编辑的配置项。
 *
 * ## 载体（2026-09-26，对齐 DSH 0.1.7-rc.2）
 *
 * 注册到 **`plugins.bundle.config`**，key 用 **npm 包名 `dsh-peakrate`**
 * （不是 host 配置命名空间 `peakrate`）：0.1.7 的 Plugin Manager 把
 * 「一个 bundle 自己的配置」派发到该 keyed 槽位，渲染在**该 bundle 详情页的
 * 描述与行列表之间**。
 *
 * ⚠️ 0.1.5 时代的 `settings.plugin.item` 在 0.1.7 已被删除：往它注册既不会抛错
 * 也不会渲染（`slots.inject` 的等待语义 = 永远等不到），卡片会**静默消失**。
 *
 * ## 内容
 *
 * 1. **可界面编辑的配置**（`refreshIntervalHours`）：走官方 `SettingsFormModel`
 *    的分阶段表单 —— 草稿只在 save 时写成一次 revision 围栏内的变更；host 侧该
 *    字段是 `volatile()`，改完**即时生效**、无需重启。
 * 2. **当前覆盖情况（实时）**：逐 provider 列出模型与命中情况；**整组零命中**的
 *    provider 会被顶到前面并高亮 —— 那是漏配唯一看得见的出口（2026-09-12 漏掉
 *    OpenCode Go 就是这种形态）。
 * 3. 目录来源与「立即刷新」。
 */
import * as React from 'react'
import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  settingsNumberField,
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormScope,
  type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  buildCoverage,
  suspiciousProviders,
  type CoverageGroup,
  type CoverageReport,
} from '../coverage.js'
import {
  DEFAULT_PROVIDER_ALIASES,
  type MatchConfig,
  type RateProfile,
} from '../matching.js'
import {
  fetchLiveCatalog,
  liveCatalogError,
  liveCatalogMeta,
  liveCatalogStatus,
  subscribeLiveCatalog,
} from './live.js'

/** host `peakrate` 命名空间里本页编辑的字段（服务端 schema 的一个子集）。 */
export interface PeakrateSettingsFields {
  /** 后台刷新间隔（小时）；0 = 不自动刷新。 */
  refreshIntervalHours?: number
}

/** 本页投影出来的表单状态。 */
export interface PeakrateSettingsState extends SettingsFormShell {
  /** 后台刷新间隔字段的草稿态。 */
  refreshIntervalHours: SettingsFieldState
}

/** 一个只读快照源（`@deepseek-ai/dsh-client-store` 的 SnapshotStore 结构子集）。 */
export interface SnapshotSource<T> {
  getSnapshot: () => T
  subscribe: (fn: () => void) => () => void
}

/** 注册面注入的句柄。 */
export interface PeakrateSettingsInjected extends SettingsFormActions {
  /** 表单快照（由 slot 渲染器绑定为 `useSettings` 选择器）。 */
  hooks: { settings: SnapshotSource<PeakrateSettingsState> }
  /** 本插件的倍率数据面。 */
  peakrate: {
    profiles: () => RateProfile[]
    config: () => MatchConfig
  }
  /** 只读的模型目录解析器（用于读取当前会话的 provider×model 列表）。 */
  modelDirectories?: {
    directoryFor: (sessionId: string) => {
      store: SnapshotSource<{ groups: readonly CoverageGroup[]; status: string }>
    }
  }
  /** 文案（本插件自己的 locale 命名空间）。 */
  t: (key: string, params?: Record<string, unknown>) => string
}

/** 会话列表快照（只取本页需要的字段）。 */
interface SessionListLike {
  ids: readonly string[]
  current?: string
}

/** 组件完整属性：注入面 + 标准 props（本页用到 useSessions）。 */
export type PeakrateSettingsProps = PeakrateSettingsInjected & {
  /** slot 渲染器绑定的 `hooks.settings`。 */
  useSettings: <S>(selector: (state: PeakrateSettingsState) => S) => S
  useSessions?: <S>(selector: (state: SessionListLike) => S) => S
}

/**
 * 把 host 的配置表单桥接成本页的分阶段表单。
 *
 * 与官方 `ShellCardController` 同构：草稿 → 一次 revision 围栏保存。
 */
export class PeakrateSettingsController {
  private readonly form: SettingsFormModel<PeakrateSettingsFields>
  private readonly store: SnapshotSource<PeakrateSettingsState>

  /**
   * @param scope - host `peakrate` 命名空间的配置表单（`configForms.get('peakrate')`）。
   */
  constructor(scope: SettingsFormScope<PeakrateSettingsFields>) {
    this.form = new SettingsFormModel(scope, [settingsNumberField('refreshIntervalHours')])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      refreshIntervalHours: this.form.field('refreshIntervalHours'),
    }))
  }

  /**
   * 构造注入面。
   *
   * @returns 表单快照（挂在 `hooks.settings` 上）+ 保存/丢弃动作。
   */
  inject(): { hooks: { settings: SnapshotSource<PeakrateSettingsState> } } & SettingsFormActions {
    return { hooks: { settings: this.store }, ...this.form.actions() }
  }

  /** 释放表单订阅。 */
  dispose(): void {
    this.form.dispose()
  }
}

/**
 * 配置页主体。
 *
 * @param props - 表单注入面 + 标准 props。
 */
export function PeakrateSettings(props: PeakrateSettingsProps): React.ReactElement {
  const { peakrate, t } = props
  const state = props.useSettings((s) => s)
  const profiles = peakrate.profiles()
  const config = peakrate.config()

  // 取一个会话以读取实时模型目录（本页是 root 作用域，没有 sessionId，
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

  const directoryState = React.useSyncExternalStore(
    (fn) => directory?.store.subscribe(fn) ?? (() => {}),
    () => directory?.store.getSnapshot(),
  )

  // 订阅运行时目录 + 拉取状态，让面板上的数据来源与刷新按钮实时更新
  React.useSyncExternalStore(subscribeLiveCatalog, liveCatalogStatus, liveCatalogStatus)
  const [refreshing, setRefreshing] = React.useState(false)
  const report: CoverageReport | undefined =
    directoryState === undefined
      ? undefined
      : buildCoverage(directoryState.groups ?? [], profiles, DEFAULT_PROVIDER_ALIASES, config)

  const suspicious = report === undefined ? [] : suspiciousProviders(report)
  const meta = liveCatalogMeta()
  const status = liveCatalogStatus()
  const error = liveCatalogError()

  return (
    <div className="dsh-peakrate-settings">
      <p className="dsh-peakrate-settings-desc">{t('settings.desc')}</p>

      <SettingsForm
        labels={{
          unavailable: t('settings.formUnavailable'),
          readOnly: t('settings.readOnly'),
          saveFailed: t('settings.saveFailed'),
          save: t('settings.save'),
          saving: t('settings.saving'),
        }}
        state={state}
        onSave={props.save}
        onDiscard={props.discard}
      >
        <SettingsValueField
          id="dsh-peakrate-refresh-interval"
          label={t('settings.refreshHours')}
          hint={t('settings.refreshHoursHint')}
          numeric
          disabled={!state.writable}
          {...state.refreshIntervalHours}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalidNumber')}
          onEdit={(text) => {
            props.edit('refreshIntervalHours', text)
          }}
          onReset={() => {
            props.resetField('refreshIntervalHours')
          }}
        />
      </SettingsForm>

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

      <div className="dsh-peakrate-settings-bar">
        <span className="dsh-peakrate-settings-muted">
          {t('settings.source', {
            origin:
              meta?.origin === 'remote' ? t('settings.originRemote') : t('settings.originBuiltin'),
            when: meta?.fetchedAt?.slice(0, 16).replace('T', ' ') ?? t('settings.never'),
          })}
        </span>
        <button
          type="button"
          className="dsh-peakrate-settings-refresh"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true)
            void fetchLiveCatalog({ refresh: true }).finally(() => setRefreshing(false))
          }}
        >
          {refreshing ? t('settings.refreshing') : t('settings.refreshNow')}
        </button>
      </div>
      {status === 'failed' && (
        <p className="dsh-peakrate-settings-muted">
          {t('settings.sourceFailed', { message: error ?? '' })}
        </p>
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
                    {missing.length === 0 ? '—' : missing.map((r) => r.modelName).join(', ')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
