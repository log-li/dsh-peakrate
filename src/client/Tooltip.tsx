/**
 * 自绘悬停卡片（DOM tooltip）。
 *
 * ## 为什么不用原生 `title`
 *
 * 徽章详情原本走浏览器**原生** `title`：由操作系统渲染、有约 1 秒延迟、样式是系统灰框，
 * 与本应用的 `--dsw-*` 设计语言**不搭**；而且它**不在页面内**，`page.screenshot()`
 * 与 CDP 都抓不到 —— 也就是说这项能力**没法用截图表达**，而截图恰恰是 README 里
 * 最直观、最精炼的说明方式。
 *
 * 自绘之后：视觉与官方菜单同构、延迟可控、跟随明暗主题，并且**可以被截图**。
 *
 * 定位与 `ModelSelect` 的菜单同一套做法（portal 到 body、先测量再夹进视口），
 * 区别只是方向偏好：徽章在屏幕底部，所以默认**向上**展开。
 */
import * as React from 'react'
import { createPortal } from 'react-dom'

/** 视口边缘留白。 */
const MARGIN = 12
/** 浮层与锚点之间的间距。 */
const GAP = 8

export interface HoverCardProps {
  /** 触发的锚点元素；为 null 时不渲染。 */
  anchor: HTMLElement | null
  /** 是否显示。 */
  open: boolean
  /** 无障碍标签。 */
  label?: string
  /** 卡片内容（React 以 rest 参数传入，故为可选）。 */
  children?: React.ReactNode
}

/**
 * 锚定在 `anchor` 附近的浮层卡片。
 *
 * @param props - 锚点、开关、无障碍标签与内容。
 */
export function HoverCard(props: HoverCardProps): React.ReactElement | null {
  const { anchor, open, label, children } = props
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)

  React.useLayoutEffect(() => {
    if (!open || anchor === null) {
      setPos(null)
      return
    }
    /**
     * 重新测量并定位。
     *
     * ⚠ **必须在每次渲染后都跑**（故无依赖数组）：首次定位发生在浮层还没绘制时，
     * `offsetHeight` 为 0 → 会把它当成「高度 0」放在徽章正上方，结果**压在徽章上**。
     * 绘制后再校正一次，`pos` 变化触发重渲染，测量值稳定后自然收敛
     * （只在差值 > 0.5px 时 setPos，不会死循环）。
     */
    const place = (): void => {
      const rect = anchor.getBoundingClientRect()
      const w = ref.current?.offsetWidth ?? 0
      const h = ref.current?.offsetHeight ?? 0
      // 优先向上展开（徽章贴着屏幕底部）；上方放不下再翻到下方
      let top = rect.top - GAP - h
      if (h > 0 && top < MARGIN) top = rect.bottom + GAP
      let left = rect.left
      if (w > 0) left = Math.min(Math.max(left, MARGIN), window.innerWidth - w - MARGIN)
      if (h > 0) top = Math.min(Math.max(top, MARGIN), window.innerHeight - h - MARGIN)
      setPos((prev) =>
        prev !== null && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5
          ? prev
          : { left, top },
      )
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  })

  if (!open || anchor === null || pos === null) return null

  return createPortal(
    React.createElement(
      'div',
      {
        ref,
        role: 'tooltip',
        'aria-label': label,
        className: 'dsh-peakrate-ms-menu dsh-peakrate-hover',
        style: pos,
      },
      children,
    ),
    document.body,
  )
}
