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
  sendMessage?(sender: unknown, targetId: string, content: Array<{type: 'text'; text: string}>, options: {signal: AbortSignal}): Promise<string>
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
  signal?: AbortSignal
}

/** 派发方式：spawn 轻装自足 / fork 带父级已完成轮次。 */
const DISPATCH_MODES = ['spawn', 'fork', 'continue'] as const

/** 宿主 dsh-subagent.startActivation 内部第一行就 spec.signal.throwIfAborted()（非可选，
 *  0.2.1 与 0.2.2 皆然），缺 signal 直接 TypeError。优先用调用方 turn 的 exec.signal；
 *  缺席时兜底插件级 controller（同 agent-kernel D2），保证任何宿主下都传真实 AbortSignal。 */
const dispatchLifetime = new AbortController()

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

// 同一宿主内防止并发创建两个主管；成功登记后的归属以持久化分工为准。
const creatingSupervisor = new Set<string>()

function formatTeamAdvice(value: unknown): string {
  const advice = value as {assessment?: unknown; roles?: unknown} | null
  if (!advice || !Array.isArray(advice.roles) || advice.roles.length === 0) {
    throw new CollaborationError('INVALID_INPUT', '首次派主管必须提供组队建议 teamAdvice（规模与复杂度、角色、人数、理由）')
  }
  const assessment = nonEmpty(advice.assessment, '任务规模与复杂度')
  const lines = advice.roles.map(item => {
    if (!item || !Number.isSafeInteger(item.count) || item.count < 1) throw new CollaborationError('INVALID_INPUT', '建议人数须为正整数')
    return `- ${nonEmpty(item.role, '建议角色')} × ${item.count}：${nonEmpty(item.reason, '配置理由')}`
  })
  return ['Router 的组队建议（实际阵容由主管自行决定）：', assessment, ...lines].join('\n')
}

/** 构造 router_dispatch 工具定义。 */
export function buildDispatchTool(deps: DispatchDeps): ToolDefinition {
  return {
    name: 'router_dispatch',
    description:
      '按角色派发子会话（职责注入由代码完成）。传入角色名（须已存在于角色库）、任务内容与派发方式；' +
      '创建成功自动登记一条分工记录（关联子会话、待处理标签）。spawn=轻装新建（默认，材料自足）；' +
      'fork=带父级已完成轮次（子会话能看到你的对话历史，令牌成本更高，确需任务背景时才用）。' +
      '主管使用主任务 taskId：首次必填 teamAdvice；续派只能用 mode=continue 和 expectedChildId，只投递不新建。rootSessionId 必须显式传入。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rootSessionId: { type: 'string', description: '根会话 ID（显式传入，不可推断）' },
        taskId: { type: 'string', description: '归属任务的记录 ID（先用 router_record_create 建任务说明）' },
        role: { type: 'string', description: '角色名（角色库中的名称，如 主管/执行者/调研员/评审员）' },
        task: { type: 'string', description: '给该角色的任务内容（目标、约束、验收条件、材料位置）' },
        teamAdvice: {
          type: 'object', description: '首次派主管必填；角色与人数只是建议，由主管自行决定。', additionalProperties: false,
          required: ['assessment', 'roles'], properties: {
            assessment: { type: 'string', description: '任务规模、复杂度、风险、可并行工作与依赖' },
            roles: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
              required: ['role', 'count', 'reason'], properties: {
                role: { type: 'string' }, count: { type: 'integer', minimum: 1 }, reason: { type: 'string', description: '为何需要该角色及这个人数' },
              } } },
          },
        },
        expectedChildId: { type: 'string', description: '仅 continue 必填：从原主管分工记录取得的确切子会话 ID' },
        mode: {
          type: 'string',
          enum: [...DISPATCH_MODES],
          description: 'spawn/fork 仅新建；continue 仅向核实的原主管投递，失败不换模式',
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
          messageId: { type: 'string', description: '追加任务已投递到原主管的宿主回执' },
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
      const roleName = nonEmpty(a.role, 'role').trim()
      const task = nonEmpty(a.task, 'task')
      const mode = a.mode
      if (mode !== 'spawn' && mode !== 'fork' && mode !== 'continue') {
        throw new CollaborationError('INVALID_INPUT', `mode 必须是 ${DISPATCH_MODES.join(' 或 ')}`)
      }
      if (mode === 'continue' && roleName !== '主管') throw new CollaborationError('INVALID_INPUT', 'continue 仅用于续派原主管')
      if (mode !== 'continue' && a.expectedChildId !== undefined) throw new CollaborationError('INVALID_INPUT', '指定原主管只能用 continue，不能新建')
      const expected = mode === 'continue' ? nonEmpty(a.expectedChildId, 'expectedChildId') : undefined
      if (deps.subagents === undefined) {
        throw new CollaborationError('IO_ERROR', 'subagents 服务不可用：无法创建子会话（检查宿主装载）')
      }
      const parent = (exec as DispatchExec | undefined)?.agent
      if (parent === undefined) {
        throw new CollaborationError('INVALID_INPUT', 'router_dispatch 需要调用方 agent（exec.agent 缺失）')
      }
      const execSignal = (exec as DispatchExec | undefined)?.signal
      const signal = execSignal instanceof AbortSignal ? execSignal : dispatchLifetime.signal
      const key = roleName === '主管' ? JSON.stringify([rootSessionId, taskId]) : undefined
      if (key && creatingSupervisor.has(key)) throw new CollaborationError('INVALID_INPUT', '该任务正在派发主管，请等待派发结果再继续')
      if (key) creatingSupervisor.add(key)
      try {
        let taskBrief = task
        const supervisors = new Set<string>()
        if (key) {
          const rows = await deps.records.list(rootSessionId, { taskId, kind: 'assignment' })
          for (const row of rows) for (const link of row.sessions ?? []) {
            if (link.label === '主管') supervisors.add(link.sessionId)
          }
          if (supervisors.size > 1) throw new CollaborationError('INVALID_INPUT', '存在多个主管，已停止。请核对并消除分工归属冲突；不会创建或投递。')
        }
        if (mode === 'continue') {
          const [childId] = supervisors
          if (!childId || childId !== expected) throw new CollaborationError('INVALID_INPUT', '没有唯一且匹配 expectedChildId 的主管分工，已停止；不得改为新建。')
          const advice = a.teamAdvice !== undefined ? formatTeamAdvice(a.teamAdvice) : ''
          const text = [`同一任务追加要求，优先续用原成员，由你决定是否补人。`, `主任务 taskId：${taskId}`, task, advice].filter(Boolean).join('\n\n')
          try {
            if (!deps.subagents.sendMessage) throw new Error('宿主缺少主管投递能力')
            const messageId = await deps.subagents.sendMessage(parent, childId, [{type:'text', text}], {signal})
            if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('宿主未返回消息编号')
            return {childId, messageId}
          } catch (error) {
            throw new CollaborationError('IO_ERROR', `向原主管 ${childId} 投递未获回执：${String(error)}。核对状态，确实无法继续时请用户确认交接，不要新建团队。`)
          }
        }
        if (key) {
          if (supervisors.size) throw new CollaborationError('INVALID_INPUT', '已登记主管，不能新建；续派必须使用 continue 并指定 expectedChildId。')
          taskBrief = [`主任务 taskId：${taskId}`, task, formatTeamAdvice(a.teamAdvice)].join('\n\n')
        }
        const role = await deps.roles.read(roleName)
        const instruction = composeDispatchInstruction({ role, task: taskBrief, rootSessionId })
        // 创建子会话；失败原样上抛（不落记录）。signal 必传：宿主 startActivation 会
        // spec.signal.throwIfAborted()，缺席即 TypeError（见 dispatchLifetime 说明）。
        const { childId } = await deps.subagents.startActivation({
          provider: mode,
          label: `${role.name}·${taskId}`,
          request: { prompt: [{ type: 'text', text: instruction }], parent, maxDepth: 2 },
          signal,
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
      } finally {
        if (key) creatingSupervisor.delete(key)
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
