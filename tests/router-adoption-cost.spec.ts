/**
 * 收编扫描的成本护栏（v1.4 索引面迁移版）。
 *
 * 2026-11-07 现场（OOM 事故）：/router/state 每 2.5 秒轮询一次，旧实现每次都
 * 对**全语料**逐个 readSession——那一步会把已落盘会话的整段日志读出来并深拷贝
 * 全部事件。本机 7967 个会话、2.4 GB，于是宿主 200%+ CPU，几十分钟堆满 4 GB
 * JS 堆（一天五次）。
 *
 * v1.4 把判定迁到已验证的受限索引（SessionHeaderIndex：冷盘有界扫描 + live
 * 事件直达 + 持久化复用，由 session-index.spec/cold-scan.spec 覆盖），收编扫描
 * 只消费索引增量候选。本文件钉住收编侧的四条护栏：
 *   1. 稳态零副作用：索引无新候选的轮次，零核验、零登记、零投递；
 *   2. 每轮预算：异步副作用数封顶，余下候选下一轮继续推进；
 *   3. 失败不热重试无限循环：连续失败达上限的候选出队，等索引重新发放；
 *   4. 单飞：进行中的扫描未落定，并发调用并入同一轮。
 *   5. 身份卡投递幂等：投过一次的不重发（稳态不再逐轮请求）。
 */

import { describe, expect, it } from 'vitest'
import type { SessionHeaderIndex, SessionVerdict, VerdictLookup } from '../src/host/session/session-index.ts'
import type { RouterAdoptionDeps } from '../src/host/bridge/router-adoption.ts'
import { createRouterAdoptionCache, scanAndAdoptRouterSessions } from '../src/host/bridge/router-adoption.ts'

/** 全 router 判定的静态索引替身（ids 取当前值，工作区可后来增长）。 */
function allRoutersIndex(ids: () => readonly string[]): SessionHeaderIndex {
  return {
    verdictOf(sessionId: string): VerdictLookup {
      return ids().includes(sessionId) ? { status: 'classified', verdict: 'router' } : { status: 'pending' }
    },
    verifyDiskFacts: async (sessionIds: readonly string[]) => new Map(sessionIds.map((sessionId) => [sessionId, { ok: true }])),
  } as unknown as SessionHeaderIndex
}

/** 记录副作用次数的依赖面；delta 队列忠实模拟索引「发放一次」语义。 */
function guardrailDeps(options: {
  ids: readonly string[]
  failRegisterFor?: () => readonly string[]
}) {
  const counters = { register: 0, deliver: 0 }
  const state = {
    known: [] as string[],
    deltaQueue: [...options.ids],
    /** 工作区清单可增长（新会话是后来才出现的）。 */
    ids: [...options.ids],
  }
  const deps: RouterAdoptionDeps = {
    get workspaces() {
      return [{ id: 'ws1', sessionIds: [...state.ids] }]
    },
    index: allRoutersIndex(() => state.ids),
    known: (sessionId) => state.known.includes(sessionId),
    register: async (sessionId) => {
      const failing = options.failRegisterFor?.() ?? []
      if (failing.includes(sessionId)) throw new Error('register failed')
      counters.register += 1
      state.known.push(sessionId)
    },
    deliver: async () => { counters.deliver += 1 },
    changedCandidates: () => state.deltaQueue.splice(0),
  }
  return { deps, counters, state }
}

describe('收编扫描的成本护栏（索引面）', () => {
  it('稳态零副作用：第二轮起零登记零投递（判定在索引里跨轮复用）', async () => {
    const { deps, counters } = guardrailDeps({ ids: ['a', 'b', 'c'] })
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(counters.register).toBe(3)
    expect(counters.deliver).toBe(3)

    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(counters.register, '稳态轮次又去登记了').toBe(3)
    expect(counters.deliver, '稳态轮次又去投递了').toBe(3)
  })

  it('新会话出现仍会被收编（护栏不是一劳永逸）', async () => {
    const { deps, counters, state } = guardrailDeps({ ids: ['a'] })
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(counters.register).toBe(1)

    // 索引后来发放了新候选（工作区里也出现了）：下一轮要收编它。
    state.ids.push('new-one')
    state.deltaQueue.push('new-one')
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(counters.register).toBe(2)
    expect(counters.deliver).toBe(2)
  })

  it('每轮预算封顶：50 个新候选一轮最多 10 次副作用，余下逐轮推进不卡死', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `s${index}`)
    const { deps, counters } = guardrailDeps({ ids })
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { budgetPerRound: 10 })
    expect(counters.register, '一轮做完了全部候选的副作用').toBe(10)

    for (let round = 0; round < 4; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { budgetPerRound: 10 })
    }
    expect(counters.register, '后续轮次没继续推进').toBe(50)
    expect(counters.deliver).toBe(50)
  })

  it('失败候选不无限热重试：连续失败达上限后出队，索引重新发放时再收编', async () => {
    let failing = true
    const { deps, counters, state } = guardrailDeps({ ids: ['bad'] })
    // register 恒定失败，直到测试后半段放行。
    ;(deps as { register?: unknown }).register = async (sessionId: string) => {
      if (failing) throw new Error('register failed')
      counters.register += 1
      state.known.push(sessionId)
    }
    const cache = createRouterAdoptionCache()
    for (let round = 0; round < 6; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { retryLimitPerCandidate: 3 })
    }
    expect(counters.register, '失败候选不该被收编').toBe(0)
    expect(cache.retry.size, '达上限后该出队').toBe(0)

    // 索引重新发放（判定翻转回来）：恢复后能再收编。
    failing = false
    state.deltaQueue.push('bad')
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { retryLimitPerCandidate: 3 })
    expect(counters.register).toBe(1)
    expect(counters.deliver).toBe(1)
  })

  it('并发的扫描并成一次（单飞）', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { deps, counters } = guardrailDeps({ ids: ['a', 'b', 'c'] })
    const originalDeliver = deps.deliver
    let deliverCount = 0
    ;(deps as { deliver?: unknown }).deliver = async (sessionId: string) => {
      deliverCount += 1
      if (deliverCount === 3) {
        // 第三个投递放行前，第二轮并发调用已经进来。
        await gate
      }
      await originalDeliver(sessionId)
    }
    const cache = createRouterAdoptionCache()
    const second = scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    const first = scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    const third = scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    release?.()
    await Promise.all([first, second, third])
    expect(counters.register, '并发轮不该重复登记').toBe(3)
    expect(counters.deliver, '并发轮不该重复投递').toBe(3)
  })
})

describe('身份卡投递的记账（索引面）', () => {
  it('投过一次的不重发（每轮不再发一遍请求）；重启后（新 cache）会再确认一次', async () => {
    const { deps, counters } = guardrailDeps({ ids: ['a'] })
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(counters.deliver).toBe(1)

    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(counters.deliver, '第二轮又投了一遍身份卡').toBe(1)

    // 进程内 delivered 集合只活一轮进程：重启后索引首帧重新发放，收编幂等确认。
    const freshCache = createRouterAdoptionCache()
    const { deps: deps2, counters: counters2 } = guardrailDeps({ ids: ['a'] })
    await scanAndAdoptRouterSessions(deps2, 'dsh-router', freshCache)
    expect(counters2.deliver).toBe(1)
  })
})
