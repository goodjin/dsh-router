/**
 * 问答桥（计划 Task B4）。
 *
 * worker/主管会话经宿主 ask_user 工具发起的提问，在 user-questions/request
 * 瀑布上被这里认领：生成 questionId、park 一个 deferred、账本落 open 记录、
 * 挂进 pending 列表等用户经 Router 界面应答。不在册会话（含 Router 自己）
 * 一律 next() 放行给后续监听者（客户端兜底 UI）。
 *
 * 宿主重启后内存里的 deferred 全部丢失：账本里遗留的 open 记录就是孤儿，
 * recoverOrphans() 把它们过期并把仍在执行的任务标 blocked。
 */

import { isTerminal, type TaskRecord } from '../../shared/types.ts'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, QuestionCard } from '../../shared/view-contract.ts'
import { canTransition } from '../ledger/machine.ts'
import { LedgerError } from '../ledger/errors.ts'
import type { TaskLedger } from '../ledger/store.ts'
import { callerSessionId } from '../tools/index.ts'

/** 瀑布请求的最小面（agent 字段交给 callerSessionId 映射）。 */
export interface ClaimRequest {
  questions: AskUserQuestionItem[]
  agent?: unknown
  signal?: AbortSignal
}

/** 在册查找用：会话 → 任务。 */
export interface SessionTaskIndex {
  listAll(): Promise<TaskRecord[]>
  get(taskId: string): TaskRecord | undefined
}

export interface AnswerRelayDeps {
  ledger: SessionTaskIndex & Pick<TaskLedger, 'addQuestion' | 'settleQuestion' | 'openQuestions' | 'findQuestion' | 'reportBlocker'>
  /** 问题 ID 生成器（宿主装配用 uuid；测试注入计数器）。 */
  newId(): string
  now(): number
}

interface ParkedQuestion {
  questionId: string
  taskId: string | undefined
  sessionId: string
  questions: AskUserQuestionItem[]
  receivedAt: number
  resolve(answer: { answers: AskUserQuestionAnswerItem[] }): void
  reject(reason: unknown): void
}

/** 问答桥：认领、park、应答、孤儿恢复。 */
export class AnswerRelay {
  private parked = new Map<string, ParkedQuestion>()
  private ledger: AnswerRelayDeps['ledger']
  private newId: () => string
  private now: () => number

  constructor(deps: AnswerRelayDeps) {
    this.ledger = deps.ledger
    this.newId = deps.newId
    this.now = deps.now
  }

  /** 按会话 ID 找在册任务（worker/主管会话才有任务绑定）。 */
  private async taskBySession(sessionId: string): Promise<TaskRecord | undefined> {
    const records = await this.ledger.listAll()
    return records.find((t) => t.sessionId === sessionId)
  }

  /**
   * user-questions/request 瀑布监听器：认领返回答案即否决链上其余人，
   * 放行调 next()。仅认领在册 worker/主管会话的问题；Router 会话一律放行。
   */
  async claimQuestion(request: ClaimRequest, next: () => Promise<unknown>): Promise<unknown> {
    let sessionId: string
    try {
      sessionId = callerSessionId(request)
    } catch {
      return next() // 没有 agent 的全局请求不是会话提问，放行
    }
    const taskRecord = await this.taskBySession(sessionId)
    if (taskRecord === undefined || taskRecord.role === 'router') return next()
    return this.park(taskRecord, sessionId, request)
  }

  /** 认领：park deferred、落 open 记录、挂 pending，等 answerQuestion 或中止。 */
  private async park(
    taskRecord: TaskRecord,
    sessionId: string,
    request: ClaimRequest,
  ): Promise<{ answers: AskUserQuestionAnswerItem[] }> {
    const questionId = this.newId()
    const receivedAt = this.now()
    const parked: ParkedQuestion = {
      questionId,
      taskId: taskRecord.id,
      sessionId,
      questions: request.questions,
      receivedAt,
      resolve: () => {},
      reject: () => {},
    }
    const gate = new Promise<{ answers: AskUserQuestionAnswerItem[] }>((resolve, reject) => {
      parked.resolve = resolve
      parked.reject = reject
    })
    this.parked.set(questionId, parked)
    const summary =
      request.questions.length > 1
        ? `${request.questions[0]?.question ?? ''} 等 ${request.questions.length} 个问题`
        : request.questions[0]?.question ?? ''
    await this.ledger.addQuestion({
      id: questionId,
      taskId: taskRecord.id,
      question: summary,
      status: 'open',
      createdAt: receivedAt,
    })
    request.signal?.addEventListener(
      'abort',
      () => {
        if (!this.parked.has(questionId)) return
        this.parked.delete(questionId)
        parked.reject(new LedgerError('question-cancelled', `问题已被中止: ${questionId}`))
        void this.ledger.settleQuestion(questionId, 'expired', '问题被中止')
      },
      { once: true },
    )
    return gate
  }

  /** 当前待答问题（Router 界面浮窗与 GET /router/state 的数据源）。 */
  pendingCards(): QuestionCard[] {
    return [...this.parked.values()]
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .map((parked) => {
        const taskRecord = parked.taskId !== undefined ? this.ledger.get(parked.taskId) : undefined
        return {
          questionId: parked.questionId,
          taskId: parked.taskId,
          taskTitle: taskRecord?.title,
          sessionId: parked.sessionId,
          sessionTitle: taskRecord !== undefined ? `${taskRecord.id} ${taskRecord.title}` : undefined,
          questions: parked.questions,
          receivedAt: parked.receivedAt,
        }
      })
  }

  /**
   * 用户应答：先落账本（失败则 worker 继续等待、用户可重试），后放行 deferred。
   * 已答（409 语义）与不存在（404 语义）分别抛 already-answered / question-not-found。
   */
  async answerQuestion(questionId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
    const parked = this.parked.get(questionId)
    if (parked !== undefined) {
      await this.ledger.settleQuestion(questionId, 'answered', JSON.stringify(answers))
      this.parked.delete(questionId)
      parked.resolve({ answers })
      return
    }
    const record = await this.ledger.findQuestion(questionId)
    if (record === undefined || record.status === 'expired') {
      throw new LedgerError('question-not-found', `问题不存在或已失效: ${questionId}`)
    }
    throw new LedgerError('already-answered', `问题已应答，拒绝重复: ${questionId}`)
  }

  /**
   * 重启孤儿恢复：账本里遗留的 open 记录对应的 deferred 已随进程消失。
   * 仍在执行（状态机允许）的任务标 blocked；问题记录一律过期。
   */
  async recoverOrphans(): Promise<string[]> {
    const open = await this.ledger.openQuestions()
    const recovered: string[] = []
    for (const record of open) {
      const taskRecord = record.taskId !== undefined ? this.ledger.get(record.taskId) : undefined
      if (
        taskRecord !== undefined
        && !isTerminal(taskRecord.status)
        && canTransition(taskRecord.status, 'blocked')
      ) {
        await this.ledger.reportBlocker(taskRecord.id, `宿主重启，待答问题中断，任务标为受阻（原问题：${record.question}）`)
      }
      await this.ledger.settleQuestion(record.id, 'expired', '宿主重启，问题失效')
      recovered.push(record.id)
    }
    return recovered
  }
}
