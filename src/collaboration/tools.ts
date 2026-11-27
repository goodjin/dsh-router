/**
 * 轻量团队协作模型工具 buildCollaborationTools（派发工具版，2026-11-18 起）。
 *
 * 八个面向模型的工具：七条存储薄壳（RecordStore/RoleStore）+ 一条派发工具
 * router_dispatch（职责注入由代码完成，见 dispatch.ts）。参数经原生 JSON Schema
 * 描述，execute 在边界守卫后转交存储/服务，CollaborationError 原样上抛（宿主据
 * code 收敛为 isError），render 输出与返回值一致的 JSON 文本。
 *
 * 依赖 ./types.ts 与 ./dispatch.ts：不 import 旧 ToolDefinition/RouterCore。
 * 存储薄壳不读 exec；router_dispatch 读 exec.agent（宿主传入的调用方）。
 */

import { CollaborationError, type RecordDraft, type RecordPatch, type RecordQuery, type RecordStore, type RoleStore } from './types.ts'
import { buildDispatchTool, type RoleDutyBinder, type SubagentsFace } from './dispatch.ts'
import type { ChildModelRun } from './model-switch.ts'
import { buildCompactTool } from './compact.ts'

/** 面向模型的一个内容块（与宿主工具输出内容块同形）。 */
export interface ToolContentBlock {
  type: 'text'
  text: string
}

/**
 * 最小结构化工具定义：宿主 ctx.tools.register 接受的裸定义形状。本地自定义，不复用
 * 旧 core 的 ToolDefinition（那条路径会拖入遗留依赖）。
 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ToolContentBlock[]
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/* ───────────────────────── 边界守卫（在访问属性 / 调存储前拦坏值） ───────────────────────── */

/** 参数包装必须是非空、非数组的对象，否则 INVALID_INPUT。 */
function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CollaborationError('INVALID_INPUT', `${what} 必须是对象`)
  }
  return value as Record<string, unknown>
}

/** 可选对象字段：省略合法；存在则必须是非空、非数组的对象。 */
function optionalObject(value: unknown, what: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return asObject(value, what)
}

/** 必需原始字符串：非空字符串，否则 INVALID_INPUT。 */
function asNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CollaborationError('INVALID_INPUT', `${what} 必须是非空字符串`)
  }
  return value
}

/* ───────────────────────── 复用的 JSON Schema 片段 ───────────────────────── */

const RECORD_KINDS = ['task', 'assignment', 'report', 'summary'] as const
const WORK_LABELS = ['待处理', '进行中', '受阻', '已报告'] as const

/** 关联会话条目（sessions 元素）。 */
const SESSION_LINK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', description: '关联会话 ID' },
    label: { type: 'string', description: '展示标签' },
  },
  required: ['sessionId', 'label'],
}

/** 成果引用条目（artifacts 元素）。 */
const ARTIFACT_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    location: { type: 'string', description: '成果位置' },
    label: { type: 'string', description: '展示标签' },
  },
  required: ['location', 'label'],
}

/** 工作记录本体的 schema（存储返回值里 record 的形状）。 */
const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '记录编号' },
    taskId: { type: 'string', description: '归属任务 ID' },
    rootSessionId: { type: 'string', description: '根会话 ID' },
    kind: { type: 'string', enum: [...RECORD_KINDS], description: '记录种类' },
    title: { type: 'string', description: '标题' },
    body: { type: 'string', description: '正文' },
    workLabel: { type: 'string', enum: [...WORK_LABELS], description: '工作标签' },
    parentRecordId: { type: 'string', description: '父记录编号' },
    sessions: { type: 'array', description: '关联会话', items: SESSION_LINK_SCHEMA },
    artifacts: { type: 'array', description: '成果引用', items: ARTIFACT_REF_SCHEMA },
    createdAt: { type: 'number', description: '创建时间戳' },
    updatedAt: { type: 'number', description: '更新时间戳' },
  },
  required: ['id', 'taskId', 'rootSessionId', 'kind', 'title', 'body', 'createdAt', 'updatedAt'],
}

/** 保存结果：记录与实际落盘路径。 */
const SAVED_RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    record: RECORD_SCHEMA,
    path: { type: 'string', description: '落盘路径' },
  },
  required: ['record', 'path'],
}

/** 角色候选模型。 */
const ROLE_MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', description: '提供方 id' },
    model: { type: 'string', description: '模型 id' },
  },
  required: ['provider', 'model'],
}

/** 角色模板 schema。models 可选：缺省表示没有候选围栏。 */
const ROLE_TEMPLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '角色 ID（=md 文件名；稳定，不随名称变）' },
    name: { type: 'string', description: '角色名（可改；全局唯一）' },
    description: { type: 'string', description: '职责说明（不含候选围栏）' },
    models: {
      type: 'array',
      description: '有序候选模型。省略表示文件里没有围栏。',
      items: ROLE_MODEL_SCHEMA,
    },
  },
  required: ['id', 'name', 'description'],
}

/* ───────────────────────── 工具定义构建 ───────────────────────── */

/** render：输出与存储返回值一致的 JSON 文本（单文本块）。 */
function jsonRender(_args: unknown, value: unknown): ToolContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 固定八个工具名（注册与上下文共用的基准顺序）。 */
export const COLLABORATION_TOOL_NAMES = [
  'router_dispatch',
  'router_record_create',
  'router_record_read',
  'router_record_list',
  'router_record_update',
  'router_role_list',
  'router_role_read',
  'router_role_save',
  'router_compact',
] as const

/**
 * 构建团队协作工具集。records/roles 为存储单实例，subagents 为宿主子代理服务
 * （base 全局提供，缺席时派发工具明确报错、其余七条不受影响）。rootSessionId
 * 始终显式传入；存储为字段校验的最终权威，本层只拦包装层坏值。
 */
/** 写记录成功后的回调（刷新活跃任务视图缓存，让上下文段零滞后）；缺席时不调。 */
export type AfterRecordWrite = (rootSessionId: string) => Promise<void>

export function buildCollaborationTools(deps: {
  records: RecordStore
  roles: RoleStore
  subagents?: SubagentsFace
  afterWrite?: AfterRecordWrite
  childModelRuns?: Map<string, ChildModelRun>
  /** 角色职责服务：派发后预热缓存与落盘会话绑定（缺席则不做）。 */
  roleDuties?: RoleDutyBinder
  /** 候选模型的随机源（缺席用 Math.random）：决定这次派发从候选序列的哪一项起步。 */
  random?: () => number
}): ToolDefinition[] {
  const { records, roles } = deps
  // 写后刷新：失败只告警，绝不把一次成功的写入变成失败（缓存下一拍会自愈）。
  const afterWrite = async (rootSessionId: string): Promise<void> => {
    if (deps.afterWrite === undefined) return
    try {
      await deps.afterWrite(rootSessionId)
    } catch (error) {
      console.warn('[dsh-router] active-task view refresh failed:', error instanceof Error ? error.message : String(error))
    }
  }
  return [
    buildDispatchTool({
      records,
      roles,
      subagents: deps.subagents,
      afterWrite,
      childModelRuns: deps.childModelRuns,
      roleDuties: deps.roleDuties,
      random: deps.random,
    }),
    {
      name: 'router_record_create',
      description:
        '新建一条工作记录（任务说明 task / 分工 assignment / 工作报告 report / 汇总 summary）。' +
        'rootSessionId 是整棵任务树的根会话，必须显式传入，不要拿当前会话 ID 充当根会话。' +
        '空 body 合法，空 title 不合法。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rootSessionId: { type: 'string', description: '根会话 ID（显式传入，不可推断）' },
          input: {
            type: 'object',
            additionalProperties: false,
            description: '新建记录入参',
            properties: {
              kind: { type: 'string', enum: [...RECORD_KINDS], description: '记录种类' },
              taskId: {
                type: 'string',
                description: '归属任务 ID（非任务记录必填；任务记录会忽略并等于本次记录 ID）',
              },
              parentRecordId: { type: 'string', description: '父记录编号（同任务内，可选）' },
              title: { type: 'string', description: '标题（非空）' },
              body: { type: 'string', description: '正文（可为空）' },
              workLabel: { type: 'string', enum: [...WORK_LABELS], description: '工作标签（可选）' },
              sessions: { type: 'array', description: '关联会话（可选）', items: SESSION_LINK_SCHEMA },
              artifacts: { type: 'array', description: '成果引用（可选）', items: ARTIFACT_REF_SCHEMA },
            },
            required: ['kind', 'title', 'body'],
          },
        },
        required: ['rootSessionId', 'input'],
      },
      output: { schema: SAVED_RECORD_SCHEMA, render: jsonRender },
      async execute(args: unknown): Promise<unknown> {
        const a = asObject(args, '参数')
        const rootSessionId = asNonEmptyString(a.rootSessionId, 'rootSessionId')
        const input = asObject(a.input, 'input')
        const saved = await records.create(rootSessionId, input as unknown as RecordDraft)
        await afterWrite(rootSessionId)
        return saved
      },
    },
    {
      name: 'router_record_read',
      description: '按 rootSessionId + taskId + recordId 读取一条工作记录。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rootSessionId: { type: 'string', description: '根会话 ID' },
          taskId: { type: 'string', description: '任务 ID' },
          recordId: { type: 'string', description: '记录 ID' },
        },
        required: ['rootSessionId', 'taskId', 'recordId'],
      },
      output: { schema: SAVED_RECORD_SCHEMA, render: jsonRender },
      async execute(args: unknown): Promise<unknown> {
        const a = asObject(args, '参数')
        const rootSessionId = asNonEmptyString(a.rootSessionId, 'rootSessionId')
        const taskId = asNonEmptyString(a.taskId, 'taskId')
        const recordId = asNonEmptyString(a.recordId, 'recordId')
        return records.read(rootSessionId, taskId, recordId)
      },
    },
    {
      name: 'router_record_list',
      description:
        '列举某根会话下的工作记录，可按 taskId 或 kind 过滤。无匹配返回空列表。' +
        'rootSessionId 必须显式传入。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rootSessionId: { type: 'string', description: '根会话 ID' },
          query: {
            type: 'object',
            additionalProperties: false,
            description: '可选过滤条件',
            properties: {
              taskId: { type: 'string', description: '只列该任务' },
              kind: { type: 'string', enum: [...RECORD_KINDS], description: '只列该种类' },
            },
          },
        },
        required: ['rootSessionId'],
      },
      output: { schema: { type: 'array', items: RECORD_SCHEMA }, render: jsonRender },
      async execute(args: unknown): Promise<unknown> {
        const a = asObject(args, '参数')
        const rootSessionId = asNonEmptyString(a.rootSessionId, 'rootSessionId')
        const query = optionalObject(a.query, 'query') as unknown as RecordQuery | undefined
        return records.list(rootSessionId, query)
      },
    },
    {
      name: 'router_record_update',
      description:
        '更新一条记录的标题/正文/工作标签/关联会话/成果引用。' +
        '种类、归属（taskId/rootSessionId）与创建时间不可更新。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rootSessionId: { type: 'string', description: '根会话 ID' },
          taskId: { type: 'string', description: '任务 ID' },
          recordId: { type: 'string', description: '记录 ID' },
          patch: {
            type: 'object',
            additionalProperties: false,
            description: '更新补丁（只含可改字段）',
            properties: {
              title: { type: 'string', description: '新标题（非空）' },
              body: { type: 'string', description: '新正文' },
              workLabel: { type: 'string', enum: [...WORK_LABELS], description: '新工作标签' },
              sessions: { type: 'array', description: '新关联会话', items: SESSION_LINK_SCHEMA },
              artifacts: { type: 'array', description: '新成果引用', items: ARTIFACT_REF_SCHEMA },
            },
          },
        },
        required: ['rootSessionId', 'taskId', 'recordId', 'patch'],
      },
      output: { schema: SAVED_RECORD_SCHEMA, render: jsonRender },
      async execute(args: unknown): Promise<unknown> {
        const a = asObject(args, '参数')
        const rootSessionId = asNonEmptyString(a.rootSessionId, 'rootSessionId')
        const taskId = asNonEmptyString(a.taskId, 'taskId')
        const recordId = asNonEmptyString(a.recordId, 'recordId')
        const patch = asObject(a.patch, 'patch')
        const saved = await records.update(rootSessionId, taskId, recordId, patch as unknown as RecordPatch)
        await afterWrite(rootSessionId)
        return saved
      },
    },
    {
      name: 'router_role_list',
      description: '列出全部角色模板（专业类型）。dispatch/派发专业类型时只从这里选，不要凭记忆或猜测。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'array', items: ROLE_TEMPLATE_SCHEMA }, render: jsonRender },
      async execute(args: unknown): Promise<unknown> {
        if (args !== undefined) asObject(args, '参数')
        return roles.list()
      },
    },
    {
      name: 'router_role_read',
      description: '按角色名或角色 ID 读取一个角色模板。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', description: '角色名（也可传角色 ID）' } },
        required: ['name'],
      },
      output: { schema: ROLE_TEMPLATE_SCHEMA, render: jsonRender },
      async execute(args: unknown): Promise<unknown> {
        const a = asObject(args, '参数')
        const name = asNonEmptyString(a.name, 'name')
        return roles.read(name)
      },
    },
    {
      name: 'router_role_save',
      description:
        '创建或修改角色模板（按名 upsert：同名覆盖职责说明，角色 ID 与文件路径不变）。' +
        '角色模板是职责文本，一个角色一个 md 文件（文件名 = 角色 ID），可直接手工编辑。' +
        '带 id 时按该 ID 更新（改名只改内容）；名称全局唯一，与别的角色重名会报错。' +
        'models 可选：省略则保留盘上已有候选；空数组清空候选。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          input: {
            type: 'object',
            additionalProperties: false,
            description: '模板入参',
            properties: {
              id: { type: 'string', description: '角色 ID（可选；给了就按该 ID 更新，ID 与文件路径不变）' },
              name: { type: 'string', description: '角色名（非空；与别的角色重名会报错）' },
              description: { type: 'string', description: '职责说明' },
              models: {
                type: 'array',
                description: '有序候选。省略保留已有候选；空数组清空。形状不合法整次拒绝。',
                items: ROLE_MODEL_SCHEMA,
              },
            },
            required: ['name', 'description'],
          },
        },
        required: ['input'],
      },
      output: { schema: ROLE_TEMPLATE_SCHEMA, render: jsonRender },
      async execute(args: unknown): Promise<unknown> {
        const a = asObject(args, '参数')
        const input = asObject(a.input, 'input')
        const name = asNonEmptyString(input.name, 'name')
        const description = typeof input.description === 'string' ? input.description : ''
        const models = Object.prototype.hasOwnProperty.call(input, 'models') ? input.models : undefined
        const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : undefined
        if (id !== undefined) {
          return roles.save({ id, name, description, ...(models !== undefined ? { models } : {}) })
        }
        // 按名 upsert：找到同名角色就原地更新（ID 与文件路径不变），找不到才新建。
        const existing = (await roles.list()).find((role) => role.name === name)
        if (existing !== undefined) {
          return roles.save({ id: existing.id, name, description, ...(models !== undefined ? { models } : {}) })
        }
        return roles.save({ name, description, ...(models !== undefined ? { models } : {}) })
      },
    },
    // 压缩工具放最后：与 COLLABORATION_TOOL_NAMES 的顺序一致。
    buildCompactTool({ records }),
  ]
}
