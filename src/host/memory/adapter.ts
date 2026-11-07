/**
 * 记忆服务的宿主适配层（计划 B8：B6 产物 ↔ 宿主服务）。
 *
 * B6 的三个模块（store/summarizer/retrieval）零宿主依赖；本文件是唯一的
 * 宿主接缝，全部宿主面从参数进（测试给假件）：
 *
 *  - createSummaryLlm：B6 的 SummaryLlm{stream(messages,signal)} ←
 *    ctx.llm.stream（样板 docs/research/r2-sessions.md §7.3：
 *    { provider, model, messages, purpose:'compaction', signal }，聚合
 *    text-delta 块为纯文本。路由对由 resolveTarget 注入——ctx.llm.stream
 *    没有 provider 直接 NO_ADAPTER（dsh-llm lib/index.js registration()），
 *    entry.ts 的兜底链 = 配置对 → 活会话最近路由头。
 *  - eventsToSummaryEvents：宿主 surface 事件 → SummaryEvent。文本提取
 *    形状照 dsh-session deriveEventMessage（user/message 的 data 即消息，
 *    assistant/tool 走 data.message.content），防御式解析、超长截断。
 *  - summarizeSessionViaQuery / maxSurfaceSeq：observeSession 租约读事件，
 *    租约必须 dispose（finally 保证，auto-resume scan.ts 先例）。
 *  - BackgroundSummarizer：会话 idle 后台增量摘要队列。去重规则
 *    「同会话同增量位只跑一次」：调度时记下当前最大事件 seq，同一 seq
 *    不再调度（失败也不在同位自动重试——下次有新事件时自然带上旧增量）。
 *  - createCompletedTaskRecorder：任务进入 completed 的触发点——
 *    appendSummary(project, key=任务标题, kind=verified-fact,
 *    text=结果摘要, sourceRefs=[taskId, result.md 相对路径]) +
 *    对任务会话跑一次增量摘要。全程不阻塞、失败只回调 onError（warn）。
 */

import {
  summarizeIncremental,
  type SummarizeResult,
  type SummaryEvent,
  type SummaryLlm,
  type SummaryPromptMessage,
} from './summarizer.ts'
import type { AppendSummaryResult, MemoryDocStore, MemoryEntryKind } from './store.ts'

/* ────────────────────────── llm 适配 ────────────────────────── */

/** ctx.llm 的最小面（AsyncIterable<chunk>）。 */
export interface HostLlmStreamFace {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

/** 一次模型调用需要的路由对（provider/model 必须都能落到适配器）。 */
export interface LlmRouteTarget {
  provider: string
  model: string
}

export const NO_ROUTE_MESSAGE =
  '记忆摘要没有可用的模型路由：配置 summarizationProvider/summarizationModel，或让目标会话先路由过一次请求'

/**
 * 把 ctx.llm.stream 包成 B6 的 SummaryLlm。只认 text-delta 块（按 index 分桶
 * 保序拼接）；reasoning/usage/finish 一律忽略。resolveTarget 允许异步返回
 * （entry 的兜底链要异步读账本找活会话的路由头）。宿主流或路由缺失的错误
 * 原样上抛——由触发方决定怎么容错（本插件触发方全部 warn 不抛）。
 */
export function createSummaryLlm(
  host: HostLlmStreamFace,
  resolveTarget: () => LlmRouteTarget | undefined | Promise<LlmRouteTarget | undefined>,
): SummaryLlm {
  return {
    async stream(messages, signal) {
      const target = await resolveTarget()
      if (target === undefined) throw new Error(NO_ROUTE_MESSAGE)
      const options: Record<string, unknown> = {
        provider: target.provider,
        model: target.model,
        messages,
        purpose: 'compaction',
        ...(signal === undefined ? {} : { signal }),
      }
      const parts = new Map<number, string>()
      for await (const chunk of host.stream(options)) {
        const record = (typeof chunk === 'object' && chunk !== null ? chunk : {}) as { type?: unknown; index?: unknown; text?: unknown }
        if (record.type !== 'text-delta' || typeof record.text !== 'string') continue
        const index = typeof record.index === 'number' ? record.index : 0
        parts.set(index, (parts.get(index) ?? '') + record.text)
      }
      return [...parts.keys()].sort((a, b) => a - b).map((index) => parts.get(index) ?? '').join('')
    },
  }
}

/* ────────────────────────── 事件提取 ────────────────────────── */

/** 喂给摘要模型的单事件文本上限（对齐宿主 snippetChars 默认量级）。 */
const EXCERPT_MAX_CHARS = 240

/** 宿主 surface 事件的最小读取面。 */
export interface SessionObservationLike {
  events: readonly unknown[]
  [Symbol.dispose]?: () => void
}

/** ctx.sessionQuery 的最小面（只消费 observeSession 租约）。 */
export interface SessionQueryObserveFace {
  observeSession(sessionId: string): Promise<SessionObservationLike>
}

/** 从一条 surface 事件里提取语义文本（形状照 dsh-session deriveEventMessage）。 */
function eventText(event: unknown): string {
  if (typeof event !== 'object' || event === null) return ''
  const { type, data } = event as { type?: unknown; data?: unknown }
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  // user/message 的 data 本身就是消息记录；assistant/tool 走 data.message。
  const message = type === 'user/message' ? record : (typeof record.message === 'object' && record.message !== null ? (record.message as Record<string, unknown>) : {})
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block !== 'object' || block === null) return ''
        const b = block as { type?: unknown; text?: unknown }
        return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
      })
      .filter((text) => text !== '')
      .join(' ')
  }
  if (typeof message.text === 'string') return message.text
  return ''
}

/** surface 事件 → SummaryEvent：无 seq、无语义文本的事件跳过，文本截断。 */
export function eventsToSummaryEvents(events: readonly unknown[]): SummaryEvent[] {
  const result: SummaryEvent[] = []
  for (const event of events) {
    const record = (typeof event === 'object' && event !== null ? event : {}) as { seq?: unknown; type?: unknown }
    const seq = typeof record.seq === 'number' ? record.seq : Number(record.seq)
    if (!Number.isSafeInteger(seq)) continue
    const type = typeof record.type === 'string' && record.type !== '' ? record.type : 'unknown'
    const textExcerpt = eventText(event).trim().slice(0, EXCERPT_MAX_CHARS)
    if (textExcerpt === '') continue
    result.push({ seq, type, textExcerpt })
  }
  return result
}

/* ────────────────────────── 租约读会话 ────────────────────────── */

/**
 * 走 observeSession 租约读事件并做增量摘要。租约在 finally 里释放——
 * llm 抛错也不泄漏；摘要失败（llm 错/空白）错误照 summarizeIncremental 上抛，
 * 增量位不推进（事件不丢）。
 */
export async function summarizeSessionViaQuery(
  query: SessionQueryObserveFace,
  store: MemoryDocStore,
  sessionId: string,
  llm: SummaryLlm,
  options: { signal?: AbortSignal } = {},
): Promise<SummarizeResult> {
  const observation = await query.observeSession(sessionId)
  try {
    const events = eventsToSummaryEvents(observation.events ?? [])
    return await summarizeIncremental(store, sessionId, events, llm, options)
  } finally {
    observation[Symbol.dispose]?.()
  }
}

/** 会话当前最大事件 seq（含结构事件；空会话 null）。租约同样在 finally 释放。 */
export async function maxSurfaceSeq(query: SessionQueryObserveFace, sessionId: string): Promise<number | null> {
  const observation = await query.observeSession(sessionId)
  try {
    let max: number | null = null
    for (const event of observation.events ?? []) {
      const seq = (event as { seq?: unknown } | undefined)?.seq
      const value = typeof seq === 'number' ? seq : Number(seq)
      if (Number.isSafeInteger(value) && (max === null || value > max)) max = value
    }
    return max
  } finally {
    observation[Symbol.dispose]?.()
  }
}

/* ────────────────────────── idle 后台队列 ────────────────────────── */

export interface BackgroundSummarizerDeps {
  /** 会话当前最大事件 seq（null = 空会话）。 */
  maxSeq(sessionId: string): Promise<number | null>
  /** 真正的增量摘要（如 summarizeSessionViaQuery 绑定参数后的形态）。 */
  run(sessionId: string): Promise<unknown>
  /** 失败回调（entry 接 warn 日志；缺席静默）。 */
  onError?(sessionId: string, error: unknown): void
}

/**
 * idle 触发的后台增量摘要调度器。规则（brief 原文）：同会话同增量位只跑一次。
 * 调度时读 maxSeq 并记账；run 失败只回调 onError，同一位不再自动重试——
 * 之后有新事件（maxSeq 变化）时 summarizeIncremental 会把旧增量一起补上。
 * 同会话在跑期间的新 onIdle 直接丢弃（不排队，避免堆积）。
 */
export class BackgroundSummarizer {
  private deps: BackgroundSummarizerDeps
  /** sessionId → 已调度到的最大事件 seq（去重位）。 */
  private scheduled = new Map<string, number>()
  private inFlight = new Set<string>()

  constructor(deps: BackgroundSummarizerDeps) {
    this.deps = deps
  }

  /** 后台调度入口：不 await、不抛（fire-and-forget）。 */
  onIdle(sessionId: string): void {
    if (this.inFlight.has(sessionId)) return
    void (async () => {
      this.inFlight.add(sessionId)
      try {
        const max = await this.deps.maxSeq(sessionId)
        if (max === null) return
        if (this.scheduled.get(sessionId) === max) return
        this.scheduled.set(sessionId, max)
        try {
          await this.deps.run(sessionId)
        } catch (error) {
          this.deps.onError?.(sessionId, error)
        }
      } catch (error) {
        this.deps.onError?.(sessionId, error)
      } finally {
        this.inFlight.delete(sessionId)
      }
    })()
  }

  /** 观测口：该会话已调度到的事件位。 */
  scheduledThrough(sessionId: string): number | undefined {
    return this.scheduled.get(sessionId)
  }
}

/* ────────────────────────── 结果判定（v1.2 规格 §4 第二级） ────────────────────────── */

/** 判定三态：completed=活已干完（没调交付工具）、partial=部分完成、failed=失败/受阻。 */
export type OutcomeVerdict = 'completed' | 'partial' | 'failed'

/** 一次判定的输出（判定摘要作为 system-judged 交付的 result.summary）。 */
export interface OutcomeJudgement {
  verdict: OutcomeVerdict
  summary: string
}

export const JUDGE_OUTCOME_SYSTEM_PROMPT = [
  '你是任务结果判定员。给你一个 worker 会话最近一轮的事件流（用户消息、助手输出），',
  '判断该任务的实际交付状态。只输出一行 JSON，不要解释：',
  '{"verdict":"completed|partial|failed","summary":"<不超过 200 字的判定摘要>"}',
  '三态定义：',
  '- completed：任务目标已实际完成（即使执行者没有调用完成工具提交）；',
  '- partial：部分完成——summary 必须说明剩余工作；',
  '- failed：失败或受阻——summary 必须说明原因；',
  '- 摘要只写事件流里有依据的结论，不添加事件里没有的内容，不写代码块。',
].join('\n')

/** 判定提示词（事件提取复用 eventsToSummaryEvents 的形状与截断规则）。 */
export function buildJudgeOutcomeMessages(events: SummaryEvent[]): SummaryPromptMessage[] {
  const lines = ['待判定的会话事件（seq 升序，最近一轮）：']
  for (const event of events) {
    lines.push(`#${event.seq} [${event.type}] ${event.textExcerpt}`)
  }
  lines.push('')
  lines.push('请输出判定 JSON。')
  return [
    { role: 'system', content: JUDGE_OUTCOME_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ]
}

/**
 * 解析判定输出：截取首尾大括号做 JSON 解析（模型偶尔包裹文字时仍可救回）；
 * verdict 必须在三态内、summary 必须非空——否则抛错（调用方按「判定不可用」
 * 处理，规格 §4：判定失败 → blocked 附判定不可用）。
 */
export function parseOutcomeJudgement(raw: string): OutcomeJudgement {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`判定输出不可解析: ${raw.trim().slice(0, 80)}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new Error(`判定输出不是合法 JSON: ${raw.trim().slice(0, 80)}`)
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { verdict?: unknown; summary?: unknown }
  const verdict = record.verdict
  if (verdict !== 'completed' && verdict !== 'partial' && verdict !== 'failed') {
    throw new Error(`判定 verdict 非法: ${String(verdict)}`)
  }
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  if (summary === '') throw new Error('判定 summary 为空')
  return { verdict, summary }
}

/**
 * 独立总结判定：复用记忆摘要的 llm 通道（SummaryLlm），输入会话尾部事件，
 * 输出三态判定。事件无语义文本（空会话等）直接抛错——无从判定就是判定失败。
 */
export async function judgeOutcome(
  sessionId: string,
  events: readonly unknown[],
  llm: SummaryLlm,
  options: { signal?: AbortSignal } = {},
): Promise<OutcomeJudgement> {
  const summarized = eventsToSummaryEvents(events)
  if (summarized.length === 0) {
    throw new Error(`会话 ${sessionId} 没有可判定的语义事件`)
  }
  const messages = buildJudgeOutcomeMessages(summarized)
  const signal = options.signal ?? new AbortController().signal
  const raw = (await llm.stream(messages, signal)).trim()
  if (raw === '') throw new Error('判定模型返回空白')
  return parseOutcomeJudgement(raw)
}

/* ────────────────────────── 完成触发 ────────────────────────── */

/** 任务完成写入项目层的条目类型（规格 §6 三分类：已验收的完成结果按已验证事实）。 */
export const COMPLETED_TASK_KIND: MemoryEntryKind = 'verified-fact'

export interface CompletedTaskMemoryInput {
  taskId: string
  /** 任务标题（project 层的主题 key）。 */
  title: string
  /** 结果摘要（complete_task 的 summary）。 */
  summary: string
  /** result.md 相对任务项目 cwd 的路径（如 .router/tasks/T-001/result.md）。 */
  resultRelPath: string
  /** 任务绑定的执行会话（有则顺带跑一次增量摘要）。 */
  sessionId?: string
}

/** 写 project 层一条完成记录（kind 固定 verified-fact；低信息按 store 规则拒绝）。 */
export function recordCompletedTask(store: MemoryDocStore, input: CompletedTaskMemoryInput): Promise<AppendSummaryResult> {
  return store.appendSummary('project', input.title, {
    sourceRefs: [input.taskId, input.resultRelPath],
    kind: COMPLETED_TASK_KIND,
    text: input.summary,
  })
}

export interface CompletedTaskRecorderDeps {
  store: MemoryDocStore
  query: SessionQueryObserveFace
  llm: SummaryLlm
  /** 失败回调（stage='completed-task'；entry 接 warn 日志）。 */
  onError?(stage: 'completed-task', error: unknown): void
}

/**
 * 任务完成触发点（不阻塞主流程、失败只回调不抛）：先写 project 层，
 * 再对任务会话跑一次增量摘要。任一步失败都不影响调用方。
 */
export function createCompletedTaskRecorder(deps: CompletedTaskRecorderDeps): (input: CompletedTaskMemoryInput) => void {
  return (input) => {
    void (async () => {
      await recordCompletedTask(deps.store, input)
      if (input.sessionId !== undefined) {
        await summarizeSessionViaQuery(deps.query, deps.store, input.sessionId, deps.llm)
      }
    })().catch((error) => {
      deps.onError?.('completed-task', error)
    })
  }
}
