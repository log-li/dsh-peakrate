/** esbuild `--loader:.css=text` 把 CSS 作为字符串模块导入。 */
declare module '*.css' {
  const content: string
  export default content
}
