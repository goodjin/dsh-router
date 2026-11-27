/**
 * 角色标签页（左列表 + 右编辑，显式保存）。
 *
 * 左侧：角色列表（名称 + 职责预览）+「新建角色」入口；新建即在列表里出现一条
 * 未保存草稿项并在右侧打开空编辑器。右侧：名称输入 + 职责多行编辑框（内容可能
 * 很长）+ 候选模型区（独立边框盒）+「添加模型」面板——**面板展开时**面板底部才有
 * 「确定」按钮，点它才**保存生效**（名称、说明、候选模型）；改动未保存时显示未保存
 * 标记；保存失败显示错误并保留草稿。与模型共享同一 RoleStore（按名 upsert）。
 */

import { useEffect, useSyncExternalStore, useState, type CSSProperties, type ReactNode } from 'react'

import type { CollaborationState, CollaborationStore } from './collaboration-store.ts'
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

/**
 * 候选模型区：与名称输入框、职责文本域同一套视觉语言（边框 / 圆角 / 内边距），
 * 自己是一个独立的盒子，不再是裸的一堆行。
 */
const MODELS_BOX_STYLE: CSSProperties = {
  marginTop: 12,
  padding: 10,
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, #d0d4dd)',
  background: 'var(--dsw-alias-bg-l1, #fff)',
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

/** 主操作按钮（「确定」）：描边 + 主色文字，与面板里其他小按钮区分。 */
const PRIMARY_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_STYLE,
  border: '1px solid var(--dsw-alias-accent-primary, #3b6ef6)',
  color: 'var(--dsw-alias-accent-primary, #3b6ef6)',
  fontWeight: 500,
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

/** 清单面板：嵌在候选模型盒子里，用更浅的底色与边框区分层级。 */
const CATALOG_STYLE: CSSProperties = {
  marginTop: 8,
  padding: 8,
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-l2, #f7f9fb)',
}

const CATALOG_RESULTS_STYLE: CSSProperties = {
  marginTop: 6,
  maxHeight: 220,
  overflow: 'auto',
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  borderRadius: 6,
}

const CATALOG_OPTION_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 7,
  padding: '6px 8px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  cursor: 'pointer',
  overflowWrap: 'anywhere',
}

const CATALOG_STATUS_STYLE: CSSProperties = {
  marginTop: 6,
  padding: '6px 8px',
  color: '#6b7078',
  fontSize: 12,
}

const NEW_SELECTION = '__new__'

interface CatalogOption {
  key: string
  providerId: string
  providerName: string
  modelId: string
  modelName: string
}

function modelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

function collectCatalogOptions(catalog: CollaborationState['modelCatalog']): CatalogOption[] {
  const seen = new Set<string>()
  const options: CatalogOption[] = []
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      const key = modelKey(provider.id, model.id)
      if (seen.has(key)) continue
      seen.add(key)
      options.push({
        key,
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
      })
    }
  }
  return options
}

/** trim 后拼接的候选键（与派发序列去重同一口径）。 */
function candidateKey(provider: string, model: string): string {
  return `${provider.trim()}\0${model.trim()}`
}

/** 搜索口径：关键字同时匹配 provider/model 的名称与 ID，多词 AND。 */
function matchesCatalogQuery(option: CatalogOption, terms: string[]): boolean {
  if (terms.length === 0) return true
  const fields = [option.providerId, option.providerName, option.modelId, option.modelName].map((field) => field.toLowerCase())
  return terms.every((term) => fields.some((field) => field.includes(term)))
}

interface CatalogGroup {
  providerId: string
  providerName: string
  /** 该提供方自己宣告的模型总数（不随搜索变化）。 */
  total: number
  options: CatalogOption[]
}

/** 按提供方分组并过滤：组顺序 = 清单顺序，组内只列该提供方自己宣告的模型。 */
function collectCatalogGroups(catalog: CollaborationState['modelCatalog'], query: string): CatalogGroup[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const groups: CatalogGroup[] = []
  const seen = new Set<string>()
  for (const provider of catalog.providers) {
    const options: CatalogOption[] = []
    for (const model of provider.models) {
      const key = modelKey(provider.id, model.id)
      if (seen.has(key)) continue
      seen.add(key)
      const option: CatalogOption = {
        key,
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
      }
      if (matchesCatalogQuery(option, terms)) options.push(option)
    }
    if (options.length > 0) groups.push({ providerId: provider.id, providerName: provider.name, total: provider.models.length, options })
  }
  return groups
}

/** 候选行文本态名称：清单里有就显示名称（ID），查不到只显示 ID，空行显示（未填写）。 */
function resolveModelLabel(candidate: RoleModelCandidate, catalog: CollaborationState['modelCatalog']): ReactNode {
  const providerId = candidate.provider.trim()
  const modelId = candidate.model.trim()
  if (providerId === '' && modelId === '') {
    return <span style={{ color: '#6b7078' }}>（未填写）</span>
  }
  const provider = catalog.providers.find((entry) => entry.id === providerId)
  const model = provider?.models.find((entry) => entry.id === modelId)
  if (provider !== undefined && model !== undefined) {
    return (
      <>
        <span style={{ fontWeight: 500 }}>{provider.name}</span>
        <span style={{ color: '#6b7078' }}>（{provider.id}）</span>
        <span> / </span>
        <span style={{ fontWeight: 500 }}>{model.name}</span>
        <span style={{ color: '#6b7078' }}>（{model.id}）</span>
      </>
    )
  }
  return (
    <>
      <span>{providerId}</span>
      <span> / </span>
      <span>{modelId}</span>
    </>
  )
}

/** 角色标签页：左列表右编辑，保存才生效。 */
export function RolesTab(props: { store: CollaborationStore }): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  // 默认收起编辑器：进入页面/切到本标签时不选中任何角色，右侧只显示引导占位。
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [draftName, setDraftName] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [draftModels, setDraftModels] = useState<RoleModelCandidate[]>([])
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogSelection, setCatalogSelection] = useState<Set<string>>(() => new Set())
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  // 候选列表本次是否被动过：新增/删除/上移/下移/编辑取值都算；只改名称或职责不算。
  // 保存时据此决定是否带 models——没动过就省略字段，由服务端保留文件里已有的候选。
  const [modelsTouched, setModelsTouched] = useState(false)

  useEffect(() => {
    void props.store.refreshModelCatalog()
  }, [props.store])

  const select = (name: string | undefined, isDraft = false): void => {
    setSelected(name)
    setCatalogQuery('')
    setCatalogSelection(new Set())
    setCatalogOpen(false)
    setEditingIndex(undefined)
    setModelsTouched(false)
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
    setModelsTouched(true)
  }

  const moveModel = (index: number, delta: number): void => {
    const target = index + delta
    setDraftModels((rows) => {
      if (target < 0 || target >= rows.length) return rows
      const next = rows.slice()
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item!)
      return next
    })
    setEditingIndex((current) => {
      if (current === undefined) return current
      if (current === index) return target
      if (current === target) return index
      return current
    })
    setDirty(true)
    setModelsTouched(true)
  }

  const deleteModel = (index: number): void => {
    setDraftModels((rows) => rows.filter((_, rowIndex) => rowIndex !== index))
    setEditingIndex((current) => {
      if (current === undefined) return current
      if (current === index) return undefined
      if (current > index) return current - 1
      return current
    })
    setDirty(true)
    setModelsTouched(true)
  }

  const toggleEdit = (index: number): void => {
    setEditingIndex((current) => (current === index ? undefined : index))
  }

  const isNew = selected === NEW_SELECTION
  const currentRole = isNew ? undefined : state.templates.find((t) => t.name === selected)
  const canSave = draftName.trim() !== '' && state.rolesError === null
  const catalogOptions = collectCatalogOptions(state.modelCatalog)
  const catalogGroups = collectCatalogGroups(state.modelCatalog, catalogQuery)
  const totalFiltered = catalogGroups.reduce((sum, group) => sum + group.options.length, 0)
  const addedKeys = new Set(draftModels.map((candidate) => candidateKey(candidate.provider, candidate.model)))

  /** 收起清单面板并清空搜索词与勾选（两种收起方式共用同一行为）。 */
  const closeCatalog = (): void => {
    setCatalogOpen(false)
    setCatalogQuery('')
    setCatalogSelection(new Set())
  }

  const toggleCatalog = (): void => {
    if (catalogOpen) closeCatalog()
    else setCatalogOpen(true)
  }

  /** 「添加所选」：按清单顺序（组顺序 + 组内顺序）追加，跳过与已有候选重复的 provider+model（trim 比较）。 */
  const addSelected = (): void => {
    const ordered = catalogOptions.filter((option) => catalogSelection.has(option.key))
    const toAdd = ordered.filter(
      (option) => !draftModels.some((candidate) => candidate.provider.trim() === option.providerId.trim() && candidate.model.trim() === option.modelId.trim()),
    )
    if (toAdd.length > 0) {
      setDraftModels((rows) => [...rows, ...toAdd.map((option) => ({ provider: option.providerId, model: option.modelId }))])
      setDirty(true)
      setModelsTouched(true)
    }
    // 添加后清空勾选与搜索词，但**面板保持展开**：保存按钮（「确定」）在面板里，
    // 收起就够不着保存了；用户点「收起」才收起。
    setCatalogSelection(new Set())
    setCatalogQuery('')
  }

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
            <div data-router-collab-role-models style={MODELS_BOX_STYLE}>
              <div style={{ fontSize: 12, marginBottom: 8, fontWeight: 500 }}>候选模型</div>
              {draftModels.map((candidate, index) => {
                const isEditing = editingIndex === index
                return (
                  <div key={index} data-router-collab-model-row style={ROW_STYLE}>
                    {isEditing ? (
                      <>
                        <input
                          data-router-collab-model-provider
                          style={{ ...INPUT_STYLE, flex: 1, minWidth: 0 }}
                          placeholder="provider"
                          aria-label={`候选 ${index + 1} provider`}
                          value={candidate.provider}
                          onChange={(event) => { patchModel(index, { provider: event.target.value }) }}
                        />
                        <input
                          data-router-collab-model-model
                          style={{ ...INPUT_STYLE, flex: 1, minWidth: 0 }}
                          placeholder="model"
                          aria-label={`候选 ${index + 1} model`}
                          value={candidate.model}
                          onChange={(event) => { patchModel(index, { model: event.target.value }) }}
                        />
                      </>
                    ) : (
                      <span data-router-collab-model-text style={{ flex: 1, minWidth: 0, fontSize: 12, overflowWrap: 'anywhere' }}>
                        {resolveModelLabel(candidate, state.modelCatalog)}
                      </span>
                    )}
                    <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
                      <button type="button" data-router-collab-model-up style={SMALL_BUTTON_STYLE} disabled={index === 0} onClick={() => { moveModel(index, -1) }}>上移</button>
                      <button type="button" data-router-collab-model-down style={SMALL_BUTTON_STYLE} disabled={index === draftModels.length - 1} onClick={() => { moveModel(index, 1) }}>下移</button>
                      <button type="button" data-router-collab-model-delete style={SMALL_BUTTON_STYLE} onClick={() => { deleteModel(index) }}>删除</button>
                      <button type="button" data-router-collab-model-edit style={SMALL_BUTTON_STYLE} onClick={() => { toggleEdit(index) }}>
                        {isEditing ? '收起' : '编辑'}
                      </button>
                    </span>
                  </div>
                )
              })}
              <div style={ROW_STYLE}>
                <button
                  type="button"
                  data-router-collab-catalog-open
                  style={SMALL_BUTTON_STYLE}
                  onClick={toggleCatalog}
                >
                  添加模型
                </button>
              </div>
              {catalogOpen ? (
                <div data-router-collab-catalog-panel style={CATALOG_STYLE}>
                  <div style={{ fontSize: 12, marginBottom: 6 }}>从清单添加（搜索 provider / model 的名称或 ID）</div>
                  <input
                    data-router-collab-catalog-query
                    style={INPUT_STYLE}
                    placeholder="搜索 provider / model"
                    aria-label="搜索清单"
                    value={catalogQuery}
                    onChange={(event) => { setCatalogQuery(event.target.value) }}
                  />
                  {state.modelCatalog.unavailable ? (
                    <div data-router-collab-catalog-status role="status" style={CATALOG_STATUS_STYLE}>清单不可用</div>
                  ) : catalogOptions.length === 0 ? (
                    <div data-router-collab-catalog-status role="status" style={CATALOG_STATUS_STYLE}>清单为空</div>
                  ) : totalFiltered === 0 ? (
                    <div data-router-collab-catalog-status role="status" style={CATALOG_STATUS_STYLE}>无匹配</div>
                  ) : (
                    <div data-router-collab-catalog-results style={CATALOG_RESULTS_STYLE}>
                      {catalogGroups.map((group) => (
                        <div key={group.providerId} data-router-collab-catalog-group data-router-collab-catalog-provider={group.providerId}>
                          <div style={{ padding: '6px 8px', fontWeight: 500, fontSize: 12, background: 'var(--dsw-alias-bg-l2, #f5f7fa)', borderBottom: '1px solid var(--dsw-alias-border-l2, #e4e7ec)' }}>
                            {group.providerName}
                            <span style={{ color: '#6b7078', fontWeight: 400 }}>（{group.providerId}）</span>
                            <span style={{ color: '#6b7078', fontWeight: 400 }}> · {group.total} 个模型</span>
                            {group.options.length < group.total ? (
                              <span style={{ color: '#6b7078', fontWeight: 400 }}> · {group.options.length} 个匹配</span>
                            ) : null}
                          </div>
                          {group.options.map((option) => {
                            const isAdded = addedKeys.has(candidateKey(option.providerId, option.modelId))
                            return (
                              <label
                                key={option.key}
                                data-router-collab-catalog-option
                                data-router-collab-catalog-model={option.modelId}
                                style={{ ...CATALOG_OPTION_STYLE, cursor: isAdded ? 'default' : 'pointer' }}
                              >
                                <input
                                  type="checkbox"
                                  data-router-collab-catalog-checkbox
                                  checked={catalogSelection.has(option.key)}
                                  disabled={isAdded}
                                  onChange={() => {
                                    setCatalogSelection((prev) => {
                                      const next = new Set(prev)
                                      if (next.has(option.key)) next.delete(option.key)
                                      else next.add(option.key)
                                      return next
                                    })
                                  }}
                                />
                                <span style={{ fontSize: 12 }}>
                                  <span style={{ fontWeight: 500 }}>{option.modelName}</span>
                                  <span style={{ color: '#6b7078' }}>（{option.modelId}）</span>
                                </span>
                                {isAdded ? (
                                  <span data-router-collab-catalog-added style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7078' }}>已加入</span>
                                ) : null}
                              </label>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 }}>
                    <button
                      type="button"
                      data-router-collab-catalog-add
                      style={SMALL_BUTTON_STYLE}
                      disabled={catalogSelection.size === 0}
                      onClick={addSelected}
                    >
                      添加所选（{catalogSelection.size}）
                    </button>
                    <button
                      type="button"
                      data-router-collab-catalog-clear
                      style={SMALL_BUTTON_STYLE}
                      disabled={catalogSelection.size === 0}
                      onClick={() => { setCatalogSelection(new Set()) }}
                    >
                      清空选择
                    </button>
                    <button
                      type="button"
                      data-router-collab-catalog-close
                      style={SMALL_BUTTON_STYLE}
                      onClick={closeCatalog}
                    >
                      收起
                    </button>
                    <button
                      type="button"
                      data-router-collab-role-save
                      style={{ ...PRIMARY_BUTTON_STYLE, marginLeft: 'auto', opacity: canSave ? 1 : 0.5 }}
                      disabled={!canSave}
                      onClick={() => {
                        if (props.store.get().rolesError !== null) return
                        const input: { name: string; description: string; models?: RoleModelCandidate[] } = {
                          name: draftName.trim(),
                          description: draftDesc,
                        }
                        // 候选列表被本次编辑动过才带 models；否则省略字段，由服务端保留既有候选围栏。
                        if (modelsTouched) {
                          input.models = draftModels.map((candidate) => ({ provider: candidate.provider, model: candidate.model }))
                        }
                        void props.store.saveRole(input).then((ok) => {
                          if (ok) select(draftName.trim())
                        })
                      }}
                    >
                      确定
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
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
