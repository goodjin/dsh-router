/**
 * 账本域统一错误（计划 Task 2：LedgerError 收敛到此）。
 *
 * machine.ts 里先临时定义的 LedgerError 搬进本文件；领域内所有业务校验失败
 * 都抛 LedgerError，调用方按 code 分流，不解析消息文本。
 */

/** 账本域错误码（账本与任务文档共用一套）。 */
export type LedgerErrorCode =
  | 'illegal-transition'
  | 'dependency-cycle'
  | 'stale-version'
  | 'persistence-failed'
  | 'task-not-found'
  | 'doc-exists'
  | 'doc-not-found'

/** 账本域统一错误。 */
export class LedgerError extends Error {
  /** 错误码，调用方以此分流。 */
  code: LedgerErrorCode

  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LedgerError'
    this.code = code
  }
}
