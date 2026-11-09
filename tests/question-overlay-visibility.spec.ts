// @vitest-environment jsdom
/**
 * 问题浮窗全局悬浮回归（需求 §14.1，先红后绿）。
 *
 * 现场缺陷：浮窗被 isRouterSessionView 门控为仅 Router 会话视图渲染，而
 * chip 点击会切到 worker 标签——切过去后浮窗整块消失，用户在 worker 上下文
 * 里反而答不了问题。需求明确「小窗为全局浮层，切换后仍悬浮」。
 * 这里用真 React（createRoot + act）驱动「Router 视图 → 点 chip → 切 worker
 * 视图」断言浮窗始终在 DOM 里。
 */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { QuestionCards } from '../src/client/question-cards.tsx'
import type { ClientPrefsStore } from '../src/client/client-prefs.ts'
import type { WorkbenchState, WorkbenchStore } from '../src/client/workbench-store.ts'
import type { QuestionCardView } from '../src/client/question-state.ts'
import type { RouterState } from '../src/shared/view-contract.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const routerState = {
  routerSessions: [{ sessionId: 'r-1', title: 'R' }],
  tasks: [],
  questions: [],
  tabs: [],
  templates: [],
} as unknown as RouterState

function cardView(): QuestionCardView {
  return {
    card: {
      questionId: 'q-1',
      taskId: 'T-1',
      taskTitle: '任务',
      sessionId: 'w-9',
      questions: [{ id: 'i-1', question: '选哪个？', options: [{ label: '甲' }] }],
      receivedAt: 1,
    },
    phase: 'received',
    collapsed: true,
    draft: {},
  }
}

/** 可驱动的最小 store：setCurrentSession 模拟宿主切会话，toggleCollapsed 真翻转。 */
function fakeStore(initialSession: string | undefined) {
  let state = {
    ready: true,
    routerState,
    lastError: null,
    currentSessionId: initialSession,
    board: { cards: [cardView()] },
  } as unknown as WorkbenchState
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  const store = {
    get: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setCurrentSession: (sessionId: string | undefined) => {
      state = { ...state, currentSessionId: sessionId }
      notify()
    },
    toggleCollapsed: (questionId: string) => {
      const board = state.board as { cards: QuestionCardView[] }
      state = {
        ...state,
        board: { cards: board.cards.map((entry) => entry.card.questionId === questionId ? { ...entry, collapsed: !entry.collapsed } : entry) },
      } as unknown as WorkbenchState
      notify()
    },
    submitAnswer: async () => undefined,
  } as unknown as WorkbenchStore
  return store
}

function fakePrefs(overlayEnabled: boolean): ClientPrefsStore {
  const snapshot = { pollMs: 2500, overlayEnabled, maxActiveCards: 12 }
  return {
    get: () => snapshot,
    subscribe: () => () => undefined,
  } as unknown as ClientPrefsStore
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function mount(store: WorkbenchStore, prefs: ClientPrefsStore, opened: string[]): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(createElement(QuestionCards, { store, prefs, uiWorkspace: { openSession: (target: string) => { opened.push(target) } } }))
  })
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

describe('问题浮窗是全局浮层（需求 §14.1）', () => {
  it('当前停在 worker 会话视图：浮窗仍渲染（不被 Router-only 门控吞掉）', () => {
    mount(fakeStore('w-9'), fakePrefs(true), [])
    expect(container?.querySelector('[data-router-question-overlay]')).not.toBeNull()
    expect(container?.querySelector('[data-router-question-chip="q-1"]')).not.toBeNull()
  })

  it('Router 视图点 chip → 切到 worker 视图后浮窗仍悬浮且卡片已展开', () => {
    const store = fakeStore('r-1')
    const opened: string[] = []
    mount(store, fakePrefs(true), opened)
    const chip = container?.querySelector('[data-router-question-chip="q-1"]') as HTMLElement
    act(() => { chip.click() })
    expect(opened).toEqual(['w-9'])
    act(() => { store.setCurrentSession('w-9') })
    expect(container?.querySelector('[data-router-question-overlay]')).not.toBeNull()
    expect(container?.querySelector('[data-router-question-chip="q-1"]')).toBeNull() // 已展开
  })

  it('偏好关闭浮窗 → 不渲染；重新打开 → 恢复渲染', () => {
    const store = fakeStore('r-1')
    mount(store, fakePrefs(false), [])
    expect(container?.querySelector('[data-router-question-overlay]')).toBeNull()
    act(() => { root?.render(createElement(QuestionCards, { store, prefs: fakePrefs(true), uiWorkspace: { openSession: () => undefined } })) })
    expect(container?.querySelector('[data-router-question-overlay]')).not.toBeNull()
  })
})