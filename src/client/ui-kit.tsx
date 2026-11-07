/**
 * UI 基线（规格 §9）：悬浮提示浅色浮层 + hover 反馈「稍变深」。
 *
 * 两条规矩全插件通用（本任务落到问题浮窗/标签条/返回按钮；后续 C3 设置页复用）：
 * - 悬浮提示一律 LightTooltip：固定浅色底、深色文字，禁黑底，不用原生
 *   `title`（原生黑浮层不受控，且无法浅色）；浮层 pointerEvents none，
 *   不挡点击。
 * - hover 反馈一律「颜色稍变深」：亮度滤镜 brightness(<1)，不反色、
 *   不换底色。行内样式表达不了 `:hover`，所以用 useHoverDarken 的
 *   事件绑定 + 样式展开（`{...bind}` 与 `{...darken}`）实现。
 *
 * 颜色与滤镜都以常量导出，测试直接断言数值（client-tabs.spec 的样式基线
 * 用例），不启 React。
 */

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** 悬浮提示底色：固定浅色，不随暗色主题翻成黑底（规格 §9 禁黑底）。 */
export const LIGHT_TOOLTIP_BG = '#f7f8fa'
/** 悬浮提示文字：深色，保证在浅底上可读。 */
export const LIGHT_TOOLTIP_TEXT = '#1f2126'
/** 悬浮提示描边：浅灰。 */
export const LIGHT_TOOLTIP_BORDER = '#d0d4dd'

/** 浅色悬浮提示的样式（固定值导出，测试断言用）。 */
export const LIGHT_TOOLTIP_STYLE: CSSProperties = {
  position: 'fixed',
  zIndex: 60,
  maxWidth: 280,
  padding: '5px 8px',
  borderRadius: 6,
  border: `1px solid ${LIGHT_TOOLTIP_BORDER}`,
  background: LIGHT_TOOLTIP_BG,
  color: LIGHT_TOOLTIP_TEXT,
  fontSize: 12,
  lineHeight: 1.5,
  boxShadow: '0 4px 12px rgba(31, 33, 38, 0.16)',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
}

/** hover 反馈 = 颜色稍变深：亮度乘 0.94 的滤镜（不反色，规格 §9）。 */
export const HOVER_DARKEN_FILTER = 'brightness(0.94)'

/** hover 时的增量样式：未 hover 不加任何属性（保持元素样式同函数）。 */
export function hoverDarkenStyle(hovered: boolean): CSSProperties {
  return hovered ? { filter: HOVER_DARKEN_FILTER } : {}
}

/** useHoverDarken 返回的事件绑定（直接展开到元素上）。 */
export interface HoverBind {
  onMouseEnter(): void
  onMouseLeave(): void
}

/** hover 稍深的 React 接线：[增量样式, 事件绑定]，配 `style={{...base, ...darken}} {...bind}` 用。 */
export function useHoverDarken(): [CSSProperties, HoverBind] {
  const [hovered, setHovered] = useState(false)
  const bind: HoverBind = {
    onMouseEnter: () => { setHovered(true) },
    onMouseLeave: () => { setHovered(false) },
  }
  return [hoverDarkenStyle(hovered), bind]
}

/**
 * 浅色悬浮提示：hover 触发元素时在其下方弹一条浅色浮层（fixed 定位跟随
 * 触发元素矩形，滚动列 overflow 裁不到它）。替代原生 `title` 黑浮层。
 */
export function LightTooltip(props: { label: string; children: ReactNode }): ReactNode {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  return (
    <span
      style={{ display: 'inline-flex' }}
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        setAnchor({ left: rect.left + rect.width / 2, top: rect.bottom + 6 })
      }}
      onMouseLeave={() => { setAnchor(null) }}
    >
      {props.children}
      {anchor !== null ? (
        <span
          role="tooltip"
          data-router-tooltip={props.label}
          style={{ ...LIGHT_TOOLTIP_STYLE, left: anchor.left, top: anchor.top, transform: 'translateX(-50%)' }}
        >
          {props.label}
        </span>
      ) : null}
    </span>
  )
}
