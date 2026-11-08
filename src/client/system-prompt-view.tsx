/**
 * 「提示词」视图标签（v1.5：提示词管理移入会话界面）。
 *
 * 挂点 `conversation.view`（list、session 作用域）——宿主 viewTabs 遍历注册项
 * 自动出标签（r5 取证 §1），order 20 落在「轨迹(10)」与「统计(40)」之间。
 * Router 会话：查看+编辑当前生效的系统提示词（会话覆盖 > 全局默认），保存/
 * 重置/另存为全局默认；非 Router 会话：空态说明（宿主无第三方标签按会话显隐
 * 的谓词，标签恒在——内容按会话类型分化，r5 §1 的既知限制）。
 *
 * 编辑逻辑复用 prompt-editor-model（脏检查/保存可用性/未保存提示），数据走
 * GET/PUT /router/prompt 与 /router/defaults；保存后下一轮组装即生效。
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
import { SYSTEM_PROMPT_VIEW_ID, SYSTEM_PROMPT_VIEW_ORDER, SYSTEM_PROMPT_VIEW_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'
import type { WorkbenchStore } from './workbench-store.ts'
import { LightTooltip, useHoverDarken } from './ui-kit.tsx'

/** 视图组件的业务输入（registration inject 工厂给；组件绝不收 ctx）。 */
export interface SystemPromptViewFace {
  store: WorkbenchStore
  api: Pick<RouterApi, 'getPrompt' | 'saveSessionPrompt' | 'getDefaults' | 'saveDefaults'>
}

export type SystemPromptViewProps = SystemPromptViewFace & {
  /** 会话作用域标准 props：本会话 id（缺席退 store 当前会话）。 */
  sessionId?: string
}

/** 把「提示词」视图注册进 conversation.view（entry.spec/bundle.spec 断言用）。 */
export function registerSystemPromptView(slots: SlotsHost, face: SystemPromptViewFace): void {
  slots.inject(SYSTEM_PROMPT_VIEW_SLOT, () => slots.register(
    { name: SYSTEM_PROMPT_VIEW_SLOT, id: SYSTEM_PROMPT_VIEW_ID, order: SYSTEM_PROMPT_VIEW_ORDER, label: () => '提示词', inject: () => face },
    SystemPromptView,
  ))
}

/**
 * 本会话是否 Router（纯函数）：session 作用域 sessionId 优先，缺席退 store
 * 当前主视图会话；再对 routerSessions 集合判定。
 */
export function systemPromptViewIsRouter(sessionId: string | undefined, currentSessionId: string | undefined, state: RouterState | null | undefined): boolean {
  const target = sessionId !== undefined && sessionId !== '' ? sessionId : currentSessionId
  if (target === undefined) return false
  if (state === null || state === undefined) return false
  return state.routerSessions.some((session) => session.sessionId === target)
}

const VIEW_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '14px 16px',
  height: '100%',
  minHeight: 0,
  boxSizing: 'border-box',
  color: '#1f2328',
}

const TITLE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 13,
  fontWeight: 600,
}

const BADGE_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  padding: '1px 8px',
  borderRadius: 999,
  border: '1px solid #d8dbe0',
  whiteSpace: 'nowrap',
}

const TEXTAREA_STYLE: CSSProperties = {
  width: '100%',
  flex: 1,
  minHeight: 220,
  resize: 'vertical',
  padding: 10,
  borderRadius: 8,
  border: '1px solid #d8dbe0',
  background: 'transparent',
  color: '#1f2328',
  fontSize: 12,
  lineHeight: 1.6,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
}

function buttonStyle(disabled: boolean): CSSProperties {
  return {
    margin: 0,
    padding: '4px 12px',
    borderRadius: 7,
    border: '1px solid #d8dbe0',
    background: 'transparent',
    color: '#1f2328',
    fontSize: 12,
    lineHeight: '18px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  }
}

const NOTICE_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, opacity: 0.75 }

const EMPTY_STYLE: CSSProperties = {
  ...NOTICE_STYLE,
  margin: 'auto',
  textAlign: 'center',
}

type Phase = 'loading' | 'ready' | 'error'

/** 「提示词」视图：Router 会话 = 编辑器；其余 = 空态说明。 */
export function SystemPromptView(props: SystemPromptViewProps): ReactNode {
  const storeState = useSyncExternalStore(props.store.subscribe, props.store.get)
  const sessionId = (props.sessionId !== undefined && props.sessionId !== '') ? props.sessionId : storeState.currentSessionId
  const isRouter = systemPromptViewIsRouter(props.sessionId, storeState.currentSessionId, storeState.routerState)

  const [phase, setPhase] = useState<Phase>('loading')
  const [editor, setEditor] = useState<PromptEditorState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  // hover 反馈的三个 hook 必须无条件调用：它们原先在下面 loading/error/empty
  // 的 early return 之后，非 editor 相位渲染的 hook 数量比 editor 相位少 3，
  // phase 或会话切换即触发「Rendered more hooks than during the previous
  // render」整树崩溃——表现即「Router 会话提示词看不到内容」。
  const [saveDarken, saveBind] = useHoverDarken()
  const [resetDarken, resetBind] = useHoverDarken()
  const [defaultDarken, defaultBind] = useHoverDarken()

  // 本会话生效提示词（覆盖 > 默认）；会话切换时重拉。
  useEffect(() => {
    if (!isRouter || sessionId === undefined) return
    let cancelled = false
    setPhase('loading')
    void props.api.getPrompt(sessionId)
      .then((loaded) => {
        if (cancelled) return
        setEditor(loadEditorState(loaded.prompt, loaded.isDefault))
        setPhase('ready')
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setError(caught instanceof Error ? caught.message : String(caught))
        setPhase('error')
      })
    return () => { cancelled = true }
  }, [isRouter, sessionId, props.api])

  if (!isRouter) {
    return (
      <div style={VIEW_STYLE} data-router-prompt-view="empty">
        <div style={EMPTY_STYLE}>此会话不是 Router 会话——「提示词」标签仅在 Router 会话中提供查看与编辑。</div>
      </div>
    )
  }
  if (sessionId === undefined) {
    return (
      <div style={VIEW_STYLE} data-router-prompt-view="nosession">
        <div style={EMPTY_STYLE}>无法确定当前会话。</div>
      </div>
    )
  }
  if (phase === 'loading') {
    return <div style={VIEW_STYLE} data-router-prompt-view="loading"><div style={EMPTY_STYLE}>正在加载提示词…</div></div>
  }
  if (phase === 'error' || editor === undefined) {
    return (
      <div style={VIEW_STYLE} data-router-prompt-view="error">
        <div style={EMPTY_STYLE}>加载失败：{error ?? '未知错误'}</div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button type="button" style={buttonStyle(false)} onClick={() => { void props.api.getPrompt(sessionId).then((loaded) => {
            setEditor(loadEditorState(loaded.prompt, loaded.isDefault)); setPhase('ready')
          }).catch(() => setPhase('error')) }}>重试</button>
        </div>
      </div>
    )
  }

  const dirty = isPromptDirty(editor)

  const save = async (): Promise<void> => {
    if (!canSavePrompt(editor) || busy) return
    setBusy(true)
    try {
      await props.api.saveSessionPrompt(sessionId, editor.text)
      setEditor(savedEditorState(editor, editor.text))
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const reset = async (): Promise<void> => {
    if (!canResetEditor(editor) || busy) return
    if (!window.confirm(resetConfirmMessage(editor))) return
    setBusy(true)
    try {
      await props.api.saveSessionPrompt(sessionId, '')
      const loaded = await props.api.getPrompt(sessionId)
      setEditor(loadEditorState(loaded.prompt, loaded.isDefault))
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const saveAsDefault = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const defaults = await props.api.getDefaults()
      await props.api.saveDefaults({ ...defaults, routerSystemPrompt: editor.text })
      const loaded = await props.api.getPrompt(sessionId)
      setEditor(loadEditorState(loaded.prompt, loaded.isDefault))
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={VIEW_STYLE} data-router-prompt-view="editor">
      <div style={TITLE_STYLE}>
        <strong>系统提示词{editor.isDefault ? '' : '（会话覆盖）'}</strong>
        <span style={BADGE_STYLE} data-router-prompt-source={editor.isDefault ? 'default' : 'override'}>
          {editor.isDefault ? '当前生效：全局默认' : '当前生效：本会话覆盖'}
        </span>
      </div>
      <textarea
        data-router-prompt-textarea
        style={TEXTAREA_STYLE}
        value={editor.text}
        onChange={(event) => { setEditor({ ...editor, text: event.target.value }) }}
        spellCheck={false}
      />
      {error !== undefined ? <div style={{ ...NOTICE_STYLE, color: '#b3261e' }} data-router-prompt-error>{error}</div> : null}
      {dirty ? <div style={NOTICE_STYLE} data-router-prompt-unsaved>{unsavedNotice(editor)}</div> : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <LightTooltip label="保存为本会话覆盖；空串等同重置。下一轮对话即生效">
          <button type="button" data-router-prompt-save style={{ ...buttonStyle(busy || !canSavePrompt(editor)), ...saveDarken }} {...saveBind} disabled={busy || !canSavePrompt(editor)} onClick={() => { void save() }}>
            {busy ? '处理中…' : '保存（本会话）'}
          </button>
        </LightTooltip>
        <LightTooltip label="清除本会话覆盖，回到全局默认">
          <button type="button" data-router-prompt-reset style={{ ...buttonStyle(busy || !canResetEditor(editor)), ...resetDarken }} {...resetBind} disabled={busy || !canResetEditor(editor)} onClick={() => { void reset() }}>
            重置为默认
          </button>
        </LightTooltip>
        <LightTooltip label="把当前编辑内容写为全局默认（影响之后新建的 Router 会话；不改本会话）">
          <button type="button" data-router-prompt-save-default style={{ ...buttonStyle(busy), ...defaultDarken }} {...defaultBind} disabled={busy} onClick={() => { void saveAsDefault() }}>
            另存为全局默认
          </button>
        </LightTooltip>
      </div>
      <div style={NOTICE_STYLE}>提示词管理已移入会话界面；设置页不再提供默认提示词编辑（默认值可在此「另存为全局默认」维护）。</div>
    </div>
  )
}
