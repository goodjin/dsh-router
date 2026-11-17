/**
 * 协作工作台面板（计划 Task 3，Layer 4）。
 *
 * 头部一个按钮「协作工作台」打开可关闭面板（fixed 浮层，同组件渲染，不复制旧浮窗体系）。
 * 面板把三类信息分开（规格 §8）：
 *  - DSH 运行事实（子会话状态）：只在宿主公开该会话事实时显示；否则「运行状态未知，请打开会话查看」
 *    + 显式跳转，不推断、不扫历史、不为状态新造后端扫描。
 *  - 模型工作描述（记录正文/工作标签）：如实展示，报告标注「模型报告」，工作标签是模型所填，
 *    不因宿主运行结束改写。
 *  - 用户反馈：经聊天提出，面板不自动验收/补做/换人。
 *
 * 会话跳转用记录内 sessions 的精确 sessionId 调 uiWorkspace.openSession（只响应点击，不抢焦点、
 * 不自动切换）；成果引用只展示/复制，不自动读取或执行。记录修改由模型工具负责，工作台只读。
 * 角色模板编辑与用户/模型工具共享同一 RoleStore（经 store.saveRole → POST /roles）。
 *
 * 样式简洁浅色，匹配现有 ui-kit；不引入新复杂设计、不引新渲染依赖（Markdown 按纯文本展示）。
 */

import { useEffect, useSyncExternalStore, useState, type ReactNode } from 'react'
import type { CSSProperties } from 'react'

import type { CollaborationStore } from './collaboration-store.ts'
import type { RecordKind, WorkRecord } from '../collaboration/types.ts'

/** 宿主运行事实：该会话的公开状态；unknown/缺省 = 不可用。 */
export type SessionRuntimeFact = 'running' | 'ended' | 'unknown'

/** 组件的业务输入（registration 的 inject 工厂给的 face；组件绝不收 ctx）。 */
export interface CollaborationPanelFace {
  store: CollaborationStore
  uiWorkspace: { openSession(target: string): void }
  /** 宿主公开的运行事实投影（按精确 sessionId）；缺省/抛错一律按 unknown 降级，不臆造。 */
  factProvider?: (sessionId: string) => SessionRuntimeFact
}

/** 组件 props = face。 */
export type CollaborationPanelProps = CollaborationPanelFace

/** slots 表面登记（conversation.session.header.actions — 与编队按钮同栏）。 */
export const COLLABORATION_PANEL_SLOT = 'conversation.session.header.actions'
export const COLLABORATION_PANEL_ID = 'router-collaboration-workbench'
export const COLLABORATION_PANEL_ORDER = -10

/** slots 表面登记（conversation.session.header.actions — 与编队同栏）。 */
export interface CollaborationSlotsHost {
  inject(key: string, prepare: () => unknown): unknown
  register(options: { name: string; id?: string; order?: number; inject?: () => unknown }, component: unknown): unknown
}

/** 把工作台面板注册进宿主头部。 */
export function registerCollaborationPanel(slots: CollaborationSlotsHost, face: CollaborationPanelFace): void {
  slots.inject(COLLABORATION_PANEL_SLOT, () => slots.register(
    { name: COLLABORATION_PANEL_SLOT, id: COLLABORATION_PANEL_ID, order: COLLABORATION_PANEL_ORDER, inject: () => face },
    CollaborationWorkbench,
  ))
}

const KIND_LABEL: Record<RecordKind, string> = {
  task: '任务说明',
  assignment: '分工记录',
  report: '工作报告',
  summary: '汇总报告',
}

const WORK_LABEL_TEXT: Record<NonNullable<WorkRecord['workLabel']>, string> = {
  '待处理': '待处理',
  '进行中': '进行中',
  '受阻': '受阻',
  '已报告': '已报告',
}

const RUNTIME_FACT_TEXT: Record<SessionRuntimeFact, string> = {
  running: '运行中',
  ended: '已结束',
  unknown: '运行状态未知，请打开会话查看',
}

const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  zIndex: 100,
  top: 56,
  insetInlineEnd: 16,
  width: 'min(420px, calc(100vw - 32px))',
  maxHeight: 'min(680px, calc(100vh - 32px))',
  overflow: 'auto',
  background: 'var(--dsw-specific-menu, #f7f8fa)',
  backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(20px))',
  border: '1px solid var(--dsw-alias-border-l1, #d0d4dd)',
  borderRadius: 12,
  boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(31,33,38,0.18))',
  padding: '12px 14px',
  boxSizing: 'border-box',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary, #1f2126)',
}

const OPEN_BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  minHeight: 28,
  padding: '3px 7px',
  borderRadius: 6,
  border: 0,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
  fontSize: 12,
  lineHeight: '16px',
  cursor: 'pointer',
}

const SECTION_STYLE: CSSProperties = {
  marginTop: 12,
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
}

const RECORD_ITEM_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'start',
  padding: '8px 10px',
  marginBottom: 6,
  borderRadius: 8,
  border: '0.5px solid var(--dsw-alias-border-l2, #e4e7ec)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  fontSize: 12,
  boxShadow: 'var(--dsw-elevation-stroke, 0 1px 2px rgba(0,0,0,0.04))',
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

const RETRY_BUTTON_STYLE: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 5,
  border: '1px solid var(--dsw-alias-border-l2, #d8dbe0)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  fontSize: 12,
}

const INPUT_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, #d0d4dd)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: 12,
}

const BODY_STYLE: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: '6px 0',
  padding: 8,
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
}

/** 运行事实降级读取：factProvider 缺省/抛错一律 unknown，不臆造。 */
function runtimeFactOf(factProvider: CollaborationPanelFace['factProvider'], sessionId: string): SessionRuntimeFact {
  if (typeof factProvider !== 'function') return 'unknown'
  try {
    const value = factProvider(sessionId)
    return value === 'running' || value === 'ended' ? value : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 根会话区：当前会话提示 + 显式 root 输入（记住覆盖）+ 重置/刷新。 */
function RootSection(props: { store: CollaborationStore }): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const current = state.currentSessionId
  return (
    <section data-router-collab-root-section>
      <div style={{ fontSize: 12, color: '#4a4e57', marginBottom: 6 }}>
        当前会话：{current === undefined ? '不可用（宿主未在本次提供当前会话）' : current}
      </div>
      <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
        根会话 ID（留空则用当前会话；输入后覆盖并被记住）
      </label>
      <input
        data-router-collab-root-input
        style={INPUT_STYLE}
        value={state.rootInput}
        placeholder={current ?? '输入根会话 ID'}
        onChange={(event) => { props.store.setRootInput(event.target.value) }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button type="button" data-router-collab-root-reset style={RETRY_BUTTON_STYLE} onClick={() => { props.store.resetRootInput() }}>
          用当前会话
        </button>
        <button type="button" data-router-collab-refresh style={RETRY_BUTTON_STYLE} onClick={() => { void props.store.refreshRecords() }}>
          刷新
        </button>
      </div>
      <div data-router-collab-preset-hint style={{ fontSize: 11, color: '#6b7078', marginTop: 6 }}>
        新建会话时，请在宿主正常 UI 选择「Router」预设（本工作台不自动创建会话）
      </div>
    </section>
  )
}

/** 记录区：错误+重试 / 加载 / 列表（点选看详情）/ 空态。 */
function RecordsSection(props: { store: CollaborationStore }): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  return (
    <section data-router-collab-records-section style={SECTION_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong>任务资料</strong>
        {state.loadingRecords ? <span style={{ fontSize: 12, color: '#4a4e57' }}>加载中…</span> : null}
      </div>
      {state.recordsError !== null ? (
        <div data-router-collab-records-error style={ERROR_STYLE} role="alert">
          <span style={{ flex: 1 }}>{state.recordsError}</span>
          <button type="button" data-router-collab-records-retry style={RETRY_BUTTON_STYLE} onClick={() => { void props.store.refreshRecords() }}>
            重试
          </button>
        </div>
      ) : null}
      {state.recordsError === null && !state.loadingRecords && state.records.length === 0 ? (
        <div data-router-collab-records-empty style={{ fontSize: 12, color: '#6b7078' }}>
          {state.effectiveRootId === undefined ? '请输入根会话 ID 查看记录' : '暂无记录'}
        </div>
      ) : null}
      <div data-router-collab-records>
        {state.records.map((record) => (
          <button
            key={`${record.taskId}:${record.id}`}
            type="button"
            data-router-collab-record={`${record.taskId}:${record.id}`}
            style={RECORD_ITEM_STYLE}
            onClick={() => { void props.store.selectRecord(record.taskId, record.id) }}
          >
            <span style={{ color: '#6b7078' }}>{KIND_LABEL[record.kind]}</span>
            {' '}
            <span>{record.title}</span>
            {record.workLabel !== undefined ? <span style={{ color: '#4a4e57' }}> · {WORK_LABEL_TEXT[record.workLabel]}</span> : null}
          </button>
        ))}
      </div>
    </section>
  )
}

/** 记录详情：模型报告标注 + 纯文本正文 + 工作标签 + 会话跳转 + 运行事实 + 成果引用。 */
function RecordDetail(props: {
  store: CollaborationStore
  uiWorkspace: CollaborationPanelFace['uiWorkspace']
  factProvider: CollaborationPanelFace['factProvider']
}): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const saved = state.selectedRecord
  if (saved === undefined) return null
  const record = saved.record
  return (
    <section data-router-collab-detail style={SECTION_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: '#6b7078' }}>{KIND_LABEL[record.kind]}</span>
        {record.kind === 'report' ? (
          <span data-router-collab-model-report style={{ fontSize: 11, padding: '1px 5px', borderRadius: 4, background: '#eef1fb', color: '#3b4a9c' }}>模型报告</span>
        ) : null}
      </div>
      <h3 style={{ margin: '6px 0', fontSize: 13 }}>{record.title}</h3>
      {record.workLabel !== undefined ? (
        <div data-router-collab-work-label style={{ fontSize: 12, color: '#4a4e57', marginBottom: 4 }}>
          模型工作标签：{WORK_LABEL_TEXT[record.workLabel]}（模型所填，不以宿主运行状态改写）
        </div>
      ) : null}
      <div data-router-collab-detail-body style={BODY_STYLE}>{record.body}</div>
      {record.sessions !== undefined && record.sessions.length > 0 ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, color: '#6b7078', marginBottom: 3 }}>关联会话（点击跳转）</div>
          {record.sessions.map((session) => {
            const fact = runtimeFactOf(props.factProvider, session.sessionId)
            return (
              <div key={session.sessionId} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <button
                  type="button"
                  data-router-collab-session-link={session.sessionId}
                  style={RETRY_BUTTON_STYLE}
                  onClick={() => { props.uiWorkspace.openSession(session.sessionId) }}
                >
                  {session.label}（{session.sessionId}）
                </button>
                <span data-router-collab-runtime-fact={session.sessionId} style={{ fontSize: 11, color: fact === 'unknown' ? '#6b7078' : '#4a4e57' }}>
                  {RUNTIME_FACT_TEXT[fact]}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
      {record.artifacts !== undefined && record.artifacts.length > 0 ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, color: '#6b7078', marginBottom: 3 }}>成果引用（仅展示，不自动打开/执行）</div>
          {record.artifacts.map((artifact) => (
            <div key={artifact.location} data-router-collab-artifact style={{ fontSize: 12, marginBottom: 2 }}>
              <span style={{ fontFamily: 'ui-monospace, monospace' }}>{artifact.location}</span>
              <span style={{ color: '#6b7078' }}> — {artifact.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ marginTop: 6, fontSize: 11, color: '#6b7078' }}>落盘路径：{saved.path}</div>
    </section>
  )
}

/** 角色模板区：与模型工具共享同一 RoleStore；明文名称/描述（空描述合法）；失败显示并保留草稿。 */
function RolesSection(props: {
  store: CollaborationStore
  roleName: string
  setRoleName(value: string): void
  roleDesc: string
  setRoleDesc(value: string): void
  editingRoleId: string | undefined
  setEditingRoleId(value: string | undefined): void
}): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const canSave = props.roleName.trim() !== ''
  return (
    <section data-router-collab-roles-section style={SECTION_STYLE}>
      <strong>角色模板</strong>
      {state.rolesError !== null ? (
        <div data-router-collab-roles-error style={ERROR_STYLE} role="alert">
          <span style={{ flex: 1 }}>{state.rolesError}</span>
          <button type="button" data-router-collab-roles-retry style={RETRY_BUTTON_STYLE} onClick={() => { void props.store.refreshRoles() }}>
            重试
          </button>
        </div>
      ) : null}
      <div data-router-collab-templates style={{ marginTop: 6 }}>
        {state.templates.length === 0
          ? <div style={{ fontSize: 12, color: '#6b7078' }}>暂无角色模板</div>
          : state.templates.map((template) => (
            <div key={template.id} data-router-collab-template={template.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ flex: 1, fontSize: 12 }}>
                {template.name}
                {template.description !== '' ? <span style={{ color: '#6b7078' }}> — {template.description}</span> : null}
              </span>
              <button
                type="button"
                data-router-collab-role-edit={template.id}
                style={RETRY_BUTTON_STYLE}
                onClick={() => {
                  props.setEditingRoleId(template.id)
                  props.setRoleName(template.name)
                  props.setRoleDesc(template.description)
                }}
              >
                编辑
              </button>
            </div>
          ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <input
          data-router-collab-role-name
          style={{ ...INPUT_STYLE, marginBottom: 4 }}
          placeholder={props.editingRoleId === undefined ? '新角色名称（必填）' : '角色名称（必填）'}
          value={props.roleName}
          onChange={(event) => { props.setRoleName(event.target.value) }}
        />
        <input
          data-router-collab-role-desc
          style={INPUT_STYLE}
          placeholder="职责说明（明文，可留空）"
          value={props.roleDesc}
          onChange={(event) => { props.setRoleDesc(event.target.value) }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button
            type="button"
            data-router-collab-role-save
            style={{ ...RETRY_BUTTON_STYLE, opacity: canSave ? 1 : 0.5 }}
            disabled={!canSave}
            onClick={() => {
              void props.store.saveRole(
                props.editingRoleId === undefined
                  ? { name: props.roleName.trim(), description: props.roleDesc }
                  : { id: props.editingRoleId, name: props.roleName.trim(), description: props.roleDesc },
              ).then((ok) => {
                if (ok) {
                  props.setRoleName('')
                  props.setRoleDesc('')
                  props.setEditingRoleId(undefined)
                }
              })
            }}
          >
            {props.editingRoleId === undefined ? '保存角色' : '保存修改'}
          </button>
          {props.editingRoleId !== undefined ? (
            <button type="button" data-router-collab-role-cancel style={RETRY_BUTTON_STYLE} onClick={() => { props.setEditingRoleId(undefined); props.setRoleName(''); props.setRoleDesc('') }}>
              取消
            </button>
          ) : null}
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

/** 工作台面板组件：与编队同栏的触发按钮 + 浮层面板。 */
export function CollaborationWorkbench(props: CollaborationPanelProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [roleName, setRoleName] = useState('')
  const [roleDesc, setRoleDesc] = useState('')
  const [editingRoleId, setEditingRoleId] = useState<string | undefined>(undefined)
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const recordCount = state.records.length

  // 面板打开时更新资料（用户打开触发，无轮询定时器）。
  useEffect(() => {
    if (!open) return
    void props.store.refreshRecords()
    void props.store.refreshRoles()
  }, [open, props.store])

  return (
    <>
      <button
        type="button"
        data-router-collab-open
        style={OPEN_BUTTON_STYLE}
        onClick={() => { setOpen(!open) }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--dsw-alias-label-primary, #1f2126)' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dsw-alias-label-tertiary, #8a8f98)' }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <path d="M5 6h6M5 8.5h4M5 11h5" />
        </svg>
        <span>协作</span>
        {recordCount > 0 ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-caption, #aab0b8)' }}>{recordCount}</span> : null}
      </button>
      {open ? (
        <div data-router-collab-panel role="dialog" aria-label="协作工作台" style={OVERLAY_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong style={{ fontSize: 13, fontWeight: 500 }}>协作记录</strong>
            <button type="button" data-router-collab-close aria-label="关闭" style={{ ...OPEN_BUTTON_STYLE, fontSize: 16, padding: '2px 6px' }} onClick={() => { setOpen(false) }}>
              ×
            </button>
          </div>
          <RootSection store={props.store} />
          <RecordsSection store={props.store} />
          <RecordDetail store={props.store} uiWorkspace={props.uiWorkspace} factProvider={props.factProvider} />
          <RolesSection
            store={props.store}
            roleName={roleName}
            setRoleName={setRoleName}
            roleDesc={roleDesc}
            setRoleDesc={setRoleDesc}
            editingRoleId={editingRoleId}
            setEditingRoleId={setEditingRoleId}
          />
        </div>
      ) : null}
    </>
  )
}
