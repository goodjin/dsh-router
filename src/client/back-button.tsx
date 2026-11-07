/**
 * 「返回 Router」浮动按钮（规格 §8 第二条）。
 *
 * 挂点 `shell.overlay`（list、root、frame 级浮层——与问题浮窗同槽位的第二项，
 * id `router-back-button`、order 35 排在问题浮窗 30 之后）：当前会话是本项目
 * 的 worker/主管会话（由 state 的 tabs/tasks 会话集合判定）时，右上角浮动
 * 「← Router」按钮，点击经 uiWorkspace.openSession 回本项目 Router 会话；
 * 当前已是 Router 会话、或本项目还没有 Router 会话时整块不渲染。
 * 可见性/目标是纯函数（client-tabs.spec 断言三态），组件只是订阅者。
 * 样式走 ui-kit 基线：悬浮提示浅色、hover 稍深（规格 §9）。
 */

import { useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { RouterState } from '../shared/view-contract.ts'
import { BACK_BUTTON_ID, BACK_BUTTON_ORDER, BACK_BUTTON_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'
import type { WorkbenchStore } from './workbench-store.ts'
import { LightTooltip, useHoverDarken } from './ui-kit.tsx'

/** 组件的业务输入（registration 的 inject 工厂给的 face；组件绝不收 ctx）。 */
export interface BackButtonFace {
  store: WorkbenchStore
  uiWorkspace: { openSession(target: string): void }
}

export type BackButtonProps = BackButtonFace

/** 把返回按钮注册进 shell.overlay（entry.spec/bundle.spec 断言第二注册项）。 */
export function registerBackButton(slots: SlotsHost, face: BackButtonFace): void {
  slots.inject(BACK_BUTTON_SLOT, () => slots.register(
    { name: BACK_BUTTON_SLOT, id: BACK_BUTTON_ID, order: BACK_BUTTON_ORDER, inject: () => face },
    BackButton,
  ))
}

/** 本项目的 worker/主管会话集合：tabs 是 worker 标签；tasks 带各自绑定的会话 id。 */
export function projectSessionIds(state: RouterState): Set<string> {
  const ids = new Set<string>()
  for (const tab of state.tabs) ids.add(tab.sessionId)
  for (const task of state.tasks) {
    if (typeof task.sessionId === 'string') ids.add(task.sessionId)
  }
  return ids
}

/**
 * 可见性三态（纯函数）：worker/主管会话 + 本项目有 Router → 显示；
 * 当前已是 Router 会话、本项目无 Router、普通会话/无状态 → 隐藏。
 */
export function backButtonVisible(
  currentSessionId: string | undefined,
  state: RouterState | null | undefined,
): boolean {
  if (currentSessionId === undefined) return false
  if (state === null || state === undefined) return false
  if (state.routerSessions.length === 0) return false
  return projectSessionIds(state).has(currentSessionId)
}

/** 返回目标：本项目 Router 会话（服务端顺序第一个）；无 Router 时 undefined。 */
export function backTargetSessionId(state: RouterState | null | undefined): string | undefined {
  return state?.routerSessions[0]?.sessionId
}

/**
 * 位置：右上角头部之下（与问题浮窗同一条右栏）。问题浮窗的堆叠列已把
 * 第一行让给它（question-cards 的 STACK_STYLE top 与这里对齐），同现时
 * 按钮在上、问题卡列在下，互不覆盖。
 */
const POSITION_STYLE: CSSProperties = {
  position: 'fixed',
  top: 52,
  right: 16,
  pointerEvents: 'none',
  zIndex: 45,
}

const BUTTON_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 10px',
  borderRadius: 7,
  border: '1px solid var(--dsh-color-border, #3a3d45)',
  background: 'var(--dsh-color-bg-elevated, #1f2126)',
  color: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/** 浮动按钮组件：不可见返回 null（slot 里不占位）。 */
export function BackButton(props: BackButtonProps): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const [darken, bind] = useHoverDarken()
  const visible = backButtonVisible(state.currentSessionId, state.routerState)
  const target = backTargetSessionId(state.routerState)
  if (!visible || target === undefined) return null
  return (
    <div data-router-back-button style={POSITION_STYLE}>
      <LightTooltip label="返回本项目的 Router 会话">
        <button
          type="button"
          data-router-back-target={target}
          aria-label="返回 Router"
          style={{ ...BUTTON_STYLE, ...darken }}
          {...bind}
          onClick={() => props.uiWorkspace.openSession(target)}
        >
          ← Router
        </button>
      </LightTooltip>
    </div>
  )
}
