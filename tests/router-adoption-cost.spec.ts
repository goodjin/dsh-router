/**
 * 收编扫描的成本护栏（v1.4 索引面 + 增量成员定位）。
 *
 * 2026-11-07 现场（OOM 事故）：/router/state 每 2.5 秒轮询一次，旧实现每次都
 * 对**全语料**逐个 readSession——那一步会把已落盘会话的整段日志读出来并深拷贝
 * 全部事件。本机 7967 个会话、2.4 GB，于是宿主 200%+ CPU，几十分钟堆满 4 GB
 * JS 堆（一天五次）。
 *
 * 本文件钉住收编侧的成本边界（review I7）：
 *   1. 稳态零枚举：没有待消费候选、也没有到期重试时，收编轮次**一次都不**
 *      遍历宿主成员面（list() 调用数与成员元素读取数都是 0）；
 *   2. 增量成本与候选数相关、与语料总量无关：定点成员核验只读**被点名的
 *      工作区**，不去遍历其它工作区的大成员表；
 *   3. 每轮预算：异步副作用数封顶，余下候选下一轮继续推进；
 *   4. 单飞：进行中的扫描未落定，并发调用并入同一轮；
 *   5. 身份卡投递幂等：投过一次的不重发。
 *
 * 成本证明用**真实计数**（Proxy 元素访问计数 + 队列计数），不用耗时假证明。
 */

import { describe, expect, it } from 'vitest'
import { SessionHeaderIndex } from '../src/host/session/session-index.ts'
import { createRouterAdoptionCache, routerAdoptionDiagnostics, scanAndAdoptRouterSessions } from '../src/host/bridge/router-adoption.ts'

/** 计数型成员面：list() 调用数 + 成员数组元素读取数（Proxy 计数）。 */
function countedMembership(workspaces: Array<{ id: string; sessionIds: string[] }>) {
  const state = { listCalls: 0, elementReads: 0 }
  const faces = new Map<string, { id: string; sessionIds: string[] }>()
  for (const workspace of workspaces) {
    const counted = new Proxy(workspace.sessionIds, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) state.elementReads += 1
        return Reflect.get(target, prop, receiver)
      },
    })
    faces.set(workspace.id, { id: workspace.id, sessionIds: counted })
  }
  return {
    state,
    face: {
      list: () => {
        state.listCalls += 1
        return [...faces.values()]
      },
      get: (workspaceId: string) => faces.get(workspaceId),
      archivedIds: () => [],
    },
  }
}

/** 造一个 live router 会话载荷（零盘读；权威组合 = 投影的 agentPreset）。 */
function liveRouterSession(id: string): unknown {
  return { id, header: { id, version: 4, createdAt: 1, isSeeded: false, agentPreset: 'dsh-router' } }
}

/** 造一个真实索引 + 收编依赖面（成员面为计数型）。 */
function setup(sessionIds: string[], workspaces: Array<{ id: string; sessionIds: string[] }>) {
  const membership = countedMembership(workspaces)
  const index = new SessionHeaderIndex({
    root: '/nonexistent-router-cost-root',
    routerPreset: 'dsh-router',
    membership: membership.face,
    resolveLivePreset: () => 'dsh-router',
  })
  const registered: string[] = []
  const deliveries: string[] = []
  const known = new Set<string>()
  const deps = {
    index,
    known: (sessionId: string) => known.has(sessionId),
    register: async (sessionId: string) => { registered.push(sessionId); known.add(sessionId) },
    deliver: async (sessionId: string) => { deliveries.push(sessionId) },
  }
  return { index, membership, registered, deliveries, deps }
}

describe('收编扫描的成本护栏（索引面 + 增量成员定位）', () => {
  it('稳态轮询零枚举：宿主成员面一次都不被遍历', async () => {
    const big = Array.from({ length: 10_000 }, (_, index) => `big-${index}`)
    const { index, membership, registered, deliveries, deps } = setup(
      ['router-a'],
      [{ id: 'ws-small', sessionIds: ['router-a'] }, { id: 'ws-big', sessionIds: big }],
    )
    index.onLiveSession(liveRouterSession('router-a'))
    await index.reconcile()
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(registered).toEqual(['router-a'])
    expect(deliveries).toEqual(['router-a'])

    // 计数归零后跑稳态轮次：不得再枚举成员面。
    membership.state.listCalls = 0
    membership.state.elementReads = 0
    for (let round = 0; round < 5; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    }
    expect(membership.state.listCalls, '稳态轮次又去枚举宿主成员面了').toBe(0)
    expect(membership.state.elementReads, '稳态轮次又去读成员数组了').toBe(0)
    expect(registered).toEqual(['router-a'])
    expect(deliveries).toEqual(['router-a'])
    expect(cache.counters.rounds).toBe(6)
    await index.dispose()
  })

  it('增量轮次只点目标工作区：成员读取量与语料总量无关', async () => {
    const big = Array.from({ length: 10_000 }, (_, index) => `big-${index}`)
    const { index, membership, registered, deps } = setup(
      ['router-a'],
      [{ id: 'ws-small', sessionIds: ['router-a'] }, { id: 'ws-big', sessionIds: big }],
    )
    index.onLiveSession(liveRouterSession('router-a'))
    await index.reconcile()
    // 计数归零：只统计**收编轮次**的成本（对账那一次是低频的，不算轮次成本）。
    membership.state.listCalls = 0
    membership.state.elementReads = 0
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(registered).toEqual(['router-a'])
    expect(membership.state.listCalls, '收编轮次不该枚举宿主成员面').toBe(0)
    // 只读被点名工作区的成员（ws-small 一个成员），大工作区不被遍历。
    expect(membership.state.elementReads).toBeLessThan(100)
    await index.dispose()
  })

  it('每轮预算封顶：50 个新候选一轮最多 10 次副作用，余下逐轮推进不卡死', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `s${index}`)
    const { index, membership, registered, deliveries, deps } = setup(ids, [{ id: 'ws', sessionIds: ids }])
    for (const id of ids) index.onLiveSession(liveRouterSession(id))
    await index.reconcile()
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { budgetPerRound: 10 })
    expect(registered.length, '一轮做完了全部候选的副作用').toBe(10)

    for (let round = 0; round < 4; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { budgetPerRound: 10 })
    }
    expect(registered.length, '后续轮次没继续推进').toBe(50)
    expect(deliveries.length).toBe(50)
    expect(membership.state.listCalls, '收编轮次不该枚举宿主成员面').toBe(1) // 只有对账那一次
    await index.dispose()
  })

  it('并发的扫描并成一次（单飞）', async () => {
    const ids = ['a', 'b', 'c']
    const { index, registered, deps } = setup(ids, [{ id: 'ws', sessionIds: ids }])
    for (const id of ids) index.onLiveSession(liveRouterSession(id))
    await index.reconcile()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const originalDeliver = deps.deliver
    let deliverCount = 0
    deps.deliver = async (sessionId: string) => {
      deliverCount += 1
      if (deliverCount === 3) await gate
      await originalDeliver(sessionId)
    }
    const cache = createRouterAdoptionCache()
    const second = scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    const first = scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    const third = scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    release?.()
    await Promise.all([first, second, third])
    expect(registered.length, '并发轮不该重复登记').toBe(3)
    await index.dispose()
  })
})

describe('身份卡投递的记账（索引面）', () => {
  it('投过一次的不重发；重启后（新 cache）会再确认一次', async () => {
    const ids = ['a']
    const { index, deliveries, deps } = setup(ids, [{ id: 'ws', sessionIds: ids }])
    index.onLiveSession(liveRouterSession('a'))
    await index.reconcile()
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(deliveries.length).toBe(1)

    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(deliveries.length, '第二轮又投了一遍身份卡').toBe(1)

    // 进程内 delivered 集合只活一轮进程：重启后索引首帧重新发放，收编幂等确认。
    const fresh = setup(ids, [{ id: 'ws', sessionIds: ids }])
    fresh.index.onLiveSession(liveRouterSession('a'))
    await fresh.index.reconcile()
    await scanAndAdoptRouterSessions(fresh.deps, 'dsh-router', createRouterAdoptionCache())
    expect(fresh.deliveries.length).toBe(1)
    await index.dispose()
    await fresh.index.dispose()
  })
})

describe('健康诊断（延期 / 下次重试）', () => {
  it('失败候选留在延期队列里，诊断暴露延期数与下次可试时刻', async () => {
    const ids = ['bad']
    const { index, deps } = setup(ids, [{ id: 'ws', sessionIds: ids }])
    index.onLiveSession(liveRouterSession('bad'))
    await index.reconcile()
    const cache = createRouterAdoptionCache()
    const failing = { value: true }
    deps.register = async () => { if (failing.value) throw new Error('register failed') }
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: () => 1_000, baseBackoffMs: 500 })
    const diagnostics = routerAdoptionDiagnostics(cache)
    expect(diagnostics.deferred, '失败的候选必须留在可恢复的延期队列里').toBe(1)
    expect(diagnostics.nextRetryAt).toBe(1_500)
    expect(diagnostics.deferredReasons['error']).toBe(1)
    expect(diagnostics.retriesDropped, 'v1.4 不再有永久放弃').toBe(0)
    await index.dispose()
  })
})
