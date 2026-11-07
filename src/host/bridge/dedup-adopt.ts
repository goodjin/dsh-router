/**
 * 去重正主的收编登记（v1.3 A2/A3 评审 F4 修正）。
 *
 * picker 自建的 Router 预设会话被 dedup 收编为正主后：此前只补发身份卡、不登记
 * ui.routerSessions——superset 工具行的运行期角色解析（callerRoleOf）查不到它，
 * 编排工具按 worker 兜底全部被拒，正主形同被锁死。修正：补发前先登记
 * ui.addRouterSession（已登记的不重写登记名），再走幂等身份卡投递。
 */

/** 收编依赖面（entry 接 ui 与桥的投递包装）。 */
export interface AdoptCanonicalsDeps {
  /** dedup.canonicalSessions() 的产物（workspace 配对）。 */
  canonicals: readonly { workspaceId: string; sessionId: string }[]
  /** 该会话是否已在 Router 会话登记里（ui.routerSessions 投影）。 */
  known(sessionId: string): boolean
  /** 登记 Router 会话（ui.addRouterSession 的定参包装）。 */
  register(sessionId: string, workspaceId: string): Promise<void>
  /**
   * 身份卡投递（entry 的 deliverRouterCard：桥幂等 + 失败告警不外泄——本函数
   * 不再吞错，投递方的降级语义归它）。
   */
  deliver(sessionId: string): Promise<void>
}

/**
 * 逐正主收编：未登记的先登记再补发，已登记的只补发。单个正主失败不拖垮其余
 * （登记/投递的异常各自捕获，逐项告警由注入方日志面处理）。
 */
export async function adoptCanonicalRouterSessions(deps: AdoptCanonicalsDeps): Promise<void> {
  for (const canonical of deps.canonicals) {
    try {
      if (!deps.known(canonical.sessionId)) {
        await deps.register(canonical.sessionId, canonical.workspaceId)
      }
      await deps.deliver(canonical.sessionId)
    } catch {
      // 单个正主失败不拖垮其余：下轮 GET /router/state 重进（登记幂等、投递幂等）。
    }
  }
}
