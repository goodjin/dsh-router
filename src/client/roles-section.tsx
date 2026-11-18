/**
 * 角色模板区（协作视图页页底分区，自旧面板移植）。
 *
 * 与模型工具共享同一 RoleStore（经 store.saveRole → POST /roles）：用户在这里
 * 创建/编辑的角色，模型侧立刻可见。明文名称/描述（空描述合法）；失败显示并保留草稿。
 */

import { useSyncExternalStore, useState, type ReactNode } from 'react'

import type { CollaborationStore } from './collaboration-store.ts'

const SECTION_STYLE = {
  marginTop: 16,
  paddingTop: 12,
  borderTop: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
} as const

const ERROR_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-state-error-primary, #d93025)',
  background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d93025) 8%, transparent)',
  color: 'var(--dsw-alias-state-error-primary, #d93025)',
  fontSize: 12,
} as const

const BUTTON_STYLE = {
  padding: '2px 8px',
  borderRadius: 5,
  border: '1px solid var(--dsw-alias-border-l2, #d8dbe0)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  fontSize: 12,
} as const

const INPUT_STYLE = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, #d0d4dd)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: 12,
} as const

/** 角色模板区：列表 + 新建/编辑表单（表单状态自持）。 */
export function RolesSection(props: { store: CollaborationStore }): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const [roleName, setRoleName] = useState('')
  const [roleDesc, setRoleDesc] = useState('')
  const canSave = roleName.trim() !== ''
  return (
    <section data-router-collab-roles-section style={SECTION_STYLE}>
      <strong>角色模板</strong>
      {state.rolesError !== null ? (
        <div data-router-collab-roles-error style={ERROR_STYLE} role="alert">
          <span style={{ flex: 1 }}>{state.rolesError}</span>
          <button type="button" data-router-collab-roles-retry style={BUTTON_STYLE} onClick={() => { void props.store.refreshRoles() }}>
            重试
          </button>
        </div>
      ) : null}
      <div data-router-collab-templates style={{ marginTop: 6 }}>
        {state.templates.length === 0
          ? <div style={{ fontSize: 12, color: '#6b7078' }}>暂无角色模板</div>
          : state.templates.map((template) => (
            <div key={template.name} data-router-collab-template={template.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ flex: 1, fontSize: 12 }}>
                {template.name}
                {template.description !== '' ? <span style={{ color: '#6b7078' }}> — {template.description}</span> : null}
              </span>
              <button
                type="button"
                data-router-collab-role-edit={template.name}
                style={BUTTON_STYLE}
                onClick={() => {
                  setRoleName(template.name)
                  setRoleDesc(template.description)
                }}
              >
                编辑
              </button>
            </div>
          ))}
      </div>
      <div style={{ marginTop: 8, maxWidth: 420 }}>
        <input
          data-router-collab-role-name
          style={{ ...INPUT_STYLE, marginBottom: 4 }}
          placeholder="角色名称（必填；同名保存即更新）"
          value={roleName}
          onChange={(event) => { setRoleName(event.target.value) }}
        />
        <input
          data-router-collab-role-desc
          style={INPUT_STYLE}
          placeholder="职责说明（明文，可留空）"
          value={roleDesc}
          onChange={(event) => { setRoleDesc(event.target.value) }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button
            type="button"
            data-router-collab-role-save
            style={{ ...BUTTON_STYLE, opacity: canSave ? 1 : 0.5 }}
            disabled={!canSave}
            onClick={() => {
              void props.store.saveRole({ name: roleName.trim(), description: roleDesc }).then((ok) => {
                if (ok) {
                  setRoleName('')
                  setRoleDesc('')
                }
              })
            }}
          >
            保存角色
          </button>
        </div>
        {state.saveError !== null ? (
          <div data-router-collab-role-error style={{ ...ERROR_STYLE, marginTop: 6 }} role="alert">
            {state.saveError}
          </div>
        ) : null}
      </div>
    </section>
  )
}
