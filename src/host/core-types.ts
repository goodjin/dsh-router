/**
 * RouterCore：工具层（src/host/tools）对根服务的调用面（计划 Task B3）。
 *
 * 工具全是薄壳——参数校验后转交这里的对应方法；真正的领域编排（账本、文档、
 * 会话桥、调度、压缩驱动）由根服务（src/entry.ts）组装实现。所有方法第一个
 * 参数是调用方会话 ID（callerSessionId(exec) 的产物），核心按它做归属与
 * workspace 解析。
 */

import type { TaskRecord, TaskStatus } from '../shared/types.ts'
import type { TaskCard } from '../shared/view-contract.ts'

/** dispatch_task 的入参（依赖条目允许带版本；版本当前仅供审计，调度按任务 ID）。 */
export interface DispatchTaskInput {
  title: string
  goal: string
  acceptance: string[]
  constraints?: string[]
  role: 'supervisor' | 'worker'
  templateId: string
  parentTaskId?: string
  dependsOn?: { taskId: string; version?: number }[]
  materials?: string[]
}

/** query_tasks 的过滤条件（都不给 = 全量）。 */
export interface QueryTasksFilter {
  status?: TaskStatus[]
  taskId?: string
}

/** complete_task 的提交体（docVersion 必须等于当前任务版本，旧 worker 迟到提交被拒）。 */
export interface CompleteTaskInput {
  docVersion: number
  summary: string
  deliverables?: string[]
  acceptanceEvidence?: string
  leftovers?: string[]
}

/** 任务编排核心的调用面（工具薄壳只认这个接口，不认识实现）。 */
export interface RouterCore {
  /** 创建任务书并派发到独立会话；返回任务 ID、任务书路径与会话 ID。 */
  dispatchTask(callerSessionId: string, input: DispatchTaskInput): Promise<{ taskId: string; docPath: string; sessionId?: string }>
  /** 补充约束：任务书升版并重投原 worker 会话；返回新版本号。 */
  supplementTask(callerSessionId: string, taskId: string, additions: string[]): Promise<{ docVersion: number }>
  /** 查询任务短卡（只读；编排角色可看全量）。 */
  queryTasks(filter?: QueryTasksFilter): Promise<{ tasks: TaskCard[] }>
  /** 暂停 / 恢复 / 取消一个任务。 */
  controlTask(callerSessionId: string, taskId: string, action: 'pause' | 'resume' | 'cancel'): Promise<{ status: TaskStatus }>
  /** 检索记忆（v1 记忆服务未接线：返回空命中与说明注记）。 */
  searchHistory(callerSessionId: string, query: string, scope: 'project' | 'global'): Promise<{ hits: { memoryRef: string; snippet: string }[]; note?: string }>
  /** worker/主管汇报一句话进度。 */
  reportProgress(callerSessionId: string, taskId: string, progress: string): Promise<{ ok: true }>
  /** 完成协议提交（幂等；policy 非 auto 落 review-pending，pendingFrom 指明待谁验收）。 */
  completeTask(callerSessionId: string, taskId: string, input: CompleteTaskInput): Promise<{ accepted: boolean; status: TaskStatus; pendingFrom?: 'supervisor' | 'user' }>
  /** 报告阻塞。 */
  reportBlocker(callerSessionId: string, taskId: string, reason: string): Promise<{ status: 'blocked' }>
  /** 同步读一个任务（角色校验用；需在核心装载后调用）。 */
  getTask(taskId: string): TaskRecord | undefined
}
