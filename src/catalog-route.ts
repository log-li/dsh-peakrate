/**
 * 目录下发路由 —— 把 host **运行时拉取**的目录送到浏览器。
 *
 * ## 为什么需要它
 *
 * 客户端的徽章与覆盖面板此前只吃**构建期烤进 bundle** 的快照
 * （`__PEAKRATE_PROFILES__`）。host 半边虽然每 24h 拉取并缓存目录，却**没有任何
 * 消费者** —— 数据源更新后界面不会变，除非重新构建并重装插件。等于「有引擎没接轮子」。
 *
 * 本模块就是那个轮子：把 host 的目录经一条**带信任围栏**的 HTTP 路由交给 client，
 * 客户端拿到就用、拿不到就回退到内置快照。
 *
 * ## 信任围栏
 *
 * 与官方 `/api` 的 browser-trust fence 同语义（见
 * `@deepseek-ai/dsh-client-connection` 的 `isTrustedApiRequest`）：本插件不直接
 * import 它（该子路径未在 package exports 中导出），而是**照抄其判定逻辑**，
 * 这样行为一致又不引入对内部路径的耦合。围栏防的是浏览器开的两个
 * confused-deputy 通道：
 *
 * - **DNS rebinding**：Host 指向攻击者域名但 socket 打到了本服务。Host 是
 *   rebinding **无法伪造**的那个头，所以它是判定的基础。
 * - **跨站请求**：恶意页面发起的请求。`sec-fetch-site: cross-site` 直接拒绝；
 *   带 Origin 时要求它与 Host 同源。
 *
 * ⚠ 这不是认证层：网络可达性与鉴权不在范围内（与官方注释一致）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RateProfile } from './matching.js'

/** 路由对外暴露的目录载荷。 */
export interface CatalogPayload {
  /** 当前生效的 profile 列表。 */
  profiles: RateProfile[]
  /** 目录数据的版本标记（数据源自带的 `updatedAt`）。 */
  updatedAt?: string
  /** 本次由 host 实际取得数据的时间戳；缺省表示用的是内置快照。 */
  fetchedAt?: string
  /** 数据来自哪里：远端拉取还是内置快照。 */
  origin: 'remote' | 'builtin'
}

/** 解析 `host[:port]` 的 authority，失败返回 undefined。 */
function parseAuthority(authority: string): { hostname: string; host: string } | undefined {
  try {
    const url = new URL(`http://${authority}`)
    if (url.hostname === '' || url.pathname !== '/') return undefined
    return { hostname: url.hostname, host: url.host }
  } catch {
    return undefined
  }
}

/** 是否为回环主机名。 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || h.startsWith('127.')
}

/**
 * 判定一条请求是否可信 —— 与官方 `isTrustedApiRequest` 同语义。
 *
 * @param request - Node HTTP 请求（只读 headers）。
 * @param trustedHosts - 部署声明的非回环 authority（`host` 或 `host:port`）。
 * @returns 可信则 true。
 */
export function isTrustedRequest(
  request: Pick<IncomingMessage, 'headers'>,
  trustedHosts: readonly string[],
): boolean {
  const rawHost = request.headers.host
  if (typeof rawHost !== 'string' || rawHost === '') return false
  const authority = parseAuthority(rawHost)
  if (authority === undefined) return false

  const trusted =
    isLoopbackHostname(authority.hostname) ||
    trustedHosts.some((entry) => {
      const t = entry.trim().toLowerCase()
      if (t === '') return false
      // 精确 `host:port`，或省略端口时匹配任意端口
      return t === authority.host.toLowerCase() || t === authority.hostname.toLowerCase()
    })
  if (!trusted) return false

  if (request.headers['sec-fetch-site'] === 'cross-site') return false

  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host.toLowerCase() === authority.host.toLowerCase()
  } catch {
    return false
  }
}

/** 写一个 JSON 响应（统一带上禁止缓存，避免浏览器缓存住旧目录）。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(text))
  res.end(text)
}

/** 路由依赖：由 host 半边提供的两个动作。 */
export interface CatalogRouteDeps {
  /** 读取当前生效的目录载荷。 */
  payload: () => CatalogPayload
  /** 强制重新拉取一次远端目录；返回拉取后的载荷。 */
  refresh: () => Promise<CatalogPayload>
  /** 读取部署声明的可信 authority。 */
  trustedHosts: () => readonly string[]
}

/**
 * 处理一条 `/peakrate/catalog` 请求。
 *
 * - `GET`  → 返回当前目录（不触发网络）
 * - `POST` → 先强制刷新一次，再返回（供覆盖面板的「立即刷新」用）
 *
 * @param request - Node HTTP 请求。
 * @param response - Node HTTP 响应。
 * @param deps - 目录读写与信任配置。
 */
export async function handleCatalogRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: CatalogRouteDeps,
): Promise<void> {
  if (!isTrustedRequest(request, deps.trustedHosts())) {
    sendJson(response, 403, { error: 'forbidden' })
    return
  }

  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST') {
    response.setHeader('allow', 'GET, POST')
    sendJson(response, 405, { error: 'method-not-allowed' })
    return
  }

  try {
    const payload = method === 'POST' ? await deps.refresh() : deps.payload()
    sendJson(response, 200, payload)
  } catch (error) {
    sendJson(response, 502, {
      error: 'catalog-unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
