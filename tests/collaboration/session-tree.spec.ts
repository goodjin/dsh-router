/**
 * 会话树构建与布局测试（协作视图页画布）。
 *
 * brief 命名断言：
 *  - tree_builds_real_edges：按 subagentCatalog 逐层构建真实父子树（默认两层深），
 *    状态 running/inactive/unknown 如实映射，工作标签只挂被关联的节点。
 *  - tree_prunes_to_linked：任务有关联会话时，只保留「关联节点 + 其后代 + 通向根的祖先链」。
 *  - tree_keeps_all_when_unlinked：无关联会话时保留整棵子会话树（刚组队、记录未落）。
 *  - tree_orphans_listed：不在树里的关联会话单独列为孤儿节点，不臆造父边。
 *  - tree_cycle_guard：目录数据成环/自指不死循环。
 *  - layout_leaves_then_midpoint：叶子按序占行、父节点居子女中点、连线数 = 节点数 - 1，
 *    尺寸随层数与叶子数增长。
 */

import { describe, expect, it } from 'vitest'

import { buildSessionTree, layoutTree, type SessionTreeInput } from '../../src/client/session-tree.ts'

interface CatalogEntryStub { id: string; label?: string }

function makeInput(overrides: Partial<SessionTreeInput> & { rootId: string }): SessionTreeInput {
  return {
    maxDepth: 2,
    childrenOf: () => [],
    statusOf: () => undefined,
    linked: new Map(),
    ...overrides,
  }
}

function catalogOf(map: Record<string, CatalogEntryStub[]>): (id: string) => CatalogEntryStub[] {
  return (id: string) => map[id] ?? []
}

describe('tree_builds_real_edges — 真实父子树与状态映射', () => {
  it('两层树：root → w1/w2，w1 → c1；状态与工作标签如实', () => {
    const result = buildSessionTree(makeInput({
      rootId: 'root-1',
      rootLabel: '根会话',
      childrenOf: catalogOf({
        'root-1': [{ id: 'w1', label: '前端' }, { id: 'w2', label: '后端' }],
        w1: [{ id: 'c1', label: '样式' }],
        w2: [],
      }),
      statusOf: (id) => (id === 'w1' ? true : id === 'w2' ? false : undefined),
      // w1、w2 都被关联：整树保留（剪枝行为在 tree_prunes_to_linked 单独验证）。
      linked: new Map([['w1', '进行中'], ['w2', '受阻']]),
    }))
    expect(result.root.sessionId).toBe('root-1')
    expect(result.root.label).toBe('根会话')
    expect(result.root.children.map((c) => c.sessionId)).toEqual(['w1', 'w2'])
    const w1 = result.root.children[0]!
    expect(w1.children.map((c) => c.sessionId)).toEqual(['c1'])
    expect(w1.status).toBe('running')
    expect(w1.workLabel).toBe('进行中')
    expect(w1.linked).toBe(true)
    expect(result.root.children[1]!.status).toBe('inactive')
    expect(w1.children[0]!.status).toBe('unknown')
    expect(w1.children[0]!.linked).toBe(false)
    expect(w1.children[0]!.workLabel).toBeUndefined()
    expect(result.orphans).toEqual([])
  })

  it('maxDepth 默认 2：第三层不再展开', () => {
    const result = buildSessionTree(makeInput({
      rootId: 'root',
      childrenOf: catalogOf({
        root: [{ id: 'w1' }],
        w1: [{ id: 'c1' }],
        c1: [{ id: 'd1' }],
      }),
    }))
    expect(result.root.children[0]!.children[0]!.sessionId).toBe('c1')
    expect(result.root.children[0]!.children[0]!.children).toEqual([])
  })
})

describe('tree_prunes_to_linked — 有关联时只留关联闭包', () => {
  it('只关联 w2：保留 root→w2，剪掉 w1 及其子代', () => {
    const result = buildSessionTree(makeInput({
      rootId: 'root',
      childrenOf: catalogOf({
        root: [{ id: 'w1', label: '无关' }, { id: 'w2', label: '有关' }],
        w1: [{ id: 'c1' }],
      }),
      linked: new Map([['w2', undefined]]),
    }))
    expect(result.root.children.map((c) => c.sessionId)).toEqual(['w2'])
  })

  it('关联 w1：保留 root→w1 及其未关联的后代 c1/c2，剪掉 w2', () => {
    const result = buildSessionTree(makeInput({
      rootId: 'root',
      childrenOf: catalogOf({
        root: [{ id: 'w1' }, { id: 'w2' }],
        w1: [{ id: 'c1' }, { id: 'c2' }],
      }),
      linked: new Map([['w1', '已报告']]),
    }))
    const w1 = result.root.children[0]!
    expect(w1.sessionId).toBe('w1')
    // 关联节点的后代保留（成员往下派的子会话也是该成员的执行），即使后代未被关联。
    expect(w1.children.map((c) => c.sessionId)).toEqual(['c1', 'c2'])
    expect(w1.children[0]!.linked).toBe(false)
    expect(result.root.children).toHaveLength(1)
  })

  it('关联孙子 c1：保留整条祖先链 root→w1→c1；深度上限外的子代不展示', () => {
    const result = buildSessionTree(makeInput({
      rootId: 'root',
      childrenOf: catalogOf({
        root: [{ id: 'w1' }, { id: 'w2' }],
        w1: [{ id: 'c1' }, { id: 'c2' }],
        c1: [{ id: 'd1' }],
      }),
      linked: new Map([['c1', '已报告']]),
    }))
    const w1 = result.root.children[0]!
    expect(w1.sessionId).toBe('w1')
    expect(w1.children.map((c) => c.sessionId)).toEqual(['c1'])
    // d1 在深度 3，超出 maxDepth=2 的构建范围：不展示（孤儿也不臆造父边）。
    expect(w1.children[0]!.children).toEqual([])
    expect(result.root.children).toHaveLength(1)
    expect(result.orphans.map((o) => o.sessionId)).toEqual([])
  })
})

describe('tree_keeps_all_when_unlinked — 无关联时整树保留', () => {
  it('linked 为空：全部子会话可见', () => {
    const result = buildSessionTree(makeInput({
      rootId: 'root',
      childrenOf: catalogOf({ root: [{ id: 'w1' }, { id: 'w2' }] }),
      linked: new Map(),
    }))
    expect(result.root.children.map((c) => c.sessionId)).toEqual(['w1', 'w2'])
  })
})

describe('tree_orphans_listed — 不在树里的关联会话列为孤儿', () => {
  it('关联了树外会话：orphans 收录，不臆造父边', () => {
    const result = buildSessionTree(makeInput({
      rootId: 'root',
      childrenOf: catalogOf({ root: [{ id: 'w1' }] }),
      linked: new Map([['w1', '进行中'], ['outside-9', undefined]]),
      titleOf: (id) => (id === 'outside-9' ? '外部会话' : undefined),
    }))
    expect(result.root.children.map((c) => c.sessionId)).toEqual(['w1'])
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0]!.sessionId).toBe('outside-9')
    expect(result.orphans[0]!.label).toBe('外部会话')
    expect(result.orphans[0]!.linked).toBe(true)
    expect(result.orphans[0]!.children).toEqual([])
  })
})

describe('tree_cycle_guard — 目录成环不死循环', () => {
  it('自指与他指环：构建终止，节点不重复', () => {
    const result = buildSessionTree(makeInput({
      rootId: 'root',
      childrenOf: catalogOf({
        root: [{ id: 'a' }, { id: 'root' }],
        a: [{ id: 'b' }],
        b: [{ id: 'a' }],
      }),
    }))
    const ids: string[] = []
    const walk = (n: { sessionId: string; children: unknown[] }): void => {
      ids.push(n.sessionId)
      for (const child of n.children as Array<{ sessionId: string; children: unknown[] }>) walk(child)
    }
    walk(result.root as never)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('root')
    expect(ids).toContain('a')
    expect(ids).toContain('b')
  })
})

describe('layout_leaves_then_midpoint — 布局：叶子顺序行、父居中、连线齐', () => {
  it('布局树形：叶子依次占行，父取子女中点，边数 = 节点数 - 1', () => {
    const { root } = buildSessionTree(makeInput({
      rootId: 'root',
      childrenOf: catalogOf({
        root: [{ id: 'w1' }, { id: 'w2' }],
        w1: [{ id: 'c1' }, { id: 'c2' }],
      }),
    }))
    const layout = layoutTree(root)
    const nodes = layout.nodes
    expect(nodes).toHaveLength(5)
    expect(layout.edges).toHaveLength(4)
    const byId = new Map(nodes.map((n) => [n.node.sessionId, n]))
    // 深度 → 列。
    expect(byId.get('root')!.depth).toBe(0)
    expect(byId.get('w1')!.depth).toBe(1)
    expect(byId.get('c1')!.depth).toBe(2)
    // 叶子按序占行：c1 在 w2 之前（先序叶序）。
    expect(byId.get('c1')!.y).toBeLessThan(byId.get('c2')!.y)
    expect(byId.get('c2')!.y).toBeLessThan(byId.get('w2')!.y)
    // 父居子女中点。
    expect(byId.get('w1')!.y).toBe((byId.get('c1')!.y + byId.get('c2')!.y) / 2)
    // 尺寸：宽度随最大深度、高度随叶数增长。
    expect(layout.width).toBeGreaterThanOrEqual(3)
    expect(layout.height).toBeGreaterThanOrEqual(3)
    // 边端点对上父子节点。
    const edge = layout.edges.find((e) => e.to === 'c1')!
    expect(edge.from).toBe('w1')
  })
})
