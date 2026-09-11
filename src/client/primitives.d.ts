/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的环境声明。
 *
 * 该包由 DSH 客户端插件批次在**运行时**提供（不在本项目的 node_modules 里），
 * 因此这里只声明本插件用到的少量导出。图标名与用法**对照官方
 * `dsh-client-ui-model-selection` 的实际产物**（它 require 的就是这些名字）。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type * as React from 'react'

  /** 通用组件属性：允许透传 className / style 等。 */
  interface IconProps {
    className?: string
    size?: number
    style?: React.CSSProperties
  }

  export const IconDataOutline16: React.ComponentType<IconProps>
  export const IconChevronDownOutline14: React.ComponentType<IconProps>
  export const IconChevronRightOutline14: React.ComponentType<IconProps>
  export const IconCheckOutline16: React.ComponentType<IconProps>
  export const IconWarningOutline16: React.ComponentType<IconProps>

  /** 瞬态提示：锚定到某个容器，展示后自行回调结束。 */
  export const Toast: React.ComponentType<{
    text: string
    icon?: React.ReactNode
    anchor?: Element | null
    onDone?: () => void
  }>
}
