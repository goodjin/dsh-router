/**
 * 任务图推导（任务画布连线，纯函数）。
 *
 * 任务之间的派生边来自**会话父子**：任务 A 的成员会话派出的子会话若是任务 B 的
 * 成员，就连 A→B（取就近的有任务归属的祖先，不跨级连边）。这是记录数据里唯一
 * 真实的派生信号——router_dispatch 登记分工时自动把成员会话关联到任务，派生链
 * 随之可推导，无需模型额外声明。
 *
 * 布局：无派生来源的任务挂到虚拟根 __root__（layoutKeyTree 一次成林）；父任务不唯一或形成环时保留为独立节点。
 */

import type { TaskView } from './task-view-model.ts'
import type { KeyTreeLayoutNode } from './session-tree.ts'

/** 虚拟根键（无派生来源的任务都挂它下面）。 */
export const TASK_GRAPH_ROOT_KEY = '__root__'


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
  // 同一会话若属于多项任务，不能拿记录顺序决定谁是父任务。
  const owners = new Map<string, Set<string>>()
  for (const task of input.tasks) for (const id of task.ownerSessionIds) {
    const set = owners.get(id) ?? new Set<string>()
    set.add(task.taskId); owners.set(id, set)
  }
  const candidates = new Map<string, Set<string>>()
  const visited = new Set<string>()
  const queue: Array<[string, string | undefined]> = input.rootId ? [[input.rootId, undefined]] : []
  for (let i = 0; i < queue.length; i++) {
    const [id, ancestor] = queue[i]!
    if (visited.has(id)) continue
    visited.add(id)
    const set = owners.get(id)
    const owner = set?.size === 1 ? set.values().next().value : undefined
    if (owner && ancestor && owner !== ancestor) {
      const parents = candidates.get(owner) ?? new Set<string>()
      parents.add(ancestor); candidates.set(owner, parents)
    }
    const next = set === undefined ? ancestor : owner
    for (const child of input.childrenOf(id)) if (child?.id) queue.push([child.id, next])
  }
  const parents = new Map<string, string>()
  for (const [id, set] of candidates) if (set.size === 1) parents.set(id, [...set][0]!)
  // 矛盾记录可能形成环。移除环内的父边，不丢失节点或其无冲突后代。
  const done = new Set<string>()
  for (const id of parents.keys()) {
    const path = new Map<string, number>()
    let current: string | undefined = id
    while (current !== undefined && !done.has(current)) {
      if (path.has(current)) {
        for (const item of [...path.keys()].slice(path.get(current))) parents.delete(item)
        break
      }
      path.set(current, path.size); current = parents.get(current)
    }
    for (const item of path.keys()) done.add(item)
  }
  const root: TaskGraphNode = { key: TASK_GRAPH_ROOT_KEY, taskId: TASK_GRAPH_ROOT_KEY, task: undefined, children: [] }
  const nodes = input.tasks.map(task => ({ taskId: task.taskId, task }))
  const byId = new Map(nodes.map(n => [n.taskId, { ...n, key: n.taskId, children: [] } as TaskGraphNode]))
  for (const node of byId.values()) (byId.get(parents.get(node.key) ?? '') ?? root).children.push(node)
  return {root, nodes, edges: [...parents].map(([to, from]) => ({from, to}))}
}
