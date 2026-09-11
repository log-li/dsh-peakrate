/**
 * 倍率图标 —— 单色描边 SVG，**风格对齐 DSH 自带图标**（如 auto-mode 的盾牌系列）：
 * `viewBox="0 0 16 16"`、`fill="none"`、`stroke="currentColor"`、描边 1.4、
 * 圆角端点，颜色继承自外层（峰时警示色 / 谷时次级色）。
 *
 * 语义：**涨 = 贵（峰时）**，**跌 = 便宜（谷时）**。
 * 曾用 emoji（🌙 / ⚡）—— 彩色 emoji 与单色 UI 语言冲突、观感突兀，故改为内联 SVG。
 */
import * as React from 'react'

/** 图标属性。 */
interface RateIconProps {
  /** 当前是峰时还是谷时。 */
  period: 'peak' | 'offPeak'
  /** 边长（px），默认 14。 */
  size?: number
  className?: string
}

/**
 * 倍率图标：峰时上扬、谷时下探。
 *
 * @param props - 时段、尺寸与类名。
 */
export function RateIcon({
  period,
  size = 14,
  className,
}: RateIconProps): React.ReactElement {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
    focusable: false,
  }
  // 折线：谷→峰（上扬）或 峰→谷（下探），末段带箭头
  const points =
    period === 'peak' ? 'M2.5 11.5 6 8l2.5 2.5L14 5' : 'M2.5 4.5 6 8l2.5-2.5L14 11'
  const arrow =
    period === 'peak' ? 'M10.5 5H14v3.5' : 'M10.5 11H14V7.5'
  return React.createElement(
    'svg',
    common,
    React.createElement('path', { d: points }),
    React.createElement('path', { d: arrow }),
  )
}
