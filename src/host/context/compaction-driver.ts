/**
 * 派发后压缩驱动（计划 Task B5；2026-11-11 修复「压缩从未执行」）。
 *
 * 规格 §4「每次成功转交后执行一次上下文整理」：任务派发（onDispatched）时给
 * 会话打 pending 标记；会话空闲（onIdle，接线自 B4 watchStatus 的
 * api-session/status running=false）且有 pending 时才动作。
 *
 * 旧实现自拼压缩区域 [检查点+1 .. 最后一条用户消息-1]，边界用裸 seq 算术。
 * 真实会话里日志事件与 surface 成员不同——seq 0 常是 permission/preset 等
 * 非 surface 事件，配对校验对非 surface seq 直接抛「surface seq not found」，
 * 被兜底 catch 静默吞掉 → 压缩从未执行（603KB 历史的成因）。现改为调用
 * 引擎的 compactNow：引擎自己圈安全范围、自己以 maintenance 方式独占会话、
 * 没有有效范围时返回 null，区域算术整块删除。
 *
 * 每个 skip 路径自报一次原因（每会话每原因只报一次，不刷屏）——静默失败
 * 在这次事故里正是「查不到任何信号」的根源，不能再无声。
 */

/** 注入面：压缩引擎 seam + 排队检查 + 自报出口（宿主装配时接真实实现）。 */
export interface CompactionDeps {
  /** 目标会话的存活 agent（不存活返回 undefined；带 status 供 idle 判定）。 */
  getAgent(sessionId: string): { session: unknown; status?: string } | undefined
  /**
   * 引擎的 compactNow(agent, signal)——idle 会话的一次有效缩减；引擎自圈
   * 范围、自校验边界，无可压内容返回 null。调用方保证 agent 已 idle。
   */
  compactNow?(agent: unknown, signal?: AbortSignal): Promise<unknown> | unknown
  /**
   * 会话是否已无排队消息（true = 无排队）。缺席视为恒真（维持既有行为）；
   * 查询抛错按 false（还有排队）处理——保守跳过，不清标记。
   */
  queueEmpty?(sessionId: string): Promise<boolean>
  /** skip 原因自报出口（每会话每原因只报一次由驱动侧保证）。 */
  reportSkip?(sessionId: string, reason: string): void
  now(): number
}

export type IdleOutcome = 'compacted' | 'skipped' | 'no-op'

export class CompactionDriver {
  private deps: CompactionDeps
  private pending = new Set<string>()
  private compacting = new Set<string>()
  /** 每会话已自报过的 skip 原因（同一原因只报一次）。 */
  private reported = new Map<string, Set<string>>()

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

  /** 自报一个 skip 原因（每会话每原因一次）。 */
  private reportSkip(sessionId: string, reason: string): void {
    let seen = this.reported.get(sessionId)
    if (seen === undefined) {
      seen = new Set<string>()
      this.reported.set(sessionId, seen)
    }
    if (seen.has(reason)) return
    seen.add(reason)
    this.deps.reportSkip?.(sessionId, reason)
  }

  /** 会话空闲：有 pending 标记、无排队消息才驱动压缩。 */
  async onIdle(sessionId: string, signal?: AbortSignal): Promise<IdleOutcome> {
    if (!this.pending.has(sessionId)) return 'no-op'
    if (this.compacting.has(sessionId)) return 'no-op'
    if (this.deps.queueEmpty !== undefined) {
      try {
        if (!(await this.deps.queueEmpty(sessionId))) {
          this.reportSkip(sessionId, 'queue-not-empty')
          return 'skipped'
        }
      } catch (error) {
        // 排队状态查不到：保守按「还有排队」处理
        this.reportSkip(sessionId, `queue-unknown: ${error instanceof Error ? error.message : String(error)}`)
        return 'skipped'
      }
    }
    const agent = this.deps.getAgent(sessionId)
    if (agent === undefined) {
      this.reportSkip(sessionId, 'agent-absent')
      return 'skipped' // 会话没活着，等下次
    }
    if (agent.status !== undefined && agent.status !== 'idle') {
      this.reportSkip(sessionId, 'agent-not-idle')
      return 'skipped'
    }
    if (this.deps.compactNow === undefined) {
      this.reportSkip(sessionId, 'engine-absent')
      return 'skipped' // 引擎不可用：不能静默（2026-11-11 教训）
    }
    this.compacting.add(sessionId)
    try {
      await this.deps.compactNow(agent, signal)
      // null = 引擎判定无有效范围，视为本轮完成；失败会抛（下方 catch）。
      this.pending.delete(sessionId)
      return 'compacted'
    } catch (error) {
      // 摘要失败保留原上下文重试（规格 §4）：标记不清，留待下次 idle
      this.reportSkip(sessionId, `compact-failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'skipped'
    } finally {
      this.compacting.delete(sessionId)
    }
  }
}
