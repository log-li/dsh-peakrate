/**
 * 覆盖率计算 —— 纯函数，供设置页与审计脚本共用。
 *
 * 动机（2026-09-12 教训）：本插件曾把「数据源没收录某 provider」当成
 * 「该 provider 没有峰谷定价」，于是 `ocg` / `opencode-go` 被静默漏掉。
 * **静默遗漏的根因是「缺少决策」被当成「决策就是不做」。**
 * 因此这里把「哪些 provider/model 命中了、哪些没有」显式算出来给人看。
 */
import { matchProfile, UNMATCHED_BY_DESIGN, type MatchConfig, type RateProfile } from './matching.js'

/** 模型目录里的一行（只取本模块需要的字段）。 */
export interface CoverageModel {
  id: string
  name: string
}

/** 模型目录里的一个 provider 分组。 */
export interface CoverageGroup {
  id: string
  name: string
  models: readonly CoverageModel[]
}

/** 单个 provider 的覆盖情况。 */
export interface ProviderCoverage {
  id: string
  name: string
  /** 命中的行数。 */
  matched: number
  /** 未命中的行数。 */
  unmatched: number
  rows: {
    modelId: string
    modelName: string
    /** 命中的 profile 展示名（`providerName · modelLabel`）；未命中为 undefined。 */
    profileLabel?: string
  }[]
  /** 该 provider 整体未映射时的已知理由（来自 UNMATCHED_BY_DESIGN）。 */
  reason?: string
  /** 该 provider 是否在别名表里有映射（与具体模型是否命中无关）。 */
  knownProvider: boolean
}

/** 整份覆盖报告。 */
export interface CoverageReport {
  providers: ProviderCoverage[]
  matchedTotal: number
  unmatchedTotal: number
  /** 存在未命中项的 provider 数（设置页据此给提示）。 */
  providersWithGaps: number
}

/**
 * 计算当前配置下的覆盖率报告。
 *
 * @param groups - 来自共享模型目录的 provider 分组。
 * @param profiles - 可用 profile 列表。
 * @param aliases - 生效的 provider 别名表（含内置与用户覆盖）。
 * @param config - 匹配配置（别名/映射覆盖）。
 * @returns 逐 provider 的覆盖情况与合计。
 */
export function buildCoverage(
  groups: readonly CoverageGroup[],
  profiles: readonly RateProfile[],
  aliases: Record<string, string>,
  config: MatchConfig = {},
): CoverageReport {
  const providers: ProviderCoverage[] = groups.map((group) => {
    const rows = group.models.map((model) => {
      const hit = matchProfile(group.id, model.id, [...profiles], config)
      return {
        modelId: model.id,
        modelName: model.name,
        ...(hit === undefined
          ? {}
          : { profileLabel: `${hit.providerName} · ${hit.modelLabel}` }),
      }
    })
    const matched = rows.filter((r) => r.profileLabel !== undefined).length
    const reason = UNMATCHED_BY_DESIGN[group.id]
    return {
      id: group.id,
      name: group.name,
      matched,
      unmatched: rows.length - matched,
      rows,
      ...(reason === undefined ? {} : { reason }),
      knownProvider: aliases[group.id] !== undefined,
    }
  })

  const matchedTotal = providers.reduce((n, p) => n + p.matched, 0)
  const unmatchedTotal = providers.reduce((n, p) => n + p.unmatched, 0)
  return {
    providers,
    matchedTotal,
    unmatchedTotal,
    providersWithGaps: providers.filter((p) => p.unmatched > 0).length,
  }
}

/**
 * 挑出「**可能漏配**」的 provider —— 即完全没有任何模型命中的 provider。
 *
 * 这是唯一值得提醒的情况：部分命中是正常的（同一 provider 下混有非峰谷计价的模型），
 * 而**整组都不命中**才可能是映射缺失或 endpoint 未被识别。
 *
 * @param report - 覆盖率报告。
 * @returns 可疑 provider（已排除在 UNMATCHED_BY_DESIGN 里写明理由的）。
 */
export function suspiciousProviders(report: CoverageReport): ProviderCoverage[] {
  return report.providers.filter(
    (p) => p.rows.length > 0 && p.matched === 0 && p.reason === undefined,
  )
}
