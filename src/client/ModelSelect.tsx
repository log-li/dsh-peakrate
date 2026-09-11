/**
 * 模型选择器 —— **官方 `@deepseek-ai/dsh-client-ui-model-selection` 的忠实移植**，
 * 唯一的功能增量是**每个模型行显示当前峰谷倍率徽章**。
 *
 * ## 为什么是 fork（2026-09-12 二次修订）
 *
 * 用户要求在模型选择器**内部**看到各模型倍率。经核查：官方注册
 * `conversation.input.model` 时**不声明 `children`**、组件内 **0 处 `renderSlot`**
 * —— 该组件**内部没有任何扩展点**，因此只有「完整重写」一条路。
 * 官方包为 **MIT**，法律上允许。
 *
 * ## 移植纪律
 *
 * - **忠实移植，不「简化」**：键盘导航（Escape / ArrowUp / ArrowDown）、
 *   `aria-*`、portal 定位与测量、滚动/缩放重定位、外部点击关闭、失焦关闭、
 *   加载/错误/警告/重试、effort 两级菜单、busy 态、toast —— 全部保留。
 * - 上游版本：`@deepseek-ai/dsh-client-ui-model-selection@0.1.5-rc.1`。
 *   升级 DSH 时须对照重移植。
 * - 仅有的差异：① 每个模型行多一个倍率徽章；② CSS 类名加 `dsh-peakrate-ms-`
 *   前缀并用本插件自己的样式；③ 文案走本插件自己的 locale 命名空间。
 *
 * 历史教训：本插件曾用**残缺的**替换实现接管该槽位，导致用户无法切换模型。
 * 因此本次移植以「功能超集」为硬要求——**官方有的，这里必须有**。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconDataOutline16,
  IconWarningOutline16,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { formatCountdown } from '../schedule.js'
import { rateFor, type RateState } from './rate.js'
import { RateIcon } from './icons.js'
import type { MatchConfig, RateProfile } from '../matching.js'

/** 极简 classnames（官方内部打包了 clsx；本项目零依赖，自行实现等价逻辑）。 */
function clsx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** 未放置的 portal 卡片：隐藏但按固定原点布局，使 offsetWidth/Height 可测量。 */
const MEASURE_STYLE: React.CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** 模型目录快照（只取本组件需要的字段）。 */
export interface DirectoryState {
  current: { provider: string; model: string; reasoningEffort?: string } | null
  groups: readonly {
    id: string
    name: string
    models: readonly {
      id: string
      name: string
      reasoning?: {
        defaultEffort?: string
        efforts: readonly { id: string; name: string }[]
      }
    }[]
  }[]
  failures: readonly { id: string; name: string; message: string }[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

/** 注入面（与官方 slot 契约一致）。 */
export interface ModelSelectInjected {
  available: boolean
  directory: {
    getSnapshot: () => DirectoryState
    subscribe: (fn: () => void) => () => void
  }
  load: () => void
  select: (selection: {
    provider: string
    model: string
    reasoningEffort?: string
  }) => Promise<boolean>
  /** 本插件的倍率数据面。 */
  peakrate: {
    profiles: () => RateProfile[]
    config: () => MatchConfig
  }
  /** 文案（本插件自己的 locale 命名空间）。 */
  t: (key: string, params?: Record<string, unknown>) => string
}

/** 组件属性：owner share（locked）+ 注入面。 */
export type ModelSelectProps = ModelSelectInjected & { locked: boolean }

/**
 * 渲染 composer 的模型座：触发器 + 两级菜单。
 *
 * @param props - owner share + 注入面。
 */
export function ModelSelect({
  locked,
  available,
  directory,
  load,
  select,
  peakrate,
  t,
}: ModelSelectProps): React.ReactElement | null {
  const state = React.useSyncExternalStore(
    (fn) => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = React.useState(false)
  const [pane, setPane] = React.useState<'root' | 'model' | 'effort'>('root')
  const lastActionRef = React.useRef<'load' | 'select'>('load')
  const [toast, setToast] = React.useState<{ seq: number; text: string } | null>(null)
  const toastSeq = React.useRef(0)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = React.useState<{ left: number; top: number } | null>(null)
  const itemRefs = React.useRef<(HTMLElement | null)[]>([])
  const id = React.useId()

  // 每 30 秒重算倍率，保持倒计时新鲜
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const profiles = peakrate.profiles()
  const config = peakrate.config()

  const choices = React.useMemo(
    () =>
      state.groups.flatMap((group) =>
        group.models.map((model) => ({
          group,
          model,
          selection: {
            provider: group.id,
            model: model.id,
            ...(model.reasoning?.defaultEffort === undefined
              ? {}
              : { reasoningEffort: model.reasoning.defaultEffort }),
          },
        })),
      ),
    [state.groups],
  )
  const currentChoice =
    choices[
      state.current === null
        ? -1
        : choices.findIndex(
            (c) =>
              c.selection.provider === state.current?.provider &&
              c.selection.model === state.current.model,
          )
    ]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel =
    reasoning === undefined
      ? undefined
      : effectiveEffort === undefined
        ? t('effort.providerDefault')
        : (reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ??
          effectiveEffort)

  const effortChoices = React.useMemo(
    () =>
      reasoning === undefined
        ? []
        : [
            ...(reasoning.defaultEffort === undefined
              ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
              : []),
            ...reasoning.efforts.map((effort) => ({
              key: `effort:${effort.id}`,
              effort: effort.id as string | undefined,
              label: effort.name,
            })),
          ],
    [reasoning, t],
  )

  const busy = state.status === 'selecting'
  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // 外部点击关闭
  React.useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
    }
  }, [open])

  // 菜单定位：锚在触发器上方，夹在视口内；滚动/缩放时重新放置
  React.useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, state])

  if (!available) return null

  const show = (): void => {
    setPane('root')
    setOpen(true)
    reload()
  }
  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) {
      queueMicrotask(() => {
        triggerRef.current?.focus()
      })
    }
  }
  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter((item): item is HTMLElement => item !== null)
    if (items.length === 0) return
    const active = items.findIndex((item) => item === document.activeElement)
    items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus()
  }
  const onRootKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane !== 'root') setPane('root')
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }
  const onBlur = (event: React.FocusEvent): void => {
    const next = event.relatedTarget
    if (
      next instanceof Node &&
      (rootRef.current?.contains(next) === true || menuRef.current?.contains(next) === true)
    ) {
      return
    }
    close()
  }
  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }
  const choose = (selection: { provider: string; model: string }): void => {
    if (
      state.current?.provider === selection.provider &&
      state.current.model === selection.model
    ) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }
  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select({
      provider: state.current.provider,
      model: state.current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }).then(settleSelection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : (currentChoice?.model.name ??
      (state.current === null
        ? t('trigger.fallback')
        : `${state.current.provider}/${state.current.model}`))
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

  itemRefs.current = []
  let itemIndex = 0
  const itemRef = (): ((node: HTMLElement | null) => void) => {
    const at = itemIndex++
    return (node) => {
      itemRefs.current[at] = node
    }
  }

  const menu =
    open &&
    createPortal(
      <div
        ref={menuRef}
        id={`${id}-menu`}
        className="dsh-peakrate-ms-menu"
        style={menuPos ?? MEASURE_STYLE}
        role="menu"
        aria-label={t('menu.aria')}
        aria-busy={state.status === 'loading' || busy}
      >
        {pane === 'root' && (
          <>
            <button
              ref={itemRef()}
              type="button"
              role="menuitem"
              className="dsh-peakrate-ms-cell"
              onClick={() => setPane('model')}
            >
              <span className="dsh-peakrate-ms-cellLabel">{t('menu.model')}</span>
              <span className="dsh-peakrate-ms-cellValue">{modelLabel}</span>
              <IconChevronRightOutline14 className="dsh-peakrate-ms-cellChevron" />
            </button>
            {reasoning !== undefined && (
              <button
                ref={itemRef()}
                type="button"
                role="menuitem"
                className="dsh-peakrate-ms-cell"
                onClick={() => setPane('effort')}
              >
                <span className="dsh-peakrate-ms-cellLabel">{t('menu.effort')}</span>
                <span className="dsh-peakrate-ms-cellValue">{effortLabel}</span>
                <IconChevronRightOutline14 className="dsh-peakrate-ms-cellChevron" />
              </button>
            )}
          </>
        )}

        {pane === 'model' && (
          <>
            {state.status === 'loading' && (
              <div className="dsh-peakrate-ms-status">{t('status.loading')}</div>
            )}
            {state.error !== null && lastActionRef.current === 'load' && (
              <div className="dsh-peakrate-ms-error">
                <span>{t('error.action', { message: state.error })}</span>
                <button type="button" className="dsh-peakrate-ms-retry" onClick={reload}>
                  {t('retry')}
                </button>
              </div>
            )}
            {state.failures.map((failure) => (
              <div className="dsh-peakrate-ms-warning" key={failure.id}>
                <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                <button type="button" className="dsh-peakrate-ms-retry" onClick={reload}>
                  {t('retry')}
                </button>
              </div>
            ))}
            <div className={clsx('dsh-peakrate-ms-groups', 'scrollable')}>
              {state.groups.map((group) => {
                const headingId = `${id}-${group.id}`
                return (
                  <section
                    role="group"
                    aria-labelledby={headingId}
                    className="dsh-peakrate-ms-group"
                    key={group.id}
                  >
                    <div className="dsh-peakrate-ms-groupTitle" id={headingId}>
                      {group.name}
                    </div>
                    {group.models.map((model) => {
                      const selected =
                        state.current?.provider === group.id && state.current.model === model.id
                      // ★ 本插件的增量：该模型此刻的峰谷倍率
                      const rate = rateFor(group.id, model.id, profiles, config, now)
                      return (
                        <button
                          ref={itemRef()}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={clsx(
                            'dsh-peakrate-ms-option',
                            selected && 'dsh-peakrate-ms-selected',
                          )}
                          title={rate === undefined ? model.name : `${model.name}\n${rateDetail(rate)}`}
                          disabled={busy}
                          onClick={() => choose({ provider: group.id, model: model.id })}
                          key={model.id}
                        >
                          <span className="dsh-peakrate-ms-optionCopy">
                            <span className="dsh-peakrate-ms-modelName">{model.name}</span>
                          </span>
                          <RateChip state={rate} />
                          <span className="dsh-peakrate-ms-check">
                            {selected ? <IconCheckOutline16 /> : null}
                          </span>
                        </button>
                      )
                    })}
                  </section>
                )
              })}
            </div>
            {state.status === 'ready' && choices.length === 0 && (
              <div className="dsh-peakrate-ms-empty">{t('empty.models')}</div>
            )}
          </>
        )}

        {pane === 'effort' && (
          <>
            {state.error !== null && lastActionRef.current === 'load' && (
              <div className="dsh-peakrate-ms-error">
                <span>{t('error.action', { message: state.error })}</span>
                <button type="button" className="dsh-peakrate-ms-retry" onClick={reload}>
                  {t('action.reload')}
                </button>
              </div>
            )}
            {effortChoices.length === 0 ? (
              <div className="dsh-peakrate-ms-empty">{t('empty.efforts')}</div>
            ) : (
              effortChoices.map((level) => (
                <button
                  ref={itemRef()}
                  type="button"
                  role="menuitemradio"
                  aria-checked={effectiveEffort === level.effort}
                  className={clsx(
                    'dsh-peakrate-ms-option',
                    effectiveEffort === level.effort && 'dsh-peakrate-ms-selected',
                  )}
                  disabled={busy}
                  onClick={() => chooseEffort(level.effort)}
                  key={level.key}
                >
                  <span className="dsh-peakrate-ms-optionCopy">
                    <span className="dsh-peakrate-ms-modelName">{level.label}</span>
                  </span>
                  <span className="dsh-peakrate-ms-check">
                    {effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
                  </span>
                </button>
              ))
            )}
          </>
        )}
      </div>,
      document.body,
    )

  return (
    <div ref={rootRef} className="dsh-peakrate-ms-root" onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-peakrate-ms-trigger"
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) close()
          else show()
        }}
      >
        <IconDataOutline16 className="dsh-peakrate-ms-triggerIcon" size={16} />
        <span className="dsh-peakrate-ms-triggerLabel">{modelLabel}</span>
        {effortLabel !== undefined && (
          <span className="dsh-peakrate-ms-triggerEffort">{effortLabel}</span>
        )}
        <IconChevronDownOutline14
          className={clsx('dsh-peakrate-ms-chevron', open && 'dsh-peakrate-ms-chevronOpen')}
        />
      </button>
      {menu}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest('[data-composer-card]') ?? null}
          onDone={() => {
            setToast(null)
          }}
        />
      )}
    </div>
  )
}

/** 行内倍率徽章：未匹配时不渲染任何内容。 */
function RateChip({ state }: { state: RateState | undefined }): React.ReactElement | null {
  if (state === undefined) return null
  const countdown = state.minutesUntilSwitch
  return (
    <span className={clsx('dsh-peakrate-ms-rate', `dsh-peakrate-${state.period}`)}>
      <RateIcon period={state.period} size={13} />
      {state.badge}
      {formatCountdown(countdown) === '' ? null : (
        <span className="dsh-peakrate-ms-rateCountdown">
          {` · ${formatCountdown(countdown)}`}
        </span>
      )}
    </span>
  )
}

/** 菜单行 title 里的详情文案。 */
function rateDetail(state: RateState): string {
  const name = state.period === 'peak' ? state.profile.peakName : state.profile.offPeakName
  return `${state.profile.providerName} · ${name}（${state.badge}）`
}
