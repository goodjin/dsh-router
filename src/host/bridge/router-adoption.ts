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
 * 复用。收编只消费索引的**资格授予**（pendingRouterGrants）与**定点**磁盘
 * 事实核验（verifyDiskFacts，一次只点一个候选名），绝不调用整日志
 * readSession，也不做整库 stat/list/open 兜底；稳态轮次（无待消费授予、
 * 无到期重试）零副作用、零成员枚举。
 *
 * 记账模型（review I1，取代旧的"基线快照"语义）：
 * - 索引侧发**资格授予**（sessionId + 资格代数），只有当前确实成立
 *   （判定=router 且已核验）的候选才有授予；载入缓存未核指纹、判定
 *   unknown/nonrouter 的候选**不在**待消费面——不会被"看一眼"就吞掉。
 * - 消费方**成功才 ack**；未 ack 的授予永远留在待消费面 → 延期、退避、
 *   跳过都不丢候选。
 * - 资格"不再成立 → 又成立"发新一代（代数 +1）：两个轮询之间的
 *   router→other→router 翻面不会被旧基线永久漏掉。
 *
 * 异步安全（review I4/I5/I6）：每个候选在**每个副作用启动前**都重新核对
 * 「当前仍是 router 判定 + 仍在目标工作区成员里 + 未被宿主归档 + 磁盘事实
 * 仍新鲜 + 生命周期代际未变」。等待期间翻面/离开/归档的候选只延期自身，
 * 绝不按旧计划登记或投递；失败进**有上限退避**的延期队列（可恢复，不永久
 * 放弃），邻居不受影响。
 */

import type { RouterGrant, TargetAuthority, VerdictLookup } from '../session/session-index.ts'

/** 收编侧用到的索引面（判定 + 定点核验 + 成员定位 + 资格授予）。 */
export interface RouterAdoptionIndexFace {
  /** 判定查询：classified/pending/failed。 */
  verdictOf(sessionId: string): VerdictLookup
  /** 定点磁盘事实核验（只核验被点名的候选）。 */
  verifyDiskFacts(sessionIds: readonly string[]): Promise<Map<string, { ok: boolean; kind?: 'untrusted' | 'changed' | 'missing' }>>
  /** 定点权威核验：目标会话现在还是该工作区成员吗/被宿主归档了吗。 */
  verifyTargets(requests: ReadonlyArray<{ workspaceId: string; sessionIds: readonly string[] }>): Map<string, TargetAuthority>
  /** 成员定位（增量缓存，O(1)）：目标工作区 + 归档状态。 */
  locateMember(sessionId: string): { workspaceId: string; archived: boolean } | undefined
  /** 待消费的资格授予（至多 limit 个；skip 里的由消费方自行排期重试）。 */
  pendingRouterGrants(limit: number, skip?: ReadonlySet<string>): readonly RouterGrant[]
  /** 待消费面上某 id 当前的资格代数。 */
  routerGrantGeneration(sessionId: string): number | undefined
  /** 记账点：消费方确认已消费（代数不符即忽略）。 */
  ackRouterGrant(sessionId: string, generation: number): void
  /** 生命周期代际（await 后的授权屏障）。 */
  authorityToken(sessionId: string): number
  /** 成员快照失效时刷新一次（缺席则不做；刷新成本由索引侧低频对账兜底）。 */
  refreshMembershipIfStale?(): boolean
}

/** 扫描器依赖面（entry 接宿主面与 ui/桥的包装）。 */
export interface RouterAdoptionDeps {
  /** 已验证会话候选索引：收编扫描的唯一判定源与成员定位源。 */
  index: RouterAdoptionIndexFace
  /** 该会话是否已在 Router 会话登记里（ui.routerSessions 投影）。 */
  known(sessionId: string): boolean
  /** 登记 Router 会话。 */
  register(sessionId: string, workspaceId: string): Promise<void>
  /**
   * 身份卡投递（entry 的 deliverRouterCardStrict：桥幂等，**失败向上抛**）。
   * 失败必须传播：只有真成功才记账（review I2）。
   */
  deliver(sessionId: string): Promise<void>
  logger?: { warn(message: string): void }
}

/** 扫描选项（无候选时缺省保守）。 */
export interface RouterAdoptionOptions {
  /** 单轮最多做多少次异步副作用；其余候选留到下一轮。 */
  budgetPerRound?: number
  /** 延期退避基数 ms（第一次延期等多久）。 */
  baseBackoffMs?: number
  /** 延期退避上限 ms（指数退避封顶——有上限，不无限拉长也不热循环）。 */
  maxBackoffMs?: number
  /** 时钟面（测试可注入；默认真实时钟）。 */
  now?: () => number
}

/** 一条延期中的候选（等退避到期再试；不丢、不永久放弃）。 */
export interface DeferredCandidate {
  /** 资格代数（重新成立时换代）。 */
  generation: number
  /** 连续失败次数（决定退避长度）。 */
  failures: number
  /** 下次可试时刻（ms）。 */
  nextAttemptAt: number
  /** 最近一次延期原因（诊断用，不含私有内容）。 */
  reason: string
}

/** 跨轮复用的护栏状态。 */
export interface RouterAdoptionCache {
  /** 已投过身份卡的会话（UI 持久标记才是跨重启幂等源）。 */
  readonly delivered: Set<string>
  /** 延期队列（退避到期再试；插入序 = 轮转序，失败头部不挡住后来者）。 */
  readonly deferred: Map<string, DeferredCandidate>
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
  /** 兼容字段：v1.4 起不再"永久放弃"，恒为 0（保留 wire 形状）。 */
  retriesDropped: number
  errors: number
}

/** /router/health 的收编诊断面（adoption 段）。 */
export interface RouterAdoptionDiagnostics {
  rounds: number
  registered: number
  delivered: number
  /** 兼容旧名：= deferred。 */
  retryQueue: number
  /** 延期中的候选数（可恢复，不是丢弃）。 */
  deferred: number
  /** 最近一次可重试时刻（ms；无延期时缺席）。 */
  nextRetryAt?: number
  /** 延期原因分布（计数口径）。 */
  deferredReasons: Record<string, number>
  verifyRejected: number
  staleSkipped: number
  /** 兼容字段：v1.4 起不再永久放弃，恒为 0。 */
  retriesDropped: number
  errors: number
  inflight: boolean
}

/** 默认每轮预算：够慢，不够快。 */
const DEFAULT_BUDGET_PER_ROUND = 10
/** 默认退避基数：一次失败后等这么久再试。 */
const DEFAULT_BASE_BACKOFF_MS = 2_000
/** 默认退避上限：指数退避封顶（不热循环，也不无限拉长）。 */
const DEFAULT_MAX_BACKOFF_MS = 60_000

/** 造一份空的护栏状态。 */
export function createRouterAdoptionCache(): RouterAdoptionCache {
  return {
    delivered: new Set<string>(),
    deferred: new Map<string, DeferredCandidate>(),
    pending: undefined,
    counters: { rounds: 0, registered: 0, delivered: 0, verifyRejected: 0, staleSkipped: 0, retriesDropped: 0, errors: 0 },
  }
}

/** 收编诊断快照（entry 的 getHealth 用）。 */
export function routerAdoptionDiagnostics(cache: RouterAdoptionCache): RouterAdoptionDiagnostics {
  const reasons: Record<string, number> = {}
  let nextRetryAt: number | undefined
  for (const record of cache.deferred.values()) {
    reasons[record.reason] = (reasons[record.reason] ?? 0) + 1
    if (nextRetryAt === undefined || record.nextAttemptAt < nextRetryAt) nextRetryAt = record.nextAttemptAt
  }
  return {
    rounds: cache.counters.rounds,
    registered: cache.counters.registered,
    delivered: cache.counters.delivered,
    retryQueue: cache.deferred.size,
    deferred: cache.deferred.size,
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
    deferredReasons: reasons,
    verifyRejected: cache.counters.verifyRejected,
    staleSkipped: cache.counters.staleSkipped,
    retriesDropped: cache.counters.retriesDropped,
    errors: cache.counters.errors,
    inflight: cache.pending !== undefined,
  }
}

/** 当前仍是 router 判定（索引判定是唯一事实源）。 */
function isRouterNow(index: RouterAdoptionIndexFace, sessionId: string): boolean {
  const lookup = index.verdictOf(sessionId)
  return lookup.status === 'classified' && lookup.verdict === 'router'
}

/**
 * 扫描所有工作区的会话：只消费已验证索引中当前为 router 的候选；逐个定点
 * 核验当前磁盘事实，未登记先登记，再幂等补发身份卡。unknown/damaged/large/old
 * 会话只跳过自身，单个核验或副作用失败不拖垮同工作区邻居。
 * @param deps - 宿主面与索引的包装。
 * @param routerPresetId - Router 预设的 id（只用于诊断/日志口径；判定在索引内）。
 * @param cache - 跨轮幂等标记、延期队列与单飞状态（缺省现造一份，只活这一轮）。
 * @param options - 每轮预算与退避参数。
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

/** 一条待处理候选（id + 资格代数）。 */
interface AdoptionCandidate {
  sessionId: string
  generation: number
}

/** 一轮实际扫描。 */
async function adoptPass(
  deps: RouterAdoptionDeps,
  cache: RouterAdoptionCache,
  options: RouterAdoptionOptions,
): Promise<void> {
  const budget = Math.max(0, options.budgetPerRound ?? DEFAULT_BUDGET_PER_ROUND)
  const baseBackoff = Math.max(0, options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS)
  const maxBackoff = Math.max(baseBackoff, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS)
  const now = (options.now ?? Date.now)()
  cache.counters.rounds += 1

  // ── 1. 延期队列维护（资格消失/换代 → 移出；到期 → 本轮重试） ──────────
  const dueDeferred: AdoptionCandidate[] = []
  for (const [sessionId, record] of [...cache.deferred]) {
    if (!isRouterNow(deps.index, sessionId)) {
      // 资格已不成立（索引侧同时撤下授予）→ 不再重试（不是丢弃：资格重新
      // 成立时索引会发新一代授予）。
      cache.deferred.delete(sessionId)
      continue
    }
    const generation = deps.index.routerGrantGeneration(sessionId)
    if (generation === undefined) {
      cache.deferred.delete(sessionId)
      continue
    }
    if (generation !== record.generation) {
      // 资格重新成立（新一代）→ 重置退避，本轮重新参与。
      cache.deferred.delete(sessionId)
      continue
    }
    if (record.nextAttemptAt <= now) dueDeferred.push({ sessionId, generation })
  }

  // ── 2. 新授予（索引侧未消费的资格） ──────────────────────────────────
  const skip = new Set(cache.deferred.keys())
  const grants = budget > 0 ? deps.index.pendingRouterGrants(budget, skip) : []

  // ── 3. 合并：延期到期与新授予**轮转交错**（失败头部不反复占预算） ──────
  const candidates: AdoptionCandidate[] = []
  let deferredIndex = 0
  let grantIndex = 0
  while (candidates.length < budget && (deferredIndex < dueDeferred.length || grantIndex < grants.length)) {
    if (deferredIndex < dueDeferred.length) {
      candidates.push(dueDeferred[deferredIndex]!)
      deferredIndex += 1
    }
    if (candidates.length < budget && grantIndex < grants.length) {
      candidates.push(grants[grantIndex]!)
      grantIndex += 1
    }
  }

  // ── 4. 逐个处理 ──────────────────────────────────────────────────────
  for (const candidate of candidates) {
    await adoptCandidate(deps, cache, candidate, now, baseBackoff, maxBackoff)
  }
}

/** 处理一个候选：定点核验 → 登记 → 复核 → 投递 → 记账。 */
async function adoptCandidate(
  deps: RouterAdoptionDeps,
  cache: RouterAdoptionCache,
  candidate: AdoptionCandidate,
  now: number,
  baseBackoff: number,
  maxBackoff: number,
): Promise<void> {
  const sessionId = candidate.sessionId
  try {
    // (0) 判定先行（内存、零成本）：资格已不成立的授予直接跳过——不做
    // 定点磁盘核验，也不延期（索引侧资格重新成立时会发新一代授予）。
    if (!isRouterNow(deps.index, sessionId)) {
      cache.deferred.delete(sessionId)
      return
    }
    // (1) 定位目标工作区（增量缓存 O(1)）+ 归档状态。
    let location = deps.index.locateMember(sessionId)
    if (location === undefined) {
      // 可能只是成员快照过期（创建先于 attach）：刷新一次再定位。
      deps.index.refreshMembershipIfStale?.()
      location = deps.index.locateMember(sessionId)
      if (location === undefined) {
        deferCandidate(deps, cache, sessionId, 'not-member', now, baseBackoff, maxBackoff)
        return
      }
    }
    if (location.archived) {
      deferCandidate(deps, cache, sessionId, 'archived', now, baseBackoff, maxBackoff)
      return
    }
    let workspaceId = location.workspaceId

    // (2) 定点磁盘事实核验（只点这个候选名；索引内共享有界 IO 槽位）。
    const facts = await deps.index.verifyDiskFacts([sessionId])
    const fact = facts.get(sessionId)
    if (fact === undefined || !fact.ok) {
      // untrusted/changed/missing：fail-closed，跳过自身，退避后再试。
      cache.counters.verifyRejected += 1
      deferCandidate(deps, cache, sessionId, `disk:${fact?.kind ?? 'unknown'}`, now, baseBackoff, maxBackoff)
      return
    }

    // (3) await 之后的同步复查（无间隙）：判定 + 目标工作区成员 + 未归档。
    if (!isRouterNow(deps.index, sessionId)) {
      cache.counters.staleSkipped += 1
      cache.deferred.delete(sessionId)
      return
    }
    let authority = deps.index.verifyTargets([{ workspaceId, sessionIds: [sessionId] }]).get(sessionId)
    if (authority === undefined || !authority.member) {
      // 目标工作区不再持有它 → 可能跨工作区移动：重新定位（不沿用旧映射）。
      deps.index.refreshMembershipIfStale?.()
      const relocated = deps.index.locateMember(sessionId)
      if (relocated === undefined || relocated.archived) {
        deferCandidate(deps, cache, sessionId, 'moved', now, baseBackoff, maxBackoff)
        return
      }
      workspaceId = relocated.workspaceId
      authority = deps.index.verifyTargets([{ workspaceId, sessionIds: [sessionId] }]).get(sessionId)
      if (authority === undefined || !authority.member || authority.archived) {
        deferCandidate(deps, cache, sessionId, 'moved', now, baseBackoff, maxBackoff)
        return
      }
    }
    if (authority.archived) {
      deferCandidate(deps, cache, sessionId, 'archived', now, baseBackoff, maxBackoff)
      return
    }

    // (4) 登记（await 之前记下生命周期代际与磁盘授权）。
    const token = deps.index.authorityToken(sessionId)
    if (!deps.known(sessionId)) {
      await deps.register(sessionId, workspaceId)
      cache.counters.registered += 1
    }

    // (5) register 等待之后：**再核一次磁盘事实**，并在同一同步屏障里复查
    // 判定 / 生命周期代际 / 目标工作区成员与归档（review I5/I6）。
    const factsAfter = await deps.index.verifyDiskFacts([sessionId])
    const factAfter = factsAfter.get(sessionId)
    if (factAfter === undefined || !factAfter.ok) {
      cache.counters.verifyRejected += 1
      deferCandidate(deps, cache, sessionId, `disk-after:${factAfter?.kind ?? 'unknown'}`, now, baseBackoff, maxBackoff)
      return
    }
    if (!isRouterNow(deps.index, sessionId)) {
      cache.counters.staleSkipped += 1
      cache.deferred.delete(sessionId)
      return
    }
    if (deps.index.authorityToken(sessionId) !== token) {
      // 生命周期/判定在等待期间变了 → 旧计划过期，延期后按新事实重来。
      cache.counters.staleSkipped += 1
      deferCandidate(deps, cache, sessionId, 'lifecycle-changed', now, baseBackoff, maxBackoff)
      return
    }
    const authorityAfter = deps.index.verifyTargets([{ workspaceId, sessionIds: [sessionId] }]).get(sessionId)
    if (authorityAfter === undefined || !authorityAfter.member || authorityAfter.archived) {
      deferCandidate(deps, cache, sessionId, 'moved', now, baseBackoff, maxBackoff)
      return
    }

    // (6) 投递身份卡：失败向上抛（不记账，等退避后重试）。
    if (!cache.delivered.has(sessionId)) {
      await deps.deliver(sessionId)
      cache.delivered.add(sessionId)
      cache.counters.delivered += 1
    }

    // (7) 记账：ack 资格授予（消费完成）。
    deps.index.ackRouterGrant(sessionId, candidate.generation)
    cache.deferred.delete(sessionId)
  } catch (error) {
    cache.counters.errors += 1
    deps.logger?.warn(`Router 会话收编失败（${sessionId}，退避后重试）: ${error instanceof Error ? error.message : String(error)}`)
    deferCandidate(deps, cache, sessionId, 'error', now, baseBackoff, maxBackoff)
  }
}

/**
 * 延期一个候选（**不丢**）：失败按指数退避改期（封顶），下一轮到期再试。
 * 资格已不在待消费面（不再成立）时直接移出——那不是丢弃，资格重新成立时
 * 索引会发新一代授予。
 */
function deferCandidate(
  deps: RouterAdoptionDeps,
  cache: RouterAdoptionCache,
  sessionId: string,
  reason: string,
  now: number,
  baseBackoff: number,
  maxBackoff: number,
): void {
  const generation = deps.index.routerGrantGeneration(sessionId)
  if (generation === undefined) {
    cache.deferred.delete(sessionId)
    return
  }
  const previous = cache.deferred.get(sessionId)
  const failures = (previous?.failures ?? 0) + 1
  const delay = Math.min(maxBackoff, baseBackoff * 2 ** Math.min(failures - 1, 16))
  // 重新插入 = 轮转到队尾：失败的头部不反复占预算，后来者公平前进。
  cache.deferred.delete(sessionId)
  cache.deferred.set(sessionId, { generation, failures, nextAttemptAt: now + delay, reason })
}
