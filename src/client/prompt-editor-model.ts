/**
 * 系统提示词编辑器纯逻辑（v1.1 计划 Task C5，规格 §7）：脏检查、保存/重置
 * 可用性、未保存提示与重置确认文案。零 React、零 fetch——组件
 * （prompt-editor.tsx）只消费这里，测试直接打纯函数（不启 DOM）。
 *
 * 语义口径：
 * - 基线（baseline）= 打开面板或最近一次保存成功时的「服务端真相」；脏 =
 *   编辑文本与基线不同（含纯空白差异——提示词是整段替换文本，空白也是内容）。
 * - 重置默认 = 保存空串（宿主清除覆盖回落 defaults）；「已是默认且干净」时
 *   重置没有任何实际效果，按钮禁用。
 * - 保存成功后的新基线由本模块给出：非空 = 有覆盖，空串 = 回默认且文本清空。
 */

/** 编辑器状态（组件持有的最小面）。 */
export interface PromptEditorState {
  /** 打开面板 / 最近一次保存成功时的生效文本（服务端真相）。 */
  baseline: string
  /** 编辑器当前内容。 */
  text: string
  /** 基线是否为默认（无会话覆盖）。 */
  isDefault: boolean
}

/** 服务端取回（GET /router/prompt）→ 编辑器初始状态。 */
export function loadEditorState(prompt: string, isDefault: boolean): PromptEditorState {
  return { baseline: prompt, text: prompt, isDefault }
}

/** 脏检查：编辑文本与基线不同即为脏。 */
export function isPromptDirty(state: PromptEditorState): boolean {
  return state.text !== state.baseline
}

/** 保存可用性：脏才可保存。 */
export function canSavePrompt(state: PromptEditorState): boolean {
  return isPromptDirty(state)
}

/** 未保存提示文案；干净时 null（不渲染提示条）。 */
export function unsavedNotice(state: PromptEditorState): string | null {
  return isPromptDirty(state) ? '有未保存的修改' : null
}

/** 重置默认可用性：有覆盖（会改现状）或有未保存修改（会丢编辑）才可点。 */
export function canResetEditor(state: PromptEditorState): boolean {
  return !state.isDefault || isPromptDirty(state)
}

/** 重置确认文案（window.confirm 用）：脏时明说丢弃修改，干净覆盖时明说回落默认。 */
export function resetConfirmMessage(state: PromptEditorState): string {
  return isPromptDirty(state)
    ? '有未保存的修改，重置将一并丢弃，恢复为默认系统提示词？'
    : '清除本会话的自定义覆盖，恢复为默认系统提示词？'
}

/** 保存成功后的新基线：savedText 为保存时上送的文本（空串 = 清除回落默认）。 */
export function savedEditorState(state: PromptEditorState, savedText: string): PromptEditorState {
  return { baseline: savedText, text: savedText, isDefault: savedText === '' }
}
