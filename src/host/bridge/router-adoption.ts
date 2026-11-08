/**
 * Router 会话收编扫描（v1.4：替代已拆除的入口去重）。
 *
 * 语义变更（用户 2026-11-08 指示）：不再限制 Router 会话数量——每次经预设
 * 选择器新建的都是独立会话，不归档、不跳转、不复用。保留的唯一职责：
 * picker 自建的 Router 预设会话要被「收编」——登记进 ui.routerSessions
 * （否则编排工具的角色解析查不到它，按 worker 兜底全拒，v1.3 A3 评审 F4
 * 的教训）并幂等补发身份卡（cache 模式的身份协议要求会话开头有卡）。
 *
 * 分类缓存：会话是否 Router 预设按 sessionId 记内存 Set（宿主重启后重扫一
 * 遍，每会话一次 readSession 点读，成本可接受；不做持久化）。
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
 */
export async function scanAndAdoptRouterSessions(deps: RouterAdoptionDeps, routerPresetId: string): Promise<void> {
  const classified = new Set<string>()
  for (const workspace of deps.workspaces) {
    for (const sessionId of workspace.sessionIds ?? []) {
      try {
        if (!classified.has(sessionId)) {
          const observation = await deps.readSession(sessionId)
          if (isRouterPresetSession(observation, routerPresetId)) classified.add(sessionId)
        }
        if (!classified.has(sessionId)) continue
        if (!deps.known(sessionId)) await deps.register(sessionId, workspace.id)
        await deps.deliver(sessionId)
      } catch (error) {
        deps.logger?.warn(`Router 会话收编失败（${sessionId}，下轮重试）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
