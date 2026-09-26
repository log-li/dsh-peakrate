/**
 * host 半边：配置、数据获取（内置快照 → 本地缓存 → 远端刷新）、
 * 以及对外提供 profile 数据给 client 半边。
 *
 * 数据获取策略见 spec §2：内置快照 + 后台刷新 + 本地缓存；远端失败只记日志，
 * 绝不阻塞 UI。
 */
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseCatalog, type ParsedCatalog } from './catalog.js'
import { handleCatalogRequest, type CatalogPayload } from './catalog-route.js'
import type { MatchConfig, RateProfile } from './matching.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * `volatile()` 配置值已提交进运行中的 fiber（**不重挂**插件），只派发给
     * 拥有该 entry 的那个 fiber。
     *
     * 这条声明的正式来源是 `cordis-plugin-loader`（DSH 运行时自带），但它不在本
     * 插件的依赖图里，所以这里按**同一签名**补一条，好让 `ctx.on` 通过类型检查。
     *
     * @param paths - 变更的配置路径（键数组）。
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/**
 * 用户配置的**明文形态**（spec §6）—— 写在 profile 的 `cordis.patch.yml`
 * （或 `settings.yaml`）那条 entry 的 `config:` 下。
 */
export interface PeakrateOptions {
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

/**
 * `volatile()` 字段在运行时的形态：一个**稳定引用**（`get()` 取当前明文值）。
 *
 * 刻意不 import `@deepseek-ai/cordis` 的 `Volatile`：本机的 cordis 是
 * `^4.0.2`，而该类型是后来才导出的，用本地结构类型能让 peer 版本更宽松。
 */
export interface VolatileRef<T> {
  get: () => T
}

/**
 * 校验之后交给 `apply` 的**运行时配置**：`volatile()` 的字段是
 * {@link VolatileRef} 引用，其余是标量。
 *
 * 名字与官方 cookbook（`docs/cookbook/adding-a-settings-card.md`）一致：**同一个
 * 模块同时导出 `interface Config`（运行时形态）与 `const Config`（schema）** ——
 * 类型空间与值空间互不冲突，前者给插件读、后者给 loader 校验与设置面派发。
 */
export interface Config {
  enabled?: boolean
  refreshIntervalHours?: VolatileRef<number | undefined>
  cachePath?: string
  catalogUrl?: string
  providerAliases?: Record<string, string>
  modelMappings?: MatchConfig['modelMappings']
  customProfiles?: unknown[]
}

const DEFAULT_CATALOG_URL = 'https://offpeakclock.com/pricing.json'
const DEFAULT_REFRESH_HOURS = 24

/**
 * 插件配置 schema —— ★ **这就是 0.1.7 的「设置命名空间注册」**。
 *
 * DSH 0.1.7 删除了 `settings.installSection(...)` 那套安装 API（0.1.5 时代的
 * 写法）：现在**模块导出的 `Config` 就是唯一的注册路径** ——
 * `settings.describe()` 取的是 `entry.fiber.runtime.Config`，命名空间就等于
 * profile 里这条 loader entry 的 `id`（即 `peakrate`，见 `cordis.patch.yml`）。
 *
 * 标了 `volatile()` 的字段是**可在界面里即时编辑**的（无需重载插件）：schema
 * 校验会把它解析成一个**稳定引用**，用户保存后由 loader 直接把新值写进该引用，
 * 并向本插件发出 `loader/volatile-update`。官方同款做法见 `llm-deepseek`。
 *
 * 只标 `refreshIntervalHours`：`enabled` 是总开关，改它要重建 store 与下发路由，
 * 属于「重新装载」语义（loader 会重挂本插件），标成 volatile 反而给出
 * 「已生效」的错觉。
 */
export const Config = z.object({
  /** 总开关；关闭后本半边不做事（改它需要重新装载）。 */
  enabled: z.boolean().default(true),
  /** 后台刷新间隔（小时）；0 = 不自动刷新。 */
  refreshIntervalHours: z.number().min(0).max(720).default(DEFAULT_REFRESH_HOURS).volatile(),
  /** 本地缓存路径；留空则用 $DSH_HOME/dsh-peakrate/pricing.json。 */
  cachePath: z.string(),
  /** 数据源地址，可换镜像/自建。 */
  catalogUrl: z.string(),
  /** provider 别名覆盖。 */
  providerAliases: z.dict(z.string()),
  /** 模型归属覆盖。⚠ 字段必须与 `ModelMapping` 一一对应（`z.object` 会**丢掉**
   * 未声明的键 —— 漏了 `matchIsRegex` 就等于静默忽略用户写下的正则开关）。 */
  modelMappings: z.array(
    z.object({
      provider: z.string(),
      match: z.string(),
      profile: z.string(),
      matchIsRegex: z.boolean(),
    }),
  ),
  /** 自定义 profile：新增或按 id 覆盖内置快照条目。 */
  customProfiles: z.array(z.any()),
})

/**
 * 读一个配置字段：`volatile` 引用取 `.get()`，标量原样返回。
 *
 * @param value - 运行时配置字段。
 * @returns 当前明文值。
 */
function readRef<T>(value: VolatileRef<T> | T | undefined): T | undefined {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as VolatileRef<T>).get === 'function'
  ) {
    return (value as VolatileRef<T>).get()
  }
  return value as T | undefined
}

/**
 * 从运行时配置里读出**当前**明文选项（`volatile` 字段每次都重新取）。
 *
 * @param config - 校验后的运行时配置。
 * @returns 明文选项。
 */
export function readOptions(config: Config): PeakrateOptions {
  return {
    enabled: config.enabled,
    refreshIntervalHours: readRef(config.refreshIntervalHours),
    cachePath: config.cachePath,
    catalogUrl: config.catalogUrl,
    providerAliases: config.providerAliases,
    modelMappings: config.modelMappings,
    customProfiles: config.customProfiles,
  }
}

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
  /** 当前 catalog 来自远端拉取还是内置/缓存快照 —— 供下发路由如实告知 client。 */
  private catalogOrigin: 'remote' | 'builtin' = 'builtin'
  private lastFetchAt = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly log: (msg: string) => void
  private readonly cachePath: string
  private readonly catalogUrl: string

  constructor(
    private readonly config: PeakrateOptions,
    logger: { info?: (msg: string) => void; warn?: (msg: string) => void } | undefined,
  ) {
    this.log = (msg) => logger?.info?.(`[peakrate] ${msg}`)
    this.cachePath = config.cachePath ?? defaultCachePath()
    this.catalogUrl = config.catalogUrl ?? DEFAULT_CATALOG_URL
  }

  /**
   * 载入可用数据：**未过期**的本地缓存优先，否则用内置快照。
   *
   * 「过期」判定（spec §2）：缓存数据比内置快照更旧时即视为过期。
   * 快照随插件包分发，插件升级会带来更新的快照——若盲目信任缓存，
   * 升级后旧缓存会一直压过新快照，直到某次远端刷新成功为止。
   * 两端都缺 `updatedAt` 时回退到**文件 mtime vs 快照 mtime** 比较。
   */
  load(): void {
    const snapshot = loadSnapshot()
    const cached = loadCache(this.cachePath)

    if (cached !== undefined && !this.isCacheStale(cached, snapshot)) {
      this.catalog = this.withCustomProfiles(cached)
      this.catalogOrigin = 'builtin' // 磁盘缓存：不是本次运行拉到的，不冒充 remote
      this.log(`已载入本地缓存（${this.catalog.profiles.length} 个 profile）`)
      return
    }
    if (cached !== undefined) {
      this.log('本地缓存已过期（比内置快照旧），改用内置快照')
    }

    if (snapshot !== undefined) {
      this.catalog = this.withCustomProfiles(snapshot)
      this.catalogOrigin = 'builtin'
      this.log(`已载入内置快照（${this.catalog.profiles.length} 个 profile）`)
    } else {
      this.log('内置快照不可用——插件将不显示任何倍率')
    }
  }

  /**
   * 判断缓存是否已过期（比内置快照旧）。
   *
   * @param cached - 已解析的缓存目录。
   * @param snapshot - 已解析的内置快照（可能不可用）。
   * @returns 缓存过期时应丢弃并改用快照。
   */
  private isCacheStale(cached: ParsedCatalog, snapshot: ParsedCatalog | undefined): boolean {
    // 快照不可用时，缓存是唯一数据源，一律采用。
    if (snapshot === undefined) return false

    // 优先比数据自身的 updatedAt（语义最准）
    const c = cached.updatedAt
    const s = snapshot.updatedAt
    if (c !== undefined && s !== undefined) {
      const ct = Date.parse(c)
      const st = Date.parse(s)
      if (!Number.isNaN(ct) && !Number.isNaN(st)) return ct < st
    }

    // 回退到文件 mtime 比较
    try {
      const cacheMtime = statSync(this.cachePath).mtimeMs
      const snapMtime = statSync(snapshotPath()).mtimeMs
      return cacheMtime < snapMtime
    } catch {
      // 无法比较时保守采用缓存（它至少是上次成功拉取的结果）
      return false
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
  /** 目录数据来源（远端拉取 / 内置或缓存快照）。 */
  origin(): 'remote' | 'builtin' {
    return this.catalogOrigin
  }


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
      this.catalogOrigin = 'remote' // 本次运行真的从远端拿到了数据
      writeCache(this.cachePath, raw, this.log)
      this.log(`远端刷新成功（${this.catalog.profiles.length} 个 profile）`)
      return true
    } catch (error) {
      // 网络失败、超时、JSON 解析失败一律降级，不影响 UI
      this.log(`远端刷新失败：${String(error)}`)
      return false
    }
  }

  /**
   * 改后台刷新间隔并立即生效（0 = 停止自动刷新）。
   *
   * 供界面里修改 `refreshIntervalHours`（volatile 字段）时调用。
   *
   * @param hours - 新间隔（小时）。
   */
  setRefreshInterval(hours: number): void {
    this.stopAutoRefresh()
    this.config.refreshIntervalHours = hours
    this.startAutoRefresh()
  }

  /** 当前生效的后台刷新间隔（小时）。 */
  refreshInterval(): number {
    return this.config.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS
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
 * @param config - 校验后的运行时配置（`volatile` 字段是稳定引用）。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const options = readOptions(config)
  if (options.enabled === false) return

  const logger = ctx.get('logger') as
    | { info?: (msg: string) => void; warn?: (msg: string) => void }
    | undefined

  const store = new CatalogStore(options, logger)
  store.load()

  // 提供 host 侧服务，client 半边通过同名 service 读取。
  // 注意：cordis 中首次注册必须用 ctx.provide（ctx.set 只能覆写已注册的服务）。
  ctx.provide('peakrate', {
    profiles: () => store.profiles(),
    updatedAt: () => store.updatedAt(),
    refresh: () => store.refresh(),
    config: () => ({
      providerAliases: options.providerAliases ?? {},
      modelMappings: options.modelMappings ?? [],
    }),
  })

  store.startAutoRefresh()
  ctx.effect(() => () => store.stopAutoRefresh())

  // 启动后异步拉一次，不阻塞启动
  void store.refresh()

  /**
   * 界面里改了 volatile 字段（`refreshIntervalHours`）：loader 会把新值写进
   * 那个**稳定引用**，并向**本插件 fiber** 发一次 `loader/volatile-update`。
   * 事件不带值，所以这里重新 `readOptions(config)` 取当前值。
   *
   * 这就是 0.1.7 之后「配置项可在界面里编辑并即时生效」的接线方式 ——
   * 替代了 0.1.5 时代那套 `setSource`（只交接一次）/`onChange` 契约。
   */
  ctx.on('loader/volatile-update', () => {
    const hours = readOptions(config).refreshIntervalHours ?? DEFAULT_REFRESH_HOURS
    if (hours === store.refreshInterval()) return
    store.setRefreshInterval(hours)
    logger?.info?.(`[peakrate] 后台刷新间隔已更新为 ${hours} 小时`)
  })

  // ── 把 host 运行时拉取到的目录下发给浏览器 ──────────────────────────────
  // 在此之前 client 只吃构建期烤进 bundle 的快照，host 的 24h 拉取没有任何消费者
  // （数据源更新后界面不变）。这条路由就是那个缺失的消费者。
  const payload = (): CatalogPayload => ({
    profiles: store.profiles(),
    ...(store.updatedAt() === undefined ? {} : { updatedAt: store.updatedAt() }),
    ...(store.lastFetch() === 0 ? {} : { fetchedAt: new Date(store.lastFetch()).toISOString() }),
    origin: store.origin(),
  })

  ctx.inject(['webServer'], (webCtx: Context) => {
    const webServer = (webCtx as unknown as { webServer?: {
      register: (route: {
        kind: 'prefix'
        path: string
        handler: (req: never, res: never) => void | Promise<void>
      }) => () => void
    } }).webServer
    if (webServer === undefined) {
      logger?.warn?.('[peakrate] webServer 服务不可用，跳过目录下发路由')
      return
    }

    /**
     * 部署声明的非回环可信 authority（tailnet / LAN）；取不到则只信回环。
     *
     * ⚠ 用 `ctx.get` 而**不是** `ctx.webRuntime`：属性访问未 inject 的服务会抛
     * `cannot get property "webRuntime" without inject`，而本函数在**请求处理路径**上，
     * 抛出会被 webserver 兜底成 **HTTP 400**（实测踩过：路由匹配上了却全 400）。
     * 同理整段包 try/catch —— 信任围栏宁可退化成「只信回环」，也不能让路由 500/400。
     */
    const trustedHosts = (): readonly string[] => {
      try {
        const runtime = ctx.get('webRuntime') as { trustedHosts?: string[] } | undefined
        return Array.isArray(runtime?.trustedHosts) ? runtime.trustedHosts : []
      } catch {
        return []
      }
    }

    const dispose = webServer.register({
      kind: 'prefix',
      path: '/peakrate/catalog',
      handler: (req, res) =>
        handleCatalogRequest(req, res, {
          payload,
          trustedHosts,
          refresh: async () => {
            await store.refresh()
            return payload()
          },
        }),
    })
    ctx.effect(() => dispose, 'peakrate: catalog route')
    logger?.info?.('[peakrate] 已挂载 /peakrate/catalog（带信任围栏）')
  })
}

export const name = 'dsh-peakrate'
export const inject = []
