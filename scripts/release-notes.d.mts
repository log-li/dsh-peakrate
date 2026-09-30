/**
 * `scripts/release-notes.mjs` 的类型声明。
 *
 * 脚本本身必须保持 `.mjs`（CI 里用 `node scripts/release-notes.mjs` 直接跑，
 * 不经构建），所以用同目录的 `.d.mts` 与它配对，让测试能 `import` 而不报 TS7016。
 */

/** 从 CHANGELOG 文本中抽出某版本的**中英双语** notes；无匹配返回空字符串。 */
export function extractReleaseNotes(text: string, version: string): string
