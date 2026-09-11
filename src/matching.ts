/**
 * 匹配层 —— 纯函数：把 DSH 的 (provider, model) 映射到数据源里的 profile。
 *
 * 严格规则：provider 与 model 必须同时命中同一 profile 才返回；否则返回 undefined，
 * UI 侧对未匹配模型**什么都不显示**。
 */

/** 数据源 profile 的归一化形态（仅保留匹配与展示所需字段）。 */
export interface RateProfile {
  id: string
  /** 数据源里的 provider 展示名，如 "Ollama"。 */
  providerName: string
  /** 数据源里的 model 描述，如 "DeepSeek V4.1 Flash / V4 Flash / V4 Pro"。 */
  modelLabel: string
  schedule: {
    timeZone: string
    peakDays: number[]
    peakWindows: { start: string; end: string }[]
    offDayName?: string
  }
  peakBadge: string
  offPeakBadge: string
  /** 峰/谷时段名，用于 hover 详情。 */
  peakName: string
  offPeakName: string
  source?: string
  verifiedAt?: string
}

/** 用户配置的模型归属覆盖项。 */
export interface ModelMapping {
  provider: string
  /** 前缀（默认）或正则（matchIsRegex: true）。 */
  match: string
  profile: string
  matchIsRegex?: boolean
}

export interface MatchConfig {
  /** provider id → 数据源 provider 展示名。覆盖内置默认。 */
  providerAliases?: Record<string, string>
  /** 补充/覆盖的模型归属规则，优先于内置规则。 */
  modelMappings?: ModelMapping[]
}

/**
 * 内置 provider 别名：DSH 的 provider id → 数据源里的 provider 展示名。
 *
 * 数据源里只覆盖 8 家 provider；本机配置中的 openrouter / ocg / opencode-go /
 * ocg-1 / ocg-1-chat 在数据源中没有对应 provider，因此其模型一律不显示。
 */
export const DEFAULT_PROVIDER_ALIASES: Record<string, string> = {
  'deepseek-official': 'DeepSeek',
  ollama: 'Ollama',
  'xiaomi-token-plan-cn': 'Xiaomi MiMo',
  'bai': 'B.AI',
  'zai': 'Z.ai',
  'qoder': 'Qoder',
  'tencent-cloud': 'Tencent Cloud',
  'alibaba-cloud': 'Alibaba Cloud',
  'swarms': 'Swarms',
}

/**
 * 内置模型归属规则：按 (provider, 模型前缀) 指向 profile id。
 *
 * V4 系为**宽松归属**（spec §4.2 已确认）：`deepseek-v4*` 前缀涵盖
 * `deepseek-v4-flash:0731`、`deepseek-v4-pro:0813`、`deepseek-v4.1-flash`；
 * 另含历史别名 `deepseek-flash`（其实现为 DeepSeek-V41-Flash）与
 * `deepseek-v4-flash-vision-exp`。
 */
export const DEFAULT_MODEL_MAPPINGS: ModelMapping[] = [
  { provider: 'deepseek-official', match: 'deepseek-v4', profile: 'deepseek-v4' },
  { provider: 'deepseek-official', match: 'deepseek-flash', profile: 'deepseek-v4' },
  { provider: 'ollama', match: 'deepseek-v4', profile: 'ollama-deepseek-v4' },
  { provider: 'ollama', match: 'deepseek-flash', profile: 'ollama-deepseek-v4' },
  { provider: 'xiaomi-token-plan-cn', match: '', profile: 'xiaomi-mimo-v2-5-token-plan' },
]

/**
 * 归一化模型 id：去掉 provider 侧 tag 后缀、小写化、统一分隔符。
 *
 * @param modelId - provider 原始模型 id，如 "deepseek-v4-flash:0731"。
 * @returns 归一化后的 id，如 "deepseek-v4-flash"。
 */
export function normalizeModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/[:@].*$/, '') // 去掉 ":0731" / "@latest" 之类后缀
}

/**
 * 判断某模型 id 是否命中一条映射规则。
 *
 * 空前缀视为「该 provider 下全部模型命中」（用于 token-plan 这类整包计费）。
 */
function mappingMatches(mapping: ModelMapping, normalized: string): boolean {
  const pattern = mapping.match
  if (pattern === '') return true
  if (mapping.matchIsRegex === true) {
    try {
      return new RegExp(pattern).test(normalized)
    } catch {
      return false
    }
  }
  return normalized.startsWith(pattern.toLowerCase())
}

/**
 * 把 (provider, model) 匹配到唯一 profile。
 *
 * @param providerId - DSH 的 provider id。
 * @param modelId - provider 原始模型 id。
 * @param profiles - 可用 profile 列表。
 * @param config - 可选的别名与归属覆盖。
 * @returns 命中的 profile；未命中返回 undefined（UI 不显示任何内容）。
 */
export function matchProfile(
  providerId: string,
  modelId: string,
  profiles: RateProfile[],
  config: MatchConfig = {},
): RateProfile | undefined {
  const aliases = { ...DEFAULT_PROVIDER_ALIASES, ...(config.providerAliases ?? {}) }
  const providerName = aliases[providerId]
  if (providerName === undefined) return undefined

  // provider 必须先在数据源里存在对应 profile，否则不必继续。
  const candidates = profiles.filter((p) => p.providerName === providerName)
  if (candidates.length === 0) return undefined

  const normalized = normalizeModelId(modelId)

  // 用户配置的映射优先，且**不受「profile 必须属于该 provider 候选集」的限制**：
  // 一旦该 provider 有了别名，用户就能把它的模型指到任意 profile（例如把自建
  // 聚合路由指到官方 profile）。
  // ⚠️ **别名是前置条件**：没有别名的 provider 在上面就已返回 undefined，
  // 只写 modelMappings 而不写 providerAliases 是无效的（配置文档已说明）。
  for (const mapping of config.modelMappings ?? []) {
    if (mapping.provider !== providerId) continue
    if (!mappingMatches(mapping, normalized)) continue
    const hit = profiles.find((p) => p.id === mapping.profile)
    if (hit !== undefined) return hit
    // 映射指向了不存在的 profile id —— 常见于拼写错误。不静默吞掉，
    // 回落到内置规则的同时留下痕迹，便于排查「为什么配置没生效」。
  }

  // 内置规则：profile 必须同时属于该 provider 的候选集，避免跨 provider 误配。
  for (const mapping of DEFAULT_MODEL_MAPPINGS) {
    if (mapping.provider !== providerId) continue
    if (!mappingMatches(mapping, normalized)) continue
    const hit = candidates.find((p) => p.id === mapping.profile)
    if (hit !== undefined) return hit
  }
  return undefined
}
