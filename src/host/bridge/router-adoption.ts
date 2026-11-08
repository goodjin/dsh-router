/**
 * Router 会话收编扫描（v1.4：替代已拆除的入口去重）。
 *
 * 语义变更（用户 2026-11-08 指示）：不再限制 Router 会话数量——每次经预设
 * 选择器新建的都是独立会话，不归档、不跳转、不复用。保留的唯一职责：
 * picker 自建的 Router 预设会话要被「收编」——登记进 ui.routerSessions
 * （否则编排工具的角色解析查不到它，按 worker 兜底全拒，v1.3 A3 评审 F4
 * 的教训）并幂等补发身份卡（cache 模式的身份协议要求会话开头有卡）。
 *
 * 成本护栏（2026-11-07 OOM 现场之后补回）：/router/state 每 2.5 秒轮询一次，
 * 而 readSession 对已落盘的会话会把整段日志读出来并深拷贝全部事件。本机
 * 7967 个会话、2.4 GB——每轮全量重扫就是 200%+ CPU 与几十分钟堆满 4 GB JS
 * 堆（一天五次）。v1.4 因此把判定改成已验证的受限读取器 + 持久化增量索引
 * （SessionHeaderIndex）：冷盘小日志只按有界 stable-EOF 扫描取最终组合；
 * seeded 排除与 live Session 投影提供其余安全事实；索引跨重启按文件指纹
 * 复用。收编只消费索引的增量候选（changedRouterCandidates）和**定点**磁盘
 * 事实核验（verifyDiskFacts，一次只点一个候选名），绝不调用整日志
 * readSession，也不做整库 stat/list/open 兜底；稳态轮次（索引 revision 未
 * 前进、无失败重试）零副作用。
 *
 * 异步安全：每个候选在定点核验之后、登记等待之后都重新核对「当前仍是
 * router 判定 + 仍在工作区成员里」；等待期间翻面/离开的候选只跳自身（索引
 * 判定翻转回 router 时会重新发放，自然重进收编）。单个候选失败进收编侧重试
 * 队列，连续失败达上限后出队（不无限热重试）；邻居不受影响。
 */

/** 扫描器依赖面（entry 接宿主面与 ui/桥的包装）。 */
export interface RouterAdoptionDeps {
  /** 工作区清单（registry.list() 的形状：含 sessionIds；建议用 getter 保持读取时新鲜）。 */
  workspaces: readonly { id: string; sessionIds?: readonly string[] }[]
  /** 已验证会话候选索引：收编扫描的唯一判定源。 */
  index: Pick<SessionHeaderIndex, 'verdictOf' | 'verifyDiskFacts'>
  /** 该会话是否已在 Router 会话登记里（ui.routerSessions 投影）。 */
  known(sessionId: string): boolean
  /** 登记 Router 会话。 */
  register(sessionId: string, workspaceId: string): Promise<void>
  /**
   * 身份卡投递（entry 的 deliverRouterCard：桥幂等 + 失败告警不外泄）。
   * 已知 UI 记录只补发，不为单个候选重复登记。
   */
  deliver(sessionId: string): Promise<void>
  /** 索引增量候选面（SessionHeaderIndex.changedRouterCandidates；缺省退化为全清单内存判定）。 */
  changedCandidates?: () => readonly string[]
  logger?: { warn(message: string): void }
}

import type { SessionHeaderIndex } from '../session/session-index.ts'

/** 扫描选项（无候选时缺省保守）。 */
export interface RouterAdoptionOptions {
  /** 单轮最多做多少次异步副作用；其余候选留到下一轮。 */
  budgetPerRound?: number
  /** 单个候选连续失败多少次后出队（等索引重新发放；默认 5）。 */
  retryLimitPerCandidate?: number
}

/** 跨轮复用的护栏状态。 */
export interface RouterAdoptionCache {
  /** 已投过身份卡的会话（UI 持久标记才是跨重启幂等源）。 */
  readonly delivered: Set<string>
  /** 上轮未消费完/失败的候选（重试队列，带连续失败计数）。 */
  readonly retry: Map<string, { failures: number }>
  /** 进行中的扫描（单飞）。 */
  pending: Promise<void> | undefined
  /** 诊断计数（/router/health 投喂；只计数不含私有内容）。 */
  readonly counters: RouterAdoptionCounters
}

/** 收编诊断计数。 */
export interface RouterAdoptionCounters {
  rounds: number
  registered: number
  delivered: number
  verifyRejected: number
  staleSkipped: number
  retriesDropped: number
  errors: number
}

/** /router/health 的收编诊断面（adoption 段）。 */
export interface RouterAdoptionDiagnostics {
  rounds: number
  registered: number
  delivered: number
  retryQueue: number
  verifyRejected: number
  staleSkipped: number
  retriesDropped: number
  errors: number
  inflight: boolean
}

/** 默认每轮预算：够慢，不够快。 */
const DEFAULT_BUDGET_PER_ROUND = 10
/** 默认单候选连续失败上限：到顶出队，等索引重新发放。 */
const DEFAULT_RETRY_LIMIT = 5

/** 造一份空的护栏状态。 */
export function createRouterAdoptionCache(): RouterAdoptionCache {
  return {
    delivered: new Set<string>(),
    retry: new Map<string, { failures: number }>(),
    pending: undefined,
    counters: { rounds: 0, registered: 0, delivered: 0, verifyRejected: 0, staleSkipped: 0, retriesDropped: 0, errors: 0 },
  }
}

/** 收编诊断快照（entry 的 getHealth 用）。 */
export function routerAdoptionDiagnostics(cache: RouterAdoptionCache): RouterAdoptionDiagnostics {
  return {
    rounds: cache.counters.rounds,
    registered: cache.counters.registered,
    delivered: cache.counters.delivered,
    retryQueue: cache.retry.size,
    verifyRejected: cache.counters.verifyRejected,
    staleSkipped: cache.counters.staleSkipped,
    retriesDropped: cache.counters.retriesDropped,
    errors: cache.counters.errors,
    inflight: cache.pending !== undefined,
  }
}

/** 当前仍是 router 判定（索引判定是唯一事实源）。 */
function isRouterNow(index: RouterAdoptionDeps['index'], sessionId: string): boolean {
  const lookup = index.verdictOf(sessionId)
  return lookup.status === 'classified' && lookup.verdict === 'router'
}

/** 会话当前仍在任一工作区成员里（异步间隙的定点成员复核）。 */
function isMemberNow(workspaces: readonly { id: string; sessionIds?: readonly string[] }[], sessionId: string): boolean {
  return workspaces.some((workspace) => (workspace.sessionIds ?? []).includes(sessionId))
}

/**
 * 扫描所有工作区的会话：只消费已验证索引中当前为 router 的候选；逐个定点
 * 核验当前磁盘事实，未登记先登记，再幂等补发身份卡。unknown/damaged/large/old
 * 会话只跳过自身，单个核验或副作用失败不拖垮同工作区邻居。
 * @param deps - 宿主面与索引的包装。
 * @param routerPresetId - Router 预设的 id（只用于诊断/日志口径；判定在索引内）。
 * @param cache - 跨轮幂等标记与单飞状态（缺省现造一份，只活这一轮）。
 * @param options - 每轮预算与重试上限。
 */
export async function scanAndAdoptRouterSessions(
  deps: RouterAdoptionDeps,
  routerPresetId: string,
  cache: RouterAdoptionCache = createRouterAdoptionCache(),
  options: RouterAdoptionOptions = {},
): Promise<void> {
  void routerPresetId
  // 单飞：进行中的扫描未落定时，后续调用并入同一轮。
  if (cache.pending !== undefined) {
    await cache.pending
    return
  }
  const run = adoptPass(deps, cache, options)
  cache.pending = run
  try {
    await run
  } finally {
    cache.pending = undefined
  }
}

/** 一轮实际扫描。 */
async function adoptPass(
  deps: RouterAdoptionDeps,
  cache: RouterAdoptionCache,
  options: RouterAdoptionOptions,
): Promise<void> {
  const budget = options.budgetPerRound ?? DEFAULT_BUDGET_PER_ROUND
  const retryLimit = options.retryLimitPerCandidate ?? DEFAULT_RETRY_LIMIT
  cache.counters.rounds += 1

  // 成员快照：sessionId → workspaceId（先到先得；同一会话不重复收编）。
  const membership = new Map<string, string>()
  for (const workspace of deps.workspaces) {
    for (const sessionId of workspace.sessionIds ?? []) {
      if (!membership.has(sessionId)) membership.set(sessionId, workspace.id)
    }
  }

  // 候选清单：重试队列优先；索引增量其次（没有增量面时退化为全清单内存判定，
  // 仍然零盘 IO——判定读取全在索引内存里）。
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const sessionId of cache.retry.keys()) {
    if (seen.has(sessionId)) continue
    // 重试项先过当前事实：判定翻面/离开工作区的直接出队。
    if (!isRouterNow(deps.index, sessionId) || !membership.has(sessionId)) {
      cache.retry.delete(sessionId)
      continue
    }
    seen.add(sessionId)
    candidates.push(sessionId)
  }
  const delta = deps.changedCandidates?.()
  if (delta !== undefined) {
    for (const sessionId of delta) {
      if (seen.has(sessionId) || !membership.has(sessionId)) continue
      if (!isRouterNow(deps.index, sessionId)) continue
      seen.add(sessionId)
      candidates.push(sessionId)
    }
  } else {
    // 全清单回退（无增量面时的兼容路径）：本进程已投递过的直接跳过——稳态
    // 轮次同样零副作用；新会话不在 delivered 集合里，照常收编。
    for (const sessionId of membership.keys()) {
      if (seen.has(sessionId) || cache.delivered.has(sessionId)) continue
      if (!isRouterNow(deps.index, sessionId)) continue
      seen.add(sessionId)
      candidates.push(sessionId)
    }
  }

  // 预算封顶：本轮做不完的整批回队（下轮优先，继续推进不卡死）。
  const batch = candidates.slice(0, Math.max(budget, 0))
  for (const sessionId of candidates.slice(batch.length)) {
    if (!cache.retry.has(sessionId)) cache.retry.set(sessionId, { failures: 0 })
  }

  const requeue = (sessionId: string): void => {
    const failures = (cache.retry.get(sessionId)?.failures ?? 0) + 1
    if (failures >= retryLimit) {
      cache.retry.delete(sessionId)
      cache.counters.retriesDropped += 1
    } else {
      cache.retry.set(sessionId, { failures })
    }
  }

  for (const sessionId of batch) {
    const workspaceId = membership.get(sessionId)
    if (workspaceId === undefined) {
      cache.retry.delete(sessionId)
      continue
    }
    try {
      // 定点磁盘事实核验：只点这个候选名（索引内共享有界 IO 槽位）。
      const facts = await deps.index.verifyDiskFacts([sessionId])
      const fact = facts.get(sessionId)
      if (fact === undefined || !fact.ok) {
        // untrusted/changed/missing：fail-closed，跳过自身，下轮再试。
        cache.counters.verifyRejected += 1
        requeue(sessionId)
        continue
      }
      // 异步间隙护栏一：核验等待期间判定翻面/离开工作区 → 不按旧计划登记。
      if (!isRouterNow(deps.index, sessionId) || !isMemberNow(deps.workspaces, sessionId)) {
        cache.counters.staleSkipped += 1
        cache.retry.delete(sessionId)
        continue
      }
      if (!deps.known(sessionId)) {
        await deps.register(sessionId, workspaceId)
        cache.counters.registered += 1
      }
      // 异步间隙护栏二：register 等待期间翻面/离开 → 不投递（登记幂等可回滚不起作用，
      // 但身份卡不该按 stale 计划发）。
      if (!isRouterNow(deps.index, sessionId) || !isMemberNow(deps.workspaces, sessionId)) {
        cache.counters.staleSkipped += 1
        cache.retry.delete(sessionId)
        continue
      }
      // 身份卡投递过一次就不再投；UI 持久标记是跨重启幂等源，cache 只挡进程内轮询。
      if (!cache.delivered.has(sessionId)) {
        await deps.deliver(sessionId)
        cache.delivered.add(sessionId)
        cache.counters.delivered += 1
      }
      cache.retry.delete(sessionId)
    } catch (error) {
      cache.counters.errors += 1
      deps.logger?.warn(`Router 会话收编失败（${sessionId}，下轮重试）: ${error instanceof Error ? error.message : String(error)}`)
      requeue(sessionId)
    }
  }
}
