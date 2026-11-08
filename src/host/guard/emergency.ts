/**
 * 作用域紧急暂停编排（v1.4 设计：紧急暂停只停当前 Router 派出去的活）。
 *
 * 与 v1.2 版的根本差别（用户 2026-11-08 指示）：
 *   - v1.2：冻结**全局**派发（breaker.freeze('user-emergency')）+ 中断**全部**
 *     运行中任务会话 + 落一条全局「派发已冻结」异常卡。冻结标记落
 *     guard-state.json，宿主重启后仍复现——用户因此被永久卡在「派发已冻结
 *     （user-emergency）」，而界面又永远显示「紧急暂停」而不是「解除冻结」
 *     （没有任何代码路径产出带 unfreeze 动作的卡），用户无法自救。
 *   - v1.4：**不碰全局熔断**，只停「当前 Router 会话派出的任务 + 其下游
 *     子任务」；不留任何全局标记；之后的新派发不受影响；别的 Router 会话
 *     不受影响。全局熔断保持全局且自动（infra 失败风暴 / 创建风暴仍会
 *     冻结派发，那是既定设计，本次不动）。
 *
 * 范围怎么算：宿主在派发时记下「谁派的我」（TaskRecord.dispatchedBySessionId，
 * 由 core.dispatchTask 落库）。派发树据此闭包——
 *   Router 会话 R 派的任务 T1（主管型，执行会话 S1），主管在 S1 里再派的下游
 *   子任务 T2（dispatchedBySessionId = S1）。
 * 于是「R 的派发树」= 从 R 出发，沿「派发者会话 → 该任务的执行会话」反复
 * 闭包出来的任务集合。不靠模型自填的 parentId（那可能漏填或填错）。
 *
 * 停的动作与顺序（每个目标任务逐项如实上报）：
 *   1. **先落账本**：状态置 paused。账本优先的理由：worker 可能在收尾时抢先
 *      交完成，而 paused 的出边只有 running/cancelled，没有 completed——迟到的
 *      complete_task 会被状态机当场拒掉。
 *   2. **再断会话**：对执行会话发中断（bridge.interruptTaskSessions，r8 §5
 *      的 agents 形态）。
 *
 * 三条如实录（不静默）：
 *   - 中断失败项在报告里带 detail，HTTP 照常 200（暂停已生效，失败是部分
 *     结果，不是整体失败）；
 *   - 落账本失败的任务**不**断它的会话（状态没停住却把会话打断，会让任务
 *     卡在既没停也没跑完的中间态）——如实报失败；
 *   - 告知 Router 会话失败不影响暂停本身，报告如实带 notifyDetail。
 *
 * 本函数是 entry.ts 与测试共用的同一份组装逻辑（避免测试假件与生产漂移）；
 * 宿主面（账本扫描 / 派发树闭包 / 落账本 / 中断 / 落卡 / 告知）全部注入。
 */

import type { TaskRecord } from '../../shared/types.ts'
import type { NotificationCard, ScopedPauseReport, ScopedPauseTaskResult } from '../../shared/view-contract.ts'
import type { InterruptOutcome } from '../bridge/sessions.ts'

export type { ScopedPauseReport, ScopedPauseTaskResult } from '../../shared/view-contract.ts'

/** 暂停通知的固定措辞（告知 Router：你的活被停了，等用户指示）。 */
export const SCOPED_PAUSE_NOTICE = '已暂停，等用户指示'

/** 扫描账本与派发树闭包、落账本、中断、落卡、告知——全部注入（宿主面）。 */
export interface ScopedPauseDeps {
  /** 当前 Router 会话派发树里的在跑任务（账本扫描 + 派发树闭包）。 */
  targets(routerSessionId: string): Promise<TaskRecord[]>
  /** 账本置 paused（先落账本，再断会话）。 */
  markPaused(taskId: string): Promise<void>
  /** 逐会话中断（bridge.interruptTaskSessions）。 */
  interrupt(sessionIds: string[]): Promise<InterruptOutcome[]>
  /** 逐任务写一张异常卡（用户面：能跳进会话、能取消）。 */
  notifyTask?(input: { taskId: string; title: string; summary: string }): Promise<NotificationCard | undefined>
  /** 告知 Router 会话「已暂停，等用户指示」（模型面：只是告知，不拦派发）。 */
  notifyRouter?(routerSessionId: string, text: string): Promise<void>
  /** 通知失败等非致命问题的日志口（缺席静默）。 */
  logger?: { warn(message: string): void }
}

/** 在跑的任务状态（dispatched/running）——只有这两个值得打断。 */
function isLive(status: TaskRecord['status']): boolean {
  return status === 'dispatched' || status === 'running'
}

/**
 * 派发树闭包：某 Router 会话派出的任务 + 其下游子任务（主管再拆的那一层）。
 *
 * 宿主记的「派发者会话」（dispatchedBySessionId）为准：Router 会话派的直接
 * 子任务记 Router 会话 id；主管在自己会话里派的下游子任务记主管的会话 id。
 * 闭包 = 从 routerSessionId 出发，沿「派发者会话 → 该任务的执行会话」反复
 * 并入新任务。
 *
 * 只保留在跑的（dispatched/running）且已绑执行会话的——其余状态不打扰，
 * 无会话的任务无处可停。
 */
export function scopedPauseTargets(
  records: readonly TaskRecord[],
  routerSessionId: string,
): TaskRecord[] {
  // 派发者会话 → 该派发者派出的任务
  const byDispatcher = new Map<string, TaskRecord[]>()
  for (const record of records) {
    const dispatcher = record.dispatchedBySessionId
    if (dispatcher === undefined || dispatcher === '') continue
    const bucket = byDispatcher.get(dispatcher)
    if (bucket === undefined) byDispatcher.set(dispatcher, [record])
    else bucket.push(record)
  }
  // 闭包：会话集合反复并入（一个派发者可能有多个任务，各带一个执行会话）
  const dispatchers = new Set<string>([routerSessionId])
  const inScope = new Map<string, TaskRecord>()
  for (;;) {
    let grew = false
    for (const dispatcher of [...dispatchers]) {
      for (const record of byDispatcher.get(dispatcher) ?? []) {
        if (inScope.has(record.id)) continue
        inScope.set(record.id, record)
        // 该任务的执行会话也可能是派发者（主管在 S1 里派的下游子任务）
        if (record.sessionId !== undefined && record.sessionId !== '') {
          if (!dispatchers.has(record.sessionId)) {
            dispatchers.add(record.sessionId)
            grew = true
          }
        }
      }
    }
    if (!grew) break
  }
  return [...inScope.values()].filter(
    (record) => isLive(record.status) && typeof record.sessionId === 'string' && record.sessionId !== '',
  )
}

/** 执行作用域紧急暂停：算范围 → 逐个落账本 → 断会话 → 逐张落卡 → 告知 → 逐项报告。 */
export async function runScopedPause(
  deps: ScopedPauseDeps,
  routerSessionId: string,
): Promise<ScopedPauseReport> {
  const targets = await deps.targets(routerSessionId)
  const results: ScopedPauseTaskResult[] = []
  // 先落账本（全部落完再断会话）：任何迟到 complete_task 都被状态机拒掉。
  const paused: ScopedPauseTaskResult[] = []
  for (const target of targets) {
    const sessionId = target.sessionId as string
    try {
      await deps.markPaused(target.id)
      const item: ScopedPauseTaskResult = { taskId: target.id, title: target.title, sessionId, paused: true, interrupted: false }
      paused.push(item)
      results.push(item)
    } catch (error) {
      results.push({
        taskId: target.id,
        title: target.title,
        sessionId,
        paused: false,
        interrupted: false,
        detail: `落账本失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  // 再断会话：只断「账本已停住」的那些（状态没停住却打断会话会留下中间态）。
  const sessionIds = paused.map((item) => item.sessionId)
  const outcomes = sessionIds.length > 0 ? await deps.interrupt(sessionIds) : []
  const outcomeBySession = new Map(outcomes.map((entry) => [entry.sessionId, entry]))
  for (const item of paused) {
    const outcome = outcomeBySession.get(item.sessionId)
    if (outcome === undefined) {
      item.interrupted = false
      item.detail = '中断结果缺失（如实：宿主未返回该会话的中断结果）'
      continue
    }
    if (outcome.outcome === 'accepted') {
      item.interrupted = true
      if (outcome.detail !== undefined) item.detail = outcome.detail
    } else {
      item.interrupted = false
      item.detail = `中断失败：${outcome.detail ?? '原因未记录'}`
    }
  }
  // 逐任务落卡（用户面）：如实带失败明细，不静默。
  if (deps.notifyTask !== undefined) {
    for (const item of results) {
      const summary = item.paused && item.interrupted
        ? `${SCOPED_PAUSE_NOTICE}：任务已暂停（紧急暂停只停当前 Router 派出的活，不影响别的会话）。`
        : `${SCOPED_PAUSE_NOTICE}：任务未完全停下——${item.detail ?? '原因未记录'}`
      try {
        await deps.notifyTask({ taskId: item.taskId, title: item.title, summary })
      } catch (error) {
        deps.logger?.warn(
          `紧急暂停的任务卡写入失败（逐项结果已在响应里如实带出）: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  // 告知 Router 会话（模型面）：只是告知，不拦派发（之后的新派发不受影响）。
  let notified = false
  let notifyDetail: string | undefined
  if (deps.notifyRouter !== undefined) {
    const failedCount = results.filter((item) => !item.paused || !item.interrupted).length
    const text = failedCount > 0
      ? `${SCOPED_PAUSE_NOTICE}：你派出的 ${results.length} 个任务已停下，其中 ${failedCount} 个未完全停下（见任务卡）。请停止推进这些任务，等用户指示。`
      : `${SCOPED_PAUSE_NOTICE}：你派出的 ${results.length} 个任务已停下。请停止推进这些任务，等用户指示。`
    try {
      await deps.notifyRouter(routerSessionId, text)
      notified = true
    } catch (error) {
      notifyDetail = error instanceof Error ? error.message : String(error)
      deps.logger?.warn(`紧急暂停告知 Router 会话失败（暂停本身已生效）: ${notifyDetail}`)
    }
  }
  const failedCount = results.filter((item) => !item.paused || !item.interrupted).length
  const report: ScopedPauseReport = {
    tasks: results,
    pausedCount: results.length - failedCount,
    failedCount,
    notified,
  }
  if (notifyDetail !== undefined) report.notifyDetail = notifyDetail
  return report
}
