/**
 * 真实文件系统的收编链路集成夹具：冷日志 → 受限读取器 → SessionHeaderIndex
 * → 收编扫描。
 *
 * v1.4 语义的端到端证明：两个独立 Router 会话（不同项目目录、先后落盘）都被
 * 登记并幂等补发身份卡；非 Router 邻居原样不动；稳态轮次零副作用；全程没有
 * canonical/归档/跳转/复用——收编依赖面上不存在那些通道。夹具全部用真实
 * tmp FS 手写会话日志，不碰真实用户语料。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { SessionHeaderIndex } from '../src/host/session/session-index.ts'
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
  fields: { agentPreset?: string; projectDir?: string },
): Promise<void> {
  const dir = join(root, fields.projectDir ?? '--proj--', encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    isSeeded: false,
    delegationDepth: 0,
    ...(fields.agentPreset === undefined ? {} : { agentPreset: fields.agentPreset }),
  })
  const lines = [header, JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: {} })]
  await writeFile(join(dir, 'session.v4.jsonl'), `${lines.join('\n')}\n`)
}

/* ────────────────────────── 集成链路 ────────────────────────── */

describe('冷日志 → 索引 → 收编：真实 FS 集成', () => {
  it('两个独立 Router 都被登记并投递；非 Router 邻居不动；稳态轮零副作用', async () => {
    const root = await tmpRoot()
    await writeSession(root, 'router-one', { agentPreset: 'dsh-router', projectDir: 'proj-a' })
    await writeSession(root, 'router-two', { agentPreset: 'dsh-router', projectDir: 'proj-b' })
    await writeSession(root, 'worker-plain', { agentPreset: 'other-preset', projectDir: 'proj-a' })

    const index = new SessionHeaderIndex({ root, routerPreset: 'dsh-router' })
    await index.reconcile()
    await index.advance()

    const registered: string[] = []
    const deliveries: string[] = []
    const known = new Set<string>()
    const cache = createRouterAdoptionCache()
    const workspaces = [{ id: 'ws-1', sessionIds: ['router-one', 'router-two', 'worker-plain'] }]
    const deps = {
      workspaces,
      index,
      known: (sessionId: string) => known.has(sessionId),
      register: async (sessionId: string) => { registered.push(sessionId); known.add(sessionId) },
      deliver: async (sessionId: string) => { deliveries.push(sessionId) },
      changedCandidates: () => index.changedRouterCandidates(),
    }

    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    // 两个独立 Router：都登记、都投递（不选正主、不归档、不跳转）。
    expect(registered.sort()).toEqual(['router-one', 'router-two'])
    expect(deliveries.sort()).toEqual(['router-one', 'router-two'])

    // 稳态轮：索引 revision 未前进，零副作用。
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache)
    expect(registered).toHaveLength(2)
    expect(deliveries).toHaveLength(2)

    const diagnostics = routerAdoptionDiagnostics(cache)
    expect(diagnostics.registered).toBe(2)
    expect(diagnostics.delivered).toBe(2)
    expect(diagnostics.retryQueue).toBe(0)
    expect(diagnostics.inflight).toBe(false)

    await index.dispose()
  })

  it('后来落盘的新 Router 会被增量收编（冷日志补投身份卡）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 'router-early', { agentPreset: 'dsh-router' })
    const index = new SessionHeaderIndex({ root, routerPreset: 'dsh-router' })
    await index.reconcile()
    await index.advance()

    const registered: string[] = []
    const deliveries: string[] = []
    const known = new Set<string>()
    const cache = createRouterAdoptionCache()
    const state = { sessionIds: ['router-early'] as string[] }
    const deps = {
      get workspaces() {
        return [{ id: 'ws-1', sessionIds: [...state.sessionIds] }]
      },
      index,
      known: (sessionId: string) => known.has(sessionId),
      register: async (sessionId: string) => { registered.push(sessionId); known.add(sessionId) },
      deliver: async (sessionId: string) => { deliveries.push(sessionId) },
      changedCandidates: () => index.changedRouterCandidates(),
    }

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
})

describe('收编面不存在 canonical/归档/跳转通道（v1.4 语义防回潮）', () => {
  it('收编模块源码不含 pin/archive/redirect/canonical 依赖面', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/host/bridge/router-adoption.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/\b(pinSession|archiveSession|redirect|canonical|superseded|dedup)\b/i)
  })
})
