/**
 * 角色标签页（左列表 + 右编辑，显式保存）。
 *
 * 左侧：角色列表（名称 + 职责预览）+「新建角色」入口；新建即在列表里出现一条
 * 未保存草稿项并在右侧打开空编辑器。右侧：名称输入 + 职责多行编辑框（内容可能
 * 很长）+「保存」——**保存才生效**，改动未保存时显示未保存标记；保存失败显示
 * 错误并保留草稿。与模型共享同一 RoleStore（按名 upsert）。
 */

import { useEffect, useSyncExternalStore, useState, type CSSProperties, type ReactNode } from 'react'

import type { CollaborationStore } from './collaboration-store.ts'
import type { RoleModelCandidate } from '../collaboration/types.ts'

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

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  marginBottom: 6,
}

const SMALL_BUTTON_STYLE: CSSProperties = {
  padding: '3px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, #d8dbe0)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  fontSize: 12,
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
  const [draftModels, setDraftModels] = useState<RoleModelCandidate[]>([])
  const [catalogProvider, setCatalogProvider] = useState('')
  const [catalogModel, setCatalogModel] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    void props.store.refreshModelCatalog()
  }, [props.store])

  const select = (name: string | undefined, isDraft = false): void => {
    setSelected(name)
    setCatalogProvider('')
    setCatalogModel('')
    if (name === undefined || isDraft) {
      setDraftName('')
      setDraftDesc('')
      setDraftModels([])
    } else {
      // 读 store 当前值而非渲染快照：保存成功后的回调里快照还是旧列表。
      const role = props.store.get().templates.find((t) => t.name === name)
      setDraftName(role?.name ?? '')
      setDraftDesc(role?.description ?? '')
      setDraftModels((role?.models ?? []).map((candidate) => ({ provider: candidate.provider, model: candidate.model })))
    }
    setDirty(false)
  }

  const patchModel = (index: number, patch: Partial<RoleModelCandidate>): void => {
    setDraftModels((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
    setDirty(true)
  }

  const moveModel = (index: number, delta: number): void => {
    setDraftModels((rows) => {
      const target = index + delta
      if (target < 0 || target >= rows.length) return rows
      const next = rows.slice()
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item!)
      return next
    })
    setDirty(true)
  }

  const isNew = selected === NEW_SELECTION
  const currentRole = isNew ? undefined : state.templates.find((t) => t.name === selected)
  const canSave = draftName.trim() !== '' && state.rolesError === null
  const catalogProviders = state.modelCatalog.providers
  const catalogModels = catalogProviders.find((provider) => provider.id === catalogProvider)?.models ?? []

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
            <div data-router-collab-role-models style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, marginBottom: 6 }}>候选模型</div>
              {draftModels.map((candidate, index) => (
                <div key={index} data-router-collab-model-row style={ROW_STYLE}>
                  <input
                    data-router-collab-model-provider
                    style={{ ...INPUT_STYLE, flex: 1 }}
                    placeholder="provider"
                    aria-label={`候选 ${index + 1} provider`}
                    value={candidate.provider}
                    onChange={(event) => { patchModel(index, { provider: event.target.value }) }}
                  />
                  <input
                    data-router-collab-model-model
                    style={{ ...INPUT_STYLE, flex: 1 }}
                    placeholder="model"
                    aria-label={`候选 ${index + 1} model`}
                    value={candidate.model}
                    onChange={(event) => { patchModel(index, { model: event.target.value }) }}
                  />
                  <button type="button" data-router-collab-model-up style={SMALL_BUTTON_STYLE} disabled={index === 0} onClick={() => { moveModel(index, -1) }}>上移</button>
                  <button type="button" data-router-collab-model-down style={SMALL_BUTTON_STYLE} disabled={index === draftModels.length - 1} onClick={() => { moveModel(index, 1) }}>下移</button>
                  <button
                    type="button"
                    data-router-collab-model-delete
                    style={SMALL_BUTTON_STYLE}
                    onClick={() => {
                      setDraftModels((rows) => rows.filter((_, rowIndex) => rowIndex !== index))
                      setDirty(true)
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
              <div style={ROW_STYLE}>
                <button
                  type="button"
                  data-router-collab-model-add
                  style={SMALL_BUTTON_STYLE}
                  onClick={() => {
                    setDraftModels((rows) => [...rows, { provider: '', model: '' }])
                    setDirty(true)
                  }}
                >
                  添加一行
                </button>
              </div>
              <div style={ROW_STYLE}>
                <select
                  data-router-collab-catalog-provider
                  style={{ ...INPUT_STYLE, flex: 1 }}
                  aria-label="清单 provider"
                  value={catalogProvider}
                  onChange={(event) => {
                    setCatalogProvider(event.target.value)
                    setCatalogModel('')
                  }}
                >
                  <option value="">{state.modelCatalog.unavailable ? '清单不可用' : '选择 provider'}</option>
                  {catalogProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name}</option>
                  ))}
                </select>
                <select
                  data-router-collab-catalog-model
                  style={{ ...INPUT_STYLE, flex: 1 }}
                  aria-label="清单 model"
                  value={catalogModel}
                  onChange={(event) => { setCatalogModel(event.target.value) }}
                >
                  <option value="">选择 model</option>
                  {catalogModels.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  data-router-collab-catalog-add
                  style={SMALL_BUTTON_STYLE}
                  disabled={catalogProvider === '' || catalogModel === ''}
                  onClick={() => {
                    setDraftModels((rows) => [...rows, { provider: catalogProvider, model: catalogModel }])
                    setDirty(true)
                  }}
                >
                  从清单添加
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <button
                type="button"
                data-router-collab-role-save
                style={{ ...BUTTON_STYLE, opacity: canSave ? 1 : 0.5 }}
                disabled={!canSave}
                onClick={() => {
                  if (props.store.get().rolesError !== null) return
                  const models = draftModels.map((candidate) => ({ provider: candidate.provider, model: candidate.model }))
                  void props.store.saveRole({ name: draftName.trim(), description: draftDesc, models }).then((ok) => {
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
