/**
 * 会话内系统提示词编辑（v1.1 计划 Task C5，规格 §7）。
 *
 * 两个表面配合：
 * - 「提示词」按钮挂 `conversation.session.header.actions`（仅 Router 会话渲染
 *   ——r5 取证 + 宿主源码确认 conversation.view 第三视图标签无法按会话条件
 *   显隐，走规格 §10 批准的回退路线；组件按 state.routerSessions 集合判定，
 *   非 Router 会话返回 null 不占位）；
 * - 编辑面板挂 `shell.overlay`（槽位文档要求浮层必须 portal——header.actions
 *   溢出会被裁切淡出；frame 级浮层天然满足）。面板内多行编辑器 + 保存 +
 *   重置默认 + 未保存提示，样式用 ui-kit（浅色悬浮提示、hover 稍深）。
 *
 * 数据走 GET/PUT /router/prompt（api.ts 封装）；保存后下一轮 system prompt
 * 组装即生效（宿主每轮现读 section text，无需刷新会话）。
 * 可见性/可用性判定是纯函数（prompt-editor-model.ts + 本文件的可见性函数），
 * 组件只是订阅者。
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { RouterApi } from './api.ts'
import type { RouterState } from '../shared/view-contract.ts'
import {
  canResetEditor,
  canSavePrompt,
  isPromptDirty,
  loadEditorState,
  resetConfirmMessage,
  savedEditorState,
  unsavedNotice,
  type PromptEditorState,
} from './prompt-editor-model.ts'
import { PROMPT_ACTION_ID, PROMPT_ACTION_ORDER, PROMPT_ACTION_SLOT, PROMPT_EDITOR_ID, PROMPT_EDITOR_ORDER, PROMPT_EDITOR_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'
import type { WorkbenchStore } from './workbench-store.ts'
import { LightTooltip, useHoverDarken } from './ui-kit.tsx'

/** 「提示词」按钮的业务输入（registration inject 工厂给；组件绝不收 ctx）。 */
export interface PromptActionFace {
  store: WorkbenchStore
}

/** 头部动作组件的 props：face + 宿主标准 props（sessionId；缺席退 store 当前会话）。 */
export interface PromptActionProps extends PromptActionFace {
  sessionId?: string
}

/** 把「提示词」按钮注册进会话头部动作位（entry.spec/bundle.spec 断言用）。 */
export function registerPromptAction(slots: SlotsHost, face: PromptActionFace): void {
  slots.inject(PROMPT_ACTION_SLOT, () => slots.register(
    { name: PROMPT_ACTION_SLOT, id: PROMPT_ACTION_ID, order: PROMPT_ACTION_ORDER, inject: () => face },
    PromptAction,
  ))
}

/** 编辑面板的业务输入。 */
export interface PromptEditorFace {
  store: WorkbenchStore
  api: Pick<RouterApi, 'getPrompt' | 'saveSessionPrompt'>
}

/** 把编辑面板注册进 shell.overlay（返回按钮同槽位第三项）。 */
export function registerPromptEditor(slots: SlotsHost, face: PromptEditorFace): void {
  slots.inject(PROMPT_EDITOR_SLOT, () => slots.register(
    { name: PROMPT_EDITOR_SLOT, id: PROMPT_EDITOR_ID, order: PROMPT_EDITOR_ORDER, inject: () => face },
    PromptEditorPanel,
  ))
}

/**
 * 「当前会话是否 Router」判定（纯函数）：state.routerSessions 集合（workbench
 * store 已拉取）包含该会话 id 才显示按钮。非 Router 会话/无快照 → false。
 */
export function promptActionVisible(sessionId: string | undefined, state: RouterState | null | undefined): boolean {
  if (sessionId === undefined || sessionId === '') return false
  if (state === null || state === undefined) return false
  return state.routerSessions.some((session) => session.sessionId === sessionId)
}

const ACTION_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  margin: 0,
  padding: '2px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsh-color-border, #3a3d45)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  userSelect: 'none',
}

/** 「提示词」按钮组件：非 Router 会话返回 null（slot 里不占位）。 */
export function PromptAction(props: PromptActionProps): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const [darken, bind] = useHoverDarken()
  // 宿主标准 props 优先（本会话头部的动作位拿到的是本会话 id）；
  // 缺席（老宿主/测试桩）退 store 维护的当前主视图会话。
  const sessionId = props.sessionId ?? state.currentSessionId
  if (!promptActionVisible(sessionId, state.routerState)) return null
  return (
    <LightTooltip label="编辑本会话的系统提示词">
      <button
        type="button"
        data-router-prompt-action={sessionId}
        aria-label="编辑系统提示词"
        style={{ ...ACTION_STYLE, ...darken }}
        {...bind}
        onClick={() => props.store.openPromptEditor(sessionId!)}
      >
        提示词
      </button>
    </LightTooltip>
  )
}

/** 编辑面板位置：右栏（返回按钮/问题卡同一条右栏，z 稍高于问题卡列）。 */
const PANEL_STYLE: CSSProperties = {
  position: 'fixed',
  top: 88,
  right: 16,
  width: 360,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: 'calc(100vh - 110px)',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 10,
  border: '1px solid var(--dsh-color-border, #3a3d45)',
  background: 'var(--dsh-color-bg-elevated, #1f2126)',
  boxShadow: '0 8px 24px rgba(31, 33, 38, 0.24)',
  pointerEvents: 'auto',
  zIndex: 46,
}

const TITLE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 13,
  fontWeight: 600,
}

const TEXTAREA_STYLE: CSSProperties = {
  width: '100%',
  minHeight: 160,
  resize: 'vertical',
  padding: 8,
  borderRadius: 8,
  border: '1px solid var(--dsh-color-border, #3a3d45)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  lineHeight: 1.6,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
}

const BUTTON_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

function panelButtonStyle(disabled: boolean): CSSProperties {
  return {
    margin: 0,
    padding: '4px 12px',
    borderRadius: 7,
    border: '1px solid var(--dsh-color-border, #3a3d45)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 12,
    lineHeight: '18px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  }
}

const NOTICE_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  opacity: 0.75,
}

/** 面板加载态（GET /router/prompt 在途）。 */
type PanelPhase = 'loading' | 'ready' | 'error'

/** 系统提示词编辑面板：打开时拉当前生效文本，保存/重置走 PUT（空串=清除）。 */
export function PromptEditorPanel(props: PromptEditorFace): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const sessionId = state.promptEditorSessionId
  const [phase, setPhase] = useState<PanelPhase>('loading')
  const [editor, setEditor] = useState<PromptEditorState>(() => loadEditorState('', true))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 打开（或换会话）即拉当前生效文本；加载结果按会话对齐，迟到的旧会话响应丢弃。
  useEffect(() => {
    if (sessionId === undefined) return
    let live = true
    setPhase('loading')
    setError(null)
    props.api.getPrompt(sessionId)
      .then((response) => {
        if (!live) return
        setEditor(loadEditorState(response.prompt, response.isDefault))
        setPhase('ready')
      })
      .catch((cause: unknown) => {
        if (!live) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase('error')
      })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props.api 由 registration 注入，稳定
  }, [sessionId])

  if (sessionId === undefined) return null

  const save = async (text: string): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await props.api.saveSessionPrompt(sessionId, text)
      setEditor(savedEditorState(editor, text))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const reset = (): void => {
    // 重置确认（规格：重置默认需确认；文案区分「丢未保存修改」与「清覆盖」）。
    if (!globalThis.confirm?.(resetConfirmMessage(editor))) return
    void save('')
  }

  const dirty = isPromptDirty(editor)
  const notice = unsavedNotice(editor)
  return (
    <div data-router-prompt-editor={sessionId} style={PANEL_STYLE}>
      <div style={TITLE_STYLE}>
        <span>系统提示词</span>
        <LightTooltip label="关闭（未保存的修改不生效）">
          <button
            type="button"
            data-router-prompt-close
            aria-label="关闭系统提示词编辑"
            style={{ ...panelButtonStyle(false), border: 'none', padding: '2px 6px', fontSize: 14 }}
            onClick={() => props.store.closePromptEditor()}
          >
            ×
          </button>
        </LightTooltip>
      </div>
      <div style={NOTICE_STYLE}>
        {phase === 'loading' ? '加载中…' : null}
        {phase === 'ready' && editor.isDefault && !dirty ? '当前是默认提示词，修改后仅本会话生效。' : null}
        {phase === 'ready' && !editor.isDefault && !dirty ? '本会话使用自定义覆盖，恢复默认点「重置」。' : null}
        {notice !== null ? <span data-router-prompt-dirty>{notice}</span> : null}
      </div>
      <textarea
        data-router-prompt-textarea
        aria-label="系统提示词内容"
        style={TEXTAREA_STYLE}
        value={editor.text}
        disabled={phase !== 'ready' || saving}
        onChange={(event) => { setEditor({ ...editor, text: event.target.value }) }}
      />
      {error !== null ? (
        <div data-router-prompt-error style={{ ...NOTICE_STYLE, color: 'var(--dsh-color-danger, #d93025)' }}>
          {error}
        </div>
      ) : null}
      <div style={BUTTON_ROW_STYLE}>
        <LightTooltip label={canSavePrompt(editor) ? '保存后下一轮对话生效（仅本会话）' : '没有需要保存的修改'}>
          <button
            type="button"
            data-router-prompt-save
            disabled={!canSavePrompt(editor) || saving || phase !== 'ready'}
            style={panelButtonStyle(!canSavePrompt(editor) || saving || phase !== 'ready')}
            onClick={() => { void save(editor.text) }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </LightTooltip>
        <LightTooltip label={canResetEditor(editor) ? '清除本会话覆盖，恢复默认提示词' : '已是默认提示词'}>
          <button
            type="button"
            data-router-prompt-reset
            disabled={!canResetEditor(editor) || saving || phase !== 'ready'}
            style={panelButtonStyle(!canResetEditor(editor) || saving || phase !== 'ready')}
            onClick={reset}
          >
            重置默认
          </button>
        </LightTooltip>
      </div>
    </div>
  )
}
