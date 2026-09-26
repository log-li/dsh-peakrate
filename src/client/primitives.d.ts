/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的环境声明。
 *
 * 该包**不在本项目的 node_modules 里**：DSH 前端 shell 把它作为 baseline 模块
 * 注册进 `window.__ModuleLoader__`（`dsh-web-frontend` 的产物里能查到
 * `"@deepseek-ai/dsh-client-ui-primitives": <module>` 这条映射），client 插件
 * 批次在**运行时**按名 require 到它。因此这里只声明本插件用到的少量导出，
 * **名字与签名对照 0.1.7-rc.2 的实际产物**（官方
 * `dsh-client-ui-model-selection` 的 lib/client.js 里 require 的就是这些名字）。
 *
 * ⚠️ 图标命名在 0.1.7 从 `Icon*Outline16/14` 换成了 `Icon*OutlineRegular`
 * （尺寸改由 `size` prop 给）：旧名在 0.1.7 的导出面上**不存在**，取到的是
 * `undefined`，render 期会抛 React「Element type is invalid」——正是
 * 「模型选择器整块崩掉、用户换不了模型」那一类事故。这份声明必须跟着一起改，
 * 否则 tsc 会继续替旧名背书（旧声明就是这么把缺陷藏住的）。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type * as React from 'react'

  /** 图标属性：0.1.7 起尺寸走 `size`，不再由图标名携带。 */
  interface IconProps {
    className?: string
    size?: number
    style?: React.CSSProperties
  }

  export const IconDataOutlineRegular: React.ComponentType<IconProps>
  export const IconChevronDownOutlineRegular: React.ComponentType<IconProps>
  export const IconChevronRightOutlineRegular: React.ComponentType<IconProps>
  export const IconCheckOutlineRegular: React.ComponentType<IconProps>
  export const IconWarningOutlineRegular: React.ComponentType<IconProps>

  /** 菜单材质面：portal 定位、圆角与毛玻璃填充由它提供，className/style 透传。 */
  export const MenuSurface: React.ForwardRefExoticComponent<
    React.PropsWithoutRef<React.HTMLAttributes<HTMLDivElement> & { compact?: boolean }> &
      React.RefAttributes<HTMLDivElement>
  >

  /** 状态点：`ongoing` 渲染旋转的 loader，其余为实心点。 */
  export const StateDot: React.ComponentType<{
    state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
    size?: number
    className?: string
    appearance?: 'dot' | 'step'
  }>

  /** 瞬态提示：锚定到某个容器，展示后自行回调结束。 */
  export const Toast: React.ComponentType<{
    text: string
    icon?: React.ReactNode
    tone?: 'success'
    anchor?: Element | null
    holdMs?: number
    onDone: () => void
  }>

  /* ------------------------------------------------------------------ *
   * 设置表单（`settings-form/`）—— 官方「插件配置」卡片的**分阶段表单**工具箱。
   * 用户编辑先落在草稿上，只有 save 才写成一次 revision 围栏内的文档变更。
   * ------------------------------------------------------------------ */

  /** 一个 host 配置命名空间的表单读数（ui-settings 的 ConfigForm 快照）。 */
  export interface SettingsFormScopeSnapshot<T> {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    base: unknown
    user: unknown
    writable: boolean
    revision: number | undefined
  }

  /** 一次保存要写的路径编辑。 */
  export type SettingsFormPathOp =
    | { op: 'set'; path: readonly string[]; value: unknown }
    | { op: 'unset'; path: readonly string[] }

  /** 表单要读写的那个命名空间（= `configForms.get(namespace)` 的返回值）。 */
  export interface SettingsFormScope<T> {
    getSnapshot: () => SettingsFormScopeSnapshot<T>
    subscribe: (listener: () => void) => () => void
    mutate: (
      ops: readonly SettingsFormPathOp[],
      expectedRevision?: number,
    ) => Promise<boolean>
  }

  /** 一个字段的草稿态。 */
  export interface SettingsFieldState {
    text: string
    overridden: boolean
    invalid: boolean
  }

  /** 卡片级表单状态。 */
  export interface SettingsFormShell {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }

  /** 每个卡片注入的写操作。 */
  export interface SettingsFormActions {
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
    save: () => void
    discard: () => void
  }

  /** 表单框所需的文案。 */
  export interface SettingsFormLabels {
    unavailable: string
    readOnly: string
    saveFailed: string
    save: string
    saving: string
  }

  /** 数字字段的转换规则（`settingsNumberField()` 的返回值）。 */
  export interface SettingsFieldSpec {
    field: string
  }

  /** 整数/数字字段。 */
  export function settingsNumberField(field: string): SettingsFieldSpec

  /** 自由文本字段。 */
  export function settingsTextField(field: string): SettingsFieldSpec

  /** 把某个命名空间的分阶段表单模型：草稿 → 一次 revision 围栏保存。 */
  export class SettingsFormModel<T> {
    constructor(scope: SettingsFormScope<T>, specs: SettingsFieldSpec[], secrets?: unknown[])
    bind<S>(project: () => S): { getSnapshot: () => S; subscribe: (fn: () => void) => () => void }
    shell(): SettingsFormShell
    field(field: string): SettingsFieldState
    actions(): SettingsFormActions
    dispose(): void
  }

  /** 表单框：只读/不可用提示 + 控件 + 保存。 */
  export const SettingsForm: React.ComponentType<{
    labels: SettingsFormLabels
    state: SettingsFormShell
    onSave: () => void
    onDiscard: () => void
    children?: React.ReactNode
  }>

  /** 一个分阶段的取值控件。 */
  export const SettingsValueField: React.ComponentType<{
    id: string
    label: string
    hint?: string
    text: string
    overridden: boolean
    invalid: boolean
    overriddenLabel: string
    resetLabel: string
    invalidLabel: string
    disabled: boolean
    numeric?: boolean
    placeholder?: string
    onEdit: (text: string) => void
    onReset: () => void
  }>
}
