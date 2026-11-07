/**
 * 问题浮窗（规格 §3.3：worker 的问题汇聚到浮动卡片区；§8：chip 点击 = 展开
 * + 跳到该 worker 会话作答）。
 *
 * 挂点 `shell.overlay`（list、root、frame 级浮层、click-through、
 * replaceRisk none——R3 报告 §1.6/§8.2 的标准答案）：每张问题卡一枚收起
 * chip（任务名 + 问题计数），点击展开并跳到问题所属 worker 会话，逐问渲染
 * 单选/多选/自由文本；提交 → POST /router/answer，先「正在送达」，成功移除、
 * 失败保留已填内容、409 视为已完成；多卡垂直排队互不覆盖；收起不是回答；
 * 提交后停留在当前会话（没有任何自动跳回）。小窗是全局浮层，跳走后仍悬浮
 * 可答。层本身 click-through：滚动列只占住自己那一窄条指针事件，列外不挡。
 * 样式走 ui-kit 基线：悬浮提示浅色（禁原生 title）、hover 稍深（规格 §9）。
 */

import { useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ClientPrefsStore } from './client-prefs.ts'
import { chipClickAction, chipSummary, visibleCards } from './question-state.ts'
import type { QuestionCardView, QuestionDraftItem } from './question-state.ts'
import type { WorkbenchStore } from './workbench-store.ts'
import { QUESTION_OVERLAY_ID, QUESTION_OVERLAY_ORDER, QUESTION_OVERLAY_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'
import { LightTooltip, useHoverDarken } from './ui-kit.tsx'
import type { AskUserQuestionItem } from '../shared/view-contract.ts'

/** 组件的业务输入（registration 的 inject 工厂给的 face；组件绝不收 ctx）。 */
export interface QuestionOverlayFace {
  store: WorkbenchStore
  prefs: ClientPrefsStore
  uiWorkspace: { openSession(target: string): void }
}

export type QuestionOverlayProps = QuestionOverlayFace

/** 把浮窗注册进 shell.overlay。键名/id 见 surface-ids.ts（entry.spec 断言用）。 */
export function registerQuestionCards(slots: SlotsHost, face: QuestionOverlayFace): void {
  slots.inject(QUESTION_OVERLAY_SLOT, () => slots.register(
    { name: QUESTION_OVERLAY_SLOT, id: QUESTION_OVERLAY_ID, order: QUESTION_OVERLAY_ORDER, inject: () => face },
    QuestionCards,
  ))
}

const STACK_STYLE: CSSProperties = {
  position: 'fixed',
  // 第一行（52–88）让给「返回 Router」浮动按钮（back-button.tsx 同右栏），
  // 按钮与问题卡同现时按钮在上、卡列在下，互不覆盖。
  top: 88,
  right: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  alignItems: 'stretch',
  maxWidth: 320,
  // 有界滚动列（审查 F7）：卡片再多也不把提交按钮推出视口；列本身就是
  // 交互内容，占住这一窄条指针事件，列外仍是 click-through。
  maxHeight: 'calc(100vh - 72px)',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  pointerEvents: 'auto',
  zIndex: 40,
}

const CARD_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  background: 'var(--dsh-color-bg-elevated, #1f2126)',
  color: 'inherit',
  border: '1px solid var(--dsh-color-border, #3a3d45)',
  borderRadius: 10,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
  padding: 10,
  fontSize: 13,
  lineHeight: 1.5,
}

const CHIP_STYLE: CSSProperties = {
  ...CARD_STYLE,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  padding: '8px 10px',
}

function optionRowStyle(selected: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 6px',
    borderRadius: 6,
    border: '1px solid',
    borderColor: selected ? 'var(--dsh-color-primary, #4f6bed)' : 'var(--dsh-color-border, #3a3d45)',
    background: selected ? 'color-mix(in srgb, var(--dsh-color-primary, #4f6bed) 14%, transparent)' : 'transparent',
    cursor: 'pointer',
    margin: '2px 0',
    color: 'inherit',
    textAlign: 'left',
    fontSize: 12,
  }
}

const INPUT_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 4,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsh-color-border, #3a3d45)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
}

const SUBMIT_STYLE: CSSProperties = {
  marginTop: 8,
  padding: '5px 12px',
  borderRadius: 7,
  border: 'none',
  background: 'var(--dsh-color-primary, #4f6bed)',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
}

const COUNT_BADGE_STYLE: CSSProperties = {
  flex: 'none',
  minWidth: 18,
  textAlign: 'center',
  padding: '0 5px',
  borderRadius: 9,
  background: 'var(--dsh-color-warning, #e8a33d)',
  color: '#20222a',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: '18px',
}

const MINOR_TEXT_STYLE: CSSProperties = { fontSize: 11, opacity: 0.7 }

const COLLAPSE_STYLE: CSSProperties = {
  flex: 'none',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  padding: '0 4px',
  cursor: 'pointer',
}

/** 单个选项行（独立组件：hover 稍深要走 useHoverDarken 的 hook，不能进 map 回调）。 */
function OptionButton(props: {
  questionId: string
  itemId: string
  multiSelect: boolean
  draftItem: QuestionDraftItem
  store: WorkbenchStore
  label: string
  description?: string
  disabled: boolean
}): ReactNode {
  const { questionId, itemId, multiSelect, draftItem, store, label, description, disabled } = props
  const selected = draftItem.selected.includes(label)
  const [darken, bind] = useHoverDarken()
  return (
    <button
      type="button"
      role={multiSelect ? undefined : 'radio'}
      aria-checked={multiSelect ? undefined : selected}
      data-question-option={label}
      data-question-option-selected={selected || undefined}
      style={{ ...optionRowStyle(selected), ...darken }}
      disabled={disabled}
      {...bind}
      onClick={() => {
        if (multiSelect) {
          // 多选：点选切换，互不覆盖。
          const next = selected
            ? draftItem.selected.filter((candidate) => candidate !== label)
            : [...draftItem.selected, label]
          store.setAnswer(questionId, itemId, { selected: next })
        } else {
          // 单选：换选即覆盖，并清掉自定义文本（custom 会覆盖选中项）。
          store.setAnswer(questionId, itemId, { selected: [label], custom: null })
        }
      }}
    >
      <span aria-hidden>{multiSelect ? (selected ? '☑' : '☐') : selected ? '◉' : '○'}</span>
      <span>
        {label}
        {description ? <span style={{ opacity: 0.7 }}> — {description}</span> : null}
      </span>
    </button>
  )
}

/** 单个问题条目：题干 +（单选|多选）选项 + 自由文本「其他」。 */
function QuestionItem(props: { entry: QuestionCardView; item: AskUserQuestionItem; store: WorkbenchStore }): ReactNode {
  const { entry, item, store } = props
  const draft = entry.draft[item.id] ?? { selected: [] }
  const disabled = entry.phase === 'submitting'
  const questionId = entry.card.questionId
  return (
    <div data-question-item={item.id} style={{ marginTop: 8 }}>
      {item.header ? <div style={MINOR_TEXT_STYLE}>{item.header}</div> : null}
      <div style={{ fontWeight: 600 }}>{item.question}</div>
      {item.detail ? <div style={{ fontSize: 12, opacity: 0.75 }}>{item.detail}</div> : null}
      {(item.options ?? []).map((option) => (
        <OptionButton
          key={option.label}
          questionId={questionId}
          itemId={item.id}
          multiSelect={item.multiSelect === true}
          draftItem={draft}
          store={store}
          label={option.label}
          description={option.description}
          disabled={disabled}
        />
      ))}
      <input
        data-question-custom
        placeholder="其他（自由填写）"
        // 受控输入（审查 F6）：草稿是唯一事实——单选换选清掉 custom 时，
        // 输入框里的字必须同时消失，不能留着「看得见但不会提交」的回答。
        value={draft.custom ?? ''}
        disabled={disabled}
        style={INPUT_STYLE}
        onChange={(event) => {
          store.setAnswer(questionId, item.id, { custom: event.target.value })
        }}
      />
    </div>
  )
}

/** 一张问题卡：收起为 chip（任务名 + 计数），展开为逐问表单。 */
function QuestionCardEntry(props: {
  entry: QuestionCardView
  store: WorkbenchStore
  uiWorkspace: { openSession(target: string): void }
}): ReactNode {
  const { entry, store, uiWorkspace } = props
  const questionId = entry.card.questionId
  // hooks 全部在分支 return 之前（Rules of Hooks：折叠态翻转不得改变 hook 顺序）。
  const [chipDarken, chipBind] = useHoverDarken()
  const [collapseDarken, collapseBind] = useHoverDarken()
  const [submitDarken, submitBind] = useHoverDarken()
  // 规格 §8：chip 点击 = 展开 + 跳到该问题所属的 worker 会话（动作是纯函数，
  // question-state.spec 断言）；小窗保持全局悬浮，提交成功后出队、不跳回。
  const openChip = (): void => {
    const action = chipClickAction(entry.card)
    store.toggleCollapsed(questionId)
    uiWorkspace.openSession(action.sessionId)
  }
  if (entry.collapsed) {
    return (
      <div
        data-router-question-chip={questionId}
        data-router-question-count={entry.card.questions.length}
        style={{ ...CHIP_STYLE, ...chipDarken }}
        role="button"
        tabIndex={0}
        {...chipBind}
        onClick={openChip}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') openChip()
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {chipSummary(entry.card)}
        </span>
        <span style={COUNT_BADGE_STYLE}>{entry.card.questions.length}</span>
      </div>
    )
  }
  const submitting = entry.phase === 'submitting'
  return (
    <div data-router-question-card={questionId} style={CARD_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {chipSummary(entry.card)}
        </strong>
        <span style={{ flex: '1 1 auto' }} />
        {/* 浅色悬浮提示替代原生 title（规格 §9 禁黑底原生浮层）。 */}
        <LightTooltip label="收起（不是回答）">
          <button
            type="button"
            data-router-question-collapse
            aria-label={`收起问题 ${chipSummary(entry.card)}`}
            style={{ ...COLLAPSE_STYLE, ...collapseDarken }}
            {...collapseBind}
            onClick={() => store.toggleCollapsed(questionId)}
          >
            ▾
          </button>
        </LightTooltip>
      </div>
      {entry.card.sessionTitle ? (
        <div style={MINOR_TEXT_STYLE}>来自 {entry.card.sessionTitle}</div>
      ) : null}
      {entry.card.questions.map((item) => (
        <QuestionItem key={item.id} entry={entry} item={item} store={store} />
      ))}
      {entry.phase === 'failed' ? (
        <div data-router-question-error style={{ marginTop: 6, color: 'var(--dsh-color-danger, #d93025)', fontSize: 12 }}>
          送达失败，已填内容已保留，可修改后重试。
        </div>
      ) : null}
      <button
        type="button"
        data-router-question-submit
        disabled={submitting}
        style={{ ...SUBMIT_STYLE, opacity: submitting ? 0.6 : 1, ...submitDarken }}
        {...submitBind}
        onClick={() => { void store.submitAnswer(questionId) }}
      >
        {submitting ? '正在送达…' : entry.phase === 'failed' ? '重新提交' : '提交回答'}
      </button>
    </div>
  )
}

/** 浮窗组件：多卡垂直排队互不覆盖；展示量按偏好封顶（账本不删，审查 F4）；状态机在 question-state。 */
export function QuestionCards(props: QuestionOverlayProps): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const prefs = useSyncExternalStore(props.prefs.subscribe, props.prefs.get)
  if (!prefs.overlayEnabled) return null
  const cards = visibleCards(state.board.cards, prefs.maxActiveCards)
  if (cards.length === 0) return null
  return (
    <div data-router-question-overlay style={STACK_STYLE}>
      {cards.map((entry) => (
        <QuestionCardEntry
          key={entry.card.questionId}
          entry={entry}
          store={props.store}
          uiWorkspace={props.uiWorkspace}
        />
      ))}
    </div>
  )
}
