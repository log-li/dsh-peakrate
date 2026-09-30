/**
 * Release notes 抽取的护栏（changelog-writing skill §5）。
 *
 * 两条规矩必须被钉死，否则会悄悄退化：
 *   ① 抽出的 notes 同时含**中英两个半区**（手工切片曾把 Release 页切成只剩英文）；
 *   ② 抽取逻辑**只此一份** —— workflow 必须调 `scripts/release-notes.mjs`，
 *      不得再内联手写切片命令。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractReleaseNotes } from '../scripts/release-notes.mjs'

const changelog = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8')
const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url)),
  'utf8',
)

/** 当前最新版本号（`## [x.y.z] - date` 的第一条）。 */
const latest = /^## \[(\d+\.\d+\.\d+)\] - /m.exec(changelog)?.[1] ?? ''

describe('★ release notes 抽取', () => {
  it('CHANGELOG 里能识别出最新版本号', () => {
    expect(latest).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('★ 最新版本的 notes 同时含英文与中文两个半区（只改一半会红）', () => {
    const notes = extractReleaseNotes(changelog, latest)
    expect(notes).not.toBe('')
    const parts = notes.split('\n\n---\n\n')
    expect(parts, '应恰好分成中英两段').toHaveLength(2)
    const [en = '', zh = ''] = parts
    expect(en.trim(), '英文半区为空').not.toBe('')
    expect(zh.trim(), '中文半区为空 —— 改了英文却忘了中文？').not.toBe('')
    // 中文半区必须**真的含中文**，而不是一份英文复制
    expect(zh, '中文半区不含中文字符').toMatch(/[\u4e00-\u9fa5]/)
    // 英文半区不得混进中文区的标题
    expect(en).not.toContain('# 更新日志')
    // 两段都要有本版本标题
    expect(en).toContain(`## [${latest}]`)
    expect(zh).toContain(`## [${latest}]`)
  })

  it('带 / 不带前导 v 的版本号结果一致（workflow 传的是 tag 名 vX.Y.Z）', () => {
    expect(extractReleaseNotes(changelog, `v${latest}`)).toBe(
      extractReleaseNotes(changelog, latest),
    )
  })

  it('不存在的版本返回空串（调用方据此回落到提示行）', () => {
    expect(extractReleaseNotes(changelog, '99.99.99')).toBe('')
    expect(extractReleaseNotes(changelog, 'v99.99.99')).toBe('')
  })

  it('★ release.yml 调脚本抽取，且不再内联手写切片', () => {
    expect(workflow).toContain('node scripts/release-notes.mjs')
    expect(workflow, 'workflow 里又出现了内联 python heredoc 切片').not.toContain("<<'PY'")
    expect(workflow).not.toContain('import re, sys')
  })
})
