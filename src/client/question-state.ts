/**
 * 问题卡状态机 reducer（规格 §3.3 问题浮窗）。
 *
 * 每张问题卡（服务端 QuestionCard）在客户端有一份 UI 状态：
 *   received →（submitting → done 移除 | failed 保留已填答案，可重试）
 * 规则：
 * - 多卡独立排队：一张卡的提交/折叠/草稿不触碰别的卡；
 * - 409（已答过）由调用方映射成 accept（done）——卡片移除、不进 failed；
 * - 收起不是回答：折叠只翻转 collapsed，phase 与草稿分毫不动；
 * - 轮询重放同一 questionId 不得重置用户已填内容；
 * - 服务端已不在的卡（他端已答/已撤）在同步时移除，submitting 中的除外；
 * - 容量上限 pruneToCap：丢最旧的，submitting 中的永不丢。
 * 全部纯函数：入参不改，返回新状态。
 */

import type { AskUserQuestionAnswerItem, QuestionCard } from '../shared/view-contract.ts'

/** 卡片的客户端阶段。done 不落状态——成功即移除。 */
export type QuestionPhase = 'received' | 'submitting' | 'failed'

/** 逐问的草稿答案（键 = AskUserQuestionItem.id）。 */
export interface QuestionDraftItem {
  selected: string[]
  custom?: string
}

/** 一张问题卡的客户端视图状态。 */
export interface QuestionCardView {
  card: QuestionCard
  phase: QuestionPhase
  collapsed: boolean
  draft: Record<string, QuestionDraftItem>
}

/** 问题浮窗的整块状态（多卡按到达顺序垂直排队）。 */
export interface QuestionBoardState {
  cards: QuestionCardView[]
}

/** 空板。 */
export function emptyBoard(): QuestionBoardState {
  return { cards: [] }
}

function indexOfCard(state: QuestionBoardState, questionId: string): number {
  return state.cards.findIndex((entry) => entry.card.questionId === questionId)
}

/** 通用映射：只改指定卡，其余原样（不可变）。 */
function mapCard(
  state: QuestionBoardState,
  questionId: string,
  transform: (entry: QuestionCardView) => QuestionCardView,
): QuestionBoardState {
  const index = indexOfCard(state, questionId)
  if (index < 0) return state
  const cards = state.cards.slice()
  cards[index] = transform(cards[index]!)
  return { cards }
}

/** 新问题按到达顺序入队；已有同 id 的卡保持原 UI 状态（重放不重置草稿）。 */
export function cardsReceived(state: QuestionBoardState, cards: QuestionCard[]): QuestionBoardState {
  const known = new Set(state.cards.map((entry) => entry.card.questionId))
  const additions = cards
    .filter((card) => !known.has(card.questionId))
    .map((card): QuestionCardView => ({ card, phase: 'received', collapsed: false, draft: {} }))
  if (additions.length === 0) return state
  return { cards: [...state.cards, ...additions] }
}

/**
 * 与服务端同步（每次轮询后调用）：追加新卡；服务端已不在的卡移除，
 * 但 submitting 中的保留（在途提交的结局未定）；在存卡的 UI 状态不动。
 */
export function syncedWithServer(state: QuestionBoardState, serverCards: QuestionCard[]): QuestionBoardState {
  const serverIds = new Set(serverCards.map((card) => card.questionId))
  const kept = state.cards.filter((entry) => entry.phase === 'submitting' || serverIds.has(entry.card.questionId))
  return cardsReceived({ cards: kept }, serverCards)
}

/** 收起/展开：只翻 collapsed——收起不是回答。未知 id 无操作。 */
export function toggleCollapsed(state: QuestionBoardState, questionId: string): QuestionBoardState {
  return mapCard(state, questionId, (entry) => ({ ...entry, collapsed: !entry.collapsed }))
}

/** 写一问的草稿：给定字段覆盖（selected 整体替换），未给字段保留。 */
export function setAnswer(
  state: QuestionBoardState,
  questionId: string,
  itemId: string,
  patch: { selected?: string[]; custom?: string },
): QuestionBoardState {
  return mapCard(state, questionId, (entry) => {
    const current = entry.draft[itemId] ?? { selected: [] }
    const next: QuestionDraftItem = {
      selected: patch.selected ?? current.selected,
      custom: patch.custom !== undefined ? patch.custom : current.custom,
    }
    const draft = { ...entry.draft, [itemId]: next }
    return { ...entry, draft }
  })
}

/** 开始提交：received | failed → submitting；submitting 保持（重复触发无副作用）。 */
export function submitStarted(state: QuestionBoardState, questionId: string): QuestionBoardState {
  return mapCard(state, questionId, (entry) =>
    entry.phase === 'received' || entry.phase === 'failed' ? { ...entry, phase: 'submitting' } : entry)
}

/**
 * 提交成功（含 409 已答过）：卡片移除（done 即出队）。
 * 只允许从 submitting 迁入——received 直 accept 是非法迁移，原样返回。
 */
export function submitAccepted(state: QuestionBoardState, questionId: string): QuestionBoardState {
  const index = indexOfCard(state, questionId)
  if (index < 0) return state
  if (state.cards[index]!.phase !== 'submitting') return state
  return { cards: state.cards.filter((entry) => entry.card.questionId !== questionId) }
}

/** 提交失败：submitting → failed，卡片与已填答案保留（可改后重试）。 */
export function submitRejected(state: QuestionBoardState, questionId: string): QuestionBoardState {
  return mapCard(state, questionId, (entry) =>
    entry.phase === 'submitting' ? { ...entry, phase: 'failed' } : entry)
}

/**
 * 容量上限：超过 cap 时从最旧开始丢，submitting 中的永不丢；cap 内原样。
 * 活动卡上限来自本包设置段（client-prefs）。
 */
export function pruneToCap(state: QuestionBoardState, cap: number): QuestionBoardState {
  if (state.cards.length <= cap) return state
  const removable = state.cards.filter((entry) => entry.phase !== 'submitting')
  const overflow = state.cards.length - cap
  const doomed = new Set(removable.slice(0, overflow).map((entry) => entry.card.questionId))
  return { cards: state.cards.filter((entry) => !doomed.has(entry.card.questionId)) }
}

/** 收起 chip 的摘要行：任务名 → 会话标题 → 首问截断；全缺时给占位。 */
export function chipSummary(card: QuestionCard, maxChars = 20): string {
  if (typeof card.taskTitle === 'string' && card.taskTitle.length > 0) return card.taskTitle
  if (typeof card.sessionTitle === 'string' && card.sessionTitle.length > 0) return card.sessionTitle
  const first = card.questions[0]?.question ?? ''
  if (first.length === 0) return '（问题内容为空）'
  return first.length > maxChars ? `${first.slice(0, maxChars)}…` : first
}

/** 草稿 → 官方答案词汇：逐问生成 {id, selected, custom?}；custom 空串省略。 */
export function buildAnswerItems(
  card: QuestionCard,
  draft: Record<string, QuestionDraftItem>,
): AskUserQuestionAnswerItem[] {
  return card.questions.map((item) => {
    const entry = draft[item.id] ?? { selected: [] }
    const custom = typeof entry.custom === 'string' && entry.custom.length > 0 ? entry.custom : undefined
    return custom === undefined
      ? { id: item.id, selected: entry.selected }
      : { id: item.id, selected: entry.selected, custom }
  })
}
