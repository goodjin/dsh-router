/**
 * 会话画布（协作视图页任务详情主视图）。
 *
 * 节点 = 会话（卡片：名称 + 状态点 + 分工工作标签），连线 = subagentCatalog 给出的
 * 真实父子关系；点击节点跳到该会话。数量多时按层级排布、画布整体可滚动。
 * 目录数据经 onRequestChildren 按需请求（sessions.refreshProjections），请求过的 id
 * 不重复请求；树外孤儿关联会话单独成行，不臆造父边。纯 HTML/SVG 自绘，不引图形库。
 *
 * 取数回调每渲染由父组件新建（携带最新投影数据），因此树**每渲染重建**（树很小），
 * 不做 memo——memo 会冻结首轮闭包，画布将看不到后续加载的目录。
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'

import { buildSessionTree, layoutTree } from './session-tree.ts'
import type { SessionRunStatus } from './session-tree.ts'
import type { WorkLabel } from '../collaboration/types.ts'

const STATUS_TEXT: Record<SessionRunStatus, string> = {
  running: '运行中',
  inactive: '已结束',
  unknown: '状态未知',
}

const STATUS_COLOR: Record<SessionRunStatus, string> = {
  running: '#2f9e63',
  inactive: '#aab0b8',
  unknown: '#e08a1e',
}

const NODE_WIDTH = 190
const NODE_HEIGHT = 64
const NODE_GAP_X = 90
const NODE_GAP_Y = 30

const NODE_STYLE: CSSProperties = {
  position: 'absolute',
  width: NODE_WIDTH,
  minHeight: NODE_HEIGHT,
  padding: '6px 8px',
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

const CANVAS_STYLE: CSSProperties = {
  overflow: 'auto',
  border: '1px solid var(--dsw-alias-border-l2, #e4e7ec)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-l1, #fafbfc)',
  padding: 10,
}

/** 画布入口属性：全部纯数据 + 回调，组件不做任何取数。 */
export interface SessionCanvasProps {
  rootId: string | undefined
  /** 该任务记录关联的会话 → 分工工作标签（键存在即关联）。 */
  linked: Map<string, WorkLabel | undefined>
  childrenOf(sessionId: string): Array<{ id: string; label?: string }>
  statusOf(sessionId: string): boolean | undefined
  titleOf(sessionId: string): string | undefined
  /** 请求加载某会话的子会话目录（sessions.refreshProjections）。 */
  onRequestChildren(sessionId: string): void
  onOpenSession(sessionId: string): void
}

/** 会话画布：父子树 + 孤儿行。 */
export function SessionCanvas(props: SessionCanvasProps): ReactNode {
  const requestedRef = useRef<Set<string>>(new Set())

  // 根变化 → 重置请求记录并请求根目录（回调身份变化不触发，避免循环）。
  useEffect(() => {
    requestedRef.current = new Set()
    if (props.rootId !== undefined) {
      requestedRef.current.add(props.rootId)
      props.onRequestChildren(props.rootId)
    }
  }, [props.rootId])

  const result = props.rootId === undefined
    ? undefined
    : buildSessionTree({
        rootId: props.rootId,
        maxDepth: 2,
        childrenOf: props.childrenOf,
        statusOf: props.statusOf,
        titleOf: props.titleOf,
        linked: props.linked,
      })

  // 树里出现新节点 → 请求其目录（为下一层做准备）；请求过的不重复。
  useEffect(() => {
    if (result === undefined) return
    interface WalkNode { sessionId: string; children: WalkNode[] }
    const walk = (node: WalkNode): void => {
      if (!requestedRef.current.has(node.sessionId)) {
        requestedRef.current.add(node.sessionId)
        props.onRequestChildren(node.sessionId)
      }
      for (const child of node.children) walk(child)
    }
    walk(result.root)
  })

  if (result === undefined) {
    return <div data-router-collab-canvas-empty style={{ fontSize: 12, color: '#6b7078' }}>请先指定根会话</div>
  }
  const layout = layoutTree(result.root, { columnWidth: NODE_WIDTH + NODE_GAP_X, rowHeight: NODE_HEIGHT + NODE_GAP_Y })

  return (
    <div data-router-collab-canvas style={CANVAS_STYLE}>
      <div style={{ position: 'relative', width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden>
          {layout.edges.map((edge) => (
            <path
              key={`${edge.from}:${edge.to}`}
              d={`M ${edge.x1 + NODE_WIDTH} ${edge.y1 + NODE_HEIGHT / 2} C ${edge.x1 + NODE_WIDTH + NODE_GAP_X / 2} ${edge.y1 + NODE_HEIGHT / 2}, ${edge.x2 - NODE_GAP_X / 2} ${edge.y2 + NODE_HEIGHT / 2}, ${edge.x2} ${edge.y2 + NODE_HEIGHT / 2}`}
              fill="none"
              stroke="var(--dsw-alias-border-l1, #d0d4dd)"
              strokeWidth={1.5}
            />
          ))}
        </svg>
        {layout.nodes.map(({ node, x, y }) => (
          <button
            key={node.sessionId}
            type="button"
            data-router-collab-node={node.sessionId}
            style={{ ...NODE_STYLE, left: x, top: y }}
            onClick={() => { props.onOpenSession(node.sessionId) }}
          >
            <span data-router-collab-node-label={node.sessionId} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.label}
            </span>
            <span data-router-collab-node-status={node.sessionId} style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, color: '#4a4e57' }}>
              <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: STATUS_COLOR[node.status], display: 'inline-block' }} />
              {STATUS_TEXT[node.status]}
            </span>
            {node.workLabel !== undefined ? (
              <span data-router-collab-node-worklabel={node.sessionId} style={{ display: 'inline-block', marginTop: 2, fontSize: 11, padding: '1px 5px', borderRadius: 4, background: '#eef1fb', color: '#3b4a9c' }}>
                {node.workLabel}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {result.orphans.length > 0 ? (
        <div data-router-collab-orphans style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--dsw-alias-border-l2, #e4e7ec)' }}>
          <div style={{ fontSize: 11, color: '#6b7078', marginBottom: 4 }}>记录关联、但不在子会话树内：</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {result.orphans.map((orphan) => (
              <button
                key={orphan.sessionId}
                type="button"
                data-router-collab-node={orphan.sessionId}
                style={{ ...NODE_STYLE, position: 'static', width: 'auto' }}
                onClick={() => { props.onOpenSession(orphan.sessionId) }}
              >
                <span data-router-collab-node-label={orphan.sessionId}>{orphan.label}</span>
                <span data-router-collab-node-status={orphan.sessionId} style={{ marginLeft: 6, color: STATUS_COLOR[orphan.status] }}>{STATUS_TEXT[orphan.status]}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
