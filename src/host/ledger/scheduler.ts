/**
 * 依赖解锁与调度就绪判定（计划 Task 4）。
 *
 * Scheduler 只做判定，不做派发：readyTasks 给出当前可投递的任务，
 * onCompleted 在任务完成后给出新解锁的任务（供服务端驱动，Part B 接线），
 * dispatchGuard 在派发前把关角色权限、递归深度与依赖环风险。
 */

import type { RoleKind, TaskRecord } from '../../shared/types.ts'
import type { TaskLedger } from './store.ts'

/** dispatchGuard 的派发方视角：会话角色 + 当前任务位置 + 深度。 */
export interface DispatchParent {
  sessionIdRole: RoleKind
  /** 派发方当前所处的任务 ID（用于祖先链环检测）。 */
  parentTaskId?: string
  /** 派发方任务的当前深度（根为 0）。 */
  depth: number
}

/** dispatchGuard 的目标视角；dependsOn 缺省时跳过环检测。 */
export interface DispatchTarget {
  role: RoleKind
  dependsOn?: string[]
}

/** 派发判定结果。 */
export type DispatchVerdict = { ok: true } | { ok: false; code: 'depth-exceeded' | 'role-forbidden' | 'cycle-risk' }

/** 调度就绪判定器。 */
export class Scheduler {
  private ledger: TaskLedger
  /** 主管递归派发的最大深度（根任务深度 1 的话就是 maxDepth 层）。 */
  private maxDepth: number
  /** 按 worker 类型的并发上限（Part B 派发队列消费；判定层暂不裁剪）。 */
  private concurrency: Record<string, number>

  constructor(ledger: TaskLedger, opts: { maxDepth: number; concurrency: Record<string, number> }) {
    this.ledger = ledger
    this.maxDepth = opts.maxDepth
    this.concurrency = opts.concurrency
  }

  /** 依赖是否全部 completed（依赖不存在视为未满足，不就绪）。 */
  private depsComplete(task: TaskRecord, byId: Map<string, TaskRecord>): boolean {
    return task.dependsOn.every((depId) => byId.get(depId)?.status === 'completed')
  }

  /** 当前可投递的任务：queued 且 dependsOn 全 completed，按创建序。 */
  async readyTasks(): Promise<TaskRecord[]> {
    const all = await this.ledger.listAll()
    const byId = new Map(all.map((t) => [t.id, t]))
    return all.filter((t) => t.status === 'queued' && this.depsComplete(t, byId))
  }

  /** 任务完成后新解锁的任务（依赖它、已 queued、其余依赖也全部完成），按创建序。 */
  async onCompleted(taskId: string): Promise<TaskRecord[]> {
    const all = await this.ledger.listAll()
    const byId = new Map(all.map((t) => [t.id, t]))
    return all.filter((t) => t.status === 'queued' && t.dependsOn.includes(taskId) && this.depsComplete(t, byId))
  }

  /**
   * 派发把关，判定顺序：权限（worker 禁止派发）→ 结构（依赖命中祖先链即环风险）
   * → 容量（新任务深度 parent.depth+1 超 maxDepth）。环先于深度：结构性错误
   * 与深度无关，无论哪层都不该派。祖先链走账本的同步 get，需在账本已装载
   * （先 await 过任一账本方法）后调用。
   */
  dispatchGuard(parent: DispatchParent, target: DispatchTarget): DispatchVerdict {
    if (parent.sessionIdRole === 'worker') {
      return { ok: false, code: 'role-forbidden' }
    }
    if (target.dependsOn !== undefined && target.dependsOn.length > 0 && parent.parentTaskId !== undefined) {
      const ancestors = new Set<string>()
      let cursor: string | undefined = parent.parentTaskId
      while (cursor !== undefined) {
        ancestors.add(cursor)
        cursor = this.ledger.get(cursor)?.parentId
      }
      if (target.dependsOn.some((depId) => ancestors.has(depId))) {
        return { ok: false, code: 'cycle-risk' }
      }
    }
    if (parent.depth + 1 > this.maxDepth) {
      return { ok: false, code: 'depth-exceeded' }
    }
    return { ok: true }
  }
}
