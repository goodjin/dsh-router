/**
 * 账本域统一错误（计划 Task 2：LedgerError 收敛到此）。
 *
 * machine.ts 里先临时定义的 LedgerError 搬进本文件；领域内所有业务校验失败
 * 都抛 LedgerError，调用方按 code 分流，不解析消息文本。
 */

/** 账本域错误码（账本、任务文档与工具角色层共用一套）。 */
export type LedgerErrorCode =
  | 'illegal-transition'
  | 'dependency-cycle'
  | 'stale-version'
  | 'persistence-failed'
  | 'task-not-found'
  | 'doc-exists'
  | 'doc-not-found'
  /** 工具角色层：调用方角色无权使用该工具（计划 Task B3）。 */
  | 'role-forbidden'
  /** 工具角色层：执行类工具操作了不属于调用方会话的任务。 */
  | 'not-task-owner'
  /** 工具角色层：工具名不在注册清单里。 */
  | 'unknown-tool'
  /** 工具角色层：无法从 exec.agent 解析调用方会话 ID（宿主身份字段缺失）。 */
  | 'caller-unresolved'
  /** 问答桥：问题 ID 不存在（HTTP 404）。 */
  | 'question-not-found'
  /** 问答桥：问题已应答，拒绝重复（HTTP 409）。 */
  | 'already-answered'
  /** 问答桥：等待中的问题被中止信号取消。 */
  | 'question-cancelled'
  /** 调度派发被拒：递归深度超限。 */
  | 'depth-exceeded'
  /** 调度派发被拒：依赖命中祖先链（环风险）。 */
  | 'cycle-risk'

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
