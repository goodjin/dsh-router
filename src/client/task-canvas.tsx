/**
 * 任务画布（任务标签主视图）。
 *
 * 节点 = 任务（卡片：标题 + 四态进度条与计数），连线 = 任务派生关系
 * （deriveTaskGraph 从会话父子推导，无派生来源的任务挂虚拟根成林）。
 * 点选节点在右侧/下方展开任务详情。纯 HTML/SVG 自绘，不引图形库。
 */

import type { CSSProperties, ReactNode } from 'react'

import { type TaskGraphResult, TASK_GRAPH_ROOT_KEY } from './task-graph.ts'
import { layoutKeyTree } from './session-tree.ts'

const NODE_WIDTH = 210
const NODE_HEIGHT = 72
const GAP_X = 80
const GAP_Y = 26

const CANVAS_STYLE: CSSProperties = {
  overflow: 'auto',
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-l1, #fafbfc)',
  padding: 10,
}

const NODE_STYLE: CSSProperties = {
  position: 'absolute',
  width: NODE_WIDTH,
  minHeight: NODE_HEIGHT,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  cursor: 'pointer',
  textAlign: 'start',
  fontSize: 12,
  lineHeight: 1.4,
  boxShadow: 'var(--dsw-elevation-stroke, 0 1px 2px rgba(0,0,0,0.04))',
}

const NODE_SELECTED_STYLE: CSSProperties = {
  ...NODE_STYLE,
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

/** 任务画布入口属性。 */
export interface TaskCanvasProps {
  graph: TaskGraphResult
  selectedTaskId: string | undefined
  onSelect(taskId: string): void
}

/** 任务画布：派生连线 + 任务节点卡。 */
export function TaskCanvas(props: TaskCanvasProps): ReactNode {
  const graph = props.graph
  if (!graph.nodes.length) return <p>暂无任务记录</p>
  const layout = layoutKeyTree(graph.root, { columnWidth: NODE_WIDTH + GAP_X, rowHeight: NODE_HEIGHT + GAP_Y })
  const taskByKey = new Map(graph.nodes.map((entry) => [entry.taskId, entry.task]))
  // 虚拟根不显示，也不占一列，主任务从画布左边开始。
  const column = NODE_WIDTH + GAP_X
  const width = layout.width - column

  return (
    <div data-router-collab-task-canvas style={CANVAS_STYLE}>
      <div style={{ position: 'relative', width, height: layout.height }}>
        <svg width={width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden>
          {layout.edges
            .filter((edge) => edge.from !== TASK_GRAPH_ROOT_KEY)
            .map((edge) => (
              <path
                key={`${edge.from}:${edge.to}`}
                d={`M ${edge.x1 - column + NODE_WIDTH} ${edge.y1 + NODE_HEIGHT / 2} C ${edge.x1 - column + NODE_WIDTH + GAP_X / 2} ${edge.y1 + NODE_HEIGHT / 2}, ${edge.x2 - column - GAP_X / 2} ${edge.y2 + NODE_HEIGHT / 2}, ${edge.x2 - column} ${edge.y2 + NODE_HEIGHT / 2}`}
                fill="none"
                stroke="var(--dsw-alias-accent-primary, #3b6ef6)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            ))}
        </svg>
        {layout.nodes.map(({ node, x, y }) => {
          if (node.key === TASK_GRAPH_ROOT_KEY) return null
          const task = taskByKey.get(node.key)
          if (task === undefined) return null
          const { progress } = task
          const counts = `待处理 ${progress.pending} · 进行中 ${progress.active} · 受阻 ${progress.blocked} · 已报告 ${progress.reported}`
            + (progress.unlabeled > 0 ? ` · 未标注 ${progress.unlabeled}` : '')
          return (
            <button
              key={node.key}
              type="button"
              data-router-collab-task-node={node.key}
              style={{ ...(node.key === props.selectedTaskId ? NODE_SELECTED_STYLE : NODE_STYLE), left: x - column, top: y }}
              onClick={() => { props.onSelect(node.key) }}
            >
              <span data-router-collab-task-title={node.key} style={{ display: 'block', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
            </button>
          )
        })}
      </div>
    </div>
  )
}
