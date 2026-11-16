/**
 * 轻量团队协作模型工具 buildCollaborationTools（计划 Task 2A，Layer 2）。
 *
 * 七个面向模型的工具，是 RecordStore/RoleStore 的薄壳：参数经原生 JSON Schema 描述
 * （宿主认可的裸 JSON Schema 工具路径），execute 在边界守卫后直接把参数转交存储，
 * 存储抛出的 CollaborationError 原样上抛（宿主据 code 收敛为 isError），不发明
 * approved/success 之类业务标志，render 输出与存储返回值一致的 JSON 文本。
 *
 * 只依赖 ./types.ts：不 import 旧 ToolDefinition/RouterCore，不拖遗留 core 依赖树。
 * 当前会话的展示由纯上下文构建（context.ts）负责，execute 不读 exec。
 */

import { CollaborationError, type RecordDraft, type RecordPatch, type RecordQuery, type RecordStore, type RoleStore } from './types.ts'

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

/** 角色模板 schema。 */
const ROLE_TEMPLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '模板编号' },
    name: { type: 'string', description: '名称' },
    description: { type: 'string', description: '职责说明' },
    createdAt: { type: 'number', description: '创建时间戳' },
    updatedAt: { type: 'number', description: '更新时间戳' },
  },
  required: ['id', 'name', 'description', 'createdAt', 'updatedAt'],
}

/* ───────────────────────── 工具定义构建 ───────────────────────── */

/** render：输出与存储返回值一致的 JSON 文本（单文本块）。 */
function jsonRender(_args: unknown, value: unknown): ToolContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 固定七个工具名（注册与上下文共用的基准顺序）。 */
export const COLLABORATION_TOOL_NAMES = [
  'router_record_create',
  'router_record_read',
  'router_record_list',
  'router_record_update',
  'router_role_list',
  'router_role_read',
  'router_role_save',
] as const

/**
 * 构建团队协作工具集。records/roles 为已创建的存储单实例；rootSessionId 始终显式传入，
 * 不由当前会话推断、不接受角色/操作者输入。存储为字段校验的最终权威，本层只拦包装层坏值。
 */
export function buildCollaborationTools(records: RecordStore, roles: RoleStore): ToolDefinition[] {
  return [
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
        return records.create(rootSessionId, input as unknown as RecordDraft)
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
        return records.update(rootSessionId, taskId, recordId, patch as unknown as RecordPatch)
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
      description: '按编号读取一个角色模板。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '模板编号' } },
        required: ['id'],
      },
      output: { schema: ROLE_TEMPLATE_SCHEMA, render: jsonRender },
      async execute(args: unknown): Promise<unknown> {
        const a = asObject(args, '参数')
        const id = asNonEmptyString(a.id, 'id')
        return roles.read(id)
      },
    },
    {
      name: 'router_role_save',
      description:
        '创建或修改角色模板（专业类型）。带 id 为修改已有模板，不带 id 为新建。' +
        '角色模板只是职责文本，不注册运行时预设。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          input: {
            type: 'object',
            additionalProperties: false,
            description: '模板入参',
            properties: {
              id: { type: 'string', description: '已有模板编号（修改时带；新建省略）' },
              name: { type: 'string', description: '名称（非空）' },
              description: { type: 'string', description: '职责说明' },
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
        return roles.save(input as unknown as { id?: string; name: string; description: string })
      },
    },
  ]
}
