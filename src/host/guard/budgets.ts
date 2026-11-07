/**
 * 派发预算 DispatchBudgets（v1.2 规格 §3，计划 Task B2 接口逐字）。
 *
 * 以「轮次」近似「用户消息」边界：会话 running→true 即新轮（entry 把
 * bridge.watchStatus 的该沿映射到 onTurnStart；ask_user 的回答开启新轮，预算
 * 自然重计）。三个独立层面，互不替代：
 *   - Router 会话每轮 1 个任务（硬限）——第二个任务必须先 ask_user 列出计划与
 *     理由，用户确认后该消息的预算清零重计（确认视为新指令）；
 *   - Router 会话每轮 1 批澄清提问（与任务预算共享确认语义）——第二批在认领
 *     层自动回「请合并为一批重问」（questions.ts 消费）；
 *   - 主管失败预算：连续 3 次派发失败（infra 或 task 均计）→ 该主管的派发冻结
 *     （supervisorFrozen，错误码 supervisor-failure-budget 指明 report_blocker
 *     出路）；成功派发或新轮解除。成功子任务不设上限（任务需求各异）。
 *
 * v1.1 的 per-task retry（3 次自动 blocked）是任务层预算，与本类无涉。
 */

/** Router 每轮任务数硬限（规格 §3：最多 1 个）。 */
export const DEFAULT_TASKS_PER_TURN = 1
/** Router 每轮提问批次数（规格 §3：1 批）。 */
export const DEFAULT_QUESTION_BATCHES_PER_TURN = 1
/** 主管连续失败冻结阈值（规格 §3：3 次）。 */
export const DEFAULT_SUPERVISOR_FAILURE_LIMIT = 3

/** 预算可见投影（query_tasks.budgets 的数据源；键全定义，过 lossless）。 */
export interface BudgetSnapshot {
  taskDispatchesThisTurn: number
  taskLimitPerTurn: number
  questionBatchesThisTurn: number
  questionLimitPerTurn: number
  consecutiveDispatchFailures: number
  supervisorFailureLimit: number
  supervisorFrozen: boolean
}

export interface DispatchBudgetsDeps {
  /** 每轮任务数上限（缺省 1）。 */
  maxTasksPerTurn?: number
  /** 每轮提问批次数上限（缺省 1）。 */
  maxQuestionBatchesPerTurn?: number
  /** 主管连续失败冻结阈值（缺省 3）。 */
  supervisorFailureLimit?: number
}

interface TurnState {
  taskDispatches: number
  questionBatches: number
}

interface FailureState {
  consecutiveFailures: number
  frozen: boolean
}

export class DispatchBudgets {
  private turns = new Map<string, TurnState>()
  private failures = new Map<string, FailureState>()
  private maxTasksPerTurn: number
  private maxQuestionBatchesPerTurn: number
  private supervisorFailureLimit: number

  constructor(deps: DispatchBudgetsDeps = {}) {
    this.maxTasksPerTurn =
      typeof deps.maxTasksPerTurn === 'number' && deps.maxTasksPerTurn >= 1 ? Math.floor(deps.maxTasksPerTurn) : DEFAULT_TASKS_PER_TURN
    this.maxQuestionBatchesPerTurn =
      typeof deps.maxQuestionBatchesPerTurn === 'number' && deps.maxQuestionBatchesPerTurn >= 1
        ? Math.floor(deps.maxQuestionBatchesPerTurn)
        : DEFAULT_QUESTION_BATCHES_PER_TURN
    this.supervisorFailureLimit =
      typeof deps.supervisorFailureLimit === 'number' && deps.supervisorFailureLimit >= 1
        ? Math.floor(deps.supervisorFailureLimit)
        : DEFAULT_SUPERVISOR_FAILURE_LIMIT
  }

  /** 新轮开始（running→true 沿；ask_user 的回答开启新轮）：清该会话全部轮态与失败连计。 */
  onTurnStart(sessionId: string): void {
    this.turns.delete(sessionId)
    this.failures.delete(sessionId)
  }

  /** 每轮任务预算：ok=false 时错误码 per-turn-task-budget（出路：先 ask_user 确认）。 */
  tryConsumeTaskDispatch(sessionId: string): { ok: true } | { ok: false; code: 'per-turn-task-budget' } {
    const turn = this.turns.get(sessionId) ?? { taskDispatches: 0, questionBatches: 0 }
    if (turn.taskDispatches >= this.maxTasksPerTurn) return { ok: false, code: 'per-turn-task-budget' }
    turn.taskDispatches += 1
    this.turns.set(sessionId, turn)
    return { ok: true }
  }

  /** 每轮提问批次预算：ok=false 时错误码 per-turn-question-budget（认领层自动回「请合并为一批重问」）。 */
  tryConsumeQuestionBatch(sessionId: string): { ok: true } | { ok: false; code: 'per-turn-question-budget' } {
    const turn = this.turns.get(sessionId) ?? { taskDispatches: 0, questionBatches: 0 }
    if (turn.questionBatches >= this.maxQuestionBatchesPerTurn) return { ok: false, code: 'per-turn-question-budget' }
    turn.questionBatches += 1
    this.turns.set(sessionId, turn)
    return { ok: true }
  }

  /** 记一次派发失败（infra 或 task 均计）；连续达阈值 → 该主管派发冻结。 */
  recordDispatchFailure(sessionId: string): void {
    const state = this.failures.get(sessionId) ?? { consecutiveFailures: 0, frozen: false }
    state.consecutiveFailures += 1
    if (state.consecutiveFailures >= this.supervisorFailureLimit) state.frozen = true
    this.failures.set(sessionId, state)
  }

  /** 记一次派发成功：连败清零、解除冻结（成功子任务不设上限）。 */
  recordDispatchSuccess(sessionId: string): void {
    this.failures.set(sessionId, { consecutiveFailures: 0, frozen: false })
  }

  /** 该会话的派发是否因连续失败被冻结。 */
  supervisorFrozen(sessionId: string): boolean {
    return this.failures.get(sessionId)?.frozen ?? false
  }

  /** 模型可见投影（query_tasks.budgets；键全定义）。 */
  snapshot(sessionId: string): BudgetSnapshot {
    const turn = this.turns.get(sessionId) ?? { taskDispatches: 0, questionBatches: 0 }
    const failure = this.failures.get(sessionId) ?? { consecutiveFailures: 0, frozen: false }
    return {
      taskDispatchesThisTurn: turn.taskDispatches,
      taskLimitPerTurn: this.maxTasksPerTurn,
      questionBatchesThisTurn: turn.questionBatches,
      questionLimitPerTurn: this.maxQuestionBatchesPerTurn,
      consecutiveDispatchFailures: failure.consecutiveFailures,
      supervisorFailureLimit: this.supervisorFailureLimit,
      supervisorFrozen: failure.frozen,
    }
  }
}
