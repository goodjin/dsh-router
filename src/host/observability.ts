/**
 * 缓存命中观测（v1.3 计划 Task C1，规格 §4，取证 docs/research/r11）。
 *
 * 宿主 `session/event` 是作用域过滤事件但放行向上（r11 §2.1：挂在根作用域的
 * 监听器收到所有会话的每条落账事件），事件信封 `{type, seq, time, data}`，
 * `assistant/message` 的 `data.usage` 是 dsh-llm 统一 TokenUsage——
 * `cacheReadTokens` 即前缀缓存命中读。
 *
 * 本模块只做一件事：识别「任务会话的首条 assistant/message」，把它的
 * cacheReadTokens 记进账本任务（firstRequestCacheReadTokens）。口径：
 * - 「首条」按会话一次性内存标记判定（简报口径）；标记只被任务会话的
 *   assistant/message 消耗——user/message 等其余事件、以及非任务会话都不消耗
 *   （worker 真正的首个模型请求才是首条；绑定晚于无关事件也不丢真正的首条）。
 * - 非 assistant/message、形状不符、非任务会话：忽略；非任务会话不消耗标记
 *   （绑定晚于无关事件也不丢真正的首条；真实时序 attach 先于 prompt）。
 * - 适配器不回 cacheReadTokens（自定义网关 / pi-ai 0 值省略，r11 §5）→ 不写，
 *   投影 undefined =「未上报」，不冒充 0；字段在（含 0）→ 原样记录（最小面
 *   模式命中=0 是规格 §4 的验收证据）。
 * - 写失败只 warn 自包含（宿主对监听器本就 logged and contained；这里是
 *   fire-and-forget 投递，绝不让观测拖垮会话事件流）。
 */

/** 观察器需要的账本最小面（TaskLedger 结构化满足；测试给假件）。 */
export interface CacheObservabilityLedger {
  listAll(): Promise<Array<{ id: string; sessionId?: string }>>
  recordFirstCacheRead(id: string, tokens: number): Promise<unknown>
}

export interface FirstRequestCacheObserverDeps {
  ledger: CacheObservabilityLedger
  logger?: { warn(message: string): void }
}

/** 事件的最小读取面（宿主信封 `{type, seq, time, data}` 的防御性投影）。 */
interface SessionEventLike {
  type?: unknown
  data?: unknown
}

export class FirstRequestCacheObserver {
  private readonly ledger: CacheObservabilityLedger
  private readonly logger: FirstRequestCacheObserverDeps['logger']
  /** 「该会话的 assistant/message 已出现过」一次性标记（会话 ID 集合）。 */
  private readonly seen = new Set<string>()

  constructor(deps: FirstRequestCacheObserverDeps) {
    this.ledger = deps.ledger
    this.logger = deps.logger
  }

  /** 根作用域 `session/event` 监听体：`ctx.on('session/event', (session, event) => void observer.onSessionEvent(session, event))`。 */
  async onSessionEvent(session: unknown, event: unknown): Promise<void> {
    try {
      await this.handle(session, event)
    } catch (error) {
      this.logger?.warn(`缓存命中观测失败（已忽略，不影响会话事件流）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handle(session: unknown, event: unknown): Promise<void> {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return
    if (!isAssistantMessage(event)) return
    if (this.seen.has(sessionId)) return

    const records = await this.ledger.listAll()
    const task = records.find((record) => record.sessionId === sessionId)
    if (task === undefined) return // 非任务会话忽略：不记、不消耗标记（绑定晚于无关事件也不丢真正首条）

    this.seen.add(sessionId) // 一次性标记只给任务会话：内存规模随任务数、不随全宿主会话数
    const tokens = cacheReadTokensOf(event)
    if (tokens === undefined) return // 未上报：不写，投影保持 undefined
    await this.ledger.recordFirstCacheRead(task.id, tokens)
  }
}

/** 宿主 Session 的防御性读 ID（`session.id` 是由 header 派生的 getter）。 */
function sessionIdOf(session: unknown): string | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const id = (session as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function isAssistantMessage(event: unknown): event is SessionEventLike & { type: 'assistant/message' } {
  return event !== null && typeof event === 'object' && (event as SessionEventLike).type === 'assistant/message'
}

/** `data.usage.cacheReadTokens`：字段缺/非有限数值 = 未上报。 */
function cacheReadTokensOf(event: SessionEventLike): number | undefined {
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  const usage = (data as { usage?: unknown }).usage
  if (usage === null || typeof usage !== 'object') return undefined
  const tokens = (usage as { cacheReadTokens?: unknown }).cacheReadTokens
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined
}
