/**
 * 领域共享类型（计划 Task 1）。
 *
 * 本文件是领域核心：零宿主依赖——不许 import 任何 @deepseek-ai/* 或 node 专有
 * 模块，宿主与浏览器两侧都能安全引用。
 */

/** 角色（权限维度）：router 主持、supervisor 可再派发、worker 只执行。 */
export type RoleKind = 'router' | 'supervisor' | 'worker'

/**
 * worker 生成模式（v1.3 规格 §1；root-config volatile，默认 cache-priority）：
 * - cache-priority：分叉创建（宿主 session/fork 继承来源历史+组合+模型），
 *   三预设统一身份中立超集组合，身份经切换卡进入历史；
 * - minimal-face：插件复刻五步分叉（agents.create+buildForkSeed+worker 预设），
 *   组合维持各角色最小工具面（静态 yml 两行原样）。
 */
export type WorkerSpawnMode = 'cache-priority' | 'minimal-face'

/** 任务状态全集（迁移闭包见 machine.ts 的迁移表）。 */
export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'waiting-user'
  | 'blocked'
  | 'paused'
  | 'review-pending'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** 终态集合：无出边，进入后任何写操作都走非法迁移。 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'cancelled', 'failed'] as const

/** 终态判定。 */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** 验收策略：auto 校验过即完成；supervisor 主管验收；user 用户确认。 */
export type AcceptancePolicy = 'auto' | 'supervisor' | 'user'

/** 任务 + 版本 的引用（派发投递、完成校验都以 taskId+version 关联）。 */
export interface TaskRef {
  taskId: string
  version: number
}

/** 最终交付报告（规格 §7 完成协议的提交字段去掉任务 ID 与执行版本后其余部分）。 */
export interface TaskResult {
  /** 结果摘要。 */
  summary: string
  /** 结果文档引用（result.md 路径等）。 */
  docRef?: string
  /** 交付物引用列表。 */
  deliverables?: string[]
  /** 验收依据。 */
  acceptanceEvidence?: string
  /** 遗留问题。 */
  openIssues?: string[]
  /** 首次完成时间（幂等去重的锚点，由账本写入）。 */
  completedAt?: number
  /**
   * 交付来源（v1.2 规格 §4）：'worker' = 执行者主动 complete_task（缺省，可省）；
   * 'system-judged' = 判定器以独立总结落的结果（完成卡可退回重做）。
   */
  deliveryOrigin?: 'worker' | 'system-judged'
}

/** 任务记录（字段清单照计划 Task 1：规格 §2/§7）。 */
export interface TaskRecord {
  /** 稳定任务 ID，形如 T-001，项目内单调。 */
  id: string
  title: string
  /** 目标。 */
  goal: string
  /** 验收条件。 */
  acceptance: string[]
  /** 约束（含 supplement 追加的补充约束）。 */
  constraints: string[]
  /** 所属项目 ID。 */
  projectId: string
  /** 任务工作目录。 */
  cwd: string
  /** 指派角色。 */
  role: RoleKind
  /** 专业类型（worker 模板 ID）。 */
  templateId?: string
  /** 父任务 ID（谁负责；与依赖关系严格分开）。 */
  parentId?: string
  /** 依赖任务 ID（开始前需哪些交付物）。 */
  dependsOn: string[]
  /** 关联 worker 会话 ID（默认一个任务一个会话）。 */
  sessionId?: string
  status: TaskStatus
  /** 一句话进度（执行者更新；报告阻塞/驳回/派发失败时也落这里）。 */
  progress?: string
  /** 连续派发失败次数（成功派发不重置——它只在失败路径累加；达上限自动 blocked）。 */
  retryCount?: number
  /** 任务书版本，从 1 起，supplement 递增。 */
  docVersion: number
  /** 完成记录（首次完成的快照，幂等去重返回它）。 */
  result?: TaskResult
  acceptancePolicy: AcceptancePolicy
  createdAt: number
  updatedAt: number
}

/** 待答问题记录（Part B 问题浮窗在用；expired = 宿主重启后失效的孤儿问题）。 */
export interface QuestionRecord {
  id: string
  taskId: string
  question: string
  status: 'open' | 'answered' | 'expired'
  answer?: string
  createdAt: number
  answeredAt?: number
}
