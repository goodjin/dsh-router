/**
 * 真实文件系统的收编链路集成夹具：冷日志 → 受限读取器 → SessionHeaderIndex
 * → 收编扫描。
 *
 * v1.4 语义的端到端证明：两个独立 Router 会话（不同项目目录、先后落盘）都被
 * 登记并幂等补发身份卡；非 Router 邻居原样不动；**坏邻居（unknown/损坏/
 * 未来格式/seeded）不挡住两个 Router**；**冷缓存重启**（hydrate → 同一
 * 指纹对账 → 收编）走的是同一条链路；全程没有 canonical/归档/跳转/复用——
 * 收编依赖面上不存在那些通道。夹具全部用真实 tmp FS 手写会话日志与真实
 * 持久化文件，不碰真实用户语料。
 */

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { SessionHeaderIndex, type IndexFileState } from '../src/host/session/session-index.ts'
import { encodeSegment } from '../src/host/session/header-io.ts'
import { createRouterAdoptionCache, routerAdoptionDiagnostics, scanAndAdoptRouterSessions } from '../src/host/bridge/router-adoption.ts'

/* ────────────────────────── 夹具 ────────────────────────── */

let roots: string[] = []
async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'router-adoption-integration-'))
  roots.push(root)
  return root
}
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

/** 写一个 v4 plain 会话日志（头行 + 可选事件行）。 */
async function writeSession(
  root: string,
  sessionId: string,
  fields: { agentPreset?: string; projectDir?: string; isSeeded?: boolean; version?: number; raw?: string },
): Promise<void> {
  const dir = join(root, fields.projectDir ?? '--proj--', encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  if (fields.raw !== undefined) {
    await writeFile(join(dir, 'session.v4.jsonl'), fields.raw)
    return
  }
  const header = JSON.stringify({
    type: 'session',
    version: fields.version ?? 4,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    isSeeded: fields.isSeeded ?? false,
    delegationDepth: 0,
    ...(fields.agentPreset === undefined ? {} : { agentPreset: fields.agentPreset }),
  })
  const lines = [header, JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: {} })]
  await writeFile(join(dir, 'session.v4.jsonl'), `${lines.join('\n')}\n`)
}

/** 真实文件持久化（索引状态落盘，跨实例复用）。 */
function jsonFilePersistence(path: string) {
  return {
    async load(): Promise<unknown> {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown
      } catch {
        return undefined
      }
    },
    async save(state: IndexFileState): Promise<void> {
      await writeFile(path, JSON.stringify(state))
    },
  }
}

/** 宿主成员面（可变：会话后来才挂进工作区）。 */
function membershipFace(sessionIds: () => readonly string[]) {
  return {
    list: () => [{ id: 'ws-1', sessionIds: [...sessionIds()] }],
    get: (workspaceId: string) =>
      workspaceId === 'ws-1' ? { id: 'ws-1', sessionIds: [...sessionIds()] } : undefined,
    archivedIds: () => [] as string[],
  }
}

/** 收编依赖面（真实索引 + 内存登记/投递记账）。 */
function adoptionDeps(index: SessionHeaderIndex) {
  const registered: string[] = []
  const deliveries: string[] = []
  const known = new Set<string>()
  const deps = {
    index,
    known: (sessionId: string) => known.has(sessionId),
    register: async (sessionId: string) => { registered.push(sessionId); known.add(sessionId) },
    deliver: async (sessionId: string) => { deliveries.push(sessionId) },
  }
  return { deps, registered, deliveries }
}

/* ────────────────────────── 集成链路 ────────────────────────── */

describe('冷日志 → 索引 → 收编：真实 FS 集成', () => {
  it('两个独立 Router 都被登记并投递；非 Router 邻居不动；稳态轮零副作用', async () => {
    const root = await tmpRoot()
    await writeSession(root, 'router-one', { agentPreset: 'dsh-router', projectDir: 'proj-a' })
    await writeSession(root, 'router-two', { agentPreset: 'dsh-router', projectDir: 'proj-b' })
    await writeSession(root, 'worker-plain', { agentPreset: 'other-preset', projectDir: 'proj-a' })

    const index = new SessionHeaderIndex({
      root,
      routerPreset: 'dsh-router',
      membership: membershipFace(() => ['router-one', 'router-two', 'worker-plain']),
    })
    await index.reconcile()
    await index.advance()

    const { deps, registered, deliveries } = adoptionDeps(index)
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    // 两个独立 Router：都登记、都投递（不选正主、不归档、不跳转）。
    expect(registered.sort()).toEqual(['router-one', 'router-two'])
    expect(deliveries.sort()).toEqual(['router-one', 'router-two'])

    // 稳态轮：没有待消费授予 → 零副作用。
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(registered).toHaveLength(2)
    expect(deliveries).toHaveLength(2)

    const diagnostics = routerAdoptionDiagnostics(cache)
    expect(diagnostics.registered).toBe(2)
    expect(diagnostics.delivered).toBe(2)
    expect(diagnostics.deferred).toBe(0)
    expect(diagnostics.inflight).toBe(false)

    await index.dispose()
  })

  it('坏邻居（unknown/损坏/未来格式/seeded）不挡住两个 Router', async () => {
    const root = await tmpRoot()
    await writeSession(root, 'router-one', { agentPreset: 'dsh-router', projectDir: 'proj-a' })
    await writeSession(root, 'router-two', { agentPreset: 'dsh-router', projectDir: 'proj-b' })
    // 坏邻居四种：seeded、损坏正文、未来版本、预设无关。
    await writeSession(root, 'seeded-one', { agentPreset: 'dsh-router', isSeeded: true })
    await writeSession(root, 'broken-one', { raw: '{not json at all\n' })
    await writeSession(root, 'future-one', { agentPreset: 'dsh-router', version: 5 })
    await writeSession(root, 'other-one', { agentPreset: 'other-preset' })

    const index = new SessionHeaderIndex({
      root,
      routerPreset: 'dsh-router',
      membership: membershipFace(() => ['router-one', 'router-two', 'seeded-one', 'broken-one', 'future-one', 'other-one']),
    })
    await index.reconcile()
    await index.advance()

    const { deps, registered, deliveries } = adoptionDeps(index)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', createRouterAdoptionCache())
    expect(registered.sort()).toEqual(['router-one', 'router-two'])
    expect(deliveries.sort()).toEqual(['router-one', 'router-two'])
    await index.dispose()
  })

  it('后来落盘的新 Router 会被增量收编（冷日志补投身份卡）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 'router-early', { agentPreset: 'dsh-router' })
    const state = { sessionIds: ['router-early'] as string[] }
    const index = new SessionHeaderIndex({
      root,
      routerPreset: 'dsh-router',
      membership: membershipFace(() => state.sessionIds),
    })
    await index.reconcile()
    await index.advance()

    const { deps, registered, deliveries } = adoptionDeps(index)
    const cache = createRouterAdoptionCache()

    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(registered).toEqual(['router-early'])

    // 会话文件后来才出现（picker 自建后落盘）：索引对账发现并判定，增量发放，收编补登记。
    await writeSession(root, 'router-late', { agentPreset: 'dsh-router', projectDir: 'proj-late' })
    state.sessionIds.push('router-late')
    await index.reconcile()
    await index.advance()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(registered).toEqual(['router-early', 'router-late'])
    expect(deliveries).toEqual(['router-early', 'router-late'])

    await index.dispose()
  })

  it('冷缓存重启：hydrate → 同指纹对账 → 收编（载入缓存未核指纹前不消费候选）', async () => {
    const root = await tmpRoot()
    const statePath = join(root, 'session-index.json')
    await writeSession(root, 'router-cold', { agentPreset: 'dsh-router', projectDir: 'proj-cold' })

    // 第一个进程：分类并落盘索引状态。
    const first = new SessionHeaderIndex({
      root,
      routerPreset: 'dsh-router',
      persistence: jsonFilePersistence(statePath),
      membership: membershipFace(() => ['router-cold']),
    })
    await first.reconcile()
    await first.advance()
    expect(first.verdictOf('router-cold')).toMatchObject({ status: 'classified', verdict: 'router' })
    await first.dispose()

    // 第二个进程（冷重启）：hydrate 后判定是 pending（缓存未核指纹），
    // **待消费面上没有候选**——不会把未核验的候选提前消费掉。
    const second = new SessionHeaderIndex({
      root,
      routerPreset: 'dsh-router',
      persistence: jsonFilePersistence(statePath),
      membership: membershipFace(() => ['router-cold']),
    })
    await second.hydrate()
    expect(second.verdictOf('router-cold').status, '载入缓存未核指纹前不得授权').toBe('pending')
    expect(second.unclaimedRouterGrants(10), '未核验的候选不该出现在待消费面').toEqual([])

    // 对账核到同一指纹 → 资格成立 → 收编照常发生。
    const { deps, registered, deliveries } = adoptionDeps(second)
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(registered, '对账核到同指纹前不该收编').toEqual([])

    await second.reconcile()
    expect(second.verdictOf('router-cold')).toMatchObject({ status: 'classified', verdict: 'router' })
    expect(second.unclaimedRouterGrants(10).map((grant) => grant.sessionId)).toEqual(['router-cold'])

    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(registered).toEqual(['router-cold'])
    expect(deliveries).toEqual(['router-cold'])
    await second.dispose()
  })
})

describe('收编面不存在 canonical/归档/跳转通道（v1.4 语义防回潮）', () => {
  it('收编模块源码不含 pin/archive/redirect/canonical 依赖面', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/host/bridge/router-adoption.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/\b(pinSession|archiveSession|redirect|canonical|superseded|dedup)\b/i)
  })
})
