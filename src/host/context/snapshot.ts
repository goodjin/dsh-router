/**
 * 活动账本快照（计划 Task B5）——纯函数。
 *
 * Router 每轮实际可见的「全部未结束任务短卡」（规格 §4）：字段是任务 ID/标题、
 * 目标与关键验收、worker 类型/会话 ID、状态/一句话进度、依赖、待回答事项、
 * 最新补充约束。终态里 completed/cancelled 剔除；failed（失败待处理）按规格
 * §4「失败待处理」保留在活动上下文里——但 failed 且无会话的空壳（v1.1 规格
 * §3.7 空壳清理）不进快照：它没有执行会话可恢复，Router 只能从归档追溯。
 * 超过 maxCards 时全部任务统一转紧凑单行卡——缩短但不丢弃（规格 §4）。
 */

import { type TaskRecord, type TaskStatus } from '../../shared/types.ts'

/** 快照渲染选项。 */
export interface SnapshotOptions {
  /** 活动卡上限（超出即全表转紧凑卡，可配置防撑爆窗口）。 */
  maxCards: number
  /** 精简长期记忆摘要（渲染在活动卡之前；缺省无此节）。 */
  memoryBrief?: string
  /** 任务 ID → 待答问题数（缺省不渲染待答行）。 */
  openQuestions?: Record<string, number>
}

/** 状态 → 中文词。 */
const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: '草稿',
  queued: '排队中',
  dispatched: '已派发',
  running: '执行中',
  'waiting-user': '等待用户',
  blocked: '受阻',
  paused: '已暂停',
  'review-pending': '待验收',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
}

/**
 * 快照里保留的任务：completed / cancelled 剔除；failed 只有绑定了执行会话的
 * 才保留（失败待处理），无会话的 failed 空壳不进快照（v1.1 规格 §3.7）。
 */
function isSnapshotVisible(record: TaskRecord): boolean {
  if (record.status === 'completed' || record.status === 'cancelled') return false
  if (record.status === 'failed' && record.sessionId === undefined) return false
  return true
}

/** 完整短卡（多行）。 */
function fullCard(record: TaskRecord, waiting: number | undefined): string {
  const lines = [
    `[${record.id}] ${record.title} — ${STATUS_LABEL[record.status]}（${record.status}）`,
    `  目标：${record.goal}`,
  ]
  if (record.acceptance.length > 0) {
    lines.push(`  验收：${record.acceptance.join('；')}`)
  }
  const identity = [`类型 ${record.role}${record.templateId !== undefined ? `/${record.templateId}` : ''}`]
  if (record.sessionId !== undefined) identity.push(`会话 ${record.sessionId}`)
  identity.push(`任务书 v${record.docVersion}`)
  lines.push(`  ${identity.join('，')}`)
  if (record.progress !== undefined && record.progress !== '') {
    lines.push(`  进度：${record.progress}`)
  }
  if (record.dependsOn.length > 0) {
    lines.push(`  依赖：${record.dependsOn.join('、')}`)
  }
  if (waiting !== undefined && waiting > 0) {
    lines.push(`  待回答：${waiting} 个问题`)
  }
  const latestConstraint = record.constraints[record.constraints.length - 1]
  if (latestConstraint !== undefined) {
    lines.push(`  最新补充约束：${latestConstraint}`)
  }
  return lines.join('\n')
}

/** 紧凑单行卡（超容量模式，一张不丢）。 */
function compactCard(record: TaskRecord, waiting: number | undefined): string {
  const parts = [
    `[${record.id}] ${record.title}`,
    STATUS_LABEL[record.status],
    `v${record.docVersion}`,
  ]
  if (record.sessionId !== undefined) parts.push(`会话 ${record.sessionId}`)
  if (record.progress !== undefined && record.progress !== '') parts.push(record.progress)
  if (waiting !== undefined && waiting > 0) parts.push(`待答 ${waiting} 问`)
  if (record.dependsOn.length > 0) parts.push(`依赖 ${record.dependsOn.join('、')}`)
  return parts.join(' | ')
}

/** 渲染活动账本快照文本（systemPrompt.context 的 text 缓存源）。 */
export function renderLedgerSnapshot(tasks: TaskRecord[], options: SnapshotOptions): string {
  const visible = tasks.filter(isSnapshotVisible)
  if (visible.length === 0) {
    return options.memoryBrief !== undefined && options.memoryBrief !== ''
      ? `## 长期记忆摘要\n\n${options.memoryBrief}\n\n## 活动任务\n\n当前没有未结束任务。\n`
      : '当前没有未结束任务。所有任务均已完成或取消，可从归档检索。'
  }
  const compact = visible.length > options.maxCards
  const sections: string[] = []
  if (options.memoryBrief !== undefined && options.memoryBrief !== '') {
    sections.push(`## 长期记忆摘要\n\n${options.memoryBrief}`)
  }
  const header = compact
    ? `## 活动任务（${visible.length} 项，超上限 ${options.maxCards}，已切换单行紧凑模式）`
    : `## 活动任务（${visible.length} 项）`
  const cards = visible.map((record) => {
    const waiting = options.openQuestions?.[record.id]
    return compact ? compactCard(record, waiting) : fullCard(record, waiting)
  })
  sections.push(`${header}\n\n${cards.join('\n\n')}`)
  return sections.join('\n\n')
}
