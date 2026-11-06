/**
 * 问题卡状态机 reducer（计划 Task B7 Step 1；规格 §3.3 问题浮窗）。
 *
 * 规则：received →（submitting → done | failed 保留已填答案）；多个 worker 的
 * 问题分别排队互不覆盖；409（已答过）按已完成处理；收起不是回答——折叠
 * 不改变 phase 与草稿；同一问题重复下发（轮询重放）不得重置用户已填内容。
 */

import { describe, expect, it } from 'vitest'
import {
  buildAnswerItems,
  chipSummary,
  cardsReceived,
  emptyBoard,
  pruneToCap,
  setAnswer,
  submitAccepted,
  submitRejected,
  submitStarted,
  syncedWithServer,
  toggleCollapsed,
} from '../src/client/question-state.ts'
import type { AskUserQuestionItem, QuestionCard } from '../src/shared/view-contract.ts'

function item(id: string, question: string, overrides: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem {
  return { id, question, options: [{ label: 'A' }, { label: 'B' }], ...overrides }
}

function card(questionId: string, overrides: Partial<QuestionCard> = {}): QuestionCard {
  return {
    questionId,
    taskId: 'T-001',
    taskTitle: '写发布文档',
    sessionId: 'w-1',
    sessionTitle: 'worker 一',
    questions: [item('q1', '用哪种许可证？')],
    receivedAt: 1_000,
    ...overrides,
  }
}

describe('received：入队与重放', () => {
  it('新问题按到达顺序入队，phase=received', () => {
    let board = emptyBoard()
    board = cardsReceived(board, [card('QA'), card('QB')])
    expect(board.cards.map((entry) => entry.card.questionId)).toEqual(['QA', 'QB'])
    expect(board.cards.every((entry) => entry.phase === 'received')).toBe(true)
  })

  it('轮询重放同一 questionId：保留已填草稿与 phase，不重复入队', () => {
    let board = cardsReceived(emptyBoard(), [card('QA')])
    board = setAnswer(board, 'QA', 'q1', { selected: ['A'] })
    board = submitStarted(board, 'QA')
    board = cardsReceived(board, [card('QA')])
    expect(board.cards).toHaveLength(1)
    expect(board.cards[0]?.phase).toBe('submitting')
    expect(board.cards[0]?.draft['q1']?.selected).toEqual(['A'])
  })

  it('多卡独立排队：第二张入队不影响第一张的草稿', () => {
    let board = cardsReceived(emptyBoard(), [card('QA')])
    board = setAnswer(board, 'QA', 'q1', { selected: ['B'] })
    board = cardsReceived(board, [card('QB')])
    expect(board.cards[0]?.draft['q1']?.selected).toEqual(['B'])
    expect(board.cards[1]?.draft['q1']).toBeUndefined()
  })
})

describe('submitting → done | failed', () => {
  it('received → submitting → 成功移除卡片（done 即出队）', () => {
    let board = cardsReceived(emptyBoard(), [card('QA')])
    board = submitStarted(board, 'QA')
    expect(board.cards[0]?.phase).toBe('submitting')
    board = submitAccepted(board, 'QA')
    expect(board.cards).toHaveLength(0)
  })

  it('409（已答过）映射为同一 done 迁移：卡片移除、不报错', () => {
    // 服务端对重复提交回 409；api 层把它映射成 submitAccepted（视为已完成）。
    let board = cardsReceived(emptyBoard(), [card('QA')])
    board = submitStarted(board, 'QA')
    board = submitAccepted(board, 'QA')
    expect(board.cards.map((entry) => entry.card.questionId)).toEqual([])
  })

  it('submitting → failed：卡片保留、phase=failed、已填答案保留', () => {
    let board = cardsReceived(emptyBoard(), [card('QA')])
    board = setAnswer(board, 'QA', 'q1', { selected: ['A'], custom: '其他说明' })
    board = submitStarted(board, 'QA')
    board = submitRejected(board, 'QA')
    expect(board.cards).toHaveLength(1)
    expect(board.cards[0]?.phase).toBe('failed')
    expect(board.cards[0]?.draft['q1']).toEqual({ selected: ['A'], custom: '其他说明' })
  })

  it('failed 后可重新 submitting（重试）', () => {
    let board = cardsReceived(emptyBoard(), [card('QA')])
    board = submitStarted(board, 'QA')
    board = submitRejected(board, 'QA')
    board = submitStarted(board, 'QA')
    expect(board.cards[0]?.phase).toBe('submitting')
  })

  it('received 直接 accept（没点提交）是非法迁移：状态不变', () => {
    let board = cardsReceived(emptyBoard(), [card('QA')])
    board = submitAccepted(board, 'QA')
    expect(board.cards).toHaveLength(1)
    expect(board.cards[0]?.phase).toBe('received')
  })
})

describe('收起与草稿', () => {
  it('收起/展开只翻转 collapsed，不改变 phase 与草稿', () => {
    let board = cardsReceived(emptyBoard(), [card('QA')])
    board = setAnswer(board, 'QA', 'q1', { selected: ['A'] })
    board = toggleCollapsed(board, 'QA')
    expect(board.cards[0]?.collapsed).toBe(true)
    expect(board.cards[0]?.phase).toBe('received')
    expect(board.cards[0]?.draft['q1']?.selected).toEqual(['A'])
    board = toggleCollapsed(board, 'QA')
    expect(board.cards[0]?.collapsed).toBe(false)
  })

  it('setAnswer 写草稿：多选累积 labels，custom 覆盖自由文本', () => {
    let board = cardsReceived(emptyBoard(), [card('QA', { questions: [item('q1', '带谁？', { multiSelect: true })] })])
    board = setAnswer(board, 'QA', 'q1', { selected: ['A'] })
    board = setAnswer(board, 'QA', 'q1', { selected: ['B'] })
    expect(board.cards[0]?.draft['q1']?.selected).toEqual(['B'])
    board = setAnswer(board, 'QA', 'q1', { custom: '都不要' })
    expect(board.cards[0]?.draft['q1']).toEqual({ selected: ['B'], custom: '都不要' })
  })

  it('未知 questionId 的操作是无操作（不抛、不改）', () => {
    const board = cardsReceived(emptyBoard(), [card('QA')])
    expect(toggleCollapsed(board, 'NOPE').cards).toEqual(board.cards)
    expect(setAnswer(board, 'NOPE', 'q1', { selected: ['A'] }).cards).toEqual(board.cards)
    expect(submitStarted(board, 'NOPE').cards).toEqual(board.cards)
  })
})

describe('与服务端同步、容量上限', () => {
  it('syncedWithServer：服务端已不在的卡（他端已答/已撤）移除；submitting 中的保留', () => {
    let board = cardsReceived(emptyBoard(), [card('QA'), card('QB')])
    board = submitStarted(board, 'QA')
    board = syncedWithServer(board, [card('QB')])
    expect(board.cards.map((entry) => entry.card.questionId)).toEqual(['QA', 'QB'])
    board = submitAccepted(board, 'QA')
    board = syncedWithServer(board, [card('QB')])
    expect(board.cards.map((entry) => entry.card.questionId)).toEqual(['QB'])
  })

  it('syncedWithServer 追加服务端新增的问题卡', () => {
    let board = cardsReceived(emptyBoard(), [card('QA')])
    board = syncedWithServer(board, [card('QA'), card('QC')])
    expect(board.cards.map((entry) => entry.card.questionId)).toEqual(['QA', 'QC'])
  })

  it('pruneToCap：超上限时丢最旧的，submitting 中的永不丢', () => {
    let board = cardsReceived(emptyBoard(), [card('Q1'), card('Q2'), card('Q3')])
    board = submitStarted(board, board.cards[1]!.card.questionId)
    const pruned = pruneToCap(board, 2)
    expect(pruned.cards.map((entry) => entry.card.questionId)).toEqual(['Q2', 'Q3'])
  })

  it('pruneToCap 上限内原样保留', () => {
    let board = cardsReceived(emptyBoard(), [card('Q1'), card('Q2')])
    expect(pruneToCap(board, 5).cards).toHaveLength(2)
  })
})

describe('buildAnswerItems：草稿 → 官方答案词汇（user-questions 编码规则）', () => {
  it('多选带 custom：selected 与 custom 并存', () => {
    const multi = card('QA', { questions: [item('q1', '带谁？', { multiSelect: true })] })
    expect(buildAnswerItems(multi, { q1: { selected: ['A'], custom: '还有临时工' } }))
      .toEqual([{ id: 'q1', selected: ['A'], custom: '还有临时工' }])
  })

  it('单选带 custom：按官方语义 selected 置空、custom 承载回答', () => {
    const single = card('QA')
    expect(buildAnswerItems(single, { q1: { selected: ['A'], custom: '走 MIT' } }))
      .toEqual([{ id: 'q1', selected: [], custom: '走 MIT' }])
  })

  it('无 custom：selected 原样携带（含空 selected = 跳过的问题）', () => {
    const qa = card('QA', { questions: [item('q1', '一'), item('q2', '二')] })
    expect(buildAnswerItems(qa, { q1: { selected: ['B'] }, q2: { selected: [] } }))
      .toEqual([
        { id: 'q1', selected: ['B'] },
        { id: 'q2', selected: [] },
      ])
  })
})

describe('chipSummary：收起 chip 的摘要行', () => {
  it('优先任务名，其次会话标题，最后首问截断', () => {
    const longQuestion = '一个很长很长很长很长很长很长很长的问题标题需要被截断展示'
    expect(chipSummary(card('QA'))).toBe('写发布文档')
    expect(chipSummary(card('QB', { taskTitle: undefined, sessionTitle: 'worker 二' }))).toBe('worker 二')
    expect(chipSummary(card('QC', { taskTitle: undefined, sessionTitle: undefined, questions: [item('q1', longQuestion)] })))
      .toBe(`${longQuestion.slice(0, 20)}…`)
  })

  it('计数取卡内问题数（UI 渲染用）', () => {
    const board = cardsReceived(emptyBoard(), [card('QA', { questions: [item('q1', '一'), item('q2', '二')] })])
    expect(board.cards[0]?.card.questions).toHaveLength(2)
  })
})
