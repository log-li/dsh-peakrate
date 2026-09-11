/**
 * 构建产物契约测试 —— 防止「客户端拿不到数据」这类只在实机暴露的缺陷。
 *
 * 背景（2026-09-12 实测踩坑）：client 半边最初用
 * `(props as { peakrate?: PeakrateFace }).peakrate` 读数据，但注册时**没有传
 * inject 注入面**，导致 profiles 恒为 []，UI 一个徽章都不显示。而当时所有单测
 * 都只测 `rateFor()` 纯函数、直接传 profiles，因此全部通过——缺陷只在实机可见。
 *
 * 本测试从**构建产物**出发验证契约，堵住这个盲区。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const clientBundle = fileURLToPath(new URL('../lib/client.js', import.meta.url))

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

beforeAll(() => {
  // 产物可能尚未构建（CI 首次运行），先构建
  if (!existsSync(clientBundle)) {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' })
  }
}, 180_000)

describe('client bundle 契约', () => {
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
})

describe('★ 回归：注册时必须提供 inject 注入面（否则 UI 无数据）', () => {
  it('register 的 options 带 inject 函数，且能给出非空 profiles', () => {
    const mod = loadBundle() as {
      apply: (ctx: unknown) => void
    }

    let options: Record<string, unknown> | undefined
    const fakeCtx = {
      get: (k: string) =>
        k === 'slots'
          ? {
              inject: (_key: string, cb: () => () => void) => cb(),
              register: (opts: Record<string, unknown>) => {
                options = opts
                return () => {}
              },
            }
          : undefined,
    }
    mod.apply(fakeCtx)

    // 注册到了正确的 slot
    expect(options?.name).toBe('conversation.input.model')

    // 关键断言：必须带 inject，且注入面里能取到 profiles
    expect(typeof options?.inject).toBe('function')
    const face = (options!.inject as () => { peakrate: { profiles: () => unknown[] } })()
    expect(face.peakrate).toBeDefined()
    const profiles = face.peakrate.profiles()
    expect(profiles.length).toBeGreaterThan(0)
  })

  it('注入的 profiles 覆盖本机三个关键 profile', () => {
    const mod = loadBundle() as { apply: (ctx: unknown) => void }
    let options: Record<string, unknown> | undefined
    mod.apply({
      get: (k: string) =>
        k === 'slots'
          ? {
              inject: (_k: string, cb: () => () => void) => cb(),
              register: (o: Record<string, unknown>) => {
                options = o
                return () => {}
              },
            }
          : undefined,
    })
    const face = (options!.inject as () => { peakrate: { profiles: () => { id: string }[] } })()
    const ids = face.peakrate.profiles().map((p) => p.id)
    expect(ids).toContain('deepseek-v4')
    expect(ids).toContain('ollama-deepseek-v4')
    expect(ids).toContain('xiaomi-mimo-v2-5-token-plan')
  })

  it('★ 端到端：注入的 profiles 能算出正确判定（ollama 峰 / 官方谷）', () => {
    const mod = loadBundle() as {
      apply: (ctx: unknown) => void
      rateFor: (
        p: string,
        m: string,
        profs: unknown[],
        cfg: unknown,
        now: Date,
      ) => { period: string; badge: string } | undefined
    }
    let options: Record<string, unknown> | undefined
    mod.apply({
      get: (k: string) =>
        k === 'slots'
          ? {
              inject: (_k: string, cb: () => () => void) => cb(),
              register: (o: Record<string, unknown>) => {
                options = o
                return () => {}
              },
            }
          : undefined,
    })
    const face = (options!.inject as () => { peakrate: { profiles: () => unknown[] } })()
    const profiles = face.peakrate.profiles()
    const now = new Date('2026-09-14T13:00:00Z') // 周一 13:00 UTC

    // 同一模型，经不同 provider → 判定相反（本插件的核心价值）
    const viaOllama = mod.rateFor('ollama', 'deepseek-v4-flash:0731', profiles, {}, now)
    const viaOfficial = mod.rateFor('deepseek-official', 'deepseek-v4-flash', profiles, {}, now)
    expect(viaOllama?.period).toBe('peak')
    expect(viaOfficial?.period).toBe('offPeak')

    // 未匹配必须返回 undefined（UI 什么都不显示）
    expect(mod.rateFor('ollama', 'glm-5.3', profiles, {}, now)).toBeUndefined()
  })
})
