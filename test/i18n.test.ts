/**
 * 双语文案契约 —— 防止 zh/en 字典在迭代中悄悄漂移。
 *
 * 背景：本插件的 UI 文案全部经 harness 的 locale 服务（`locale.register` /
 * `locale.bind`），跟随用户的 harness 语言设置。插件扩展功能时会不断加文案，
 * 而**漏翻一处**在中文环境下完全看不出来 —— 只有把 harness 切成英文才会暴露。
 * 因此把「两本字典键集必须完全一致」固化成测试。
 *
 * 注：字典定义在 `src/client/index.tsx`（含 JSX，不便直接 import），
 * 故此处按源码文本解析 —— 与 scripts 里的审计方式一致。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

/** 抽出某个字典对象的键。 */
function keysOf(name: 'zh' | 'en'): string[] {
  const start = SRC.indexOf(`const ${name}: Record<string, string> = {`)
  if (start < 0) throw new Error(`未找到字典 ${name}`)
  const end = SRC.indexOf('\n}', start)
  const block = SRC.slice(start, end)
  return [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1] as string)
}

describe('★ 双语字典契约（zh / en）', () => {
  const zh = keysOf('zh')
  const en = keysOf('en')

  it('zh 字典非空（防止解析失败被当成通过）', () => {
    expect(zh.length).toBeGreaterThan(20)
  })

  it('en 不缺少任何 zh 的键（漏翻会在英文界面暴露中文）', () => {
    expect(zh.filter((k) => !en.includes(k))).toEqual([])
  })

  it('en 没有 zh 不存在的多余键（防复制粘贴残留）', () => {
    expect(en.filter((k) => !zh.includes(k))).toEqual([])
  })

  it('英文值里不含 CJK 字符（漏翻的另一种形态）', () => {
    const start = SRC.indexOf('const en: Record<string, string> = {')
    const block = SRC.slice(start, SRC.indexOf('\n}', start))
    const cjk = [...block.matchAll(/^\s*'([^']+)':\s*'([^']*)'/gm)]
      .filter(([, , value]) => /[\u4e00-\u9fff]/.test(value as string))
      .map(([, key]) => key as string)
    expect(cjk).toEqual([])
  })

  it('中文值里不含成句英文（漏译的另一种形态，允许 Default 这类专名）', () => {
    const start = SRC.indexOf('const zh: Record<string, string> = {')
    const block = SRC.slice(start, SRC.indexOf('\n}', start))
    const allow = new Set(['effort.providerDefault'])
    const latin = [...block.matchAll(/^\s*'([^']+)':\s*'([^']*)'/gm)]
      .filter(([key, , value]) => {
        const k = key as string
        if (allow.has(k)) return false
        return /[A-Za-z]{4,}\s+[A-Za-z]{4,}/.test(value as string) && !/[\u4e00-\u9fff]/.test(value as string)
      })
      .map(([, key]) => key as string)
    expect(latin).toEqual([])
  })
})
