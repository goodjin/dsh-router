/**
 * 收编扫描只消费已验证的受限会话候选索引。
 *
 * v1.4 的收编语义：每个独立 Router 会话都要被登记并幂等补发身份卡；单个
 * unknown/损坏/过大/旧格式会话只跳过自身，绝不阻断同工作区已确认邻居。
 * 判定与定点磁盘核验全部走 SessionHeaderIndex 面（verdictOf/verifyDiskFacts），
 * deps 上没有也不需要整日志 readSession 通道；异步副作用（register/deliver）
 * 前后都有 stale 护栏。这里用合成索引替身钉住消费边界，不扫真实用户语料；
 * 索引自身的行为由 session-index.spec / cold-scan.spec / header-io.spec 覆盖。
 */

import { describe, expect, it } from 'vitest'
import type { SessionHeaderIndex, SessionVerdict, VerdictLookup } from '../src/host/session/session-index.ts'
import type { RouterAdoptionDeps } from '../src/host/bridge/router-adoption.ts'
import { createRouterAdoptionCache, scanAndAdoptRouterSessions } from '../src/host/bridge/router-adoption.ts'

/** 可变判定的索引替身：记录定点核验调用；verdicts 可在异步间隙翻面。 */
function fakeIndex(verdicts: Record<string, SessionVerdict>, options: { onVerify?: (sessionId: string) => void; rejectVerify?: (sessionId: string) => boolean } = {}) {
  const verifyCalls: string[][] = []
  const index = {
    verdictOf(sessionId: string): VerdictLookup {
      const verdict = verdicts[sessionId]
      if (verdict === undefined) return { status: 'pending' }
      return { status: 'classified', verdict }
    },
    async verifyDiskFacts(sessionIds: readonly string[]): Promise<Map<string, { ok: boolean }>> {
      const names = [...sessionIds]
      verifyCalls.push(names)
      for (const name of names) options.onVerify?.(name)
      return new Map(names.map((sessionId) => [sessionId, { ok: !options.rejectVerify?.(sessionId) }]))
    },
  }
  return { index: index as unknown as SessionHeaderIndex, verifyCalls, verdicts }
}

/** 记录登记/投递的依赖面；workspaces 用 getter 保持可变（模拟异步间隙离开）。 */
function makeDeps(options: {
  index: SessionHeaderIndex
  /** 索引增量候选（收编每轮消费；缺省走全清单内存判定回退）。 */
  delta?: () => readonly string[]
  sessionIds?: string[]
  known?: readonly string[]
  failRegisterFor?: () => readonly string[]
}) {
  const state = {
    sessionIds: options.sessionIds ?? [],
    known: [...(options.known ?? [])],
    registered: [] as string[],
    deliveries: [] as string[],
  }
  const deps: RouterAdoptionDeps = {
    get workspaces() {
      return [{ id: 'ws-1', sessionIds: [...state.sessionIds] }]
    },
    index: options.index,
    known: (sessionId) => state.known.includes(sessionId),
    register: async (sessionId) => {
      const failing = options.failRegisterFor?.() ?? []
      if (failing.includes(sessionId)) throw new Error(`register failed: ${sessionId}`)
      state.registered.push(sessionId)
      state.known.push(sessionId)
    },
    deliver: async (sessionId) => { state.deliveries.push(sessionId) },
  }
  if (options.delta !== undefined) deps.changedCandidates = options.delta
  return { deps, state }
}

describe('收编扫描：索引是唯一判定源', () => {
  it('定点核验只点候选名（一次一个）；多个独立 Router 都登记并投递', async () => {
    const { index, verifyCalls } = fakeIndex({
      'router-a': 'router',
      'router-b': 'router',
      unknown: 'unknown',
      seeded: 'nonrouter',
      large: 'unknown',
    })
    const { deps, state } = makeDeps({
      index,
      sessionIds: ['router-a', 'router-b', 'unknown', 'seeded', 'large'],
      delta: () => ['router-a', 'router-b', 'unknown', 'seeded', 'large'],
    })
    await scanAndAdoptRouterSessions(deps, 'dsh-router')
    // 只对确认的 router 做定点核验，且逐个点名（不整库、不整工作区枚举核验）。
    expect(verifyCalls).toEqual([['router-a'], ['router-b']])
    // 多 Router 语义：两个都登记（不选正主、不归档、不跳转）。
    expect(state.registered).toEqual(['router-a', 'router-b'])
    expect(state.deliveries).toEqual(['router-a', 'router-b'])
  })

  it('unknown/large/seeded 只跳过自身：不在候选里挡住邻居的登记与投递', async () => {
    const { index } = fakeIndex({ 'router-b': 'router', broken: 'unknown' })
    const { deps, state } = makeDeps({
      index,
      sessionIds: ['broken', 'router-b'],
      delta: () => ['broken', 'router-b'],
    })
    await scanAndAdoptRouterSessions(deps, 'dsh-router')
    expect(state.registered).toEqual(['router-b'])
    expect(state.deliveries).toEqual(['router-b'])
  })

  it('稳定轮次零副作用：索引无新候选时不核验、不登记、不投递', async () => {
    const { index, verifyCalls } = fakeIndex({ 'router-a': 'router' })
    const queue: string[][] = [['router-a']]
    const { deps, state } = makeDeps({
      index,
      sessionIds: ['router-a'],
      delta: () => queue.shift() ?? [],
    })
    await scanAndAdoptRouterSessions(deps, 'dsh-router')
    expect(verifyCalls).toEqual([['router-a']])
    await scanAndAdoptRouterSessions(deps, 'dsh-router')
    await scanAndAdoptRouterSessions(deps, 'dsh-router')
    expect(verifyCalls, '稳定轮次又去核验了磁盘事实').toEqual([['router-a']])
    expect(state.registered).toEqual(['router-a'])
    expect(state.deliveries, '稳态重复投递身份卡').toEqual(['router-a'])
  })

  it('register 失败：候选下轮重试；已投递成功的身份卡不重发', async () => {
    const { index } = fakeIndex({ 'router-a': 'router', 'router-b': 'router' })
    let failA = true
    const { deps, state } = makeDeps({
      index,
      sessionIds: ['router-a', 'router-b'],
      delta: () => ['router-a', 'router-b'],
      failRegisterFor: () => (failA ? ['router-a'] : []),
    })
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered).toEqual(['router-b'])
    failA = false
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered).toEqual(['router-b', 'router-a'])
    expect(state.deliveries, 'router-b 不该被重发').toEqual(['router-b', 'router-a'])
  })

  it('异步核验间隙判定翻面（router→unknown）：不登记不投递', async () => {
    const verdicts: Record<string, SessionVerdict> = { 'router-a': 'router' }
    const { index } = fakeIndex(verdicts, {
      // 核验等待期间索引判据变了：候选不再是 router。
      onVerify: () => { verdicts['router-a'] = 'unknown' },
    })
    const { deps, state } = makeDeps({ index, sessionIds: ['router-a'], delta: () => ['router-a'] })
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered, 'stale 计划不该登记').toEqual([])
    expect(state.deliveries, 'stale 计划不该投递').toEqual([])
  })

  it('register 等待间隙离开工作区：不按 stale 计划投递', async () => {
    const { index } = fakeIndex({ 'router-a': 'router' })
    const { deps, state } = makeDeps({ index, sessionIds: ['router-a'], delta: () => ['router-a'] })
    const originalRegister = deps.register
    deps.register = async (sessionId, workspaceId) => {
      // register 等待期间会话被移出工作区。
      state.sessionIds = []
      await originalRegister(sessionId, workspaceId)
    }
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered).toEqual(['router-a'])
    expect(state.deliveries, '离开工作区后不该继续投递').toEqual([])
  })

  it('verifyDiskFacts 拒绝（untrusted/changed/missing）：跳过自身、下轮再试、不阻断邻居', async () => {
    const rejected = new Set<string>(['router-a'])
    const { index, verifyCalls } = fakeIndex({ 'router-a': 'router', 'router-b': 'router' }, {
      rejectVerify: (sessionId) => rejected.has(sessionId),
    })
    const queue: string[][] = [['router-a', 'router-b']]
    const { deps, state } = makeDeps({
      index,
      sessionIds: ['router-a', 'router-b'],
      delta: () => queue.shift() ?? [],
    })
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered, '被拒候选不该挡住邻居').toEqual(['router-b'])
    rejected.clear()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(verifyCalls).toEqual([['router-a'], ['router-b'], ['router-a']])
    expect(state.registered).toEqual(['router-b', 'router-a'])
    expect(state.deliveries).toEqual(['router-b', 'router-a'])
  })
})
