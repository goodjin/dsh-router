/**
 * 记录详情（协作视图页任务详情内，自旧面板移植）。
 *
 * 三类信息分开：模型报告标注 + 纯文本正文 + 工作标签（模型所填，不以宿主运行状态改写）
 * + 会话跳转（运行状态来自页面会话状态数据，缺省按未知降级）+ 成果引用（仅展示）。
 * 会话跳转用记录内 sessions 的精确 sessionId，只响应点击，不抢焦点、不自动切换。
 */

import { useSyncExternalStore, type ReactNode } from 'react'

import type { CollaborationStore } from './collaboration-store.ts'
import type { WorkRecord } from '../collaboration/types.ts'
import type { SessionRunStatus } from './session-tree.ts'

const KIND_LABEL: Record<WorkRecord['kind'], string> = {
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

const RUNTIME_FACT_TEXT: Record<SessionRunStatus, string> = {
  running: '运行中',
  inactive: '已结束',
  unknown: '运行状态未知，请打开会话查看',
}

const SECTION_STYLE = {
  marginTop: 12,
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
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

const BODY_STYLE = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: '6px 0',
  padding: 8,
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
} as const

/** 详情入口属性：store + 会话状态读取（布尔 running；缺省 unknown）+ 跳转回调。 */
export interface RecordDetailProps {
  store: CollaborationStore
  statusOf(sessionId: string): boolean | undefined
  onOpenSession(sessionId: string): void
}

/** 记录详情：模型报告标注 + 正文 + 工作标签 + 会话跳转（带运行状态）+ 成果引用。 */
export function RecordDetail(props: RecordDetailProps): ReactNode {
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
            const running = props.statusOf(session.sessionId)
            const fact: SessionRunStatus = running === true ? 'running' : running === false ? 'inactive' : 'unknown'
            return (
              <div key={session.sessionId} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <button
                  type="button"
                  data-router-collab-session-link={session.sessionId}
                  style={BUTTON_STYLE}
                  onClick={() => { props.onOpenSession(session.sessionId) }}
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
