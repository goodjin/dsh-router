/**
 * 协作视图页（会话标签行 conversation.view 的「协作」页）。
 *
 * 取代旧「头部按钮 + 弹出卡片」：整页显示在会话界面里，从上到下——
 *  - 页头：根会话选择（留空默认当前会话）+ 用当前会话 + 刷新 + 预设提示；
 *  - 主区左：任务看板（按任务分组、四态进度）；
 *  - 主区右：任务详情（任务说明、会话画布、分工列表、报告列表、选中记录详情）；
 *  - 页底：角色模板区（查看 + 新建/编辑，与模型共享同一 RoleStore）。
 *
 * 会话树数据来自页面标准属性 useSessions（subagentCatalog 投影 / byId 摘要）与
 * useSessionStatus（实时运行状态），按需经 face.refreshProjection（sessions.refreshProjections）
 * 加载；全部守卫读取，缺失降级（无树/未知状态），不炸视图。
 * 组件绝不收 ctx：业务面经 registration 的 inject 工厂下发（face）。
 */

import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'

import type { CollaborationStore } from './collaboration-store.ts'
import { RecordDetail } from './record-detail.tsx'
import { RolesSection } from './roles-section.tsx'
import { SessionCanvas } from './session-canvas.tsx'
import { TaskBoard } from './task-board.tsx'
import { deriveTasks, type TaskView } from './task-view-model.ts'
import type { WorkLabel, WorkRecord } from '../collaboration/types.ts'

/** 会话标签行座位（与官方统计页同款挂法）。 */
export const COLLABORATION_VIEW_SLOT = 'conversation.view'
export const COLLABORATION_VIEW_ID = 'router-collaboration'
export const COLLABORATION_VIEW_ORDER = 50
export const COLLABORATION_VIEW_LABEL = '协作'

/** slots 表面登记的宿主最小面。 */
export interface CollaborationSlotsHost {
  inject(key: string, prepare: () => unknown): unknown
  register(options: {
    name: string
    id?: string
    order?: number
    label?: string | (() => string)
    inject?: () => unknown
  }, component: unknown): unknown
}

/** 视图业务面（registration 的 inject 工厂下发；组件绝不收 ctx）。 */
export interface CollaborationViewFace {
  store: CollaborationStore
  uiWorkspace: { openSession(target: string): void }
  /** 按需加载某会话的子会话目录（sessions.refreshProjections）；缺省 no-op。 */
  refreshProjection?(sessionId: string): void
}

/* ---- 页面标准属性的最小结构面（真实 face 由框架提供；缺失即降级） ---- */

interface CatalogEntryLike { id: string; label?: string }
interface ProjectionSnapshotLike { values?: { subagentCatalog?: CatalogEntryLike[] } }
interface SessionSummaryLike { title?: string; running?: boolean }
interface SessionsStateLike {
  projectionsBySession?: Record<string, ProjectionSnapshotLike | undefined>
  byId?: Record<string, SessionSummaryLike | undefined>
}
interface StatusMapLike { get(id: string): { running?: boolean } | undefined }

/** useSessions 选择器钩子的最小结构面。 */
export type SessionsSelectorHook = <T>(selector: (state: SessionsStateLike) => T) => T
/** useSessionStatus 选择器钩子的最小结构面。 */
export type StatusSelectorHook = <T>(selector: (value: StatusMapLike) => T) => T

/** 视图 props = face + 页面标准属性（session scope 自动下发；测试可显式传）。 */
export interface CollaborationViewProps extends CollaborationViewFace {
  sessionId?: string
  useSessions?: SessionsSelectorHook
  useSessionStatus?: StatusSelectorHook
}

/** 把视图页注册进会话标签行。 */
export function registerCollaborationView(slots: CollaborationSlotsHost, face: CollaborationViewFace): void {
  slots.inject(COLLABORATION_VIEW_SLOT, () => slots.register(
    {
      name: COLLABORATION_VIEW_SLOT,
      id: COLLABORATION_VIEW_ID,
      order: COLLABORATION_VIEW_ORDER,
      label: COLLABORATION_VIEW_LABEL,
      inject: () => face,
    },
    CollaborationView,
  ))
}

/* ---- 样式 ---- */

const BUTTON_STYLE: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 5,
  border: '1px solid var(--dsw-alias-border-l2, #d8dbe0)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  fontSize: 12,
}

const INPUT_STYLE: CSSProperties = {
  width: 320,
  boxSizing: 'border-box',
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, #d0d4dd)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
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

const SUBSECTION_STYLE: CSSProperties = {
  marginTop: 14,
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
}

const KIND_LABEL: Record<WorkRecord['kind'], string> = {
  task: '任务说明',
  assignment: '分工记录',
  report: '工作报告',
  summary: '汇总报告',
}

/** 守卫读取：访问可能抛错的属性/调用时返回 undefined，绝不外抛。 */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** 页头：根会话选择 + 用当前会话 + 刷新 + 预设提示。 */
function RootBar(props: { store: CollaborationStore }): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const current = state.currentSessionId
  return (
    <section data-router-collab-root-section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#4a4e57' }}>
          当前会话：{current === undefined ? '不可用（宿主未在本次提供当前会话）' : current}
        </span>
        <input
          data-router-collab-root-input
          style={INPUT_STYLE}
          value={state.rootInput}
          placeholder={current ?? '根会话 ID（留空则用当前会话；输入后覆盖并被记住）'}
          onChange={(event) => { props.store.setRootInput(event.target.value) }}
        />
        <button type="button" data-router-collab-root-reset style={BUTTON_STYLE} onClick={() => { props.store.resetRootInput() }}>
          用当前会话
        </button>
        <button type="button" data-router-collab-refresh style={BUTTON_STYLE} onClick={() => { void props.store.refreshRecords() }}>
          刷新
        </button>
      </div>
      <div data-router-collab-preset-hint style={{ fontSize: 11, color: '#6b7078', marginTop: 6 }}>
        新建会话时，请在宿主正常 UI 选择「Router」预设（本工作台不自动创建会话）
      </div>
    </section>
  )
}

/** 协作视图页。 */
export function CollaborationView(props: CollaborationViewProps): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined)
  const effective = state.effectiveRootId
  const tasks = deriveTasks(state.records)
  const selectedTask: TaskView | undefined = tasks.find((task) => task.taskId === selectedTaskId) ?? tasks[0]

  // 进入视图 / 根会话变化 → 拉取任务资料与角色模板（用户可见的打开动作触发，无轮询）。
  useEffect(() => {
    void props.store.refreshRecords()
    void props.store.refreshRoles()
  }, [props.store, effective])

  // 会话数据（标准属性，守卫读取；缺失降级为空目录/未知状态）。
  const sessionsState = safeRead(() => props.useSessions?.((value) => value))
  const projections = safeRead(() => (sessionsState as SessionsStateLike | undefined)?.projectionsBySession) ?? {}
  const byId = safeRead(() => (sessionsState as SessionsStateLike | undefined)?.byId) ?? {}
  const statuses = safeRead(() => props.useSessionStatus?.((value) => value))

  const childrenOf = (sessionId: string): Array<{ id: string; label?: string }> => {
    const catalog = safeRead(() => projections[sessionId]?.values?.subagentCatalog)
    if (!Array.isArray(catalog)) return []
    return catalog.filter((entry): entry is CatalogEntryLike => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
  }
  const statusOf = (sessionId: string): boolean | undefined => {
    const fromStatus = safeRead(() => statuses?.get(sessionId)?.running)
    if (typeof fromStatus === 'boolean') return fromStatus
    const fromSummary = safeRead(() => byId[sessionId]?.running)
    return typeof fromSummary === 'boolean' ? fromSummary : undefined
  }
  const titleOf = (sessionId: string): string | undefined => safeRead(() => byId[sessionId]?.title)
  const onRequestChildren = (sessionId: string): void => {
    try {
      props.refreshProjection?.(sessionId)
    } catch {
      // 降级：请求失败即目录缺省（画布显示未知/无子层），不炸视图。
    }
  }
  const onOpenSession = (sessionId: string): void => { props.uiWorkspace.openSession(sessionId) }

  // 该任务的关联会话 → 分工工作标签（先分工定标签，再补其余记录的成员关系）。
  const linked = new Map<string, WorkLabel | undefined>()
  const taskRecords: WorkRecord[] = selectedTask === undefined
    ? []
    : state.records
        .filter((record) => record.taskId === selectedTask.taskId)
        .sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : 1))
  for (const record of taskRecords) {
    if (record.kind !== 'assignment') continue
    for (const session of record.sessions ?? []) {
      if (!linked.has(session.sessionId)) linked.set(session.sessionId, record.workLabel)
    }
  }
  for (const record of taskRecords) {
    for (const session of record.sessions ?? []) {
      if (!linked.has(session.sessionId)) linked.set(session.sessionId, undefined)
    }
  }

  const assignments = taskRecords.filter((record) => record.kind === 'assignment')
  const reports = taskRecords.filter((record) => record.kind === 'report' || record.kind === 'summary')

  return (
    <div data-router-collab-view style={{ height: '100%', boxSizing: 'border-box', overflow: 'auto', padding: '12px 16px', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary, #1f2126)' }}>
      <RootBar store={props.store} />
      {state.recordsError !== null ? (
        <div data-router-collab-records-error style={{ ...ERROR_STYLE, marginTop: 10 }} role="alert">
          <span style={{ flex: 1 }}>{state.recordsError}</span>
          <button type="button" data-router-collab-records-retry style={BUTTON_STYLE} onClick={() => { void props.store.refreshRecords() }}>
            重试
          </button>
        </div>
      ) : null}
      {state.loadingRecords ? <div style={{ fontSize: 12, color: '#4a4e57', marginTop: 8 }}>加载中…</div> : null}
      {state.recordsError === null && !state.loadingRecords && tasks.length === 0 ? (
        <div data-router-collab-records-empty style={{ fontSize: 12, color: '#6b7078', marginTop: 8 }}>
          {effective === undefined ? '请输入根会话 ID 查看记录' : '暂无任务记录'}
        </div>
      ) : null}
      {tasks.length > 0 && selectedTask !== undefined ? (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginTop: 12 }}>
          <TaskBoard tasks={tasks} selectedTaskId={selectedTask.taskId} onSelect={setSelectedTaskId} />
          <div data-router-collab-task-detail style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>{selectedTask.title}</h3>
            {selectedTask.summaryBody !== undefined && selectedTask.summaryBody !== '' ? (
              <div data-router-collab-task-brief style={BODY_STYLE}>{selectedTask.summaryBody}</div>
            ) : null}
            <SessionCanvas
              rootId={effective}
              linked={linked}
              childrenOf={childrenOf}
              statusOf={statusOf}
              titleOf={titleOf}
              onRequestChildren={onRequestChildren}
              onOpenSession={onOpenSession}
            />
            <div style={SUBSECTION_STYLE}>
              <strong>分工（{assignments.length}）</strong>
              <div data-router-collab-records style={{ marginTop: 6 }}>
                {assignments.map((record) => (
                  <button
                    key={`${record.taskId}:${record.id}`}
                    type="button"
                    data-router-collab-record={`${record.taskId}:${record.id}`}
                    style={RECORD_ITEM_STYLE}
                    onClick={() => { void props.store.selectRecord(record.taskId, record.id) }}
                  >
                    <span>{record.title}</span>
                    {record.workLabel !== undefined ? <span style={{ color: '#4a4e57' }}> · {record.workLabel}</span> : null}
                  </button>
                ))}
                {assignments.length === 0 ? <div style={{ fontSize: 12, color: '#6b7078' }}>暂无分工记录</div> : null}
              </div>
            </div>
            <div style={SUBSECTION_STYLE}>
              <strong>报告（{reports.length}）</strong>
              <div style={{ marginTop: 6 }}>
                {reports.map((record) => (
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
                  </button>
                ))}
                {reports.length === 0 ? <div style={{ fontSize: 12, color: '#6b7078' }}>暂无报告</div> : null}
              </div>
            </div>
            <RecordDetail store={props.store} statusOf={statusOf} onOpenSession={onOpenSession} />
          </div>
        </div>
      ) : null}
      <RolesSection store={props.store} />
    </div>
  )
}
