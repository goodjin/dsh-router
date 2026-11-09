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
 * - 容量上限只裁渲染（visibleCards），账本与草稿永不因上限丢失。
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
  answeredIds?: string[]
}

/** 空板。 */
export function emptyBoard(): QuestionBoardState {
  return { cards: [] }
}

function indexOfCard(state: QuestionBoardState, questionId: string): number {
  return state.cards.findIndex((entry) => entry.card.questionId === questionId)
}

/** 通用映射：只改指定卡，其余原样（不可变）；变换是无操作时保持整块状态同一性。 */
function mapCard(
  state: QuestionBoardState,
  questionId: string,
  transform: (entry: QuestionCardView) => QuestionCardView,
): QuestionBoardState {
  const index = indexOfCard(state, questionId)
  if (index < 0) return state
  const current = state.cards[index]!
  const next = transform(current)
  if (next === current) return state
  const cards = state.cards.slice()
  cards[index] = next
  return { ...state, cards }
}

/** 新问题按到达顺序入队；默认收起（规格 §3.3：收起 chip）；已有同 id 的卡保持原 UI 状态（重放不重置草稿）。 */
export function cardsReceived(state: QuestionBoardState, cards: QuestionCard[]): QuestionBoardState {
  const known = new Set([...state.cards.map((entry) => entry.card.questionId), ...(state.answeredIds ?? [])])
  const additions = cards
    .filter((card) => {
      if (known.has(card.questionId)) return false
      known.add(card.questionId)
      return true
    })
    .map((card): QuestionCardView => ({ card, phase: 'received', collapsed: true, draft: {} }))
  if (additions.length === 0) return state
  return { ...state, cards: [...state.cards, ...additions] }
}

/**
 * 与服务端同步（每次轮询后调用）：追加新卡；服务端已不在的卡移除，
 * 但 submitting 中的保留（在途提交的结局未定）；在存卡的 UI 状态不动。
 */
export function syncedWithServer(state: QuestionBoardState, serverCards: QuestionCard[]): QuestionBoardState {
  const serverIds = new Set(serverCards.map((card) => card.questionId))
  const kept = state.cards.filter((entry) => entry.phase === 'submitting' || serverIds.has(entry.card.questionId))
  return cardsReceived({ ...state, cards: kept }, serverCards)
}

/** 收起/展开：只翻 collapsed——收起不是回答。未知 id 无操作。 */
export function toggleCollapsed(state: QuestionBoardState, questionId: string): QuestionBoardState {
  return mapCard(state, questionId, (entry) => ({ ...entry, collapsed: !entry.collapsed }))
}

/**
 * 写一问的草稿：selected 整体替换；custom——string 覆盖、null 清除、
 * undefined 保持不变（单选换选即传 null，避免旧 custom 覆盖新选中项）。
 */
export function setAnswer(
  state: QuestionBoardState,
  questionId: string,
  itemId: string,
  patch: { selected?: string[]; custom?: string | null },
): QuestionBoardState {
  return mapCard(state, questionId, (entry) => {
    const current = entry.draft[itemId] ?? { selected: [] }
    const custom = patch.custom === null
      ? undefined
      : patch.custom !== undefined ? patch.custom : current.custom
    const next: QuestionDraftItem = {
      selected: patch.selected ?? current.selected,
      custom,
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
  return { ...state, answeredIds: [...(state.answeredIds ?? []), questionId], cards: state.cards.filter((entry) => entry.card.questionId !== questionId) }
}

/** 提交失败：submitting → failed，卡片与已填答案保留（可改后重试）。 */
export function submitRejected(state: QuestionBoardState, questionId: string): QuestionBoardState {
  return mapCard(state, questionId, (entry) =>
    entry.phase === 'submitting' ? { ...entry, phase: 'failed' } : entry)
}

/**
 * 展示容量（审查 F4）：上限只裁「渲染」，不删账本——超出的最旧卡离开视野，
 * 但草稿与折叠状态原样保留；前面的卡出队后它们带着状态回到视野。
 * 这避免「同一批 13 张卡、上限 12」时反复轮换、丢用户已填内容。
 */
export function visibleCards(cards: QuestionCardView[], cap: number): QuestionCardView[] {
  if (cards.length <= cap) return cards
  return cards.slice(cards.length - cap)
}

/** 收起 chip 的摘要行：任务名 → 会话标题 → 首问截断；全缺时给占位。 */
export function chipSummary(card: QuestionCard, maxChars = 20): string {
  if (typeof card.taskTitle === 'string' && card.taskTitle.length > 0) return card.taskTitle
  if (typeof card.sessionTitle === 'string' && card.sessionTitle.length > 0) return card.sessionTitle
  const first = card.questions[0]?.question ?? ''
  if (first.length === 0) return '（问题内容为空）'
  return first.length > maxChars ? `${first.slice(0, maxChars)}…` : first
}

/** chip 点击动作（规格 §8）：展开本卡 + 跳到该问题所属的 worker 会话作答。 */
export type QuestionChipAction = { type: 'expand-and-open'; sessionId: string }

/**
 * chip 点击 → 动作（纯函数，只读卡数据）：collapsed 翻转仍走 toggleCollapsed，
 * 会话跳转由组件拿 action.sessionId 经 uiWorkspace.openSession 执行；
 * 提交成功后卡片出队、停留在跳过去的会话——没有任何「自动跳回」的动作类型。
 */
export function chipClickAction(card: QuestionCard): QuestionChipAction {
  return { type: 'expand-and-open', sessionId: card.sessionId }
}

/**
 * 草稿 → 官方答案词汇（user-questions 编码规则，逐字）：
 * - 单选题带 custom：custom 覆盖选中项 → selected 置空、custom 承载回答；
 * - 多选题带 custom：custom 补充 selected，两者并存；
 * - 无 custom：selected 原样（空 selected 且无 custom = 跳过的问题，保留在批次里）。
 */
export function buildAnswerItems(
  card: QuestionCard,
  draft: Record<string, QuestionDraftItem>,
): AskUserQuestionAnswerItem[] {
  return card.questions.map((item) => {
    const entry = draft[item.id] ?? { selected: [] }
    const custom = typeof entry.custom === 'string' && entry.custom.length > 0 ? entry.custom : undefined
    if (custom === undefined) {
      return { id: item.id, selected: entry.selected }
    }
    return item.multiSelect === true
      ? { id: item.id, selected: entry.selected, custom }
      : { id: item.id, selected: [], custom }
  })
}
