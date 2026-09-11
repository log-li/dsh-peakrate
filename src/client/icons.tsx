/**
 * 倍率图标 —— 单色描边 SVG，**风格对齐 DSH 自带图标**（如 auto-mode 的盾牌系列）：
 * `viewBox="0 0 16 16"`、`fill="none"`、`stroke="currentColor"`、描边 1.4、
 * 圆角端点，颜色继承自外层（峰时警示色 / 谷时次级色）。
 *
 * 语义（2026-09-12 修订）：**双峰山 = 峰时**、**双谷 = 谷时**、**星芒 = 限时活动**。
 *
 * **为什么从「折线箭头」改成「波峰/波谷」**（用户指出）：
 * 折线上扬/下探带箭头，容易被读成「**之后会涨/跌**」——那是**方向**语义，
 * 而本图标要表达的是「**此刻处于高位还是低位**」。方向 ≠ 形状。
 * 波峰/波谷是**形状**：山不是「在上升」，它本身就是高点，歧义消失。
 * （中文语境里「峰/谷」也正好对应峰时/谷时。）
 * 曾用 emoji（🌙 / ⚡）—— 彩色 emoji 与单色 UI 语言冲突、观感突兀，故改为内联 SVG。
 */
import * as React from 'react'
import type { Period } from '../schedule.js'

/** 图标属性。 */
interface RateIconProps {
  /** 时段态：峰 / 谷 / 活动。 */
  period: Period
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
    strokeWidth: period === 'campaign' ? 1.4 : 1.35,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
    focusable: false,
  }
  // 活动态：四角星芒（限时/特惠），与折线区分明显
  if (period === 'campaign') {
    return React.createElement(
      'svg',
      common,
      React.createElement('path', {
        d: 'M8 2.2l1.5 4.1 4.1 1.7-4.1 1.7L8 13.8l-1.5-4.1L2.4 8l4.1-1.7z',
      }),
    )
  }
  // 双峰山 / 双谷：形状本身表达高/低，不暗示方向。
  // 用「两座山 / 两道谷」而非单个拱形 —— 更像地貌、也更易在 13px 下辨认。
  const curve =
    period === 'peak'
      ? 'M1.5 12.5 5 6.5l3 4 3-4 3.5 6'
      : 'M1.5 3.5 5 9.5l3-4 3 4 3.5-6'
  return React.createElement('svg', common, React.createElement('path', { d: curve }))
}
