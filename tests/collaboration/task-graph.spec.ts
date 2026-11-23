/**
 * 任务图推导测试（任务画布连线）。
 *
 * brief 命名断言：
 *  - taskgraph_edges_from_sessions：任务派生边来自会话父子——任务 A 的成员会话派出
 *    的子会话若是任务 B 的成员，则连 A→B（就近祖先，不跨级连边）。
 *  - taskgraph_no_cross_noise：同任务内部会话父子不产生自环；无任务归属的会话不产生边。
 *  - taskgraph_multi_roots：多个无派生来源的任务各自成根（布局可共用虚拟根）。
 */

import { describe, expect, it } from 'vitest'

import { deriveTaskGraph } from '../../src/client/task-graph.ts'
import type { TaskView } from '../../src/client/task-view-model.ts'

function task(taskId: string, sessionIds: string[]): TaskView {
  return {
    taskId,
    title: `任务${taskId}`,
    summaryBody: undefined,
    progress: { pending: 0, active: 0, blocked: 0, reported: 0, unlabeled: 0, total: 0 },
    lastReportAt: undefined,
    sessionIds,
    ownerSessionIds: sessionIds,
    recordIds: [],
  }
}

describe('taskgraph_edges_from_sessions — 派生边来自会话父子', () => {
  it('A 的成员派出 B 的成员 → 边 A→B；就近祖先（跨过无归属会话）', () => {
    const tasks = [
      task('A', ['s-a1']),
      task('B', ['s-b1']),
    ]
    const graph = deriveTaskGraph({
      tasks,
      rootId: 'root',
      childrenOf: (id) => ({
        root: [{ id: 's-a1' }],
        's-a1': [{ id: 's-mid' }],
        's-mid': [{ id: 's-b1' }],
        's-b1': [],
      })[id] ?? [],
    })
    expect(graph.edges).toEqual([{ from: 'A', to: 'B' }])
    expect(graph.nodes.map((n) => n.taskId)).toEqual(['A', 'B'])
  })

  it('同任务内部父子不自环；无归属会话不产生边', () => {
    const tasks = [task('A', ['s-a1', 's-a2'])]
    const graph = deriveTaskGraph({
      tasks,
      rootId: 'root',
      childrenOf: (id) => ({
        root: [{ id: 's-a1' }],
        's-a1': [{ id: 's-a2' }],
      })[id] ?? [],
    })
    expect(graph.edges).toEqual([])
  })

  it('会话被两个任务关联：首个任务定归属，不产生歧义边', () => {
    const tasks = [task('A', ['s-x']), task('B', ['s-x'])]
    const graph = deriveTaskGraph({
      tasks,
      rootId: 'root',
      childrenOf: () => [],
    })
    expect(graph.edges).toEqual([])
    expect(graph.nodes).toHaveLength(2)
  })

  it('虚拟根：多个无派生任务都挂到 __root__，布局一次成林', () => {
    const tasks = [task('A', []), task('B', []), task('C', ['s-c1'])]
    const graph = deriveTaskGraph({
      tasks,
      rootId: 'root',
      childrenOf: (id) => (id === 'root' ? [{ id: 's-c1' }] : []),
    })
    expect(graph.root.key).toBe('__root__')
    const rootChildren = graph.root.children.map((c) => c.taskId).sort()
    expect(rootChildren).toEqual(['A', 'B', 'C'])
  })
})

it('多级派发保留，归属冲突、多个父任务和循环均不硬挂', () => {
  const children: Record<string,string[]> = { r:['a','p','x'], a:['b','m'], b:['c'], p:['n'], x:['y'] }
  const build = (tasks:TaskView[]) => deriveTaskGraph({tasks,rootId:'r',childrenOf:id=>(children[id]??[]).map(id=>({id}))})
  const g=build([task('A',['a']),task('B',['b']),task('C',['c']),task('P',['p']),task('M',['m','n']),task('X',['x']),task('Z',['x']),task('Y',['y'])])
  expect(g.root.children.map(n=>n.key)).toEqual(['A','P','M','X','Z','Y'])
  expect(g.root.children[0]?.children[0]?.children[0]?.key).toBe('C')
  expect(build([task('A',['a','c']),task('B',['b'])]).root.children.map(n=>n.key)).toEqual(['A','B'])
})
