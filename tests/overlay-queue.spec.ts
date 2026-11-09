// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { overlayBatch, overlayRouterSession, taskRouterSession, OVERLAY_STACK_STYLE, OVERLAY_CARD_SIZE } from '../src/client/overlay-queue.ts'
import { cardsReceived, emptyBoard, setAnswer, submitAccepted, submitStarted, syncedWithServer, toggleCollapsed } from '../src/client/question-state.ts'
import { emptyNotifications, notificationAckSucceeded, syncedNotifications, toggleNotificationCollapsed } from '../src/client/notification-model.ts'
import type { NotificationCard, QuestionCard, RouterState, TaskCard } from '../src/shared/view-contract.ts'

export function task(id: string, source = 'r1', parentId?: string): TaskCard {
  return { taskId: id, title: id, goal: '', status: 'running', role: 'worker', templateId: 'worker', waitingQuestions: 0, docVersion: 1, sessionId: `s-${id}`, dispatchedBySessionId: source, parentId }
}
export function notification(id: string, taskId = 't1'): NotificationCard {
  return { cardId: id, taskId, kind: 'completion', title: id, summary: '内容', actions: [{ action: 'ack', label: '知道了' }], at: 2, ack: false }
}
export function question(id: string): QuestionCard {
  return { questionId: id, taskId: 't1', sessionId: 's-t1', receivedAt: 1, questions: [{ id: 'answer', question: '问题' }] }
}
export function routerState(): RouterState {
  return { routerSessions: [{ sessionId: 'r1', title: 'Router' }, { sessionId: 'r2', title: 'Router2' }], tasks: [task('t1'), task('t2', 'r2'), task('child', 's-t1', 't1')], tabs: [], templates: [], questions: [] }
}

describe('浮窗排队与隔离', () => {
  it('13 条分五页加载，处理后补位，不删队列', () => {
    const items = Array.from({ length: 13 }, (_, i) => i)
    expect(overlayBatch(items, 0)).toMatchObject({ items: [0, 1, 2], remaining: 10, pages: 5 })
    expect(overlayBatch(items, 1).items).toEqual([3, 4, 5])
    expect(overlayBatch(items, 4).items).toEqual([12])
    expect(overlayBatch(items.slice(1), 0).items).toEqual([1, 2, 3])
    expect(overlayBatch([], 2).page).toBe(0)
    expect(items).toHaveLength(13)
  })
  it('父任务与来源会话都能追溯；普通会话与环不串入', () => {
    const state = routerState()
    expect(taskRouterSession(state, 'child')).toBe('r1')
    expect(overlayRouterSession(state, 'r1')).toBe('r1')
    expect(overlayRouterSession(state, 'r2')).toBe('r2')
    for (const id of ['s-t1', 's-t2', 's-child', undefined]) {
      expect(overlayRouterSession(state, id)).toBeUndefined()
    }
    expect(overlayRouterSession(null, 'r1')).toBeUndefined()
    expect(overlayRouterSession(state, 'ordinary')).toBeUndefined()
    state.tasks.push(task('cycle', 's-cycle', 'cycle'))
    expect(taskRouterSession(state, 'cycle')).toBeUndefined()
  })
  it('问题批内/跨批去重，轮询保留草稿与收起，已答问题重放不复活', () => {
    const q = question('q1')
    let board = cardsReceived(emptyBoard(), [q, q])
    expect(board.cards).toHaveLength(1)
    board = setAnswer(toggleCollapsed(board, 'q1'), 'q1', 'answer', { custom: '草稿' })
    board = syncedWithServer(board, [q, q])
    expect(board.cards[0]).toMatchObject({ collapsed: false, draft: { answer: { custom: '草稿' } } })
    board = submitAccepted(submitStarted(board, 'q1'), 'q1')
    expect(syncedWithServer(board, [q]).cards).toHaveLength(0)
  })
  it('通知稳定 ID 去重、ack:true/本地已确认重放过滤，收起状态不重置', () => {
    const n = notification('n1')
    let board = syncedNotifications(emptyNotifications(), [n, n, { ...notification('done'), ack: true }])
    expect(board.cards).toHaveLength(1)
    board = toggleNotificationCollapsed(board, 'n1')
    board = syncedNotifications(board, [n])
    expect(board.cards[0]?.collapsed).toBe(false)
    board = notificationAckSucceeded(board, 'n1')
    expect(syncedNotifications(board, [n]).cards).toHaveLength(0)
  })
  it('360/600/1080 高视口均留底边，320 宽视口不溢出（布局公式）', () => {
    expect(OVERLAY_STACK_STYLE.right).toBe(20)
    expect(OVERLAY_STACK_STYLE.maxHeight).toBe('calc(100dvh - min(88px, 15dvh) - 20px)')
    expect(OVERLAY_CARD_SIZE.maxHeight).toBe('min(680px, calc(100dvh - min(88px, 15dvh) - 100px))')
    for (const height of [360, 600, 1080]) {
      const top = Math.min(88, height * .15)
      const card = Math.min(680, height - top - 100)
      expect(top + card + 80).toBeLessThanOrEqual(height - 20)
      expect(card).toBeGreaterThan(0)
    }
    expect(20 + Math.min(360, 320 - 40)).toBeLessThanOrEqual(320 - 20)
  })
})

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'
import { NotificationOverlay } from '../src/client/notification-cards.tsx'
import { dispatchedSessionWindows, sessionWindowStatus, SESSION_WINDOW_ANIMATIONS } from '../src/client/session-windows.ts'
import type { WorkbenchState, WorkbenchStore } from '../src/client/workbench-store.ts'
import type { RouterApi } from '../src/client/api.ts'
import type { ClientPrefsStore } from '../src/client/client-prefs.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each([0, 1, 3, 4, 10])('%i 个会话分页且去重，无会话草稿不入卡', (count) => {
  const state = routerState()
  state.tasks = Array.from({ length: count }, (_, i) => task(`t${i}`))
  if (count) state.tasks.push(state.tasks[0]!)
  state.tasks.push({ ...task('no-session'), status: 'failed', sessionId: undefined }, task('other', 'r2'))
  const rows = dispatchedSessionWindows(state, 'r1')
  expect(rows).toHaveLength(count)
  const pages = Math.max(1, Math.ceil(count / 3))
  const all = Array.from({ length: pages }, (_, i) => overlayBatch(rows, i).items).flat()
  expect(all).toHaveLength(count)
  expect(overlayBatch(rows, 100).page).toBe(pages - 1)
})

it('真实状态及减少动态效果，不把已派发或终态伪装成运行', () => {
  const row = { sessionId: 's', title: '任务', tasks: [task('t')] }
  for (const status of ['queued', 'dispatched', 'completed', 'cancelled'] as const) {
    row.tasks = [{ ...task('t'), status, sessionRunning: true }]
    expect(sessionWindowStatus(row, false).kind).toBe('idle')
  }
  row.tasks = [{ ...task('t'), status: 'running', sessionRunning: true }]
  expect(sessionWindowStatus(row, false).kind).toBe('running')
  row.tasks = [{ ...task('t'), status: 'blocked' }]
  expect(sessionWindowStatus(row, false).kind).toBe('error')
  expect(sessionWindowStatus(row, true).kind).toBe('waiting')
  expect(SESSION_WINDOW_ANIMATIONS).toContain('@media (prefers-reduced-motion: reduce)')
  expect(SESSION_WINDOW_ANIMATIONS).toContain('animation: none !important')
})

it('会话卡三项分页、隐藏只改可见性、点击窗口即切换会话、底部操作不回归', async () => {
  const data = routerState()
  data.tasks = [task('t1'), task('t2'), task('t3'), task('t4'), task('foreign', 'r2'), task('child', 's-t1', 't1')]
  data.tasks[0]!.sessionRunning = true
  data.notifications = [{ ...notification('n1'), actions: [
    { action: 'open-session', label: '打开会话' }, { action: 'view-result', label: '查看结果' },
    { action: 'rework', label: '退回重做' }, { action: 'redispatch', label: '重派' },
    { action: 'cancel', label: '取消' }, { action: 'accept', label: '通过' },
    { action: 'reject', label: '驳回' }, { action: 'ack', label: '知道了' },
  ] }]
  let state: WorkbenchState = { ready: true, lastError: null, currentSessionId: 'r1', closingSessionIds: [], routerState: data, board: emptyBoard() }
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((listener) => listener())
  const store = { get: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } as unknown as WorkbenchStore
  const prefsValue = { overlayEnabled: true, maxActiveCards: 12, pollMs: 2500 }
  const prefs = { get: () => prefsValue, subscribe: () => () => {}, set: () => {} } as ClientPrefsStore
  const ack = vi.fn(async () => {})
  const control = vi.fn(async () => {})
  const api = { ackNotification: ack, controlTask: control } as unknown as RouterApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const openMain = vi.fn()
  const click = async (selector: string) => {
    const button = container.querySelector<HTMLElement>(selector)
    expect(button, selector).not.toBeNull()
    await act(async () => { button!.click() })
  }
  const switchTo = async (id: string) => { await act(async () => { state = { ...state, currentSessionId: id }; emit() }) }
  const count = () => container.querySelectorAll('[data-router-session-window]').length
  try {
    await act(async () => { root.render(createElement(NotificationOverlay, { store, api, prefs, uiWorkspace: { openSession: openMain } })) })
    expect(count()).toBe(3)
    // 直属 worker、下游 worker、其他 Router 的 worker 均不显示整组窗口。
    for (const id of ['s-t1', 's-child', 's-foreign', 'ordinary']) {
      await switchTo(id)
      expect(container.innerHTML).toBe('')
      // 后续轮询刷新不得把窗口重新带回 worker 视图。
      await act(async () => { state = { ...state, routerState: { ...data } }; emit() })
      expect(container.innerHTML).toBe('')
    }
    await switchTo('r1')
    expect(count()).toBe(3)
    expect(container.querySelector('[data-overlay-pagination]')?.textContent).toContain('1/2 页 · 共 5')
    expect(container.querySelector('[data-router-session-window="s-foreign"]')).toBeNull()
    const actionButtons = [...container.querySelectorAll('[data-notification-action]')]
    expect(actionButtons.map((el) => el.textContent)).toEqual(['打开会话', '查看结果', '退回重做', '重派', '取消', '通过', '驳回', '隐藏'])
    expect((actionButtons[1] as HTMLButtonElement).disabled).toBe(true)
    // 点击窗口 = 直接切换到该会话（内嵌详情浮层已移除，2026-11-09 用户裁定）
    await click('[data-open-session="s-t1"]')
    expect(openMain).toHaveBeenCalledWith('s-t1')
    expect(container.querySelector('[data-router-session-detail]')).toBeNull()
    await click('[data-open-session="s-t2"]')
    expect(openMain).toHaveBeenCalledWith('s-t2')
    // 卡片动作「打开会话」同样走切换，不再开内嵌详情
    await click('[data-notification-action="n1:open-session"]')
    expect(openMain).toHaveBeenLastCalledWith('s-t1')
    await click('[data-overlay-pagination] button:last-child')
    expect(count()).toBe(2)
    await click('[data-overlay-pagination] button:first-of-type')
    await click('[data-notification-action="n1:ack"]')
    expect(ack).not.toHaveBeenCalled()
    expect(control).not.toHaveBeenCalled()
    expect(count()).toBe(3)
    await act(async () => { state = { ...state, routerState: { ...data } }; emit() })
    expect(container.querySelector('[data-router-session-window="s-t1"]')).toBeNull()
    await click('[data-hidden-toggle]')
    await click('[data-restore-session="s-t1"]')
    expect(container.querySelector('[data-router-session-window="s-t1"]')).not.toBeNull()
    await click('[data-notification-action="n1:rework"]')
    expect(control).toHaveBeenCalledWith('t1', 'rework')
    expect(ack).toHaveBeenCalledWith('n1')
    await act(async () => { data.tasks[0]!.status = 'blocked'; state = { ...state, routerState: { ...data } }; emit() })
    expect(container.querySelector('[data-router-session-window="s-t1"] [data-router-session-status]')?.getAttribute('data-router-session-status')).toBe('error')
    await click('[data-overlay-pagination] button:last-child')
    await click('[data-hide-session="s-t4"]')
    expect(count()).toBe(1)
    await click('[data-hide-session="s-child"]')
    expect(count()).toBe(3)
    expect(container.querySelector('[data-overlay-pagination]')?.textContent).toContain('1/1 页')
    await click('[data-hidden-toggle]')
    expect(container.querySelectorAll('[data-hidden-session]')).toHaveLength(2)
    await click('[data-restore-session="s-child"]')
    expect(container.querySelector('[data-overlay-pagination]')?.textContent).toContain('共 4 个会话')
    await switchTo('r2')
    expect(count()).toBe(1)
    await switchTo('ordinary')
    expect(container.innerHTML).toBe('')
    // 三次点击（两次窗口 + 一次卡片动作）全部走 openSession 切换
    expect(openMain).toHaveBeenCalledTimes(3)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
  expect(listeners.size).toBe(0)
})
