/**
 * 会话树构建与画布布局（协作视图页，纯函数）。
 *
 * 数据源是浏览器侧会话服务的「子会话目录」投影（subagentCatalog：某会话的直接子会话）
 * 与实时运行状态。这里把逐层目录折叠成带真实父子边的树，供画布渲染：
 *  - 构建时带 visited 集合，目录数据成环/自指不死循环、节点不重复；
 *  - 深度封顶 maxDepth（默认 2，与本仓预设的子会话深度一致）；
 *  - 任务有关联会话（记录里的 sessions）时只保留「关联节点 + 其后代 + 通向根的祖先链」，
 *    无关联时保留整棵树（刚组队、记录未落也能看见团队）；
 *  - 不在树里的关联会话列为孤儿（orphans），不臆造父边；
 *  - 布局：深度定列、叶子按先序占行、父取子女中点（组织架构图式）。
 *
 * 纯函数零 IO：状态与目录由调用方以回调喂入，测试直接构造。
 */

import type { WorkLabel } from '../collaboration/types.ts'

/** 节点运行状态：true=running、false=inactive、缺省=unknown。 */
export type SessionRunStatus = 'running' | 'inactive' | 'unknown'

/** 画布节点。 */
export interface SessionNode {
  sessionId: string
  label: string
  status: SessionRunStatus
  /** 能对上该任务分工记录的成员带工作标签（模型所填）。 */
  workLabel: WorkLabel | undefined
  /** 是否被该任务记录关联。 */
  linked: boolean
  children: SessionNode[]
}

/** 构建输入：目录/状态/标题由回调喂入。 */
export interface SessionTreeInput {
  rootId: string
  rootLabel?: string
  /** 深度封顶（根为 0），默认 2。 */
  maxDepth?: number
  /** 某会话的直接子会话目录（subagentCatalog）。 */
  childrenOf(sessionId: string): Array<{ id: string; label?: string }>
  /** 某会话实时运行状态；true=running、false=inactive、undefined=unknown。 */
  statusOf(sessionId: string): boolean | undefined
  /** 备选标题（会话摘要里的标题），目录条目无 label 时用。 */
  titleOf?(sessionId: string): string | undefined
  /** 该任务记录关联的会话 → 分工工作标签（键存在即关联；值 undefined 表示无标签）。 */
  linked: Map<string, WorkLabel | undefined>
}

/** 构建结果：根树 + 树外孤儿。 */
export interface SessionTreeResult {
  root: SessionNode
  orphans: SessionNode[]
}

/** 把目录与状态折叠成带真实父子边的（可能剪枝的）会话树。 */
export function buildSessionTree(input: SessionTreeInput): SessionTreeResult {
  const maxDepth = input.maxDepth ?? 2
  const parentOf = new Map<string, string>()
  const built = new Set<string>()

  const labelOf = (id: string, catalogLabel: string | undefined): string => {
    if (catalogLabel !== undefined && catalogLabel !== '') return catalogLabel
    const title = input.titleOf?.(id)
    if (title !== undefined && title !== '') return title
    return id
  }

  const build = (id: string, catalogLabel: string | undefined, depth: number): SessionNode => {
    built.add(id)
    const linkedEntry = input.linked.get(id)
    const children: SessionNode[] = []
    if (depth < maxDepth) {
      for (const entry of input.childrenOf(id)) {
        if (built.has(entry.id)) continue // 环/重复：跳过，不死循环
        parentOf.set(entry.id, id)
        children.push(build(entry.id, entry.label, depth + 1))
      }
    }
    const running = input.statusOf(id)
    return {
      sessionId: id,
      label: id === input.rootId && input.rootLabel !== undefined && input.rootLabel !== ''
        ? input.rootLabel
        : labelOf(id, catalogLabel),
      status: running === true ? 'running' : running === false ? 'inactive' : 'unknown',
      workLabel: linkedEntry,
      linked: input.linked.has(id),
      children,
    }
  }

  const root = build(input.rootId, input.rootLabel, 0)

  // 剪枝：有关联会话时只保留「关联 + 关联的后代 + 通向根的祖先链」；无关联保留整树。
  if (input.linked.size > 0) {
    const keep = new Set<string>()
    // 关联节点若在树中 → 保留；其后代整棵保留（成员往下派的子会话也是该成员的执行）。
    const keepDown = (node: SessionNode, ancestorKept: boolean): boolean => {
      const self = node.linked || ancestorKept
      if (self) keep.add(node.sessionId)
      let anyDescendant = false
      for (const child of node.children) {
        if (keepDown(child, self)) anyDescendant = true
      }
      return self || anyDescendant
    }
    keepDown(root, false)
    // 祖先链：从每个保留节点沿 parentOf 上溯到根。
    for (const id of [...keep]) {
      let current: string | undefined = parentOf.get(id)
      while (current !== undefined && !keep.has(current)) {
        keep.add(current)
        current = parentOf.get(current)
      }
    }
    const prune = (node: SessionNode): void => {
      node.children = node.children.filter((child) => keep.has(child.sessionId))
      for (const child of node.children) prune(child)
    }
    prune(root)
  }

  // 孤儿：被关联但不在（深度内）树中的会话——单独列出，不臆造父边。
  const orphans: SessionNode[] = []
  for (const [id, workLabel] of input.linked) {
    if (built.has(id)) continue
    const running = input.statusOf(id)
    orphans.push({
      sessionId: id,
      label: labelOf(id, undefined),
      status: running === true ? 'running' : running === false ? 'inactive' : 'unknown',
      workLabel,
      linked: true,
      children: [],
    })
  }

  return { root, orphans }
}

/** 布局后的节点（坐标为格点：列 × 行）。 */
export interface PositionedNode {
  node: SessionNode
  depth: number
  x: number
  y: number
}

/** 画布布局：深度定列、叶子按先序占行、父取子女中点。 */
export interface TreeLayout {
  nodes: PositionedNode[]
  edges: Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }>
  width: number
  height: number
}

/** 组织架构图式布局：x=深度×columnWidth，y=行×rowHeight。 */
export function layoutTree(root: SessionNode, options?: { columnWidth?: number; rowHeight?: number }): TreeLayout {
  const columnWidth = options?.columnWidth ?? 220
  const rowHeight = options?.rowHeight ?? 92
  const nodes: PositionedNode[] = []
  const edges: TreeLayout['edges'] = []
  let nextRow = 0
  let maxDepth = 0

  const place = (node: SessionNode, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth)
    if (node.children.length === 0) {
      const y = nextRow * rowHeight
      nextRow += 1
      nodes.push({ node, depth, x: depth * columnWidth, y })
      return y
    }
    const childYs = node.children.map((child) => place(child, depth + 1))
    const y = (childYs[0]! + childYs[childYs.length - 1]!) / 2
    nodes.push({ node, depth, x: depth * columnWidth, y })
    for (const child of node.children) {
      const childNode = nodes.find((n) => n.node === child)!
      edges.push({ from: node.sessionId, to: child.sessionId, x1: depth * columnWidth, y1: y, x2: childNode.x, y2: childNode.y })
    }
    return y
  }

  place(root, 0)
  return { nodes, edges, width: (maxDepth + 1) * columnWidth, height: Math.max(nextRow, 1) * rowHeight }
}
