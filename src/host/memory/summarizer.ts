/**
 * 增量会话摘要（规格 §6：会话摘要每会话一份、增量更新、记录已处理到的事件位）。
 *
 * llm 注入：{ stream(messages, signal): Promise<string> }——宿主集成层接
 * ctx.llm.stream（样板见 docs/research/r2-sessions.md §7.3：compaction-basic
 * 的摘要就是一次流式调用，purpose:'compaction'）；本模块只面向注入面，
 * 不 import 任何宿主包。
 *
 * 流程：读会话文档取增量位/标题/此前摘要 → 只把 lastSummarizedSeq 之后的事件
 * 喂给提示词 → llm 产出条目化摘要 → 写回摘要节并推进增量位。空增量跳过；
 * llm 抛错或返回空白都不推进增量位（事件不丢，下次重试）。
 */

import type { MemoryDocStore } from './store.ts'

export interface SummaryEvent {
  seq: number
  type: string
  textExcerpt: string
}

export interface SummaryPromptMessage {
  role: 'system' | 'user'
  content: string
}

/** 注入式模型面：宿主集成层用 ctx.llm.stream 适配。 */
export interface SummaryLlm {
  stream(messages: unknown[], signal: AbortSignal): Promise<string>
}

export interface BuildSummaryPromptInput {
  sessionTitle?: string
  events: SummaryEvent[]
  previousSummary?: string
}

export type SummarizeResult =
  | { skipped: 'no-new-events' }
  | { summarized: true; fromSeq: number; toSeq: number }

export interface SummarizeOptions {
  /** 透传给 llm.stream 的中止信号；缺省给一个永不中止的信号。 */
  signal?: AbortSignal
}

const SYSTEM_PROMPT = [
  '你是会话记忆摘要员。把事件流压缩成中文条目化摘要，规则：',
  '- 每条以 [决定]、[建议]、[事实] 之一开头：用户的决定用 [决定]，worker 的主张用 [建议]，已核实的结果用 [事实]；',
  '- 每条末尾用 (seqs: n,n) 注明来源事件序号，便于回溯；',
  '- 每条不超过 200 字；只保留需求、决定、结果、未决事项，不写过程流水；',
  '- 不写代码块，不添加事件里没有的内容；',
  '- 只输出摘要条目本身，不要解释。',
].join('\n')

export function buildSummaryPrompt(input: BuildSummaryPromptInput): {
  messages: SummaryPromptMessage[]
} {
  const events = [...input.events].sort((a, b) => a.seq - b.seq)
  const lines: string[] = [
    input.sessionTitle === undefined ? '会话标题：（无）' : `会话标题：${input.sessionTitle}`,
    '此前摘要：',
    input.previousSummary === undefined || input.previousSummary === ''
      ? '（无）'
      : input.previousSummary,
    '',
    '待摘要的新事件（seq 升序）：',
  ]
  for (const event of events) {
    lines.push(`#${event.seq} [${event.type}] ${event.textExcerpt}`)
  }
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: lines.join('\n') },
    ],
  }
}

export async function summarizeIncremental(
  store: MemoryDocStore,
  sessionId: string,
  events: SummaryEvent[],
  llm: SummaryLlm,
  options: SummarizeOptions = {},
): Promise<SummarizeResult> {
  const doc = await store.readDoc('session', sessionId)
  const lastSeq = doc?.lastSummarizedSeq ?? 0
  const pending = events.filter((event) => event.seq > lastSeq)
  if (pending.length === 0) return { skipped: 'no-new-events' }

  const { messages } = buildSummaryPrompt({
    sessionTitle: doc?.title,
    events: pending,
    previousSummary: doc?.summary,
  })
  const signal = options.signal ?? new AbortController().signal
  const summary = (await llm.stream(messages, signal)).trim()
  if (summary === '') {
    throw new Error('summarizeIncremental: llm 返回空白摘要，不推进增量位（下次重试）')
  }

  await store.setSessionSummary(sessionId, summary)
  const toSeq = Math.max(...pending.map((event) => event.seq))
  await store.setLastSummarizedSeq(sessionId, toSeq)
  return { summarized: true, fromSeq: Math.min(...pending.map((event) => event.seq)), toSeq }
}
