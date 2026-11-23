/**
 * 协作视图页（会话标签行 conversation.view 的「协作」页）。
 *
 * 任务页显示可折叠任务树、任务内容与结果；独立任务图复用同一棵树。
 * 组件绝不收 ctx：业务面经 registration 的 inject 工厂下发（face）。
 */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'

import type { CollaborationStore } from './collaboration-store.ts'
import { RolesTab } from './roles-tab.tsx'
import { deriveTaskGraph } from './task-graph.ts'
import { TaskCanvas } from './task-canvas.tsx'
import { TaskList } from './task-list.tsx'
import { deriveTasks, type TaskView } from './task-view-model.ts'

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

/** 守卫读取：访问可能抛错的属性/调用时返回 undefined，绝不外抛。 */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** 隐藏输入框的样式规则 id 与标记名（测试断言用）。 */
export const HIDE_COMPOSER_STYLE_ID = 'router-collab-hide-composer'
export const ACTIVE_BODY_MARKER = 'data-router-collab-active'
const HIDE_COMPOSER_CSS = '[data-router-collab-active="1"] [data-composer-dock] { display: none !important; }'

/**
 * 协作视图打开期间隐藏会话输入框（composer dock）。
 *
 * 视图是「一次渲染一个」的 View：本组件挂载即代表协作视图处于激活态——在 body 上
 * 打标记并注入一条样式规则隐藏宿主的停靠输入框；卸载（切回聊天等其他视图）时撤掉
 * 两者，输入框原样恢复。样式规则只挂一次（按 id 幂等）；document 缺失/异常时静默
 * 降级（输入框不隐藏，视图功能不受影响）。
 */
function useHideComposerWhileMounted(): void {
  useEffect(() => {
    let style: HTMLStyleElement | undefined
    try {
      document.body.setAttribute(ACTIVE_BODY_MARKER, '1')
      style = document.getElementById(HIDE_COMPOSER_STYLE_ID) as HTMLStyleElement | undefined ?? undefined
      if (style === undefined) {
        style = document.createElement('style')
        style.id = HIDE_COMPOSER_STYLE_ID
        style.textContent = HIDE_COMPOSER_CSS
        document.head.append(style)
      }
    } catch {
      // 降级：输入框不隐藏，视图照常可用。
    }
    return () => {
      try {
        document.body.removeAttribute(ACTIVE_BODY_MARKER)
        style?.remove()
      } catch {
        // 清理失败不影响视图卸载。
      }
    }
  }, [])
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
  const [activeTab, setActiveTab] = useState<'tasks' | 'graph' | 'roles'>('tasks')
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined)
  const effective = state.effectiveRootId
  const tasks = deriveTasks(state.records)
  const selectedTask: TaskView | undefined = tasks.find((task) => task.taskId === selectedTaskId) ?? tasks[0]

  // 进入视图 / 根会话变化 → 拉取任务资料与角色模板（用户可见的打开动作触发，无轮询）。
  useEffect(() => {
    void props.store.refreshRecords()
    void props.store.refreshRoles()
  }, [props.store, effective])

  // 协作视图激活期间隐藏会话输入框。
  useHideComposerWhileMounted()

  // 会话数据（标准属性，守卫读取；缺失降级为空目录/未知状态）。
  const sessionsState = safeRead(() => props.useSessions?.((value) => value))
  const projections = safeRead(() => (sessionsState as SessionsStateLike | undefined)?.projectionsBySession) ?? {}
  const childrenOf = (sessionId: string): Array<{ id: string; label?: string }> => {
    const catalog = safeRead(() => projections[sessionId]?.values?.subagentCatalog)
    if (!Array.isArray(catalog)) return []
    return catalog.filter((entry): entry is CatalogEntryLike => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
  }
  const graph = deriveTaskGraph({tasks, rootId: effective, childrenOf})
  const requested = useRef(new Set<string>())
  useEffect(() => { requested.current.clear() }, [effective])
  useEffect(() => {
    if (!effective || !props.refreshProjection) return
    const seen = new Set<string>()
    const queue = [effective]
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!
      if (seen.has(id)) continue
      seen.add(id)
      if (!requested.current.has(id)) {
        requested.current.add(id)
        try { props.refreshProjection(id) } catch { /* 目录不可用时独立展示 */ }
      }
      for (const child of childrenOf(id)) queue.push(child.id)
    }
  }, [effective, projections, props.refreshProjection])
  const records = state.records.filter(r => r.taskId === selectedTask?.taskId)
  const summary = records.filter(r => r.kind === 'summary').sort((a,b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0]
  const results = summary ? [summary] : records.filter(r => r.kind === 'report').sort((a,b) => a.createdAt - b.createdAt)

  return (
    <div data-router-collab-view style={{ height: '100%', boxSizing: 'border-box', overflow: 'auto', padding: '12px 16px', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary, #1f2126)' }}>
      <RootBar store={props.store} />
      <div role="tablist" style={{ display: 'flex', gap: 6, marginTop: 10, borderBottom: '1px solid var(--dsw-alias-border-l2, #e4e7ec)' }}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'tasks'}
          data-router-collab-tab="tasks"
          style={{ ...TAB_STYLE, ...(activeTab === 'tasks' ? TAB_ACTIVE_STYLE : {}) }}
          onClick={() => { setActiveTab('tasks') }}
        >
          任务{tasks.length > 0 ? `（${tasks.length}）` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'graph'}
          data-router-collab-tab="graph"
          style={{ ...TAB_STYLE, ...(activeTab === 'graph' ? TAB_ACTIVE_STYLE : {}) }}
          onClick={() => { setActiveTab('graph') }}
        >
          任务图
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'roles'}
          data-router-collab-tab="roles"
          style={{ ...TAB_STYLE, ...(activeTab === 'roles' ? TAB_ACTIVE_STYLE : {}) }}
          onClick={() => { setActiveTab('roles') }}
        >
          角色{state.templates.length > 0 ? `（${state.templates.length}）` : ''}
        </button>
      </div>
      {activeTab === 'roles' ? <RolesTab store={props.store} /> : null}
      {activeTab === 'graph' ? (
        <TaskCanvas
          graph={graph}
          selectedTaskId={selectedTask?.taskId}
          onSelect={(taskId) => { setSelectedTaskId(taskId); setActiveTab('tasks') }}
        />
      ) : null}
      {activeTab === 'tasks' ? (
        <>
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
          <TaskList key={effective} roots={graph.root.children} selectedTaskId={selectedTask.taskId} onSelect={setSelectedTaskId} />
          <div data-router-collab-task-detail style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>{selectedTask.title}</h3>
            <h4>任务内容</h4>
            <div data-router-collab-task-brief style={BODY_STYLE}>{selectedTask.summaryBody || '暂无任务内容'}</div>
            <h4>任务结果</h4>
            {results.length === 0 ? <p>暂无结果</p> : results.map(r => <article key={r.id}>
              <strong>{r.title}</strong>
              <div style={BODY_STYLE}>{r.body}</div>
              {r.artifacts?.map((artifact, i) => <div key={i}>{artifact.label}：{artifact.location}</div>)}
            </article>)}
          </div>
        </div>
      ) : null}
        </>
      ) : null}
    </div>
  )
}

const TAB_STYLE: CSSProperties = {
  padding: '6px 14px',
  border: 0,
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #4a4e57)',
  cursor: 'pointer',
  fontSize: 13,
}

const TAB_ACTIVE_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-accent-primary, #3b6ef6)',
  borderBottom: '2px solid var(--dsw-alias-accent-primary, #3b6ef6)',
  fontWeight: 500,
}
