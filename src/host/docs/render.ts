/**
 * 任务书渲染（计划 Task 3）。
 *
 * 纯函数：TaskRecord + 输入材料 → 纯 Markdown 任务书（无代码块）。
 * 章节与顺序照计划固定九节：目标 / 背景与范围 / 约束 / 验收条件 / 指派 /
 * 父任务与依赖 / 输入材料 / 来源引用 / 文档版本。
 */

import type { TaskRecord } from '../../shared/types.ts'

/** 任务书渲染的附加输入（都可缺省，缺省渲染「无」占位）。 */
export interface TaskBookInputs {
  /** 输入材料（需求链接、文档路径等）。 */
  materials?: string[]
  /** 记忆引用（项目约定、相关记忆条目）。 */
  memoryRefs?: string[]
  /** 来源引用（来源会话与消息）。 */
  sourceRef?: string
}

/** 无序列表行。 */
function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

/** 列表或「无」占位。 */
function listOrNone(items: string[]): string {
  return items.length > 0 ? bullets(items) : '无'
}

/** 渲染任务书全文。 */
export function renderTaskBook(task: TaskRecord, inputs: TaskBookInputs = {}): string {
  const materialLines = [
    ...(inputs.materials ?? []).map((m) => `- ${m}`),
    ...(inputs.memoryRefs ?? []).map((m) => `- 记忆引用：${m}`),
  ]
  const lines = [
    `# 任务书 ${task.id}：${task.title}`,
    '',
    '## 目标',
    task.goal,
    '',
    '## 背景与范围',
    `- 所属项目：${task.projectId}`,
    `- 工作目录：${task.cwd}`,
    '',
    '## 约束',
    listOrNone(task.constraints),
    '',
    '## 验收条件',
    listOrNone(task.acceptance),
    '',
    '## 指派',
    `- 角色：${task.role}`,
    `- 专业类型：${task.templateId ?? '未指定'}`,
    '',
    '## 父任务与依赖',
    `- 父任务：${task.parentId ?? '无'}`,
    `- 依赖：${task.dependsOn.length > 0 ? task.dependsOn.join('、') : '无'}`,
    '',
    '## 输入材料',
    materialLines.length > 0 ? materialLines.join('\n') : '无',
    '',
    '## 来源引用',
    inputs.sourceRef ?? '无',
    '',
    '## 文档版本',
    `v${task.docVersion}`,
    '',
  ]
  return lines.join('\n')
}
