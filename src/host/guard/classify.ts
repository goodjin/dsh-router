/**
 * 故障分类器（v1.2 规格 §1，计划 Task B1 接口逐字）。
 *
 * 派发链路失败分两类：
 *   - **infra**：会话创建失败、预设挂载失败、任务书投递失败——系统故障，不进
 *     任务重试预算（不换模板硬撞），直接计入熔断器计数并通知 Router
 *     「系统故障，停止重试」；
 *   - **task**：参数/校验/依赖类拒绝（模板、依赖、角色、预算）——走既有
 *     per-task 重试（3 次封顶自动 blocked，v1.1 语义不动）。
 *
 * 打标方式（侵入最小）：会话桥在会话创建/登记/投递的失败路径用
 * tagInfraFailure 给错误对象打 `failureClass: 'infra'` 标；分类函数读到标就
 * 直接用，没有标时按错误来源兜底——LedgerError 里除 persistence-failed 外
 * 都是域内拒绝（task），完全未知的错误按 infra 计（规格 §2：熔断误报代价 =
 * 用户一键解除，漏报代价 = 失控派发，宁可误报）。
 */

import { LedgerError } from '../ledger/errors.ts'

/** 派发失败的两类。 */
export type DispatchFailureClass = 'infra' | 'task'

/** 分类结果：类别 + 给人看的细节（阶段 + 原始消息）。 */
export interface ClassifiedDispatchFailure {
  class: DispatchFailureClass
  detail: string
}

/** 错误对象上的分类标（bridge 失败路径写入）。 */
const FAILURE_CLASS_KEY = 'failureClass'

/** 打标时记的失败阶段（会话创建/登记/投递），诊断用。 */
const FAILURE_STAGE_KEY = 'failureStage'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 会话桥打标：把宿主调用面（create / attachSession / rename / prompt）的失败
 * 标成 infra。返回同一个错误（原样再抛，只多两个不可枚举无关字段）。
 */
export function tagInfraFailure(error: unknown, stage: string): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  Object.assign(err, { [FAILURE_CLASS_KEY]: 'infra' as const, [FAILURE_STAGE_KEY]: stage })
  return err
}

/** 分类：读到标用标；否则 LedgerError 域内拒绝为 task（持久化失败除外）；未知按 infra。 */
export function classifyDispatchFailure(error: unknown): ClassifiedDispatchFailure {
  const detail = messageOf(error)
  const tagged = (error as { failureClass?: unknown } | null | undefined)?.failureClass
  if (tagged === 'infra' || tagged === 'task') {
    const stage = (error as { failureStage?: unknown } | null | undefined)?.failureStage
    return { class: tagged, detail: typeof stage === 'string' && stage !== '' ? `${stage}: ${detail}` : detail }
  }
  if (error instanceof LedgerError) {
    // 账本域错误都是参数/校验/依赖类拒绝；唯一例外是持久化失败（磁盘/落盘是系统故障）。
    return { class: error.code === 'persistence-failed' ? 'infra' : 'task', detail }
  }
  return { class: 'infra', detail }
}
