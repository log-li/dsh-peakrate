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
import { rateFor, detailText } from './rate.js'
import { RateIcon } from './icons.js'
import { ModelSelect, type DirectoryState } from './ModelSelect.js'
import { PeakrateSettings } from './SettingsSection.js'

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
  profiles: () => bundledProfiles(),
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
    getSnapshot: () => { current: { provider: string; model: string } | null }
    subscribe: (fn: () => void) => () => void
  }
  peakrate?: PeakrateFace
}

/**
 * 紧凑倍率徽章：显示**当前模型**的倍率与倒计时。
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
  // 详情**只走桌面悬停**（`title`），不做点击面板 —— 用户判断：
  // 「一般只有开始用时需要看详细信息，之后看图标简略显示就够了」。
  // 「学一次」的需求由**设置卡片**承担（那里有完整覆盖表 + 规则 + 配置说明），
  // 徽章只承担「随时扫一眼」。
  return React.createElement(
    'span',
    {
      className: `dsh-peakrate-chip dsh-peakrate-${rate.period}`,
      title: detailText(rate, formatCountdown),
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
  )
}

/* ------------------------------------------------------------------ *
 * 文案（本插件自己的 locale 命名空间，措辞对照官方）
 * ------------------------------------------------------------------ */

const NS = 'peakrate-model'
const zh: Record<string, string> = {
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
  retry: '重新加载',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'empty.models': '没有可用的模型。',
  'empty.efforts': '当前模型未提供推理等级。',
  // 设置页
  'settings.title': '模型峰谷倍率',
  'settings.desc':
    '按 provider + 模型判定峰谷时段，在模型选择器与 composer 工具行显示倍率与切换倒计时。',
  'settings.coverage': '当前覆盖情况',
  'settings.rules': '匹配规则',
  'settings.howto': '如何自定义',
  'settings.colProvider': 'Provider',
  'settings.colModel': '模型',
  'settings.colRate': '当前倍率',
  'settings.colProfile': '命中 profile',
  'settings.colTarget': '映射到 / 不映射的理由',
  'settings.notCovered': '未收录',
  'settings.noSession': '暂无会话，无法读取模型目录（打开一个会话后回到本页即可看到）。',
  'settings.noSessionShort': '暂无会话数据',
  'settings.summary': '已覆盖 {covered} / {total} 个模型',
  'settings.summaryWarn': ' · ⚠ {count} 个 provider 未命中',
  'settings.noModels': '该 provider 未提供模型。',
  'settings.suspicious': '⚠ {count} 个 provider 完全没有命中',
  'settings.suspiciousHint':
    '该 provider 下没有任何模型命中 profile。可能是「确实没有峰谷定价」，也可能是「endpoint 未被识别」——若是后者，请用下面的 config 补充 providerAliases。',
  'settings.rulesDesc': '内置 {profiles} 个 profile、{providers} 条 provider 映射。',
}
const en: Record<string, string> = {
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
  retry: 'Reload',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'empty.models': 'No models available.',
  'empty.efforts': 'This model provides no reasoning effort.',
  'settings.title': 'Model peak rates',
  'settings.desc':
    'Judges peak/off-peak per provider + model and shows the rate and countdown in the model selector and the composer tool row.',
  'settings.coverage': 'Current coverage',
  'settings.rules': 'Matching rules',
  'settings.howto': 'How to customize',
  'settings.colProvider': 'Provider',
  'settings.colModel': 'Model',
  'settings.colRate': 'Current rate',
  'settings.colProfile': 'Matched profile',
  'settings.colTarget': 'Mapped to / reason for skipping',
  'settings.notCovered': 'not covered',
  'settings.noSession': 'No session yet — open one and come back to read the model directory.',
  'settings.noSessionShort': 'No session data',
  'settings.summary': '{covered} / {total} models covered',
  'settings.summaryWarn': ' · ⚠ {count} provider(s) unmatched',
  'settings.noModels': 'This provider exposes no models.',
  'settings.suspicious': '⚠ {count} provider(s) matched nothing at all',
  'settings.suspiciousHint':
    'No model under this provider matched a profile. It may genuinely have no time-based pricing, or its endpoint is unrecognized — if the latter, add a providerAliases entry below.',
  'settings.rulesDesc': '{profiles} bundled profile(s), {providers} provider mapping(s).',
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

  ctx.inject(['slots', 'sessions', 'modelDirectories', 'locale'], (injected) => {
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
            }) => Promise<void>
          }
        }
      | undefined
    const sessions = scope.sessions as
      | { subagentAddress: (sessionId: string) => unknown }
      | undefined

    if (slots === undefined || models === undefined || sessions === undefined) return

    // 本插件自己的文案命名空间（locale 不可用时回退内置中文，不影响功能）
    let t: (key: string, params?: Record<string, unknown>) => string = (key, params) =>
      translate(zh, key, params)
    const locale = scope.locale
    if (locale !== undefined) {
      try {
        locale.register(NS, { zh, en })
        t = locale.bind(NS)
      } catch {
        /* 回退到内置中文 */
      }
    }

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
            }
          },
        },
        PeakrateChip,
      ),
    )

    // ② 插件卡片：出现在「设置 → 插件 → 插件配置」。
    //    keyed 槽位按 **Host 提供的 settings 命名空间** 派发 key，因此 key 必须是
    //    我们自己的命名空间名（`peakrate`，在 settings.yaml 里）。
    slots.inject('settings.plugin.item', () =>
      slots.register(
        {
          name: 'settings.plugin.item',
          key: 'peakrate',
          inject: () => ({
            peakrate: DEFAULT_FACE,
            modelDirectories: models,
            t,
          }),
        },
        PeakrateSettings,
      ),
    )

    // ③ fork 的模型选择器：single 槽位，功能超集（见 ModelSelect.tsx）
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
                  ? directory.select(selection).then(
                      () => true,
                      () => false,
                    )
                  : Promise.resolve(false),
              peakrate: DEFAULT_FACE,
              t,
            }
          },
        },
        ModelSelect,
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
