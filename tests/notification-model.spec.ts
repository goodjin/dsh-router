/**
 * 统一通知卡纯逻辑（v1.2 Task C1 Step 1：动作映射 + 卡片队列 reducer）。
 *
 * 规则（计划 Task C1 接口 + 规格 §5）：
 * - 动作集 open-session|view-result|rework|cancel|redispatch|unfreeze|ack，
 *   映射成对宿主控制路由的请求或本地导航；view-result 无宿主路由（置灰，
 *   如实注释）；rework 与重派共用控制路由的 redispatch 动作（宿主侧 =
 *   supplement「用户重派」+ 回 running + 重派，即 rework 语义）。
 * - 卡片队列多卡排队（新在前），动作提交 submitting → 成功补 ack 后消失、
 *   失败保留可重试；动作已生效但确认失败的卡只补确认、不再重发动作。
 * 全部断言打在纯函数上，不启 React、不启宿主、不发网络。
 */

import { describe, expect, it } from 'vitest'
import {
  actionAvailable,
  cardActionPlan,
  cardSessionTarget,
  emptyNotifications,
  notificationAckFailed,
  notificationAckStarted,
  notificationAckSucceeded,
  notificationActionFailed,
  notificationActionStarted,
  notificationActionSucceeded,
  notificationCollapsed,
  notificationChipSummary,
  syncedNotifications,
  toggleNotificationCollapsed,
} from '../src/client/notification-model.ts'
import type {
  NotificationCard,
  RouterState,
  TaskCard,
  WorkerTabInfo,
} from '../src/shared/view-contract.ts'

function card(cardId: string, overrides: Partial<NotificationCard> = {}): NotificationCard {
  return {
    cardId,
    kind: 'completion',
    taskId: 'T-001',
    title: '写发布文档',
    summary: '发布说明已写完并通过验收',
    actions: [
      { action: 'open-session', label: '打开会话' },
      { action: 'view-result', label: '查看结果' },
      { action: 'rework', label: '退回重做' },
      { action: 'ack', label: '知道了' },
    ],
    deliveryOrigin: 'worker',
    at: 1_000,
    ack: false,
    ...overrides,
  }
}

function taskCard(taskId: string, sessionId: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    taskId,
    title: '写发布文档',
    goal: '写完发布说明',
    status: 'completed',
    role: 'worker',
    templateId: 'docs',
    waitingQuestions: 0,
    docVersion: 1,
    sessionId,
    ...overrides,
  }
}

function workerTab(sessionId: string, taskId: string, overrides: Partial<WorkerTabInfo> = {}): WorkerTabInfo {
  return { sessionId, title: sessionId, taskId, running: false, ...overrides }
}

function routerState(overrides: Partial<RouterState> = {}): RouterState {
  return {
    routerSessions: [{ sessionId: 'router-1', title: 'Router' }],
    tasks: [taskCard('T-001', 'w-1')],
    questions: [],
    tabs: [workerTab('w-1', 'T-001')],
    templates: [],
    ...overrides,
  }
}

/* ────────────────────────── 动作 → 宿主请求映射 ────────────────────────── */

describe('cardActionPlan：动作 → 请求/本地行为映射', () => {
  it('rework → 控制路由 redispatch（宿主 supplement「用户重派」+ 回 running + 重派 = rework 语义）', () => {
    const plan = cardActionPlan(card('K-1'), 'rework')
    expect(plan).toEqual({ type: 'request', request: { channel: 'control', taskId: 'T-001', action: 'redispatch' } })
  })

  it('redispatch → 同一条控制路由 redispatch（异常卡的「重派」与 rework 共用宿主动作）', () => {
    const plan = cardActionPlan(card('K-1', { kind: 'anomaly' }), 'redispatch')
    expect(plan).toEqual({ type: 'request', request: { channel: 'control', taskId: 'T-001', action: 'redispatch' } })
  })

  it('cancel → 控制路由 cancel', () => {
    const plan = cardActionPlan(card('K-1'), 'cancel')
    expect(plan).toEqual({ type: 'request', request: { channel: 'control', taskId: 'T-001', action: 'cancel' } })
  })

  it('unfreeze → 熔断解除通道（无 taskId 也可用）', () => {
    const plan = cardActionPlan(card('K-1', { taskId: undefined }), 'unfreeze')
    expect(plan).toEqual({ type: 'request', request: { channel: 'unfreeze' } })
  })

  it('ack → 通知确认通道（带 cardId）', () => {
    const plan = cardActionPlan(card('K-1'), 'ack')
    expect(plan).toEqual({ type: 'request', request: { channel: 'ack', cardId: 'K-1' } })
  })

  it('open-session 带会话 → 本地导航（不发请求）', () => {
    const plan = cardActionPlan(card('K-1'), 'open-session', 'w-1')
    expect(plan).toEqual({ type: 'open-session', sessionId: 'w-1' })
  })

  it('open-session 无会话 → disabled（无处可跳）', () => {
    const plan = cardActionPlan(card('K-1'), 'open-session', undefined)
    expect(plan).toEqual({ type: 'disabled', reason: expect.any(String) })
  })

  it('view-result → disabled（宿主无结果文档查看路由，如实降级——注释同款语义）', () => {
    const plan = cardActionPlan(card('K-1'), 'view-result', 'w-1')
    expect(plan).toMatchObject({ type: 'disabled' })
    expect((plan as { type: 'disabled'; reason: string }).reason.length).toBeGreaterThan(0)
  })

  it('rework/cancel/redispatch 缺 taskId → disabled（无从控制）', () => {
    const bare = card('K-1', { taskId: undefined })
    expect(cardActionPlan(bare, 'rework')).toMatchObject({ type: 'disabled' })
    expect(cardActionPlan(bare, 'cancel')).toMatchObject({ type: 'disabled' })
    expect(cardActionPlan(bare, 'redispatch')).toMatchObject({ type: 'disabled' })
  })
})

describe('cardSessionTarget：卡的任务 → 会话解析', () => {
  it('优先取 tasks 里该任务的绑定会话', () => {
    expect(cardSessionTarget('T-001', routerState().tasks, routerState().tabs)).toBe('w-1')
  })

  it('tasks 没有（卡投影早于任务列表）→ tabs 兜底', () => {
    expect(cardSessionTarget('T-001', [], [workerTab('w-9', 'T-001')])).toBe('w-9')
  })

  it('两处都没有 → undefined（open-session 置灰）', () => {
    expect(cardSessionTarget('T-404', routerState().tasks, routerState().tabs)).toBeUndefined()
    expect(cardSessionTarget(undefined, routerState().tasks, routerState().tabs)).toBeUndefined()
  })
})

describe('actionAvailable：按钮可用性（置灰逻辑）', () => {
  it('动作已生效（actionApplied）时只留 ack 可用，其余禁用——防止重复退回重做', () => {
    const c = card('K-1')
    expect(actionAvailable(c, 'ack', undefined, true).available).toBe(true)
    expect(actionAvailable(c, 'rework', 'w-1', true).available).toBe(false)
    expect(actionAvailable(c, 'open-session', 'w-1', true).available).toBe(false)
  })

  it('未生效时按常规可用性判定（view-result 恒禁用、open-session 看会话）', () => {
    const c = card('K-1')
    expect(actionAvailable(c, 'view-result', 'w-1', false).available).toBe(false)
    expect(actionAvailable(c, 'open-session', 'w-1', false).available).toBe(true)
    expect(actionAvailable(c, 'open-session', undefined, false).available).toBe(false)
    expect(actionAvailable(c, 'rework', undefined, false).available).toBe(false)
    expect(actionAvailable(c, 'rework', undefined, false).reason).toBeTruthy()
  })
})

/* ────────────────────────── 卡片队列 reducer ────────────────────────── */

describe('syncedNotifications：轮询合流（多卡排队，新在前）', () => {
  it('空板 → 新卡按服务端序入队，phase=idle、默认收起', () => {
    const next = syncedNotifications(emptyNotifications(), [card('K-1'), card('K-2')])
    expect(next.cards.map((entry) => entry.card.cardId)).toEqual(['K-1', 'K-2'])
    expect(next.cards.every((entry) => entry.phase === 'idle' && entry.collapsed)).toBe(true)
  })

  it('已存卡保留 UI 状态（phase/collapsed），重放不重置', () => {
    let board = syncedNotifications(emptyNotifications(), [card('K-1')])
    board = toggleNotificationCollapsed(board, 'K-1')
    board = notificationActionStarted(board, 'K-1')
    board = syncedNotifications(board, [card('K-1')])
    expect(board.cards).toHaveLength(1)
    expect(board.cards[0]?.phase).toBe('submitting')
    expect(board.cards[0]?.collapsed).toBe(false) // 展开态在重放后保持，不被打回收起
  })

  it('服务端已不在的卡移除，submitting/acking 中的保留（在途动作结局未定）', () => {
    let board = syncedNotifications(emptyNotifications(), [card('K-1'), card('K-2')])
    board = notificationActionStarted(board, 'K-1')
    board = notificationActionSucceeded(board, 'K-1') // K-1 进入 acking
    board = syncedNotifications(board, [card('K-2')])
    expect(board.cards.map((entry) => entry.card.cardId)).toEqual(['K-1', 'K-2'])
    expect(board.cards[0]?.phase).toBe('acking')
  })
})

describe('提交窗口：action submitting → acking → 移除 | failed 保留', () => {
  it('idle → submitting → acking → ack 成功移除（提交成功即消失）', () => {
    let board = syncedNotifications(emptyNotifications(), [card('K-1')])
    board = notificationActionStarted(board, 'K-1')
    expect(board.cards[0]?.phase).toBe('submitting')
    board = notificationActionSucceeded(board, 'K-1')
    expect(board.cards[0]?.phase).toBe('acking')
    board = notificationAckStarted(board, 'K-1')
    board = notificationAckSucceeded(board, 'K-1')
    expect(board.cards).toHaveLength(0)
  })

  it('动作失败：submitting → failed + 错误文案，卡片保留可重试', () => {
    let board = syncedNotifications(emptyNotifications(), [card('K-1')])
    board = notificationActionStarted(board, 'K-1')
    board = notificationActionFailed(board, 'K-1', '派发已冻结：请先解除冻结')
    expect(board.cards[0]?.phase).toBe('failed')
    expect(board.cards[0]?.error).toBe('派发已冻结：请先解除冻结')
    expect(board.cards[0]?.actionApplied).toBeUndefined()
    // 重试：failed → submitting 再走一遍
    board = notificationActionStarted(board, 'K-1')
    expect(board.cards[0]?.phase).toBe('submitting')
  })

  it('动作成功但确认失败：failed + actionApplied——重试只补确认，不重发动作', () => {
    let board = syncedNotifications(emptyNotifications(), [card('K-1')])
    board = notificationActionStarted(board, 'K-1')
    board = notificationActionSucceeded(board, 'K-1')
    board = notificationAckFailed(board, 'K-1', '网络超时')
    expect(board.cards[0]?.phase).toBe('failed')
    expect(board.cards[0]?.error).toBe('网络超时')
    expect(board.cards[0]?.actionApplied).toBe(true)
    expect(actionAvailable(board.cards[0]!.card, 'rework', 'w-1', true).available).toBe(false)
    expect(actionAvailable(board.cards[0]!.card, 'ack', undefined, true).available).toBe(true)
  })

  it('ack-only 卡动作（ack 失败重试）走 ackStarted：failed → acking', () => {
    let board = syncedNotifications(emptyNotifications(), [card('K-1')])
    board = notificationActionStarted(board, 'K-1')
    board = notificationActionSucceeded(board, 'K-1')
    board = notificationAckFailed(board, 'K-1', '网络超时')
    board = notificationAckStarted(board, 'K-1')
    expect(board.cards[0]?.phase).toBe('acking')
    board = notificationAckSucceeded(board, 'K-1')
    expect(board.cards).toHaveLength(0)
  })

  it('acking 中重复触发动作是无操作（不发第二个请求）', () => {
    let board = syncedNotifications(emptyNotifications(), [card('K-1')])
    board = notificationActionStarted(board, 'K-1')
    board = notificationActionSucceeded(board, 'K-1')
    expect(notificationActionStarted(board, 'K-1')).toBe(board) // 引用不变 = 无操作
  })

  it('未知 cardId 全部无操作（返回同一状态引用）', () => {
    const board = syncedNotifications(emptyNotifications(), [card('K-1')])
    expect(toggleNotificationCollapsed(board, 'K-404')).toBe(board)
    expect(notificationActionStarted(board, 'K-404')).toBe(board)
    expect(notificationAckSucceeded(board, 'K-404')).toBe(board)
  })
})

describe('notificationCollapsed：打开会话后收起（留在队列等待确认）', () => {
  it('只翻 collapsed，phase 不动', () => {
    let board = syncedNotifications(emptyNotifications(), [card('K-1')])
    board = notificationCollapsed(board, 'K-1')
    expect(board.cards[0]?.collapsed).toBe(true)
    expect(board.cards[0]?.phase).toBe('idle')
    expect(toggleNotificationCollapsed(board, 'K-1').cards[0]?.collapsed).toBe(false)
  })
})

describe('notificationChipSummary：收起 chip 一行摘要', () => {
  it('任务名 + 摘要拼一行，超长截断', () => {
    const text = notificationChipSummary(card('K-1'), 12)
    expect(text).toContain('写发布文档')
    expect(text).toContain('…')
    expect(text.length).toBeLessThanOrEqual('写发布文档'.length + 12 + 1)
  })

  it('摘要为空时只给任务名', () => {
    expect(notificationChipSummary(card('K-1', { summary: '' }))).toBe('写发布文档')
  })
})
