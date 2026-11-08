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

/* ─────────────────── I7 round 2：延期积压不得让每轮全扫 ─────────────────── */

/** 计数包装：统计消费侧对真实索引的判定查询次数。 */
function countedIndex(index: SessionHeaderIndex, checks: { verdict: number }) {
  return new Proxy(index, {
    get(target, prop, receiver) {
      if (prop === 'verdictOf') {
        return (sessionId: string) => {
          checks.verdict += 1
          return target.verdictOf(sessionId)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** 可注入时钟。 */
function clock(start = 0) {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

describe('I7 round 2：大量未到期延期候选不得让每轮全扫（真实索引计数）', () => {
  /** 造 1000 个 live router 候选（成员表为空 → 全部进入延期队列）。 */
  function backlog(count: number) {
    const membership = countedMembership([{ id: 'ws', sessionIds: [] as string[] }])
    const index = new SessionHeaderIndex({
      root: '/nonexistent-router-backlog-root',
      routerPreset: 'dsh-router',
      membership: membership.face,
      resolveLivePreset: () => 'dsh-router',
    })
    for (let i = 0; i < count; i += 1) index.onLiveSession(liveRouterSession(`s${i}`))
    const checks = { verdict: 0 }
    const deps = {
      index: countedIndex(index, checks),
      known: () => false,
      register: async () => {},
      deliver: async () => {},
    }
    return { index, membership, checks, deps }
  }

  it('1000 个未到期延期 + 零新授予：一轮零判定查询、零授予访问', async () => {
    const { index, checks, deps } = backlog(1000)
    await index.reconcile()
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    // 100 轮预算 10 → 1000 个候选全部延期（成员表为空 → not-member）。
    for (let round = 0; round < 100; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    }
    expect(cache.deferred.size, '1000 个候选都该在延期队列里').toBe(1000)

    // 关键一轮：没有到期重试、也没有新授予 → 不该有任何检查/枚举。
    checks.verdict = 0
    const visitsBefore = index.diagnostics().grant.visits
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    expect(checks.verdict, '未到期延期不得触发逐条判定查询').toBe(0)
    expect(index.diagnostics().grant.visits - visitsBefore, '未到期延期不得触发授予面枚举').toBe(0)
    expect(cache.deferred.size).toBe(1000)
    await index.dispose()
  })

  it('到期重试与新授予都受单轮预算约束（检查量随有效工作增长）', async () => {
    const { index, checks, deps } = backlog(1000)
    await index.reconcile()
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    for (let round = 0; round < 100; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    }
    // 让全部延期到期：下一轮只应处理预算内的候选。
    time.advance(10_000)
    checks.verdict = 0
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    // 每个候选最多 3 次判定查询（定位后 / 核验后 / 登记后）→ 检查量与预算同阶。
    expect(checks.verdict).toBeLessThanOrEqual(30)
    expect(checks.verdict).toBeGreaterThan(0)
    await index.dispose()
  })

  it('旧延期前缀之后出现的新授予仍及时交付（不被旧积压挡住）', async () => {
    const membership = countedMembership([{ id: 'ws', sessionIds: [] as string[] }])
    const index = new SessionHeaderIndex({
      root: '/nonexistent-router-backlog-root',
      routerPreset: 'dsh-router',
      membership: membership.face,
      resolveLivePreset: () => 'dsh-router',
    })
    for (let i = 0; i < 1000; i += 1) index.onLiveSession(liveRouterSession(`s${i}`))
    await index.reconcile()
    const registered: string[] = []
    const delivered: string[] = []
    const checks = { verdict: 0 }
    const deps = {
      index: countedIndex(index, checks),
      known: () => false,
      register: async (sessionId: string) => { registered.push(sessionId) },
      deliver: async (sessionId: string) => { delivered.push(sessionId) },
    }
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    for (let round = 0; round < 100; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    }
    expect(cache.deferred.size).toBe(1000)
    expect(registered).toEqual([])

    // 新候选出现且挂进工作区：下一轮就该被交付（不等 1000 个旧延期）。
    membership.face.get('ws')!.sessionIds.push('fresh')
    index.onLiveSession(liveRouterSession('fresh'))
    await index.reconcile()
    checks.verdict = 0
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    expect(registered, '新授予必须及时交付').toEqual(['fresh'])
    expect(delivered).toEqual(['fresh'])
    expect(checks.verdict, '这一轮只该检查新候选，不该遍历旧积压').toBeLessThanOrEqual(3)
    await index.dispose()
  })

  it('新一代资格接管旧的延期项（不被旧退避吞掉）', async () => {
    const membership = countedMembership([{ id: 'ws', sessionIds: [] as string[] }])
    const index = new SessionHeaderIndex({
      root: '/nonexistent-router-backlog-root',
      routerPreset: 'dsh-router',
      membership: membership.face,
      resolveLivePreset: () => 'dsh-router',
    })
    const session = liveRouterSession('s0')
    index.onLiveSession(session)
    await index.reconcile()
    const registered: string[] = []
    const deps = {
      index,
      known: () => false,
      register: async (sessionId: string) => { registered.push(sessionId) },
      deliver: async () => {},
    }
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(cache.deferred.size).toBe(1)

    // 资格先失效（组合翻到别的预设）→ 旧一代授予被撤销；
    // 再重新成立（翻回 router）→ 新一代授予回到未领取面。
    index.onLiveSessionEvent(session, { type: 'agent-preset/selected', data: { agentPreset: 'other' } })
    index.onLiveSessionEvent(session, { type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } })
    // 同时它挂进了工作区（此前 1000 个候选都因为"不是成员"而延期）。
    membership.face.get('ws')!.sessionIds.push('s0')
    await index.reconcile()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(registered, '新一代资格必须立即收编，不等旧退避').toEqual(['s0'])
    expect(cache.deferred.size).toBe(0)
    await index.dispose()
  })
})

describe('I7 补充：同工作区批次的成员读取成本（如实记录，不弱化授权核验）', () => {
  it('同工作区 1000 个已确认 Router：成员读取量按 候选数 × 工作区成员数 增长', async () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `s${index}`)
    const membership = countedMembership([{ id: 'ws', sessionIds: [...ids] }])
    const index = new SessionHeaderIndex({
      root: '/nonexistent-router-samews-root',
      routerPreset: 'dsh-router',
      membership: membership.face,
      resolveLivePreset: () => 'dsh-router',
    })
    for (const id of ids) index.onLiveSession(liveRouterSession(id))
    await index.reconcile()
    const deps = {
      index,
      known: () => true, // 已登记 → 每候选只做一次定点授权核验
      register: async () => {},
      deliver: async () => {},
    }
    const cache = createRouterAdoptionCache()
    membership.state.elementReads = 0
    // 把 1000 个候选全部过一轮（预算 10 → 100 轮）：每个候选一次定点成员
    // 核验 × 该工作区的 1000 个成员 = 候选数 × 工作区成员数（如实记录）。
    for (let round = 0; round < 100; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { budgetPerRound: 10 })
    }
    expect(membership.state.elementReads).toBe(1_000_000)
    // 稳态（无待消费授予、无到期重试）→ 零成员读取。
    membership.state.elementReads = 0
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { budgetPerRound: 10 })
    expect(membership.state.elementReads, '稳态不得再读成员数组').toBe(0)
    await index.dispose()
  })
})
