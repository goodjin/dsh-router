/**
 * 任务状态机（计划 Task 1）。
 *
 * 迁移表是闭包集合：表内为合法，表外一律非法并抛 LedgerError。终态无出边。
 * LedgerError 暂住本文件——计划把它收敛到 errors.ts 排在 Task 2，届时搬移。
 */

import type { TaskStatus } from '../../shared/types.ts'

/** 账本域错误码（随实现逐步扩充）。 */
export type LedgerErrorCode = 'illegal-transition'

/** 账本域统一错误：业务校验失败全部抛它，调用方按 code 分流。 */
export class LedgerError extends Error {
  /** 错误码，调用方以此分流而不是解析消息文本。 */
  code: LedgerErrorCode

  constructor(code: LedgerErrorCode, message: string) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
  }
}

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
