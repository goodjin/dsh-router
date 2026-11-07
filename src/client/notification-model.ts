/**
 * 统一通知卡纯逻辑（v1.2 Task C1，规格 §5）。
 *
 * 动作映射（cardActionPlan）：rework/redispatch/cancel → 控制路由；unfreeze →
 * 熔断解除；ack → 通知确认；open-session → 本地导航；view-result → 如实置灰
 * （宿主无结果文档查看路由）。卡片队列 reducer：多卡排队新在前、UI 状态跨
 * 轮询保持、提交窗口 submitting→acking→移除、失败保留可重试；动作已生效但
 * 确认失败只补确认不重发动作（actionApplied 防重复退回重做）。
 *
 * @module @goodjin2/dsh-router/client/notification-model
 */

import type { NotificationActionKind, NotificationCard, RouterState, TaskCard, WorkerTabInfo } from '../shared/view-contract.ts'

/** 一张卡在 UI 上的生命周期相位。 */
export type NotificationPhase = 'idle' | 'submitting' | 'acking' | 'failed'

/** 队列里的一张卡（card 为服务端投影，其余为本地 UI 状态）。 */
export interface NotificationCardEntry {
  card: NotificationCard
  phase: NotificationPhase
  collapsed: boolean
  error?: string
  /** 动作已生效（仅确认失败时置 true）：重试只补确认，不再重发动作。 */
  actionApplied?: boolean
}

/** 通知卡面板状态。 */
export interface NotificationBoard {
  cards: NotificationCardEntry[]
}

export function emptyNotifications(): NotificationBoard {
  return { cards: [] }
}

/** 请求通道（UI 层据此调 api；模型层不发网络）。 */
export type NotificationRequest =
  | { channel: 'control'; taskId: string; action: 'pause' | 'resume' | 'cancel' | 'redispatch' }
  | { channel: 'unfreeze' }
  | { channel: 'ack'; cardId: string }

/** 动作计划：发请求 / 本地导航 / 置灰（带原因）。 */
export type NotificationActionPlan =
  | { type: 'request'; request: NotificationRequest }
  | { type: 'open-session'; sessionId: string }
  | { type: 'disabled'; reason: string }

/** 动作 → 请求/本地行为映射（纯函数）。 */
export function cardActionPlan(cardData: NotificationCard, action: NotificationActionKind, sessionTarget?: string): NotificationActionPlan {
  switch (action) {
    case 'rework':
    case 'redispatch':
    case 'cancel': {
      if (cardData.taskId === undefined) {
        return { type: 'disabled', reason: '该卡未关联任务，无法执行此动作' }
      }
      // rework 与异常卡的「重派」共用控制路由的 redispatch（宿主侧 =
      // supplement「用户重派」+ 回 running + 重派，即退回重做语义）。
      return { type: 'request', request: { channel: 'control', taskId: cardData.taskId, action: action === 'cancel' ? 'cancel' : 'redispatch' } }
    }
    case 'unfreeze':
      return { type: 'request', request: { channel: 'unfreeze' } }
    case 'ack':
      return { type: 'request', request: { channel: 'ack', cardId: cardData.cardId } }
    case 'open-session':
      return sessionTarget === undefined
        ? { type: 'disabled', reason: '未找到该任务的会话' }
        : { type: 'open-session', sessionId: sessionTarget }
    case 'view-result':
      // 宿主暂无结果文档查看路由：如实置灰（打开会话可看交付过程与 result 摘要）。
      return { type: 'disabled', reason: '结果文档请在任务会话中查看（宿主暂无独立查看路由）' }
  }
}

/** 卡的任务 → 会话解析（tasks 优先，tabs 兜底）。 */
export function cardSessionTarget(taskId: string | undefined, tasks: readonly TaskCard[], tabs: readonly WorkerTabInfo[]): string | undefined {
  if (taskId === undefined) return undefined
  const task = tasks.find((entry) => entry.taskId === taskId)
  if (task?.sessionId !== undefined) return task.sessionId
  return tabs.find((entry) => entry.taskId === taskId)?.sessionId
}

/** 按钮可用性（置灰逻辑）。 */
export function actionAvailable(
  cardData: NotificationCard,
  action: NotificationActionKind,
  sessionTarget: string | undefined,
  actionApplied: boolean,
): { available: boolean; reason?: string } {
  if (actionApplied) {
    // 动作已生效：只留确认可用——防止重复退回重做/重复取消。
    return action === 'ack' ? { available: true } : { available: false, reason: '动作已生效，等待确认' }
  }
  if (action === 'view-result') return { available: false, reason: '结果文档请在任务会话中查看' }
  if (action === 'open-session') {
    return sessionTarget === undefined ? { available: false, reason: '未找到该任务的会话' } : { available: true }
  }
  if (action === 'rework' || action === 'redispatch') {
    // 退回重做/重派要重新触达执行会话：既要有任务也要能定位会话。
    if (cardData.taskId === undefined) return { available: false, reason: '该卡未关联任务' }
    return sessionTarget === undefined ? { available: false, reason: '未找到该任务的会话' } : { available: true }
  }
  if (action === 'cancel') {
    return cardData.taskId === undefined ? { available: false, reason: '该卡未关联任务' } : { available: true }
  }
  return { available: true }
}

function entryFor(cardData: NotificationCard): NotificationCardEntry {
  return { card: cardData, phase: 'idle', collapsed: true }
}

/** 轮询合流：服务端序入队；已存卡保留 UI 状态；在途（submitting/acking）卡即使服务端已移除也保留在前。 */
export function syncedNotifications(board: NotificationBoard, serverCards: readonly NotificationCard[]): NotificationBoard {
  const serverById = new Map(serverCards.map((cardData) => [cardData.cardId, cardData]))
  const kept: NotificationCardEntry[] = []
  for (const entry of board.cards) {
    const inFlight = entry.phase === 'submitting' || entry.phase === 'acking'
    const fresh = serverById.get(entry.card.cardId)
    if (inFlight || fresh !== undefined) {
      kept.push(fresh !== undefined ? { ...entry, card: fresh } : entry)
      serverById.delete(entry.card.cardId)
    }
  }
  const appended = [...serverById.values()].map(entryFor)
  const cards = [...kept, ...appended]
  return cards === board.cards ? board : { cards }
}

function mapCard(board: NotificationBoard, cardId: string, fn: (entry: NotificationCardEntry) => NotificationCardEntry | null): NotificationBoard {
  let changed = false
  const cards: NotificationCardEntry[] = []
  for (const entry of board.cards) {
    if (entry.card.cardId !== cardId) {
      cards.push(entry)
      continue
    }
    const next = fn(entry)
    if (next === null) {
      changed = true
      continue
    }
    cards.push(next)
    if (next !== entry) changed = true
  }
  return changed ? { cards } : board
}

/** 动作开始：idle/failed → submitting；其余相位无操作（返回原引用）。 */
export function notificationActionStarted(board: NotificationBoard, cardId: string): NotificationBoard {
  return mapCard(board, cardId, (entry) => (entry.phase === 'idle' || entry.phase === 'failed' ? { ...entry, phase: 'submitting', error: undefined } : entry))
}

/** 动作成功：submitting → acking（随后走确认；确认成功移除）。 */
export function notificationActionSucceeded(board: NotificationBoard, cardId: string): NotificationBoard {
  return mapCard(board, cardId, (entry) => (entry.phase === 'submitting' ? { ...entry, phase: 'acking' } : entry))
}

/** 动作失败：submitting → failed（错误文案；卡片保留可重试）。 */
export function notificationActionFailed(board: NotificationBoard, cardId: string, error: string): NotificationBoard {
  return mapCard(board, cardId, (entry) => (entry.phase === 'submitting' ? { ...entry, phase: 'failed', error } : entry))
}

/** 确认开始：failed/acking 内部转场 → acking。 */
export function notificationAckStarted(board: NotificationBoard, cardId: string): NotificationBoard {
  return mapCard(board, cardId, (entry) => (entry.phase === 'failed' || entry.phase === 'acking' ? { ...entry, phase: 'acking', error: undefined } : entry))
}

/** 确认成功：移除该卡。 */
export function notificationAckSucceeded(board: NotificationBoard, cardId: string): NotificationBoard {
  return mapCard(board, cardId, () => null)
}

/** 确认失败：acking → failed，actionApplied=true（重试只补确认，不重发动作）。 */
export function notificationAckFailed(board: NotificationBoard, cardId: string, error: string): NotificationBoard {
  return mapCard(board, cardId, (entry) => (entry.phase === 'acking' ? { ...entry, phase: 'failed', error, actionApplied: true } : entry))
}

/** 打开会话后收起（留在队列等待确认）。 */
export function notificationCollapsed(board: NotificationBoard, cardId: string): NotificationBoard {
  return mapCard(board, cardId, (entry) => (entry.collapsed ? entry : { ...entry, collapsed: true }))
}

/** 翻转收起/展开。 */
export function toggleNotificationCollapsed(board: NotificationBoard, cardId: string): NotificationBoard {
  return mapCard(board, cardId, (entry) => ({ ...entry, collapsed: !entry.collapsed }))
}

/** 收起 chip 的一行摘要：任务名（+截断摘要）。 */
export function notificationChipSummary(cardData: NotificationCard, maxSummaryLength = 24): string {
  const title = cardData.title
  const summary = cardData.summary.trim()
  if (summary === '') return title
  const clipped = summary.length >= maxSummaryLength ? `${summary.slice(0, Math.max(1, maxSummaryLength - 1))}…` : summary
  return `${title}：${clipped}`
}

/** 从轮询 state 汇出通知卡清单（缺失键 → 空表）。 */
export function notificationsFromState(state: RouterState): readonly NotificationCard[] {
  return state.notifications ?? []
}
