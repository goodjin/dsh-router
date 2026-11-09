/**
 * 标签条纯函数（规格 §3.2 两层导航）。
 *
 * Router 会话固定在标签条首位（可多个，保持服务端顺序），worker 标签按
 * 服务端下发顺序（GET /router/state 的 tabs = 持久标签序）排列在后；
 * 关闭 worker 标签只移出标签条（会话与任务不受影响）；激活态 = 当前会话
 * id 映射到标签下标，映射不上（普通会话）时返回 -1 交宿主 UI 处理。
 * 全部是纯函数：不改入参，便于测试与 React 重渲染。
 */

import type { RouterState, WorkerTabInfo } from '../shared/view-contract.ts'

/** 标签条上的一格。kind 区分固定 Router 位与 worker 位。 */
export interface RouterTabEntry {
  kind: 'router' | 'worker'
  sessionId: string
  title: string
  taskId?: string
  taskStatus?: WorkerTabInfo['taskStatus']
  running: boolean
}

/**
 * RouterState → 标签列表：routerSessions 固定在前，tabs（worker）随后。
 * 服务端顺序即最终顺序，这里不做任何重排。
 */
export function buildTabList(state: RouterState): RouterTabEntry[] {
  const routerTabs: RouterTabEntry[] = state.routerSessions.map((session) => ({
    kind: 'router',
    sessionId: session.sessionId,
    title: session.title,
    running: false,
  }))
  const workerTabs: RouterTabEntry[] = state.tabs.map((tab) => ({
    kind: 'worker',
    sessionId: tab.sessionId,
    title: tab.title,
    taskId: tab.taskId,
    taskStatus: tab.taskStatus,
    running: tab.running,
  }))
  return [...routerTabs, ...workerTabs]
}

/** 关闭一个 worker 标签后的重算：移除该格，其余顺序不变。Router 位不受它管。 */
export function removeWorkerTab(tabs: RouterTabEntry[], sessionId: string): RouterTabEntry[] {
  return tabs.filter((tab) => !(tab.kind === 'worker' && tab.sessionId === sessionId))
}

/** 当前会话 id → 标签下标；不在条上（普通会话/无会话）返回 -1。 */
export function activeTabIndex(tabs: RouterTabEntry[], currentSessionId: string | undefined): number {
  if (currentSessionId === undefined) return -1
  return tabs.findIndex((tab) => tab.sessionId === currentSessionId)
}

/** 仅 Router 及其派发会话显示导航；关闭标签不改变任务会话的归属。 */
export function workbenchTabsVisible(
  state: RouterState | null | undefined,
  currentSessionId: string | undefined,
): boolean {
  if (!state || !currentSessionId) return false
  return state.routerSessions.some((row) => row.sessionId === currentSessionId)
    || state.tabs.some((row) => row.sessionId === currentSessionId)
    || state.tasks.some((row) => row.sessionId === currentSessionId)
}
