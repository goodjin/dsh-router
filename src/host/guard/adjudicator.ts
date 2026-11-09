/**
 * 事件驱动结果判定（v1.2 规格 §4，计划 Task B3；2026-11-09 改原会话自判）。
 *
 * 两级判定：worker 本轮输出结束（running→false，r7 §5.1）且任务未交付且无
 * 待答问题时，先注入一条自报身份的收尾提醒（r9 §5）；提醒轮结束仍无交付，
 * 再向**同一个会话**注入判定请求（只回一行 JSON 的三态自判），下一轮结束
 * 解析其回复落位（completed/partial/failed，parseOutcomeJudgement）。不再走
 * 独立 llm 通道——那条通道借别的会话路由、消息形状也曾不合宿主契约
 * （2026-11-09「判定模型返回空白」事故）。判定「实际已完成」时以判定摘要
 * 代交付并标记 deliveryOrigin='system-judged'（完成卡可退回重做）。
 *
 * 兜底定时器（首响超时/墙钟）防事件不来，与事件触发共用状态机防双跑；
 * 到期先查会话运行态：仍在跑（模型请求未超时=还在等）就整体让位给
 * 「轮结束」事件路径，不打扰、不另设计时器。
 *
 * @module @goodjin2/dsh-router/guard/adjudicator
 */

import type { TaskLedger } from '../ledger/store.ts'
import { parseOutcomeJudgement } from '../memory/adapter.ts'
import type { FsAdapter } from '../../shared/fs-adapter.ts'
import type { TaskRecord } from '../../shared/types.ts'

/** 去抖窗（r7 §5.2：300–500ms 吸收 latched 唤醒的 false→true 翻抖）。 */
export const DEFAULT_CLOSURE_DEBOUNCE_MS = 400

/** 派发后无任何轮结束的首响超时（规格 §4 兜底定时器一）。 */
export const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = 600_000

/** 任务墙钟上限（规格 §4 兜底定时器二；root-config 可配）。 */
export const DEFAULT_ADJUDICATION_WALL_CLOCK_MS = 1_800_000

/** 收尾提醒投递（gateway/internal 类）的尝试上限：同 requestId 限时重试。 */
const PROMPT_ATTEMPT_LIMIT = 3

/** observeSession 点读的观测结果（r7 §3.2：一次性 projectionMode:'none' 租约）。 */
export interface SessionObservation {
  events: readonly unknown[]
}

/** 写前意图账的落盘形状（r9 §5.2：先落账再投递，重试沿用同 requestId）。 */
interface ClosureIntentFile {
  schemaVersion: 1
  intents: { taskId: string; seq: number; requestId: string; text: string; deliveredAt?: number }[]
}

export interface ClosureIntentStoreDeps {
  fs: FsAdapter
  path: string
  logger?: { warn(message: string): void }
}

/** 一次收尾提醒的投递身份。 */
export interface ClosureIntent {
  seq: number
  requestId: string
}

/**
 * 收尾提醒意图账：prepare 先落盘再返回（写前账）——prompt 调用时意图已在
 * 磁盘上；同任务同文本的 pending 意图复用同 seq（重试同 requestId）；不同
 * 文本、或上次已 delivered，则分配新 seq。绝不用会话事件 seq（重试间漂移，
 * r9 §3.3）。宿主重启后 pending 意图跨实例复用。
 */
export class ClosureIntentStore {
  private fs: ClosureIntentStoreDeps['fs']
  private path: string
  private logger: ClosureIntentStoreDeps['logger']
  private file: ClosureIntentFile | undefined

  constructor(deps: ClosureIntentStoreDeps) {
    this.fs = deps.fs
    this.path = deps.path
    this.logger = deps.logger
  }

  private async ensureLoaded(): Promise<ClosureIntentFile> {
    if (this.file !== undefined) return this.file
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.path)) as Partial<ClosureIntentFile> | null
      if (parsed !== null && typeof parsed === 'object' && parsed.schemaVersion === 1 && Array.isArray(parsed.intents)) {
        this.file = { schemaVersion: 1, intents: parsed.intents.filter((entry) => typeof entry?.taskId === 'string' && typeof entry?.seq === 'number') }
      }
    } catch {
      // 首启无文件：从空白开始。
    }
    this.file ??= { schemaVersion: 1, intents: [] }
    return this.file
  }

  private async save(): Promise<void> {
    const file = await this.ensureLoaded()
    try {
      const lastSlash = this.path.lastIndexOf('/')
      await this.fs.mkdirp(lastSlash <= 0 ? '/' : this.path.slice(0, lastSlash))
      await this.fs.writeFile(this.path, JSON.stringify(file, null, 2))
    } catch (error) {
      this.logger?.warn(`closure-intents 落盘失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 分配（或复用）一次收尾提醒的投递身份。 */
  async prepare(taskId: string, text: string, now: number): Promise<ClosureIntent> {
    const file = await this.ensureLoaded()
    const pending = file.intents.find((intent) => intent.taskId === taskId && intent.text === text && intent.deliveredAt === undefined)
    if (pending !== undefined) return { seq: pending.seq, requestId: pending.requestId }
    const maxSeq = file.intents.reduce((acc, intent) => (intent.taskId === taskId && intent.seq > acc ? intent.seq : acc), 0)
    const seq = maxSeq + 1
    const requestId = `closure-${taskId}-${seq}`
    file.intents.push({ taskId, seq, requestId, text })
    await this.save()
    return { seq, requestId: `closure-${taskId}-${seq}` }
  }

  /** 标记已投递：下一次同文本提醒会分配新 seq（新周期）。 */
  async markDelivered(taskId: string, seq: number, now = 0): Promise<void> {
    const file = await this.ensureLoaded()
    const intent = file.intents.find((entry) => entry.taskId === taskId && entry.seq === seq)
    if (intent !== undefined && intent.deliveredAt === undefined) {
      intent.deliveredAt = now
      await this.save()
    }
  }
}

/** 判定用的 core 面（只认这两个动作；真实 core 注入，测试给假件）。 */
export interface AdjudicatorCoreFace {
  completeTask(callerSessionId: string, taskId: string, input: { docVersion: number; summary: string; deliveryOrigin?: 'worker' | 'system-judged' }): Promise<unknown>
  reportBlocker(callerSessionId: string, taskId: string, reason: string): Promise<unknown>
}

/** 事故条目（项目记忆 [事实]；entry 接 memory appendSummary）。 */
export interface IncidentEntry {
  taskId: string
  title: string
  text: string
}

export interface OutcomeAdjudicatorDeps {
  ledger: TaskLedger
  /** 一次性点读（projectionMode:'none'）。 */
  observeSession(sessionId: string, options?: { projectionMode?: 'none' }): Promise<SessionObservation>
  /** 收尾提醒注入（r9 §5 形状；错误对象带 code）。 */
  prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }): Promise<{ accepted: boolean }>
  /** 桌面版 session/state 面（缺席 = CLI 老宿主，走 agentsGet 兜底）。 */
  sessionState?(sessionId: string): Promise<{ running?: boolean; pendingInput?: readonly string[] } | undefined>
  /** CLI 兜底：agents.get(id)?.status（'running' 推迟）。 */
  agentsGet(sessionId: string): { status: string } | undefined
  core: AdjudicatorCoreFace
  intents: ClosureIntentStore
  recordIncident(entry: IncidentEntry): void
  now(): number
  schedule(delayMs: number, fn: () => void | Promise<void>): () => void
  firstResponseTimeoutMs?: number
  adjudicationWallClockMs?: number
  logger?: { warn(message: string): void }
}

/** 每任务每周期的判定相位：watching → nudged → judging → judged。 */
type CyclePhase = 'watching' | 'nudged' | 'judging' | 'judged'

interface TaskCycle {
  phase: CyclePhase
}

interface ArmedTimers {
  cancelFirst: () => void
  cancelWall: () => void
}

function closurePromptText(taskId: string): string {
  return [
    `【系统收尾提醒】任务 ${taskId} 的本轮输出已结束，但尚未提交交付。`,
    '请立即选择其一：',
    '1. 已完成 → 调用 complete_task 提交（summary 写清成果与验收条件的对照）；',
    '2. 受阻 → 调用 report_blocker 说明原因；',
    '3. 未做完 → 说明剩余工作与计划。',
    '（这是系统自动提醒，不是用户新指令。）',
  ].join('\n')
}

/** 判定请求的事件内标记（resolveJudge 只认含此标记之后的助手回复）。 */
export const JUDGE_REQUEST_MARKER = '【系统判定请求】'

function judgePromptText(taskId: string): string {
  return [
    `${JUDGE_REQUEST_MARKER}任务 ${taskId} 尚未提交交付。请对本任务的实际交付状态做一次判定，只输出一行 JSON，不要解释、不要调用工具：`,
    '{"verdict":"completed|partial|failed","summary":"<不超过 200 字的判定摘要>"}',
    '- completed：任务目标已实际完成（若此刻已可交付，请直接调用 complete_task 提交，忽略本判定）；',
    '- partial：部分完成——summary 必须说明剩余工作；',
    '- failed：失败或受阻——summary 必须说明原因。',
    '（这是系统自动判定请求，不是用户新指令。）',
  ].join('\n')
}

/** 一条 surface 事件的可见文本（user/message 的 data 即消息记录；assistant 走 data.message；形状照 memory/adapter 的 eventText，防御式）。 */
function eventVisibleText(event: unknown): string {
  if (typeof event !== 'object' || event === null) return ''
  const { type, data } = event as { type?: unknown; data?: unknown }
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  const message = type === 'user/message' ? record : (typeof record.message === 'object' && record.message !== null ? (record.message as Record<string, unknown>) : {})
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'object' && block !== null) {
          const b = block as { type?: unknown; text?: unknown }
          if (b.type === 'text' && typeof b.text === 'string') return b.text
        }
        return ''
      })
      .filter((text) => text !== '')
      .join(' ')
  }
  return typeof message.text === 'string' ? message.text : ''
}

/** 从事件流解析末轮：返回 { lastTurnStartIdx, lastTurnEnd }；无完整轮 → undefined。 */
function lastTurnWindow(events: readonly unknown[]): { startIdx: number; end: { reason?: { kind?: string } } } | undefined {
  let startIdx = -1
  let end: { reason?: { kind?: string } } | undefined
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i] as { type?: string; data?: { reason?: { kind?: string } } }
    if (event?.type === 'turn/start') startIdx = i
    if (event?.type === 'turn/end') end = event.data ?? {}
  }
  if (startIdx < 0 || end === undefined) return undefined
  return { startIdx, end }
}

function turnHasAssistantOutput(events: readonly unknown[], startIdx: number): boolean {
  for (let i = startIdx; i < events.length; i += 1) {
    if ((events[i] as { type?: string })?.type === 'assistant/message') return true
  }
  return false
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : error instanceof Error ? error.message : String(error)
}

/**
 * 结果判定器。事件入口 onTurnEnd/onTurnStart（bridge watchStatus 翻沿），
 * 周期入口 onDispatched（派发成功重置）；兜底 onFirstResponseTimeout/onWallClock。
 * 状态机每任务每周期：watching → nudged → judged。
 */
export class OutcomeAdjudicator {
  private deps: OutcomeAdjudicatorDeps
  private firstResponseMs: number
  private wallClockMs: number
  private cycles = new Map<string, TaskCycle>()
  private armed = new Map<string, ArmedTimers>()
  private debounces = new Map<string, () => void>()
  private evaluating = new Set<string>()

  constructor(deps: OutcomeAdjudicatorDeps) {
    this.deps = deps
    this.firstResponseMs = deps.firstResponseTimeoutMs ?? DEFAULT_FIRST_RESPONSE_TIMEOUT_MS
    this.wallClockMs = deps.adjudicationWallClockMs ?? DEFAULT_ADJUDICATION_WALL_CLOCK_MS
  }

  /* ───────────────────── 周期与兜底 ───────────────────── */

  /** 派发成功（或补充重投）：重置周期并武装双定时器。 */
  onDispatched(taskId: string): void {
    this.clearTimers(taskId)
    this.cycles.set(taskId, { phase: 'watching' })
    this.armTimers(taskId)
  }

  /** 启动恢复：给在飞的 dispatched|running 任务武装定时器（相位 watching）。 */
  async syncWatched(): Promise<void> {
    for (const record of await this.deps.ledger.listAll()) {
      if ((record.status === 'dispatched' || record.status === 'running') && record.sessionId !== undefined) {
        if (!this.cycles.has(record.id)) this.cycles.set(record.id, { phase: 'watching' })
        this.armTimers(record.id)
      }
    }
  }

  private armTimers(taskId: string): void {
    if (this.armed.has(taskId)) return
    const cancelFirst = this.deps.schedule(this.firstResponseMs, () => this.onFirstResponseTimeout(taskId))
    const cancelWall = this.deps.schedule(this.wallClockMs, () => this.onWallClock(taskId))
    this.armed.set(taskId, { cancelFirst, cancelWall })
  }

  private clearTimers(taskId: string): void {
    const armed = this.armed.get(taskId)
    if (armed !== undefined) {
      armed.cancelFirst()
      armed.cancelWall()
      this.armed.delete(taskId)
    }
  }

  /* ───────────────────── 事件入口 ───────────────────── */

  /** 会话转空闲（可能翻抖）：去抖后评估。 */
  onTurnEnd(sessionId: string): void {
    this.debounces.get(sessionId)?.()
    this.debounces.set(sessionId, this.deps.schedule(DEFAULT_CLOSURE_DEBOUNCE_MS, () => {
      this.debounces.delete(sessionId)
      return this.evaluate(sessionId)
    }))
  }

  /** 会话回到运行：取消去抖（新一轮开始了）。 */
  onTurnStart(sessionId: string): void {
    this.debounces.get(sessionId)?.()
    this.debounces.delete(sessionId)
  }

  /* ───────────────────── 兜底定时器入口 ───────────────────── */

  /** 首响超时：watching 相位补一次提醒（挂死会话不误判——不判定）。 */
  async onFirstResponseTimeout(taskId: string): Promise<void> {
    const cycle = this.cycles.get(taskId)
    if (cycle === undefined || cycle.phase !== 'watching') return
    const record = this.deps.ledger.get(taskId)
    if (record === undefined || record.sessionId === undefined || (record.status !== 'dispatched' && record.status !== 'running')) return
    // 会话仍在跑就不打扰（模型请求自带超时，没超时=还在等；轮结束事件会再进评估）。
    if (await this.sessionBusy(record.sessionId)) return
    await this.nudge(record)
  }

  /** 墙钟到期：watching → 提醒；nudged → 投判定请求；judging → 强制解析；judged → 无动作。 */
  async onWallClock(taskId: string): Promise<void> {
    const cycle = this.cycles.get(taskId)
    if (cycle === undefined || cycle.phase === 'judged') return
    const record = this.deps.ledger.get(taskId)
    if (record === undefined || record.sessionId === undefined || (record.status !== 'dispatched' && record.status !== 'running')) return
    // 会话仍在跑就整体让位：不打扰、不判定，轮结束事件路径接管（请求超时自会结束这轮）。
    if (await this.sessionBusy(record.sessionId)) return
    if (cycle.phase === 'watching') {
      await this.nudge(record)
      return
    }
    if (cycle.phase === 'nudged') {
      await this.requestJudge(record)
      return
    }
    const observation = await this.deps.observeSession(record.sessionId, { projectionMode: 'none' })
    await this.resolveJudge(record, observation.events, { forced: true })
  }

  /** 会话是否仍在跑一轮（桌面 sessionState 优先，CLI 老 host 用 agentsGet 兜底）。 */
  private async sessionBusy(sessionId: string): Promise<boolean> {
    if (this.deps.sessionState !== undefined) {
      try {
        const state = await this.deps.sessionState(sessionId)
        return state?.running === true
      } catch (error) {
        // 兜底定时器路径无外层兜底，异常外泄会被宿主当 fatal 整个退出
        //（2026-11-09 崩溃循环）；读不到态按「不占用」处理，判定流程继续，
        // 后续 prompt 对已销毁会话自有 not-found 分治。
        this.deps.logger?.warn(`sessionState 读取失败（会话 ${sessionId}），按不占用处理: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }
    return this.deps.agentsGet(sessionId)?.status === 'running'
  }

  /* ───────────────────── 评估（豁免链 + 相位动作） ───────────────────── */

  private async activeTaskFor(sessionId: string): Promise<TaskRecord | undefined> {
    for (const record of await this.deps.ledger.listAll()) {
      if (record.sessionId === sessionId && (record.status === 'dispatched' || record.status === 'running')) return record
    }
    return undefined
  }

  private async hasOpenQuestion(taskId: string): Promise<boolean> {
    return (await this.deps.ledger.openQuestions()).some((question) => question.taskId === taskId)
  }

  private async evaluate(sessionId: string): Promise<void> {
    if (this.evaluating.has(sessionId)) return
    this.evaluating.add(sessionId)
    try {
      const record = await this.activeTaskFor(sessionId)
      if (record === undefined) return
      // 未显式 onDispatched 的任务（如启动恢复前的存量）按 watching 惰性接管
      const cycle = this.cycles.get(record.id) ?? { phase: 'watching' as CyclePhase }
      if (cycle.phase === 'judged') return
      // 豁免 1：本任务有已认领待答问题（自家问题库；pendingInput 不可信，r9 §4.4）
      if (await this.hasOpenQuestion(record.id)) return
      // 点读（r7 §5.2：一次性 projectionMode:'none'）取末轮
      const observation = await this.deps.observeSession(sessionId, { projectionMode: 'none' })
      const events = observation.events
      // turnWindow（非 window）：宿主 bundle 里不能出现裸 window 标识符
      //（bundle.spec 断言宿主产物不混浏览器全局名，防误引浏览器侧代码）。
      const turnWindow = lastTurnWindow(events)
      if (turnWindow === undefined) return // 挂死（无完整轮）：留给兜底定时器
      // 豁免 2：末轮非 completed（aborted/error/interrupted ≠ 完成输出）
      if (turnWindow.end.reason?.kind !== 'completed') return
      // 豁免 3：零步空轮（末轮无 assistant/message）
      if (!turnHasAssistantOutput(events, turnWindow.startIdx)) return
      // 豁免 4：桌面 session/state 的 pendingInput 含 question/approval；CLI 老宿主 agentsGet 兜底
      if (this.deps.sessionState !== undefined) {
        const state = await this.deps.sessionState(sessionId)
        const pending = state?.pendingInput ?? []
        if (pending.includes('question') || pending.includes('approval')) return
      } else if (this.deps.agentsGet(sessionId)?.status === 'running') {
        return
      }
      if (cycle.phase === 'watching') await this.nudge(record)
      else if (cycle.phase === 'nudged') await this.requestJudge(record)
      else if (cycle.phase === 'judging') await this.resolveJudge(record, events, { forced: false })
    } catch (error) {
      this.deps.logger?.warn(`判定评估失败（会话 ${sessionId}）: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.evaluating.delete(sessionId)
    }
  }

  /* ───────────────────── 提示注入（收尾提醒与判定请求共用） ───────────────────── */

  /**
   * 排队注入一条系统提示：写前意图账（同文本 pending 复用同 requestId）→
   * gateway 类同 requestId 限时重试 → 四码分治。投递成功与否由返回值告知，
   * 相位与 progress 由调用方落（收尾提醒与判定请求的文案不同）。
   */
  private async injectQueuedPrompt(
    record: TaskRecord,
    text: string,
  ): Promise<{ outcome: 'delivered' | 'gateway-exhausted' | 'writer-held' | 'not-found' | 'agent-busy'; requestId: string }> {
    const taskId = record.id
    const sessionId = record.sessionId as string
    const intent = await this.deps.intents.prepare(taskId, text, this.deps.now())
    let attempt = 0
    while (attempt < PROMPT_ATTEMPT_LIMIT) {
      attempt += 1
      try {
        await this.deps.prompt({ requestId: intent.requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] })
        await this.deps.intents.markDelivered(taskId, intent.seq, this.deps.now())
        return { outcome: 'delivered', requestId: intent.requestId }
      } catch (error) {
        const code = errorCode(error)
        if (code.includes('gateway/internal') || code.includes('gateway')) {
          if (attempt >= PROMPT_ATTEMPT_LIMIT) return { outcome: 'gateway-exhausted', requestId: intent.requestId }
          continue // 同 requestId 限时重试（r9 §3.3）
        }
        if (code.includes('writer-held')) return { outcome: 'writer-held', requestId: intent.requestId } // 停手（r9 §5.1）
        if (code.includes('not-found')) return { outcome: 'not-found', requestId: intent.requestId }
        if (code.includes('agent-busy')) return { outcome: 'agent-busy', requestId: intent.requestId }
        throw error
      }
    }
    return { outcome: 'gateway-exhausted', requestId: intent.requestId }
  }

  /* ───────────────────── 第一级：收尾提醒 ───────────────────── */

  private async nudge(record: TaskRecord): Promise<void> {
    const taskId = record.id
    const { outcome, requestId } = await this.injectQueuedPrompt(record, closurePromptText(taskId))
    if (outcome === 'delivered') {
      this.cycles.set(taskId, { phase: 'nudged' })
      this.armTimers(taskId)
      await this.deps.ledger.updateProgress(taskId, `收尾提醒已投递（${requestId}）：请交付或说明阻塞`)
      this.deps.recordIncident({ taskId, title: '收尾提醒', text: `收尾提醒已投递: ${requestId}` })
      return
    }
    if (outcome === 'gateway-exhausted') {
      this.deps.logger?.warn(`收尾提醒 ${requestId} 重试耗尽（gateway），意图保持 pending 下轮续投`)
      return
    }
    if (outcome === 'writer-held') {
      await this.deps.ledger.updateProgress(taskId, '收尾提醒投递受阻（session/writer-held），本轮不重试')
      return
    }
    if (outcome === 'not-found') {
      await this.deps.ledger.updateProgress(taskId, '收尾提醒失败：会话不存在（session/not-found）')
      this.deps.recordIncident({ taskId, title: '收尾提醒失败', text: '收尾提醒投递失败 session/not-found' })
      return
    }
    await this.deps.ledger.updateProgress(taskId, '收尾提醒推迟：会话被占用（session/agent-busy），下轮再试')
  }

  /* ───────────────────── 第二级：原会话自判（2026-11-09 起） ───────────────────── */

  /**
   * 投递判定请求（queue）：同一执行会话自判三态，只回一行 JSON。投递成功置
   * judging 相位并重开墙钟（防「判定轮零输出且墙钟已耗尽」卡死在 judging）；
   * 回复由下一轮结束的 resolveJudge 或墙钟强制解析。
   */
  private async requestJudge(record: TaskRecord): Promise<void> {
    const taskId = record.id
    const phase = this.cycles.get(taskId)?.phase
    if (phase === 'judging' || phase === 'judged') return
    const { outcome, requestId } = await this.injectQueuedPrompt(record, judgePromptText(taskId))
    if (outcome === 'delivered') {
      this.clearTimers(taskId)
      this.cycles.set(taskId, { phase: 'judging' })
      this.armTimers(taskId)
      await this.deps.ledger.updateProgress(taskId, `判定请求已投递（${requestId}）：等待会话自判回复`)
      this.deps.recordIncident({ taskId, title: '判定请求', text: `判定请求已投递: ${requestId}` })
      return
    }
    if (outcome === 'not-found') {
      // 会话不存在：无从自判，blocked（判定不可用）终结本周期。
      this.cycles.set(taskId, { phase: 'judged' })
      this.clearTimers(taskId)
      await this.deps.core.reportBlocker(record.sessionId as string, taskId, '判定不可用：会话不存在（session/not-found）')
      this.deps.recordIncident({ taskId, title: '判定失败', text: '判定不可用：会话不存在（session/not-found）' })
      return
    }
    // gateway 耗尽 / writer-held / agent-busy：留在 nudged，下轮事件或墙钟再试。
    if (outcome === 'gateway-exhausted') {
      this.deps.logger?.warn(`判定请求 ${requestId} 重试耗尽（gateway），意图保持 pending 下轮续投`)
    } else if (outcome === 'writer-held') {
      await this.deps.ledger.updateProgress(taskId, '判定请求投递受阻（session/writer-held），本轮不重试')
    } else {
      await this.deps.ledger.updateProgress(taskId, '判定请求推迟：会话被占用（session/agent-busy），下轮再试')
    }
  }

  /**
   * 解析自判回复：只认「含判定标记的最后一条用户消息之后」的助手文本；
   * 三态落位（completed→系统判定交付；partial/failed→blocked 附判定）。
   * 找不到标记、无回复、回复不可解析 → blocked「判定不可用」附实情——
   * 全程不再发起任何独立模型调用。
   *
   * forced=false（轮结束事件路径）：标记尚未出现 = 判定请求还在队列里，
   * 不动相位继续等（下一轮结束或墙钟再进来）；forced=true（墙钟强制作结）：
   * 一切缺失都按「判定不可用」如实落 blocked。
   */
  private async resolveJudge(record: TaskRecord, events: readonly unknown[], options: { forced: boolean }): Promise<void> {
    const taskId = record.id
    const sessionId = record.sessionId as string
    let markerIdx = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if ((events[i] as { type?: string } | undefined)?.type === 'user/message' && eventVisibleText(events[i]).includes(JUDGE_REQUEST_MARKER)) {
        markerIdx = i
        break
      }
    }
    if (markerIdx < 0 && !options.forced) return
    // 入口同步置 judged：并发触发（去抖与墙钟同至）在异步工作开始前就被挡下
    this.cycles.set(taskId, { phase: 'judged' })
    this.clearTimers(taskId)
    if (markerIdx < 0) {
      await this.deps.core.reportBlocker(sessionId, taskId, '判定不可用：判定请求未被执行会话处理')
      this.deps.recordIncident({ taskId, title: '判定失败', text: '判定不可用：判定请求未被执行会话处理' })
      return
    }
    let reply = ''
    for (let i = markerIdx + 1; i < events.length; i += 1) {
      if ((events[i] as { type?: string } | undefined)?.type === 'assistant/message') reply = eventVisibleText(events[i])
    }
    let verdict
    try {
      verdict = parseOutcomeJudgement(reply)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.core.reportBlocker(sessionId, taskId, `判定不可用：${message}`)
      this.deps.recordIncident({ taskId, title: '判定失败', text: `判定不可用：${message}` })
      return
    }
    if (verdict.verdict === 'completed') {
      if (record.status === 'dispatched') {
        await this.deps.ledger.transition(taskId, 'running', '系统判定转执行')
      }
      await this.deps.core.completeTask(sessionId, taskId, {
        docVersion: record.docVersion,
        summary: verdict.summary,
        deliveryOrigin: 'system-judged',
      })
      await this.deps.ledger.updateProgress(taskId, `系统判定交付：${verdict.summary}`)
      this.deps.recordIncident({ taskId, title: '系统判定', text: `系统判定交付：${verdict.summary}` })
    } else {
      await this.deps.core.reportBlocker(sessionId, taskId, `${verdict.verdict}：${verdict.summary}`)
      await this.deps.ledger.updateProgress(taskId, `系统判定 ${verdict.verdict}：${verdict.summary}`)
      this.deps.recordIncident({ taskId, title: '系统判定', text: `系统判定 ${verdict.verdict}：${verdict.summary}` })
    }
  }
}
