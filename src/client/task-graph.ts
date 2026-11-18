/**
 * 任务图推导（任务画布连线，纯函数）。
 *
 * 任务之间的派生边来自**会话父子**：任务 A 的成员会话派出的子会话若是任务 B 的
 * 成员，就连 A→B（取就近的有任务归属的祖先，不跨级连边）。这是记录数据里唯一
 * 真实的派生信号——router_dispatch 登记分工时自动把成员会话关联到任务，派生链
 * 随之可推导，无需模型额外声明。
 *
 * 布局：无派生来源的任务挂到虚拟根 __root__（layoutKeyTree 一次成林）；一个任务
 * 有多条派生边时，布局父取首条（按任务序），其余边照常返回供画布叠加绘制。
 */

import type { TaskView } from './task-view-model.ts'
import type { KeyTreeLayoutNode } from './session-tree.ts'

/** 虚拟根键（无派生来源的任务都挂它下面）。 */
export const TASK_GRAPH_ROOT_KEY = '__root__'

/** 深度封顶（预设派发深度 2，留裕量到 4）。 */
const MAX_SESSION_DEPTH = 4

/** 任务画布节点（满足 KeyTreeLayoutNode，可直入通用布局）。 */
export interface TaskGraphNode extends KeyTreeLayoutNode {
  /** taskId（虚拟根为 __root__）。 */
  key: string
  taskId: string
  /** 虚拟根为 undefined。 */
  task: TaskView | undefined
  children: TaskGraphNode[]
}

/** 派生边（from 派生出 to）。 */
export interface TaskGraphEdge {
  from: string
  to: string
}

/** 推导入参：任务列表 + 根会话 + 会话目录。 */
export interface TaskGraphInput {
  tasks: TaskView[]
  rootId: string | undefined
  childrenOf(sessionId: string): Array<{ id: string; label?: string }>
}

/** 推导结果：虚拟根树 + 全部任务 + 派生边。 */
export interface TaskGraphResult {
  root: TaskGraphNode
  nodes: Array<{ taskId: string; task: TaskView }>
  edges: TaskGraphEdge[]
}

/** 从会话父子推导任务派生图。 */
export function deriveTaskGraph(input: TaskGraphInput): TaskGraphResult {
  // 会话 → 任务归属（首现任务定归属，重复关联不产生歧义）。
  const taskOfSession = new Map<string, string>()
  for (const task of input.tasks) {
    for (const sessionId of task.sessionIds) {
      if (!taskOfSession.has(sessionId)) taskOfSession.set(sessionId, task.taskId)
    }
  }

  // 遍历会话树：找「就近有任务归属的祖先」，形成任务派生边。
  const parentOf = new Map<string, string>()
  const edgeSet = new Set<string>()
  const edges: TaskGraphEdge[] = []
  if (input.rootId !== undefined) {
    const visited = new Set<string>()
    const walk = (sessionId: string, nearestTaskAncestor: string | undefined, depth: number): void => {
      if (visited.has(sessionId) || depth > MAX_SESSION_DEPTH) return
      visited.add(sessionId)
      const ownTask = taskOfSession.get(sessionId)
      // 就近祖先：自己有归属则后续子树以自己为祖先；否则沿用上层最近祖先。
      const effectiveAncestor = ownTask ?? nearestTaskAncestor
      if (ownTask !== undefined && nearestTaskAncestor !== undefined && ownTask !== nearestTaskAncestor) {
        const dedup = `${nearestTaskAncestor}→${ownTask}`
        if (!edgeSet.has(dedup)) {
          edgeSet.add(dedup)
          edges.push({ from: nearestTaskAncestor, to: ownTask })
        }
      }
      for (const child of input.childrenOf(sessionId)) {
        if (child === null || typeof child !== 'object' || typeof child.id !== 'string') continue
        parentOf.set(child.id, sessionId)
        walk(child.id, effectiveAncestor, depth + 1)
      }
    }
    walk(input.rootId, undefined, 0)
  }

  // 任务节点 + 布局父（多条入边取首条，按 edges 顺序即推导顺序）。
  const nodeOf = new Map<string, TaskGraphNode>()
  for (const task of input.tasks) {
    nodeOf.set(task.taskId, { key: task.taskId, taskId: task.taskId, task, children: [] })
  }
  const root: TaskGraphNode = { key: TASK_GRAPH_ROOT_KEY, taskId: TASK_GRAPH_ROOT_KEY, task: undefined, children: [] }
  const layoutParent = new Map<string, string>()
  for (const edge of edges) {
    if (!layoutParent.has(edge.to)) layoutParent.set(edge.to, edge.from)
  }
  for (const task of input.tasks) {
    const parentKey = layoutParent.get(task.taskId)
    const parentNode = parentKey !== undefined ? nodeOf.get(parentKey) : undefined
    ;(parentNode ?? root).children.push(nodeOf.get(task.taskId)!)
  }

  return {
    root,
    nodes: input.tasks.map((task) => ({ taskId: task.taskId, task })),
    edges,
  }
}
