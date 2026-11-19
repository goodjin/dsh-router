/**
 * 任务列表（任务标签左栏，纯列表）。
 *
 * 每行：标题、四态进度计数与占比条、最近报告时间；点行在右侧查看任务详情。
 * 画布形态在「任务图」标签（task-canvas.tsx），两者数据同源、互不依赖。
 */

import type { CSSProperties, ReactNode } from 'react'

import type { TaskView } from './task-view-model.ts'

const ROW_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'start',
  padding: '8px 10px',
  marginBottom: 6,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  fontSize: 12,
  boxShadow: 'var(--dsw-elevation-stroke, 0 1px 2px rgba(0,0,0,0.04))',
}

const ROW_SELECTED_STYLE: CSSProperties = {
  ...ROW_STYLE,
  border: '1px solid var(--dsw-alias-accent-primary, #3b6ef6)',
}

const PROGRESS_TRACK_STYLE: CSSProperties = {
  display: 'flex',
  height: 4,
  borderRadius: 2,
  overflow: 'hidden',
  background: 'var(--dsw-alias-border-l2, #e4e7ec)',
  marginTop: 6,
}

const SEGMENT_COLORS = {
  pending: '#aab0b8',
  active: '#3b6ef6',
  blocked: '#e08a1e',
  reported: '#2f9e63',
} as const

function formatTime(timestamp: number | undefined): string {
  if (timestamp === undefined) return ''
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return ''
  }
}

/** 任务列表入口属性。 */
export interface TaskListProps {
  tasks: TaskView[]
  selectedTaskId: string | undefined
  onSelect(taskId: string): void
}

/** 任务列表：纯列表行，选中态高亮。 */
export function TaskList(props: TaskListProps): ReactNode {
  return (
    <nav data-router-collab-task-list style={{ width: 280, flexShrink: 0 }}>
      {props.tasks.map((task) => {
        const { progress } = task
        const counts = `待处理 ${progress.pending} · 进行中 ${progress.active} · 受阻 ${progress.blocked} · 已报告 ${progress.reported}`
          + (progress.unlabeled > 0 ? ` · 未标注 ${progress.unlabeled}` : '')
        const lastReport = formatTime(task.lastReportAt)
        return (
          <button
            key={task.taskId}
            type="button"
            data-router-collab-task-item={task.taskId}
            style={task.taskId === props.selectedTaskId ? ROW_SELECTED_STYLE : ROW_STYLE}
            onClick={() => { props.onSelect(task.taskId) }}
          >
            <span style={{ display: 'block', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {task.title}
            </span>
            <span data-router-collab-task-progress style={{ display: 'block', marginTop: 4, color: '#4a4e57' }}>{counts}</span>
            <span data-router-collab-task-progressbar style={PROGRESS_TRACK_STYLE} aria-hidden>
              {progress.total > 0
                ? (Object.keys(SEGMENT_COLORS) as Array<keyof typeof SEGMENT_COLORS>).map((key) => (
                    progress[key] > 0
                      ? <span key={key} style={{ width: `${(progress[key] / progress.total) * 100}%`, background: SEGMENT_COLORS[key] }} />
                      : null
                  ))
                : null}
            </span>
            {lastReport !== '' ? <span style={{ display: 'block', marginTop: 4, color: '#6b7078' }}>最近报告 {lastReport}</span> : null}
          </button>
        )
      })}
    </nav>
  )
}
