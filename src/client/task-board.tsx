/**
 * 任务看板（协作视图页主区左栏）。
 *
 * 每个任务一张卡：标题、四态进度条与计数、最近报告时间。点选在右侧展开任务详情。
 * 进度数据全部来自视图模型（deriveTasks），组件零推导。
 */

import type { CSSProperties, ReactNode } from 'react'

import type { TaskView } from './task-view-model.ts'

const CARD_STYLE: CSSProperties = {
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

const CARD_SELECTED_STYLE: CSSProperties = {
  ...CARD_STYLE,
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

/** 格式化时间（诊断性展示；非法值显示占位）。 */
function formatTime(timestamp: number | undefined): string {
  if (timestamp === undefined) return ''
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return ''
  }
}

/** 任务看板：卡片列表 + 选中态。 */
export function TaskBoard(props: {
  tasks: TaskView[]
  selectedTaskId: string | undefined
  onSelect(taskId: string): void
}): ReactNode {
  return (
    <nav data-router-collab-board style={{ width: 280, flexShrink: 0 }}>
      {props.tasks.map((task) => {
        const { progress } = task
        const counts = `待处理 ${progress.pending} · 进行中 ${progress.active} · 受阻 ${progress.blocked} · 已报告 ${progress.reported}`
          + (progress.unlabeled > 0 ? ` · 未标注 ${progress.unlabeled}` : '')
        const lastReport = formatTime(task.lastReportAt)
        return (
          <button
            key={task.taskId}
            type="button"
            data-router-collab-task={task.taskId}
            style={task.taskId === props.selectedTaskId ? CARD_SELECTED_STYLE : CARD_STYLE}
            onClick={() => { props.onSelect(task.taskId) }}
          >
            <strong style={{ fontSize: 12, fontWeight: 500 }}>{task.title}</strong>
            <div data-router-collab-task-progress style={{ marginTop: 4, color: '#4a4e57' }}>{counts}</div>
            <div data-router-collab-task-progressbar style={PROGRESS_TRACK_STYLE} aria-hidden>
              {progress.total > 0
                ? (Object.keys(SEGMENT_COLORS) as Array<keyof typeof SEGMENT_COLORS>).map((key) => (
                    progress[key] > 0
                      ? <span key={key} style={{ width: `${(progress[key] / progress.total) * 100}%`, background: SEGMENT_COLORS[key] }} />
                      : null
                  ))
                : null}
            </div>
            {lastReport !== '' ? <div style={{ marginTop: 4, color: '#6b7078' }}>最近报告 {lastReport}</div> : null}
          </button>
        )
      })}
    </nav>
  )
}
