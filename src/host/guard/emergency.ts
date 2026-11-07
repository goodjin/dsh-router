/**
 * 紧急暂停编排（v1.2 计划 Task B4，规格 Review Focus 5）。
 *
 * 语义 = breaker.freeze('user-emergency') + 对账本全部 running/dispatched 任务
 * 的执行会话逐个中断（bridge.interruptTaskSessions，r8 §5 的 agents 形态）+
 * 写一条 kind:'anomaly' 异常通知 + 返回逐项结果。
 *
 * 三条如实录（不静默）：
 *   - 中断失败项在 interrupted[].outcome='failed' 带 detail，HTTP 照常 200
 *     （冻结已生效，失败是部分结果，不是整体失败）；
 *   - 失败明细同时进通知摘要（汇总卡如实报失败项）；
 *   - 中断面未接线 → 全部如实 failed，冻结照常生效。
 *
 * 本函数是 entry.ts 与测试共用的同一份组装逻辑（避免测试假件与生产漂移）；
 * 宿主面（账本扫描 / 熔断冻结 / 中断 / 通知落卡）全部注入。注意边界（r8 §3）：
 * 只停任务会话本体的活动轮次，不停它们派生的 jobs/子代理会话。
 */

import type { TaskStatus } from '../../shared/types.ts'
import type { GuardNotification } from '../../shared/view-contract.ts'
import type { InterruptOutcome } from '../bridge/sessions.ts'

/** 紧急暂停的冻结原因（留痕 guard-state；用户解除后不再复现）。 */
export const EMERGENCY_PAUSE_REASON = 'user-emergency'

/** 紧急暂停的报告（lossless：可选键只在有值时出现）。 */
export interface EmergencyPauseReport {
  /** 冻结后的熔断状态（emergency-pause 恒冻结）。 */
  frozen: boolean
  /** 生效中的冻结原因（本次写入 user-emergency；已冻结时保留首次原因）。 */
  reason?: string
  /** 逐会话中断结果（失败项如实列出）。 */
  interrupted: InterruptOutcome[]
  /** interrupted 中 outcome='failed' 的数量（响应消费方的一眼判据）。 */
  failedCount: number
  /** 写入的异常通知卡（通知面缺席/失败时缺席，其余失败在 interrupted 里如实带出）。 */
  notification?: GuardNotification
}

export interface EmergencyPauseDeps {
  /** 目标会话收集（entry：emergencyPauseTargets(ledger.listAll())）。 */
  targetSessionIds(): Promise<string[]>
  /** 冻结（幂等；返回冻结后的状态与生效原因）。 */
  freeze(reason: string): Promise<{ frozen: boolean; reason?: string }>
  /** 逐会话中断（bridge.interruptTaskSessions）。 */
  interrupt(sessionIds: string[]): Promise<InterruptOutcome[]>
  /** 异常通知落卡（缺席/失败不挡暂停，报告如实缺 notification）。 */
  notify?(input: { title: string; summary: string }): Promise<NotificationCard | undefined>
  /** 通知失败等非致命问题的日志口（缺席静默）。 */
  logger?: { warn(message: string): void }
}

/**
 * 紧急暂停目标：账本 running/dispatched 且已绑执行会话的任务（paused/queued/
 * waiting-user 等其余状态不打扰；无会话的任务无处可停）。
 */
export function emergencyPauseTargets(
  records: readonly { status: TaskStatus; sessionId?: string }[],
): string[] {
  return records
    .filter(
      (record) =>
        (record.status === 'running' || record.status === 'dispatched')
        && typeof record.sessionId === 'string'
        && record.sessionId !== '',
    )
    .map((record) => record.sessionId as string)
}

/** 执行紧急暂停：冻结 → 收集 → 逐会话中断 → 异常通知 → 逐项报告。 */
export async function runEmergencyPause(deps: EmergencyPauseDeps): Promise<EmergencyPauseReport> {
  // 1. 先冻结（拦住新的派发），再中断在跑的会话——顺序保证冻结窗口内不新增目标。
  const freezeOutcome = await deps.freeze(EMERGENCY_PAUSE_REASON)
  // 2. 逐会话中断（单会话失败不拖垮批量，逐项结果如实聚合）。
  const sessionIds = await deps.targetSessionIds()
  const interrupted = sessionIds.length > 0 ? await deps.interrupt(sessionIds) : []
  const failed = interrupted.filter((entry) => entry.outcome === 'failed')
  // 3. 异常通知：摘要如实带失败明细（Review Focus 5：汇总卡不静默）。
  let notification: GuardNotification | undefined
  if (deps.notify !== undefined) {
    const failedText = failed
      .map((entry) => `${entry.sessionId}（${entry.detail ?? '原因未记录'}）`)
      .join('；')
    const summary =
      interrupted.length === 0
        ? `派发已冻结（${freezeOutcome.reason ?? EMERGENCY_PAUSE_REASON}），无进行中的任务会话需要中断`
        : `派发已冻结（${freezeOutcome.reason ?? EMERGENCY_PAUSE_REASON}），已中断 ${interrupted.length} 个任务会话（受理 ${interrupted.length - failed.length}${failed.length > 0 ? `；失败 ${failed.length}：${failedText}` : ''}）`
    try {
      notification = await deps.notify({ title: '紧急暂停已执行', summary })
    } catch (error) {
      deps.logger?.warn(
        `紧急暂停的异常通知写入失败（逐项结果已在响应里如实带出）: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  // 4. 报告（lossless：可选键只在有值时出现）。
  const report: EmergencyPauseReport = { frozen: freezeOutcome.frozen, interrupted, failedCount: failed.length }
  if (freezeOutcome.reason !== undefined) report.reason = freezeOutcome.reason
  if (notification !== undefined) report.notification = notification
  return report
}
