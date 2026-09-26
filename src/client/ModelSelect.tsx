/**
 * 模型选择器 —— 官方 `@deepseek-ai/dsh-client-ui-model-selection` 的**忠实移植**，
 * 唯一的功能增量是**每个模型行显示当前峰谷倍率徽章**。
 *
 * ## 上游基线
 *
 * **`0.1.7-rc.2`**（DSH tag `dsh-v0.1.7-rc.2`）。此前的移植基线是 `0.1.5-rc.1`，
 * 0.1.7 更换了 UI primitive 命名（`Icon*OutlineRegular`）、把 busy 判据从
 * `status === 'selecting'` 改为 `pending !== null`、并引入 `retainedEffort`；
 * 不重基线会在 render 期拿到 `undefined` 图标组件（React「Element type is invalid」），
 * 也就是「用户换不了模型」那一类事故。升级 DSH 时须对照上游重移植。
 *
 * ## 为什么是 fork
 *
 * 用户要求在模型选择器**内部**看到各模型倍率。官方注册
 * `conversation.input.model` 时**不声明 `children`**、组件内 **0 处 `renderSlot`**
 * —— 该组件**内部没有任何扩展点**，因此只有「完整重写」一条路。官方包为
 * **MIT**，法律上允许；本项目自行实现（不复制上游源码），仅在结构与交互语义上
 * 逐项对齐，便于日后对照重移植。
 *
 * ## 移植纪律（功能超集）
 *
 * 官方有的交互**一个都不能少**：两级菜单（模型 / 推理等级）、键盘导航
 * （↑/↓ 循环、Escape/Shift+Tab 逐级返回、Tab 等同 Enter 落定）、焦点交还
 * （drill 落到当前值行、返回落到打开的 cell）、`MenuSurface` portal 定位与
 * 滚动/缩放重测量、外部点击与失焦关闭、加载/错误/警告/重试、`pending` 行内
 * spinner 与触发器 spinner、`aria-*`、`RemoteResult` 语义（含 `session/writer-held`
 * 专用文案）、`retainedEffort`、官方 provider 排序、`deepseek-account` 展示名。
 *
 * 本文件**仅有的偏离**（都在下方就地标注）：
 * ① 每个模型行多一个倍率徽章（本插件的存在理由）；
 * ② 行 `title` 在命中倍率时附加详情（原生 tooltip，纯增量信息）；
 * ③ `select()` 的 rejection 兜底 —— 官方只 `.then()`，一旦 Promise 拒绝，
 *    `pending` 永远不落定、整个菜单持续 disabled（用户再也点不动模型）。
 *    这里把 rejection 也收敛成一次失败 toast。
 *
 * 历史教训：本插件曾用**残缺的**替换实现接管该槽位，导致用户无法切换模型。
 * 因此本次移植以「功能超集」为硬要求。守卫测试见 `test/bundle-contract.test.ts`。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  MenuSurface,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconDataOutlineRegular,
  IconWarningOutlineRegular,
  StateDot,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { formatCountdown } from '../schedule.js'
import { detailText, type Translate, rateFor, type RateState } from './rate.js'
import { RateIcon } from './icons.js'
import type { MatchConfig, RateProfile } from '../matching.js'

/** 极简 classnames（官方内部打包了 clsx；本项目零依赖，自行实现等价逻辑）。 */
function clsx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** 未放置的 portal 卡片：隐藏但按固定原点布局，使 offsetWidth/Height 可测量。 */
const MEASURE_STYLE: React.CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** 菜单当前展示的面板：两行的根面板，或钻进去的某一列表。 */
type Pane = 'root' | 'model' | 'effort'

/** 一条完整的模型选择（provider + provider 自己的 model id + 可选推理等级）。 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 目录里一个模型（只取本组件需要的字段）。 */
export interface DirectoryModel {
  id: string
  name: string
  reasoning?: {
    defaultEffort?: string
    efforts: readonly { id: string; name: string }[]
  }
}

/** 目录里一个 provider 分组。 */
export interface DirectoryGroup {
  id: string
  name: string
  models: readonly DirectoryModel[]
}

/** 上一次目录加载里**局部失败**的 provider（仍然可用的分组保持可用）。 */
export interface DirectoryFailure {
  id: string
  name: string
  message: string
}

/**
 * 模型目录快照 —— 字段对齐官方 `ModelDirectoryState`（0.1.7-rc.2）里本组件
 * 真正读取的部分。
 *
 * 注：官方 state 里的 `routable` 只被 `/model` 弹窗消费，本组件（composer 座）
 * 不读它，故不在此声明 —— 声明用不到的字段只会掩盖真实的依赖面。
 */
export interface DirectoryState {
  /** 已保存的选择；即使其 provider / model 已离开目录也保留。 */
  current: ModelSelection | null
  /** 选中模型暂时不在目录里时保留的 effort 文案。 */
  retainedEffort?: string
  groups: readonly DirectoryGroup[]
  failures: readonly DirectoryFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** 最近一次 `select` 提交、尚未落定的选择；否则 null。 */
  pending: ModelSelection | null
  error: string | null
}

/**
 * `select()` 的结果 —— 与官方 `RemoteResult<void>` **结构对齐**的本地子集。
 *
 * 刻意保留 `error.code` / `error.message` 而不是压成 boolean：官方用
 * `code === 'session/writer-held'` 判定「会话被别的 DSH 占用」并给专用文案，
 * 压平之后就只剩一句无差别的失败提示。
 */
export type SelectionOutcome =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** 注入面（结构对齐官方 slot 契约，另加本插件的倍率数据面与文案）。 */
export interface ModelSelectInjected {
  /** 本会话是否支持 Agent 绑定的模型查看与选择（子代理会话为 false）。 */
  available: boolean
  /** 本会话的共享目录 store（与自带 `/model` 弹窗同一实例）。 */
  directory: {
    getSnapshot: () => DirectoryState
    subscribe: (fn: () => void) => () => void
  }
  /** 确保共享目录已加载（错误落在 store 上）。 */
  load: () => void
  /** 提交一次完整选择；本会话不可选择时返回 undefined。 */
  select: (selection: ModelSelection) => Promise<SelectionOutcome | undefined>
  /** 本插件的倍率数据面。 */
  peakrate: {
    profiles: () => RateProfile[]
    config: () => MatchConfig
  }
  /** 文案（本插件自己的 locale 命名空间）。 */
  t: Translate
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
  const [pane, setPane] = React.useState<Pane>('root')
  // 菜单内的错误条只服务**目录加载**（它的 Retry 重跑 load）；被拒绝的
  // **选择**改由瞬时 toast 播报，因此这里记住最近一次动作是谁。
  const lastActionRef = React.useRef<'load' | 'select'>('load')
  const [toast, setToast] = React.useState<{ seq: number; text: string } | null>(null)
  const toastSeq = React.useRef(0)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = React.useState<React.CSSProperties | null>(null)
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([])
  const id = React.useId()

  // 本插件的增量：每 30 秒重算倍率，保持倒计时新鲜
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // 官方排序：`deepseek-account` → `deepseek-official` → 其余（保持原相对次序）。
  // 用 `[...].sort` 而非 `toSorted`：本项目 tsconfig 的 lib 是 ES2022。
  const groups = React.useMemo(
    () =>
      [...state.groups].sort(
        (left, right) => groupRank(left.id) - groupRank(right.id),
      ),
    [state.groups],
  )
  const choices = React.useMemo(
    () =>
      groups.flatMap((group) =>
        group.models.map((model) => ({
          group,
          model,
          selection: {
            provider: group.id,
            model: model.id,
            ...(model.reasoning?.defaultEffort === undefined
              ? {}
              : { reasoningEffort: model.reasoning.defaultEffort }),
          } satisfies ModelSelection,
        })),
      ),
    [groups],
  )
  const selectedIndex =
    state.current === null
      ? -1
      : choices.findIndex(
          (c) =>
            c.selection.provider === state.current?.provider &&
            c.selection.model === state.current.model,
        )
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  // 当前模型暂时不在目录里（`reasoning === undefined`）时，官方回退到保留的
  // effort 文案，而不是把触发器上的等级凭空抹掉。
  const effortLabel =
    reasoning === undefined
      ? state.retainedEffort
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
  const { pending } = state
  // ★ 0.1.7 的 busy 判据是「有一次选择未落定」，不是「status === 'selecting'」
  //   —— 后者在目录刷新、连接重置等路径下会漏判。
  const busy = pending !== null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // 外部点击关闭（portal 卡片在触发器子树之外，两处都要查）
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

  // 换面板会卸载当时持有焦点的行，焦点于是掉到 body（卡片子树之外，键盘再也
  // 进不来）。因此每次换面板都必须指名焦点落点：drill 落到「当前值」那一行，
  // 返回则落到打开该面板的 cell。
  const paneFocus = React.useRef<'drill' | 'model' | 'effort' | null>(null)
  React.useEffect(() => {
    const intent = paneFocus.current
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      const checked = menuRef.current?.querySelector<HTMLElement>(
        '[role="menuitemradio"][aria-checked="true"]:not([disabled])',
      )
      const target = checked ?? itemRefs.current.find((item) => item !== null && !item.disabled)
      // 有选择在飞行时行是 disabled 的，拿不到焦点；交给触发器，卡片上的按键
      // 仍能到达菜单。
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const cell = itemRefs.current[intent === 'effort' ? 1 : 0]
    ;(cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane])

  // portal 定位：锚在触发器上方、右边缘对齐；先测量再绘制，并夹在视口内。
  // 依赖 pane 与目录状态 —— 换面板与异步加载都会改变卡片尺寸。
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
      const y0 = rect.top - 8 - lh
      let y = y0
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    // 首次与 `open` 同一个 commit 上运行：先测量隐藏的预渲染，再绘制。
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
    triggerRef.current?.focus()
    if (state.current === null) paneFocus.current = 'drill'
    setPane(state.current === null ? 'model' : 'root')
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

  const drill = (next: Pane): void => {
    paneFocus.current = 'drill'
    setPane(next)
  }

  /** 从钻进去的面板退回根面板，把键盘交回打开它的那个 cell。 */
  const back = (from: Exclude<Pane, 'root'>): void => {
    paneFocus.current = from
    setPane('root')
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
    if (items.length === 0) return
    const active = items.findIndex((item) => item === document.activeElement)
    // 焦点还在行之外（刚打开时在触发器上）：从**来的那一端**进入 ——
    // 向下走落到第一行，向上走落到最后一行。
    const next =
      active === -1
        ? offset > 0
          ? 0
          : items.length - 1
        : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape 先退出一层钻进去的面板，再关闭。
      if (pane !== 'root' && state.current !== null) back(pane)
      else close(true)
      return
    }
    if (!open) return
    // Tab 等同 Enter 落定、Shift+Tab 等同 Escape 返回 —— 菜单里的键在 composer
    // 里也是这个意思。两者都被消费掉：卡片打开时不允许浏览器的焦点遍历跑掉。
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root' && state.current !== null) back(pane)
        else close(true)
        return
      }
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      // 落定键盘所在的那一行；焦点若还在触发器上，则从「当前值」进入菜单。
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      // 卡片里其它控件（如重试按钮）保留浏览器自己的遍历，所以这里不消费。
      if (focused !== triggerRef.current) return
      event.preventDefault()
      const checked = menuRef.current?.querySelector<HTMLElement>(
        '[role="menuitemradio"][aria-checked="true"]:not([disabled])',
      )
      ;(checked ?? rows.find((item) => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget
    if (
      next instanceof Node &&
      (rootRef.current?.contains(next) === true || menuRef.current?.contains(next) === true)
    ) {
      return
    }
    close()
  }

  const settleSelection = (
    result: Awaited<ReturnType<ModelSelectInjected['select']>>,
  ): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) close(true)
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text:
        error.code === 'session/writer-held'
          ? t('error.sessionInUse')
          : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const submit = (selection: ModelSelection): void => {
    lastActionRef.current = 'select'
    // 选择在飞行时行是 disabled 的，留不住焦点。
    triggerRef.current?.focus()
    // ★ 偏离③：官方只 `.then()`。Promise 若拒绝（连接断裂等），`pending` 永不
    //   落定 → 整个菜单持续 disabled，用户再也点不动模型。这里把 rejection
    //   也收敛成一次失败播报，保证 UI 一定能回到可用态。
    void select(selection)
      .then(settleSelection)
      .catch((error: unknown) => {
        settleSelection({
          ok: false,
          error: {
            code: 'peakrate/select-failed',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })
  }

  const choose = (selection: ModelSelection): void => {
    if (
      state.current?.provider === selection.provider &&
      state.current.model === selection.model
    ) {
      close(true)
      return
    }
    submit(selection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    submit({
      provider: state.current.provider,
      model: state.current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    })
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

  const profiles = peakrate.profiles()
  const config = peakrate.config()

  itemRefs.current = []
  let itemIndex = 0
  const itemRef = (): ((node: HTMLButtonElement | null) => void) => {
    const at = itemIndex++
    return (node) => {
      itemRefs.current[at] = node
    }
  }

  const menu =
    open &&
    createPortal(
      // Portal 到 body（Menu primitive 的 portal 模式）：侧栏与列的 overflow
      // 裁不到卡片；合成事件仍沿本 React 子树冒泡，故 onKeyDown/onBlur 仍有效。
      <MenuSurface
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
              onClick={() => drill('model')}
            >
              <span className="dsh-peakrate-ms-cellLabel">{t('menu.model')}</span>
              <span className="dsh-peakrate-ms-cellValue">{modelLabel}</span>
              <IconChevronRightOutlineRegular className="dsh-peakrate-ms-cellChevron" />
            </button>
            {reasoning !== undefined && (
              <button
                ref={itemRef()}
                type="button"
                role="menuitem"
                className="dsh-peakrate-ms-cell"
                onClick={() => drill('effort')}
              >
                <span className="dsh-peakrate-ms-cellLabel">{t('menu.effort')}</span>
                <span className="dsh-peakrate-ms-cellValue">{effortLabel}</span>
                <IconChevronRightOutlineRegular className="dsh-peakrate-ms-cellChevron" />
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
                <span>
                  {t('warning.groupLoad', {
                    name: providerLabel(failure, t),
                    message: failure.message,
                  })}
                </span>
                <button type="button" className="dsh-peakrate-ms-retry" onClick={reload}>
                  {t('retry')}
                </button>
              </div>
            ))}
            <div className={clsx('dsh-peakrate-ms-groups', 'scrollable')}>
              {groups.map((group) => {
                const headingId = `${id}-${group.id}`
                return (
                  <section
                    role="group"
                    aria-labelledby={headingId}
                    className="dsh-peakrate-ms-group"
                    key={group.id}
                  >
                    <div className="dsh-peakrate-ms-groupTitle" id={headingId}>
                      {group.id === 'deepseek-account' ? t('provider.account') : group.name}
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
                          // ★ 偏离②：命中倍率时在原生 tooltip 里补详情（纯增量信息）
                          title={rate === undefined ? model.name : `${model.name}\n${rateDetail(rate, t)}`}
                          disabled={busy}
                          onClick={() => choose({ provider: group.id, model: model.id })}
                          key={model.id}
                        >
                          <span className="dsh-peakrate-ms-optionCopy">
                            <span className="dsh-peakrate-ms-modelName">{model.name}</span>
                          </span>
                          <RateChip state={rate} />
                          <span className="dsh-peakrate-ms-check">
                            {pending?.provider === group.id && pending.model === model.id ? (
                              <StateDot state="ongoing" />
                            ) : selected ? (
                              <IconCheckOutlineRegular />
                            ) : null}
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
                    {pending !== null &&
                    pending.provider === state.current?.provider &&
                    pending.model === state.current.model &&
                    pending.reasoningEffort === level.effort ? (
                      <StateDot state="ongoing" />
                    ) : effectiveEffort === level.effort ? (
                      <IconCheckOutlineRegular />
                    ) : null}
                  </span>
                </button>
              ))
            )}
          </>
        )}
      </MenuSurface>,
      document.body,
    )

  return (
    <div
      ref={rootRef}
      className="dsh-peakrate-ms-root"
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit 会在 click 前先失焦那一行，除非 button 的 mousedown 保住焦点。
        if (event.target instanceof Element && event.target.closest('button') !== null) {
          event.preventDefault()
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="dsh-peakrate-ms-trigger"
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={busy}
        disabled={locked}
        onClick={() => {
          if (open) close(true)
          else show()
        }}
      >
        <IconDataOutlineRegular className="dsh-peakrate-ms-triggerIcon" size={16} />
        <span className="dsh-peakrate-ms-triggerLabel">{modelLabel}</span>
        {effortLabel !== undefined && (
          <span className="dsh-peakrate-ms-triggerEffort">{effortLabel}</span>
        )}
        {busy ? (
          <StateDot state="ongoing" />
        ) : (
          <IconChevronDownOutlineRegular
            className={clsx('dsh-peakrate-ms-chevron', open && 'dsh-peakrate-ms-chevronOpen')}
          />
        )}
      </button>
      {menu}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => {
            setToast(null)
          }}
        />
      )}
    </div>
  )
}

/** 官方 provider 排序权重：账号 → 官方 → 其余。 */
function groupRank(id: string): number {
  return id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2
}

/** `deepseek-account` 用官方展示名，其余用目录自带名。 */
function providerLabel(
  provider: { id: string; name: string },
  t: Translate,
): string {
  return provider.id === 'deepseek-account' ? t('provider.account') : provider.name
}

/** 行内倍率徽章：未匹配时不渲染任何内容。 */
function RateChip({ state }: { state: RateState | undefined }): React.ReactElement | null {
  if (state === undefined) return null
  const countdown = formatCountdown(state.minutesUntilSwitch)
  return (
    <span className={clsx('dsh-peakrate-ms-rate', `dsh-peakrate-${state.period}`)}>
      <RateIcon period={state.period} size={13} />
      {state.badge}
      {countdown === '' ? null : (
        <span className="dsh-peakrate-ms-rateCountdown">{` · ${countdown}`}</span>
      )}
    </span>
  )
}

/**
 * 菜单行 title 里的详情文案 —— 与 composer 徽章**共用同一套本地化详情**
 * （`detailText`），避免两处各造一套格式、也避免其中一处漏翻。
 */
function rateDetail(state: RateState, t: Translate): string {
  return detailText(state, formatCountdown, t)
}
