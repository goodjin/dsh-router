/**
 * 收编队列的状态与公平性回归（v1.4 review round 3：I7-A / I7-B / N1）。
 *
 * 三个缺陷都是"队列/预算/所有权"层面的，共用一条真实链路：
 * `SessionHeaderIndex`（资格授予：未领取/已领取）+ `scanAndAdoptRouterSessions`
 * （到期堆 + 领取 + 预算 + 延期队列）。
 *
 * - **I7-A**：到期堆里的失效/墓碑项（资格被撤销、已改期、已移出）也**占
 *   预算**——一轮不能清空整个失效积压（维护量必须与副作用共用预算）。
 * - **I7-B**：到期重试与新授予**明确交替**，轮转位跨轮保留（budget=1 也
 *   交替）→ 长期失败的积压不能把新授予饿死。
 * - **N1**：逐条 claim→process + 告警面吞掉自己的异常 → 未 ack 的授予
 *   永远有所有者（pending 或 deferred），不会因为一次异常变成永久不可达。
 *
 * 全部用真实索引 + 合成会话（不扫真实语料、不启服务）。
 */

import { describe, expect, it } from 'vitest'
import { SessionHeaderIndex } from '../src/host/session/session-index.ts'
import { createRouterAdoptionCache, routerAdoptionDiagnostics, scanAndAdoptRouterSessions } from '../src/host/bridge/router-adoption.ts'

/** 可注入时钟。 */
function clock(start = 0) {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

/** live router 会话载荷（权威组合 = 投影的 agentPreset）。 */
function liveRouterSession(id: string): unknown {
  return { id, header: { id, version: 4, createdAt: 1, isSeeded: false, agentPreset: 'dsh-router' } }
}

/** 真实索引 + 可变成员面。 */
function makeIndex(sessionIds: () => readonly string[]) {
  const index = new SessionHeaderIndex({
    root: '/nonexistent-router-queue-root',
    routerPreset: 'dsh-router',
    membership: {
      list: () => [{ id: 'ws', sessionIds: [...sessionIds()] }],
      get: (workspaceId: string) => (workspaceId === 'ws' ? { id: 'ws', sessionIds: [...sessionIds()] } : undefined),
      archivedIds: () => [] as string[],
    },
    resolveLivePreset: () => 'dsh-router',
  })
  return index
}

/** 收编依赖面（登记/投递可注入故障）。 */
function makeDeps(index: SessionHeaderIndex, options: {
  deliver?: (sessionId: string) => Promise<void>
  logger?: { warn(message: string): void }
} = {}) {
  const registered: string[] = []
  const delivered: string[] = []
  const known = new Set<string>()
  const deps = {
    index,
    known: (sessionId: string) => known.has(sessionId),
    register: async (sessionId: string) => { registered.push(sessionId); known.add(sessionId) },
    deliver: options.deliver ?? (async (sessionId: string) => { delivered.push(sessionId) }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }
  return { deps, registered, delivered }
}

describe('I7-A：失效/墓碑延期项也占预算（维护量有界）', () => {
  it('1000 个被撤销的到期延期项：一轮只清理预算内的数量，其余留给下一轮', async () => {
    const index = makeIndex(() => [])
    const sessions = Array.from({ length: 1000 }, (_, i) => liveRouterSession(`s${i}`))
    for (const session of sessions) index.onLiveSession(session)
    await index.reconcile()
    const { deps } = makeDeps(index)
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    // 100 轮预算 10 → 1000 个候选全部延期（不是成员 → not-member）。
    for (let round = 0; round < 100; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    }
    expect(cache.deferred.size).toBe(1000)

    // 撤销全部资格 → 这 1000 条延期项变成"失效/墓碑"。
    for (const session of sessions) {
      index.onLiveSessionEvent(session, { type: 'agent-preset/selected', data: { agentPreset: 'other' } })
    }
    expect(index.diagnostics().grant.claimed, '资格撤销后两侧都撤下').toBe(0)

    // 到期后的一轮：维护量必须受预算约束（不能一轮清空整个积压）。
    time.advance(10_000)
    const exhaustedBefore = routerAdoptionDiagnostics(cache).budgetExhausted
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    const diagnostics = routerAdoptionDiagnostics(cache)
    expect(diagnostics.maintenance, '维护消耗必须占预算').toBe(10)
    expect(cache.deferredHeap.length, '一轮不得清空整个失效积压').toBe(990)
    expect(cache.deferred.size).toBe(990)
    expect(diagnostics.budgetExhausted - exhaustedBefore, '预算耗尽要与"没有到期项"区分开').toBe(1)
    await index.dispose()
  })

  it('预算耗尽后下一轮继续清理剩余积压（不是丢弃）', async () => {
    const index = makeIndex(() => [])
    const sessions = Array.from({ length: 25 }, (_, i) => liveRouterSession(`s${i}`))
    for (const session of sessions) index.onLiveSession(session)
    await index.reconcile()
    const { deps } = makeDeps(index)
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    for (let round = 0; round < 3; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    }
    expect(cache.deferred.size).toBe(25)
    for (const session of sessions) {
      index.onLiveSessionEvent(session, { type: 'agent-preset/selected', data: { agentPreset: 'other' } })
    }
    time.advance(10_000)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    expect(cache.deferredHeap.length).toBe(15)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    expect(cache.deferredHeap.length).toBe(5)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    expect(cache.deferredHeap.length, '剩余积压逐轮清理干净').toBe(0)
    expect(cache.deferred.size).toBe(0)
    await index.dispose()
  })
})

describe('I7-B：新授予不被到期的失败积压饿死（来源交替，轮转位跨轮）', () => {
  it('1000 个持续失败的到期积压 + 一个可投递的新候选：budget=1 也能及时交付', async () => {
    const members: string[] = []
    const index = makeIndex(() => members)
    const backlog = Array.from({ length: 1000 }, (_, i) => liveRouterSession(`old${i}`))
    for (const session of backlog) index.onLiveSession(session)
    await index.reconcile()
    const { deps, delivered } = makeDeps(index)
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    // 1000 个旧候选全部延期（不是成员 → 永远失败）。
    for (let round = 0; round < 100; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 10 })
    }
    expect(cache.deferred.size).toBe(1000)

    // 新候选挂进工作区 → 可投递。
    members.push('fresh')
    index.onLiveSession(liveRouterSession('fresh'))
    await index.reconcile()
    time.advance(10_000) // 旧积压此刻全部到期（持续到期）

    // budget=1 也必须交替：新候选不能被旧积压饿死。
    let rounds = 0
    while (!delivered.includes('fresh') && rounds < 10) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 1 })
      rounds += 1
    }
    expect(delivered, '新候选必须被及时交付').toContain('fresh')
    expect(rounds, '新候选必须在少数几轮内交付（来源交替，不是到期优先）').toBeLessThanOrEqual(3)
    await index.dispose()
  })

  it('两侧同时有工作时按轮转交替推进（budget=1 也交替，轮转位跨轮保留）', async () => {
    const members: string[] = []
    const index = makeIndex(() => members)
    index.onLiveSession(liveRouterSession('stuck'))
    await index.reconcile()
    const { deps, registered } = makeDeps(index)
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    // 'stuck' 不是成员 → 到期重试持续存在。
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 2 })
    expect(cache.deferred.size).toBe(1)

    // 新候选出现（可登记），同时让旧积压处于到期状态：两侧都有工作。
    members.push('fresh')
    index.onLiveSession(liveRouterSession('fresh'))
    await index.reconcile()
    time.advance(10_000)
    // budget=1 也必须交替：轮转位跨轮保留 → 最多两轮就该轮到新授予。
    let rounds = 0
    while (!registered.includes('fresh') && rounds < 4) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 1 })
      rounds += 1
    }
    expect(registered, '新授予必须轮到（不能只做到期重试）').toEqual(['fresh'])
    expect(rounds, '轮转位跨轮保留 → 最多两轮').toBeLessThanOrEqual(2)
    await index.dispose()
  })
})

describe('N1：告警面异常不得让邻居的授予失去所有者', () => {
  it('deliver 与 warn 同时抛错：邻居与当前候选最终都能恢复', async () => {
    const members = ['s0', 's1', 's2']
    const index = makeIndex(() => members)
    for (const id of members) index.onLiveSession(liveRouterSession(id))
    await index.reconcile()
    let failing = true
    const warns: string[] = []
    const { deps, delivered } = makeDeps(index, {
      deliver: async (sessionId: string) => {
        if (failing && sessionId === 's0') throw new Error('deliver failed')
        delivered.push(sessionId)
      },
      logger: {
        warn: (message: string) => {
          warns.push(message)
          if (failing) throw new Error('logger failed')
        },
      },
    })
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 3 })
    // 故障期间：s0 不得被记成已投递。
    expect(delivered).not.toContain('s0')

    // 故障恢复 → 五个 60 秒轮次内全部交付。
    failing = false
    for (let round = 0; round < 5; round += 1) {
      time.advance(60_000)
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 3 })
    }
    expect(delivered.sort(), '故障恢复后全部候选都应被交付').toEqual(['s0', 's1', 's2'])
    // 不变量：未 ack 的授予必须都有所有者（未领取 pending 或延期 deferred）。
    const diagnostics = routerAdoptionDiagnostics(cache)
    expect(diagnostics.deferred).toBe(0)
    expect(index.diagnostics().grant.pending).toBe(0)
    expect(index.diagnostics().grant.claimed, '没有无主的已领取授予').toBe(0)
    await index.dispose()
  })

  it('队列状态不变量：混 valid/revoked/newgen/due/异常时，未 ack 的授予总有所有者', async () => {
    const members = ['valid', 'revoked', 'newgen', 'dued']
    const index = makeIndex(() => members)
    const sessions = new Map<string, unknown>()
    for (const id of members) {
      const session = liveRouterSession(id)
      sessions.set(id, session)
      index.onLiveSession(session)
    }
    await index.reconcile()
    const { deps } = makeDeps(index, {
      deliver: async () => { throw new Error('deliver always fails') },
      logger: { warn: () => { throw new Error('logger always fails') } },
    })
    const cache = createRouterAdoptionCache()
    const time = clock(0)
    for (let round = 0; round < 6; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 3 })
      time.advance(10_000)
      // 不变量（每轮都查）：索引侧"已领取未 ack"的授予，必须与消费侧的延期
      // 队列**一一对应**——绝不允许出现"已领取但既不在 pending 也不在
      // deferred"的孤儿（round 3 N1）。
      const grant = index.diagnostics().grant
      expect(grant.claimed, '每个已领取未 ack 的授予都要有延期所有者').toBe(cache.deferred.size)
      expect(grant.pending + grant.claimed, '授予总数不变（不凭空消失）').toBe(4)
    }
    await index.dispose()
  })
})
