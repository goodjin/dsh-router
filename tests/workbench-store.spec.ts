/**
 * 工作台共享 store（计划 Task B7：轮询 2.5s、仅当本 workspace 有 router 会话、
 * 页面隐藏暂停；worker 标签本地移除；问题卡与轮询状态合流）。
 *
 * store 是纯逻辑（定时器可注入），组件只是它的订阅者。测试用假 api 与假
 * workspaces 快照经公开 API（pollOnce）驱动，不启网络、不启 React。
 */

import { describe, expect, it } from 'vitest'
import { startWorkbenchPolling, startWorkbenchStore, buildAnswers, currentWorkspaceIdOf } from '../src/client/workbench-store.ts'
import type { RouterApi } from '../src/client/api.ts'
import type { ClientPrefs, ClientPrefsStore } from '../src/client/client-prefs.ts'
import type { AskUserQuestionAnswerItem, QuestionCard, RouterState, WorkerTabInfo } from '../src/shared/view-contract.ts'

function prefsStore(overrides: Partial<ClientPrefs> = {}): ClientPrefsStore {
  let current: ClientPrefs = { pollMs: 2500, overlayEnabled: true, maxActiveCards: 12, ...overrides }
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next) => { current = next; for (const listener of [...listeners]) listener() },
  }
}

/** 假 api：记录调用，state 序列按次序返回（走完后停在最后一个）。 */
function fakeApi(states: RouterState[], overrides: Partial<RouterApi> = {}): RouterApi & {
  stateCalls: (string | undefined)[]
  closeCalls: [string, string][]
  answerCalls: [string, unknown][]
} {
  const impl = {
    stateCalls: [] as (string | undefined)[],
    closeCalls: [] as [string, string][],
    answerCalls: [] as [string, unknown][],
    getState: async (workspaceId?: string) => {
      impl.stateCalls.push(workspaceId)
      if (overrides.getState) return overrides.getState(workspaceId)
      if (states.length === 0) return emptyState()
      const last = Math.min(impl.stateCalls.length - 1, states.length - 1)
      return states[last]!
    },
    createRouterSession: overrides.createRouterSession ?? (async () => ({ sessionId: 'router-x' })),
    postAnswer: async (questionId: string, answers: AskUserQuestionAnswerItem[]) => {
      impl.answerCalls.push([questionId, answers])
      if (overrides.postAnswer) return overrides.postAnswer(questionId, answers)
    },
    closeWorkerTab: async (workspaceId: string, sessionId: string) => {
      impl.closeCalls.push([workspaceId, sessionId])
      if (overrides.closeWorkerTab) return overrides.closeWorkerTab(workspaceId, sessionId)
    },
  }
  return impl as RouterApi & typeof impl
}

function emptyState(overrides: Partial<RouterState> = {}): RouterState {
  return { routerSessions: [], tasks: [], questions: [], tabs: [], templates: [], ...overrides }
}

function workspaces(items: Array<{ workspaceId: string; sessionIds: string[] }>): { getSnapshot(): { items: typeof items } } {
  return { getSnapshot: () => ({ items }) }
}

function card(questionId: string): QuestionCard {
  return {
    questionId,
    taskId: 'T-001',
    taskTitle: '写发布文档',
    sessionId: 'w-1',
    sessionTitle: 'worker 一',
    questions: [{ id: 'q1', question: '用哪种许可证？', options: [{ label: 'A' }, { label: 'B' }] }],
    receivedAt: 1_000,
  }
}

describe('currentWorkspaceIdOf：当前会话 → 工作区', () => {
  it('会话属于哪个 workspace 就解析哪个', () => {
    const items = [
      { workspaceId: 'ws-1', sessionIds: ['s1', 's2'] },
      { workspaceId: 'ws-2', sessionIds: ['s3'] },
    ]
    expect(currentWorkspaceIdOf(items, 's3')).toBe('ws-2')
    expect(currentWorkspaceIdOf(items, 's1')).toBe('ws-1')
    expect(currentWorkspaceIdOf(items, 'unknown')).toBeUndefined()
    expect(currentWorkspaceIdOf(items, undefined)).toBeUndefined()
  })
})

describe('pollOnce：轮询门控', () => {
  it('拉取 state 并把 questions 合流为问题卡（received）', async () => {
    const api = fakeApi([emptyState({ routerSessions: [{ sessionId: 'router-1', title: 'R' }], questions: [card('QA')] })])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: workspaces([]) })
    store.setCurrentSession('s1')
    await store.pollOnce()
    expect(store.get().routerState?.routerSessions).toHaveLength(1)
    expect(store.get().board.cards.map((entry) => entry.card.questionId)).toEqual(['QA'])
    expect(store.get().lastError).toBeNull()
  })

  it('workspace 解析出来时带上查询参数', async () => {
    const api = fakeApi([emptyState()])
    const ws = workspaces([{ workspaceId: 'ws-1', sessionIds: ['s1'] }])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: ws })
    store.setCurrentSession('s1')
    await store.pollOnce()
    expect(api.stateCalls).toEqual(['ws-1'])
  })

  it('上次 state 本 workspace 无 router 会话 → 跳过请求；恢复有会话前也不再空转', async () => {
    const api = fakeApi([emptyState()])
    const ws = workspaces([{ workspaceId: 'ws-1', sessionIds: ['s1'] }])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: ws })
    store.setCurrentSession('s1')
    await store.pollOnce() // 首次必拉，得知无 router 会话
    await store.pollOnce() // 门控关闭 → 跳过
    expect(api.stateCalls).toHaveLength(1)
  })

  it('上次 state 有 router 会话 → 继续轮询', async () => {
    const api = fakeApi([emptyState({ routerSessions: [{ sessionId: 'router-1', title: 'R' }] })])
    const ws = workspaces([{ workspaceId: 'ws-1', sessionIds: ['s1'] }])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: ws })
    store.setCurrentSession('s1')
    await store.pollOnce()
    await store.pollOnce()
    expect(api.stateCalls).toHaveLength(2)
  })

  it('workspace 变化后重置门控（换项目立即拉一次）', async () => {
    const api = fakeApi([emptyState()])
    const ws = workspaces([{ workspaceId: 'ws-1', sessionIds: ['s1'] }, { workspaceId: 'ws-2', sessionIds: ['s3'] }])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: ws })
    store.setCurrentSession('s1')
    await store.pollOnce()
    expect(api.stateCalls).toHaveLength(1)
    store.setCurrentSession('s3') // → ws-2
    await store.pollOnce()
    expect(api.stateCalls).toHaveLength(2)
    expect(api.stateCalls[1]).toBe('ws-2')
  })

  it('页面隐藏时不发请求', async () => {
    const api = fakeApi([])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: workspaces([]), isHidden: () => true })
    await store.pollOnce()
    expect(api.stateCalls).toHaveLength(0)
  })

  it('请求失败：保留旧 state，lastError 记录原因', async () => {
    const api = fakeApi([], { getState: async () => { throw new Error('boom') } })
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: workspaces([]) })
    await store.pollOnce()
    expect(store.get().routerState).toBeNull()
    expect(store.get().lastError).toContain('boom')
  })

  it('轮询间隔读偏好（供定时器使用）', () => {
    const store = startWorkbenchStore({ api: fakeApi([]), prefs: prefsStore({ pollMs: 4000 }), workspacesList: workspaces([]) })
    expect(store.pollIntervalMs()).toBe(4000)
  })
})

describe('closeWorkerTab：× 关闭 worker 标签', () => {
  const tabs: WorkerTabInfo[] = [
    { sessionId: 'w-a', title: 'A', running: false },
    { sessionId: 'w-b', title: 'B', running: false },
  ]

  async function seeded(api: RouterApi) {
    const store = startWorkbenchStore({
      api,
      prefs: prefsStore(),
      workspacesList: workspaces([{ workspaceId: 'ws-1', sessionIds: ['s1'] }]),
    })
    store.setCurrentSession('s1')
    await store.pollOnce() // api.getState 返回带 tabs 的 state
    return store
  }

  it('成功：调 tabs/close，然后本地移除该标签', async () => {
    const api = fakeApi([emptyState({ routerSessions: [{ sessionId: 'router-1', title: 'R' }], tabs })])
    const store = await seeded(api)
    await store.closeWorkerTab('w-a')
    expect(api.closeCalls).toEqual([['ws-1', 'w-a']])
    expect(store.get().routerState?.tabs.map((tab) => tab.sessionId)).toEqual(['w-b'])
    expect(store.get().closingSessionIds).toEqual([])
  })

  it('pending 期间该标签带 closing 标记（UI 禁点）', async () => {
    let releaseClose: (() => void) | undefined
    const api = fakeApi([emptyState({ routerSessions: [{ sessionId: 'router-1', title: 'R' }], tabs })], {
      closeWorkerTab: () => new Promise<void>((resolve) => { releaseClose = resolve }),
    })
    const store = await seeded(api)
    const pending = store.closeWorkerTab('w-a')
    expect(store.get().closingSessionIds).toEqual(['w-a'])
    releaseClose?.()
    await pending
    expect(store.get().closingSessionIds).toEqual([])
  })

  it('失败：标签保留、closing 标记清除、错误可读', async () => {
    const api = fakeApi(
      [emptyState({ routerSessions: [{ sessionId: 'router-1', title: 'R' }], tabs })],
      { closeWorkerTab: async () => { throw new Error('network down') } },
    )
    const store = await seeded(api)
    await store.closeWorkerTab('w-a')
    expect(store.get().routerState?.tabs.map((tab) => tab.sessionId)).toEqual(['w-a', 'w-b'])
    expect(store.get().closingSessionIds).toEqual([])
    expect(store.get().lastError).toContain('network down')
  })
})

describe('submitAnswer：提交 → answer 路由', () => {
  async function seeded(api: RouterApi) {
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: workspaces([]) })
    await store.pollOnce() // getState 返回带问题卡的 state
    return store
  }

  it('提交成功：卡片移除，answers 按官方词汇逐问构造（单选+custom → selected 置空）', async () => {
    const api = fakeApi([emptyState({ questions: [card('QA')] })])
    const store = await seeded(api)
    store.setAnswer('QA', 'q1', { selected: ['A'], custom: '都行' })
    await store.submitAnswer('QA')
    expect(api.answerCalls).toEqual([['QA', [{ id: 'q1', selected: [], custom: '都行' }]]])
    expect(store.get().board.cards).toHaveLength(0)
  })

  it('409 视为 done：卡片移除、不进 failed', async () => {
    const api = fakeApi([emptyState({ questions: [card('QA')] })], {
      postAnswer: async () => {
        const error = new Error('already answered') as Error & { status?: number }
        error.status = 409
        throw error
      },
    })
    const store = await seeded(api)
    await store.submitAnswer('QA')
    expect(store.get().board.cards).toHaveLength(0)
  })

  it('其他失败：phase=failed、草稿保留', async () => {
    const api = fakeApi([emptyState({ questions: [card('QA')] })], {
      postAnswer: async () => { throw new Error('server on fire') },
    })
    const store = await seeded(api)
    store.setAnswer('QA', 'q1', { selected: ['B'] })
    await store.submitAnswer('QA')
    expect(store.get().board.cards[0]?.phase).toBe('failed')
    expect(store.get().board.cards[0]?.draft['q1']?.selected).toEqual(['B'])
  })
})

describe('buildAnswers：草稿 → 官方答案词汇', () => {
  it('逐问生成 {id, selected, custom?}；custom 为空时省略', () => {
    const qa = card('QA')
    const withTwoQuestions = { ...qa, questions: [...qa.questions, { id: 'q2', question: '还要补充什么？' }] }
    const answers = buildAnswers(withTwoQuestions, {
      q1: { selected: ['A', 'B'] },
      q2: { selected: [], custom: '' },
    })
    expect(answers).toEqual([
      { id: 'q1', selected: ['A', 'B'] },
      { id: 'q2', selected: [] },
    ])
  })
})

describe('startWorkbenchPolling：定时器接线', () => {
  /** 假定时器：记录排上的回调与间隔，手动触发。 */
  function fakeTimer() {
    const armed: Array<{ callback: () => void; ms: number }> = []
    const timer = {
      armed,
      setIntervalFn: (callback: () => void, ms: number) => {
        armed.push({ callback, ms })
        return armed.length - 1
      },
      clearIntervalFn: (handle: unknown) => {
        const index = handle as number
        if (index >= 0 && index < armed.length) armed.splice(index, 1)
      },
    }
    return timer
  }

  it('按偏好间隔起一次轮询；tick 触发 pollOnce；停止后不再触发', async () => {
    const api = fakeApi([emptyState({ routerSessions: [{ sessionId: 'router-1', title: 'R' }] })])
    const prefs = prefsStore()
    const store = startWorkbenchStore({ api, prefs, workspacesList: workspaces([]) })
    const timer = fakeTimer()
    const stop = startWorkbenchPolling(store, prefs, timer)
    expect(timer.armed).toHaveLength(1)
    expect(timer.armed[0]?.ms).toBe(2500)
    timer.armed[0]?.callback()
    await Promise.resolve()
    expect(api.stateCalls).toHaveLength(1)
    stop()
    // 清不掉句柄会被下面的断言抓出来：armed 应已空。
    expect(timer.armed).toHaveLength(0)
  })

  it('偏好间隔变化时重排定时器（旧句柄被清）', () => {
    const api = fakeApi([])
    const prefs = prefsStore()
    const store = startWorkbenchStore({ api, prefs, workspacesList: workspaces([]) })
    const timer = fakeTimer()
    const stop = startWorkbenchPolling(store, prefs, timer)
    expect(timer.armed).toHaveLength(1)
    prefs.set({ ...prefs.get(), pollMs: 5000 })
    expect(timer.armed).toHaveLength(1)
    expect(timer.armed[0]?.ms).toBe(5000)
    stop()
  })
})
