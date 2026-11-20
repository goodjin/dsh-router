/**
 * 角色标签页（左列表 + 右编辑，显式保存）。
 *
 * 左侧：角色列表（名称 + 职责预览）+「新建角色」入口；新建即在列表里出现一条
 * 未保存草稿项并在右侧打开空编辑器。右侧：名称输入 + 职责多行编辑框（内容可能
 * 很长）+「保存」——**保存才生效**，改动未保存时显示未保存标记；保存失败显示
 * 错误并保留草稿。与模型共享同一 RoleStore（按名 upsert）。
 */

import { useSyncExternalStore, useState, type CSSProperties, type ReactNode } from 'react'

import type { CollaborationStore } from './collaboration-store.ts'

const LAYOUT_STYLE: CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'flex-start',
  marginTop: 12,
}

const LIST_STYLE: CSSProperties = {
  width: 240,
  flexShrink: 0,
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  padding: 6,
  maxHeight: 520,
  overflow: 'auto',
}

const ITEM_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'start',
  padding: '7px 9px',
  marginBottom: 4,
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1.4,
}

const ITEM_SELECTED_STYLE: CSSProperties = {
  ...ITEM_STYLE,
  border: '1px solid var(--dsw-alias-accent-primary, #3b6ef6)',
  background: 'color-mix(in srgb, var(--dsw-alias-accent-primary, #3b6ef6) 6%, transparent)',
}

const NEW_BUTTON_STYLE: CSSProperties = {
  ...ITEM_STYLE,
  color: 'var(--dsw-alias-accent-primary, #3b6ef6)',
}

const EDITOR_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  padding: 12,
  fontSize: 13,
}

const INPUT_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, #d0d4dd)',
  background: 'var(--dsw-alias-bg-l1, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: 12,
}

const TEXTAREA_STYLE: CSSProperties = {
  ...INPUT_STYLE,
  minHeight: 440,
  resize: 'vertical',
  fontFamily: 'inherit',
  whiteSpace: 'pre-wrap',
}

const BUTTON_STYLE: CSSProperties = {
  padding: '4px 14px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, #d8dbe0)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  fontSize: 12,
}

const ERROR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-state-error-primary, #d93025)',
  background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d93025) 8%, transparent)',
  color: 'var(--dsw-alias-state-error-primary, #d93025)',
  fontSize: 12,
}

const NEW_SELECTION = '__new__'

/** 角色标签页：左列表右编辑，保存才生效。 */
export function RolesTab(props: { store: CollaborationStore }): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  // 默认收起编辑器：进入页面/切到本标签时不选中任何角色，右侧只显示引导占位。
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [draftName, setDraftName] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [dirty, setDirty] = useState(false)

  const select = (name: string | undefined, isDraft = false): void => {
    setSelected(name)
    if (name === undefined || isDraft) {
      setDraftName('')
      setDraftDesc('')
    } else {
      // 读 store 当前值而非渲染快照：保存成功后的回调里快照还是旧列表。
      const role = props.store.get().templates.find((t) => t.name === name)
      setDraftName(role?.name ?? '')
      setDraftDesc(role?.description ?? '')
    }
    setDirty(false)
  }

  const isNew = selected === NEW_SELECTION
  const currentRole = isNew ? undefined : state.templates.find((t) => t.name === selected)
  const canSave = draftName.trim() !== ''

  return (
    <div data-router-collab-roles-tab style={LAYOUT_STYLE}>
      <aside data-router-collab-role-list style={LIST_STYLE}>
        {state.templates.map((role) => (
          <button
            key={role.name}
            type="button"
            data-router-collab-role-item={role.name}
            style={role.name === selected ? ITEM_SELECTED_STYLE : ITEM_STYLE}
            onClick={() => { select(role.name) }}
          >
            <span style={{ display: 'block', fontWeight: 500 }}>{role.name}</span>
            {role.description !== '' ? (
              <span style={{ display: 'block', color: '#6b7078', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {role.description.slice(0, 40)}
              </span>
            ) : null}
          </button>
        ))}
        {isNew ? (
          <div data-router-collab-role-item="__draft__" style={{ ...ITEM_SELECTED_STYLE, cursor: 'default' }}>
            <span style={{ display: 'block', fontWeight: 500 }}>{draftName.trim() === '' ? '新角色（未保存）' : `${draftName.trim()}（未保存）`}</span>
          </div>
        ) : null}
        <button type="button" data-router-collab-role-new style={NEW_BUTTON_STYLE} onClick={() => { select(NEW_SELECTION, true) }}>
          ＋ 新建角色
        </button>
      </aside>
      <section data-router-collab-role-editor style={EDITOR_STYLE}>
        {selected === undefined ? (
          <div style={{ fontSize: 12, color: '#6b7078' }}>在左侧选择一个角色查看，或新建角色。</div>
        ) : (
          <>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>角色名称</label>
            <input
              data-router-collab-role-name
              style={INPUT_STYLE}
              placeholder="角色名称（必填；同名保存即更新）"
              value={draftName}
              onChange={(event) => { setDraftName(event.target.value); setDirty(true) }}
            />
            <label style={{ display: 'block', fontSize: 12, margin: '10px 0 4px' }}>职责说明（派发时注入子会话初始指令）</label>
            <textarea
              data-router-collab-role-desc
              style={TEXTAREA_STYLE}
              placeholder="职责说明：做什么、报告给谁、边界是什么。支持多行，可直接手工编辑同名 md 文件。"
              value={draftDesc}
              onChange={(event) => { setDraftDesc(event.target.value); setDirty(true) }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <button
                type="button"
                data-router-collab-role-save
                style={{ ...BUTTON_STYLE, opacity: canSave ? 1 : 0.5 }}
                disabled={!canSave}
                onClick={() => {
                  void props.store.saveRole({ name: draftName.trim(), description: draftDesc }).then((ok) => {
                    if (ok) select(draftName.trim())
                  })
                }}
              >
                保存
              </button>
              {dirty ? (
                <span data-router-collab-role-dirty style={{ fontSize: 12, color: '#e08a1e' }}>未保存</span>
              ) : currentRole !== undefined ? (
                <span style={{ fontSize: 11, color: '#6b7078' }}>md 文件：{currentRole.name}.md（可直接手工编辑）</span>
              ) : null}
            </div>
            {state.rolesError !== null ? (
              <div data-router-collab-roles-error style={{ ...ERROR_STYLE, marginTop: 10 }} role="alert">
                <span style={{ flex: 1 }}>{state.rolesError}</span>
                <button type="button" data-router-collab-roles-retry style={BUTTON_STYLE} onClick={() => { void props.store.refreshRoles() }}>
                  重试
                </button>
              </div>
            ) : null}
            {state.saveError !== null ? (
              <div data-router-collab-role-error style={{ ...ERROR_STYLE, marginTop: 10 }} role="alert">
                {state.saveError}
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}
