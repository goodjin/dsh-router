/**
 * 任务状态机（计划 Task 1）。
 *
 * 迁移表是闭包集合：表内为合法，表外一律非法并抛 LedgerError。终态无出边。
 * LedgerError 本体在 errors.ts（计划 Task 2 收敛点），此处转载以保既有导入路径。
 */

import type { TaskStatus } from '../../shared/types.ts'
import { LedgerError } from './errors.ts'

export { LedgerError } from './errors.ts'

/** 合法迁移表：from → 允许的 to 闭包集合（照计划逐条列出）。 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  // draft/queued → blocked：派发失败达上限的自动封顶（v1.1 规格 §2-4）。
  draft: ['queued', 'blocked', 'cancelled'],
  queued: ['dispatched', 'blocked', 'cancelled'],
  // dispatched → paused：作用域紧急暂停（v1.4）。活着的任务是 dispatched（不是 running），
  // 没有这条边就暂停落不下去。
  // dispatched → completed/review-pending：worker 主动交付（需求 §3 R-1）。常态就是
  // dispatched，缺这两条边时 complete_task 必抛非法迁移——现场账本 0 条 completed 的根因。
  dispatched: ['running', 'completed', 'review-pending', 'paused', 'blocked', 'failed', 'cancelled'],
  running: ['waiting-user', 'blocked', 'paused', 'review-pending', 'completed', 'failed', 'cancelled'],
  'waiting-user': ['running', 'blocked', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  'review-pending': ['completed', 'cancelled'],
  // 终态无出边
  completed: [],
  cancelled: [],
  failed: [],
}

/** 判断 from→to 是否合法迁移。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** 断言 from→to 合法；非法抛 LedgerError('illegal-transition')，消息带 from→to。 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new LedgerError('illegal-transition', `非法状态迁移: ${from} → ${to}`)
  }
}
