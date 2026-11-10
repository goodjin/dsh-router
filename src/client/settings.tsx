/**
 * 设置段（「Router 管理」栏目；2026-11-10 设置页收敛后三块）。
 *
 * 挂点 settings.section（slot key 以 R3 报告为准）。栏目：
 * 1. 原偏好展示（pollMs/浮窗/活动卡上限——client-prefs 只读，写通道同前）；
 * 2. 派生模式选择（说明文案按 2026-11-10 分叉范围裁定如实表述）；
 * 3. Worker 类型管理：列表（名称/角色/模型/启用态/来源）+ 行内操作（禁用/启用/
 *    删除，builtin 无删除不可禁用）+ **新建**表单（名称、描述、角色、模型有序
 *    列表）。类型**无编辑入口**（要改就删了重建）；**不再挂技能**（有提示词就够）。
 *    「Router 默认」区已整体移除：Router 身份由预设 persona 直定，无需默认模型。
 *
 * 样式基线（规格 §9）：全部浅色，无黑底回退；悬浮提示一律 ui-kit 的
 * LightTooltip（禁原生 title），hover 反馈一律「颜色稍变深」（useHoverDarken）。
 * 交互的纯逻辑（校验/归一化/reducer）在 settings-model.ts，本文件只做组装。
 */

import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import type { RouterApi } from './api.ts'
import type { ClientPrefsStore } from './client-prefs.ts'
import {
  SPAWN_MODE_MODEL_HINT,
  canDisableRecord,
  canRemoveRecord,
  initialTypeManageState,
  isFormDirty,
  modelCatalogOf,
  normalizeTypeForm,
  originLabel,
  roleLabel,
  spawnModeDescription,
  spawnModeLabel,
  typeManageReducer,
  validateTypeForm,
  type TypeFormState,
  type TypeManageAction,
} from './settings-model.ts'
import { SETTINGS_ID, SETTINGS_ORDER, SETTINGS_SLOT } from './surface-ids.ts'
import { LightTooltip, useHoverDarken } from './ui-kit.tsx'
import type { SlotsHost } from './workbench-tabs.tsx'
import type { WorkerSpawnMode, WorkerTypeRecord } from '../shared/view-contract.ts'

/** 组件的业务输入。 */
export interface SettingsFace {
  prefs: ClientPrefsStore
  api: RouterApi
}

export type SettingsSectionProps = SettingsFace

/** 设置段的 rail 行文字（thunk；将来接 locale 时在这里换）。 */
export function settingsLabel(): string {
  return 'Router'
}

/** 把设置段注册进 settings.section（entry.spec 断言键名/id）。 */
export function registerSettingsSection(slots: SlotsHost, face: SettingsFace): void {
  slots.inject(SETTINGS_SLOT, () => slots.register(
    { name: SETTINGS_SLOT, id: SETTINGS_ID, order: SETTINGS_ORDER, label: settingsLabel, inject: () => face },
    RouterSettingsSection,
  ))
}

/* ────────────────────────── 样式（浅色基线，无黑底回退） ────────────────────────── */

const PAGE_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  maxWidth: 720,
  fontSize: 13,
  lineHeight: 1.6,
}

const CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 10,
  border: '1px solid var(--dsh-color-border, #d0d4dd)',
  background: 'var(--dsh-color-bg-elevated, #f7f8fa)',
  color: 'inherit',
}

const SECTION_TITLE_STYLE: CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsh-color-border, #d0d4dd)',
}

const TYPE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsh-color-border, #d0d4dd)',
  background: 'var(--dsh-color-bg, #ffffff)',
}

const FIELD_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsh-color-border, #d0d4dd)',
  background: 'var(--dsh-color-bg, #ffffff)',
  color: 'inherit',
  fontSize: 12,
}

const SMALL_BUTTON_STYLE: CSSProperties = {
  padding: '3px 10px',
  borderRadius: 6,
  border: '1px solid var(--dsh-color-border, #d0d4dd)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const PRIMARY_BUTTON_STYLE: CSSProperties = {
  ...SMALL_BUTTON_STYLE,
  border: 'none',
  background: 'var(--dsh-color-primary, #4f6bed)',
  color: '#fff',
}

const DANGER_BUTTON_STYLE: CSSProperties = {
  ...SMALL_BUTTON_STYLE,
  borderColor: 'var(--dsh-color-danger, #d93025)',
  color: 'var(--dsh-color-danger, #d93025)',
}

const TAG_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 8px',
  borderRadius: 999,
  border: '1px solid var(--dsh-color-border, #d0d4dd)',
  fontSize: 11,
  lineHeight: '20px',
  whiteSpace: 'nowrap',
}

const NOTE_STYLE: CSSProperties = { fontSize: 12, opacity: 0.75 }

const PROBLEM_STYLE: CSSProperties = { fontSize: 12, color: 'var(--dsh-color-danger, #d93025)' }

const FIELD_LABEL_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }

/* ────────────────────────── 通用小件 ────────────────────────── */

/** 带 hover 稍深反馈的小按钮（规格 §9：hover 一律颜色稍变深）。 */
function HoverButton(props: {
  label: string
  onClick(): void
  style?: CSSProperties
  disabled?: boolean
  dataTag?: string
}): ReactNode {
  const [darken, bind] = useHoverDarken()
  return (
    <button
      type="button"
      data-router-settings-button={props.dataTag}
      style={{ ...(props.style ?? SMALL_BUTTON_STYLE), ...(props.disabled === true ? { opacity: 0.5, cursor: 'default' } : {}), ...darken }}
      disabled={props.disabled}
      onClick={props.onClick}
      {...bind}
    >
      {props.label}
    </button>
  )
}

/** 列表/表单共用的来源标记。 */
function OriginTag(props: { origin: WorkerTypeRecord['origin'] }): ReactNode {
  return (
    <LightTooltip label={props.origin === 'builtin' ? '内置兜底类型：不可编辑/禁用/删除' : props.origin === 'router' ? 'Router 会话里现场创建的类型' : '设置页手动创建的类型'}>
      <span style={TAG_STYLE} data-router-type-origin={props.origin}>{originLabel(props.origin)}</span>
    </LightTooltip>
  )
}

/* ────────────────────────── 类型行 ────────────────────────── */

function TypeRow(props: {
  record: WorkerTypeRecord
  busy: boolean
  armedRemove: string | null
  onToggle(record: WorkerTypeRecord): void
  onArmRemove(templateId: string): void
  onConfirmRemove(templateId: string): void
}): ReactNode {
  const { record } = props
  const removeArmed = props.armedRemove === record.templateId
  return (
    <div style={TYPE_ROW_STYLE} data-router-type-row={record.templateId}>
      <strong>{record.name}</strong>
      <span style={TAG_STYLE}>{roleLabel(record.role)}</span>
      <OriginTag origin={record.origin} />
      <span style={NOTE_STYLE}>
        模型 {record.models.length} 个{record.models.length > 0 ? `（默认 ${record.models[0]}）` : ''}
      </span>
      <span style={{ ...TAG_STYLE, opacity: record.enabled ? 1 : 0.6 }} data-router-type-enabled={String(record.enabled)}>
        {record.enabled ? '已启用' : '已禁用'}
      </span>
      <span style={{ display: 'inline-flex', gap: 6, marginLeft: 'auto' }}>
        {record.enabled ? (
          canDisableRecord(record) ? (
            <LightTooltip label="禁用后保留预设注册，仅拒绝新派发；已建会话不受影响">
              <HoverButton label="禁用" dataTag={`disable-${record.templateId}`} disabled={props.busy} onClick={() => props.onToggle(record)} />
            </LightTooltip>
          ) : (
            <LightTooltip label="内置通用 worker 不可禁用（保证任何情况下可派发）">
              <HoverButton label="禁用" dataTag={`disable-${record.templateId}`} disabled onClick={() => undefined} />
            </LightTooltip>
          )
        ) : (
          <LightTooltip label="重新启用该类型（新派发恢复可用）">
            <HoverButton label="启用" dataTag={`enable-${record.templateId}`} disabled={props.busy} onClick={() => props.onToggle(record)} />
          </LightTooltip>
        )}
        {canRemoveRecord(record) ? (
          removeArmed ? (
            <LightTooltip label="再点一次确认删除。已关闭的该类型会话将无法重开，重建同名类型可恢复">
              <HoverButton label="确认删除" dataTag={`confirm-remove-${record.templateId}`} style={DANGER_BUTTON_STYLE} disabled={props.busy} onClick={() => props.onConfirmRemove(record.templateId)} />
            </LightTooltip>
          ) : (
            <LightTooltip label="删除 = 注销动态预设；已关闭的该类型会话将无法重开，重建同名类型可恢复">
              <HoverButton label="删除" dataTag={`remove-${record.templateId}`} disabled={props.busy} onClick={() => props.onArmRemove(record.templateId)} />
            </LightTooltip>
          )
        ) : (
          <LightTooltip label="内置类型不可删除">
            <HoverButton label="删除" dataTag={`remove-${record.templateId}`} disabled onClick={() => undefined} />
          </LightTooltip>
        )}
      </span>
    </div>
  )
}

/* ────────────────────────── 模型有序列表编辑器 ────────────────────────── */

function ModelsEditor(props: {
  models: string[]
  catalog: string[]
  disabled?: boolean
  onChange(models: string[]): void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const selectable = props.catalog.filter((entry) => !props.models.includes(entry))
  const move = (index: number, delta: number): void => {
    const next = [...props.models]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    props.onChange(next)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-router-models-editor>
      {props.models.length === 0 ? <span style={NOTE_STYLE}>暂无模型（该类型会话跟随宿主默认路由）</span> : null}
      {props.models.map((model, index) => (
        <div key={`${model}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={NOTE_STYLE}>{index === 0 ? '默认' : `候选${index}`}</span>
          <span style={TAG_STYLE}>{model}</span>
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <HoverButton label="↑" dataTag={`model-up-${index}`} disabled={props.disabled || index === 0} onClick={() => move(index, -1)} />
            <HoverButton label="↓" dataTag={`model-down-${index}`} disabled={props.disabled || index === props.models.length - 1} onClick={() => move(index, 1)} />
            <HoverButton label="移除" dataTag={`model-remove-${index}`} disabled={props.disabled} onClick={() => props.onChange(props.models.filter((_, i) => i !== index))} />
          </span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          data-router-model-add
          style={FIELD_STYLE}
          value=""
          disabled={props.disabled || selectable.length === 0}
          onChange={(event) => {
            const value = event.target.value
            if (value !== '') props.onChange([...props.models, value])
          }}
        >
          <option value="">{selectable.length === 0 ? '候选清单已全部选用' : '从候选模型添加…'}</option>
          {selectable.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
        <input
          data-router-model-custom
          style={FIELD_STYLE}
          placeholder="或填 provider/model"
          value={draft}
          disabled={props.disabled}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <LightTooltip label="追加一个模型引用（provider/model）；首个为默认模型">
          <HoverButton
            label="添加"
            dataTag="model-add-custom"
            disabled={props.disabled || draft.trim() === ''}
            onClick={() => {
              props.onChange([...props.models, draft.trim()])
              setDraft('')
            }}
          />
        </LightTooltip>
      </div>
    </div>
  )
}

/* ────────────────────────── 新建表单 ────────────────────────── */

function TypeForm(props: {
  api: RouterApi
  editing: TypeFormState
  baseline: TypeFormState | null
  confirmDiscard: boolean
  busy: boolean
  error: string | null
  modelCatalog: string[]
  dispatch(action: TypeManageAction): void
  onSaved(record: WorkerTypeRecord): void
}): ReactNode {
  const { editing, dispatch, api } = props
  const problems = validateTypeForm(editing)
  const dirty = isFormDirty(editing, props.baseline)
  const isNew = editing.templateId === null

  async function submit(): Promise<void> {
    if (problems['name'] !== null) return
    dispatch({ type: 'save-start' })
    try {
      const normalized = normalizeTypeForm(editing)
      // 不带 systemPrompt/skills 键：宿主按角色补默认提示词；类型不挂技能。
      props.onSaved(await api.createWorkerType(normalized))
    } catch (caught) {
      dispatch({ type: 'op-failed', message: caught instanceof Error ? caught.message : String(caught) })
    }
  }

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 8, border: '1px solid var(--dsh-color-border, #d0d4dd)', background: 'var(--dsh-color-bg, #ffffff)' }}
      data-router-type-form={isNew ? 'new' : editing.templateId!}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <strong>新建 worker 类型</strong>
      <label style={FIELD_LABEL_STYLE}>
        <span>名称（必填）</span>
        <input data-router-type-name value={editing.name} autoFocus onChange={(event) => { dispatch({ type: 'form-change', patch: { name: event.target.value } }) }} />
        {problems['name'] !== null ? <span style={PROBLEM_STYLE}>{problems['name']}</span> : null}
      </label>
      <label style={FIELD_LABEL_STYLE}>
        <span>描述</span>
        <input data-router-type-description value={editing.description} onChange={(event) => { dispatch({ type: 'form-change', patch: { description: event.target.value } }) }} />
      </label>
      <label style={FIELD_LABEL_STYLE}>
        <span>角色</span>
        <select
          data-router-type-role
          style={FIELD_STYLE}
          value={editing.role}
          onChange={(event) => { dispatch({ type: 'form-change', patch: { role: event.target.value === 'supervisor' ? 'supervisor' : 'worker' } }) }}
        >
          <option value="worker">worker（执行者）</option>
          <option value="supervisor">supervisor（可继续拆分子任务）</option>
        </select>
      </label>
      <div style={FIELD_LABEL_STYLE}>
        <span>允许模型（有序：首个为该类型会话默认模型，其余为候选）</span>
        <ModelsEditor
          models={editing.models}
          catalog={props.modelCatalog}
          onChange={(models) => { dispatch({ type: 'form-change', patch: { models } }) }}
        />
      </div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input
          type="checkbox"
          data-router-type-enabled
          checked={editing.enabled}
          onChange={(event) => { dispatch({ type: 'form-change', patch: { enabled: event.target.checked } }) }}
        />
        <span>启用该类型{isNew ? '' : '（与列表上的启用态一致，保存时一并生效）'}</span>
      </label>
      {dirty ? <div style={NOTE_STYLE} data-router-form-dirty>有未保存的更改。</div> : null}
      {props.error !== null ? <div style={PROBLEM_STYLE} data-router-form-error>{props.error}</div> : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <LightTooltip label={dirty && props.confirmDiscard ? '再点一次「放弃」确认丢弃更改' : '回到列表'}>
          <HoverButton
            label={props.confirmDiscard ? '确认放弃更改？' : '取消'}
            dataTag="form-cancel"
            onClick={() => { dispatch({ type: 'form-cancel' }) }}
          />
        </LightTooltip>
        {props.confirmDiscard ? (
          <HoverButton label="不放弃，继续编辑" dataTag="form-resume" onClick={() => { dispatch({ type: 'form-change', patch: {} }) }} />
        ) : null}
        <LightTooltip label="创建类型（即刻注册动态预设；系统提示词按角色取默认，worker 收到时经身份切换卡生效）">
          <HoverButton
            label={props.busy ? '保存中…' : '创建'}
            dataTag="form-save"
            style={PRIMARY_BUTTON_STYLE}
            disabled={props.busy || problems['name'] !== null}
            onClick={() => { void submit() }}
          />
        </LightTooltip>
      </div>
    </form>
  )
}

/* ────────────────────────── 设置段主体 ────────────────────────── */

function seconds(pollMs: number): string {
  const value = pollMs / 1000
  return Number.isInteger(value) ? `${value} 秒` : `${value.toFixed(1)} 秒`
}

function onOff(enabled: boolean): string {
  return enabled ? '开' : '关'
}

/** 设置段：偏好展示 + 派生模式 + Worker 类型管理（2026-11-10 收敛后三块）。 */
export function RouterSettingsSection(props: SettingsSectionProps): ReactNode {
  const prefs = useSyncExternalStore(props.prefs.subscribe, props.prefs.get)
  const [state, dispatch] = useReducer(typeManageReducer, undefined, initialTypeManageState)

  const reload = useCallback(async (): Promise<void> => {
    dispatch({ type: 'load-start' })
    try {
      const [types, spawn] = await Promise.all([
        props.api.listWorkerTypes(),
        props.api.getSpawnMode(),
      ])
      dispatch({ type: 'loaded', types })
      dispatch({ type: 'spawn-loaded', mode: spawn.mode })
    } catch (caught) {
      dispatch({ type: 'load-failed', message: caught instanceof Error ? caught.message : String(caught) })
    }
  }, [props.api])

  useEffect(() => { void reload() }, [reload])

  async function toggleRecord(record: WorkerTypeRecord): Promise<void> {
    dispatch({ type: 'toggle-start' })
    try {
      const updated = await props.api.setWorkerTypeEnabled({ templateId: record.templateId, enabled: !record.enabled })
      dispatch({ type: 'toggle-done', record: updated })
    } catch (caught) {
      dispatch({ type: 'op-failed', message: caught instanceof Error ? caught.message : String(caught) })
    }
  }

  async function confirmRemove(templateId: string): Promise<void> {
    dispatch({ type: 'remove-start' })
    try {
      await props.api.removeWorkerType(templateId)
      dispatch({ type: 'remove-done', templateId })
    } catch (caught) {
      dispatch({ type: 'op-failed', message: caught instanceof Error ? caught.message : String(caught) })
    }
  }

  /** 切派生模式：选择即保存（volatile，即时生效；失败保旧值提示）。 */
  async function changeSpawnMode(mode: WorkerSpawnMode): Promise<void> {
    if (state.spawnMode === null) return
    dispatch({ type: 'spawn-save-start' })
    try {
      const saved = await props.api.saveSpawnMode(mode)
      dispatch({ type: 'spawn-save-done', mode: saved.mode })
    } catch (caught) {
      dispatch({ type: 'spawn-failed', message: caught instanceof Error ? caught.message : String(caught) })
    }
  }

  const modelCatalog = modelCatalogOf(state.types)

  return (
    <div data-router-settings style={PAGE_STYLE}>
      {/* 1. 偏好展示（client-prefs；只读，写通道同 v1 说明） */}
      <div style={CARD_STYLE}>
        <div style={SECTION_TITLE_STYLE}>
          <strong>Router 工作台</strong>
        </div>
        <div style={ROW_STYLE} data-router-setting="pollMs">
          <span>状态轮询间隔</span>
          <span data-router-setting-value>{seconds(prefs.pollMs)}</span>
        </div>
        <div style={ROW_STYLE} data-router-setting="overlayEnabled">
          <span>问题浮窗</span>
          <span data-router-setting-value>{onOff(prefs.overlayEnabled)}</span>
        </div>
        <div style={ROW_STYLE} data-router-setting="maxActiveCards">
          <span>活动问题卡上限</span>
          <span data-router-setting-value>{prefs.maxActiveCards} 张</span>
        </div>
        <div style={NOTE_STYLE} data-router-settings-note>
          以上值来自代码默认并在浏览器本地保存（清站点数据即恢复默认）；本块暂为只读。
        </div>
      </div>

      {/* 2. 派生模式（v1.3 C2，规格 §1）：双模式选择器 + 两模式语义 + 切模型即换缓存提示 */}
      <div style={CARD_STYLE} data-router-spawn-section>
        <div style={SECTION_TITLE_STYLE}>
          <strong>派生模式</strong>
          {state.spawnMode !== null ? <span style={TAG_STYLE} data-router-spawn-current>{spawnModeLabel(state.spawnMode)}</span> : null}
        </div>
        <label style={FIELD_LABEL_STYLE}>
          <span>worker 派生方式（改动即时生效；不影响存量任务与已建会话）</span>
          <select
            data-router-spawn-mode
            style={FIELD_STYLE}
            value={state.spawnMode ?? ''}
            disabled={state.spawnBusy || state.spawnMode === null}
            onChange={(event) => {
              const value = event.target.value
              if (value === 'cache-priority' || value === 'minimal-face') void changeSpawnMode(value)
            }}
          >
            {state.spawnMode === null ? <option value="">加载中…</option> : null}
            <option value="cache-priority">{spawnModeLabel('cache-priority')}</option>
            <option value="minimal-face">{spawnModeLabel('minimal-face')}</option>
          </select>
        </label>
        {state.spawnMode !== null ? (
          <div style={NOTE_STYLE} data-router-spawn-description>{spawnModeDescription(state.spawnMode)}</div>
        ) : null}
        <div style={NOTE_STYLE} data-router-spawn-model-hint>{SPAWN_MODE_MODEL_HINT}</div>
        <div style={NOTE_STYLE}>
          此开关为运行时值（volatile）：保存即生效、不落盘，宿主重启后回到启动配置的
          workerSpawnMode 值；要常驻生效请在宿主设置页改本插件的 workerSpawnMode 配置项。
        </div>
        {state.spawnError !== null ? <div style={PROBLEM_STYLE} data-router-spawn-error>保存失败（保留原模式）：{state.spawnError}</div> : null}
      </div>

      {/* 3. Worker 类型管理（规格 §6） */}
      <div style={CARD_STYLE} data-router-types-section>
        <div style={SECTION_TITLE_STYLE}>
          <strong>Worker 类型</strong>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <LightTooltip label="新建一个 worker 类型（即刻注册为动态预设，可派发）">
              <HoverButton label="新建类型" dataTag="types-new" style={PRIMARY_BUTTON_STYLE} disabled={state.editing !== null} onClick={() => { dispatch({ type: 'new-form' }) }} />
            </LightTooltip>
            <LightTooltip label="重新拉取类型与默认值">
              <HoverButton label="刷新" dataTag="types-reload" onClick={() => { void reload() }} />
            </LightTooltip>
          </span>
        </div>
        {state.loadError !== null ? (
          <div style={PROBLEM_STYLE} data-router-types-load-error>
            类型清单加载失败：{state.loadError}
            <HoverButton label="重试" dataTag="types-retry" onClick={() => { void reload() }} />
          </div>
        ) : null}
        {state.notice !== null ? <div style={NOTE_STYLE} data-router-types-notice>{state.notice}</div> : null}
        {state.error !== null && state.editing === null ? <div style={PROBLEM_STYLE} data-router-types-error>{state.error}</div> : null}
        {state.types.map((record) => (
          <TypeRow
            key={record.templateId}
            record={record}
            busy={state.busy}
            armedRemove={state.armedRemove}
            onToggle={(row) => { void toggleRecord(row) }}
            onArmRemove={(templateId) => { dispatch({ type: 'remove-arm', templateId }) }}
            onConfirmRemove={(templateId) => { void confirmRemove(templateId) }}
          />
        ))}
        {state.loaded && state.loadError === null && state.types.length === 0 ? (
          <div style={NOTE_STYLE}>还没有任何 worker 类型，点「新建类型」创建。</div>
        ) : null}
        {state.editing !== null ? (
          <TypeForm
            api={props.api}
            editing={state.editing}
            baseline={state.baseline}
            confirmDiscard={state.confirmDiscard}
            busy={state.busy}
            error={state.error}
            modelCatalog={modelCatalog}
            dispatch={dispatch}
            onSaved={(record) => { dispatch({ type: 'save-done', record }) }}
          />
        ) : null}
        <div style={NOTE_STYLE}>
          禁用 = 保留预设注册、仅拒绝新派发；删除 = 注销预设，已关闭的该类型会话将无法重开（重建同名类型可恢复）。
          类型不支持编辑——要改就删除后重建（Router 会话里也可随时 create_worker_type）。
        </div>
      </div>
    </div>
  )
}
