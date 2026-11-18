/**
 * 派发工具 router_dispatch（全自动注入，2026-11-18 起）。
 *
 * 模型只传四个参数：角色名、任务内容、派发方式（spawn 轻装 / fork 带父级上下文）、
 * 归属任务。职责注入由代码完成——读角色 md、把职责说明连同任务与根会话拼成初始
 * 指令、经宿主 subagents 服务创建子会话（完成通知 delivery:'parent' 由服务包办）、
 * 再自动登记一条分工记录（关联 childId 会话、待处理标签）。模型跳不过去：不调
 * 本工具就没有子会话，职责与根会话的注入是机制保证，不依赖模型自觉。
 *
 * 失败口径：角色不存在/参数坏 → 拒绝且不创建；创建失败 → 错误上抛、不落记录；
 * 创建成功但登记失败 → 返回 childId + recordError（子会话已存在，不能丢编号）。
 */

import { CollaborationError, type RecordStore, type RoleStore } from './types.ts'
import type { ToolDefinition } from './tools.ts'

/** 宿主 subagents 服务的最小面（真实服务由 dsh-subagent 提供，base 全局挂载）。 */
export interface SubagentsFace {
  startActivation(request: {
    provider: string
    label?: string
    request: {
      prompt: Array<{ type: 'text'; text: string }>
      parent: unknown
      maxDepth?: number
    }
    signal?: unknown
    delivery: 'parent'
  }): Promise<{ childId: string }>
}

/** 派发工具依赖：记录/角色存储 + 子代理服务（缺席时工具明确报错）。 */
export interface DispatchDeps {
  records: RecordStore
  roles: RoleStore
  subagents?: SubagentsFace
}

/** 工具执行上下文的最小面（宿主 execute(args, exec) 的 exec）。 */
interface DispatchExec {
  agent?: unknown
}

/** 派发方式：spawn 轻装自足 / fork 带父级已完成轮次。 */
const DISPATCH_MODES = ['spawn', 'fork'] as const
type DispatchMode = (typeof DISPATCH_MODES)[number]

/** 拼装给子会话的初始指令：职责 + 任务 + 根会话 + 报告链要点（纯函数）。 */
export function composeDispatchInstruction(input: {
  role: { name: string; description: string }
  task: string
  rootSessionId: string
}): string {
  const duty = input.role.description.trim() === '' ? '（该角色模板未写职责说明）' : input.role.description.trim()
  return [
    `你是轻量团队协作中的「${input.role.name}」。`,
    '',
    '你的职责说明：',
    duty,
    '',
    '本次任务：',
    input.task,
    '',
    `根会话（rootSessionId）：${input.rootSessionId}——之后每次保存工作记录都必须显式带上它，不要用你自己的会话 ID 充当。`,
    '工作资料用记录工具保存（task/assignment/report/summary）；进度、问题与结果按报告链报给上级（worker→主管→Router→用户）。',
    '完成后保存报告记录（标注工作标签），并把结果与产物位置写清楚；不要等待额外系统确认。',
  ].join('\n')
}

/** 构造 router_dispatch 工具定义。 */
export function buildDispatchTool(deps: DispatchDeps): ToolDefinition {
  return {
    name: 'router_dispatch',
    description:
      '按角色派发子会话（职责注入由代码完成）。传入角色名（须已存在于角色库）、任务内容与派发方式；' +
      '创建成功自动登记一条分工记录（关联子会话、待处理标签）。spawn=轻装新建（默认，材料自足）；' +
      'fork=带父级已完成轮次（子会话能看到你的对话历史，令牌成本更高，确需任务背景时才用）。' +
      'rootSessionId 是整棵任务树的根会话，必须显式传入。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rootSessionId: { type: 'string', description: '根会话 ID（显式传入，不可推断）' },
        taskId: { type: 'string', description: '归属任务的记录 ID（先用 router_record_create 建任务说明）' },
        role: { type: 'string', description: '角色名（角色库中的名称，如 主管/执行者/调研员/评审员）' },
        task: { type: 'string', description: '给该角色的任务内容（目标、约束、验收条件、材料位置）' },
        mode: {
          type: 'string',
          enum: [...DISPATCH_MODES],
          description: '派发方式：spawn=轻装新建（默认）；fork=带父级已完成轮次（成本更高，确需背景才用）',
        },
      },
      required: ['rootSessionId', 'taskId', 'role', 'task', 'mode'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string' },
          record: {
            type: 'object',
            additionalProperties: false,
            properties: { taskId: { type: 'string' }, recordId: { type: 'string' }, path: { type: 'string' } },
          },
          recordError: { type: 'string' },
        },
        required: ['childId'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: unknown): Promise<unknown> {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new CollaborationError('INVALID_INPUT', '参数必须是对象')
      }
      const a = args as Record<string, unknown>
      const rootSessionId = nonEmpty(a.rootSessionId, 'rootSessionId')
      const taskId = nonEmpty(a.taskId, 'taskId')
      const roleName = nonEmpty(a.role, 'role')
      const task = nonEmpty(a.task, 'task')
      const mode = a.mode
      if (typeof mode !== 'string' || !(DISPATCH_MODES as readonly string[]).includes(mode)) {
        throw new CollaborationError('INVALID_INPUT', `mode 必须是 ${DISPATCH_MODES.join(' 或 ')}`)
      }
      const provider: DispatchMode = mode as DispatchMode
      // 职责来自角色库（代码读取，不依赖模型转述）。
      const role = await deps.roles.read(roleName)
      if (deps.subagents === undefined) {
        throw new CollaborationError('IO_ERROR', 'subagents 服务不可用：无法创建子会话（检查宿主装载）')
      }
      const parent = (exec as DispatchExec | undefined)?.agent
      if (parent === undefined) {
        throw new CollaborationError('INVALID_INPUT', 'router_dispatch 需要调用方 agent（exec.agent 缺失）')
      }
      const instruction = composeDispatchInstruction({ role, task, rootSessionId })
      // 创建子会话；失败原样上抛（不落记录）。
      const { childId } = await deps.subagents.startActivation({
        provider,
        label: `${role.name}·${taskId}`,
        request: { prompt: [{ type: 'text', text: instruction }], parent, maxDepth: 2 },
        delivery: 'parent',
      })
      // 登记分工记录；失败不丢 childId（返回 recordError，让模型补记）。
      try {
        const saved = await deps.records.create(rootSessionId, {
          kind: 'assignment',
          taskId,
          title: `${role.name}：${task.slice(0, 40)}`,
          body: instruction,
          workLabel: '待处理',
          sessions: [{ sessionId: childId, label: role.name }],
        })
        return { childId, record: { taskId: saved.record.taskId, recordId: saved.record.id, path: saved.path } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          childId,
          recordError: `子会话已创建（${childId}），但分工记录登记失败：${message}——请用 router_record_create 补记并关联该子会话`,
        }
      }
    },
  }
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CollaborationError('INVALID_INPUT', `${what} 必须是非空字符串`)
  }
  return value
}
