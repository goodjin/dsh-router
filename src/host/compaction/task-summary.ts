/**
 * 任务描述装配（2026-11-11 用户裁定流程）：Router 会话压缩时，用账本里
 * 「当前会话派发、仍在推进」的任务描述清单替换自上一检查点以来的聊天段——不调 LLM。
 *
 * 纯函数、零宿主依赖：输入 TaskRecord 数组，输出替换文本。排序按 id（确定性：
 * 同一份账本多次装配字节相同，检查点可复现）。终态任务不进清单——完成/取消/
 * 失败的讨论过程不再保留，历史里只留仍在推进的事；别的会话派发的任务不归本会话。
 *
 * 类型策略：本仓 node_modules 没有 dsh-compaction* 包（只在宿主运行时出现），
 * 所以这里不 import 宿主包，摘要信封按结构对齐官方 summarize 返回形状。
 */

import type { TaskRecord } from '../../shared/types.ts'
import { isTerminal } from '../../shared/types.ts'

/** 无活跃任务时的兜底句（引擎要求摘要至少一块非空文本）。 */
const IDLE_LINE = '当前没有进行中的任务。'

/** 一条任务的描述行（紧凑单行；与任务简述 taskBrief 同一信息密度）。 */
function describeTask(record: TaskRecord): string {
  const parts = [`【${record.status}】${record.id}「${record.title}」目标：${record.goal}`]
  if (record.acceptance.length > 0) parts.push(`验收要点：${record.acceptance.join('；')}`)
  if (record.constraints.length > 0) parts.push(`约束：${record.constraints.join('；')}`)
  return parts.join('；')
}

/**
 * 装配任务描述清单文本：终态剔除、按 id 升序各一行；空集给兜底句。
 */
export function assembleTaskSummary(records: readonly TaskRecord[]): string {
  const ordered = records
    .filter((record) => !isTerminal(record.status))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (ordered.length === 0) return IDLE_LINE
  return ordered.map(describeTask).join('\n')
}

/**
 * 选出该会话派发的任务（终态与否交给装配函数裁决）。「别的会话派的不归我」
 * 定在这一个选择器里；真引擎与测试共用。
 */
export function selectDispatchedBy(records: readonly TaskRecord[], sessionId: string): TaskRecord[] {
  return records.filter((record) => record.dispatchedBySessionId === sessionId)
}

/** 摘要信封（结构对齐宿主 summarize 返回形状；provider/model 必填非空）。 */
export interface TaskSummaryEnvelope {
  summary: { type: 'text'; text: string }[]
  provider?: string
  model?: string
}

/** summarize 钩子的入参形状（只取本钩子消费的字段）。 */
export interface SummaryAgent {
  session?: { id?: string }
}

/** 账本来源：异步取全量记录；取不到（缺面/失败）返回 undefined 走回退。 */
export type TaskRecordSource = () => Promise<readonly TaskRecord[] | undefined>

/** 默认 summarize 回退（真引擎里是官方 summarizeWithLlm 行为；测试里注入替身）。 */
export type SummaryFallback = (
  input: unknown,
  agent: unknown,
  signal: unknown,
) => Promise<TaskSummaryEnvelope | undefined>

/**
 * 账本驱动的 summarize 判断（真引擎与测试驱动器共用同一套逻辑）：
 * 该会话派发且有活跃任务 → 装配描述文本，provider/model 标「router-ledger」/
 * 「task-summary」，不置 llmStreamCall（描述装配不调 LLM）；
 * 账本不可用 / 无活跃任务 / 会话标识缺失 → 回退默认 summarize。
 */
export async function taskSummarySummarize(
  records: readonly TaskRecord[] | undefined,
  fallback: SummaryFallback,
  input: unknown,
  agent: SummaryAgent,
  signal: unknown,
): Promise<TaskSummaryEnvelope | undefined> {
  const sessionId = agent?.session?.id
  if (records === undefined || sessionId === undefined) return fallback(input, agent, signal)
  const mine = selectDispatchedBy(records, sessionId)
  if (!mine.some((record) => !isTerminal(record.status))) return fallback(input, agent, signal)
  return {
    summary: [{ type: 'text', text: assembleTaskSummary(mine) }],
    provider: 'router-ledger',
    model: 'task-summary',
  }
}
