/**
 * 轻量协作上下文构建 buildCollaborationContext（计划 Task 2A，Layer 2）。
 *
 * 纯函数：只依据 {sessionId, dataDir} 产出一段面向模型的文本，无任何 DB/文件系统/宿主
 * 访问，不含时间戳、动态账本或推断归属。dataDir 是插件数据根，按正常路径拼接一次
 * collaboration 子目录（仅 node:path，宿主侧）。报告的是当前会话 sessionId（不是推断的
 * root）；rootSessionId 须由父级会话显式提供，缺失时提示模型向上级询问。当前会话 ID
 * 不会被改写成（臆造的）root。不同子会话只改变所报告的当前会话，不改变 root 的缺省语义。
 */

import { join } from 'node:path'

import { CollaborationError } from './types.ts'
import { COLLABORATION_TOOL_NAMES } from './tools.ts'

/** 协作目录名（与 RecordStore/RoleStore 的命名空间一致；只拼一次）。 */
const COLLABORATION_DIR = 'collaboration'

export interface CollaborationContextInput {
  /** 当前会话 ID（原样报告，不当作 root 推断）。 */
  sessionId: string
  /** 插件数据根，内部拼一次 collaboration 子目录。 */
  dataDir: string
}

/** 非空字符串校验（坏入参直接拒绝，不产出误导文本）。 */
function requireNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CollaborationError('INVALID_INPUT', `${what} 必须是非空字符串`)
  }
  return value
}

/**
 * 构建协作上下文文本。纯函数：相同入参恒等输出，可安全在渲染期重复调用。
 */
export function buildCollaborationContext(input: CollaborationContextInput): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CollaborationError('INVALID_INPUT', 'input 必须是对象')
  }
  const sessionId = requireNonEmptyString(input.sessionId, 'sessionId')
  const dataDir = requireNonEmptyString(input.dataDir, 'dataDir')
  // 正常路径拼接一次协作子目录；node:path 仅做路径计算，不触碰文件系统。
  const collaborationDir = join(dataDir, COLLABORATION_DIR)
  const toolList = COLLABORATION_TOOL_NAMES.join(', ')

  return [
    '当前会话 ID：' + sessionId,
    '注意：这是当前会话的 ID，不是根会话（root）ID，不要把它当作 rootSessionId 使用。',
    '',
    '协作记录目录：' + collaborationDir,
    '所有工作记录与角色模板都存在该目录下的 JSON 文件里，文件是唯一事实源。',
    '',
    '根会话（rootSessionId）必须由父级会话随每次操作显式传入；',
    '如果你拿不到 rootSessionId，请向上级会话询问，不要自行推断或猜测。',
    '',
    '可用的协作工具（共 ' + String(COLLABORATION_TOOL_NAMES.length) + ' 个）：' + toolList,
    '记录种类：task（任务说明）、assignment（分工记录）、report（工作报告）、summary（汇总报告）。',
  ].join('\n')
}
