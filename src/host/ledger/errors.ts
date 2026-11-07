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
  /** 派发执行失败（会话创建/投递异常）：任务已回 draft/queued 并记账。 */
  | 'dispatch-failed'
  /** dispatch 的 templateId 不在当前启用类型清单（错误带 available 清单）。 */
  | 'template-unavailable'
  /** HTTP 请求体不合法（路由参数校验）。 */
  | 'bad-request'
  /** worker 类型存储：类型名与已有类型重复（规格 §6 重名拒绝）。 */
  | 'template-exists'
  /** worker 类型存储：templateId 不存在。 */
  | 'template-not-found'
  /** worker 类型存储：内置通用 worker 受保护（不可删/不可改/不可禁用）。 */
  | 'builtin-protected'
  /** worker 类型存储：输入不合法（空名字等）。 */
  | 'invalid-input'
  /** C2 类型工具：类型存储未接线（WorkerTypesFace.createRouterType 缺席）。 */
  | 'types-unavailable'
  /** v1.2 熔断器：派发全局冻结（规格 §2；解除仅用户）。 */
  | 'dispatch-frozen'

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
