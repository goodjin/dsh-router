// @vitest-environment jsdom
/**
 * 浮窗延后挂载 + 只加载运行中的会话（v1.5）。
 *
 * 现场问题：打开 Router 会话那一刻，浮窗为每个派发会话把**整条**会话事件流
 * 留驻浏览器（一次约 2MB），整个界面顿一下。v1.5 的口径：
 * 1) 先开界面，再加载浮窗——浮窗等浏览器空闲才挂载；
 * 2) 只有正在跑的会话才去宿主取尾部文字，已结束的用账本摘要（零请求）。
 */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotificationOverlay } from '../src/client/notification-cards.tsx'
import type { RouterApi } from '../src/client/api.ts'
import type { ClientPrefsStore } from '../src/client/client-prefs.ts'
import type { WorkbenchState, WorkbenchStore } from '../src/client/workbench-store.ts'
import type { RouterState } from '../src/shared/view-contract.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const routerState: RouterState = {
  routerSessions: [{ sessionId: 'r-1', title: 'Router' }],
  tasks: [
    {
      taskId: 'T-1', title: '跑着的任务', goal: 'g', status: 'running', role: 'worker',
      templateId: 'coder', waitingQuestions: 0, docVersion: 1, sessionId: 'w-live',
      sessionRunning: true, dispatchedBySessionId: 'r-1',
    },
    {
      taskId: 'T-2', title: '做完的任务', goal: 'g', status: 'completed', role: 'worker',
      templateId: 'coder', waitingQuestions: 0, docVersion: 1, sessionId: 'w-done',
      sessionRunning: false, dispatchedBySessionId: 'r-1', summary: '已完成：写完文档',
    },
  ],
  questions: [],
  tabs: [],
  templates: [],
} as unknown as RouterState

function fakeStore(): WorkbenchStore {
  const state = {
    ready: true,
    routerState,
    lastError: null,
    actionError: null,
    currentSessionId: 'r-1',
    board: { cards: [] },
  } as unknown as WorkbenchState
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setCurrentSession: () => undefined,
    toggleCollapsed: () => undefined,
    submitAnswer: async () => undefined,
    clearActionError: () => undefined,
  } as unknown as WorkbenchStore
}

function fakePrefs(): ClientPrefsStore {
  return {
    get: () => ({ pollMs: 2500, overlayEnabled: true, maxActiveCards: 12 }),
    subscribe: () => () => undefined,
  } as unknown as ClientPrefsStore
}

function fakeApi(): { api: RouterApi; calls: string[] } {
  const calls: string[] = []
  const api = {
    getSessionOutput: (sessionId: string) => {
      calls.push(sessionId)
      return Promise.resolve({ text: `尾部:${sessionId}`, source: 'live' as const })
    },
  } as unknown as RouterApi
  return { api, calls }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount())
  root = undefined
  container?.remove()
  container = undefined
  vi.unstubAllGlobals()
})

describe('浮窗延后挂载与按需加载', () => {
  it('挂载前不渲染浮窗；空闲回调后才出现', async () => {
    let idle: (() => void) | undefined
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle = callback; return 1 })
    const { api } = fakeApi()
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root!.render(
      <NotificationOverlay store={fakeStore()} api={api} prefs={fakePrefs()} uiWorkspace={{ openSession: () => undefined }} />,
    ))
    // 界面先出来：浮窗还没挂。
    expect(container!.querySelectorAll('[data-router-session-window]')).toHaveLength(0)
    await act(async () => { idle?.() })
    expect(container!.querySelectorAll('[data-router-session-window]').length).toBeGreaterThan(0)
  })

  it('只有运行中的会话去取尾部；已结束的显示账本摘要、零请求', async () => {
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => { callback(); return 1 })
    const { api, calls } = fakeApi()
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root!.render(
      <NotificationOverlay store={fakeStore()} api={api} prefs={fakePrefs()} uiWorkspace={{ openSession: () => undefined }} />,
    ))
    await act(async () => { await Promise.resolve() })
    expect(calls).toEqual(['w-live'])
    const outputs = [...container!.querySelectorAll('[data-session-output]')].map((node) => node.textContent ?? '')
    expect(outputs.some((text) => text.includes('已完成：写完文档'))).toBe(true)
    expect(outputs.some((text) => text.includes('尾部:w-live'))).toBe(true)
  })

  it('没有 requestIdleCallback 时退回定时器：浮窗仍然会出现', async () => {
    vi.stubGlobal('requestIdleCallback', undefined)
    const { api } = fakeApi()
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root!.render(
      <NotificationOverlay store={fakeStore()} api={api} prefs={fakePrefs()} uiWorkspace={{ openSession: () => undefined }} />,
    ))
    expect(container!.querySelectorAll('[data-router-session-window]')).toHaveLength(0)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    expect(container!.querySelectorAll('[data-router-session-window]').length).toBeGreaterThan(0)
  })
})
