/**
 * Router 入口去重（计划 v1.1 Task C4）：/router/state 构建时扫描各 workspace
 * 的会话，识别「用了 dsh-router 预设」的会话（真实取证：v4 日志 session 头带
 * `agentPreset`；旧格式走 `agent-preset/selected` 事件；`permission/preset` 是
 * 权限预设事件、每个会话都有，不作为识别依据）。每 workspace 最早的 router
 * 会话为正主：正主 pin 到顶部，其余较新者归档 + 写 redirect 指令；归档失败
 * warn 后下轮重试；判定按会话缓存、只读一次。
 *
 * 全部用假 sessionQuery / workspaceRegistry 驱动公开 API，不碰宿主。
 */

import { describe, expect, it } from 'vitest'
import { RouterDedup, stateWithRedirect, type RouterDedupOptions } from '../src/host/bridge/dedup.ts'
import type { RouterDedupDeps } from '../src/host/bridge/dedup.ts'
import type { RouterRedirect } from '../src/shared/view-contract.ts'
import type { WorkspaceInfo } from '../src/host/bridge/sessions.ts'
import type { RouterState } from '../src/shared/view-contract.ts'

/* ────────────────────────── 假件 ────────────────────────── */

/** 会话日志快照的最小面（readSession 的返回形状）。 */
function snapshot(preset: string | undefined, createdAt: number | undefined, events: { type: string; data?: Record<string, unknown> }[] = []) {
  return {
    session: {
      ...(preset !== undefined ? { agentPreset: preset } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    },
    events,
  }
}

interface EnvOptions {
  workspaces: WorkspaceInfo[]
  /** sessionId → readSession 的返回（缺席 = 会话不存在 → undefined）。 */
  snapshots: Map<string, ReturnType<typeof snapshot>>
  /** 首次读这些会话时抛错（下轮恢复）。 */
  failFirstReadFor?: string[]
  /** 透传给 RouterDedup 的成本护栏选项（预算/冷却/持久化）。 */
  dedupOptions?: RouterDedupOptions
  /** 首次归档这些会话时抛错（下轮恢复）。 */
  failFirstArchiveFor?: string[]
  /** 首次 pin 时抛错（下轮恢复）。 */
  failFirstPin?: boolean
  /** 初始已在归档集的会话（模拟重启前已处置过的重复会话）。 */
  archived?: string[]
  /** 用旧假设的「函数形状」暴露归档集（默认 getter 属性形状 = 宿主真实形状）。 */
  archivedAsFunction?: boolean
}

/** 组一套带记录的假环境：读写计数与告警全部可断言。 */
function createEnv(options: EnvOptions) {
  const readCalls: string[] = []
  const pinCalls: string[] = []
  const archiveCalls: string[] = []
  const warns: string[] = []
  const archived = new Set<string>(options.archived ?? [])
  const failRead = new Set<string>(options.failFirstReadFor ?? [])
  const failArchive = new Set<string>(options.failFirstArchiveFor ?? [])
  let pinFailed = options.failFirstPin === true

  const deps: RouterDedupDeps = {
    workspaces: { list: () => options.workspaces },
    sessionQuery: {
      readSession: async (sessionId: string) => {
        readCalls.push(sessionId)
        if (failRead.has(sessionId)) {
          failRead.delete(sessionId)
          throw new Error(`读会话失败: ${sessionId}`)
        }
        return options.snapshots.get(sessionId)
      },
    },
    registry: {
      pinSession: async (sessionId: string) => {
        pinCalls.push(sessionId)
        if (pinFailed) {
          pinFailed = false
          throw new Error('pin 失败一次')
        }
        return undefined
      },
      archiveSession: async (sessionId: string) => {
        archiveCalls.push(sessionId)
        if (failArchive.has(sessionId)) {
          failArchive.delete(sessionId)
          throw new Error('归档失败一次')
        }
        archived.add(sessionId)
        return undefined
      },
      /** 宿主真实形状（getter 属性返回数组）；置 true 时用旧假设的函数形状。 */
      archivedSessionIds: options.archivedAsFunction === true ? () => [...archived] : [...archived],
    },
    routerPreset: 'dsh-router',
    logger: { warn: (message: string) => { warns.push(message) } },
  }
  return { dedup: new RouterDedup(deps, options.dedupOptions), readCalls, pinCalls, archiveCalls, warns }
}

const WS = (id: string, sessionIds: string[]): WorkspaceInfo => ({ id, sessionIds })

function baseState(): RouterState {
  return { routerSessions: [], tasks: [], questions: [], tabs: [], templates: [] }
}

/* ────────────────────────── 正主与归档 ────────────────────────── */

describe('RouterDedup.resolve：正主判定与归档', () => {
  it('最早 router 会话为正主并 pin；较新者归档并写 redirect', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-old', 's-new', 's-plain'])],
      snapshots: new Map([
        ['s-old', snapshot('dsh-router', 100)],
        ['s-new', snapshot('dsh-router', 200)],
        ['s-plain', snapshot(undefined, 150)],
      ]),
    })
    await env.dedup.resolve()
    expect(env.pinCalls).toEqual(['s-old'])
    expect(env.archiveCalls).toEqual(['s-new'])
    expect(env.dedup.pendingRedirectFor('ws-1')).toEqual({ sessionId: 's-old', supersededSessionId: 's-new' })
    expect(env.dedup.pendingRedirectFor('ws-other')).toBeUndefined()
  })

  it('旧格式日志没有 header.agentPreset：以 agent-preset/selected 事件判定', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-old', 's-new'])],
      snapshots: new Map([
        ['s-old', snapshot('dsh-router', 100)],
        ['s-new', snapshot(undefined, 200, [{ type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } }])],
      ]),
    })
    await env.dedup.resolve()
    expect(env.archiveCalls).toEqual(['s-new'])
    expect(env.dedup.pendingRedirectFor('ws-1')).toEqual({ sessionId: 's-old', supersededSessionId: 's-new' })
  })

  it('permission/preset 是权限预设事件：不作为 router 会话识别依据', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-old', 's-plain'])],
      snapshots: new Map([
        ['s-old', snapshot('dsh-router', 100)],
        ['s-plain', snapshot(undefined, 200, [{ type: 'permission/preset', data: { preset: 'danger-full-access' } }])],
      ]),
    })
    await env.dedup.resolve()
    expect(env.pinCalls).toEqual(['s-old'])
    expect(env.archiveCalls).toEqual([])
    expect(env.dedup.pendingRedirectFor('ws-1')).toBeUndefined()
  })

  it('唯一 router 会话：只 pin，不归档、无 redirect', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-only'])],
      snapshots: new Map([['s-only', snapshot('dsh-router', 100)]]),
    })
    await env.dedup.resolve()
    expect(env.pinCalls).toEqual(['s-only'])
    expect(env.archiveCalls).toEqual([])
    expect(env.dedup.pendingRedirectFor('ws-1')).toBeUndefined()
  })

  it('多个 workspace 各自取正主，互不串扰', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['r-a', 'r-b']), WS('ws-2', ['r-c'])],
      snapshots: new Map([
        ['r-a', snapshot('dsh-router', 1)],
        ['r-b', snapshot('dsh-router', 2)],
        ['r-c', snapshot('dsh-router', 10)],
      ]),
    })
    await env.dedup.resolve()
    expect(env.pinCalls.sort()).toEqual(['r-a', 'r-c'])
    expect(env.archiveCalls).toEqual(['r-b'])
    expect(env.dedup.pendingRedirectFor('ws-1')).toEqual({ sessionId: 'r-a', supersededSessionId: 'r-b' })
    expect(env.dedup.pendingRedirectFor('ws-2')).toBeUndefined()
  })

  it('归档集形状兼容：宿主 getter 属性（默认）与旧函数假设行为一致（重启不重复跳）', async () => {
    // 默认（属性形状，宿主真实形状 dsh-workspace lib/index.js:506-507）
    const asProperty = createEnv({
      archived: ['r-b'],
      workspaces: [WS('ws-1', ['r-a', 'r-b'])],
      snapshots: new Map([
        ['r-a', snapshot('dsh-router', 1)],
        ['r-b', snapshot('dsh-router', 2)],
      ]),
    })
    await asProperty.dedup.resolve()
    expect(asProperty.pinCalls).toEqual(['r-a'])
    expect(asProperty.archiveCalls).toEqual([])
    expect(asProperty.dedup.pendingRedirectFor('ws-1')).toBeUndefined()

    // 旧函数形状（防御性兼容路径）
    const asFunction = createEnv({
      archived: ['r-b'],
      archivedAsFunction: true,
      workspaces: [WS('ws-1', ['r-a', 'r-b'])],
      snapshots: new Map([
        ['r-a', snapshot('dsh-router', 1)],
        ['r-b', snapshot('dsh-router', 2)],
      ]),
    })
    await asFunction.dedup.resolve()
    expect(asFunction.pinCalls).toEqual(['r-a'])
    expect(asFunction.archiveCalls).toEqual([])
    expect(asFunction.dedup.pendingRedirectFor('ws-1')).toBeUndefined()
  })
})

describe('RouterDedup.resolve：正主迁移（更早会话后到）', () => {
  it('后到的更早 router 会话接管正主；原正主按规则归档并改写 redirect', async () => {
    // 简报规则是纯规则：最早者恒为正主，其余较新者一律归档。进程内几乎不会
    // 出现「更早会话后到」（重启 bootstrap 才会），一旦出现按规则迁移正主。
    const snapshots = new Map<string, ReturnType<typeof snapshot>>([
      ['s-new', snapshot('dsh-router', 200)],
    ])
    let members = ['s-new']
    const readCalls: string[] = []
    const pinCalls: string[] = []
    const archiveCalls: string[] = []
    const dedup = new RouterDedup({
      workspaces: { list: () => [{ id: 'ws-1', sessionIds: members }] },
      sessionQuery: {
        readSession: async (sessionId: string) => {
          readCalls.push(sessionId)
          return snapshots.get(sessionId)
        },
      },
      registry: {
        pinSession: async (sessionId: string) => { pinCalls.push(sessionId) },
        archiveSession: async (sessionId: string) => { archiveCalls.push(sessionId) },
      },
      routerPreset: 'dsh-router',
    })
    await dedup.resolve()
    expect(pinCalls).toEqual(['s-new'])
    // 第二轮：更早的 s-old 出现在 workspace 成员里 → 接管正主。
    snapshots.set('s-old', snapshot('dsh-router', 100))
    members = ['s-new', 's-old']
    await dedup.resolve()
    expect(pinCalls).toEqual(['s-new', 's-old'])
    expect(archiveCalls).toEqual(['s-new'])
    expect(dedup.pendingRedirectFor('ws-1')).toEqual({ sessionId: 's-old', supersededSessionId: 's-new' })
  })
})

/* ────────────────────────── 失败与重试 ────────────────────────── */

describe('RouterDedup.resolve：归档失败重试（Review Focus 2）', () => {
  it('归档抛错：warn、不写 redirect、正主事实保持；下轮成功后补写', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-old', 's-new'])],
      snapshots: new Map([
        ['s-old', snapshot('dsh-router', 100)],
        ['s-new', snapshot('dsh-router', 200)],
      ]),
      failFirstArchiveFor: ['s-new'],
    })
    await env.dedup.resolve()
    expect(env.warns.join(' ')).toContain('s-new')
    expect(env.dedup.pendingRedirectFor('ws-1')).toBeUndefined()
    expect(env.pinCalls).toEqual(['s-old']) // 正主事实不丢
    await env.dedup.resolve() // 下轮重试
    expect(env.dedup.pendingRedirectFor('ws-1')).toEqual({ sessionId: 's-old', supersededSessionId: 's-new' })
    expect(env.archiveCalls).toEqual(['s-new', 's-new'])
  })

  it('pin 抛错：warn、下轮重试', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-old', 's-new'])],
      snapshots: new Map([
        ['s-old', snapshot('dsh-router', 100)],
        ['s-new', snapshot('dsh-router', 200)],
      ]),
      failFirstPin: true,
    })
    await env.dedup.resolve()
    expect(env.warns.join(' ')).toContain('pin')
    expect(env.pinCalls).toEqual(['s-old'])
    await env.dedup.resolve()
    expect(env.pinCalls).toEqual(['s-old', 's-old']) // 重试成功
    expect(env.dedup.pendingRedirectFor('ws-1')).toEqual({ sessionId: 's-old', supersededSessionId: 's-new' })
  })

  it('readSession 抛错：进失败冷却不每轮重试；failureRetryMs=0 时下轮立即可重试', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-old', 's-new'])],
      snapshots: new Map([
        ['s-old', snapshot('dsh-router', 100)],
        ['s-new', snapshot('dsh-router', 200)],
      ]),
      failFirstReadFor: ['s-new'],
      dedupOptions: { failureRetryMs: 0 },
    })
    await env.dedup.resolve()
    expect(env.archiveCalls).toEqual([]) // s-new 未判定，不归档
    await env.dedup.resolve()
    expect(env.archiveCalls).toEqual(['s-new'])
    expect(env.dedup.pendingRedirectFor('ws-1')).toEqual({ sessionId: 's-old', supersededSessionId: 's-new' })
  })
})

/* ────────────────────────── 缓存与 ack ────────────────────────── */

describe('RouterDedup：判定缓存与 redirect 生命周期', () => {
  it('两轮扫描每个会话只读一次（判定缓存）', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-old', 's-new'])],
      snapshots: new Map([
        ['s-old', snapshot('dsh-router', 100)],
        ['s-new', snapshot('dsh-router', 200)],
      ]),
    })
    await env.dedup.resolve()
    await env.dedup.resolve()
    expect(env.readCalls.sort()).toEqual(['s-new', 's-old'])
  })

  it('ack 清除 redirect；后续扫描不重复发布同一指令', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-old', 's-new'])],
      snapshots: new Map([
        ['s-old', snapshot('dsh-router', 100)],
        ['s-new', snapshot('dsh-router', 200)],
      ]),
    })
    await env.dedup.resolve()
    expect(env.dedup.pendingRedirectFor('ws-1')).toBeDefined()
    env.dedup.ackRedirect('ws-1', 's-new')
    expect(env.dedup.pendingRedirectFor('ws-1')).toBeUndefined()
    await env.dedup.resolve()
    expect(env.dedup.pendingRedirectFor('ws-1')).toBeUndefined()
    expect(env.archiveCalls).toEqual(['s-new']) // 不重复归档
  })

  it('重启场景：已在归档集的 router 会话不再发 redirect、不再归档', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-old', 's-new'])],
      snapshots: new Map([
        ['s-old', snapshot('dsh-router', 100)],
        ['s-new', snapshot('dsh-router', 200)],
      ]),
      archived: ['s-new'],
    })
    await env.dedup.resolve()
    expect(env.archiveCalls).toEqual([])
    expect(env.dedup.pendingRedirectFor('ws-1')).toBeUndefined()
    expect(env.pinCalls).toEqual(['s-old'])
  })

  it('会话消失（readSession 返回 undefined）：按非 router 处理，不抛', async () => {
    const env = createEnv({
      workspaces: [WS('ws-1', ['s-gone'])],
      snapshots: new Map(),
    })
    await expect(env.dedup.resolve()).resolves.toBeUndefined()
    expect(env.pinCalls).toEqual([])
    expect(env.archiveCalls).toEqual([])
  })
})

/* ────────────────────────── state 合并 ────────────────────────── */

describe('stateWithRedirect：RouterState 合并（entry 接线用）', () => {
  it('无 redirect 时不加键（lossless：undefined 键不得出现在 JSON 里）', () => {
    const merged = stateWithRedirect(baseState(), undefined)
    expect(Object.prototype.hasOwnProperty.call(merged, 'redirect')).toBe(false)
    expect(JSON.parse(JSON.stringify(merged))).toEqual(baseState())
  })

  it('有 redirect 时原样合并，不改动其余字段', () => {
    const redirect: RouterRedirect = { sessionId: 's-old', supersededSessionId: 's-new' }
    const merged = stateWithRedirect(baseState(), redirect)
    expect(merged.redirect).toEqual(redirect)
    expect(merged.routerSessions).toEqual([])
  })
})
