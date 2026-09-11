/**
 * host 半边：配置、数据获取（内置快照 → 本地缓存 → 远端刷新）、
 * 以及对外提供 profile 数据给 client 半边。
 *
 * 数据获取策略见 spec §2：内置快照 + 后台刷新 + 本地缓存；远端失败只记日志，
 * 绝不阻塞 UI。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { parseCatalog, type ParsedCatalog } from './catalog.js'
import type { MatchConfig, RateProfile } from './matching.js'

/** 插件配置（spec §6）。 */
export interface Config {
  /** 总开关。 */
  enabled?: boolean
  /** 后台刷新间隔（小时）；0 = 不自动刷新。 */
  refreshIntervalHours?: number
  /** 本地缓存路径；默认 $DSH_HOME/dsh-peakrate/pricing.json。 */
  cachePath?: string
  /** 数据源地址，可换镜像/自建。 */
  catalogUrl?: string
  /** provider 别名覆盖。 */
  providerAliases?: Record<string, string>
  /** 模型归属覆盖。 */
  modelMappings?: MatchConfig['modelMappings']
  /** 自定义 profile：新增或按 id 覆盖内置快照条目。 */
  customProfiles?: unknown[]
}

const DEFAULT_CATALOG_URL = 'https://offpeakclock.com/pricing.json'
const DEFAULT_REFRESH_HOURS = 24

/** 内置快照路径（随包分发，安装即用、离线可用）。 */
function snapshotPath(): string {
  return fileURLToPath(new URL('../data/pricing.json', import.meta.url))
}

/** 解析默认缓存路径：$DSH_HOME/dsh-peakrate/pricing.json。 */
function defaultCachePath(): string {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  return join(home, 'dsh-peakrate', 'pricing.json')
}

/** 读取内置快照；失败返回 undefined（不应发生，属打包错误）。 */
function loadSnapshot(): ParsedCatalog | undefined {
  try {
    return parseCatalog(JSON.parse(readFileSync(snapshotPath(), 'utf8')))
  } catch {
    return undefined
  }
}

/** 读取本地缓存；不存在或非法返回 undefined。 */
function loadCache(path: string): ParsedCatalog | undefined {
  try {
    return parseCatalog(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/** 写入本地缓存；失败只记日志（缓存是优化，不是功能依赖）。 */
function writeCache(path: string, raw: unknown, log: (msg: string) => void): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(raw), 'utf8')
  } catch (error) {
    log(`写入缓存失败：${String(error)}`)
  }
}

/**
 * 数据源持有者：管理当前生效的 profile 集合，并在后台按间隔刷新。
 *
 * 读取优先级（spec §2）：**本地缓存（未过期）→ 内置快照**；远端成功则替换。
 * 任何一步失败都沿用上一份可用数据，UI 不受影响。
 */
export class CatalogStore {
  private catalog: ParsedCatalog | undefined
  private lastFetchAt = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly log: (msg: string) => void
  private readonly cachePath: string
  private readonly catalogUrl: string

  constructor(
    private readonly config: Config,
    logger: { info?: (msg: string) => void; warn?: (msg: string) => void } | undefined,
  ) {
    this.log = (msg) => logger?.info?.(`[peakrate] ${msg}`)
    this.cachePath = config.cachePath ?? defaultCachePath()
    this.catalogUrl = config.catalogUrl ?? DEFAULT_CATALOG_URL
  }

  /** 载入可用数据：缓存优先，回退内置快照。 */
  load(): void {
    const cached = loadCache(this.cachePath)
    if (cached !== undefined) {
      this.catalog = this.withCustomProfiles(cached)
      this.log(`已载入本地缓存（${this.catalog.profiles.length} 个 profile）`)
      return
    }
    const snapshot = loadSnapshot()
    if (snapshot !== undefined) {
      this.catalog = this.withCustomProfiles(snapshot)
      this.log(`已载入内置快照（${this.catalog.profiles.length} 个 profile）`)
    } else {
      this.log('内置快照不可用——插件将不显示任何倍率')
    }
  }

  /** 应用 customProfiles：按 id 覆盖已有条目，或追加新条目。 */
  private withCustomProfiles(catalog: ParsedCatalog): ParsedCatalog {
    const custom = this.config.customProfiles
    if (!Array.isArray(custom) || custom.length === 0) return catalog

    // 复用 parseCatalog 的校验：把 custom 包成一份临时目录解析，坏条目自然被丢弃。
    const parsedCustom = parseCatalog({
      schemaVersion: catalog.schemaVersion,
      profiles: custom,
    })
    if (parsedCustom === undefined) {
      this.log('customProfiles 校验失败，已忽略')
      return catalog
    }

    const byId = new Map(catalog.profiles.map((p) => [p.id, p]))
    for (const p of parsedCustom.profiles) byId.set(p.id, p)
    return { ...catalog, profiles: [...byId.values()] }
  }

  /** 当前生效的 profile 列表（始终返回数组，未载入时为空）。 */
  profiles(): RateProfile[] {
    return this.catalog?.profiles ?? []
  }

  /** 数据源更新时间（用于 UI 提示数据新鲜度）。 */
  updatedAt(): string | undefined {
    return this.catalog?.updatedAt
  }

  /**
   * 从远端拉取一次并替换当前数据。
   *
   * @returns 是否成功替换（失败时沿用旧数据）。
   */
  async refresh(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      let raw: unknown
      try {
        const res = await fetch(this.catalogUrl, { signal: controller.signal })
        if (!res.ok) {
          this.log(`远端返回 ${res.status}，沿用现有数据`)
          return false
        }
        raw = await res.json()
      } finally {
        clearTimeout(timeout)
      }

      const parsed = parseCatalog(raw)
      if (parsed === undefined) {
        // schemaVersion 不支持 / profiles 为空 → 丢弃本次结果（spec §8）
        this.log('远端数据校验失败，沿用现有数据')
        return false
      }

      this.catalog = this.withCustomProfiles(parsed)
      this.lastFetchAt = Date.now()
      writeCache(this.cachePath, raw, this.log)
      this.log(`远端刷新成功（${this.catalog.profiles.length} 个 profile）`)
      return true
    } catch (error) {
      // 网络失败、超时、JSON 解析失败一律降级，不影响 UI
      this.log(`远端刷新失败：${String(error)}`)
      return false
    }
  }

  /** 启动后台刷新（refreshIntervalHours = 0 时不启动）。 */
  startAutoRefresh(): void {
    const hours = this.config.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS
    if (hours <= 0) return
    const ms = hours * 3600 * 1000
    this.timer = setInterval(() => {
      void this.refresh()
    }, ms)
    // 不阻止进程退出
    this.timer.unref?.()
  }

  /** 停止后台刷新。 */
  stopAutoRefresh(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 上次成功拉取时间（0 = 从未）。 */
  lastFetch(): number {
    return this.lastFetchAt
  }
}

/**
 * 插件主体：建立 CatalogStore，注册为 cordis 服务，并按配置启动刷新。
 *
 * @param ctx - cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return

  const logger = ctx.get('logger') as
    | { info?: (msg: string) => void; warn?: (msg: string) => void }
    | undefined

  const store = new CatalogStore(config, logger)
  store.load()

  // 提供 host 侧服务，client 半边通过同名 service 读取。
  ctx.set('peakrate', {
    profiles: () => store.profiles(),
    updatedAt: () => store.updatedAt(),
    refresh: () => store.refresh(),
    config: () => ({
      providerAliases: config.providerAliases ?? {},
      modelMappings: config.modelMappings ?? [],
    }),
  })

  store.startAutoRefresh()
  ctx.effect(() => () => store.stopAutoRefresh())

  // 启动后异步拉一次，不阻塞启动
  void store.refresh()
}

export const name = 'dsh-peakrate'
export const inject = []
