/**
 * 问题浮窗（规格 §3.3：worker 的问题汇聚到浮动卡片区）。
 *
 * 挂点 `shell.overlay`（list、root、frame 级浮层、click-through、
 * replaceRisk none——R3 报告 §1.6/§8.2 的标准答案）：每张问题卡一枚收起
 * chip（任务名 + 问题计数），点击展开，逐问渲染单选/多选/自由文本；
 * 提交 → POST /router/answer，先「正在送达」，成功移除、失败保留已填内容、
 * 409 视为已完成；多卡垂直排队互不覆盖；收起不是回答。
 * 层本身 click-through：容器不恢复 pointer events，chip/卡自己恢复。
 */

import { useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ClientPrefsStore } from './client-prefs.ts'
import { chipSummary } from './question-state.ts'
import type { QuestionCardView } from './question-state.ts'
import type { WorkbenchStore } from './workbench-store.ts'
import { QUESTION_OVERLAY_ID, QUESTION_OVERLAY_ORDER, QUESTION_OVERLAY_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'
import type { AskUserQuestionItem } from '../shared/view-contract.ts'

/** 组件的业务输入（registration 的 inject 工厂给的 face；组件绝不收 ctx）。 */
export interface QuestionOverlayFace {
  store: WorkbenchStore
  prefs: ClientPrefsStore
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
  top: 52,
  right: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  alignItems: 'stretch',
  maxWidth: 320,
  // 层本身 click-through：容器穿透，交互元素自己恢复（R3 报告 §1.6）。
  pointerEvents: 'none',
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
      {(item.options ?? []).map((option) => {
        const selected = draft.selected.includes(option.label)
        return (
          <button
            key={option.label}
            type="button"
            role={item.multiSelect === true ? undefined : 'radio'}
            aria-checked={item.multiSelect === true ? undefined : selected}
            data-question-option={option.label}
            data-question-option-selected={selected || undefined}
            style={optionRowStyle(selected)}
            disabled={disabled}
            onClick={() => {
              if (item.multiSelect === true) {
                // 多选：点选切换，互不覆盖。
                const next = selected
                  ? draft.selected.filter((label) => label !== option.label)
                  : [...draft.selected, option.label]
                store.setAnswer(questionId, item.id, { selected: next })
              } else {
                // 单选：换选即覆盖，并清掉自定义文本（custom 会覆盖选中项）。
                store.setAnswer(questionId, item.id, { selected: [option.label], custom: null })
              }
            }}
          >
            <span aria-hidden>{item.multiSelect === true ? (selected ? '☑' : '☐') : selected ? '◉' : '○'}</span>
            <span>
              {option.label}
              {option.description ? <span style={{ opacity: 0.7 }}> — {option.description}</span> : null}
            </span>
          </button>
        )
      })}
      <input
        data-question-custom
        placeholder="其他（自由填写）"
        defaultValue={draft.custom ?? ''}
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
function QuestionCardEntry(props: { entry: QuestionCardView; store: WorkbenchStore }): ReactNode {
  const { entry, store } = props
  const questionId = entry.card.questionId
  if (entry.collapsed) {
    return (
      <div
        data-router-question-chip={questionId}
        data-router-question-count={entry.card.questions.length}
        style={CHIP_STYLE}
        role="button"
        tabIndex={0}
        onClick={() => store.toggleCollapsed(questionId)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') store.toggleCollapsed(questionId)
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
        <button
          type="button"
          data-router-question-collapse
          title="收起（不是回答）"
          aria-label={`收起问题 ${chipSummary(entry.card)}`}
          style={COLLAPSE_STYLE}
          onClick={() => store.toggleCollapsed(questionId)}
        >
          ▾
        </button>
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
        style={{ ...SUBMIT_STYLE, opacity: submitting ? 0.6 : 1 }}
        onClick={() => { void store.submitAnswer(questionId) }}
      >
        {submitting ? '正在送达…' : entry.phase === 'failed' ? '重新提交' : '提交回答'}
      </button>
    </div>
  )
}

/** 浮窗组件：多卡垂直排队互不覆盖；浮窗开关读偏好；状态机在 question-state。 */
export function QuestionCards(props: QuestionOverlayProps): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const prefs = useSyncExternalStore(props.prefs.subscribe, props.prefs.get)
  if (!prefs.overlayEnabled) return null
  if (state.board.cards.length === 0) return null
  return (
    <div data-router-question-overlay style={STACK_STYLE}>
      {state.board.cards.map((entry) => (
        <QuestionCardEntry key={entry.card.questionId} entry={entry} store={props.store} />
      ))}
    </div>
  )
}
