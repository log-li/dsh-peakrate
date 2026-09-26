/**
 * client 半边入口。注册**两个互补**的呈现：
 *
 * 1. `conversation.input.left`（list · `replaceRisk: none`）——
 *    **追加式**的当前模型徽章：免开菜单即可见倍率与倒计时。
 * 2. `conversation.input.model`（single · shadows-shipped-ui）——
 *    **完整移植的官方模型选择器 + 每行倍率徽章**：展开菜单时逐行对比各模型峰谷。
 *
 * 两者并存：原显示（工具行徽章）保留不动，菜单内**新增**逐行倍率。
 *
 * 数据来源：只读共享的官方 `ctx.modelDirectories`（与 `/model` 弹窗同一实例），
 * 因此判定天然与选择器一致。
 *
 * ⚠️ 关于第 2 项的历史教训：本插件曾用**残缺的**替换实现接管该槽位，导致用户
 * 无法切换模型。现要求「**功能超集**」——官方有的交互必须全部保留（见
 * `ModelSelect.tsx` 的移植纪律）。守卫测试见 `test/bundle-contract.test.ts`。
 */
import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { formatCountdown } from '../schedule.js'
import type { MatchConfig, RateProfile } from '../matching.js'
import css from './style.css'
import { rateFor, detailLines } from './rate.js'
import { HoverCard } from './Tooltip.js'
import {
  fetchLiveCatalog,
  resolveProfiles,
  subscribeLiveCatalog,
  liveCatalogStatus,
} from './live.js'
import { RateIcon } from './icons.js'
import { ModelSelect, type DirectoryState, type SelectionOutcome } from './ModelSelect.js'
import {
  PeakrateSettings,
  PeakrateSettingsController,
  type PeakrateSettingsFields,
} from './SettingsSection.js'
import type { SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * 已知会遮蔽自带 UI、但本插件**有意接管**的槽位（附接管理由）。
 *
 * 守卫测试 `test/bundle-contract.test.ts` 会读取此清单：清单**之外**的
 * shadowing 槽位一律禁止注册；列在这里的必须满足「功能超集」。
 */
export const INTENTIONALLY_SHADOWED: Record<string, string> = {
  'conversation.input.model':
    '完整移植官方模型选择器 + 每行倍率徽章（用户要求在菜单内一览各模型倍率）。' +
    '官方组件不声明 children、组件内 0 处 renderSlot —— 无扩展点，只能重写。' +
    '移植纪律见 ModelSelect.tsx：官方交互（键盘/aria/portal/toast/effort/错误态）全保留。',
}

/** 注入面：构建期打包进 client 的 profile 快照。 */
interface PeakrateFace {
  profiles: () => RateProfile[]
  config: () => MatchConfig
}

/**
 * 默认注入面：**构建期打包进 client 的 profile 快照**。
 *
 * host 树与 client 树是两套独立 cordis 实例，client 侧拿不到 host 的
 * `ctx.get('peakrate')`，故由 `scripts/build-client.mjs` 用 `define` 注入。
 *
 * ⚠️ 已知限制：`providerAliases` / `modelMappings` / `customProfiles` 目前只在
 * host 侧生效，不影响 UI 渲染（client 用打包快照 + 内置映射）。见 README。
 */
declare const __PEAKRATE_PROFILES__: RateProfile[] | undefined

function bundledProfiles(): RateProfile[] {
  return typeof __PEAKRATE_PROFILES__ === 'undefined' ? [] : __PEAKRATE_PROFILES__
}

const DEFAULT_FACE: PeakrateFace = {
  // 运行时目录优先（host 每 24h 拉取，经带围栏的 /peakrate/catalog 下发），
  // 拉不到就静默回退到构建期内置快照 —— 首屏不等网络。
  profiles: () => resolveProfiles(bundledProfiles()),
  config: () => ({}),
}

/* ------------------------------------------------------------------ *
 * 样式注入
 * ------------------------------------------------------------------ */

/**
 * 把本插件样式插入 `document.head`（**去重**，与官方同构）。
 *
 * ⚠️ 这是一个容易漏掉的步骤：esbuild 的 `--loader:.css=text` 只把 CSS 变成
 * 字符串模块，**不会自动注入**。缺了它，CSS 类名全部无样式 ——
 * 表现为菜单 `position: static` 而跑到视口外、`max-height` 失效等
 * （2026-09-12 实测踩坑，纯 DOM/契约测试均发现不了，只有真实浏览器可见）。
 */
function injectStyles(): void {
  if (typeof document === 'undefined') return
  const tagId = 'dsh-peakrate/style.css'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-peakrate'
  tag.dataset.pluginCss = tagId
  tag.textContent = css
  document.head.appendChild(tag)
}

/* ------------------------------------------------------------------ *
 * 追加式徽章（conversation.input.left）
 * ------------------------------------------------------------------ */

/** 组件注入面：来自官方 `modelDirectories` 的**只读**句柄。 */
interface ChipProps {
  available: boolean
  directory: {
    getSnapshot: () => {
      current: { provider: string; model: string } | null
      /** 共享模型目录的分组；用于把模型 **id** 换成用户看到的**展示名**。 */
      groups?: readonly {
        id: string
        models: readonly { id: string; name: string }[]
      }[]
    }
    subscribe: (fn: () => void) => () => void
  }
  peakrate?: PeakrateFace
  /** 本地化函数（悬停详情需要按语言渲染）。 */
  t?: (key: string, params?: Record<string, unknown>) => string
}

/**
 * 紧凑倍率徽章：显示**当前模型**的倍率与倒计时。
 * 未匹配的模型**什么都不渲染**（返回 null，无占位、无灰字）。
 *
 * @param props - 注入面 + 共享模型目录。
 */
export function PeakrateChip(props: ChipProps): React.ReactElement | null {
  // 自绘悬停卡片：锚点即徽章本身；原生 title 已移除（见 Tooltip.tsx 的理由）
  const chipRef = React.useRef<HTMLSpanElement>(null)
  const [hover, setHover] = React.useState(false)
  const state = React.useSyncExternalStore(
    (fn) => props.directory.subscribe(fn),
    () => props.directory.getSnapshot(),
  )
  // 每 30 秒重算一次，让倒计时保持新鲜
  // 订阅运行时目录：host 下发到手后立即重渲染（否则要等 30s 心跳才更新）
  React.useSyncExternalStore(subscribeLiveCatalog, liveCatalogStatus, liveCatalogStatus)
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
  // 详情**只走桌面悬停**（`title`），不做点击面板 —— 用户判断：
  // 「一般只有开始用时需要看详细信息，之后看图标简略显示就够了」。
  // 「学一次」的需求由**设置卡片**承担（那里有完整覆盖表 + 规则 + 配置说明），
  // 徽章只承担「随时扫一眼」。
  const t = props.t ?? ((k: string) => k)
  // 主语 = 当前模型。优先用**用户看到的展示名**（与触发器一致，如 `DeepSeek-V41-Flash`），
  // 查不到才退回原始 id —— 直接显示 `deepseek-flash` 这种内部 id 对使用者没有意义。
  const subject =
    state.groups
      ?.find((g) => g.id === current.provider)
      ?.models.find((m) => m.id === current.model)?.name ?? current.model
  const lines = detailLines(rate, formatCountdown, t, subject)

  return React.createElement(
    'span',
    {
      ref: chipRef,
      className: `dsh-peakrate-chip dsh-peakrate-${rate.period}`,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      // 键盘可达：聚焦也展示详情（原生 title 做不到这点）
      onFocus: () => setHover(true),
      onBlur: () => setHover(false),
      tabIndex: 0,
    },
    React.createElement(
      'span',
      { className: 'dsh-peakrate-chip-badge' },
      React.createElement(RateIcon, { period: rate.period, size: 13 }),
      rate.badge,
    ),
    countdown === ''
      ? null
      : React.createElement(
          'span',
          { className: 'dsh-peakrate-chip-countdown' },
          ` · ${countdown}`,
        ),
    // 自绘悬停卡片（替代原生 title；理由见 Tooltip.tsx）
    React.createElement(
      HoverCard,
      { anchor: chipRef.current, open: hover, label: lines.join('\n') },
      lines.map((line, i) =>
        React.createElement(
          'span',
          {
            key: i,
            className: i === 0 ? 'dsh-peakrate-hover-title' : 'dsh-peakrate-hover-line',
          },
          line,
        ),
      ),
    ),
  )
}

/* ------------------------------------------------------------------ *
 * 文案（本插件自己的 locale 命名空间，措辞对照官方）
 * ------------------------------------------------------------------ */

const NS = 'peakrate-model'
const zh: Record<string, string> = {
  'provider.account': 'DeepSeek 账号',
  'trigger.fallback': '选择模型',
  'trigger.loading': '正在加载模型…',
  'trigger.selectAria': '选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'menu.aria': '模型与推理等级',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'effort.providerDefault': 'Default',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'error.sessionInUse':
    '当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。',
  retry: '重新加载',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'empty.models': '没有可用的模型。',
  'empty.efforts': '当前模型未提供推理等级。',
  // 配置页（注册在 plugins.bundle.config）
  'settings.desc':
    '按 provider + 模型判定峰谷时段，在模型选择器与 composer 工具行显示倍率与切换倒计时。',
  'settings.coverage': '当前覆盖情况',
  'settings.colProvider': 'Provider',
  'period.peak': '峰价',
  'period.offPeak': '谷价',
  'period.campaign': '活动价',
  'detail.now': '此刻 {now}',
  'detail.next': '{countdown} 后 → {next}',
  'settings.colCount': '覆盖',
  'settings.source': '目录来源：{origin} · 更新于 {when}',
  'settings.originRemote': '远端',
  'settings.originBuiltin': '内置快照',
  'settings.never': '未拉取',
  'settings.refreshNow': '立即刷新',
  'settings.refreshing': '刷新中…',
  'settings.sourceFailed': '目录拉取失败（{message}）—— 已回退到内置快照。',
  'settings.colMissing': '未收录的模型',
  'settings.noSession': '暂无会话，无法读取模型目录（打开一个会话后回到本页即可看到）。',
  'settings.suspicious': '⚠ {count} 个 provider 完全没有命中',
  'settings.suspiciousHint':
    '该 provider 下没有任何模型命中 profile。可能是「确实没有峰谷定价」，也可能是「endpoint 未被识别」——若是后者，请在 config 的 providerAliases 里补一条。',
  // 配置表单（官方 SettingsForm 的分阶段保存）
  'settings.refreshHours': '后台刷新间隔（小时）',
  'settings.refreshHoursHint': '0 = 不自动刷新；保存后立即生效，无需重启。',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.saveFailed': '保存未被接受，请重试。',
  'settings.formUnavailable': 'Host 没有提供 peakrate 配置命名空间，本页暂时不可编辑。',
  'settings.readOnly': '当前部署的配置是只读的。',
  'settings.overridden': '已自定义',
  'settings.reset': '重置',
  'settings.invalidNumber': '请输入数字，或留空以恢复默认。',
}
const en: Record<string, string> = {
  'provider.account': 'DeepSeek Account',
  'trigger.fallback': 'Select model',
  'trigger.loading': 'Loading models…',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, effort {effort}',
  'menu.aria': 'Model and reasoning effort',
  'menu.model': 'Model',
  'menu.effort': 'Reasoning effort',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model action failed: {message}',
  'error.sessionInUse':
    'This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.',
  retry: 'Reload',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'empty.models': 'No models available.',
  'empty.efforts': 'This model provides no reasoning effort.',
  'settings.desc':
    'Judges peak/off-peak per provider + model and shows the rate and countdown in the model selector and the composer tool row.',
  'settings.coverage': 'Current coverage',
  'settings.colProvider': 'Provider',
  'period.peak': 'Peak',
  'period.offPeak': 'Off-peak',
  'period.campaign': 'Campaign',
  'detail.now': 'Now {now}',
  'detail.next': 'in {countdown} → {next}',
  'settings.colCount': 'Covered',
  'settings.source': 'Catalog: {origin} · updated {when}',
  'settings.originRemote': 'remote',
  'settings.originBuiltin': 'bundled snapshot',
  'settings.never': 'never',
  'settings.refreshNow': 'Refresh now',
  'settings.refreshing': 'Refreshing…',
  'settings.sourceFailed': 'Catalog fetch failed ({message}) — fell back to the bundled snapshot.',
  'settings.colMissing': 'Not covered',
  'settings.noSession': 'No session yet — open one and come back to read the model directory.',
  'settings.suspicious': '⚠ {count} provider(s) matched nothing at all',
  'settings.suspiciousHint':
    'No model under this provider matched a profile. It may genuinely have no time-based pricing, or its endpoint is unrecognized — if the latter, add a providerAliases entry in the config.',
  'settings.refreshHours': 'Background refresh interval (hours)',
  'settings.refreshHoursHint': '0 disables auto-refresh; a save applies immediately, with no restart.',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.saveFailed': 'The save was not accepted — try again.',
  'settings.formUnavailable': 'The Host serves no peakrate configuration namespace, so this page cannot be edited.',
  'settings.readOnly': 'This deployment stores configuration read-only.',
  'settings.overridden': 'Overridden',
  'settings.reset': 'Reset',
  'settings.invalidNumber': 'Enter a number, or clear the field to restore the default.',
}

/**
 * 极简翻译器：按 `{name}` 插值；未知 key 原样返回（便于发现漏配）。
 *
 * @param dict - 语言字典。
 * @param key - 文案键。
 * @param params - 插值参数。
 */
function translate(
  dict: Record<string, string>,
  key: string,
  params?: Record<string, unknown>,
): string {
  const template = dict[key]
  if (template === undefined) return key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

/** 注入作用域上本插件用到的服务（**属性**访问，理由见 apply 的注释）。 */
interface ClientScope {
  slots?: unknown
  modelDirectories?: unknown
  sessions?: unknown
  locale?: {
    register: (ns: string, dict: Record<string, Record<string, string>>) => void
    bind: (ns: string) => (key: string, params?: Record<string, unknown>) => string
  }
}

/** slot 注册面（结构子集，避免依赖官方包的类型）。 */
interface ClientSlots {
  inject: (key: string, cb: () => () => void) => void
  register: (options: Record<string, unknown>, component: unknown) => () => void
}

/**
 * client 侧配置表单服务（`@deepseek-ai/dsh-client-ui-settings` 的 `ConfigForms`）。
 *
 * `get(entryId)` 的 entryId **就是** host 配置命名空间（0.1.7 起二者恒等）。
 */
interface SettingsFormsLike {
  get: (namespace: string) => unknown
}

/**
 * host 侧配置命名空间 —— 等于 profile 里那条 loader entry 的 `id`
 * （`cordis.patch.yml` 的 `- id: peakrate`），也就是 `settings.describe()` 的 `ns`。
 */
const SETTINGS_NAMESPACE = 'peakrate'

/**
 * client 插件入口：注册工具行徽章 + fork 的模型选择器。
 *
 * 注册要点：
 * - 用**属性访问**取服务（`scope.slots`），不用 `ctx.get()`——cordis 服务代理
 *   只在属性访问时把 `this.ctx` 绑定到调用方上下文，否则内部依赖解析不到；
 * - `conversation.input.left` 是 **list** 槽位 → 用 `id` 做纯追加；
 * - `conversation.input.model` 是 **single** 槽位 → 用 `name` 接管（有意为之）。
 *
 * @param ctx - client cordis 上下文。
 */
export function apply(ctx: Context): void {
  injectStyles()

  // 本插件自己的文案命名空间（locale 不可用时回退内置中文，不影响功能）。
  // 只注册一次，两处注册面共用同一个 `t`。
  let t: (key: string, params?: Record<string, unknown>) => string = (key, params) =>
    translate(zh, key, params)
  ctx.inject(['locale'], (injected) => {
    const locale = (injected as unknown as ClientScope).locale
    if (locale === undefined) return
    try {
      locale.register(NS, { zh, en })
      t = locale.bind(NS)
    } catch {
      /* 回退到内置中文 */
    }
  })

  ctx.inject(['slots', 'sessions', 'modelDirectories'], (injected) => {
    const scope = injected as unknown as ClientScope

    const slots = scope.slots as
      | {
          inject: (key: string, cb: () => () => void) => void
          register: (options: Record<string, unknown>, component: unknown) => () => void
        }
      | undefined
    const models = scope.modelDirectories as
      | {
          directoryFor: (sessionId: string) => {
            store: {
              getSnapshot: () => DirectoryState
              subscribe: (fn: () => void) => () => void
            }
            load: () => Promise<unknown>
            select: (s: {
              provider: string
              model: string
              reasoningEffort?: string
            }) => Promise<SelectionOutcome>
          }
        }
      | undefined
    const sessions = scope.sessions as
      | { subagentAddress: (sessionId: string) => unknown }
      | undefined

    if (slots === undefined || models === undefined || sessions === undefined) return

    // 启动即拉一次运行时目录（host 每 24h 拉取，经带围栏的 /peakrate/catalog 下发）。
    // 不阻塞首屏：拉不到就静默用构建期内置快照。
    void fetchLiveCatalog()

    // ① 追加式徽章：list 槽位，自有 id = 纯追加
    slots.inject('conversation.input.left', () =>
      slots.register(
        {
          // `name` = 槽位键；`id` = 自己的 cell 键，两者都必需
          name: 'conversation.input.left',
          id: 'peakrate',
          order: 50,
          inject: (sessionId: string) => {
            const directory = models.directoryFor(sessionId)
            return {
              available: sessions.subagentAddress(sessionId) === undefined,
              directory: directory.store,
              peakrate: DEFAULT_FACE,
              t,
            }
          },
        },
        PeakrateChip,
      ),
    )

    // ② fork 的模型选择器：single 槽位，功能超集（见 ModelSelect.tsx）
    slots.inject('conversation.input.model', () =>
      slots.register(
        {
          name: 'conversation.input.model',
          // ★ single 槽位的遮蔽规则：**同一优先级只能有一个注册**（官方占 0），
          //   且条目按 priority **升序**排列、single 只取第一个 → **最低者渲染**。
          //   因此必须给一个比 0 更低的优先级才能盖过官方实现。
          //   （不给 priority 会直接抛错：single slot already has a registration
          //    at priority 0 (registered by Z8) — register at a different priority）
          priority: -1,
          inject: (sessionId: string) => {
            const directory = models.directoryFor(sessionId)
            const available = sessions.subagentAddress(sessionId) === undefined
            return {
              available,
              directory: directory.store,
              load: () => {
                if (available) void directory.load().catch(() => {})
              },
              select: (selection: {
                provider: string
                model: string
                reasoningEffort?: string
              }) =>
                available
                  ? // ★ 原样透传官方的 `RemoteResult`（`{ ok, value } | { ok, error: { code, message } }`）。
                    //   压成 boolean 会丢掉 `error.code`，`session/writer-held`
                    //   这类专用文案就再也判不出来了。
                    directory.select(selection)
                  : Promise.resolve(undefined),
              peakrate: DEFAULT_FACE,
              t,
            }
          },
        },
        ModelSelect,
      ),
    )
  })

  // ③ 配置页：**单独一个 inject 面**。
  //
  // 刻意不把 `configForms` 并进上面那个作用域：`ctx.inject` 会等**所有**声明的
  // 服务就绪，把配置面的依赖混进去，一旦 settings 半边缺失，徽章与模型选择器的
  // 注册会被一起拖住 —— 那是「一个次要面拖垮核心面」。
  ctx.inject(['slots', 'configForms', 'modelDirectories', 'sessions'], (injected) => {
    const scope = injected as unknown as ClientScope & { configForms?: SettingsFormsLike }
    const slots = scope.slots as ClientSlots | undefined
    const configForms = scope.configForms
    if (slots === undefined || configForms === undefined) return

    const controller = new PeakrateSettingsController(
      configForms.get(SETTINGS_NAMESPACE) as SettingsFormScope<PeakrateSettingsFields>,
    )
    ctx.effect(() => () => controller.dispose(), 'peakrate: settings form')

    slots.inject('plugins.bundle.config', () =>
      slots.register(
        {
          name: 'plugins.bundle.config',
          // ★ key = **npm 包名**（`dsh-peakrate`），不是 host 配置命名空间
          //   （`peakrate`）：该槽位按「bundle 的包名」派发，见 ui-plugin-manager
          //   的 slot-contract。
          key: 'dsh-peakrate',
          inject: () => ({
            ...controller.inject(),
            peakrate: DEFAULT_FACE,
            modelDirectories: scope.modelDirectories,
            t,
          }),
        },
        PeakrateSettings,
      ),
    )
  })
}

// 供构建产物契约测试断言端到端判定（产物里必须能取到同一个判定函数）
export { rateFor } from './rate.js'

export const name = 'dsh-peakrate-client'

/**
 * 插件级 inject —— 与官方 `dsh-client-ui-model-selection` 对齐。
 *
 * - `modelDirectories.directoryFor()` 内部依赖 **`remote.session`**，缺了它会在
 *   **运行时**抛 `cannot get property "remote.session" without inject`
 *   （纯函数单测与服务端产物均正常，只有真实浏览器能暴露）；
 * - `locale` 用于注册本插件自己的文案命名空间。
 */
export const inject = [
  'slots',
  'sessions',
  'modelDirectories',
  'locale',
  'remote',
  'remote.session',
]
