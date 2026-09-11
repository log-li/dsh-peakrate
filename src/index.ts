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

/**
 * 本插件在**用户设置**里的命名空间。
 *
 * 它同时解决两件事：
 * 1. **「设置 → 插件 → 插件配置」里的卡片**：该页签按 Host 提供的 settings
 *    命名空间派发 slot key，没有命名空间 → 客户端卡片注册了也**不会渲染**
 *    （实测确认：光在 settings.yaml 加一个顶层 key 不被 serve，必须
 *    `settings.installSection(...)`）。
 * 2. **配置可在界面里编辑**：不必再手改 `cordis.patch.yml`。
 *
 * 只暴露 host 侧**能真正生效**的项；别名/映射等复杂结构仍留在 loader config。
 */
const SETTINGS_NAMESPACE = 'peakrate'

/** 暴露给设置 UI 的 schema —— 两项都 host 侧可即时生效。 */
const SETTINGS_SCHEMA = z.object({
  /** 总开关；关闭后不再后台刷新（客户端呈现暂不受其影响）。 */
  enabled: z.boolean().default(true),
  /** 后台刷新间隔（小时）；0 = 不自动刷新。 */
  refreshIntervalHours: z.number().default(DEFAULT_REFRESH_HOURS),
})

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
      this.log(`已载入本地缓存（${this.catalog.profiles.length} 个 profile）`)
      return
    }
    if (cached !== undefined) {
      this.log('本地缓存已过期（比内置快照旧），改用内置快照')
    }

    if (snapshot !== undefined) {
      this.catalog = this.withCustomProfiles(snapshot)
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

  /**
   * 改后台刷新间隔并立即生效（0 = 停止自动刷新）。
   *
   * 供用户设置里修改 `refreshIntervalHours` 时调用。
   *
   * @param hours - 新间隔（小时）。
   */
  setRefreshInterval(hours: number): void {
    this.stopAutoRefresh()
    this.config.refreshIntervalHours = hours
    this.startAutoRefresh()
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
  // 注意：cordis 中首次注册必须用 ctx.provide（ctx.set 只能覆写已注册的服务）。
  ctx.provide('peakrate', {
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

  // 声明用户设置命名空间：既让「设置 → 插件」的卡片得以渲染，
  // 也让这两项配置可在界面里编辑。
  let live = {
    enabled: config.enabled ?? true,
    refreshIntervalHours: config.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS,
  }
  /** 安装时由 `setSource` 交接的「当前用户设置」读取器；每次变更后按需重读。 */
  let readSettings: (() => Record<string, unknown>) | undefined
  /**
   * 把最新设置应用到运行中的 store。
   *
   * 只处理**真正能即时生效**的两项：开关与刷新间隔。其余配置（别名/映射/
   * 自定义 profile）结构复杂且需重建快照，仍留在 `cordis.patch.yml`。
   */
  const applySettings = (next: typeof live): void => {
    const enabledChanged = next.enabled !== live.enabled
    const intervalChanged = next.refreshIntervalHours !== live.refreshIntervalHours
    live = next
    if (!enabledChanged && !intervalChanged) return

    if (!next.enabled) {
      store.stopAutoRefresh()
      logger?.info?.('[peakrate] 已按用户设置停用后台刷新')
      return
    }
    store.setRefreshInterval(next.refreshIntervalHours)
    logger?.info?.(`[peakrate] 后台刷新间隔已更新为 ${next.refreshIntervalHours} 小时`)
  }

  ctx.inject(['settings'], (settingsCtx: Context) => {
    const settings = (settingsCtx as unknown as { settings?: {
      installSection: (
        owner: Context,
        ns: string,
        schema: unknown,
        entry: Record<string, unknown>,
        hooks: {
          setSource: (source: () => Record<string, unknown>) => void
          onChange: () => void
        },
      ) => void
    } }).settings
    if (settings === undefined) return
    // 契约（2026-09-12 实测探针确认）：`setSource` **只在安装时交接一次读取器**，
    // 此后用户每次编辑只触发 `onChange`，**不会**再调 `setSource`。
    // 因此必须「存读取器 + 在 onChange 里自己再拉一次」——
    // 官方两个使用方（dsh-agent-loop / dsh-tool-subagent）同样是存 reader 按需读。
    // 早期写法在 setSource 里一次性取值、onChange 留空 → 用户编辑到不了运行中的 store。
    settings.installSection(ctx, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, live, {
      setSource: (source) => {
        readSettings = source
        applySettings(readSettings() as typeof live)
      },
      onChange: () => {
        if (readSettings !== undefined) applySettings(readSettings() as typeof live)
      },
    })
  })
}

export const name = 'dsh-peakrate'
export const inject = []
