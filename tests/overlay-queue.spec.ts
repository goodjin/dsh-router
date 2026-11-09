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
  it('13 条分三批加载，处理后补位，不删队列', () => {
    const items = Array.from({ length: 13 }, (_, i) => i)
    expect(overlayBatch(items, 0)).toMatchObject({ items: [0, 1, 2, 3, 4], remaining: 8, pages: 3 })
    expect(overlayBatch(items, 1).items).toEqual([5, 6, 7, 8, 9])
    expect(overlayBatch(items, 2).items).toEqual([10, 11, 12])
    expect(overlayBatch(items.slice(1), 0).items).toEqual([1, 2, 3, 4, 5])
    expect(overlayBatch([], 2).page).toBe(0)
    expect(items).toHaveLength(13)
  })
  it('父任务与来源会话都能追溯；普通会话与环不串入', () => {
    const state = routerState()
    expect(taskRouterSession(state, 'child')).toBe('r1')
    expect(overlayRouterSession(state, 's-t2')).toBe('r2')
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
import { NotificationOverlay } from '../src/client/notification-cards.tsx'
import type { WorkbenchState, WorkbenchStore } from '../src/client/workbench-store.ts'
import type { RouterApi } from '../src/client/api.ts'
import type { ClientPrefsStore } from '../src/client/client-prefs.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('真实组件：两类合计五项、切批/补位、收起与草稿保留、跨 Router 隔离及卸载清理', async () => {
  const data = routerState()
  const q = question('q1')
  data.questions = [q]
  data.notifications = [...Array.from({ length: 8 }, (_, i) => notification(`n${i}`)), notification('other', 't2')]
  let state: WorkbenchState = { ready: true, lastError: null, currentSessionId: 'r1', closingSessionIds: [], routerState: data, board: cardsReceived(emptyBoard(), [q]) }
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((listener) => listener())
  const store = {
    get: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    toggleCollapsed: (id: string) => { state = { ...state, board: toggleCollapsed(state.board, id) }; emit() },
    setAnswer: (id: string, item: string, patch: { custom: string }) => { state = { ...state, board: setAnswer(state.board, id, item, patch) }; emit() },
  } as unknown as WorkbenchStore
  const prefsValue = { overlayEnabled: true, maxActiveCards: 12, pollMs: 2500 }
  const prefs = { get: () => prefsValue, subscribe: () => () => {}, set: () => {} } as ClientPrefsStore
  const api = { ackNotification: async () => {} } as unknown as RouterApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const click = async (selector: string) => {
    const button = container.querySelector<HTMLElement>(selector)
    expect(button, selector).not.toBeNull()
    await act(async () => { button!.click() })
  }
  const switchTo = async (id: string) => { await act(async () => { state = { ...state, currentSessionId: id }; emit() }) }
  const count = () => container.querySelectorAll('[data-router-question-chip], [data-router-question-card], [data-notification-card]').length
  try {
    await act(async () => { root.render(createElement(NotificationOverlay, { store, api, prefs, uiWorkspace: { openSession: () => {} } })) })
    expect(count()).toBe(5)
    expect(container.querySelector('[data-notification-card="n4"]')).toBeNull()
    expect(container.querySelector('[data-notification-card="other"]')).toBeNull()
    expect(container.querySelector('[data-overlay-pagination]')?.textContent).toContain('另有 4 项')
    await click('[data-router-question-chip]')
    await act(async () => { store.setAnswer('q1', 'answer', { custom: '保留的回答' }) })
    await click('[data-router-question-collapse]')
    await act(async () => { state = { ...state, routerState: { ...data }, board: syncedWithServer(state.board, [q, q]) }; emit() })
    expect(container.querySelector('[data-router-question-chip]')).not.toBeNull()
    await click('[data-router-question-chip]')
    expect(container.querySelector<HTMLInputElement>('[data-question-custom]')?.value).toBe('保留的回答')
    await click('[data-overlay-toggle]')
    expect(count()).toBe(0)
    await act(async () => { state = { ...state, routerState: { ...data } }; emit() })
    expect(count()).toBe(0)
    await click('[data-overlay-toggle]')
    expect(container.querySelector<HTMLInputElement>('[data-question-custom]')?.value).toBe('保留的回答')
    await click('[data-notification-chip="n0"]')
    await click('[data-notification-collapse]')
    expect(container.querySelector('[data-notification-chip="n0"]')).not.toBeNull()
    await click('[data-notification-chip="n0"]')
    await click('[data-notification-action="n0:ack"]')
    expect(count()).toBe(5)
    expect(container.querySelector('[data-notification-card="n4"]')).not.toBeNull()
    await act(async () => { state = { ...state, routerState: { ...data } }; emit() })
    expect(container.querySelector('[data-notification-card="n0"]')).toBeNull()
    await click('[data-overlay-pagination] button:last-child')
    expect(count()).toBe(3)
    expect(container.querySelector('[data-notification-card="n7"]')).not.toBeNull()
    await switchTo('r2')
    expect(count()).toBe(1)
    expect(container.querySelector('[data-notification-card="other"]')).not.toBeNull()
    await switchTo('ordinary')
    expect(container.innerHTML).toBe('')
    await switchTo('s-t1')
    expect(count()).toBe(3)
    await click('[data-overlay-pagination] button:first-of-type')
    expect(container.querySelector<HTMLInputElement>('[data-question-custom]')?.value).toBe('保留的回答')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
  expect(listeners.size).toBe(0)
})
