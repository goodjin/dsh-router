/**
 * 收编扫描：索引是唯一判定源（v1.4 review I1–I6 的行为钉子）。
 *
 * v1.4 的收编语义：每个独立 Router 会话都要被登记并幂等补发身份卡；单个
 * unknown/损坏/过大/旧格式会话只跳过自身，绝不阻断同工作区已确认邻居。
 * 判定、定点磁盘核验、定点成员/归档核验、资格授予全部走索引面；deps 上
 * 没有也不需要整日志 readSession 通道。这里用合成索引替身钉住消费边界，
 * 不扫真实用户语料；索引自身的行为由 session-index.spec / cold-scan.spec /
 * header-io.spec 覆盖。
 *
 * 记账模型（review I1）：消费方**成功才 ack** 资格授予；未 ack 的候选留在
 * 延期队列里按退避重试——不会因为"看一眼"就被永久吞掉。
 */

import { describe, expect, it } from 'vitest'
import type { RouterAdoptionDeps } from '../src/host/bridge/router-adoption.ts'
import { createRouterAdoptionCache, scanAndAdoptRouterSessions } from '../src/host/bridge/router-adoption.ts'
import { createFakeIndex, type FakeIndex } from './helpers/adoption-index.ts'

/** 记录副作用的依赖面；时钟可注入（退避断言不靠等待）。 */
function makeDeps(fake: FakeIndex, options: {
  known?: readonly string[]
  failRegisterFor?: () => readonly string[]
  failDeliverFor?: () => readonly string[]
} = {}) {
  const state = {
    known: [...(options.known ?? [])],
    registered: [] as string[],
    deliveries: [] as string[],
    warns: [] as string[],
  }
  const deps: RouterAdoptionDeps = {
    index: fake.index,
    known: (sessionId) => state.known.includes(sessionId),
    register: async (sessionId, workspaceId) => {
      const failing = options.failRegisterFor?.() ?? []
      if (failing.includes(sessionId)) throw new Error(`register failed: ${sessionId}`)
      state.registered.push(`${sessionId}@${workspaceId}`)
      state.known.push(sessionId)
    },
    deliver: async (sessionId) => {
      const failing = options.failDeliverFor?.() ?? []
      if (failing.includes(sessionId)) throw new Error(`deliver failed: ${sessionId}`)
      state.deliveries.push(sessionId)
    },
    logger: { warn: (message: string) => { state.warns.push(message) } },
  }
  return { deps, state }
}

/** 可控时钟（退避断言用，不靠真实等待）。 */
function clock(start = 1_000) {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

describe('收编扫描：索引是唯一判定源', () => {
  it('定点核验只点候选名（一次一个）；多个独立 Router 都登记并投递', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router', 'router-b': 'router', unknown: 'unknown', seeded: 'nonrouter' },
      members: { 'router-a': 'ws-1', 'router-b': 'ws-1', unknown: 'ws-1', seeded: 'ws-1' },
      grants: ['router-a', 'router-b', 'unknown', 'seeded'],
    })
    const { deps, state } = makeDeps(fake)
    await scanAndAdoptRouterSessions(deps, 'dsh-router')
    // 只对确认的 router 做定点核验，且逐个点名（不整库、不整工作区枚举核验）。
    expect(fake.verifyCalls.every((call) => call.length === 1)).toBe(true)
    expect(new Set(fake.verifyCalls.flat())).toEqual(new Set(['router-a', 'router-b']))
    // 多 Router 语义：两个都登记（不选正主、不归档、不跳转）。
    expect(state.registered).toEqual(['router-a@ws-1', 'router-b@ws-1'])
    expect(state.deliveries).toEqual(['router-a', 'router-b'])
  })

  it('unknown/large/seeded 只跳过自身：不在候选里挡住邻居的登记与投递', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-b': 'router', broken: 'unknown' },
      members: { broken: 'ws-1', 'router-b': 'ws-1' },
      grants: ['broken', 'router-b'],
    })
    const { deps, state } = makeDeps(fake)
    await scanAndAdoptRouterSessions(deps, 'dsh-router')
    expect(state.registered).toEqual(['router-b@ws-1'])
    expect(state.deliveries).toEqual(['router-b'])
  })

  it('稳定轮次零副作用：没有待消费授予时不核验、不登记、不投递', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: ['router-a'],
    })
    const { deps, state } = makeDeps(fake)
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    const firstRoundVerifies = fake.verifyCalls.length
    expect(firstRoundVerifies).toBeGreaterThan(0)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(fake.verifyCalls.length, '稳定轮次又去核验了磁盘事实').toBe(firstRoundVerifies)
    expect(state.registered).toEqual(['router-a@ws-1'])
    expect(state.deliveries, '稳态重复投递身份卡').toEqual(['router-a'])
    expect(cache.deferred.size, '成功候选不该留在延期队列').toBe(0)
  })
})

describe('review I1：资格授予可靠记账（不提前消费、不永久漏）', () => {
  it('未核验（pending）的候选不在待消费面；核验通过后拿到新授予并被收编', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: [],
    })
    const { deps, state } = makeDeps(fake)
    const cache = createRouterAdoptionCache()
    // 判定还没成立（pending）→ 消费方看不到任何候选。
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered).toEqual([])

    // 资格成立后（索引发新一代授予）→ 收编。
    fake.grants.set('router-a', 1)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered).toEqual(['router-a@ws-1'])
    expect(state.deliveries).toEqual(['router-a'])
  })

  it('未加入工作区的候选被延期（不是丢弃）；加入后能收编', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: {},
      grants: ['router-a'],
    })
    const { deps, state } = makeDeps(fake)
    const cache = createRouterAdoptionCache()
    const time = clock()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.registered, '还没进工作区不该登记').toEqual([])
    expect(cache.deferred.size, '候选必须留在延期队列里，不能丢').toBe(1)
    expect(cache.deferred.get('router-a')?.reason).toBe('not-member')

    // 之后被挂进工作区：退避到期后重新收编。
    fake.members.set('router-a', 'ws-1')
    time.advance(10_000)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.registered).toEqual(['router-a@ws-1'])
    expect(cache.deferred.size).toBe(0)
  })

  it('两个轮询之间 router→other→router 的翻面：新一代授予仍会被收编', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: [],
    })
    const { deps, state } = makeDeps(fake)
    const cache = createRouterAdoptionCache()
    // 翻到别的组合（资格撤下），再翻回来（新一代授予）。
    fake.verdicts.set('router-a', 'nonrouter')
    fake.revokeGrant('router-a')
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered).toEqual([])

    fake.verdicts.set('router-a', 'router')
    fake.regrant('router-a')
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered, '翻回来的 router 是新事实，不该被旧基线吞掉').toEqual(['router-a@ws-1'])
  })

  it('资格消失后移出延期队列；重新成立时按新一代重新收编', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: ['router-a'],
    })
    const { deps, state } = makeDeps(fake)
    const cache = createRouterAdoptionCache()
    const time = clock()
    fake.diskOk.set('router-a', false)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(cache.deferred.size).toBe(1)

    // 资格不再成立 → 移出延期队列（不是永久丢弃：资格重新成立会有新授予）。
    fake.verdicts.set('router-a', 'nonrouter')
    fake.revokeGrant('router-a')
    time.advance(10_000)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(cache.deferred.size).toBe(0)

    // 重新成立 → 新一代授予 → 收编。
    fake.verdicts.set('router-a', 'router')
    fake.diskOk.set('router-a', true)
    fake.regrant('router-a')
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.registered).toEqual(['router-a@ws-1'])
  })
})

describe('review I2：投递失败必须传播（只有真成功才记账）', () => {
  it('投递失败：不算已投递、不 ack，退避后重试；成功才补发', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: ['router-a'],
    })
    let failing = true
    const { deps, state } = makeDeps(fake, { failDeliverFor: () => (failing ? ['router-a'] : []) })
    const cache = createRouterAdoptionCache()
    const time = clock()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.deliveries, '投递失败不能记成已投递').toEqual([])
    expect(cache.delivered.has('router-a')).toBe(false)
    expect(fake.grants.has('router-a'), '投递失败不能 ack 掉资格').toBe(true)
    expect(cache.deferred.size).toBe(1)

    failing = false
    time.advance(10_000)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.deliveries).toEqual(['router-a'])
    expect(cache.delivered.has('router-a')).toBe(true)
    expect(fake.grants.has('router-a'), '成功后资格才被消费').toBe(false)
  })
})

describe('review I3：失败可恢复（不永久放弃）且公平', () => {
  it('连续失败不永久放弃：留在延期队列、退避有上限；恢复后收编成功', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: ['router-a'],
    })
    let failing = true
    const { deps, state } = makeDeps(fake, { failRegisterFor: () => (failing ? ['router-a'] : []) })
    const cache = createRouterAdoptionCache()
    const time = clock()
    for (let round = 0; round < 12; round += 1) {
      await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, {
        now: time.now,
        baseBackoffMs: 1_000,
        maxBackoffMs: 8_000,
      })
      time.advance(8_000)
    }
    expect(state.registered, '失败候选不该被收编').toEqual([])
    expect(cache.deferred.size, '达上限后不该被永久丢弃').toBe(1)
    // 旧实现连续 5 次失败就永久出队；现在失败多少次都还在队列里。
    expect(cache.deferred.get('router-a')?.failures).toBeGreaterThan(5)
    // 退避封顶：下次可试时刻不超过 now + 上限。
    const record = cache.deferred.get('router-a')!
    expect(record.nextAttemptAt - time.now()).toBeLessThanOrEqual(8_000)

    // 恢复后收编成功（同一队列里继续，不靠外部重新发放）。
    failing = false
    time.advance(8_000)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.registered).toEqual(['router-a@ws-1'])
    expect(cache.deferred.size).toBe(0)
    expect(fake.grants.has('router-a'), '成功后资格才被消费').toBe(false)
  })

  it('失败的头部不反复占用预算：后面的候选照常推进', async () => {
    const fake = createFakeIndex({
      verdicts: { bad: 'router', good1: 'router', good2: 'router' },
      members: { bad: 'ws-1', good1: 'ws-1', good2: 'ws-1' },
      grants: ['bad', 'good1', 'good2'],
    })
    const { deps, state } = makeDeps(fake, { failRegisterFor: () => ['bad'] })
    const cache = createRouterAdoptionCache()
    const time = clock()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 1 })
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 1 })
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now, budgetPerRound: 1 })
    expect(state.registered, '一个候选持续失败不该挡住后面的候选').toEqual(['good1@ws-1', 'good2@ws-1'])
  })

  it('注册失败：候选退避后重试；已投递成功的身份卡不重发', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router', 'router-b': 'router' },
      members: { 'router-a': 'ws-1', 'router-b': 'ws-1' },
      grants: ['router-a', 'router-b'],
    })
    let failA = true
    const { deps, state } = makeDeps(fake, { failRegisterFor: () => (failA ? ['router-a'] : []) })
    const cache = createRouterAdoptionCache()
    const time = clock()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.registered).toEqual(['router-b@ws-1'])
    failA = false
    time.advance(10_000)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.registered).toEqual(['router-b@ws-1', 'router-a@ws-1'])
    expect(state.deliveries, 'router-b 不该被重发').toEqual(['router-b', 'router-a'])
  })
})

describe('review I4：每个副作用起点都要 workspace 精确 + 未归档', () => {
  it('已归档的候选：不登记不投递（延期等状态变化）', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      archived: ['router-a'],
      grants: ['router-a'],
    })
    const { deps, state } = makeDeps(fake)
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered, '归档会话不该登记').toEqual([])
    expect(state.deliveries).toEqual([])
    expect(cache.deferred.get('router-a')?.reason).toBe('archived')
  })

  it('跨 workspace 移动：重新计算绑定（不沿用旧映射）', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-old' },
      grants: ['router-a'],
    })
    // 核验等待期间会话被移到另一个工作区。
    fake.onVerify = () => { fake.members.set('router-a', 'ws-new') }
    const { deps, state } = makeDeps(fake)
    await scanAndAdoptRouterSessions(deps, 'dsh-router')
    expect(state.registered, '必须按新工作区登记').toEqual(['router-a@ws-new'])
  })

  it('等待期间被移出工作区：不按 stale 计划投递', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: ['router-a'],
    })
    const { deps, state } = makeDeps(fake)
    const originalRegister = deps.register
    deps.register = async (sessionId, workspaceId) => {
      // register 等待期间会话被移出工作区。
      fake.members.delete(sessionId)
      await originalRegister(sessionId, workspaceId)
    }
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.registered).toEqual(['router-a@ws-1'])
    expect(state.deliveries, '离开工作区后不该继续投递').toEqual([])
  })
})

describe('review I5：register 等待之后重新核验磁盘事实', () => {
  it('register 等待期间磁盘事实变化：不投递（延期），下一轮复核后才投', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: ['router-a'],
    })
    const { deps, state } = makeDeps(fake)
    const originalRegister = deps.register
    deps.register = async (sessionId, workspaceId) => {
      // 登记等待期间冷日志被改写（指纹不再新鲜）。
      fake.diskOk.set(sessionId, false)
      await originalRegister(sessionId, workspaceId)
    }
    const cache = createRouterAdoptionCache()
    const time = clock()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.deliveries, '旧授权不该继续投递').toEqual([])
    expect(cache.deferred.size).toBe(1)

    fake.diskOk.set('router-a', true)
    time.advance(10_000)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { now: time.now })
    expect(state.deliveries).toEqual(['router-a'])
  })
})

describe('review I6：生命周期屏障（live 权威撤销后不按旧计划投递）', () => {
  it('register 等待期间 live 权威被撤销（代际变化）：不投递', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: ['router-a'],
    })
    const { deps, state } = makeDeps(fake)
    const originalRegister = deps.register
    deps.register = async (sessionId, workspaceId) => {
      // 会话离开 live store：生命周期代际推进。
      fake.bumpToken(sessionId)
      await originalRegister(sessionId, workspaceId)
    }
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.deliveries, '旧生命周期不该继续投递').toEqual([])
    expect(cache.deferred.size).toBe(1)
  })

  it('register 等待期间判定翻面：不投递也不记账', async () => {
    const fake = createFakeIndex({
      verdicts: { 'router-a': 'router' },
      members: { 'router-a': 'ws-1' },
      grants: ['router-a'],
    })
    const { deps, state } = makeDeps(fake)
    const originalRegister = deps.register
    deps.register = async (sessionId, workspaceId) => {
      fake.verdicts.set(sessionId, 'nonrouter')
      fake.revokeGrant(sessionId)
      await originalRegister(sessionId, workspaceId)
    }
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(state.deliveries, '判定翻面后不该投递').toEqual([])
    expect(cache.deferred.size).toBe(0)
    expect(cache.counters.staleSkipped).toBe(1)
  })
})
