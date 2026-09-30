#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽取某个版本的 **双语** Release notes。
 *
 * 为什么是独立脚本（changelog-writing skill §5）：
 * 抽取逻辑**只此一份** —— workflow 与手动刷新都调它，不要在任何一方手写切片命令。
 * 手工切片曾把 Release 页切成只剩英文；`test/release-notes.test.ts` 用一条测试钉死
 * 「抽出的 notes 同时含中英两组标题」，防止再次退化。
 *
 * 用法：
 *   node scripts/release-notes.mjs v0.3.1      # 带不带前导 v 都行
 *   node scripts/release-notes.mjs 0.3.1 > notes.md
 *
 * 输出：英文段 + `---` + 中文段（两段都缺时回落到一行提示）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 中英两个半区的分隔标记（与 CHANGELOG.md 的 `# 更新日志` 标题一致）。 */
const ZH_HEADING = '\n# 更新日志'

/**
 * 从 CHANGELOG 文本中抽出某版本的小节。
 *
 * @param {string} text - CHANGELOG.md 全文。
 * @param {string} version - 版本号（可带前导 `v`）。
 * @returns {string} 中英合并后的 notes（无匹配时为空字符串）。
 */
export function extractReleaseNotes(text, version) {
  const ver = String(version).replace(/^v/, '')
  const at = text.indexOf(ZH_HEADING)
  const en = at === -1 ? text : text.slice(0, at)
  const zh = at === -1 ? '' : text.slice(at + ZH_HEADING.length)

  // `## [x.y.z]` 起，到下一个 `## [` 或文末
  const grab = (block) => {
    if (block === '') return ''
    const start = block.search(new RegExp(`^## \\[${escapeRe(ver)}\\]`, 'm'))
    if (start === -1) return ''
    const rest = block.slice(start)
    const next = rest.slice(1).search(/^## \[/m)
    return (next === -1 ? rest : rest.slice(0, next + 1)).trim()
  }

  const enPart = grab(en)
  const zhPart = grab(zh)
  if (enPart === '' && zhPart === '') return ''
  return zhPart === '' ? enPart : `${enPart}\n\n---\n\n${zhPart}`
}

/** 用户输入不可信（版本号来自命令行）→ 做正则转义。 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 作为脚本直接运行时才读文件 / 输出（被 import 时只导出纯函数，便于测试）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2]
  if (arg === undefined || arg === '') {
    console.error('用法: node scripts/release-notes.mjs <version>')
    process.exit(2)
  }
  const text = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8')
  const notes = extractReleaseNotes(text, arg)
  process.stdout.write(notes === '' ? `Release ${arg} (see CHANGELOG.md)\n` : `${notes}\n`)
}
