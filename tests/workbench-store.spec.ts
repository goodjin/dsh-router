/**
 * 工作台共享 store（计划 Task B7：轮询 2.5s、仅当本 workspace 有 router 会话、
 * 页面隐藏暂停；worker 标签本地移除；问题卡与轮询状态合流）。
 *
 * store 是纯逻辑（定时器可注入），组件只是它的订阅者。测试用假 api 与假
 * workspaces 快照经公开 API（pollOnce）驱动，不启网络、不启 React。
 */

import { describe, expect, it } from 'vitest'
import { isRouterSessionView, startWorkbenchPolling, startWorkbenchStore, buildAnswers, currentWorkspaceIdOf } from '../src/client/workbench-store.ts'
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

/** 假 uiWorkspace：记录 openSession 的目标。 */
function fakeUiWorkspace() {
  const openCalls: string[] = []
  return { openCalls, openSession: (target: string) => { openCalls.push(target) } }
}

/** 冲刷微任务（ack 是 fire-and-forget 的 promise，断言前要让它结算）。 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** 可手动放行的 promise（竞态测试用）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((given) => { resolve = given })
  return { promise, resolve }
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

  it('请求失败：保留旧 state（先成功后失败，界面不闪空），lastError 记录原因', async () => {
    const good = emptyState({ routerSessions: [{ sessionId: 'router-1', title: 'R' }], tabs: [{ sessionId: 'w-a', title: 'A', running: false }] })
    let calls = 0
    const api = fakeApi([], {
      getState: async () => {
        calls += 1
        if (calls === 1) return good
        throw new Error('boom')
      },
    })
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: workspaces([]) })
    await store.pollOnce()
    expect(store.get().routerState).toEqual(good)
    await store.pollOnce()
    expect(store.get().routerState).toEqual(good)
    expect(store.get().lastError).toContain('boom')
  })

  it('门控重开（审查 F2）：创建首个 Router 后显式失效，下一次 tick 立即拉取', async () => {
    const api = fakeApi([emptyState()])
    const ws = workspaces([{ workspaceId: 'ws-1', sessionIds: ['s1'] }])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: ws })
    store.setCurrentSession('s1')
    await store.pollOnce()
    await store.pollOnce()
    expect(api.stateCalls).toHaveLength(1) // 门控已关
    store.invalidateGate()
    await store.pollOnce()
    expect(api.stateCalls).toHaveLength(2)
    expect(api.stateCalls[1]).toBe('ws-1')
  })

  it('迟到响应不覆盖现状（审查 F3）：旧 workspace 的响应被丢弃', async () => {
    const stale = emptyState({ routerSessions: [{ sessionId: 'router-old', title: '旧工作区的 Router' }] })
    const fresh = emptyState({ routerSessions: [{ sessionId: 'router-new', title: '新工作区的 Router' }] })
    const pending = deferred<RouterState>()
    const api = fakeApi([], {
      getState: (workspaceId) => workspaceId === 'ws-1' ? pending.promise : Promise.resolve(fresh),
    })
    const ws = workspaces([{ workspaceId: 'ws-1', sessionIds: ['s1'] }, { workspaceId: 'ws-2', sessionIds: ['s3'] }])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: ws })
    store.setCurrentSession('s1')
    const first = store.pollOnce() // 挂在 ws-1 上
    await Promise.resolve()
    store.setCurrentSession('s3') // → ws-2
    await store.pollOnce() // ws-2 立即完成
    expect(store.get().routerState).toEqual(fresh)
    pending.resolve(stale) // ws-1 的迟到响应
    await first
    expect(store.get().routerState).toEqual(fresh)
  })

  it('变更之后完成的旧响应不复活已删除项（审查 F3）：关标签后丢弃在途快照', async () => {
    const withTab = emptyState({ routerSessions: [{ sessionId: 'router-1', title: 'R' }], tabs: [{ sessionId: 'w-a', title: 'A', running: false }] })
    const pending = deferred<RouterState>()
    let calls = 0
    const api = fakeApi([], {
      getState: () => {
        calls += 1
        if (calls === 1) return Promise.resolve(withTab) // 首拍正常落地
        return pending.promise // 第二拍悬着（快照里仍带 w-a）
      },
    })
    const ws = workspaces([{ workspaceId: 'ws-1', sessionIds: ['s1'] }])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: ws })
    store.setCurrentSession('s1')
    await store.pollOnce()
    expect(store.get().routerState?.tabs.map((tab) => tab.sessionId)).toEqual(['w-a'])
    const second = store.pollOnce() // 在途快照（还带着 w-a）
    await Promise.resolve()
    await store.closeWorkerTab('w-a') // 本地移除 + 记一次变更
    expect(store.get().routerState?.tabs).toEqual([])
    pending.resolve(withTab) // 在途响应这时才回来（带着 w-a）
    await second
    // 快照被竞态防线丢弃：w-a 不得复活。
    expect(store.get().routerState?.tabs).toEqual([])
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

  it('结算落在当前账本上（审查 F1）：提交 A 期间编辑 B，不被旧快照覆盖；结算后 C 正常进账', async () => {
    let releaseAnswer: (() => void) | undefined
    const withCards = emptyState({
      routerSessions: [{ sessionId: 'router-1', title: 'R' }],
      questions: [card('QA'), card('QB')],
    })
    const afterSettle = emptyState({
      routerSessions: [{ sessionId: 'router-1', title: 'R' }],
      questions: [card('QB'), card('QC')],
    })
    const api = fakeApi([withCards, afterSettle], {
      postAnswer: () => new Promise<void>((resolve) => { releaseAnswer = resolve }),
    })
    const store = await seeded(api)
    store.setAnswer('QA', 'q1', { selected: ['A'] })
    const inFlight = store.submitAnswer('QA') // A 提交中
    await Promise.resolve()
    store.setAnswer('QB', 'q1', { selected: ['B'] }) // 期间编辑 B
    releaseAnswer?.()
    await inFlight
    expect(store.get().board.cards.map((entry) => entry.card.questionId)).toEqual(['QB'])
    expect(store.get().board.cards[0]?.draft['q1']?.selected).toEqual(['B'])
    // 结算后下一拍轮询把 C 带进来，B 的草稿必须原样。
    await store.pollOnce()
    expect(store.get().board.cards.map((entry) => entry.card.questionId)).toEqual(['QB', 'QC'])
    expect(store.get().board.cards[0]?.draft['q1']?.selected).toEqual(['B'])
  })

  it('并发提交各自结算：A 成功不移除 B（审查 F1）', async () => {
    const both = emptyState({ routerSessions: [{ sessionId: 'router-1', title: 'R' }], questions: [card('QA'), card('QB')] })
    const api = fakeApi([both])
    const store = await seeded(api)
    await Promise.all([store.submitAnswer('QA'), store.submitAnswer('QB')])
    expect(store.get().board.cards).toHaveLength(0)
  })

  it('提交中的卡二次提交是无操作（审查 F9）：只发一次请求', async () => {
    let releaseAnswer: (() => void) | undefined
    const api = fakeApi([emptyState({ questions: [card('QA')] })], {
      postAnswer: () => new Promise<void>((resolve) => { releaseAnswer = resolve }),
    })
    const store = await seeded(api)
    const first = store.submitAnswer('QA')
    await Promise.resolve()
    await store.submitAnswer('QA') // 第二次点击/调用：在途，必须不发
    releaseAnswer?.()
    await first
    expect(api.answerCalls).toHaveLength(1)
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

/* ────────────────────────── 提示词编辑器开关状态（v1.1 Task C5） ────────────────────────── */

describe('提示词编辑器开关（C5）', () => {
  it('openPromptEditor 记住会话 id，closePromptEditor 清掉；重复 open 覆盖', () => {
    const api = fakeApi([])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: workspaces([]) })
    expect(store.get().promptEditorSessionId).toBeUndefined()
    store.openPromptEditor('s-router')
    expect(store.get().promptEditorSessionId).toBe('s-router')
    store.openPromptEditor('s-other')
    expect(store.get().promptEditorSessionId).toBe('s-other')
    store.closePromptEditor()
    expect(store.get().promptEditorSessionId).toBeUndefined()
    // 重复 close 幂等
    store.closePromptEditor()
    expect(store.get().promptEditorSessionId).toBeUndefined()
  })

  it('开关变更通知订阅者（浮层组件跟着开/关）', () => {
    const api = fakeApi([])
    const store = startWorkbenchStore({ api, prefs: prefsStore(), workspacesList: workspaces([]) })
    let snapshots: Array<string | undefined> = []
    const dispose = store.subscribe(() => { snapshots.push(store.get().promptEditorSessionId) })
    store.openPromptEditor('s-router')
    store.closePromptEditor()
    dispose()
    expect(snapshots).toEqual(['s-router', undefined])
  })
})

describe('isRouterSessionView：浮窗只在 Router 会话视图展示（v1.4）', () => {
  // isRouterSessionView 只读 currentSessionId 与 routerState.routerSessions，
  // 测试用最小形状直构（不启完整 store）。
  const view = (current: string | undefined): Parameters<typeof isRouterSessionView>[0] =>
    ({
      currentSessionId: current,
      routerState: { routerSessions: [{ sessionId: 'r-1', title: 'R' }], tasks: [], questions: [], tabs: [], templates: [] },
    }) as Parameters<typeof isRouterSessionView>[0]
  it('当前会话在 routerSessions 里 → true；不在或无当前会话 → false', () => {
    expect(isRouterSessionView(view('r-1'))).toBe(true)
    expect(isRouterSessionView(view('w-9'))).toBe(false)
    expect(isRouterSessionView(view(undefined))).toBe(false)
    expect(isRouterSessionView({ ...view('r-1'), routerState: null })).toBe(false)
  })
})
