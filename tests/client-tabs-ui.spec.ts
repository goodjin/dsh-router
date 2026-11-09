// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DUPLICATE_TITLE_SELECTOR, WorkbenchTabs } from '../src/client/workbench-tabs.tsx'
import type { WorkbenchState, WorkbenchStore } from '../src/client/workbench-store.ts'
import { emptyBoard } from '../src/client/question-state.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('会话切换时仅 Router 及派发会话保留标签，普通会话和无会话完全不占位', async () => {
  let snapshot: WorkbenchState = {
    ready: true, lastError: null, board: emptyBoard(), closingSessionIds: [],
    currentSessionId: 'ordinary',
    routerState: {
      routerSessions: [{ sessionId: 'router', title: 'Router' }],
      tabs: [{ sessionId: 'worker', title: '执行任务', running: true }],
      tasks: [{ taskId: 'T-1', title: '已关标签的主管', goal: '', status: 'running',
        role: 'supervisor', templateId: 'sup', waitingQuestions: 0, docVersion: 1, sessionId: 'supervisor' }],
      questions: [], templates: [],
    },
  }
  const listeners = new Set<() => void>()
  const store = {
    get: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    closeWorkerTab: vi.fn(),
  } as unknown as WorkbenchStore
  const container = document.createElement('div')
  const header = document.createElement('header')
  const title = document.createElement('nav')
  title.className = 'hostHash_crumbs'
  title.textContent = '重复的会话标题'
  const actions = document.createElement('div')
  actions.className = 'hostHash_headerActions'
  header.append(container, title, actions)
  document.body.append(header)
  const otherHeader = document.createElement('header')
  otherHeader.innerHTML = '<nav class="hostHash_crumbs">普通会话标题</nav>'
  document.body.append(otherHeader)
  const root = createRoot(container)
  const openSession = vi.fn()
  const switchTo = async (currentSessionId: string | undefined) => {
    await act(async () => {
      snapshot = { ...snapshot, currentSessionId }
      listeners.forEach((listener) => listener())
    })
  }
  try {
    await act(async () => { root.render(createElement(WorkbenchTabs, { store, uiWorkspace: { openSession } })) })
    expect(container.innerHTML).toBe('')
    for (const id of ['router', 'worker', 'supervisor']) {
      await switchTo(id)
      expect(container.querySelectorAll('[data-router-tab]')).toHaveLength(2)
      expect(title.matches(DUPLICATE_TITLE_SELECTOR)).toBe(true)
      expect(actions.matches(DUPLICATE_TITLE_SELECTOR)).toBe(false)
      expect(otherHeader.querySelector('nav')!.matches(DUPLICATE_TITLE_SELECTOR)).toBe(false)
      expect(container.querySelector('style')?.textContent).toContain('display: none')
      const routerTab = container.querySelector<HTMLElement>('[data-router-tab="router"]')!
      expect(routerTab.style.borderWidth).toBe('1px')
      expect(routerTab.style.borderStyle).toBe('solid')
      expect(routerTab.style.background).not.toBe('transparent')
      if (id !== 'supervisor') {
        expect(container.querySelector('[aria-selected="true"]')?.getAttribute('data-session-id')).toBe(id)
      }
      await switchTo('ordinary')
      expect(container.innerHTML).toBe('')
      expect(title.matches(DUPLICATE_TITLE_SELECTOR)).toBe(false)
    }
    await switchTo('router')
    await switchTo(undefined)
    expect(container.innerHTML).toBe('')
    await switchTo('router')
    await act(async () => {
      snapshot = { ...snapshot, routerState: null }
      listeners.forEach((listener) => listener())
    })
    expect(container.innerHTML).toBe('')
    expect(openSession).not.toHaveBeenCalled()
  } finally {
    await act(async () => { root.unmount() })
    header.remove()
    otherHeader.remove()
  }
})
