/**
 * 派发后压缩驱动（计划 Task B5）。
 *
 * 规格 §4「每次成功转交后执行一次上下文整理」：任务派发（onDispatched）时给
 * 会话打 pending 标记；会话空闲（onIdle，接线自 B4 watchStatus 的
 * api-session/status running=false）且有 pending 时才动作。压缩区域 =
 * [上次检查点之后 .. 最后一条用户消息之前]，两端先过 toolPairingBalanced
 * 校验，合法才调 compactRegion（压缩引擎与配对函数全部从注入面进，测试用
 * 假件）。无合法区域或校验不过 → 跳过、保留标记留待下次；压缩失败同理；
 * 成功后推进检查点并清标记。压缩进行中重复 onIdle 直接 no-op（不重入）。
 */

/** 注入面：压缩引擎 seam + 配对检查 + 事件锚点（宿主装配时接真实实现）。 */
export interface CompactionDeps {
  /** 目标会话的存活 agent（不存活返回 undefined；带 status 供 idle 判定）。 */
  getAgent(sessionId: string): { session: unknown; status?: string } | undefined
  /** 最后一条用户消息的 surface seq（没有返回 null；接线用 sessionQuery 读 user/message）。 */
  lastUserMessageSeq(sessionId: string): Promise<number | null>
  /** @deepseek-ai/dsh-compaction 的 toolPairingBalancedBefore（区域起点端）。 */
  balancedBefore(session: unknown, seq: number): Promise<boolean>
  /** toolPairingBalancedAfter（区域终点端）。 */
  balancedAfter(session: unknown, seq: number): Promise<boolean>
  /** @deepseek-ai/dsh-compaction 的 compactRegion(start, end, agent, signal)。 */
  compactRegion(start: number, end: number, agent: unknown, signal?: AbortSignal): Promise<{ endSeq?: number } | unknown>
  /**
   * 会话是否已无排队消息（true = 无排队）。缺席视为恒真（维持既有行为）；
   * 查询抛错按 false（还有排队）处理——保守跳过，不清标记。
   */
  queueEmpty?(sessionId: string): Promise<boolean>
  now(): number
}

export type IdleOutcome = 'compacted' | 'skipped' | 'no-op'

export class CompactionDriver {
  private deps: CompactionDeps
  /** 每会话上次压缩终点（下一次区域起点 = 检查点 + 1；初始 -1 → 从 0 起）。 */
  private checkpoints = new Map<string, number>()
  private pending = new Set<string>()
  private compacting = new Set<string>()

  constructor(deps: CompactionDeps) {
    this.deps = deps
  }

  /** 成功转交（派发/补充重投）后调用：给目标会话打标记。 */
  onDispatched(sessionId: string): void {
    this.pending.add(sessionId)
  }

  /** 压缩是否待办（测试与观测口）。 */
  isPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /** 某会话的当前检查点（观测口）。 */
  checkpointOf(sessionId: string): number {
    return this.checkpoints.get(sessionId) ?? -1
  }

  /** 会话空闲：有 pending 标记、无排队消息才尝试压缩。 */
  async onIdle(sessionId: string, signal?: AbortSignal): Promise<IdleOutcome> {
    if (!this.pending.has(sessionId)) return 'no-op'
    if (this.compacting.has(sessionId)) return 'no-op'
    if (this.deps.queueEmpty !== undefined) {
      try {
        if (!(await this.deps.queueEmpty(sessionId))) return 'skipped'
      } catch {
        return 'skipped' // 排队状态查不到：保守按「还有排队」处理
      }
    }
    const agent = this.deps.getAgent(sessionId)
    if (agent === undefined) return 'skipped' // 会话没活着，等下次
    if (agent.status !== undefined && agent.status !== 'idle') return 'skipped'
    this.compacting.add(sessionId)
    try {
      const lastUserSeq = await this.deps.lastUserMessageSeq(sessionId)
      if (lastUserSeq === null) return 'skipped'
      const start = this.checkpointOf(sessionId) + 1
      const end = lastUserSeq - 1
      if (end < start) return 'skipped' // 区域为空：无内容可压
      const session = agent.session
      if (!(await this.deps.balancedBefore(session, start))) return 'skipped'
      if (!(await this.deps.balancedAfter(session, end))) return 'skipped'
      const result = await this.deps.compactRegion(start, end, agent, signal)
      const endSeq = (result as { endSeq?: number } | null)?.endSeq
      this.checkpoints.set(sessionId, typeof endSeq === 'number' ? endSeq : end)
      this.pending.delete(sessionId)
      return 'compacted'
    } catch {
      // 摘要失败保留原上下文重试（规格 §4）：标记不清，留待下次 idle
      return 'skipped'
    } finally {
      this.compacting.delete(sessionId)
    }
  }
}
