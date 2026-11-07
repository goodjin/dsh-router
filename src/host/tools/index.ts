/**
 * 工具角色层（计划 Task B3）。
 *
 * 八个编排工具的薄壳定义：参数经 JSON Schema 校验后转交 RouterCore（根服务实现，
 * 见 src/host/core-types.ts），render 出面向模型的中文内容块。本文件里真正的
 * 逻辑只有两块纯函数：
 *
 *  - assertCallerRole：角色×工具矩阵 + 任务归属（执行类工具要求
 *    task.sessionId === 调用方会话；编排类工具要求非 worker 角色）；
 *  - callerSessionId：exec.agent → sessionId 映射（宿主 Agent.id 即 sessionId，
 *    依据 docs/research/r2-sessions.md §3.2 与宿主源码 dsh-agent-loop
 *    ReactLoopAgent this.id = id、api-session-controller:685 created.agent.id）。
 *
 * 注册走宿主认可的裸定义路径（ctx.tools.register 接受原始 JSON Schema 定义，
 * 依据 docs/research/r1-presets-tools.md §2.2；defineTool 的 DSL 编译产物就是
 * 同款形状）。不 import @deepseek-ai/dsh-tools：它的运行时依赖树需要宿主全套
 * peer 包，插件仓内不可解析。
 */

import type { RoleKind, TaskRecord, TaskStatus } from '../../shared/types.ts'
import type { WorkerTemplate, WorkerTypeSummary } from '../../shared/view-contract.ts'
import { LedgerError } from '../ledger/errors.ts'
import type {
  CompleteTaskInput,
  DispatchTaskInput,
  QueryTasksFilter,
  RouterCore,
  RouterTypeCreateInput,
} from '../core-types.ts'

export type { RouterCore } from '../core-types.ts'
export type {
  CompleteTaskInput,
  DispatchTaskInput,
  QueryTasksFilter,
  RouterTypeCreateInput,
} from '../core-types.ts'

/** 本插件注册的编排工具名全集（ask_user 是宿主原生工具，不在此列）。 */
export type OrchestrationToolName =
  | 'dispatch_task'
  | 'supplement_task'
  | 'query_tasks'
  | 'control_task'
  | 'search_history'
  | 'report_progress'
  | 'complete_task'
  | 'report_blocker'
  | 'list_worker_types'
  | 'create_worker_type'

/** 全集（注册与矩阵校验的基准顺序）。 */
export const TOOL_NAMES: readonly OrchestrationToolName[] = [
  'dispatch_task',
  'supplement_task',
  'query_tasks',
  'control_task',
  'search_history',
  'report_progress',
  'complete_task',
  'report_blocker',
  'list_worker_types',
  'create_worker_type',
]

/** 角色 → 工具白名单（v1.1 C2 起 router 增类型两件；router 无 complete，worker 无派发）。 */
const ROLE_TOOLS: Record<RoleKind, readonly OrchestrationToolName[]> = {
  router: [
    'dispatch_task',
    'supplement_task',
    'query_tasks',
    'control_task',
    'search_history',
    'list_worker_types',
    'create_worker_type',
  ],
  supervisor: [
    'dispatch_task',
    'supplement_task',
    'query_tasks',
    'control_task',
    'search_history',
    'report_progress',
    'complete_task',
  ],
  worker: ['report_progress', 'complete_task', 'report_blocker'],
}

/** 角色的工具白名单（依基准顺序）。 */
export function toolsForRole(role: RoleKind): readonly OrchestrationToolName[] {
  return TOOL_NAMES.filter((name) => ROLE_TOOLS[role].includes(name))
}

/** 任务归属校验要读账本的最小面（同步 get，核心装载后可用）。 */
export interface CallerLedger {
  get(taskId: string): TaskRecord | undefined
}

/** 执行类工具：操作者必须是任务绑定的会话（规格 §7「调用者是当前任务执行者」）。 */
const EXECUTOR_TOOLS: readonly OrchestrationToolName[] = ['report_progress', 'complete_task', 'report_blocker']

/**
 * 角色×工具校验（计划 Task B3 纯函数）。
 *
 * 校验顺序：工具名 → 角色矩阵 → 任务归属（仅执行类；taskId 缺省时跳过归属，
 * 由核心在读取任务时兜底）。「操作自己名下任务」按角色分流：执行类按
 * sessionId 匹配；编排类（supplement/control/dispatch/query）只要求非 worker
 * 角色——任务不记录创建者会话，v1 无跨 Router 隔离。
 */
export function assertCallerRole(
  role: RoleKind,
  tool: OrchestrationToolName,
  callerSessionId: string,
  ledger: CallerLedger,
  taskId?: string,
): void {
  void callerSessionId
  if (!TOOL_NAMES.includes(tool)) {
    throw new LedgerError('unknown-tool', `未知工具: ${tool}`)
  }
  if (!ROLE_TOOLS[role].includes(tool)) {
    throw new LedgerError('role-forbidden', `角色 ${role} 无权使用工具 ${tool}`)
  }
  if (taskId !== undefined && EXECUTOR_TOOLS.includes(tool)) {
    const record = ledger.get(taskId)
    if (record === undefined) {
      throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
    }
    if (record.sessionId !== callerSessionId) {
      throw new LedgerError('not-task-owner', `任务 ${taskId} 不属于会话 ${callerSessionId}`)
    }
  }
}

/** 宿主 exec 的最小形状（只关心身份字段；字段依据见文件头注释）。 */
interface HostExec {
  agent?: { id?: unknown; session?: { id?: unknown } }
}

/**
 * exec.agent → sessionId。宿主 Agent.id 就是 sessionId（ReactLoopAgent 构造时
 * this.id = id，api-session-controller 以 created.agent.id 作 sessionId）；
 * 老样本里也有 agent.session.id 的读法，作兜底。
 */
export function callerSessionId(exec: unknown): string {
  const agent = (exec as HostExec | undefined)?.agent
  const id =
    typeof agent?.id === 'string' && agent.id !== ''
      ? agent.id
      : typeof agent?.session?.id === 'string' && agent.session.id !== ''
        ? agent.session.id
        : undefined
  if (id === undefined) {
    // TODO(宿主契约): 宿主若改变 Agent 身份字段（见 docs/research/r2-sessions.md
    // §3.2），此处映射需跟着更新——取不到即抛，绝不静默把任务挂错会话。
    throw new LedgerError(
      'caller-unresolved',
      '无法从 exec.agent 解析调用方会话 ID（宿主 Agent 身份字段缺失或类型不符）',
    )
  }
  return id
}

/** 工具定义形状（宿主 ctx.tools.register 接受的裸定义的最小面）。 */
export interface ToolDefinition {
  name: OrchestrationToolName
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): { type: 'text'; text: string }[]
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** 状态 → 中文词（render 用）。 */
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

/** 依赖条目的 JSON Schema（taskId 必填，version 仅审计）。 */
const TASK_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', description: '依赖任务 ID（如 T-002）' },
    version: { type: 'number', description: '依赖的任务书版本（可选，仅供审计）' },
  },
  required: ['taskId'],
} as const

/** string 数组参数。 */
function stringArray(description: string) {
  return { type: 'array', items: { type: 'string' }, description } as const
}

/** 任务引用参数。 */
const TASK_ID_PARAM = { type: 'string', description: '任务 ID（如 T-001）' } as const

/** 八个工具的参数与输出 schema（形状照计划 Task B3 清单逐项）。 */
const TOOL_SPECS: Record<
  OrchestrationToolName,
  {
    description: string
    parameters: Record<string, unknown>
    outputSchema: Record<string, unknown>
    run(core: RouterCore, sid: string, args: Record<string, unknown>): Promise<unknown>
    render(args: Record<string, unknown>, value: unknown): string
  }
> = {
  dispatch_task: {
    description:
      '创建任务并派发到独立执行会话。写清目标、验收条件与约束后派发；执行会话收到任务书全文，Router 不阻塞等待。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '任务标题（一行）' },
        goal: { type: 'string', description: '目标：要达成什么、为什么' },
        acceptance: stringArray('验收条件：怎样才算做完'),
        constraints: stringArray('约束：范围、技术选型、禁做事项等'),
        role: { type: 'string', enum: ['supervisor', 'worker'], description: '指派角色：supervisor 可再拆分，worker 只执行' },
        templateId: { type: 'string', description: '专业类型（worker 模板 ID）' },
        parentTaskId: { type: 'string', description: '父任务 ID（主管再拆分时填写）' },
        dependsOn: { type: 'array', items: TASK_REF_SCHEMA, description: '依赖任务：全部完成后本任务才派发' },
        materials: stringArray('输入材料：需求链接、文档路径等'),
      },
      required: ['title', 'goal', 'acceptance', 'role', 'templateId'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string' },
        docPath: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: ['taskId', 'docPath'],
    },
    async run(core, sid, args) {
      const input: DispatchTaskInput = {
        title: String(args.title),
        goal: String(args.goal),
        acceptance: (args.acceptance ?? []) as string[],
        constraints: args.constraints as string[] | undefined,
        role: args.role as 'supervisor' | 'worker',
        templateId: String(args.templateId),
        parentTaskId: args.parentTaskId as string | undefined,
        dependsOn: args.dependsOn as DispatchTaskInput['dependsOn'],
        materials: args.materials as string[] | undefined,
      }
      return core.dispatchTask(sid, input)
    },
    render(args, value) {
      const v = value as { taskId: string; docPath: string; sessionId?: string }
      const parts = [
        `任务 ${v.taskId}「${String(args.title)}」已派发（${STATUS_LABEL.queued}→${STATUS_LABEL.dispatched}）。`,
        `任务书：${v.docPath}`,
        v.sessionId !== undefined ? `执行会话：${v.sessionId}` : '执行会话：待分配',
      ]
      return parts.join('\n')
    },
  },
  supplement_task: {
    description: '给已有任务补充约束：任务书升版并把新版本重投原执行会话。同一任务不要重新派发。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: TASK_ID_PARAM,
        additions: stringArray('补充内容（每条一条约束或要求）'),
      },
      required: ['taskId', 'additions'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { docVersion: { type: 'number' } },
      required: ['docVersion'],
    },
    async run(core, sid, args) {
      return core.supplementTask(sid, String(args.taskId), (args.additions ?? []) as string[])
    },
    render(_args, value) {
      const v = value as { docVersion: number }
      return `任务书已升到 v${v.docVersion}，补充内容已重投执行会话；旧版本作废，完成提交须按 v${v.docVersion}。`
    },
  },
  query_tasks: {
    description: '查询任务短卡：按状态或任务 ID 过滤。路由/主管随时可查全量。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'array', items: { type: 'string' }, description: '按状态过滤（如 running、blocked）' },
        taskId: { type: 'string', description: '只查这一个任务' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { tasks: { type: 'array', items: { type: 'object' } } },
      required: ['tasks'],
    },
    async run(core, _sid, args) {
      const filter: QueryTasksFilter = {}
      if (Array.isArray(args.status) && args.status.length > 0) filter.status = args.status as TaskStatus[]
      if (typeof args.taskId === 'string' && args.taskId !== '') filter.taskId = args.taskId
      return core.queryTasks(Object.keys(filter).length > 0 ? filter : undefined)
    },
    render(_args, value) {
      const cards = (value as { tasks: {
        taskId: string; title: string; status: TaskStatus; role: string; templateId: string;
        progress?: string; sessionId?: string; waitingQuestions: number; docVersion: number
      }[] }).tasks
      if (cards.length === 0) return '当前没有符合条件的任务。'
      return cards
        .map((c) =>
          [
            `${c.taskId}「${c.title}」${STATUS_LABEL[c.status]}`,
            `  角色 ${c.role}/${c.templateId}，任务书 v${c.docVersion}${c.sessionId !== undefined ? `，会话 ${c.sessionId}` : ''}`,
            c.progress !== undefined ? `  进度：${c.progress}` : null,
            c.waitingQuestions > 0 ? `  待用户回答 ${c.waitingQuestions} 个问题` : null,
          ]
            .filter((line) => line !== null)
            .join('\n'),
        )
        .join('\n')
    },
  },
  control_task: {
    description: '控制任务：pause（仅执行中可暂停）、resume（恢复执行）、cancel（取消并通知执行会话停止）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: TASK_ID_PARAM,
        action: { type: 'string', enum: ['pause', 'resume', 'cancel'], description: '控制动作' },
      },
      required: ['taskId', 'action'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string' } },
      required: ['status'],
    },
    async run(core, sid, args) {
      return core.controlTask(sid, String(args.taskId), args.action as 'pause' | 'resume' | 'cancel')
    },
    render(_args, value) {
      const v = value as { status: TaskStatus }
      return `任务状态：${STATUS_LABEL[v.status]}（${v.status}）。`
    },
  },
  search_history: {
    description: '检索历史记忆（项目/全局范围）：完成的任务结果、用户决定、已验证事实都在里面。命中按时间倒序，最多 20 条；命中为空就如实告知用户。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索词' },
        scope: { type: 'string', enum: ['project', 'global'], description: '检索范围' },
      },
      required: ['query', 'scope'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          memoryRef: { type: 'string' },
          snippet: { type: 'string' },
        } } },
        note: { type: 'string' },
      },
      required: ['hits'],
    },
    async run(core, sid, args) {
      return core.searchHistory(sid, String(args.query), args.scope as 'project' | 'global')
    },
    render(_args, value) {
      const v = value as { hits: { memoryRef: string; snippet: string }[]; note?: string }
      if (v.hits.length === 0) return v.note !== undefined ? `未命中（${v.note}）` : '未命中。'
      return v.hits.map((h) => `${h.memoryRef}: ${h.snippet}`).join('\n')
    },
  },
  report_progress: {
    description: '汇报一句话进度（写到任务进展，Router 的活动快照能看到）。长任务应当阶段性汇报。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: TASK_ID_PARAM,
        progress: { type: 'string', description: '一句话进度' },
      },
      required: ['taskId', 'progress'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
    async run(core, sid, args) {
      return core.reportProgress(sid, String(args.taskId), String(args.progress))
    },
    render(_args, value) {
      return (value as { ok: boolean }).ok ? '进度已记录。' : '进度记录失败。'
    },
  },
  complete_task: {
    description:
      '完成协议：申请交付任务。必须带当前任务书版本号（docVersion）；版本不符会被拒。是否完成由验收策略定——auto 即完成，否则进入待验收。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: TASK_ID_PARAM,
        docVersion: { type: 'number', description: '执行所依据的任务书版本（如 1）' },
        summary: { type: 'string', description: '结果摘要' },
        deliverables: stringArray('交付物引用（文件路径等）'),
        acceptanceEvidence: { type: 'string', description: '验收依据（测试、证据）' },
        leftovers: stringArray('遗留问题'),
      },
      required: ['taskId', 'docVersion', 'summary'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accepted: { type: 'boolean' },
        status: { type: 'string' },
        pendingFrom: { type: 'string' },
      },
      required: ['accepted', 'status'],
    },
    async run(core, sid, args) {
      const input: CompleteTaskInput = {
        docVersion: Number(args.docVersion),
        summary: String(args.summary),
        deliverables: args.deliverables as string[] | undefined,
        acceptanceEvidence: args.acceptanceEvidence as string | undefined,
        leftovers: args.leftovers as string[] | undefined,
      }
      return core.completeTask(sid, String(args.taskId), input)
    },
    render(_args, value) {
      const v = value as { accepted: boolean; status: TaskStatus; pendingFrom?: 'supervisor' | 'user' }
      if (v.accepted) return `任务完成（${STATUS_LABEL.completed}）。结果已入档，Router 已收到通知。`
      const who = v.pendingFrom === 'user' ? '用户' : '主管'
      return `提交已收到，任务进入${STATUS_LABEL['review-pending']}——等待${who}验收，请勿重复提交；补充材料用 supplement_task 之外先等验收结论。`
    },
  },
  report_blocker: {
    description: '报告阻塞：任务无法继续时用这个工具，不要用完成工具掩盖失败。写清缺什么、等什么。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: TASK_ID_PARAM,
        reason: { type: 'string', description: '阻塞原因：缺什么、等什么' },
      },
      required: ['taskId', 'reason'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string' } },
      required: ['status'],
    },
    async run(core, sid, args) {
      return core.reportBlocker(sid, String(args.taskId), String(args.reason))
    },
    render(_args, value) {
      return `任务已标记为${STATUS_LABEL.blocked}（${(value as { status: string }).status}）；Router 会把阻塞转告用户。`
    },
  },
  list_worker_types: {
    description:
      '列出当前全部 worker 类型（含停用与来源）：dispatch_task 的 templateId 必须取自这里的启用类型，不要凭记忆或猜测。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { types: { type: 'array', items: { type: 'object' } } },
      required: ['types'],
    },
    async run(core, _sid, _args) {
      return { types: core.listWorkerTypes() }
    },
    render(_args, value) {
      const types = (value as { types: WorkerTypeSummary[] }).types
      if (types.length === 0) return '当前没有任何 worker 类型，先告知调用方配置类型，不要派发。'
      return types
        .map((t) => `${t.templateId}=${t.name}（${t.role === 'supervisor' ? '主管' : 'worker'}，${t.enabled ? '启用' : '停用'}，来源 ${t.origin}）`)
        .join('\n')
    },
  },
  create_worker_type: {
    description:
      '现场创建 worker 类型并立即注册其动态预设：创建成功即可按返回的 templateId 用 dispatch_task 派发。同名类型会被拒绝；presetRegistered=false 表示预设注册失败，此时派发该类型会被拒，须如实告知调用方。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, description: '类型名（如 文档写手；同名已存在会被拒）' },
        description: { type: 'string', description: '一句话说明这个类型做什么' },
        role: { type: 'string', enum: ['worker', 'supervisor'], description: '角色（缺省 worker）' },
        systemPrompt: { type: 'string', minLength: 1, description: '该类型的系统提示词（persona 整段替换）' },
        models: stringArray('允许模型列表（provider/model，有序；首个为该类型会话默认模型）'),
        skills: stringArray('初始技能名清单'),
      },
      required: ['name', 'systemPrompt'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { templateId: { type: 'string' }, presetRegistered: { type: 'boolean' } },
      required: ['templateId', 'presetRegistered'],
    },
    async run(core, sid, args) {
      const input: RouterTypeCreateInput = {
        name: String(args.name),
        description: typeof args.description === 'string' ? args.description : undefined,
        role: args.role as RouterTypeCreateInput['role'],
        systemPrompt: String(args.systemPrompt),
        models: args.models as string[] | undefined,
        skills: args.skills as string[] | undefined,
      }
      return core.createWorkerType(sid, input)
    },
    render(args, value) {
      const v = value as { templateId: string; presetRegistered: boolean }
      const base = `worker 类型「${String(args.name)}」已创建（templateId=${v.templateId}）`
      return v.presetRegistered
        ? `${base}，动态预设已注册：可立即用 dispatch_task 按该 templateId 派发。`
        : `${base}，但动态预设注册失败：当前按该 templateId 派发会被拒（template-unavailable），请如实告知调用方排查该类型的提示词/技能/模型配置。`
    },
  },
}

/** 启用类型清单 → dispatch_task 描述里的清单段（v1.1 Task A4）。 */
export function dispatchTemplateSection(templates: readonly WorkerTemplate[]): string {
  if (templates.length === 0) return '当前没有已启用的专业类型，不要派发，先告知调用方配置类型。'
  const list = templates.map((entry) => `${entry.templateId}=${entry.name}（${entry.description}）`).join('、')
  return `当前可用的专业类型（templateId）只有这些，必须从清单里选，不要虚构（如 general）: ${list}。`
}

/**
 * 按角色产出工具定义子集（只含该角色白名单内的工具；每个 execute 先跑
 * assertCallerRole 再转交核心——白名单在注册层已裁剪，这里是纵深防御）。
 * opts.templates 缺省时读 core.enabledTemplates()（实时清单；类型变更后由
 * 调用方重建工具定义刷新描述——重注册机制在 Part C 接线）。
 */
export function buildToolDefinitions(
  core: RouterCore,
  role: RoleKind,
  opts?: { templates?: readonly WorkerTemplate[] },
): ToolDefinition[] {
  const liveTemplates = (): readonly WorkerTemplate[] => {
    if (opts?.templates !== undefined) return opts.templates
    const face = core as { enabledTemplates?: () => readonly WorkerTemplate[] }
    return typeof face.enabledTemplates === 'function' ? face.enabledTemplates() : []
  }
  return toolsForRole(role).map((name) => {
    const spec = TOOL_SPECS[name]
    return {
      name,
      // dispatch_task 的启用类型清单段是「活的」（v1.1 C2 类型变更刷新的最小
      // 实现）：宿主 dsh-tools 按引用保存注册定义、每次组装模型请求时经
      // schemaOf 投影现读 description，因此 getter 每轮都拿到最新清单——类型
      // 创建/禁用后无需重注册工具行。
      get description(): string {
        return name === 'dispatch_task'
          ? `${spec.description} ${dispatchTemplateSection(liveTemplates())}`
          : spec.description
      },
      parameters: spec.parameters,
      output: {
        schema: spec.outputSchema,
        render: (args: unknown, value: unknown) => [{ type: 'text' as const, text: spec.render(args as Record<string, unknown>, value) }],
      },
      async execute(args: unknown, exec: unknown) {
        const sid = callerSessionId(exec)
        const record = args as Record<string, unknown>
        assertCallerRole(
          role,
          name,
          sid,
          { get: (taskId: string) => core.getTask(taskId) },
          typeof record.taskId === 'string' ? record.taskId : undefined,
        )
        return spec.run(core, sid, record)
      },
    }
  })
}
