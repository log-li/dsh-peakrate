/**
 * 运行时目录（live catalog）—— client 侧从 host 拉取目录并回退到内置快照。
 *
 * 背景：徽章与覆盖面板此前只吃**构建期烤进 bundle** 的快照
 * （`__PEAKRATE_PROFILES__`）。host 每 24h 拉取目录却无人消费 —— 数据源更新后
 * 界面不会变，除非重新构建并重装插件。现在 host 通过带信任围栏的
 * `/peakrate/catalog` 把运行时目录交给这里。
 *
 * 设计取舍：
 * - **内置快照永远是兜底**：拉取失败（离线 / 首启 / 被围栏拒绝）时静默回退，
 *   绝不让徽章因为网络问题消失。首屏不等网络 —— 先用内置的渲染，拿到再替换。
 * - **单一数据源**：模块级一份 `profiles`，组件经 `subscribeLiveCatalog` 订阅，
 *   拉取落地后立即重渲染，不必等下一次 30s 心跳。
 */
import type { RateProfile } from '../matching.js'

/** host 下发路由的载荷形状（与 `src/catalog-route.ts` 的 CatalogPayload 对应）。 */
interface CatalogPayload {
  profiles: RateProfile[]
  updatedAt?: string
  fetchedAt?: string
  origin?: 'remote' | 'builtin'
}

/** 当前生效的运行时目录；undefined = 尚未成功拉到，调用方应回退到内置快照。 */
let liveProfiles: RateProfile[] | undefined

/** 最近一次拉取的结果描述，供覆盖面板如实显示数据来源。 */
let liveMeta: { origin: 'remote' | 'builtin'; fetchedAt?: string; updatedAt?: string } | undefined

/** 拉取状态：idle 表示还没试过。 */
let liveStatus: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'

/** 失败原因（仅用于诊断，不面向用户主路径）。 */
let liveError: string | undefined

const listeners = new Set<() => void>()

/** 广播一次变更。 */
function emit(): void {
  for (const fn of listeners) fn()
}

/** 订阅运行时目录的变化；返回取消订阅函数。 */
export function subscribeLiveCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 取当前生效的 profile 列表。
 *
 * @param fallback - 内置快照；仅在还没成功拉到运行时目录时使用。
 * @returns 运行时目录优先，否则回退。
 */
export function resolveProfiles(fallback: readonly RateProfile[]): RateProfile[] {
  return liveProfiles ?? [...fallback]
}

/** 运行时目录的元信息（数据来源 / 取得时间），供覆盖面板展示。 */
export function liveCatalogMeta(): typeof liveMeta {
  return liveMeta
}

/** 当前拉取状态。 */
export function liveCatalogStatus(): typeof liveStatus {
  return liveStatus
}

/** 最近一次失败原因（若有）。 */
export function liveCatalogError(): string | undefined {
  return liveError
}

/**
 * 校验 host 下发的载荷 —— 不信任网络边界之外的数据形状。
 *
 * @param value - 解析后的 JSON。
 * @returns 合法时返回 profile 数组，否则 undefined。
 */
function acceptedProfiles(value: unknown): CatalogPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const payload = value as CatalogPayload
  if (!Array.isArray(payload.profiles) || payload.profiles.length === 0) return undefined
  for (const p of payload.profiles) {
    if (typeof p !== 'object' || p === null) return undefined
    if (typeof (p as RateProfile).id !== 'string') return undefined
    if (typeof (p as RateProfile).schedule !== 'object') return undefined
  }
  return payload
}

/**
 * 从 host 拉取一次目录。
 *
 * @param options - `refresh: true` 时用 POST 让 host **强制重新拉取远端**，
 *                  否则 GET 只读 host 当前已有的目录。
 * @returns 是否成功拿到新目录。
 */
export async function fetchLiveCatalog(options: { refresh?: boolean } = {}): Promise<boolean> {
  liveStatus = 'loading'
  emit()
  try {
    const res = await fetch('/peakrate/catalog', {
      method: options.refresh === true ? 'POST' : 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      liveStatus = 'failed'
      liveError = `HTTP ${res.status}`
      emit()
      return false
    }
    const payload = acceptedProfiles(await res.json())
    if (payload === undefined) {
      liveStatus = 'failed'
      liveError = 'malformed payload'
      emit()
      return false
    }
    liveProfiles = payload.profiles
    liveMeta = {
      origin: payload.origin ?? 'builtin',
      ...(payload.fetchedAt === undefined ? {} : { fetchedAt: payload.fetchedAt }),
      ...(payload.updatedAt === undefined ? {} : { updatedAt: payload.updatedAt }),
    }
    liveStatus = 'ready'
    liveError = undefined
    emit()
    return true
  } catch (error) {
    // 网络不可用是**正常情形**（离线 / 首次启动），静默回退到内置快照。
    liveStatus = 'failed'
    liveError = error instanceof Error ? error.message : String(error)
    emit()
    return false
  }
}
