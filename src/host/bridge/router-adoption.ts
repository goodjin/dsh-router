/**
 * Router 会话收编扫描（v1.4：替代已拆除的入口去重）。
 *
 * 语义变更（用户 2026-11-08 指示）：不再限制 Router 会话数量——每次经预设
 * 选择器新建的都是独立会话，不归档、不跳转、不复用。保留的唯一职责：
 * picker 自建的 Router 预设会话要被「收编」——登记进 ui.routerSessions
 * （否则编排工具的角色解析查不到它，按 worker 兜底全拒，v1.3 A3 评审 F4
 * 的教训）并幂等补发身份卡（cache 模式的身份协议要求会话开头有卡）。
 *
 * 成本护栏（2026-11-07 OOM 现场之后补回）：
 * /router/state 每 2.5 秒轮询一次，而 readSession 对已落盘的会话会把整段
 * 日志读出来并深拷贝全部事件。本机 7967 个会话、2.4 GB——每轮全量重扫就是
 * 200%+ CPU 与几十分钟堆满 4 GB JS 堆（一天五次）。
 *
 * v1.4 拆掉旧去重器时这些护栏没有跟着搬过来，注释里写的「稳态零读取」并
 * 没有做到：classified 是函数内的局部 Set，每轮都从零开始。这里补回四件事：
 *   - 判定缓存跨轮复用：已判定过的会话不再 readSession；
 *   - 单飞：进行中的扫描未落定时，后续调用并入同一轮；
 *   - 失败冷却：读失败的会话十分钟内不重试；
 *   - 每轮预算：新判定数封顶，剩下的留到下一轮慢慢推进。
 *
 * 判定缓存只存「这个会话是不是 Router 预设」这一位事实，按 sessionId 记在
 * 内存里（宿主重启后重扫一遍，每会话一次点读）。不做持久化——那份文件曾经
 * 存着去重器的裁决，语义已经不同了。
 */

/** 扫描器依赖面（entry 接宿主面与 ui/桥的包装）。 */
export interface RouterAdoptionDeps {
  /** 工作区清单（registry.list() 的形状：含 sessionIds）。 */
  workspaces: readonly { id: string; sessionIds?: readonly string[] }[]
  /** 一次性点读会话日志头部（判定 agentPreset）。 */
  readSession(sessionId: string): Promise<{ events?: readonly unknown[]; header?: { agentPreset?: string } } | undefined>
  /** 该会话是否已登记为 Router 会话（ui.routerSessions 投影）。 */
  known(sessionId: string): boolean
  /** 登记 Router 会话。 */
  register(sessionId: string, workspaceId: string): Promise<void>
  /** 身份卡投递（桥幂等 + 已发标记防重发）。 */
  deliver(sessionId: string): Promise<void>
  logger?: { warn(message: string): void }
}

/** 扫描选项（缺省保守：预算小、冷却短）。 */
export interface RouterAdoptionOptions {
  /** 每轮最多新判定多少个会话；其余留到下一轮。 */
  budgetPerRound?: number
  /** 读失败的会话多久之内不重试（毫秒）。 */
  failureCooldownMs?: number
}

/** 跨轮复用的判定缓存与护栏状态。 */
export interface RouterAdoptionCache {
  /** 已判定的会话：是不是 Router 预设。 */
  readonly verdicts: Map<string, boolean>
  /** 读失败的会话与它的冷却到期时刻。 */
  readonly failures: Map<string, number>
  /** 已经投过身份卡的会话。 */
  readonly delivered: Set<string>
  /** 进行中的扫描（单飞）。 */
  pending: Promise<void> | undefined
}

/** 默认每轮预算：够慢，不够快。 */
const DEFAULT_BUDGET_PER_ROUND = 10
/** 默认失败冷却：十分钟。 */
const DEFAULT_FAILURE_COOLDOWN_MS = 10 * 60 * 1000

/** 造一份空的护栏状态。 */
export function createRouterAdoptionCache(): RouterAdoptionCache {
  return {
    verdicts: new Map<string, boolean>(),
    failures: new Map<string, number>(),
    delivered: new Set<string>(),
    pending: undefined,
  }
}

/** 从点读结果判定是否 Router 预设会话（header 直判 + 事件兜底，双证据同 v1.1 C4）。 */
export function isRouterPresetSession(
  observation: { events?: readonly unknown[]; header?: { agentPreset?: string } } | undefined,
  routerPresetId: string,
): boolean {
  if (observation?.header?.agentPreset === routerPresetId) return true
  const events = observation?.events ?? []
  const header = events.find((event) => (event as { type?: string })?.type === 'session') as
    | { data?: { agentPreset?: string } }
    | undefined
  if (header?.data?.agentPreset === routerPresetId) return true
  return events.some(
    (event) =>
      (event as { type?: string })?.type === 'agent-preset/selected'
      && ((event as { data?: { agentPreset?: string } }).data?.agentPreset === routerPresetId),
  )
}

/**
 * 扫描所有工作区的会话：未分类的先点读分类；Router 预设会话逐个收编
 * （未登记先登记，再幂等补发身份卡）。单个失败不拖垮其余（下轮 state 重进）。
 *
 * 判定结果记进 cache 跨轮复用；已判定过的会话不再 readSession。读失败的会话
 * 进冷却，避免每轮都去撞同一个坏会话。
 * @param deps - 宿主面与 ui/桥的包装。
 * @param routerPresetId - Router 预设的 id。
 * @param cache - 跨轮复用的护栏状态（缺省现造一份，只活这一轮）。
 * @param options - 预算与冷却的缺省值。
 */
export async function scanAndAdoptRouterSessions(
  deps: RouterAdoptionDeps,
  routerPresetId: string,
  cache: RouterAdoptionCache = createRouterAdoptionCache(),
  options: RouterAdoptionOptions = {},
): Promise<void> {
  // 单飞：进行中的扫描未落定时，后续调用并入同一轮。
  if (cache.pending !== undefined) {
    await cache.pending
    return
  }
  const run = adoptPass(deps, routerPresetId, cache, options)
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
  routerPresetId: string,
  cache: RouterAdoptionCache,
  options: RouterAdoptionOptions,
): Promise<void> {
  const budget = options.budgetPerRound ?? DEFAULT_BUDGET_PER_ROUND
  const cooldown = options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS
  const now = Date.now()
  let spent = 0
  for (const workspace of deps.workspaces) {
    for (const sessionId of workspace.sessionIds ?? []) {
      // 判定过的不再读——这一条就是「稳态零读取」的兑现。
      if (!cache.verdicts.has(sessionId)) {
        // 预算用完了：这轮不判，留到下一轮。
        if (spent >= budget) continue
        // 失败冷却内的会话不重试。
        const failedAt = cache.failures.get(sessionId)
        if (failedAt !== undefined && now - failedAt < cooldown) continue
        spent += 1
        try {
          const observation = await deps.readSession(sessionId)
          cache.verdicts.set(sessionId, isRouterPresetSession(observation, routerPresetId))
          cache.failures.delete(sessionId)
        } catch (error) {
          cache.failures.set(sessionId, now)
          deps.logger?.warn(`Router 会话收编失败（${sessionId}，下轮重试）: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
      }
      if (cache.verdicts.get(sessionId) !== true) continue
      try {
        if (!deps.known(sessionId)) await deps.register(sessionId, workspace.id)
        // 身份卡投递过一次就不再投——稳态下这里不该每轮都发一遍请求。
        if (!cache.delivered.has(sessionId)) {
          await deps.deliver(sessionId)
          cache.delivered.add(sessionId)
        }
      } catch (error) {
        deps.logger?.warn(`Router 会话收编失败（${sessionId}，下轮重试）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
