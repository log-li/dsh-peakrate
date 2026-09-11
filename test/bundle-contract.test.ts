/**
 * 构建产物契约测试 —— 从**构建产物**出发验证 client 半边的注册契约。
 *
 * 背景（2026-09-12 两次实机事故）：
 * 1. client 注册 slot 时漏传 `inject` 注入面 → 组件拿不到数据 → UI 一个徽章都不显示；
 * 2. 注册到 `conversation.input.model`（single + replaceRisk: shadows-shipped-ui）
 *    → **遮蔽自带模型选择器**，且替换实现残缺 → **用户无法切换模型**。
 *
 * 两次都是「纯函数单测全绿、实机才炸」。本文件因此从构建产物出发验证**注册契约**，
 * 特别是**绝不允许注册到会遮蔽自带 UI 的槽位**。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const clientBundle = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/**
 * 已知会**遮蔽自带 UI** 的槽位（replaceRisk: shadows-shipped-ui）。
 * 本插件必须**永不**注册到这些槽位——注册即替换官方实现。
 *
 * 来源：Client Slots Inspect Provider（listSubTree）实测。
 */
const SHADOWING_SLOTS = [
  'conversation.input.model', // single · 模型选择器（2026-09-12 事故槽位）
  'conversation.composer.bar',
  'conversation.composer',
  'conversation.session',
  'conversation.input.plan',
  'conversation.input.attachments',
  'sidebar',
  'main',
  'rightbar',
  'root',
]

/** 在模拟浏览器环境下执行 client bundle，返回其导出的模块。 */
function loadBundle(): Record<string, unknown> {
  const code = readFileSync(clientBundle, 'utf8')
  const fakeReact = {
    createElement: () => null,
    useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
  }
  let mod: Record<string, unknown> | undefined
  const win = {
    __ModuleLoader__: {
      load: ({ factory }: { factory: (r: (n: string) => unknown) => Record<string, unknown> }) => {
        mod = factory((name: string) => (name === 'react' ? fakeReact : null))
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', code)(win)
  if (mod === undefined) throw new Error('bundle 未调用 __ModuleLoader__.load')
  return mod
}

/** 记录 apply() 实际注册到的槽位与选项。 */
interface Registration {
  slot: string
  options: Record<string, unknown>
}

/**
 * 用假的 client ctx 跑一遍 apply()，捕获注册行为。
 *
 * 复刻真实契约：`ctx.inject(deps, cb)` 会以「有 get() 的 scope」回调，
 * 且提供 slots / modelDirectories / sessions 三个服务。
 */
function captureRegistration(): Registration[] {
  return captureWith({ subagentAddress: () => undefined }).regs
}

/** 可按需定制 sessions 服务的捕获。 */
function captureWith(sessions: {
  subagentAddress: (sessionId: string) => unknown
}): { regs: Registration[]; opts: () => Record<string, unknown> } {
  const mod = loadBundle() as { apply: (ctx: unknown) => void }
  const out: Registration[] = []
  let pendingSlot = ''

  const slots = {
    inject: (key: string, cb: () => () => void) => {
      pendingSlot = key
      return cb()
    },
    register: (opts: Record<string, unknown>) => {
      out.push({ slot: pendingSlot, options: opts })
      return () => {}
    },
  }
  const modelDirectories = {
    directoryFor: () => ({
      store: { getSnapshot: () => ({ current: null }), subscribe: () => () => {} },
    }),
  }

  // 注入作用域：**以属性**暴露服务（cordis 的服务代理要求属性访问才绑定调用方
  // 上下文；实现里也因此不能用 get()，否则运行时抛 remote.session 缺 inject）。
  const fakeCtx = {
    inject: (
      _deps: string[],
      cb: (scope: {
        slots: unknown
        modelDirectories: unknown
        sessions: unknown
      }) => void,
    ) => {
      cb({ slots, modelDirectories, sessions })
    },
  }
  mod.apply(fakeCtx)
  return { regs: out, opts: () => out[0]!.options }
}

beforeAll(() => {
  if (!existsSync(clientBundle)) {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' })
  }
}, 180_000)

describe('client bundle 格式契约', () => {
  it('是 __ModuleLoader__ 包裹的 CJS（无裸 ESM import）', () => {
    const code = readFileSync(clientBundle, 'utf8')
    expect(code.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(/^\s*import\s/m.test(code)).toBe(false)
    expect(/^\s*export\s/m.test(code)).toBe(false)
  })

  it('能被 classic script 语法解析', () => {
    const code = readFileSync(clientBundle, 'utf8')
    expect(() => new Function('window', code)).not.toThrow()
  })

  it('导出 apply 与 name', () => {
    const mod = loadBundle()
    expect(typeof mod.apply).toBe('function')
    expect(mod.name).toBe('dsh-peakrate-client')
  })

  /** ★ 回归：插件级 inject 必须包含 modelDirectories 运行所需的依赖。
   *
   * `modelDirectories.directoryFor()` 内部要解析会话的模型选择投影，依赖
   * `remote.session`。缺了它会在**浏览器运行时**抛
   * `cannot get property "remote.session" without inject`——纯函数单测抓不到，
   * 只有实机浏览器能暴露（2026-09-12 实测：徽章渲染 + 该错误同时出现）。
   * 这里把依赖固化成静态断言。
   */
  it('inject 列表含 slots / sessions / modelDirectories / remote.session', () => {
    const mod = loadBundle()
    const inject = mod.inject as string[]
    expect(Array.isArray(inject)).toBe(true)
    for (const dep of ['slots', 'sessions', 'modelDirectories', 'remote', 'remote.session']) {
      expect(inject, `inject 缺少 ${dep}`).toContain(dep)
    }
  })
})

describe('★ 回归：绝不注册到会遮蔽自带 UI 的槽位', () => {
  it('注册的槽位不在 SHADOWING_SLOTS 中', () => {
    const regs = captureRegistration()
    expect(regs.length).toBeGreaterThan(0)
    for (const r of regs) {
      expect(SHADOWING_SLOTS, `禁止注册到遮蔽槽位：${r.slot}`).not.toContain(r.slot)
    }
  })

  it('注册到 conversation.input.left（list · replaceRisk: none）', () => {
    const regs = captureRegistration()
    expect(regs.map((r) => r.slot)).toEqual(['conversation.input.left'])
  })

  it('同时传 name（槽位键）与 id（自有 cell 键）—— 只给 id 无法注册', () => {
    const regs = captureRegistration()
    const opts = regs[0]!.options
    // name 决定「注册到哪个槽位」，缺了它 register 无从归属
    expect(opts.name).toBe('conversation.input.left')
    // id 决定「是追加还是占用别人的单元格」——自有 id = 纯追加
    expect(opts.id).toBe('peakrate')
  })

  it('明确不注册到 conversation.input.model（2026-09-12 事故槽位）', () => {
    const regs = captureRegistration()
    expect(regs.some((r) => r.slot === 'conversation.input.model')).toBe(false)
  })
})

describe('★ 回归：注册时必须提供 inject 注入面（否则 UI 无数据）', () => {
  it('options.name 必须与 slots.inject 的槽位键一致（否则注册错位）', () => {
    const regs = captureRegistration()
    for (const r of regs) {
      expect(r.options.name, 'options.name 应与 inject 的槽位键一致').toBe(r.slot)
    }
  })

  it('register 的 options 带 inject 函数，且能给出非空 profiles', () => {
    const regs = captureRegistration()
    const opts = regs[0]!.options

    expect(typeof opts.inject).toBe('function')
    const face = (opts.inject as (sessionId: string) => Record<string, unknown>)('session-1')
    expect(face.available).toBe(true)
    expect(face.directory).toBeDefined()

    const peakrate = face.peakrate as { profiles: () => unknown[] }
    expect(peakrate).toBeDefined()
    expect(peakrate.profiles().length).toBeGreaterThan(0)
  })

  it('注入的 profiles 覆盖本机三个关键 profile', () => {
    const regs = captureRegistration()
    const face = (regs[0]!.options.inject as (s: string) => Record<string, unknown>)('session-1')
    const ids = (face.peakrate as { profiles: () => { id: string }[] })
      .profiles()
      .map((p) => p.id)
    expect(ids).toContain('deepseek-v4')
    expect(ids).toContain('ollama-deepseek-v4')
    expect(ids).toContain('xiaomi-mimo-v2-5-token-plan')
  })

  it('子代理会话（subagentAddress 非空）时 available 为 false', () => {
    const { opts } = captureWith({ subagentAddress: () => 'agent-1' })
    const face = (opts().inject as (s: string) => Record<string, unknown>)('session-1')
    expect(face.available).toBe(false)
  })
})

describe('★ 端到端：仍能算出正确判定（ollama 峰 / 官方谷）', () => {
  it('同一模型经不同 provider 判定相反；未匹配返回 undefined', () => {
    const mod = loadBundle() as {
      rateFor: (
        p: string,
        m: string,
        profs: unknown[],
        cfg: unknown,
        now: Date,
      ) => { period: string } | undefined
    }
    const regs = captureRegistration()
    const face = (regs[0]!.options.inject as (s: string) => Record<string, unknown>)('session-1')
    const profiles = (face.peakrate as { profiles: () => unknown[] }).profiles()
    const now = new Date('2026-09-14T13:00:00Z') // 周一 13:00 UTC

    expect(mod.rateFor('ollama', 'deepseek-v4-flash:0731', profiles, {}, now)?.period).toBe('peak')
    expect(mod.rateFor('deepseek-official', 'deepseek-v4-flash', profiles, {}, now)?.period).toBe(
      'offPeak',
    )
    expect(mod.rateFor('ollama', 'glm-5.3', profiles, {}, now)).toBeUndefined()
  })
})
