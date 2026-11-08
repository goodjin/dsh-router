/**
 * 收编扫描的成本护栏。
 *
 * 2026-11-07 现场（OOM 事故）：/router/state 每 2.5 秒轮询一次，每次都对
 * **全语料**逐个 readSession——那一步会把已落盘会话的整段日志读出来并深拷贝
 * 全部事件。本机 7967 个会话、2.4 GB，于是宿主 200%+ CPU，几十分钟堆满
 * 4 GB JS 堆（一天五次）。
 *
 * v1.4 拆掉旧的去重器时，收编扫描没有继承它的成本护栏（单飞、失败冷却、
 * 每轮预算、判定缓存），于是每轮都从零开始重扫。注释写着「稳态零读取」，
 * 实现并没有做到——classified 是函数内的局部 Set，每轮都是新的。
 *
 * 这里钉住三件事：
 *   1. 判定跨轮复用：已判定过的会话不再 readSession；
 *   2. 每轮有预算：新判定数封顶，剩下的留到下一轮；
 *   3. 判定失败的会话进冷却，不在下一轮立刻重试。
 */

import { describe, expect, it } from 'vitest'
import {
  createRouterAdoptionCache,
  isRouterPresetSession,
  scanAndAdoptRouterSessions,
  type RouterAdoptionDeps,
} from '../src/host/bridge/router-adoption.ts'

/** 一个会话的观测结果。 */
type Observation = { events?: readonly unknown[]; header?: { agentPreset?: string } }

/** 记录每次 readSession 的会话 id。 */
function tracker(): { reads: string[] } {
  return { reads: [] }
}

/** 一组假依赖：会话读、带判定与否由 router 预设决定。 */
function deps(options: {
  reads: string[]
  /** 这些会话读的时候会抛错。 */
  failing?: readonly string[]
  /** 已经是 Router 会话（known=true）。 */
  known?: readonly string[]
}): RouterAdoptionDeps {
  return {
    workspaces: [{ id: 'ws1', sessionIds: ['a', 'b', 'c'] }],
    readSession: async (sessionId: string): Promise<Observation | undefined> => {
      options.reads.push(sessionId)
      if (options.failing?.includes(sessionId) === true) throw new Error('读取失败')
      // 只有 a 是 Router 预设会话。
      if (sessionId !== 'a') return { header: { agentPreset: 'other' } }
      return { header: { agentPreset: 'dsh-router' } }
    },
    known: (sessionId: string) => options.known?.includes(sessionId) === true,
    register: async () => {},
    deliver: async () => {},
  }
}

describe('收编扫描的成本护栏', () => {
  it('判定过的会话不重复读（第二轮零读取）', async () => {
    const reads = tracker()
    const depsOnce = deps({ reads: reads.reads })
    const cache = createRouterAdoptionCache()

    await scanAndAdoptRouterSessions(depsOnce, 'dsh-router', cache)
    const firstRound = reads.reads.length
    expect(firstRound).toBeGreaterThan(0)

    // 第二轮：判定缓存生效，不该再读一遍。
    const before = reads.reads.length
    await scanAndAdoptRouterSessions(depsOnce, 'dsh-router', cache)
    expect(reads.reads.length, '第二轮又去读了一遍会话日志').toBe(before)
  })

  it('新会话仍会被判定（缓存不是一劳永逸）', async () => {
    const reads = tracker()
    const mutable = { ids: ['a'] }
    const depsLive: RouterAdoptionDeps = {
      // 工作区清单每轮重取——新会话是后来才出现的。
      get workspaces() {
        return [{ id: 'ws1', sessionIds: mutable.ids }]
      },
      readSession: async (sessionId: string): Promise<Observation | undefined> => {
        reads.reads.push(sessionId)
        return { header: { agentPreset: 'dsh-router' } }
      },
      known: () => true,
      register: async () => {},
      deliver: async () => {},
    }

    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(depsLive, 'dsh-router', cache)
    expect(reads.reads).toEqual(['a'])

    // 新出现一个会话，下一轮要读它。
    mutable.ids = ['a', 'new-one']
    await scanAndAdoptRouterSessions(depsLive, 'dsh-router', cache)
    expect(reads.reads).toEqual(['a', 'new-one'])
  })

  it('读失败的会话进冷却，下一轮不立刻重试', async () => {
    const reads = tracker()
    const depsFail = deps({ reads: reads.reads, failing: ['a'] })
    const cache = createRouterAdoptionCache()

    await scanAndAdoptRouterSessions(depsFail, 'dsh-router', cache)
    expect(reads.reads).toContain('a')

    const before = reads.reads.length
    await scanAndAdoptRouterSessions(depsFail, 'dsh-router', cache)
    expect(reads.reads.length, '失败的会话被立刻重试了').toBe(before)
  })

  it('每轮有新判定的预算上限（不一次扫完整语料）', async () => {
    const reads = tracker()
    const ids = Array.from({ length: 50 }, (_, index) => `s${index}`)
    const depsBudget: RouterAdoptionDeps = {
      workspaces: [{ id: 'ws1', sessionIds: ids }],
      readSession: async (sessionId: string): Promise<Observation | undefined> => {
        reads.reads.push(sessionId)
        return { header: { agentPreset: 'other' } }
      },
      known: () => true,
      register: async () => {},
      deliver: async () => {},
    }

    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(depsBudget, 'dsh-router', cache, { budgetPerRound: 10 })
    expect(reads.reads.length, '一轮读了全部会话').toBeLessThanOrEqual(10)

    // 后续轮次继续推进，不是卡住不动。
    const afterFirst = reads.reads.length
    await scanAndAdoptRouterSessions(depsBudget, 'dsh-router', cache, { budgetPerRound: 10 })
    expect(reads.reads.length).toBeGreaterThan(afterFirst)
  })

  it('并发的扫描并成一次（单飞）', async () => {
    const reads = tracker()
    const depsConcurrent = deps({ reads: reads.reads })
    const cache = createRouterAdoptionCache()

    await Promise.all([
      scanAndAdoptRouterSessions(depsConcurrent, 'dsh-router', cache),
      scanAndAdoptRouterSessions(depsConcurrent, 'dsh-router', cache),
    ])
    // 两轮并发：第一轮读三个，第二轮并入同一轮，不再读一遍。
    expect(reads.reads.length).toBe(3)
  })

  it('判定逻辑本身没变：header 直判 + 事件兜底', () => {
    expect(isRouterPresetSession({ header: { agentPreset: 'dsh-router' } }, 'dsh-router')).toBe(true)
    expect(isRouterPresetSession({ events: [{ type: 'session', data: { agentPreset: 'dsh-router' } }] }, 'dsh-router')).toBe(true)
    expect(isRouterPresetSession({ events: [{ type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } }] }, 'dsh-router')).toBe(true)
    expect(isRouterPresetSession({ header: { agentPreset: 'other' } }, 'dsh-router')).toBe(false)
    expect(isRouterPresetSession(undefined, 'dsh-router')).toBe(false)
  })
})

describe('身份卡投递的记账', () => {
  it('稳态下不重复投递（每轮不再发一遍请求）', async () => {
    const reads = tracker()
    const deliveries: string[] = []
    const depsDeliver: RouterAdoptionDeps = {
      workspaces: [{ id: 'ws1', sessionIds: ['a'] }],
      readSession: async (sessionId: string): Promise<Observation | undefined> => {
        reads.reads.push(sessionId)
        return { header: { agentPreset: 'dsh-router' } }
      },
      known: () => true,
      register: async () => {},
      deliver: async (sessionId: string) => { deliveries.push(sessionId) },
    }
    const cache = createRouterAdoptionCache()

    await scanAndAdoptRouterSessions(depsDeliver, 'dsh-router', cache)
    expect(deliveries).toEqual(['a'])

    await scanAndAdoptRouterSessions(depsDeliver, 'dsh-router', cache)
    expect(deliveries, '第二轮又投了一遍身份卡').toEqual(['a'])
  })
})
