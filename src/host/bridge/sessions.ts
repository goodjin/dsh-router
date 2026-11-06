/**
 * 会话桥（计划 Task B4）：任务 ↔ 独立持久会话之间的投递通道。
 *
 * 宿主调用面（create / prompt / onStatus / rename）全部注入，测试用假实现。
 * 投递幂等：requestId = `dispatch-<taskId>-v<docVersion>`——同版本重投在宿主侧
 * 去重（r2 §2.1：requestId 已排队或已入账时返回原受理），补充（supplementTo）
 * 用同一条规则带新版本号。workspace 解析：先按任务的 projectId 回查
 * workspaceRegistry，再按已有执行会话扫 workspace 成员，最后回退 cwd 创建。
 */

import { LedgerError } from '../ledger/errors.ts'
import type { TaskLedger } from '../ledger/store.ts'
import type { TaskRecord } from '../../shared/types.ts'
import type { TaskDocStore } from '../docs/task-docs.ts'

/** 宿主会话控制器的最小调用面（r2 §1/§2：sessionController.create/prompt）。 */
export interface SessionBridgeHost {
  create(opts: { workspaceId?: string; cwd?: string; agentPreset?: string }, signal?: AbortSignal): Promise<string>
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: { type: 'text'; text: string }[]
  }, signal?: AbortSignal): Promise<unknown>
  /** api-session/status（r2 §3.1：(sessionId, running)）。 */
  onStatus(callback: (sessionId: string, running: boolean) => void): void
  /** session/rename（r2 §1.1：标题只能事后改）。 */
  rename?(sessionId: string, title: string): Promise<void>
}

/** workspaceRegistry 的最小面（r2 §5）。 */
export interface WorkspaceInfo {
  id: string
  path?: string
  sessionIds?: string[]
}

export interface WorkspaceFace {
  list(): WorkspaceInfo[]
  get(id: string): WorkspaceInfo | undefined
}

export interface SessionBridgeDeps {
  ledger: Pick<TaskLedger, 'get' | 'transition' | 'attachSession'>
  /** 任务文档存储按任务工作目录取（每项目一个根：<cwd>/<tasksDir>）。 */
  docsFor(cwd: string): TaskDocStore
  /** registry 可选缺席（缺席即全部回退 cwd 创建）。 */
  workspaces?: WorkspaceFace
  host: SessionBridgeHost
  /** 按任务角色选预设 id。 */
  presets: { supervisor: string; worker: string }
  /** 执行指引文本（prompts/worker-instructions 的产物）。 */
  workerInstructions(): string
  /** 投递用的中止信号（缺席时每次调用自造 2 分钟超时）。 */
  signal?: AbortSignal
}

/** 宿主 prompt 的 Remote 包装第一行就 throwIfAborted（r2 §2.1），必须有信号。 */
const PROMPT_TIMEOUT_MS = 120_000

export class SessionBridge {
  private ledger: SessionBridgeDeps['ledger']
  private docsFor: (cwd: string) => TaskDocStore
  private workspaces: WorkspaceFace | undefined
  private host: SessionBridgeHost
  private presets: SessionBridgeDeps['presets']
  private workerInstructions: () => string
  private signal: AbortSignal | undefined
  private running = new Map<string, boolean>()
  private statusListeners: ((sessionId: string, running: boolean) => void)[] = []

  constructor(deps: SessionBridgeDeps) {
    this.ledger = deps.ledger
    this.docsFor = deps.docsFor
    this.workspaces = deps.workspaces
    this.host = deps.host
    this.presets = deps.presets
    this.workerInstructions = deps.workerInstructions
    this.signal = deps.signal
  }

  private hostSignal(): AbortSignal {
    return this.signal ?? AbortSignal.timeout(PROMPT_TIMEOUT_MS)
  }

  /** 任务的执行预设 id（router 角色不该被派发，防御性拒绝）。 */
  private presetFor(record: TaskRecord): string {
    if (record.role === 'router') {
      throw new LedgerError('role-forbidden', `任务 ${record.id} 指派了不可执行的角色 router`)
    }
    return this.presets[record.role]
  }

  /** workspace 解析：projectId 回查 → 已有执行会话扫成员 → undefined（回退 cwd）。 */
  private resolveWorkspace(record: TaskRecord): WorkspaceInfo | undefined {
    if (this.workspaces === undefined) return undefined
    const byId = this.workspaces.get(record.projectId)
    if (byId !== undefined) return byId
    if (record.sessionId !== undefined) {
      const bySession = this.workspaces.list().find((w) => w.sessionIds?.includes(record.sessionId as string))
      if (bySession !== undefined) return bySession
    }
    return undefined
  }

  /**
   * 派发任务：无会话则建（解析 workspace / 预设、改名），投任务书全文 + 执行指引
   * （requestId 幂等），成功后走状态机到 dispatched。draft 任务经 draft→queued→
   * dispatched 两步走表边（表里没有 draft→dispatched 直达边）。
   */
  async dispatchTask(taskId: string): Promise<{ sessionId: string | undefined }> {
    const record = this.ledger.get(taskId)
    if (record === undefined) throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
    const book = await this.docsFor(record.cwd).readDoc(taskId, 'task', record.docVersion)
    let sessionId = record.sessionId
    if (sessionId === undefined) {
      const workspace = this.resolveWorkspace(record)
      const createOpts = workspace !== undefined
        ? { workspaceId: workspace.id, agentPreset: this.presetFor(record) }
        : { cwd: record.cwd, agentPreset: this.presetFor(record) }
      sessionId = await this.host.create(createOpts, this.hostSignal())
      await this.ledger.attachSession(taskId, sessionId)
      await this.host.rename?.(sessionId, `${record.id} ${record.title}`)
    }
    await this.host.prompt(
      {
        requestId: `dispatch-${taskId}-v${record.docVersion}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `${book}\n\n${this.workerInstructions()}` }],
      },
      this.hostSignal(),
    )
    if (record.status === 'draft') await this.ledger.transition(taskId, 'queued')
    if (record.status === 'draft' || record.status === 'queued') {
      await this.ledger.transition(taskId, 'dispatched')
    }
    return { sessionId }
  }

  /**
   * 补充重投：把当前版本任务书投给原执行会话（requestId 同规则、带新版本号）。
   * 任务还没有执行会话时不投递——它保持 queued 等依赖解锁后按新版本首发。
   */
  async supplementTo(taskId: string): Promise<{ sessionId: string | undefined }> {
    const record = this.ledger.get(taskId)
    if (record === undefined) throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
    if (record.sessionId === undefined) return { sessionId: undefined }
    const book = await this.docsFor(record.cwd).readDoc(taskId, 'task', record.docVersion)
    await this.host.prompt(
      {
        requestId: `dispatch-${taskId}-v${record.docVersion}`,
        sessionId: record.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `${book}\n\n${this.workerInstructions()}` }],
      },
      this.hostSignal(),
    )
    return { sessionId: record.sessionId }
  }

  /** 取消通知：steer 插到执行会话最近一步，尽快停下。无会话时静默跳过。 */
  async notifyCancel(taskId: string): Promise<void> {
    const record = this.ledger.get(taskId)
    if (record === undefined) throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
    if (record.sessionId === undefined) return
    await this.notify(
      record.sessionId,
      `cancel-${taskId}`,
      `任务 ${record.id}「${record.title}」已被取消。请立即停止相关工作，不要继续提交；已产生的中间产物留在原地。`,
    )
  }

  /** 通用投递通道（完成通知、暂停通知等；默认 steer 立即插到最近一步）。 */
  async notify(
    sessionId: string,
    requestId: string,
    text: string,
    mode: 'queue' | 'steer' = 'steer',
  ): Promise<void> {
    await this.host.prompt({ requestId, sessionId, mode, content: [{ type: 'text', text }] }, this.hostSignal())
  }

  /** 订阅 api-session/status：记录运行标志（标签条 running 字段）并转发监听者。 */
  watchStatus(): void {
    this.host.onStatus((sessionId, isRunning) => {
      this.running.set(sessionId, isRunning)
      for (const listener of this.statusListeners) listener(sessionId, isRunning)
    })
  }

  /** 注册状态变化监听（压缩驱动等接线用）。 */
  onStatusChange(listener: (sessionId: string, isRunning: boolean) => void): void {
    this.statusListeners.push(listener)
  }

  /** 会话是否在跑（未观察过 = false）。 */
  isRunning(sessionId: string): boolean {
    return this.running.get(sessionId) ?? false
  }
}
