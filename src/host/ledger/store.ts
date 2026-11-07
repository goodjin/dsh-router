/**
 * 任务账本 TaskLedger（计划 Task 2）。
 *
 * 所有写操作走同一条路：先内存校验（校验失败直接抛，不碰状态、不触发保存），
 * 再变更内存、一次性 save；save 失败把内存回滚到变更前并抛
 * LedgerError('persistence-failed')。持久化经注入的 LedgerPersistence，领域
 * 核心零宿主依赖；时间经注入的 clock，保证可测。
 */

import { isTerminal } from '../../shared/types.ts'
import type { QuestionRecord, TaskRecord, TaskResult } from '../../shared/types.ts'
import { LedgerError } from './errors.ts'
import { assertTransition } from './machine.ts'

/** 任务状态（转载自共享类型，账本消费方一处可取）。 */
export type { TaskStatus } from '../../shared/types.ts'
import type { TaskStatus } from '../../shared/types.ts'

/** 持久化适配器：账本 IO 的唯一出口（测试用内存实现，宿主侧 Part B 给文件实现）。 */
export interface LedgerPersistence {
  load(): Promise<LedgerFile | null>
  save(f: LedgerFile): Promise<void>
}

/** 账本落盘形状：schemaVersion 升级时按版本迁移。 */
export interface LedgerFile {
  schemaVersion: 1
  tasks: TaskRecord[]
  nextTaskNumber: number
  questions: QuestionRecord[]
}

/** createTask 入参（ID 由账本分配，不由调用方指定）。 */
export interface NewTaskInput {
  title: string
  goal: string
  acceptance?: string[]
  constraints?: string[]
  projectId: string
  cwd: string
  role: TaskRecord['role']
  templateId?: string
  parentId?: string
  /** 依赖任务 ID；允许前向引用尚未创建的任务（环检测在创建时把关）。 */
  dependsOn?: string[]
  /** 默认 'auto'。 */
  acceptancePolicy?: TaskRecord['acceptancePolicy']
}

/** complete 提交入参：执行版本必须等于当前 docVersion（旧 worker 迟到提交拒绝）。 */
export interface TaskResultInput {
  docVersion: number
  summary: string
  docRef?: string
  deliverables?: string[]
  acceptanceEvidence?: string
  openIssues?: string[]
}

/** ID 格式：T-%03d，项目内单调。 */
function formatTaskId(n: number): string {
  return `T-${String(n).padStart(3, '0')}`
}

/**
 * 在依赖图（含新建节点）上 DFS 找环，返回环路径（首尾同节点），无环返回 null。
 * 未创建的依赖 ID 没有出边，不参与成环。
 */
function findDependencyCycle(edges: Map<string, string[]>, start: string): string[] | null {
  const visiting = new Set<string>()
  const stack: string[] = []
  const visit = (node: string): string[] | null => {
    if (visiting.has(node)) {
      const from = stack.indexOf(node)
      return [...stack.slice(from), node]
    }
    visiting.add(node)
    stack.push(node)
    for (const dep of edges.get(node) ?? []) {
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    stack.pop()
    return null
  }
  return visit(start)
}

/** 任务账本：任务的内存权威状态 + 注入式持久化。 */
export class TaskLedger {
  private persistence: LedgerPersistence
  private clock: () => number
  private tasks: TaskRecord[] = []
  private nextTaskNumber = 1
  private questions: QuestionRecord[] = []
  private loaded = false

  constructor(persistence: LedgerPersistence, clock: () => number = Date.now) {
    this.persistence = persistence
    this.clock = clock
  }

  /** 首次访问时从持久化装载（构造函数保持同步）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    const file = await this.persistence.load()
    if (file) {
      this.tasks = structuredClone(file.tasks)
      this.nextTaskNumber = file.nextTaskNumber
      this.questions = file.questions ?? []
    }
    this.loaded = true
  }

  /** 当前状态的落盘快照（深拷贝，之后内存再变不影响这份）。 */
  private currentFile(): LedgerFile {
    return {
      schemaVersion: 1,
      tasks: structuredClone(this.tasks),
      nextTaskNumber: this.nextTaskNumber,
      questions: structuredClone(this.questions),
    }
  }

  /**
   * 写操作统一通道：备份 → 校验并变更内存（校验抛错则状态未动、不触发保存）
   * → 保存新状态 → 保存失败回滚内存并抛 persistence-failed。
   */
  private async commit<T>(mutate: () => T): Promise<T> {
    await this.ensureLoaded()
    const backupTasks = structuredClone(this.tasks)
    const backupNext = this.nextTaskNumber
    const backupQuestions = structuredClone(this.questions)
    const value = mutate()
    try {
      await this.persistence.save(this.currentFile())
    } catch (cause) {
      this.tasks = backupTasks
      this.nextTaskNumber = backupNext
      this.questions = backupQuestions
      throw new LedgerError('persistence-failed', `账本保存失败，内存已回滚: ${String(cause)}`, { cause })
    }
    return value
  }

  /** 取任务，不存在抛 task-not-found。 */
  private mustGet(id: string): TaskRecord {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) throw new LedgerError('task-not-found', `任务不存在: ${id}`)
    return task
  }

  /** 按创建序拿全量任务。 */
  async listAll(): Promise<TaskRecord[]> {
    await this.ensureLoaded()
    return [...this.tasks]
  }

  /** 按创建序拿未结束（非终态）任务。 */
  async listActive(): Promise<TaskRecord[]> {
    await this.ensureLoaded()
    return this.tasks.filter((t) => !isTerminal(t.status))
  }

  /** 同步读取任务（先任意 await 过一次账本方法再调用，保证已装载）。 */
  get(id: string): TaskRecord | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  /** 创建任务：分配单调 ID、依赖图查环；依赖未满足落 queued，否则 draft。 */
  async createTask(input: NewTaskInput): Promise<TaskRecord> {
    await this.ensureLoaded()
    const id = formatTaskId(this.nextTaskNumber)
    const dependsOn = input.dependsOn ?? []
    const edges = new Map<string, string[]>(this.tasks.map((t) => [t.id, t.dependsOn]))
    edges.set(id, dependsOn)
    const cycle = findDependencyCycle(edges, id)
    if (cycle) {
      throw new LedgerError('dependency-cycle', `依赖环: ${cycle.join(' → ')}`)
    }
    const depsSatisfied = dependsOn.every((depId) => {
      const dep = this.tasks.find((t) => t.id === depId)
      return dep !== undefined && dep.status === 'completed'
    })
    const now = this.clock()
    const record: TaskRecord = {
      id,
      title: input.title,
      goal: input.goal,
      acceptance: input.acceptance ?? [],
      constraints: input.constraints ?? [],
      projectId: input.projectId,
      cwd: input.cwd,
      role: input.role,
      templateId: input.templateId,
      parentId: input.parentId,
      dependsOn,
      status: depsSatisfied ? 'draft' : 'queued',
      docVersion: 1,
      retryCount: 0,
      acceptancePolicy: input.acceptancePolicy ?? 'auto',
      createdAt: now,
      updatedAt: now,
    }
    return this.commit(() => {
      this.tasks.push(record)
      this.nextTaskNumber += 1
      return record
    })
  }

  /**
   * 状态迁移：照状态机表校验，非法抛 illegal-transition。
   * reason 仅为调用侧审计保留，账本内不落独立字段。
   */
  async transition(id: string, to: TaskStatus, reason?: string): Promise<TaskRecord> {
    void reason
    return this.commit(() => {
      const task = this.mustGet(id)
      assertTransition(task.status, to)
      task.status = to
      task.updatedAt = this.clock()
      return task
    })
  }

  /** 绑定 worker 会话（默认一个任务一个会话）。 */
  async attachSession(id: string, sessionId: string): Promise<TaskRecord> {
    return this.commit(() => {
      const task = this.mustGet(id)
      task.sessionId = sessionId
      task.updatedAt = this.clock()
      return task
    })
  }

  /** 更新一句话进度（worker 汇报）。 */
  async updateProgress(id: string, text: string): Promise<TaskRecord> {
    return this.commit(() => {
      const task = this.mustGet(id)
      task.progress = text
      task.updatedAt = this.clock()
      return task
    })
  }

  /** 补充约束：docVersion+1、约束追加（活动短卡的「最新补充约束」来源）。 */
  async supplement(id: string, additions: string[]): Promise<number> {
    return this.commit(() => {
      const task = this.mustGet(id)
      if (isTerminal(task.status)) {
        throw new LedgerError('illegal-transition', `终态任务不可补充: ${task.id}（${task.status}）`)
      }
      task.docVersion += 1
      task.constraints.push(...additions)
      task.updatedAt = this.clock()
      return task.docVersion
    })
  }

  /**
   * 完成申请。校验：调用版本必须等于当前 docVersion（否则 stale-version）。
   * 幂等：completed / review-pending 上同版本重复提交返回首次记录，不落盘。
   * 策略：auto 且无未结子任务 → completed；否则 → review-pending。
   */
  async complete(id: string, input: TaskResultInput): Promise<TaskRecord> {
    await this.ensureLoaded()
    const task = this.mustGet(id)
    // 幂等与版本校验是纯读，不进写通道
    if (input.docVersion !== task.docVersion) {
      throw new LedgerError(
        'stale-version',
        `完成提交版本 v${input.docVersion} 与当前任务版本 v${task.docVersion} 不符: ${id}`,
      )
    }
    if (task.status === 'completed') return task
    if (task.status === 'review-pending' && task.result) return task
    return this.commit(() => {
      const openSubtasks = this.tasks.filter((t) => t.parentId === id && !isTerminal(t.status))
      const target: TaskStatus =
        task.acceptancePolicy === 'auto' && openSubtasks.length === 0 ? 'completed' : 'review-pending'
      assertTransition(task.status, target)
      const result: TaskResult = {
        summary: input.summary,
        docRef: input.docRef,
        deliverables: input.deliverables,
        acceptanceEvidence: input.acceptanceEvidence,
        openIssues: input.openIssues,
        completedAt: this.clock(),
      }
      task.result = result
      task.status = target
      task.updatedAt = this.clock()
      return task
    })
  }

  /** 验收通过：review-pending → completed（by 仅为审计语义，账本不落字段）。 */
  async accept(id: string, by: 'supervisor' | 'user'): Promise<TaskRecord> {
    void by
    return this.commit(() => {
      const task = this.mustGet(id)
      assertTransition(task.status, 'completed')
      task.status = 'completed'
      task.updatedAt = this.clock()
      return task
    })
  }

  /**
   * 驳回返工：review-pending → running，note 落 progress（worker 第一眼要看的文字）。
   * 状态机表里没有 review-pending→running 边（计划 Task 1 明注「驳回不走表边」）：
   * 驳回是完成协议的专属操作，只认 review-pending 起点，其余起点照抛非法迁移。
   */
  async reject(id: string, note: string): Promise<TaskRecord> {
    return this.commit(() => {
      const task = this.mustGet(id)
      if (task.status !== 'review-pending') {
        throw new LedgerError('illegal-transition', `驳回仅适用于 review-pending: ${id}（当前 ${task.status}）`)
      }
      task.status = 'running'
      task.progress = note
      task.updatedAt = this.clock()
      return task
    })
  }

  /** 取消：进终态 cancelled。 */
  async cancel(id: string, reason: string): Promise<TaskRecord> {
    void reason
    return this.commit(() => {
      const task = this.mustGet(id)
      assertTransition(task.status, 'cancelled')
      task.status = 'cancelled'
      task.updatedAt = this.clock()
      return task
    })
  }

  /** 失败收场：进终态 failed。 */
  async fail(id: string, reason: string): Promise<TaskRecord> {
    void reason
    return this.commit(() => {
      const task = this.mustGet(id)
      assertTransition(task.status, 'failed')
      task.status = 'failed'
      task.updatedAt = this.clock()
      return task
    })
  }

  /** 报告阻塞：→ blocked，reason 落 progress。 */
  async reportBlocker(id: string, reason: string): Promise<TaskRecord> {
    return this.commit(() => {
      const task = this.mustGet(id)
      assertTransition(task.status, 'blocked')
      task.status = 'blocked'
      task.progress = reason
      task.updatedAt = this.clock()
      return task
    })
  }

  /**
   * 派发失败记账（v1.1 规格 §2-4）：retryCount+1、错误文本落 progress，任务保持
   * 原状态（draft/queued —— 不产生 cancelled + 无会话残留）；累计达 blockAt
   * （默认 3）自动 → blocked 并返回封顶后的记录，由调用方通知 Router。
   * 幂等口径：已 blocked 的任务再记账不重复迁移（评审修复——并发下不抛
   * blocked→blocked），retryCount 停在上限，错误文本照常更新。
   */
  async recordDispatchFailure(id: string, reason: string, opts?: { blockAt?: number }): Promise<TaskRecord> {
    return this.commit(() => {
      const task = this.mustGet(id)
      const blockAt = opts?.blockAt ?? 3
      const nextCount = (task.retryCount ?? 0) + 1
      // 先校验后变更：封顶迁移非法时直接抛，内存不留「计数已加、迁移未动」的脏写。
      if (nextCount >= blockAt && task.status !== 'blocked') {
        assertTransition(task.status, 'blocked')
      }
      task.retryCount = task.status === 'blocked' ? Math.min(nextCount, blockAt) : nextCount
      task.progress = reason
      task.updatedAt = this.clock()
      if (nextCount >= blockAt && task.status !== 'blocked') {
        task.status = 'blocked'
      }
      return task
    })
  }

  /** 记一条待答问题（问答桥认领时落库，重启后孤儿恢复的依据）。 */
  async addQuestion(record: QuestionRecord): Promise<QuestionRecord> {
    return this.commit(() => {
      this.questions.push(structuredClone(record))
      return record
    })
  }

  /** 问题了结（answered / expired）；找不到返回 undefined。 */
  async settleQuestion(
    id: string,
    status: Extract<QuestionRecord['status'], 'answered' | 'expired'>,
    answer?: string,
  ): Promise<QuestionRecord | undefined> {
    return this.commit(() => {
      const record = this.questions.find((q) => q.id === id)
      if (record === undefined) return undefined
      record.status = status
      if (answer !== undefined) record.answer = answer
      record.answeredAt = this.clock()
      return record
    })
  }

  /** 全部 open 状态的问题（重启孤儿恢复扫描用）。 */
  async openQuestions(): Promise<QuestionRecord[]> {
    await this.ensureLoaded()
    return this.questions.filter((q) => q.status === 'open')
  }

  /** 按 ID 找问题（任意状态；应答桥区分 404/409 用）。 */
  async findQuestion(id: string): Promise<QuestionRecord | undefined> {
    await this.ensureLoaded()
    return this.questions.find((q) => q.id === id)
  }

  /**
   * 某任务已认领的提问批次数（v1.1 C6 提问预算的计数面）：认领即落一条记录，
   * 已答/失效都占预算——预算按「批次」计，不看批次的最终去向。
   */
  async countTaskQuestions(taskId: string): Promise<number> {
    await this.ensureLoaded()
    return this.questions.filter((q) => q.taskId === taskId).length
  }
}
