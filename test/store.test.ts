/**
 * CatalogStore 单测 —— 数据获取、缓存、降级行为（spec §2 / §8）。
 *
 * 不依赖 DSH 运行时：store 只用到 fs / fetch / setInterval。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogStore, type Config } from '../src/index.js'

/** 造一份合法数据源，profile id 可指定，便于断言来源。 */
function catalog(profileId: string, schemaVersion = 1) {
  return {
    schemaVersion,
    updatedAt: '2026-09-11',
    profiles: [
      {
        id: profileId,
        provider: 'Vendor',
        model: 'Model',
        schedule: {
          timeZone: 'UTC',
          peakDays: [1],
          peakWindows: [{ start: '12:00', end: '18:00' }],
        },
        periods: { peak: { name: 'Peak', badge: '2×' }, offPeak: { name: 'Off', badge: '1×' } },
      },
    ],
  }
}

/** 静默 logger。 */
const silent = { info: () => {}, warn: () => {} }

/** 建一个临时缓存路径。 */
function tempCachePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'peakrate-')), 'pricing.json')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('载入优先级：本地缓存 → 内置快照', () => {
  it('无缓存时回退内置快照', () => {
    const store = new CatalogStore({ cachePath: tempCachePath() }, silent)
    store.load()
    expect(store.profiles().length).toBeGreaterThan(0)
    // 内置快照里应有本机需要的 profile
    expect(store.profiles().map((p) => p.id)).toContain('deepseek-v4')
  })

  it('有合法缓存时优先用缓存', () => {
    const path = tempCachePath()
    writeFileSync(path, JSON.stringify(catalog('from-cache')), 'utf8')
    const store = new CatalogStore({ cachePath: path }, silent)
    store.load()
    expect(store.profiles().map((p) => p.id)).toEqual(['from-cache'])
  })

  it('缓存非法（schemaVersion 不支持）时回退内置快照', () => {
    const path = tempCachePath()
    writeFileSync(path, JSON.stringify(catalog('bad', 99)), 'utf8')
    const store = new CatalogStore({ cachePath: path }, silent)
    store.load()
    expect(store.profiles().map((p) => p.id)).not.toContain('bad')
    expect(store.profiles().map((p) => p.id)).toContain('deepseek-v4')
  })

  it('缓存是坏 JSON 时回退内置快照', () => {
    const path = tempCachePath()
    writeFileSync(path, '{not json', 'utf8')
    const store = new CatalogStore({ cachePath: path }, silent)
    store.load()
    expect(store.profiles().map((p) => p.id)).toContain('deepseek-v4')
  })
})

describe('refresh：远端拉取与降级', () => {
  it('成功时替换数据并写入缓存', async () => {
    const path = tempCachePath()
    const store = new CatalogStore({ cachePath: path }, silent)
    store.load()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(catalog('from-remote')), { status: 200 })),
    )

    const ok = await store.refresh()
    expect(ok).toBe(true)
    expect(store.profiles().map((p) => p.id)).toEqual(['from-remote'])
    // 缓存已落盘，且内容可被再次解析
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).profiles[0].id).toBe('from-remote')
  })

  it('HTTP 非 2xx 时沿用旧数据', async () => {
    const path = tempCachePath()
    writeFileSync(path, JSON.stringify(catalog('keep-me')), 'utf8')
    const store = new CatalogStore({ cachePath: path }, silent)
    store.load()

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect(await store.refresh()).toBe(false)
    expect(store.profiles().map((p) => p.id)).toEqual(['keep-me'])
  })

  it('远端 schemaVersion 不支持时丢弃本次结果', async () => {
    const path = tempCachePath()
    writeFileSync(path, JSON.stringify(catalog('keep-me')), 'utf8')
    const store = new CatalogStore({ cachePath: path }, silent)
    store.load()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(catalog('bad', 99)), { status: 200 })),
    )
    expect(await store.refresh()).toBe(false)
    expect(store.profiles().map((p) => p.id)).toEqual(['keep-me'])
  })

  it('远端 profiles 为空时丢弃本次结果', async () => {
    const store = new CatalogStore({ cachePath: tempCachePath() }, silent)
    store.load()
    const before = store.profiles().length

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, profiles: [] }), { status: 200 })),
    )
    expect(await store.refresh()).toBe(false)
    expect(store.profiles().length).toBe(before)
  })

  it('网络异常时不抛错，沿用旧数据', async () => {
    const store = new CatalogStore({ cachePath: tempCachePath() }, silent)
    store.load()
    const before = store.profiles().length

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    expect(await store.refresh()).toBe(false)
    expect(store.profiles().length).toBe(before)
  })

  it('响应不是合法 JSON 时不抛错', async () => {
    const store = new CatalogStore({ cachePath: tempCachePath() }, silent)
    store.load()
    const before = store.profiles().length

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{broken', { status: 200 })))
    expect(await store.refresh()).toBe(false)
    expect(store.profiles().length).toBe(before)
  })
})

describe('customProfiles：覆盖与追加', () => {
  it('按 id 覆盖内置条目', () => {
    const custom = [
      {
        id: 'deepseek-v4',
        provider: 'DeepSeek',
        model: 'Overridden',
        schedule: {
          timeZone: 'Asia/Tokyo',
          peakDays: [0],
          peakWindows: [{ start: '01:00', end: '02:00' }],
        },
        periods: { peak: { name: 'P', badge: '9×' }, offPeak: { name: 'O', badge: '0.1×' } },
      },
    ]
    const store = new CatalogStore({ cachePath: tempCachePath(), customProfiles: custom }, silent)
    store.load()
    const hit = store.profiles().find((p) => p.id === 'deepseek-v4')
    expect(hit?.modelLabel).toBe('Overridden')
    expect(hit?.peakBadge).toBe('9×')
    expect(hit?.schedule.timeZone).toBe('Asia/Tokyo')
  })

  it('追加新 profile', () => {
    const custom = [
      {
        id: 'my-custom',
        provider: 'MyVendor',
        model: 'Mine',
        schedule: { timeZone: 'UTC', peakDays: [1], peakWindows: [{ start: '09:00', end: '10:00' }] },
        periods: { peak: { name: 'P', badge: '3×' }, offPeak: { name: 'O', badge: '1×' } },
      },
    ]
    const store = new CatalogStore({ cachePath: tempCachePath(), customProfiles: custom }, silent)
    store.load()
    expect(store.profiles().map((p) => p.id)).toContain('my-custom')
  })

  it('非法 customProfiles 被忽略，不影响内置数据', () => {
    const store = new CatalogStore(
      { cachePath: tempCachePath(), customProfiles: [{ id: 'broken' }] },
      silent,
    )
    store.load()
    expect(store.profiles().map((p) => p.id)).toContain('deepseek-v4')
    expect(store.profiles().map((p) => p.id)).not.toContain('broken')
  })
})

describe('后台刷新开关', () => {
  it('refreshIntervalHours = 0 时不启动定时器', () => {
    const store = new CatalogStore({ cachePath: tempCachePath(), refreshIntervalHours: 0 }, silent)
    store.startAutoRefresh()
    store.stopAutoRefresh() // 不应抛错
    expect(store.lastFetch()).toBe(0)
  })
})

describe('enabled 总开关', () => {
  it('enabled: false 时 apply 不注册任何东西', async () => {
    const { apply } = await import('../src/index.js')
    const set = vi.fn()
    const fakeCtx = { get: () => undefined, set, effect: vi.fn() } as never
    apply(fakeCtx, { enabled: false } as Config)
    expect(set).not.toHaveBeenCalled()
  })
})

describe('★ 回归：缓存过期检查（过期缓存不得压过新快照）', () => {
  it('缓存的 updatedAt 比快照旧 → 改用快照', () => {
    const path = tempCachePath()
    // 造一个「很旧」的缓存，且内容明显不同
    writeFileSync(
      path,
      JSON.stringify({ ...catalog('stale-entry'), updatedAt: '2020-01-01' }),
      'utf8',
    )
    const store = new CatalogStore({ cachePath: path }, silent)
    store.load()
    const ids = store.profiles().map((p) => p.id)
    expect(ids).not.toContain('stale-entry')
    // 内置快照有 14 个 profile
    expect(ids.length).toBeGreaterThan(10)
  })

  it('缓存与快照 updatedAt 相同 → 仍用缓存（缓存是远端拉取的结果）', () => {
    const path = tempCachePath()
    const snapshotUpdatedAt = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../data/pricing.json', import.meta.url)),
        'utf8',
      ),
    ).updatedAt
    writeFileSync(
      path,
      JSON.stringify({ ...catalog('same-date'), updatedAt: snapshotUpdatedAt }),
      'utf8',
    )
    const store = new CatalogStore({ cachePath: path }, silent)
    store.load()
    expect(store.profiles().map((p) => p.id)).toEqual(['same-date'])
  })

  it('缓存比快照新 → 用缓存', () => {
    const path = tempCachePath()
    writeFileSync(
      path,
      JSON.stringify({ ...catalog('newer'), updatedAt: '2099-01-01' }),
      'utf8',
    )
    const store = new CatalogStore({ cachePath: path }, silent)
    store.load()
    expect(store.profiles().map((p) => p.id)).toEqual(['newer'])
  })
})
