/**
 * 轻量团队协作工具 buildCollaborationTools 测试（计划 Task 2A，Layer 2）。
 *
 * brief 命名断言：seven exact tool names / sample-valid nested schemas /
 * each execute forwards args to the correct store method / actual owned record store
 * roundtrip / role save+read shared template store (manual↔model both orders) /
 * store rejection same object thrown / invalid wrapper typed INVALID_INPUT /
 * missing root must not silently bind current session / no subagent surface /
 * no save-triggered side effect / render emits JSON matching store values.
 * 边界守卫在宿主校验之前拦 null/非对象/缺包装/必填原始类型坏值，避免未类型 TypeError。
 */

import { afterAll, describe, expect, it } from 'vitest'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCollaborationTools } from '../../src/collaboration/tools.ts'
import { createRecordStore } from '../../src/collaboration/records.ts'
import { createRoleStore } from '../../src/collaboration/roles.ts'
import {
  CollaborationError,
  type RecordDraft,
  type RecordQuery,
  type RecordStore,
  type RoleStore,
  type SavedRecord,
  type WorkRecord,
} from '../../src/collaboration/types.ts'

/* ───────────────────────── schema 子集校验器（仅测本层用到的形状） ───────────────────────── */

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  additionalProperties?: boolean
  items?: JsonSchema
}

/** 校验 value 是否匹配 schema 用到的子集：type/properties/required/enum/additionalProperties:false/items。 */
function matches(schema: JsonSchema, value: unknown, path = '$'): void {
  if (schema.enum !== undefined) {
    expect(schema.enum, `${path} enum`).toContain(value)
    return
  }
  if (schema.type === 'object') {
    expect(typeof value, `${path} type`).toBe('object')
    expect(value, `${path} non-null`).not.toBeNull()
    expect(Array.isArray(value), `${path} not array`).toBe(false)
    const obj = value as Record<string, unknown>
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(obj)) {
        expect(allowed.has(key), `${path}.${key} allowed`).toBe(true)
      }
    }
    for (const req of schema.required ?? []) {
      expect(obj, `${path}.${req} required`).toHaveProperty(req)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined) matches(sub, obj[key], `${path}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    expect(Array.isArray(value), `${path} is array`).toBe(true)
    if (schema.items) (value as unknown[]).forEach((el, i) => matches(schema.items!, el, `${path}[${i}]`))
    return
  }
  if (schema.type === 'string') expect(typeof value, `${path} type`).toBe('string')
  if (schema.type === 'number') expect(typeof value, `${path} type`).toBe('number')
  if (schema.type === 'boolean') expect(typeof value, `${path} type`).toBe('boolean')
}

/* ───────────────────────── 假 store（记录调用，验证转发与无副作用） ───────────────────────── */

interface Call {
  method: string
  args: unknown[]
}

function makeFakeStores(): {
  records: RecordStore
  roles: RoleStore
  calls: Call[]
} {
  const calls: Call[] = []
  const rec = <T>(method: string, ret: T) => async (...args: unknown[]): Promise<T> => {
    calls.push({ method: `records.${method}`, args })
    return ret
  }
  const role = <T>(method: string, ret: T) => async (...args: unknown[]): Promise<T> => {
    calls.push({ method: `roles.${method}`, args })
    return ret
  }
  const savedRecord: SavedRecord = {
    record: {
      kind: 'task',
      id: '11111111-1111-4111-8111-111111111111',
      taskId: '11111111-1111-4111-8111-111111111111',
      rootSessionId: 'root-sid',
      title: 'T',
      body: '',
      createdAt: 1,
      updatedAt: 1,
    },
    path: '/x/y.json',
  }
  const workRecord: WorkRecord = { ...savedRecord.record }
  const roleTemplate = { name: '编码', description: '写代码' }
  const records: RecordStore = {
    create: rec('create', savedRecord),
    read: rec('read', savedRecord),
    list: rec('list', [workRecord]),
    update: rec('update', savedRecord),
  }
  const roles: RoleStore = {
    list: role('list', [roleTemplate]),
    read: role('read', roleTemplate),
    save: role('save', roleTemplate),
    remove: async () => false,
    migrateLegacyJson: async () => {},
  }
  return { records, roles, calls }
}

const TOOL_NAMES = [
  'router_dispatch',
  'router_record_create',
  'router_record_read',
  'router_record_list',
  'router_record_update',
  'router_role_list',
  'router_role_read',
  'router_role_save',
]

/* ───────────────────────── 工具名与 schema ───────────────────────── */

describe('buildCollaborationTools — names & schemas', () => {
  const tools = buildCollaborationTools(makeFakeStores())
  const byName = new Map(tools.map((t) => [t.name, t]))

  it('exposes exactly the eight fixed tool names in order', () => {
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES)
  })

  it('every tool has description, parameters, output.schema, output.render, execute', () => {
    for (const t of tools) {
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.parameters.type).toBe('object')
      // output schema is object or array (list tools return arrays); no invented flags
      expect(['object', 'array']).toContain(t.output.schema.type)
      if (t.output.schema.type === 'object') {
        expect(t.output.schema.additionalProperties).toBe(false)
      }
      expect(typeof t.output.render).toBe('function')
      expect(typeof t.execute).toBe('function')
    }
  })

  it('record_create schema: nested input with kind enum, required kind/title/body, additionalProperties false', () => {
    const p = byName.get('router_record_create')!.parameters as JsonSchema
    expect(p.additionalProperties).toBe(false)
    expect(p.required).toEqual(['rootSessionId', 'input'])
    const input = p.properties!.input as JsonSchema
    expect(input.type).toBe('object')
    expect(input.additionalProperties).toBe(false)
    expect(input.required).toEqual(['kind', 'title', 'body'])
    expect((input.properties!.kind as JsonSchema).enum).toEqual(['task', 'assignment', 'report', 'summary'])
    // sample-valid nested input
    matches(p, {
      rootSessionId: 'root-sid',
      input: {
        kind: 'assignment',
        taskId: '11111111-1111-4111-8111-111111111111',
        parentRecordId: '22222222-2222-4222-8222-222222222222',
        title: '分工',
        body: '做这部分',
        workLabel: '待处理',
        sessions: [{ sessionId: 'child-sid', label: '执行会话' }],
        artifacts: [{ location: '/tmp/x', label: '成果' }],
      },
    })
  })

  it('record_create schema rejects missing required / bad enum / extra property', () => {
    const p = byName.get('router_record_create')!.parameters as JsonSchema
    expect(() => matches(p, { rootSessionId: 'r', input: { kind: 'task', title: 'T' } })).toThrow() // missing body
    expect(() => matches(p, { rootSessionId: 'r', input: { kind: 'nope', title: 'T', body: 'b' } })).toThrow() // bad enum
    expect(() =>
      matches(p, { rootSessionId: 'r', input: { kind: 'task', title: 'T', body: 'b', x: 1 } }),
    ).toThrow() // additionalProperties false
  })

  it('record_read schema: required rootSessionId/taskId/recordId', () => {
    const p = byName.get('router_record_read')!.parameters as JsonSchema
    expect(p.required).toEqual(['rootSessionId', 'taskId', 'recordId'])
    matches(p, { rootSessionId: 'r', taskId: '11111111-1111-4111-8111-111111111111', recordId: '22222222-2222-4222-8222-222222222222' })
  })

  it('record_list schema: query optional object with optional taskId/kind enum', () => {
    const p = byName.get('router_record_list')!.parameters as JsonSchema
    expect(p.required).toEqual(['rootSessionId'])
    const q = p.properties!.query as JsonSchema
    expect(q.type).toBe('object')
    expect(q.additionalProperties).toBe(false)
    expect((q.properties!.kind as JsonSchema).enum).toEqual(['task', 'assignment', 'report', 'summary'])
    matches(p, { rootSessionId: 'r', query: { kind: 'report', taskId: '11111111-1111-4111-8111-111111111111' } })
  })

  it('record_update schema: nested patch object, additionalProperties false', () => {
    const p = byName.get('router_record_update')!.parameters as JsonSchema
    expect(p.required).toEqual(['rootSessionId', 'taskId', 'recordId', 'patch'])
    const patch = p.properties!.patch as JsonSchema
    expect(patch.additionalProperties).toBe(false)
    expect((patch.properties!.workLabel as JsonSchema).enum).toEqual(['待处理', '进行中', '受阻', '已报告'])
    matches(p, { rootSessionId: 'r', taskId: 't', recordId: 'rec', patch: { body: 'x', workLabel: '进行中' } })
  })

  it('role tools schemas: role_save nested input required name/description; role_read required name', () => {
    const save = byName.get('router_role_save')!.parameters as JsonSchema
    expect(save.required).toEqual(['input'])
    const input = save.properties!.input as JsonSchema
    expect(input.required).toEqual(['name', 'description'])
    matches(save, { input: { name: '编码', description: '写代码' } })
    const read = byName.get('router_role_read')!.parameters as JsonSchema
    expect(read.required).toEqual(['name'])
  })

  it('output schema describes real returned shape (record+path), not invented success flags', () => {
    const create = byName.get('router_record_create')!.output.schema as JsonSchema
    expect(create.required).toEqual(['record', 'path'])
    const rec = create.properties!.record as JsonSchema
    expect(rec.required).toContain('id')
    expect(rec.required).toContain('taskId')
    expect(rec.required).toContain('rootSessionId')
    expect(rec.required).toContain('createdAt')
    expect(rec.properties!.kind).toBeDefined()
    // no invented approved/success business flag anywhere
    const json = JSON.stringify(create)
    expect(json).not.toContain('approved')
    expect(json).not.toContain('"success"')
    const list = byName.get('router_record_list')!.output.schema as JsonSchema
    expect(list.type).toBe('array')
    const roleList = byName.get('router_role_list')!.output.schema as JsonSchema
    expect(roleList.type).toBe('array')
  })
})

/* ───────────────────────── 转发到正确的 store 方法 ───────────────────────── */

describe('buildCollaborationTools — execute forwards to store', () => {
  function find(name: string) {
    const { records, roles, calls } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    return { tool: tools.find((t) => t.name === name)!, calls }
  }

  it('router_record_create forwards (rootSessionId, input) to records.create', async () => {
    const { tool, calls } = find('router_record_create')
    const input: RecordDraft = { kind: 'task', title: 'T', body: '' }
    await tool.execute({ rootSessionId: 'root-sid', input }, {})
    expect(calls).toEqual([{ method: 'records.create', args: ['root-sid', input] }])
  })

  it('router_record_read forwards (rootSessionId, taskId, recordId)', async () => {
    const { tool, calls } = find('router_record_read')
    await tool.execute({ rootSessionId: 'r', taskId: 't', recordId: 'rec' }, {})
    expect(calls).toEqual([{ method: 'records.read', args: ['r', 't', 'rec'] }])
  })

  it('router_record_list forwards (rootSessionId, query)', async () => {
    const { tool, calls } = find('router_record_list')
    const query: RecordQuery = { kind: 'report' }
    await tool.execute({ rootSessionId: 'r', query }, {})
    expect(calls).toEqual([{ method: 'records.list', args: ['r', query] }])
  })

  it('router_record_update forwards (rootSessionId, taskId, recordId, patch)', async () => {
    const { tool, calls } = find('router_record_update')
    const patch = { body: 'x' }
    await tool.execute({ rootSessionId: 'r', taskId: 't', recordId: 'rec', patch }, {})
    expect(calls).toEqual([{ method: 'records.update', args: ['r', 't', 'rec', patch] }])
  })

  it('router_role_list forwards () to roles.list', async () => {
    const { tool, calls } = find('router_role_list')
    await tool.execute({}, {})
    expect(calls).toEqual([{ method: 'roles.list', args: [] }])
  })

  it('router_role_read forwards (name) to roles.read', async () => {
    const { tool, calls } = find('router_role_read')
    await tool.execute({ name: '主管' }, {})
    expect(calls).toEqual([{ method: 'roles.read', args: ['主管'] }])
  })

  it('router_role_save forwards (input) to roles.save', async () => {
    const { tool, calls } = find('router_role_save')
    const input = { name: '编码', description: '写代码' }
    await tool.execute({ input }, {})
    expect(calls).toEqual([{ method: 'roles.save', args: [input] }])
  })

  it('no save-triggered side effect: role_save calls only roles.save once', async () => {
    const { tool, calls } = find('router_role_save')
    await tool.execute({ input: { name: 'n', description: 'd' } }, {})
    expect(calls).toHaveLength(1)
  })

  it('subagents 缺席时其余七条照常注册（派发工具在调用时才明确报错）', () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    expect(tools).toHaveLength(8)
    expect(tools.map((t) => t.name)).toContain('router_dispatch')
  })
})

/* ───────────────────────── 错误传播与边界守卫 ───────────────────────── */

describe('buildCollaborationTools — error propagation & boundary guards', () => {
  function throwingStores(err: CollaborationError): { records: RecordStore; roles: RoleStore } {
    const records = {
      create: async () => {
        throw err
      },
      read: async () => {
        throw err
      },
      list: async () => {
        throw err
      },
      update: async () => {
        throw err
      },
    } as RecordStore
    const roles = {
      remove: async () => {
        throw err
      },
      list: async () => {
        throw err
      },
      read: async () => {
        throw err
      },
      save: async () => {
        throw err
      },
      migrateLegacyJson: async () => {
        throw err
      },
    } as RoleStore
    return { records, roles }
  }

  it('store rejection is the SAME CollaborationError object thrown (not success-shaped)', async () => {
    const storeErr = new CollaborationError('NOT_FOUND', '记录不存在')
    const { records, roles } = throwingStores(storeErr)
    const tools = buildCollaborationTools({ records, roles })
    const recordCreate = tools.find((t) => t.name === 'router_record_create')!
    await expect(
      recordCreate.execute({ rootSessionId: 'r', input: { kind: 'task', title: 'T', body: '' } }, {}),
    ).rejects.toBe(storeErr)
  })

  it('invalid wrapper: null args → INVALID_INPUT', async () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    const recordCreate = tools.find((t) => t.name === 'router_record_create')!
    await expect(recordCreate.execute(null, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('invalid wrapper: non-object args → INVALID_INPUT', async () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    const recordCreate = tools.find((t) => t.name === 'router_record_create')!
    await expect(recordCreate.execute('not-an-object', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('invalid wrapper: missing rootSessionId on record tool → INVALID_INPUT (no silent bind)', async () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    const recordCreate = tools.find((t) => t.name === 'router_record_create')!
    await expect(recordCreate.execute({ input: { kind: 'task', title: 'T', body: '' } }, {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('invalid wrapper: empty rootSessionId → INVALID_INPUT', async () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    const recordCreate = tools.find((t) => t.name === 'router_record_create')!
    await expect(recordCreate.execute({ rootSessionId: '', input: { kind: 'task', title: 'T', body: '' } }, {})).rejects.toMatchObject(
      { code: 'INVALID_INPUT' },
    )
  })

  it('invalid wrapper: present-but-non-object input → INVALID_INPUT before property access', async () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    const recordCreate = tools.find((t) => t.name === 'router_record_create')!
    await expect(recordCreate.execute({ rootSessionId: 'r', input: 'oops' }, {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('invalid wrapper: present-but-non-object patch on update → INVALID_INPUT', async () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    const update = tools.find((t) => t.name === 'router_record_update')!
    await expect(update.execute({ rootSessionId: 'r', taskId: 't', recordId: 'rec', patch: 5 }, {})).rejects.toMatchObject(
      { code: 'INVALID_INPUT' },
    )
  })

  it('invalid wrapper: missing taskId on record_read → INVALID_INPUT', async () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    await expect(tools.find((t) => t.name === 'router_record_read')!.execute({ rootSessionId: 'r' }, {})).rejects.toMatchObject(
      { code: 'INVALID_INPUT' },
    )
  })

  it('raw invoke does not throw untyped TypeError for scalar/array/boolean wrappers', async () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    for (const bad of [42, [], 'x', true]) {
      await expect(tools.find((t) => t.name === 'router_record_create')!.execute(bad, {})).rejects.toMatchObject({ name: 'CollaborationError' })
    }
  })
})

/* ───────────────────────── render 输出 JSON 文本 ───────────────────────── */

describe('buildCollaborationTools — render emits JSON text matching value', () => {
  it('render returns a single text block whose text is JSON of the store value', () => {
    const { records, roles } = makeFakeStores()
    const tools = buildCollaborationTools({ records, roles })
    const value = {
      record: { id: 'x', taskId: 't', rootSessionId: 'r', kind: 'task', title: 'T', body: '', createdAt: 1, updatedAt: 1 },
      path: '/p',
    }
    const blocks = tools[0]!.output.render({}, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('text')
    expect(JSON.parse(blocks[0]!.text)).toEqual(value)
  })
})

/* ───────────────────────── 真实 owned store 工具往返 ───────────────────────── */

describe('buildCollaborationTools — real owned store roundtrip', () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  })
  async function makeReal() {
    const dir = await mkdtemp(join(tmpdir(), 'router-collab-tools-'))
    dirs.push(dir)
    const records = createRecordStore(dir)
    const roles = createRoleStore(dir)
    const tools = buildCollaborationTools({ records, roles })
    return {
      records,
      roles,
      create: tools.find((t) => t.name === 'router_record_create')!,
      read: tools.find((t) => t.name === 'router_record_read')!,
      list: tools.find((t) => t.name === 'router_record_list')!,
      update: tools.find((t) => t.name === 'router_record_update')!,
      roleSave: tools.find((t) => t.name === 'router_role_save')!,
      roleRead: tools.find((t) => t.name === 'router_role_read')!,
    }
  }

  const ROOT = 'root-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  it('record_create → record_read → record_list → record_update roundtrip', async () => {
    const r = await makeReal()
    const created = await r.create.execute(
      { rootSessionId: ROOT, input: { kind: 'task', title: '任务一', body: '目标' } },
      {},
    )
    const createdRec = (created as { record: { id: string; taskId: string } }).record
    expect(createdRec.taskId).toBe(createdRec.id) // task record id == taskId

    const readBack = await r.read.execute(
      { rootSessionId: ROOT, taskId: createdRec.id, recordId: createdRec.id },
      {},
    )
    expect((readBack as { record: { title: string } }).record.title).toBe('任务一')

    const listed = await r.list.execute({ rootSessionId: ROOT }, {})
    expect((listed as unknown[]).length).toBeGreaterThanOrEqual(1)

    const updated = await r.update.execute(
      { rootSessionId: ROOT, taskId: createdRec.id, recordId: createdRec.id, patch: { body: '更新后', workLabel: '进行中' } },
      {},
    )
    expect((updated as { record: { body: string } }).record.body).toBe('更新后')
    expect((updated as { record: { workLabel: string } }).record.workLabel).toBe('进行中')
  })

  it('role save (manual store) → model tool read; and model tool save → manual store read (shared template store)', async () => {
    const r = await makeReal()
    // manual store save first
    const manual = await r.roles.save({ name: '调研', description: '做调研' })
    // model tool read sees it
    const viaTool = await r.roleRead.execute({ name: '调研' }, {})
    expect((viaTool as { name: string }).name).toBe('调研')

    // model tool save next
    const viaSave = await r.roleSave.execute({ input: { name: '文档', description: '写文档' } }, {})
    const savedName = (viaSave as { name: string }).name
    // manual store read sees it
    const manualRead = await r.roles.read(savedName)
    expect(manualRead.name).toBe('文档')
  })
})
