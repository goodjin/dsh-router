import type { CSSProperties } from 'react'
import type { RouterState } from '../shared/view-contract.ts'

export const OVERLAY_BATCH_SIZE = 3

/** 沿父任务/派发会话反查 Router；环或缺失归属不猜测成当前 Router。 */
export function taskRouterSession(state: RouterState, taskId: string | undefined): string | undefined {
  const seen = new Set<string>()
  let task = state.tasks.find((row) => row.taskId === taskId)
  while (task && !seen.has(task.taskId)) {
    seen.add(task.taskId)
    const source = task.dispatchedBySessionId
    if (state.routerSessions.some((row) => row.sessionId === source)) return source
    task = state.tasks.find((row) => row.taskId === task?.parentId)
      ?? state.tasks.find((row) => row.sessionId === source)
  }
  return undefined
}

export function overlayRouterSession(state: RouterState | null, sessionId: string | undefined): string | undefined {
  if (!state || !sessionId) return undefined
  if (state.routerSessions.some((row) => row.sessionId === sessionId)) return sessionId
  return taskRouterSession(state, state.tasks.find((row) => row.sessionId === sessionId)?.taskId)
}

export function overlayBatch<T>(items: readonly T[], page: number): { items: T[]; page: number; pages: number; remaining: number } {
  const pages = Math.max(1, Math.ceil(items.length / OVERLAY_BATCH_SIZE))
  const current = Math.min(Math.max(0, page), pages - 1)
  const visible = items.slice(current * OVERLAY_BATCH_SIZE, (current + 1) * OVERLAY_BATCH_SIZE)
  return { items: visible, page: current, pages, remaining: items.length - visible.length }
}

/** 桌面右边距 20px；360px 宽、最窄缩至视口内；底边始终留 20px。 */
export const OVERLAY_STACK_STYLE: CSSProperties = {
  position: 'fixed', top: 'min(88px, 15dvh)', right: 20,
  width: 'min(360px, calc(100vw - 40px))',
  maxHeight: 'calc(100dvh - min(88px, 15dvh) - 20px)',
  display: 'flex', flexDirection: 'column', gap: 8,
  overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain',
  pointerEvents: 'auto', zIndex: 40,
}

/** 展开卡最多 680px，短视口时扣除队列操作区；长内容在卡内滚动。 */
export const OVERLAY_CARD_SIZE: CSSProperties = {
  maxHeight: 'min(680px, calc(100dvh - min(88px, 15dvh) - 100px))',
  overflowY: 'auto', overflowWrap: 'anywhere', minWidth: 0, flexShrink: 0, boxSizing: 'border-box',
}
