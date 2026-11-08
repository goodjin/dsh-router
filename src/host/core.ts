/**
 * RouterCore 的根服务实现（计划 B2/B3/B4/B5 的组装点，纯逻辑、宿主面全注入）。
 *
 * 工具薄壳（src/host/tools）调用的每个方法都在这里落地：派发前的模板校验与
 * dispatchGuard（角色/深度/环）、任务书渲染落盘、会话桥投递、驱动打标、标签
 * 登记；完成协议的存结果、通知上级、解锁自动派发；以及 Router 工作台面
 * （state / createRouterSession / answer / closeTab）与同步快照缓存。
 * entry.ts 把宿主服务接进 deps；本文件不 import 任何宿主专有包。
 */

import { LedgerError } from './ledger/errors.ts'
import type { TaskLedger } from './ledger/store.ts'
import type { TaskDocStore } from './docs/task-docs.ts'
import { renderTaskBook } from './docs/render.ts'
import type { Scheduler } from './ledger/scheduler.ts'
import type { SessionBridge, WorkspaceInfo } from './bridge/sessions.ts'
import type { AnswerRelay } from './bridge/questions.ts'
import { isHuskTask, type UiStateStore } from './bridge/tabs.ts'
import type { CompactionDriver } from './context/compaction-driver.ts'
import { renderLedgerSnapshot } from './context/snapshot.ts'
import { assertCallerRole } from './tools/index.ts'
import type {
  CompleteTaskInput,
  DispatchTaskInput,
  QueryTasksFilter,
  RouterCore,
  RouterTypeCreateInput,
} from './core-types.ts'
import { isTerminal, type RoleKind, type TaskRecord, type TaskStatus } from '../shared/types.ts'
import type { CircuitBreaker, BreakerVisibility } from './guard/breaker.ts'
import { runScopedPause, scopedPauseTargets } from './guard/emergency.ts'
import type { DispatchBudgets, BudgetSnapshot } from './guard/budgets.ts'
import { classifyDispatchFailure } from './guard/classify.ts'
import { anomalyActions, completionActions, pausedActions, type NotificationSink } from './guard/notifications.ts'
import type {
  AskUserQuestionAnswerItem,
  QuestionCard,
  RouterDefaults,
  RouterState,
  TaskCard,
  WorkerTemplate,
  WorkerTypeRecord,
  WorkerTypeSummary,
} from '../shared/view-contract.ts'
import { parseModelRef } from './model-ref.ts'

/** 宿主服务的最小面（entry.ts 接真实服务；测试给假件）。 */
export interface RouterCoreHosts {
  sessionController: {
    create(opts: { workspaceId?: string; cwd?: string; agentPreset?: string }, signal?: AbortSignal): Promise<{ sessionId: string }>
    prompt(request: {
      requestId: string
      sessionId: string
      mode: 'queue' | 'steer'
      content: { type: 'text'; text: string }[]
    }, signal?: AbortSignal): Promise<unknown>
    rename(request: { sessionId: string; title: string }, signal?: AbortSignal): Promise<unknown>
    /**
     * v1.1 规格 §5：会话模型设置通路（两版本 sessionController 都有；UI
     * ModelSelect 走的同一入口）。缺席 = 不钉默认模型（降级实现）。
     */
    selectModel?(request: { sessionId: string; provider: string; model: string }, signal?: AbortSignal): Promise<unknown>
  }
  /** 只在装配层用（压缩驱动取存活 agent）；核心逻辑不消费。 */
  agents: { get(sessionId: string): unknown }
  workspaceRegistry: {
    /** 同步投影（r2 §5：list/get 都是同步方法，sessionIds 已按 cwd 过滤）。 */
    list(): WorkspaceInfo[]
    get(id: string): WorkspaceInfo | undefined
  }
  /** api-session/status 订阅口（会话桥 watchStatus 的落点）。 */
  onSessionStatus(callback: (sessionId: string, running: boolean) => void): void
}

/** worker 类型存储的投影面（entry.ts 接 WorkerTypeStore；测试给假投影）。 */
export interface WorkerTypesFace {
  /** 启用类型的同步投影（dispatch 校验与工具描述的实时清单）。 */
  enabled(): WorkerTemplate[]
  /** 全类型摘要（RouterState.types；含 enabled/origin）。 */
  summaries(): WorkerTypeSummary[]
  /**
   * C2 类型工具的创建通道：建 router 来源类型（重名拒绝）并做引擎增量同步
   * （注册新预设）。缺席 = 存储未接线，createWorkerType 拒绝创建。
   */
  createRouterType?(input: RouterTypeCreateInput): Promise<{ record: WorkerTypeRecord; presetRegistered: boolean }>
}

/** Router 默认值面（规格 §6；缺省 = 不钉默认模型、提示词走静态兜底）。 */
export interface RouterDefaultsFace {
  get(): Promise<RouterDefaults>
}

/** 预设与模板配置。 */
export interface RouterCoreConfig {
  routerPreset: string
  supervisorPreset: string
  workerPreset: string
  templates: WorkerTemplate[]
}

/** 记忆服务面（计划 B6/B8：entry.ts 用 memory/adapter + retrieval 组装注入）。 */
export interface RouterMemory {
  /** search_history 的数据面（retrieval.search 直传）。 */
  search(query: string, scope: 'project' | 'global'): Promise<{ memoryRef: string; snippet: string }[]>
  /**
   * 任务完成触发：写 project 层完成记录 + 任务会话增量摘要。
   * 实现方自行容错（不阻塞完成协议、失败只 warn）。
   */
  onTaskCompleted(input: { taskId: string; title: string; summary: string; resultRelPath: string; sessionId?: string }): void
}

export interface RouterCoreAssemblyDeps {
  ledger: TaskLedger
  docsFor(cwd: string): TaskDocStore
  bridge: SessionBridge
  relay: AnswerRelay
  driver: CompactionDriver
  scheduler: Scheduler
  ui: UiStateStore
  hosts: RouterCoreHosts
  config: RouterCoreConfig
  /** 类型存储投影（v1.1 C1；缺席 = config.templates 兜底）。 */
  types?: WorkerTypesFace
  /** Router 默认值（v1.1 C1；缺席/模型空 = 不钉默认模型）。 */
  routerDefaults?: RouterDefaultsFace
  newId(): string
  signal?: AbortSignal
  isRunning(sessionId: string): boolean
  /** 活动快照卡上限（缺省 12）。 */
  maxActiveCards?: number
  /** 任务文档目录名（缺省 '.router'；result.md 相对路径用它拼）。 */
  tasksDir?: string
  /** 记忆服务（缺省时 search_history 返回注记、完成不触发记忆写入）。 */
  memory?: RouterMemory
  /** 派发失败等非致命问题的日志口（缺席静默）。 */
  logger?: { warn(message: string): void }
  /** 全局派发熔断器（v1.2 Task B1；缺席 = 不熔断，只走 v1.1 per-task 语义）。 */
  breaker?: CircuitBreaker
  /** 派发预算（v1.2 Task B2；缺席 = 不限每轮任务/提问、无主管失败预算）。 */
  budgets?: DispatchBudgets
  /** v1.2 B3：统一通知卡（完成/异常）；缺省不发电（测试与降级形态）。 */
  notifications?: NotificationSink
  /** 熔断事件记账时钟（缺省 Date.now）。 */
  now?: () => number
}

/** Router 工作台面（HTTP 路由消费）。 */
export interface RouterWorkbench {
  state(workspaceId?: string): Promise<RouterState>
  createRouterSession(workspaceId: string | undefined, name?: string): Promise<{ sessionId: string }>
  answerQuestion(questionId: string, answers: AskUserQuestionAnswerItem[]): Promise<void>
  closeTab(workspaceId: string, sessionId: string): Promise<boolean>
  pendingQuestions(): QuestionCard[]
}

/** 深度：根任务 1，子任务 +1；parentId 链带 visited 防护。 */
function depthOf(ledger: TaskLedger, taskId: string | undefined): number {
  let depth = 0
  const visited = new Set<string>()
  let cursor: string | undefined = taskId
  while (cursor !== undefined && !visited.has(cursor)) {
    visited.add(cursor)
    depth += 1
    cursor = ledger.get(cursor)?.parentId
  }
  return depth
}

/** TaskRecord → TaskCard（role 字段：任务只会以 supervisor/worker 创建）。 */
function toCard(record: TaskRecord, waiting: number): TaskCard {
  // 可选字段只在有值时进卡：undefined 值的键会被 JSON 序列化静默蒸发，
  // 输出就不是无损 JSON（v1.1 Task A3 门禁，v1 现场 query_tasks 因此全盲）。
  const card: TaskCard = {
    taskId: record.id,
    title: record.title,
    goal: record.goal,
    status: record.status,
    role: record.role as 'supervisor' | 'worker',
    templateId: record.templateId ?? '',
    waitingQuestions: waiting,
    docVersion: record.docVersion,
  }
  if (record.progress !== undefined) card.progress = record.progress
  if (record.sessionId !== undefined) card.sessionId = record.sessionId
  if (record.parentId !== undefined) card.parentId = record.parentId
  // v1.3 C1：首请求缓存命中量，未上报不进卡（undefined 键会被 JSON 蒸发，lossless）
  if (record.firstRequestCacheReadTokens !== undefined) card.firstRequestCacheReadTokens = record.firstRequestCacheReadTokens
  return card
}

export interface RouterCoreAssembly {
  core: RouterCore
  workbench: RouterWorkbench
  /** 最近一次刷新的快照文本（systemPrompt.context 的同步读缓存）。 */
  snapshotText(): string
  refreshSnapshot(): Promise<void>
  recoverOrphans(): Promise<string[]>
}

/**
 * 熔断冻结态的可见投影（lossless：未冻结只带 frozen；冻结才带原因与时间）。
 * query_tasks.breaker（模型可见）与 RouterState.breaker（界面可见）共用它。
 */
async function breakerView(breaker: CircuitBreaker): Promise<BreakerVisibility> {
  const state = await breaker.state()
  const view: BreakerVisibility = { frozen: state.frozen }
  if (state.frozen) {
    if (state.reason !== undefined) view.reason = state.reason
    if (state.frozenAt !== undefined) view.frozenAt = state.frozenAt
  }
  return view
}

/**
 * 派发重试上限（v1.1 规格 §2-4）：同一任务连续派发失败达上限自动 blocked，
 * 禁止无限重试换模板碰运气。
 */
export const DISPATCH_RETRY_CAP = 3

/**
 * templateId 收紧（v1.1 Task A4）：未知或已禁用的模板直接拒，错误带当前可用
 * 清单（杜绝 general 式幻觉）。enabledTypes 由调用方传入当前启用子集。
 */
export function assertTemplateUsable(templateId: string, enabledTypes: readonly WorkerTemplate[]): void {
  const known = enabledTypes.find((entry) => entry.templateId === templateId)
  if (known !== undefined) return
  const error = new LedgerError(
    'template-unavailable',
    `未知或已禁用的 worker 模板: ${templateId}（可用：${enabledTypes.map((entry) => entry.templateId).join('、')}）`,
  )
  Object.assign(error, { available: enabledTypes.map((entry) => entry.templateId) })
  throw error
}

/** 派发失败的统一处理：分类上报熔断（v1.2 B1）、记账（progress + retryCount，达上限自动 blocked）并通知 Router。 */
async function recordDispatchFailure(
  deps: RouterCoreAssemblyDeps,
  ledger: TaskLedger,
  taskId: string,
  title: string,
  error: unknown,
  notifyRouterSession: string | undefined,
): Promise<TaskRecord> {
  // v1.2 规格 §1：失败先分类——infra（会话创建/挂载/投递失败）计入熔断器，
  // task 类只走既有 per-task 重试，不进熔断计数。
  const verdict = classifyDispatchFailure(error)
  await deps.breaker?.recordFailure({ taskId, at: (deps.now ?? (() => Date.now()))(), class: verdict.class })
  const message = error instanceof Error ? error.message : String(error)
  const failed = await ledger.recordDispatchFailure(taskId, `派发失败: ${message}`, { blockAt: DISPATCH_RETRY_CAP })
  if (failed.status === 'blocked') {
    await deps.notifications?.push({
      kind: 'anomaly',
      taskId,
      title,
      summary: `连续 ${failed.retryCount} 次派发失败，任务已自动阻塞：${message}`,
      actions: anomalyActions(),
    })
  }
  if (failed.status === 'blocked' && notifyRouterSession !== undefined) {
    await deps.bridge.notify(
      notifyRouterSession,
      `dispatch-blocked-${taskId}`,
      `任务 ${taskId}「${title}」连续 ${failed.retryCount} 次派发失败，已自动受阻（blocked）。请检查模板/环境问题后人工介入；不要继续重试同一模板。最近错误：${message}`,
    )
  }
  return failed
}

export function createRouterCore(deps: RouterCoreAssemblyDeps): RouterCoreAssembly {
  const { ledger, bridge, relay, driver, scheduler, ui, hosts, config } = deps

  /** 待答问题计数（taskId → open 数）。 */
  const waitingCounts = async (): Promise<Record<string, number>> => {
    const open = await ledger.openQuestions()
    const counts: Record<string, number> = {}
    for (const question of open) {
      if (question.taskId !== undefined) counts[question.taskId] = (counts[question.taskId] ?? 0) + 1
    }
    return counts
  }

  /** 调用方会话绑定的任务（决定 caller 的角色与项目归属）。 */
  const taskBySession = async (sessionId: string): Promise<TaskRecord | undefined> => {
    const records = await ledger.listAll()
    return records.find((record) => record.sessionId === sessionId)
  }

  /**
   * 调用方会话的真实角色（v1.3 A1：superset 工具行的执行层硬闸数据源）。
   * 账本绑定优先（任务会话=其角色）；Router 会话登记其次；都没有 → undefined
   * （工具层按 worker 最严兜底）。
   */
  const callerRoleOf = async (sessionId: string): Promise<RoleKind | undefined> => {
    const record = await taskBySession(sessionId)
    if (record !== undefined) return record.role
    if (ui.routerSessions().some((entry) => entry.sessionId === sessionId)) return 'router'
    return undefined
  }

  /** Router 会话所在 workspace（sessionIds 成员扫描；registry 是同步投影）。 */
  const workspaceOfSession = (sessionId: string): WorkspaceInfo | undefined =>
    hosts.workspaceRegistry.list().find((workspace) => workspace.sessionIds?.includes(sessionId))

  /** 派发后的公共收尾：打标、加标签、刷快照。 */
  const afterDispatch = async (record: TaskRecord, sessionId: string | undefined, workspaceId: string | undefined): Promise<void> => {
    if (sessionId !== undefined) {
      driver.onDispatched(sessionId)
      if (workspaceId !== undefined && !workspaceId.startsWith('cwd:')) {
        await ui.addTab(workspaceId, sessionId, record.id)
      }
    }
    await refreshSnapshot()
  }

  let snapshotCache = ''

  /**
   * 同一任务的派发/重派串行化锁（评审修复：并发补充同一任务时，后到者在锁内
   * 重新过闸门，不破封顶、不重复派发）。JS 单线程下按 taskId 链式排队即可。
   */
  const taskLocks = new Map<string, Promise<unknown>>()
  const withTaskLock = async <T>(taskId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = taskLocks.get(taskId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    taskLocks.set(taskId, run.then(() => undefined, () => undefined))
    return run
  }

  /** 任务的依赖是否全部 completed（重派闸门：未满足的 queued 任务只升版等解锁）。 */
  const depsSatisfied = async (taskId: string): Promise<boolean> => {
    const task = ledger.get(taskId)
    if (task === undefined) return false
    if (task.dependsOn.length === 0) return true
    const all = await ledger.listAll()
    const byId = new Map(all.map((entry) => [entry.id, entry]))
    return task.dependsOn.every((depId) => byId.get(depId)?.status === 'completed')
  }

  /**
   * 执行类工具（report_progress/complete_task/report_blocker）的归属复核：
   * 调用方必须是任务绑定的会话（纵深防御——assertCallerRole 已在工具层查过
   * 一次，这里用核心的账本再拦一道）。
   */
  const mustOwn = (callerSessionId: string, taskId: string): TaskRecord => {
    const record = ledger.get(taskId)
    if (record === undefined) throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
    assertCallerRole(record.role, 'report_progress', callerSessionId, { get: (id) => ledger.get(id) }, taskId)
    return record
  }

  const refreshSnapshot = async (): Promise<void> => {
    const records = await ledger.listAll()
    snapshotCache = renderLedgerSnapshot(records, {
      maxCards: deps.maxActiveCards ?? 12,
      openQuestions: await waitingCounts(),
    })
  }

  /** 记账时钟（熔断事件时间戳；缺省 Date.now）。 */
  const now = deps.now ?? (() => Date.now())

  /** 熔断冻结拒绝的统一文案（规格 §2：明确告知停止重试并向用户报告）。 */
  const frozenRejection = (reason: string | undefined): LedgerError =>
    new LedgerError('dispatch-frozen', `派发已冻结（${reason ?? '原因未记录'}）：请停止重试并向用户报告`)

  /** 熔断冻结时一切派发被拦（dispatch_task / create_worker_type 共用入口检查）。 */
  const assertDispatchOpen = async (): Promise<void> => {
    if (deps.breaker === undefined) return
    const state = await deps.breaker.state()
    if (state.frozen) throw frozenRejection(state.reason)
  }

  /**
   * 当前启用类型的实时清单：类型存储在册时用它的同步投影（WorkerTypeStore 在
   * 启动装载后维护），缺席退回 v1 Config 模板（降级兼容）。
   */
  const enabledTemplates = (): WorkerTemplate[] => (deps.types !== undefined ? deps.types.enabled() : [...config.templates])

  const core: RouterCore = {
    enabledTemplates,

    listWorkerTypes() {
      // 与 workbench.state 的 types 投影同源：存储在册用摘要，缺席从 config 推导。
      return deps.types !== undefined
        ? deps.types.summaries()
        : config.templates.map((template) => ({ ...template, enabled: true, origin: 'user' as const }))
    },

    async createWorkerType(callerSessionId, input) {
      void callerSessionId // 创建不依赖调用方任务归属；角色由工具白名单保证（router 专属）
      await assertDispatchOpen() // v1.2 规格 §2：冻结时 create_worker_type 同拦
      const face = deps.types
      if (face?.createRouterType === undefined) {
        throw new LedgerError('types-unavailable', '类型存储未接线（WorkerTypesFace.createRouterType 缺席），无法现场创建 worker 类型')
      }
      const { record, presetRegistered } = await face.createRouterType(input)
      // 输出全量键（v1.1 A3 lossless 门禁）：presetRegistered 恒在，注册失败不静默。
      return { templateId: record.templateId, presetRegistered }
    },

    async dispatchTask(callerSessionId, input) {
      await assertDispatchOpen() // v1.2 规格 §2：冻结时一切派发被拦
      assertTemplateUsable(input.templateId, enabledTemplates())
      const callerTask = await taskBySession(callerSessionId)
      const callerRole: RoleKind = callerTask?.role ?? 'router'
      const parentTaskId = input.parentTaskId
      const verdict = scheduler.dispatchGuard(
        { sessionIdRole: callerRole, parentTaskId, depth: parentTaskId !== undefined ? depthOf(ledger, parentTaskId) : 0 },
        { role: input.role, dependsOn: input.dependsOn?.map((ref) => ref.taskId) },
      )
      if (!verdict.ok) {
        throw new LedgerError(verdict.code, `派发被拒（${verdict.code}）：${dispatchRejectionText(verdict.code, callerRole)}`)
      }
      // v1.2 规格 §3 派发预算（两层，互不替代；per-task retry 的 v1.1 语义不动）：
      // 主管只受连续失败预算（成功子任务不设上限）；其余（Router）每轮 1 个任务，
      // 第二个必须先 ask_user 列计划与理由，用户确认后新轮重计。
      if (deps.budgets !== undefined) {
        if (callerRole === 'supervisor') {
          if (deps.budgets.supervisorFrozen(callerSessionId)) {
            throw new LedgerError(
              'supervisor-failure-budget',
              `连续 ${deps.budgets.snapshot(callerSessionId).consecutiveDispatchFailures} 次派发失败，你的派发已被冻结：请停止重试，调用 report_blocker 向用户报告阻塞`,
            )
          }
        } else {
          const budgetVerdict = deps.budgets.tryConsumeTaskDispatch(callerSessionId)
          if (!budgetVerdict.ok) {
            throw new LedgerError(
              budgetVerdict.code,
              `本轮（当前用户消息）已派发过 ${deps.budgets.snapshot(callerSessionId).taskLimitPerTurn} 个任务。要派第二个任务，请先调用 ask_user 列出计划与理由征得用户确认；确认后预算清零重计`,
            )
          }
        }
      }
      const workspace = workspaceOfSession(callerSessionId)
      const cwd = workspace?.path ?? callerTask?.cwd ?? process.cwd()
      const projectId = workspace?.id ?? `cwd:${cwd}`
      const record = await ledger.createTask({
        title: input.title,
        goal: input.goal,
        acceptance: input.acceptance,
        constraints: input.constraints ?? [],
        projectId,
        cwd,
        role: input.role,
        templateId: input.templateId,
        parentId: parentTaskId,
        // v1.4：记下派发者会话（宿主记，不靠模型自填的 parentId）——作用域紧急
        // 暂停据此圈定「当前 Router 派出的活 + 其下游子任务」。
        dispatchedBySessionId: callerSessionId,
        dependsOn: input.dependsOn?.map((ref) => ref.taskId) ?? [],
        acceptancePolicy: 'auto',
      })
      const docs = deps.docsFor(record.cwd)
      const book = renderTaskBook(record, { materials: input.materials, sourceRef: `router 会话 ${callerSessionId}` })
      const docPath = await docs.initTask(record, book)
      // v1.2 规格 §2 条件 b：创建进熔断计数（任务 ID 集合对窗口；完成清基准）。
      await deps.breaker?.recordCreation(record.id, now())
      try {
        // v1.3 A3：分叉来源 = 派发者会话（Router 或主管；fork 继承其历史/组合/模型）。
        // 子任务解锁/重派路径不传显式来源，由桥按父任务会话回溯。
        const { sessionId } = await bridge.dispatchTask(record.id, { forkFrom: callerSessionId })
        // 规格 §4「每次成功转交后执行一次上下文整理」对调用者会话同样成立：
        // dispatch_task 成功后给 Router（或主管）会话打 pendingCompaction，其自身
        // 的派发讨论段在 idle 后被压缩（裁定 5 顺延项的补齐）。
        deps.budgets?.recordDispatchSuccess(callerSessionId) // v1.2：成功清主管连败
        driver.onDispatched(callerSessionId)
        await afterDispatch(record, sessionId, workspace?.id)
        return { taskId: record.id, docPath, sessionId }
      } catch (error) {
        // 派发失败不留空壳（v1.1 规格 §2-4）：任务回 draft/queued、错误文本写
        // progress、retryCount+1；达上限自动 blocked 并通知 Router。v1.2：同时
        // 分类上报熔断、计入调用者的主管失败预算（infra/task 均计）。
        deps.budgets?.recordDispatchFailure(callerSessionId)
        const failed = await recordDispatchFailure(deps, ledger, record.id, record.title, error, callerSessionId)
        await refreshSnapshot()
        throw new LedgerError(
          'dispatch-failed',
          `任务 ${record.id} 派发失败（第 ${failed.retryCount} 次，任务保持${failed.status === 'blocked' ? 'blocked' : record.status}）: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },

    async supplementTask(callerSessionId, taskId, additions) {
      const record = ledger.get(taskId)
      if (record === undefined) throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
      if (isTerminal(record.status)) {
        throw new LedgerError('illegal-transition', `终态任务不可补充: ${taskId}（${record.status}）`)
      }
      const fromVersion = record.docVersion
      const newVersion = await ledger.supplement(taskId, additions)
      await deps.docsFor(record.cwd).supplement(taskId, fromVersion, additions)
      let delivered: { sessionId: string | undefined }
      try {
        delivered = await bridge.supplementTo(taskId)
      } catch (error) {
        const live = ledger.get(taskId)!
        // 首发未完成的任务（draft/queued）重投失败：与首发失败同口径记账——
        // retryCount 朝上限累计，达 3 自动 blocked；running 等任务照原样抛。
        if (live.sessionId !== undefined && (live.status === 'draft' || live.status === 'queued')) {
          deps.budgets?.recordDispatchFailure(callerSessionId) // v1.2：重投失败同口径计入失败预算
          const failed = await recordDispatchFailure(deps, ledger, taskId, live.title, error, callerSessionId)
          await refreshSnapshot()
          throw new LedgerError(
            'dispatch-failed',
            `任务 ${taskId} 重投失败（第 ${failed.retryCount} 次，任务保持${failed.status === 'blocked' ? 'blocked' : live.status}）: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        throw error
      }
      if (delivered.sessionId !== undefined) {
        deps.budgets?.recordDispatchSuccess(callerSessionId) // v1.2：重投成功清连败
        driver.onDispatched(delivered.sessionId)
        driver.onDispatched(callerSessionId)
        const live = ledger.get(taskId)!
        if (live.status === 'draft' || live.status === 'queued') {
          // 首发投递未完成的任务补投成功：走表边到 dispatched、驱动打标、挂标签，
          // 不留「有会话却停在 draft」的隐形任务（评审修复）。
          if (live.status === 'draft') await ledger.transition(taskId, 'queued')
          await ledger.transition(taskId, 'dispatched')
          const dispatched = ledger.get(taskId)!
          await afterDispatch(
            dispatched,
            delivered.sessionId,
            dispatched.projectId.startsWith('cwd:') ? undefined : dispatched.projectId,
          )
        }
      } else {
        // 任务还没有执行会话：锁内重新过闸门再决定是否重派（评审修复——闸门
        // 必须在锁内，并发补充时后到者看到的是前一次落定后的状态）。
        await withTaskLock(taskId, async () => {
          const live = ledger.get(taskId)!
          const dispatchable =
            live.sessionId === undefined
            && (live.status === 'draft' || live.status === 'queued')
            && (await depsSatisfied(taskId))
          if (!dispatchable) return // 依赖未满足 / 已封顶 / 已有会话：只升版，不派发
          try {
            const { sessionId } = await bridge.dispatchTask(taskId)
            deps.budgets?.recordDispatchSuccess(callerSessionId) // v1.2：重派成功清连败
            if (sessionId !== undefined) {
              driver.onDispatched(sessionId)
            }
            driver.onDispatched(callerSessionId)
            const dispatched = ledger.get(taskId)!
            await afterDispatch(
              dispatched,
              sessionId,
              dispatched.projectId.startsWith('cwd:') ? undefined : dispatched.projectId,
            )
          } catch (error) {
            deps.budgets?.recordDispatchFailure(callerSessionId) // v1.2：重派失败同口径计入失败预算
            const failed = await recordDispatchFailure(deps, ledger, taskId, live.title, error, callerSessionId)
            await refreshSnapshot()
            throw new LedgerError(
              'dispatch-failed',
              `任务 ${taskId} 重派失败（第 ${failed.retryCount} 次，任务保持${failed.status === 'blocked' ? 'blocked' : live.status}）: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        })
      }
      await refreshSnapshot()
      return { docVersion: newVersion }
    },

    async queryTasks(filter, viewerSessionId) {
      const records = await ledger.listAll()
      const counts = await waitingCounts()
      let cards = records.map((record) => toCard(record, counts[record.id] ?? 0))
      if (filter?.status !== undefined && filter.status.length > 0) {
        const wanted = new Set<TaskStatus>(filter.status)
        cards = cards.filter((card) => wanted.has(card.status))
      }
      if (filter?.taskId !== undefined) cards = cards.filter((card) => card.taskId === filter.taskId)
      // v1.2 规格 §3：预算状态对模型可见——viewer 的预算快照 + 全局熔断冻结态。
      // 可选键只在有值时进返回对象（undefined 值的键会被 JSON 序列化静默蒸发，
      // v1.1 Task A3 lossless 门禁）。
      const result: { tasks: TaskCard[]; budgets?: BudgetSnapshot; breaker?: BreakerVisibility } = { tasks: cards }
      if (deps.budgets !== undefined && viewerSessionId !== undefined) {
        result.budgets = deps.budgets.snapshot(viewerSessionId)
      }
      if (deps.breaker !== undefined) {
        result.breaker = await breakerView(deps.breaker)
      }
      return result
    },

    async controlTask(callerSessionId, taskId, action) {
      const record = ledger.get(taskId)
      if (record === undefined) throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
      if (action === 'pause') {
        await ledger.transition(taskId, 'paused')
        if (record.sessionId !== undefined) {
          await bridge.notify(record.sessionId, `pause-${taskId}`, `任务 ${taskId}「${record.title}」已暂停。请停止推进，等待恢复指示；不要提交完成。`)
        }
      } else if (action === 'resume') {
        await ledger.transition(taskId, 'running')
        if (record.sessionId !== undefined) {
          await bridge.notify(record.sessionId, `resume-${taskId}`, `任务 ${taskId}「${record.title}」已恢复，请继续按任务书当前版本推进。`)
        }
      } else {
        await ledger.cancel(taskId, `cancelled by ${callerSessionId}`)
        await bridge.notifyCancel(taskId)
      }
      await refreshSnapshot()
      return { status: ledger.get(taskId)?.status ?? record.status }
    },

    async searchHistory(_callerSessionId, query, scope) {
      if (deps.memory === undefined) {
        return { hits: [], note: '记忆服务未配置' }
      }
      try {
        return { hits: await deps.memory.search(query, scope) }
      } catch (error) {
        // 检索失败对模型诚实降级（空命中+注记），不让一次磁盘故障变成工具报错
        deps.logger?.warn(`记忆检索失败: ${error instanceof Error ? error.message : String(error)}`)
        return { hits: [], note: '记忆检索失败' }
      }
    },

    async reportProgress(callerSessionId, taskId, progress) {
      const record = mustOwn(callerSessionId, taskId)
      await ledger.updateProgress(taskId, progress)
      await deps.docsFor(record.cwd).writeProgress(taskId, progress)
      await refreshSnapshot()
      return { ok: true as const }
    },

    async completeTask(callerSessionId, taskId, input) {
      const record = mustOwn(callerSessionId, taskId)
      // 账本方法返回活引用：record.status 会在 complete 后被原地改写，
      // 「是否首次完成」必须在调用前取证。
      const wasTerminal = isTerminal(record.status)
      const completed = await ledger.complete(taskId, {
        docVersion: input.docVersion,
        summary: input.summary,
        deliverables: input.deliverables,
        acceptanceEvidence: input.acceptanceEvidence,
        openIssues: input.leftovers,
        ...(input.deliveryOrigin !== undefined ? { deliveryOrigin: input.deliveryOrigin } : {}),
      })
      if (completed.result !== undefined) {
        await deps.docsFor(record.cwd).writeResult(taskId, completed.result)
      }
      let pendingFrom: 'supervisor' | 'user' | undefined
      if (completed.status === 'review-pending') {
        pendingFrom = completed.acceptancePolicy === 'user' ? 'user' : 'supervisor'
      }
      if (completed.status === 'completed' && !wasTerminal) {
        // 首次完成（幂等重提不重复广播）：熔断创建基准清除（v1.2 B1）+ 记忆触发
        // + 通知上级 + 解锁依赖自动派发
        await deps.breaker?.recordCompletion(taskId, now())
        // v1.3 C1：完成卡摘要可选带「首请求缓存命中 X tok」——已上报才带
        //（未上报不出现该行，不动既有卡结构语义）。
        const cacheLine = completed.firstRequestCacheReadTokens !== undefined
          ? `\n首请求缓存命中 ${completed.firstRequestCacheReadTokens} tok`
          : ''
        await deps.notifications?.push({
          kind: 'completion',
          taskId,
          title: record.title,
          summary: `${input.summary}${cacheLine}`,
          actions: completionActions(),
          deliveryOrigin: input.deliveryOrigin ?? 'worker',
        })
        deps.memory?.onTaskCompleted({
          taskId,
          title: record.title,
          summary: input.summary,
          resultRelPath: `${deps.tasksDir ?? '.router'}/tasks/${taskId}/result.md`,
          sessionId: record.sessionId,
        })
        const parent = completed.parentId !== undefined ? ledger.get(completed.parentId) : undefined
        if (parent?.sessionId !== undefined && parent.sessionId !== callerSessionId) {
          await bridge.notify(parent.sessionId, `notice-${taskId}-completed`, `子任务 ${taskId}「${record.title}」已完成：${input.summary}`)
        }
        const unlocked = await scheduler.onCompleted(taskId)
        for (const nextTask of unlocked) {
          try {
            // 与 supplement 重派共用同一把任务锁：并发补充/解锁不重复派发
            await withTaskLock(nextTask.id, async () => {
              const delivered = await bridge.dispatchTask(nextTask.id)
              const workspace = nextTask.projectId.startsWith('cwd:') ? undefined : nextTask.projectId
              await afterDispatch(nextTask, delivered.sessionId, workspace)
            })
          } catch (error) {
            // 单个解锁任务的派发失败不拖垮完成本身：失败记账（retryCount 累计、
            // 达上限自动 blocked 并通知 Router），任务保持 queued 等下次解锁重试。
            await recordDispatchFailure(deps, ledger, nextTask.id, nextTask.title, error, ui.routerSessions()[0]?.sessionId)
            await refreshSnapshot()
            deps.logger?.warn(`任务 ${nextTask.id} 解锁后派发失败（retryCount=${ledger.get(nextTask.id)?.retryCount}）: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      await refreshSnapshot()
      // pendingFrom 只在待验收时进输出：undefined 值的键会被 JSON 序列化蒸发
      //（v1.1 Task A3 lossless 门禁）。
      return pendingFrom !== undefined
        ? { accepted: completed.status === 'completed', status: completed.status, pendingFrom }
        : { accepted: completed.status === 'completed', status: completed.status }
    },

    async reportBlocker(callerSessionId, taskId, reason) {
      mustOwn(callerSessionId, taskId)
      const blocked = ledger.get(taskId)
      await ledger.reportBlocker(taskId, reason)
      await deps.notifications?.push({
        kind: 'anomaly',
        taskId,
        title: blocked?.title ?? taskId,
        summary: reason,
        actions: anomalyActions(),
      })
      await refreshSnapshot()
      return { status: 'blocked' as const }
    },

    getTask(taskId: string): TaskRecord | undefined {
      return ledger.get(taskId)
    },

    /**
     * 作用域紧急暂停（v1.4）：只停「该 Router 会话派出的任务 + 其下游子任务」。
     * 不碰全局熔断、不留任何全局标记、之后的新派发不受影响、别的 Router 会话
     * 不受影响。派发树按宿主记的派发者会话闭包（见 guard/emergency.ts）。
     */
    async scopedPause(routerSessionId: string) {
      // 只认已登记的 Router 会话：防止拿任意会话 id 圈出不属于它的范围。
      if (!ui.routerSessions().some((entry) => entry.sessionId === routerSessionId)) {
        throw new LedgerError('bad-request', `不是已登记的 Router 会话: ${routerSessionId}`)
      }
      const report = await runScopedPause(
        {
          targets: async () => scopedPauseTargets(await ledger.listAll(), routerSessionId),
          markPaused: async (taskId) => {
            await ledger.transition(taskId, 'paused')
          },
          interrupt: (sessionIds) => bridge.interruptTaskSessions(sessionIds),
          notifyTask: async (input) =>
            deps.notifications?.push({
              kind: 'anomaly',
              taskId: input.taskId,
              title: input.title,
              summary: input.summary,
              actions: pausedActions(),
            }),
          notifyRouter: async (sessionId, text) => {
            await bridge.notify(sessionId, `scoped-pause-${sessionId}`, text)
          },
          logger: deps.logger,
        },
        routerSessionId,
      )
      await refreshSnapshot()
      return report
    },

    callerRoleOf,
  }

  const workbench: RouterWorkbench = {
    async state(workspaceId) {
      const records = await ledger.listAll()
      const counts = await waitingCounts()
      const bySession = new Map(records.filter((r) => r.sessionId !== undefined).map((r) => [r.sessionId as string, r]))
      const byId = new Map(records.map((record) => [record.id, record]))
      const tabRows = workspaceId !== undefined ? ui.tabs(workspaceId) : ui.allTabs()
      const notificationCards = await deps.notifications?.pending() ?? []
      return {
        routerSessions: ui.routerSessions(),
        tasks: records.map((record) => toCard(record, counts[record.id] ?? 0)),
        questions: relay.pendingCards(),
        // 空壳清理（v1.1 规格 §3.7）：指向「cancelled/failed 且无会话」任务的
        // 标签行移出投影；store 里的落盘行与账本记录都不动（Review Focus 5）。
        tabs: tabRows
          .filter((row) => !isHuskTask(row.taskId !== undefined ? byId.get(row.taskId) : undefined))
          .map((row) => {
            const taskRecord = bySession.get(row.sessionId)
            return {
              sessionId: row.sessionId,
              title: taskRecord !== undefined ? `${taskRecord.id} ${taskRecord.title}` : row.sessionId,
              taskId: taskRecord?.id ?? row.taskId,
              taskStatus: taskRecord?.status,
              running: deps.isRunning(row.sessionId),
            }
          }),
        templates: enabledTemplates(),
        types: deps.types !== undefined
          ? deps.types.summaries()
          : config.templates.map((template) => ({ ...template, enabled: true, origin: 'user' as const })),
        // v1.4：把真实熔断态投影进 RouterState——界面据此显示「解除冻结」。
        // （历史上界面靠「有没有带 unfreeze 动作的卡」推断，而没有任何代码路径
        // 产出那种卡，于是用户永远看不到「解除冻结」，被旧版紧急暂停的全局
        // 冻结标记永久锁死。）
        ...(deps.breaker !== undefined ? { breaker: await breakerView(deps.breaker) } : {}),
        ...(notificationCards.length > 0 ? { notifications: notificationCards } : {}),
      }
    },

    async createRouterSession(workspaceId, name) {
      const title = name ?? 'Router'
      const created = await hosts.sessionController.create(
        { workspaceId, agentPreset: config.routerPreset },
        deps.signal,
      )
      // 规格 §6：Router 默认模型来自设置——经宿主 selectModel（UI 同通路）钉进
      // 本会话；缺席/为空/失败都不挡创建（会话保持宿主默认路由）。
      const defaults = await deps.routerDefaults?.get()
      const ref = defaults?.routerModel ?? ''
      const parsed = ref !== '' ? parseModelRef(ref) : undefined
      if (parsed !== undefined && hosts.sessionController.selectModel !== undefined) {
        try {
          await hosts.sessionController.selectModel(
            { sessionId: created.sessionId, provider: parsed.provider, model: parsed.model },
            deps.signal,
          )
        } catch (error) {
          deps.logger?.warn(`Router 会话默认模型钉定失败（保持宿主默认路由）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await hosts.sessionController.rename({ sessionId: created.sessionId, title }, deps.signal)
      await ui.addRouterSession(created.sessionId, workspaceId, title)
      return { sessionId: created.sessionId }
    },

    async answerQuestion(questionId, answers) {
      await relay.answerQuestion(questionId, answers)
    },

    async closeTab(workspaceId, sessionId) {
      return ui.removeTab(workspaceId, sessionId)
    },

    pendingQuestions(): QuestionCard[] {
      return relay.pendingCards()
    },
  }

  return {
    core,
    workbench,
    snapshotText: () => snapshotCache,
    refreshSnapshot,
    recoverOrphans: () => relay.recoverOrphans(),
  }
}

/** 派发拒绝的补充说明（给模型看得懂的下一步）。 */
function dispatchRejectionText(code: 'depth-exceeded' | 'role-forbidden' | 'cycle-risk', callerRole: RoleKind): string {
  if (code === 'role-forbidden' && callerRole === 'worker') return '工作型角色无权派发任务'
  if (code === 'role-forbidden') return '主管之下只能派 worker 或子代理，不能再派主管（v1.1 规格 §3.4 禁主管链）'
  if (code === 'depth-exceeded') return '超过最大递归深度，请把工作合并进当前任务或改派 supervisor'
  return '依赖命中了自身的祖先任务（环），请换依赖对象'
}
