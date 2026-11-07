/**
 * 系统提示词编辑器纯逻辑测试（v1.1 计划 Task C5，先红后绿）。
 *
 * 脏检查/保存可用性/重置确认/未保存提示——零 React、零 fetch，组件
 * （prompt-editor.tsx）只消费这里。重置语义：prompt 空串 = 清除覆盖回落默认；
 * 已是默认且无未保存修改时「重置默认」没有实际效果，按钮应禁用。
 */

import { describe, expect, it } from 'vitest'

import {
  canResetEditor,
  canSavePrompt,
  loadEditorState,
  isPromptDirty,
  resetConfirmMessage,
  savedEditorState,
  unsavedNotice,
} from '../src/client/prompt-editor-model.ts'

describe('提示词编辑器状态（C5）', () => {
  it('loadEditorState：基线=文本=当前生效文本，isDefault 随服务端标记', () => {
    const override = loadEditorState('本会话覆盖', false)
    expect(override).toEqual({ baseline: '本会话覆盖', text: '本会话覆盖', isDefault: false })
    const fallback = loadEditorState('默认提示词', true)
    expect(fallback).toEqual({ baseline: '默认提示词', text: '默认提示词', isDefault: true })
  })

  it('脏检查：改过文本为脏，与基线一致为干净（含空白差异也算改动）', () => {
    const state = loadEditorState('基线', false)
    expect(isPromptDirty({ ...state, text: '基线' })).toBe(false)
    expect(isPromptDirty({ ...state, text: '改过' })).toBe(true)
    expect(isPromptDirty({ ...state, text: '基线 ' })).toBe(true)
  })

  it('保存可用性：脏才可保存', () => {
    const state = loadEditorState('基线', false)
    expect(canSavePrompt({ ...state, text: '基线' })).toBe(false)
    expect(canSavePrompt({ ...state, text: '改过' })).toBe(true)
  })

  it('未保存提示：脏时给提示文案，干净时为 null', () => {
    const state = loadEditorState('基线', false)
    expect(unsavedNotice({ ...state, text: '改过' })).toBeTruthy()
    expect(unsavedNotice({ ...state, text: '基线' })).toBeNull()
  })

  it('重置默认可用性：已是默认且干净 → 不可点（重置无实际效果）；有覆盖或脏 → 可点', () => {
    const clean = loadEditorState('默认提示词', true)
    expect(canResetEditor(clean)).toBe(false)
    expect(canResetEditor({ ...clean, text: '改过' })).toBe(true)
    const override = loadEditorState('覆盖文本', false)
    expect(canResetEditor(override)).toBe(true)
  })

  it('重置确认文案：脏时明说丢弃未保存修改；干净覆盖时明说清除覆盖回落默认', () => {
    const cleanOverride = loadEditorState('覆盖文本', false)
    expect(resetConfirmMessage(cleanOverride)).toMatch(/默认/)
    expect(resetConfirmMessage(cleanOverride)).toMatch(/覆盖|自定义/)

    const dirty = loadEditorState('默认提示词', true)
    const dirtyMessage = resetConfirmMessage({ ...dirty, text: '改了一半' })
    expect(dirtyMessage).toMatch(/未保存|丢弃/)
  })

  it('保存成功后的新基线：非空保存 = 有覆盖；空串保存 = 回默认且文本清空', () => {
    const state = loadEditorState('旧覆盖', false)
    const saved = savedEditorState(state, '新文本')
    expect(saved).toEqual({ baseline: '新文本', text: '新文本', isDefault: false })
    expect(isPromptDirty(saved)).toBe(false)

    const cleared = savedEditorState(state, '')
    expect(cleared.isDefault).toBe(true)
    expect(cleared.text).toBe('')
    expect(isPromptDirty(cleared)).toBe(false)
  })
})
