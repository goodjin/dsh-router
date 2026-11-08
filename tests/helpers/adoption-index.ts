/**
 * 收编侧索引替身（共享夹具）。
 *
 * 覆盖收编消费面用到的全部索引能力：判定、定点磁盘核验、定点成员/归档
 * 权威核验、成员定位、资格授予（pending/ack/代数）、生命周期代际。
 * 状态可变（模拟异步间隙里的翻面/移动/归档），并统计调用次数（成本断言
 * 用真实计数，不用时间假证明）。
 */

import type { RouterAdoptionIndexFace } from '../../src/host/bridge/router-adoption.ts'
import type { RouterGrant, TargetAuthority, VerdictLookup } from '../../src/host/session/session-index.ts'

export interface FakeIndex {
  index: RouterAdoptionIndexFace
  /** 当前判定（可改）。 */
  verdicts: Map<string, 'router' | 'nonrouter' | 'unknown'>
  /** 成员定位表：sessionId → workspaceId（可改）。 */
  members: Map<string, string>
  /** 宿主归档集（可改）。 */
  archived: Set<string>
  /** 定点磁盘核验结果（false = untrusted/changed/missing）。 */
  diskOk: Map<string, boolean>
  /** **未领取**的资格授予：id → 代数。 */
  grants: Map<string, number>
  /** **已领取未 ack** 的资格授予：id → 代数。 */
  claimed: Map<string, number>
  /** 生命周期代际。 */
  tokens: Map<string, number>
  /** 定点核验调用记录（每轮一个候选名）。 */
  verifyCalls: string[][]
  /** verifyTargets 调用记录。 */
  targetCalls: Array<{ workspaceId: string; sessionIds: readonly string[] }>
  /** 领取面枚举时真正访问过的未领取授予条数（成本口径）。 */
  grantVisits: number
  /** 核验等待期间触发的钩子（模拟异步间隙的变化）。 */
  onVerify?: (sessionId: string) => void
  /** 核验等待期间的目标核验钩子。 */
  onVerifyTargets?: (sessionId: string) => void
  /** 递增资格代数并发新一代授予（回未领取面）。 */
  regrant(sessionId: string): void
  /** 撤下资格（不再成立；两侧都撤）。 */
  revokeGrant(sessionId: string): void
  /** 推进生命周期代际（模拟 live 权威变化）。 */
  bumpToken(sessionId: string): void
}

export interface FakeIndexInit {
  verdicts?: Record<string, 'router' | 'nonrouter' | 'unknown'>
  members?: Record<string, string>
  archived?: readonly string[]
  diskOk?: Record<string, boolean>
  /** 初始待消费授予（id 列表；代数从 1 起）。 */
  grants?: readonly string[]
}

export function createFakeIndex(init: FakeIndexInit = {}): FakeIndex {
  const verdicts = new Map<string, 'router' | 'nonrouter' | 'unknown'>(Object.entries(init.verdicts ?? {}))
  const members = new Map<string, string>(Object.entries(init.members ?? {}))
  const archived = new Set<string>(init.archived ?? [])
  const diskOk = new Map<string, boolean>(Object.entries(init.diskOk ?? {}))
  const grants = new Map<string, number>()
  for (const id of init.grants ?? []) grants.set(id, 1)
  const claimed = new Map<string, number>()
  const tokens = new Map<string, number>()

  const fake: FakeIndex = {
    index: undefined as unknown as RouterAdoptionIndexFace,
    verdicts,
    members,
    archived,
    diskOk,
    grants,
    claimed,
    tokens,
    verifyCalls: [],
    targetCalls: [],
    grantVisits: 0,
    regrant(sessionId: string) {
      const generation = (grants.get(sessionId) ?? claimed.get(sessionId) ?? 0) + 1
      claimed.delete(sessionId)
      grants.set(sessionId, generation)
    },
    revokeGrant(sessionId: string) {
      grants.delete(sessionId)
      claimed.delete(sessionId)
    },
    bumpToken(sessionId: string) {
      tokens.set(sessionId, (tokens.get(sessionId) ?? 0) + 1)
    },
  }

  fake.index = {
    verdictOf(sessionId: string): VerdictLookup {
      const verdict = verdicts.get(sessionId)
      if (verdict === undefined) return { status: 'pending' }
      return { status: 'classified', verdict }
    },
    async verifyDiskFacts(sessionIds: readonly string[]): Promise<Map<string, { ok: boolean; kind?: 'untrusted' }>> {
      const names = [...sessionIds]
      fake.verifyCalls.push(names)
      const result = new Map<string, { ok: boolean; kind?: 'untrusted' }>()
      for (const name of names) {
        fake.onVerify?.(name)
        const ok = diskOk.get(name) ?? true
        result.set(name, ok ? { ok: true } : { ok: false, kind: 'untrusted' })
      }
      return result
    },
    verifyTargets(requests: ReadonlyArray<{ workspaceId: string; sessionIds: readonly string[] }>): Map<string, TargetAuthority> {
      const result = new Map<string, TargetAuthority>()
      for (const request of requests) {
        fake.targetCalls.push({ workspaceId: request.workspaceId, sessionIds: [...request.sessionIds] })
        for (const sessionId of request.sessionIds) {
          fake.onVerifyTargets?.(sessionId)
          const member = members.get(sessionId) === request.workspaceId
          result.set(sessionId, { member, archived: archived.has(sessionId) })
        }
      }
      return result
    },
    locateMember(sessionId: string) {
      const workspaceId = members.get(sessionId)
      if (workspaceId === undefined) return undefined
      return { workspaceId, archived: archived.has(sessionId) }
    },
    claimRouterGrants(limit: number): readonly RouterGrant[] {
      const out: RouterGrant[] = []
      if (limit <= 0) return out
      for (const [sessionId, generation] of [...grants]) {
        if (out.length >= limit) break
        fake.grantVisits += 1
        grants.delete(sessionId)
        claimed.set(sessionId, generation)
        out.push({ sessionId, generation })
      }
      return out
    },
    routerGrantGeneration(sessionId: string): number | undefined {
      return claimed.get(sessionId) ?? grants.get(sessionId)
    },
    ackRouterGrant(sessionId: string, generation: number): void {
      if (claimed.get(sessionId) === generation) {
        claimed.delete(sessionId)
        return
      }
      if (grants.get(sessionId) === generation) grants.delete(sessionId)
    },
    authorityToken(sessionId: string): number {
      return tokens.get(sessionId) ?? 0
    },
    refreshMembershipIfStale(): boolean {
      return false
    },
  }
  return fake
}
