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
 * 复用。收编只消费索引的**资格授予**（claimRouterGrants）与**定点**磁盘
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
  /**
   * **领取**未领取的资格授予（至多 limit 条）。领取后该授予进入"已领取"面，
   * 不再被重复领取，直到消费方 ack（记账点）或资格撤销。
   */
  claimRouterGrants(limit: number): readonly RouterGrant[]
  /** 某 id 当前的资格代数（已领取或未领取都算；没有授予则 undefined）。 */
  routerGrantGeneration(sessionId: string): number | undefined
  /** 未领取授予的条数（O(1)；判断"是否还有新工作"）。 */
  unclaimedRouterGrantCount(): number
  /** 交还一条已领取的授予（异常路径兜底：绝不留下无主的已领取授予）。 */
  releaseRouterGrant(sessionId: string, generation: number): void
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
   * 身份卡投递（2026-11-09 起可选——Router 身份由 persona 直定，不再投卡；
   * 留接口兼容旧接线：提供时仍「失败向上抛」，只有真成功才记账（review I2））。
   */
  deliver?(sessionId: string): Promise<void>
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

/** 延期队列的到期堆条目（惰性失效：弹出时与记录核对）。 */
interface DeferredHeapEntry {
  sessionId: string
  nextAttemptAt: number
}

/** 跨轮复用的护栏状态。 */
export interface RouterAdoptionCache {
  /** 已投过身份卡的会话（UI 持久标记才是跨重启幂等源）。 */
  readonly delivered: Set<string>
  /** 延期队列（退避到期再试；插入序 = 轮转序，失败头部不挡住后来者）。 */
  readonly deferred: Map<string, DeferredCandidate>
  /**
   * 延期队列的**到期堆**（按 nextAttemptAt 排序的最小堆；review I7 round 2）：
   * "有没有到期的重试"是一次 O(1)  peek——没有到期项时整轮**不再遍历延期
   * 队列**，也不构造全量快照/skip 集合。堆条目惰性失效（记录已删或已改期
   * 时弹出即丢）。
   */
  readonly deferredHeap: DeferredHeapEntry[]
  /**
   * 来源轮转位（review I7 round 3）：0 = 下一次先试到期重试，1 = 先试新
   * 授予。每完成一步翻转，**跨轮保留** → 即使 budget=1 也是交替的，新授予
   * 不会被到期的失败积压长期饿死。
   */
  rotation: number
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
  /** 维护消耗：被清理的失效/墓碑延期项（占预算）。 */
  maintenance: number
  /** 预算耗尽的轮数（还有工作但本轮预算用完——与"没有到期项"区分）。 */
  budgetExhausted: number
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
  /** 维护消耗（清理失效/墓碑延期项，占预算）。 */
  maintenance: number
  /** 预算耗尽的轮数（还有工作但本轮预算用完）。 */
  budgetExhausted: number
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
    deferredHeap: [],
    rotation: 0,
    pending: undefined,
    counters: {
      rounds: 0,
      registered: 0,
      delivered: 0,
      verifyRejected: 0,
      staleSkipped: 0,
      retriesDropped: 0,
      errors: 0,
      maintenance: 0,
      budgetExhausted: 0,
    },
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
    maintenance: cache.counters.maintenance,
    budgetExhausted: cache.counters.budgetExhausted,
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

/** 选择循环的一步（review I7 round 3）。 */
type SelectionStep =
  /** 一条可处理候选（到期重试或新授予）。 */
  | { kind: 'candidate'; candidate: AdoptionCandidate }
  /** 清理了一条失效/墓碑延期项——**占预算**（维护量与副作用共用预算）。 */
  | { kind: 'maintenance' }
  /** 当前两个来源都没有可做的事（不是"预算耗尽"）。 */
  | { kind: 'none' }

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

  // ── 统一选择循环（review I7 round 3）─────────────────────────────────
  // 一个预算 `spent` 同时约束**维护**与**副作用**：
  // - 每弹出一个堆条目（无论有效还是失效/墓碑）都扣 1 → 维护量有界，不会
  //   "一轮清空整个失效积压"（round 2 的 `while … continue` 就是这个问题）；
  // - 每个被处理的候选扣 1 → 副作用数仍然 ≤ 预算。
  // "预算耗尽"与"没有到期项"是两回事：前者意味着还有工作但本轮用完了预算
  // （下一轮从剩余积压继续），后者意味着两侧都没活干。
  let spent = 0
  while (spent < budget) {
    const step = nextStep(deps, cache, now)
    if (step.kind === 'none') break
    if (step.kind === 'maintenance') {
      cache.counters.maintenance += 1
      spent += 1
      continue
    }
    try {
      await adoptCandidate(deps, cache, step.candidate, now, baseBackoff, maxBackoff)
    } catch (error) {
      // 兜底：adoptCandidate 内部已经兜住了所有异常；这里防的是"连兜底都
      // 失败"（例如告警面本身抛错）。此时**不能丢掉已领取的授予**——先保住
      // 所有权（延期；连延期都失败就交还给未领取面），再告警。
      cache.counters.errors += 1
      retainOwnership(deps, cache, step.candidate, now, baseBackoff, maxBackoff)
      safeWarn(deps, `Router 会话收编异常（${step.candidate.sessionId}，退避后重试）: ${error instanceof Error ? error.message : String(error)}`)
    }
    spent += 1
  }
  if (spent >= budget && hasMoreWork(deps, cache, now)) cache.counters.budgetExhausted += 1
}

/**
 * 取下一步工作（review I7 round 3：来源**明确交替**，轮转位跨轮保留）。
 *
 * - 轮转位 `cache.rotation` 决定本步**先试哪个来源**（0 = 到期重试，
 *   1 = 新授予），每完成一步就翻转 —— 因此 budget=1 时也是交替的，新授予
 *   不会被到期的失败积压长期饿死（round 2 的"到期优先"就是这个问题）。
 * - 首选来源暂时没活时，回落到另一来源（不消耗预算：空检查是 O(1)）。
 */
function nextStep(deps: RouterAdoptionDeps, cache: RouterAdoptionCache, now: number): SelectionStep {
  const preferDue = cache.rotation === 0
  const take = (step: SelectionStep): SelectionStep => {
    if (step.kind !== 'none') cache.rotation = preferDue ? 1 : 0
    return step
  }
  if (preferDue) {
    const due = popDueCandidate(deps, cache, now)
    if (due.kind !== 'none') return take(due)
    const grant = claimOneGrant(deps, cache)
    if (grant !== undefined) return take({ kind: 'candidate', candidate: grant })
    return { kind: 'none' }
  }
  const grant = claimOneGrant(deps, cache)
  if (grant !== undefined) return take({ kind: 'candidate', candidate: grant })
  const due = popDueCandidate(deps, cache, now)
  if (due.kind !== 'none') return take(due)
  return { kind: 'none' }
}

/** 是否还有（可能）可做的事：到期堆顶已到期，或未领取面非空。 */
function hasMoreWork(deps: RouterAdoptionDeps, cache: RouterAdoptionCache, now: number): boolean {
  const top = cache.deferredHeap[0]
  if (top !== undefined && top.nextAttemptAt <= now) return true
  return deps.index.unclaimedRouterGrantCount() > 0
}

/**
 * 取一条**到期**的延期候选（最小堆驱动）。
 *
 * **每次调用最多弹出一个堆条目**（review I7 round 3）：失效/墓碑条目返回
 * `maintenance`（由调用方扣预算），不能内部无限 `continue` —— 否则一轮就能
 * 清空整个失效积压（维护量 O(backlog) 且不占预算）。
 */
function popDueCandidate(
  deps: RouterAdoptionDeps,
  cache: RouterAdoptionCache,
  now: number,
): SelectionStep {
  const top = cache.deferredHeap[0]
  if (top === undefined) return { kind: 'none' }
  if (top.nextAttemptAt > now) return { kind: 'none' } // 未到期 → 本轮无到期重试
  heapPop(cache)
  const record = cache.deferred.get(top.sessionId)
  if (record === undefined) return { kind: 'maintenance' } // 已移出 → 墓碑
  if (record.nextAttemptAt !== top.nextAttemptAt) return { kind: 'maintenance' } // 已改期 → 旧条目
  const generation = deps.index.routerGrantGeneration(top.sessionId)
  if (generation === undefined) {
    // 资格已被撤销（不再成立）→ 不再重试这条（将来重新成立会有新一代授予）。
    cache.deferred.delete(top.sessionId)
    return { kind: 'maintenance' }
  }
  if (generation !== record.generation) {
    // 资格换代（新一代已由领取面交付）→ 旧的延期项作废，不与新代抢。
    cache.deferred.delete(top.sessionId)
    return { kind: 'maintenance' }
  }
  return { kind: 'candidate', candidate: { sessionId: top.sessionId, generation: record.generation } }
}

/** 领取一条新授予（未领取面；O(1) 摊还，稳态未领取面为空 → 空过）。 */
function claimOneGrant(deps: RouterAdoptionDeps, cache: RouterAdoptionCache): AdoptionCandidate | undefined {
  const granted = deps.index.claimRouterGrants(1)
  const grant = granted[0]
  if (grant === undefined) return undefined
  // 新一代资格接管：旧的延期项作废（否则旧退避会把新代"吞"到很久以后）。
  const record = cache.deferred.get(grant.sessionId)
  if (record !== undefined && record.generation !== grant.generation) {
    cache.deferred.delete(grant.sessionId)
  }
  return { sessionId: grant.sessionId, generation: grant.generation }
}

/** 最小堆压入（按 nextAttemptAt）。 */
function heapPush(cache: RouterAdoptionCache, entry: DeferredHeapEntry): void {
  const heap = cache.deferredHeap
  heap.push(entry)
  let index = heap.length - 1
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (heap[parent]!.nextAttemptAt <= heap[index]!.nextAttemptAt) break
    const tmp = heap[parent]!
    heap[parent] = heap[index]!
    heap[index] = tmp
    index = parent
  }
}

/** 最小堆弹出（堆顶）。 */
function heapPop(cache: RouterAdoptionCache): DeferredHeapEntry | undefined {
  const heap = cache.deferredHeap
  if (heap.length === 0) return undefined
  const top = heap[0]!
  const last = heap.pop()!
  if (heap.length > 0) {
    heap[0] = last
    let index = 0
    for (;;) {
      const left = 2 * index + 1
      const right = 2 * index + 2
      let min = index
      if (left < heap.length && heap[left]!.nextAttemptAt < heap[min]!.nextAttemptAt) min = left
      if (right < heap.length && heap[right]!.nextAttemptAt < heap[min]!.nextAttemptAt) min = right
      if (min === index) break
      const tmp = heap[min]!
      heap[min] = heap[index]!
      heap[index] = tmp
      index = min
    }
  }
  return top
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
        deferCandidate(deps, cache, sessionId, candidate.generation, 'not-member', now, baseBackoff, maxBackoff)
        return
      }
    }
    if (location.archived) {
      deferCandidate(deps, cache, sessionId, candidate.generation, 'archived', now, baseBackoff, maxBackoff)
      return
    }
    let workspaceId = location.workspaceId

    // (2) 定点磁盘事实核验（只点这个候选名；索引内共享有界 IO 槽位）。
    const facts = await deps.index.verifyDiskFacts([sessionId])
    const fact = facts.get(sessionId)
    if (fact === undefined || !fact.ok) {
      // untrusted/changed/missing：fail-closed，跳过自身，退避后再试。
      cache.counters.verifyRejected += 1
      deferCandidate(deps, cache, sessionId, candidate.generation, `disk:${fact?.kind ?? 'unknown'}`, now, baseBackoff, maxBackoff)
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
        deferCandidate(deps, cache, sessionId, candidate.generation, 'moved', now, baseBackoff, maxBackoff)
        return
      }
      workspaceId = relocated.workspaceId
      authority = deps.index.verifyTargets([{ workspaceId, sessionIds: [sessionId] }]).get(sessionId)
      if (authority === undefined || !authority.member || authority.archived) {
        deferCandidate(deps, cache, sessionId, candidate.generation, 'moved', now, baseBackoff, maxBackoff)
        return
      }
    }
    if (authority.archived) {
      deferCandidate(deps, cache, sessionId, candidate.generation, 'archived', now, baseBackoff, maxBackoff)
      return
    }

    // (4) 登记（await 之前记下生命周期代际与磁盘授权）。
    const token = deps.index.authorityToken(sessionId)
    if (!deps.known(sessionId)) {
      await deps.register(sessionId, workspaceId)
      cache.counters.registered += 1

      // (5) register 等待之后：**再核一次磁盘事实**，并在同一同步屏障里复查
      // 判定 / 生命周期代际 / 目标工作区成员与归档（review I5/I6）。
      // 只有**跨过了 await** 才需要复核：没有 register 等待时，第 (3) 步的
      // 授权与投递之间没有任何 await，授权不会过期（同一同步屏障内）。
      const factsAfter = await deps.index.verifyDiskFacts([sessionId])
      const factAfter = factsAfter.get(sessionId)
      if (factAfter === undefined || !factAfter.ok) {
        cache.counters.verifyRejected += 1
        deferCandidate(deps, cache, sessionId, candidate.generation, `disk-after:${factAfter?.kind ?? 'unknown'}`, now, baseBackoff, maxBackoff)
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
        deferCandidate(deps, cache, sessionId, candidate.generation, 'lifecycle-changed', now, baseBackoff, maxBackoff)
        return
      }
      const authorityAfter = deps.index.verifyTargets([{ workspaceId, sessionIds: [sessionId] }]).get(sessionId)
      if (authorityAfter === undefined || !authorityAfter.member || authorityAfter.archived) {
        deferCandidate(deps, cache, sessionId, candidate.generation, 'moved', now, baseBackoff, maxBackoff)
        return
      }
    }

    // (6) 投递身份卡（可选——缺省即撤卡语义）：失败向上抛（不记账，等退避后重试）。
    if (deps.deliver !== undefined && !cache.delivered.has(sessionId)) {
      await deps.deliver(sessionId)
      cache.delivered.add(sessionId)
      cache.counters.delivered += 1
    }

    // (7) 记账：ack 资格授予（消费完成）。
    deps.index.ackRouterGrant(sessionId, candidate.generation)
    cache.deferred.delete(sessionId)
  } catch (error) {
    cache.counters.errors += 1
    // **先保住所有权再告警**：告警面本身抛错不得打断恢复路径（round 3 N1）。
    deferCandidate(deps, cache, sessionId, candidate.generation, 'error', now, baseBackoff, maxBackoff)
    safeWarn(deps, `Router 会话收编失败（${sessionId}，退避后重试）: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 告警（**吞掉自己的异常**）：告警面抛错不得打断收编的恢复路径——否则
 * 已领取的授予会失去所有者（round 3 N1）。
 */
function safeWarn(deps: RouterAdoptionDeps, message: string): void {
  try {
    deps.logger?.warn(message)
  } catch {
    // 告警面自身失败：忽略（不能让它中断收编/重试的所有权交接）。
  }
}

/**
 * 保住一个已领取候选的**所有权**（round 3 N1）：正常路径是"延期"；连延期都
 * 失败（索引面异常）时，把授予**交还**未领取面——下一轮重新领取，绝不留下
 * "已领取但既不在 pending 也不在 deferred"的孤儿。
 */
function retainOwnership(
  deps: RouterAdoptionDeps,
  cache: RouterAdoptionCache,
  candidate: AdoptionCandidate,
  now: number,
  baseBackoff: number,
  maxBackoff: number,
): void {
  try {
    deferCandidate(deps, cache, candidate.sessionId, candidate.generation, 'error', now, baseBackoff, maxBackoff)
    if (cache.deferred.has(candidate.sessionId)) return
  } catch {
    // 延期失败 → 走交还路径。
  }
  try {
    deps.index.releaseRouterGrant(candidate.sessionId, candidate.generation)
  } catch {
    // 交还也失败：只能留给索引侧（下轮由资格重新发放兜底）。
  }
}

/**
 * 延期一个候选（**不丢**）：失败按指数退避改期（封顶），下一轮到期再试。
 * 资格已撤销或已换代时直接移出——那不是丢弃：资格重新成立时索引会发新一代
 * 授予（回到未领取面，由领取路径交付，不会被旧的延期项吞掉）。
 */
function deferCandidate(
  deps: RouterAdoptionDeps,
  cache: RouterAdoptionCache,
  sessionId: string,
  generation: number,
  reason: string,
  now: number,
  baseBackoff: number,
  maxBackoff: number,
): void {
  const current = deps.index.routerGrantGeneration(sessionId)
  if (current === undefined || current !== generation) {
    // 资格已撤销（undefined）或已换代（新一代接管）→ 旧延期项作废。
    cache.deferred.delete(sessionId)
    return
  }
  const previous = cache.deferred.get(sessionId)
  const failures = (previous?.failures ?? 0) + 1
  const delay = Math.min(maxBackoff, baseBackoff * 2 ** Math.min(failures - 1, 16))
  const nextAttemptAt = now + delay
  // 重新插入 = 轮转到队尾：失败的头部不反复占预算，后来者公平前进。
  cache.deferred.delete(sessionId)
  cache.deferred.set(sessionId, { generation, failures, nextAttemptAt, reason })
  // 到期堆：新条目入堆；旧条目（不同 nextAttemptAt）惰性失效，弹出即丢。
  heapPush(cache, { sessionId, nextAttemptAt })
}
