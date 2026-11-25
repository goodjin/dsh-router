/**
 * 派发工具 router_dispatch（两级模型，2026-11-24 起：Router 主会话直接担任主管）。
 *
 * 模型传：角色名、任务内容、派发方式（spawn 轻装 / fork 带父级上下文 / continue 追加）、
 * 归属任务（可选）。职责注入由代码完成——读角色 md、把职责说明连同任务、任务 ID 与根会话
 * 拼成初始指令、经宿主 subagents 服务创建子会话（完成通知 delivery:'parent' 由服务包办）、
 * 再自动登记一条分工记录（关联 childId 会话、待处理标签）。模型跳不过去：不调本工具就
 * 没有子会话，职责与根会话的注入是机制保证，不依赖模型自觉。
 *
 * 每次派发都能新建任务并把子会话关联到任务（用户诉求 ①）：
 * - 给了 taskId → 在该任务下派发（一个任务可以挂多个子会话）；
 * - 省略 taskId → 自动新建一条任务（taskTitle 必填；parentTaskId 可选，通常是主任务，
 *   新任务作为它的子任务），子会话随分工记录挂到新任务下。
 * 这样追加/修改需求时，router_record_list(taskId, kind=assignment) 就能查到该发给哪些子会话；
 * continue 模式直接按 expectedChildId 找到它归属的任务投递，并把追加要求拼进该任务描述，
 * 让任务描述始终是「现在要做什么」的权威来源（用户诉求 ③ 的落点之一）。
 *
 * 失败口径：角色不存在/参数坏 → 拒绝且不创建；创建失败 → 错误上抛、不落记录；
 * 创建成功但登记失败 → 返回 childId + recordError（子会话已存在，不能丢编号）。
 */

import { CollaborationError, type RecordStore, type RoleModelCandidate, type RoleStore } from './types.ts'
import type { ToolDefinition } from './tools.ts'
import type { ChildModelRun } from './model-switch.ts'
import { resolveDispatchSequence } from './role-models.ts'

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
      agentOptions?: { provider: string; model: string }
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
  /** 写记录成功后的回调（刷新活跃任务视图缓存）；缺席时不调。失败只告警，不影响派发结果。 */
  afterWrite?: (rootSessionId: string) => Promise<void>
  /** 本次 apply 的子会话候选游标。缺席时仍按序列传 agentOptions，只是不登记切换。 */
  childModelRuns?: Map<string, ChildModelRun>
}

/** 工具执行上下文的最小面（宿主 execute(args, exec) 的 exec）。 */
interface DispatchExec {
  agent?: unknown
  signal?: AbortSignal
}

/** 派发方式：spawn 轻装自足 / fork 带父级已完成轮次 / continue 向既有子会话追加。 */
const DISPATCH_MODES = ['spawn', 'fork', 'continue'] as const

/** 宿主 dsh-subagent.startActivation 内部第一行就 spec.signal.throwIfAborted()（非可选，
 *  0.2.1 与 0.2.2 皆然），缺 signal 直接 TypeError。优先用调用方 turn 的 exec.signal；
 *  缺席时兜底插件级 controller（同 agent-kernel D2），保证任何宿主下都传真实 AbortSignal。 */
const dispatchLifetime = new AbortController()

/** continue 追加要求时拼进任务描述的分隔标记（便于人读、也便于测试断言）。 */
export const APPEND_MARKER = '[追加要求]'

/** 拼装给子会话的初始指令：职责 + 任务 + 任务/根会话 + 报告链要点（纯函数）。 */
export function composeDispatchInstruction(input: {
  role: { name: string; description: string }
  task: string
  taskId: string
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
    `本任务 taskId：${input.taskId}——你的分工记录与工作报告都挂在这个任务下。`,
    `根会话（rootSessionId）：${input.rootSessionId}——之后每次保存工作记录都必须显式带上它，不要用你自己的会话 ID 充当。`,
    '工作资料用记录工具保存（task/assignment/report/summary）；进度、问题与结果按报告链报给上级（worker→Router→用户）。',
    '完成后保存报告记录（标注工作标签），并把结果与产物位置写清楚；不要等待额外系统确认。',
  ].join('\n')
}

/** 构造 router_dispatch 工具定义。 */
export function buildDispatchTool(deps: DispatchDeps): ToolDefinition {
  return {
    name: 'router_dispatch',
    description:
      '按角色派发子会话（职责注入由代码完成）。传入角色名（须已存在于角色库）、任务内容与派发方式；' +
      '创建成功自动登记一条分工记录（关联子会话、待处理标签）。' +
      '归属任务两种给法：给 taskId → 在该任务下派发；省略 taskId → 自动新建一条任务（taskTitle 必填；' +
      'parentTaskId 可选，新任务作为它的子任务，通常传主任务）。' +
      'spawn=轻装新建（默认，材料自足）；fork=带父级已完成轮次（子会话能看到你的对话历史，令牌成本更高）；' +
      'continue=向既有子会话追加要求（expectedChildId 必填，从该任务的分工记录取；追加要求会自动拼进它归属的任务描述）。' +
      'spawn/fork 可带仅这一次的 provider 与 model（必须成对，不写回角色）；continue 不能带。' +
      'rootSessionId 必须显式传入。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rootSessionId: { type: 'string', description: '根会话 ID（显式传入，不可推断）' },
        role: { type: 'string', description: '角色名（角色库中的名称，如 执行者/调研员/评审员）' },
        task: { type: 'string', description: '给该角色的任务内容（目标、约束、验收条件、材料位置）' },
        mode: {
          type: 'string',
          enum: [...DISPATCH_MODES],
          description: 'spawn/fork 新建子会话；continue 向 expectedChildId 指定的既有子会话追加要求，失败不换模式',
        },
        taskId: { type: 'string', description: '归属任务的记录 ID（给了就在该任务下派发；省略则自动新建任务）' },
        taskTitle: { type: 'string', description: '省略 taskId 时必填：自动新建的任务标题' },
        parentTaskId: { type: 'string', description: '省略 taskId 时可选：新任务挂在这个父任务下（通常传主任务）' },
        expectedChildId: { type: 'string', description: '仅 continue 必填：从归属任务的分工记录（assignment.sessions）取得的确切子会话 ID' },
        provider: { type: 'string', description: '仅 spawn/fork 可选：这一次的首选提供方，必须与 model 成对，不写回角色' },
        model: { type: 'string', description: '仅 spawn/fork 可选：这一次的首选模型，必须与 provider 成对，不写回角色' },
      },
      required: ['rootSessionId', 'role', 'task', 'mode'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string' },
          taskId: { type: 'string', description: '本次派发归属（或自动新建）的任务 ID' },
          createdTask: { type: 'boolean', description: '本次是否自动新建了任务' },
          record: {
            type: 'object',
            additionalProperties: false,
            properties: { taskId: { type: 'string' }, recordId: { type: 'string' }, path: { type: 'string' } },
          },
          messageId: { type: 'string', description: 'continue：追加要求已投递到既有子会话的宿主回执' },
          recordError: { type: 'string' },
          model: {
            type: 'object',
            additionalProperties: false,
            description: '实际传给子会话的第一个候选；没配候选时不出现',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
            },
            required: ['provider', 'model'],
          },
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
      const roleName = nonEmpty(a.role, 'role').trim()
      const task = nonEmpty(a.task, 'task')
      const mode = a.mode
      if (mode !== 'spawn' && mode !== 'fork' && mode !== 'continue') {
        throw new CollaborationError('INVALID_INPUT', `mode 必须是 ${DISPATCH_MODES.join(' 或 ')}`)
      }
      if (mode !== 'continue' && a.expectedChildId !== undefined) {
        throw new CollaborationError('INVALID_INPUT', 'expectedChildId 只能配合 continue 使用，新建不需要')
      }
      // 临时指定在读角色、建任务、投递之前拒绝坏形状。continue 上出现任一字段都不改任务正文。
      const override = takeDispatchOverride(a, mode)
      if (deps.subagents === undefined) {
        throw new CollaborationError('IO_ERROR', 'subagents 服务不可用：无法创建子会话（检查宿主装载）')
      }
      const parent = (exec as DispatchExec | undefined)?.agent
      if (parent === undefined) {
        throw new CollaborationError('INVALID_INPUT', 'router_dispatch 需要调用方 agent（exec.agent 缺失）')
      }
      const execSignal = (exec as DispatchExec | undefined)?.signal
      const signal = execSignal instanceof AbortSignal ? execSignal : dispatchLifetime.signal
      // 写后刷新活跃任务视图：子会话与任务关联立刻进上下文段。失败只告警。
      const afterWrite = async (): Promise<void> => {
        if (deps.afterWrite === undefined) return
        try {
          await deps.afterWrite(rootSessionId)
        } catch (error) {
          console.warn('[dsh-router] active-task view refresh failed after dispatch:', error instanceof Error ? error.message : String(error))
        }
      }

      // ── continue：向既有子会话追加要求 ───────────────────────────────────────
      if (mode === 'continue') {
        const childId = nonEmpty(a.expectedChildId, 'expectedChildId')
        // 该子会话归属哪个任务：看分工记录里谁的 sessions 含它。必须唯一，否则不投递。
        const assignments = await deps.records.list(rootSessionId, { kind: 'assignment' })
        const owners = assignments.filter((row) => (row.sessions ?? []).some((link) => link.sessionId === childId))
        if (owners.length === 0) {
          throw new CollaborationError('INVALID_INPUT', `没有登记子会话 ${childId} 的分工记录，已停止；用 router_record_list(kind=assignment) 核对 expectedChildId，不得臆造。`)
        }
        if (owners.length > 1) {
          throw new CollaborationError('INVALID_INPUT', `子会话 ${childId} 登记在多个分工下（${owners.map((r) => r.taskId).join('、')}），归属不唯一，已停止；请先核对并消除冲突。`)
        }
        const owner = owners[0]!
        const taskId = owner.taskId
        // 把追加要求拼进归属任务的描述：任务描述始终是「现在要做什么」的权威来源。
        const owned = await deps.records.read(rootSessionId, taskId, taskId)
        const appended = `${owned.record.body}\n\n${APPEND_MARKER}\n${task}`
        await deps.records.update(rootSessionId, taskId, taskId, { body: appended })
        await afterWrite()
        const text = [
          '同一任务追加要求（已同步进该任务描述），优先续用你已有的上下文；需要补人由 Router 决定。',
          `任务 taskId：${taskId}`,
          task,
        ].join('\n\n')
        try {
          if (!deps.subagents.sendMessage) throw new Error('宿主缺少向子会话投递的能力')
          const messageId = await deps.subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal })
          if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('宿主未返回消息编号')
          return { childId, taskId, messageId }
        } catch (error) {
          throw new CollaborationError('IO_ERROR', `向子会话 ${childId} 投递未获回执：${String(error)}。核对状态，确实无法继续时请用户确认交接。`)
        }
      }

      // ── spawn / fork：新建子会话 ────────────────────────────────────────────
      // 先读角色（无副作用）：角色不存在就什么都不写，不会留下自动建的孤儿任务。
      const role = await deps.roles.read(roleName)
      const sequence = resolveDispatchSequence(role.models, override)
      // 解析归属任务：给了 taskId 用它；省略则自动新建（taskTitle 必填，parentTaskId 可选）。
      let taskId: string
      let createdTask = false
      if (a.taskId !== undefined) {
        taskId = nonEmpty(a.taskId, 'taskId')
        await deps.records.read(rootSessionId, taskId, taskId) // 任务必须存在（read 会核身份与种类）
      } else {
        const title = nonEmpty(a.taskTitle, 'taskTitle（省略 taskId 时必填）')
        const parentTaskId = a.parentTaskId === undefined ? undefined : nonEmpty(a.parentTaskId, 'parentTaskId')
        const created = await deps.records.create(rootSessionId, {
          kind: 'task',
          parentRecordId: parentTaskId,
          title,
          body: task,
          workLabel: '待处理',
        })
        taskId = created.record.taskId
        createdTask = true
      }
      const instruction = composeDispatchInstruction({ role, task, taskId, rootSessionId })
      // 创建子会话；失败原样上抛（不落记录，也不替剩下的候选再循环创建）。
      // signal 必传：宿主 startActivation 会 spec.signal.throwIfAborted()，缺席即 TypeError。
      // 序列为空时 request 不出现 agentOptions 键（D6，保持今天的调用形状）。
      const request: {
        prompt: Array<{ type: 'text'; text: string }>
        parent: unknown
        maxDepth: number
        agentOptions?: { provider: string; model: string }
      } = { prompt: [{ type: 'text', text: instruction }], parent, maxDepth: 2 }
      const first = sequence[0]
      if (first !== undefined) request.agentOptions = { provider: first.provider, model: first.model }
      const { childId } = await deps.subagents.startActivation({
        provider: mode,
        label: `${role.name}·${taskId}`,
        request,
        signal,
        delivery: 'parent',
      })
      if (first !== undefined && deps.childModelRuns !== undefined) {
        const parentSessionId = agentId(parent)
        deps.childModelRuns.set(childId, {
          sequence,
          index: 0,
          phase: 'armed',
          rootSessionId,
          taskId,
          roleName: role.name,
          parentSessionId,
          failures: [],
        })
      }
      const sentModel = first === undefined ? {} : { model: { provider: first.provider, model: first.model } }
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
        await afterWrite()
        return { childId, taskId, createdTask, record: { taskId: saved.record.taskId, recordId: saved.record.id, path: saved.path }, ...sentModel }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          childId,
          taskId,
          createdTask,
          recordError: `子会话已创建（${childId}），但分工记录登记失败：${message}——请用 router_record_create 补记并关联该子会话`,
          ...sentModel,
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

function agentId(agent: unknown): string {
  if (typeof agent === 'object' && agent !== null && typeof (agent as { id?: unknown }).id === 'string') {
    return (agent as { id: string }).id
  }
  return ''
}

/** spawn/fork 的一次性首选。两个都缺才是没有；只出现一个或 trim 后为空则拒绝。continue 上任一字段都拒绝。 */
function takeDispatchOverride(args: Record<string, unknown>, mode: string): RoleModelCandidate | undefined {
  const hasProvider = args.provider !== undefined
  const hasModel = args.model !== undefined
  if (mode === 'continue') {
    if (hasProvider || hasModel) {
      throw new CollaborationError('INVALID_INPUT', 'continue 不能指定 provider 或 model')
    }
    return undefined
  }
  if (!hasProvider && !hasModel) return undefined
  if (!hasProvider || !hasModel) {
    throw new CollaborationError('INVALID_INPUT', 'provider 与 model 必须成对出现')
  }
  if (typeof args.provider !== 'string' || args.provider.trim() === '') {
    throw new CollaborationError('INVALID_INPUT', 'provider 必须是 trim 后的非空字符串')
  }
  if (typeof args.model !== 'string' || args.model.trim() === '') {
    throw new CollaborationError('INVALID_INPUT', 'model 必须是 trim 后的非空字符串')
  }
  return { provider: args.provider.trim(), model: args.model.trim() }
}
