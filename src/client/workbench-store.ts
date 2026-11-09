/**
 * 工作台共享 store（计划 Task B7：轮询 2.5s、仅当本 workspace 有 router
 * 会话、页面隐藏暂停；worker 标签本地移除；问题卡与轮询状态在这里合流）。
 *
 * 为什么不把轮询塞进某个组件：标签条与问题浮窗都要读 RouterState，轮询
 * 放在共享 store（apply 里经 ctx.effect 起停）让两块表面读同一个来源，
 * 组件保持纯订阅者。门控规则与简报一致：
 * - 首次必拉；此后「本 workspace 上次 state 里没有 router 会话」就不再发
 *   请求（避免没装 Router 的项目空转）；workspace 变了立即重拉；
 * - document.hidden 时跳过（页面不可见不打扰网络）。
 */

import type { RouterApi, RouterApiError } from './api.ts'
import type { ClientPrefsStore } from './client-prefs.ts'
import {
  buildAnswerItems,
  setAnswer,
  submitAccepted,
  submitRejected,
  submitStarted,
  syncedWithServer,
  toggleCollapsed,
  emptyBoard,
} from './question-state.ts'
import type { QuestionBoardState, QuestionDraftItem } from './question-state.ts'
import type { RouterState } from '../shared/view-contract.ts'

export { buildAnswerItems as buildAnswers }

/** workspaces.list 快照的最小面（结构化，测试可用假快照充当）。 */
export interface WorkspacesListLike {
  getSnapshot(): { items?: ReadonlyArray<{ workspaceId: string; sessionIds: readonly string[] }> }
}

/** 当前会话 id → 所属工作区 id（与宿主 ui-workspace 的推导同款）。 */
export function currentWorkspaceIdOf(
  items: ReadonlyArray<{ workspaceId: string; sessionIds: readonly string[] }>,
  sessionId: string | undefined,
): string | undefined {
  if (sessionId === undefined) return undefined
  return items.find((item) => item.sessionIds.includes(sessionId))?.workspaceId
}

/** store 的对外状态（React useSyncExternalStore 直接读）。 */
/** 当前是否停在 Router 会话视图（仅通知浮窗的暂停/解冻按钮用；问题浮窗是全局浮层）。 */
export function isRouterSessionView(state: WorkbenchState): boolean {
  if (state.currentSessionId === undefined) return false
  return (state.routerState?.routerSessions ?? []).some((row) => row.sessionId === state.currentSessionId)
}

export interface WorkbenchState {
  ready: boolean
  routerState: RouterState | null
  lastError: string | null
  board: QuestionBoardState
  /** 关闭中的 worker 标签（× 点下后、服务端确认前），UI 禁点防重复。 */
  closingSessionIds: readonly string[]
  currentSessionId?: string
  /** 系统提示词编辑面板当前打开的会话 id（v1.1 C5；undefined = 关闭）。 */
  promptEditorSessionId?: string
}

/** startWorkbenchStore 的依赖。 */
export interface WorkbenchStoreDeps {
  api: RouterApi
  prefs: ClientPrefsStore
  /** workspaces.list——把当前会话映射成 workspaceId 用于 state 过滤。 */
  workspacesList?: WorkspacesListLike
  /** 页面隐藏判定；缺省读 document.hidden。 */
  isHidden?: () => boolean
  /** 诊断出口（apply 里接 logger.warn）；缺省静默。 */
  report?: (message: string) => void
  /** 会话导航（openSession）——问题卡跳转等本地导航用；缺席时降级。 */
  uiWorkspace?: { openSession(target: string): void }
}

/** 工作台 store 的公开面（全部操作经它，组件不发自己的请求）。 */
export interface WorkbenchStore {
  get(): WorkbenchState
  subscribe(listener: () => void): () => void
  setCurrentSession(sessionId: string | undefined): void
  /** 一次轮询 tick（门控在这里）；定时器只负责按间隔调它。 */
  pollOnce(): Promise<void>
  /** 供定时器读的间隔（跟随偏好）。 */
  pollIntervalMs(): number
  /** 当前解析出的 workspaceId（创建 Router 表单也用它）。 */
  currentWorkspaceId(): string | undefined
  /**
   * 门控重开 + 在途快照作废（审查 F2）：本工作区刚发生了会让服务端状态
   * 变化的动作（如创建了第一个 Router）时调用，下一拍立即拉真。
   */
  invalidateGate(): void
  closeWorkerTab(sessionId: string): Promise<void>
  toggleCollapsed(questionId: string): void
  setAnswer(questionId: string, itemId: string, patch: { selected?: string[]; custom?: string | null }): void
  submitAnswer(questionId: string): Promise<void>
  /** 打开某会话的系统提示词编辑面板（v1.1 C5；头部按钮触发，浮层消费）。 */
  /** 关闭编辑面板（幂等）。 */
}

function emptyState(): RouterState {
  return { routerSessions: [], tasks: [], questions: [], tabs: [], templates: [] }
}

function isPageHidden(): boolean {
  try {
    return globalThis.document?.hidden === true
  } catch {
    return false
  }
}

function errorStatus(error: unknown): number | undefined {
  return (error as Partial<RouterApiError>)?.status
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function startWorkbenchStore(deps: WorkbenchStoreDeps): WorkbenchStore {
  const { api, prefs } = deps
  const report = deps.report ?? (() => {})
  const isHidden = deps.isHidden ?? isPageHidden

  let state: WorkbenchState = {
    ready: false,
    routerState: null,
    lastError: null,
    board: emptyBoard(),
    closingSessionIds: [],
  }
  // 门控记忆：上次拉取的 workspace 与「该 workspace 是否有 router 会话」。
  let lastGateKey: string | undefined
  let gateHasRouterSession = false
  // 竞态防线（审查 F3）：每次轮询带序号，本地变更再推进变更号；只有
  // 「请求发起时的两个号都仍是当前号」的响应才允许落地——迟到的旧
  // workspace 快照、关标签/提交完成前发出的快照一律丢弃。
  let pollSeq = 0
  let mutationSeq = 0
  const listeners = new Set<() => void>()
  function emit(): void {
    for (const listener of [...listeners]) listener()
  }

  function apply(mutate: () => WorkbenchState): void {
    const next = mutate()
    if (next === state) return
    state = next
    emit()
  }

  function workspaceItems(): ReadonlyArray<{ workspaceId: string; sessionIds: readonly string[] }> {
    return deps.workspacesList?.getSnapshot().items ?? []
  }

  // 门控重开 + 在途快照作废。用闭包而非 this：store 方法可能被解构调用。
  function reopenGate(): void {
    mutationSeq += 1
    lastGateKey = undefined
  }

  return {
    get: () => state,

    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    setCurrentSession(sessionId) {
      if (state.currentSessionId === sessionId) return
      apply(() => ({ ...state, currentSessionId: sessionId }))
      // 会话切换（含新建 Router 被打开）重开门控：否则门控一旦因「本工作区无
      // Router」关闭就永不重开，picker 自建的首个 Router 永远不被轮询/收编发现。
      reopenGate()
    },

    pollIntervalMs: () => prefs.get().pollMs,

    currentWorkspaceId: () => currentWorkspaceIdOf(workspaceItems(), state.currentSessionId),

    invalidateGate(): void {
      // 本工作区发生了服务端会关心的变化（如创建了首个 Router）：
      // 门控重开 + 在途快照作废，下一次 tick 立即拉真。
      reopenGate()
    },

    async pollOnce(): Promise<void> {
      if (isHidden()) return
      const workspaceId = currentWorkspaceIdOf(workspaceItems(), state.currentSessionId)
      const gateKey = workspaceId ?? ''
      if (lastGateKey === gateKey && !gateHasRouterSession) return
      const seq = ++pollSeq
      const mutAtStart = mutationSeq
      try {
        const next: RouterState = await api.getState(workspaceId) ?? emptyState()
        if (seq !== pollSeq || mutAtStart !== mutationSeq) return // 迟到快照：丢弃
        gateHasRouterSession = next.routerSessions.length > 0
        lastGateKey = gateKey
        apply(() => ({
          ...state,
          ready: true,
          routerState: next,
          lastError: null,
          board: syncedWithServer(state.board, next.questions),
        }))
      } catch (error) {
        if (seq !== pollSeq || mutAtStart !== mutationSeq) return // 迟到失败：不打扰当前态
        // 失败保留旧 state（界面不闪空），错误可读；门控记忆不动，下次照常试。
        report(`router state poll failed: ${errorMessage(error)}`)
        apply(() => ({ ...state, ready: true, lastError: errorMessage(error) }))
      }
    },

    async closeWorkerTab(sessionId: string): Promise<void> {
      const workspaceId = currentWorkspaceIdOf(workspaceItems(), state.currentSessionId)
      if (workspaceId === undefined) {
        const message = 'router: 无法确定当前工作区，关闭标签被跳过'
        report(message)
        apply(() => ({ ...state, lastError: message }))
        return
      }
      mutationSeq += 1 // 在途的轮询快照从此作废（不得复活被关的标签）
      apply(() => ({
        ...state,
        closingSessionIds: state.closingSessionIds.includes(sessionId)
          ? state.closingSessionIds
          : [...state.closingSessionIds, sessionId],
      }))
      try {
        await api.closeWorkerTab(workspaceId, sessionId)
        apply(() => ({
          ...state,
          lastError: null,
          // 服务端确认后本地移除：关的是视图，不是会话、不是任务。
          routerState: state.routerState === null
            ? null
            : { ...state.routerState, tabs: state.routerState.tabs.filter((tab) => tab.sessionId !== sessionId) },
        }))
      } catch (error) {
        report(`router tabs/close failed: ${errorMessage(error)}`)
        apply(() => ({ ...state, lastError: `关闭标签失败：${errorMessage(error)}` }))
      } finally {
        apply(() => ({ ...state, closingSessionIds: state.closingSessionIds.filter((id) => id !== sessionId) }))
      }
    },

    toggleCollapsed(questionId: string): void {
      apply(() => ({ ...state, board: toggleCollapsed(state.board, questionId) }))
    },

    setAnswer(questionId: string, itemId: string, patch: { selected?: string[]; custom?: string | null }): void {
      apply(() => ({ ...state, board: setAnswer(state.board, questionId, itemId, patch) }))
    },

    async submitAnswer(questionId: string): Promise<void> {
      const entry = state.board.cards.find((candidate) => candidate.card.questionId === questionId)
      if (entry === undefined) return
      // 显式阶段守卫（审查 F9/F1）：只有 received | failed 可发起提交；
      // 在途（submitting）二次触发是无操作，不发第二个请求。
      if (entry.phase !== 'received' && entry.phase !== 'failed') return
      mutationSeq += 1 // 在途的轮询快照作废（不得覆盖提交窗口内的本地变更）
      apply(() => ({ ...state, board: submitStarted(state.board, questionId) }))
      const answers = buildAnswerItems(entry.card, entry.draft as Record<string, QuestionDraftItem>)
      try {
        await api.postAnswer(questionId, answers)
        // 成功（或 409 已答过 = 视为已完成）：在【当前】账本上出队（审查 F1——
        // 提交窗口内其他卡的草稿/新卡不动）。
        apply(() => ({ ...state, lastError: null, board: submitAccepted(state.board, questionId) }))
      } catch (error) {
        if (errorStatus(error) === 409) {
          apply(() => ({ ...state, lastError: null, board: submitAccepted(state.board, questionId) }))
          return
        }
        // 其他失败：卡片保留、已填内容保留、可改后重试（同样落在当前账本上）。
        report(`router answer failed: ${errorMessage(error)}`)
        apply(() => ({ ...state, lastError: `回答送达失败：${errorMessage(error)}`, board: submitRejected(state.board, questionId) }))
      }
    },
  }
}

/** 定时器面（测试注入假定时器；缺省走全局 setInterval）。 */
export interface PollingTimer {
  setIntervalFn(callback: () => void, ms: number): unknown
  clearIntervalFn(handle: unknown): void
}

const defaultPollingTimer: PollingTimer = {
  setIntervalFn: (callback, ms) => globalThis.setInterval(callback, ms),
  clearIntervalFn: (handle) => { globalThis.clearInterval(handle as ReturnType<typeof setInterval>) },
}

/**
 * 启动轮询：按偏好间隔调 pollOnce；偏好变化时重排间隔；返回停止函数
 * （apply 里经 ctx.effect 挂生命周期，插件卸载即停）。
 */
export function startWorkbenchPolling(
  store: WorkbenchStore,
  prefs: ClientPrefsStore,
  timer: PollingTimer = defaultPollingTimer,
): () => void {
  let handle: unknown
  const arm = (): void => {
    if (handle !== undefined) timer.clearIntervalFn(handle)
    handle = timer.setIntervalFn(() => { void store.pollOnce() }, store.pollIntervalMs())
  }
  arm()
  const disposePrefs = prefs.subscribe(arm)
  return () => {
    disposePrefs()
    if (handle !== undefined) {
      timer.clearIntervalFn(handle)
      handle = undefined
    }
  }
}
