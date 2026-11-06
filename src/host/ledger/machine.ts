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
  draft: ['queued', 'cancelled'],
  queued: ['dispatched', 'cancelled'],
  dispatched: ['running', 'blocked', 'failed', 'cancelled'],
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
