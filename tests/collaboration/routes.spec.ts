/**
 * 宿主薄路由测试（计划 Task 3，Layer 4）。
 *
 * brief 命名断言：
 *  - routes_reuse_store：UI 模板保存与模型工具共享同一 RoleStore（routes 只折叠 HTTP，
 *    逻辑全在注入的 RecordStore/RoleStore）；未登录沿用宿主 connection.admit 拒绝；
 *    保存错误不返回 200；旧 /router/tasks/control 等控制路由未注册。
 *  - request_bad_type/method/body：坏查询/坏方法/坏 JSON 各映射到明确状态码。
 *  - store_io_error_not_200：存储抛 IO_ERROR → 500（不伪装成 200/空列表）。
 *  - admit_denied_zero_io：connection.admit 拒绝时 datastore 零 IO。
 *
 * 用真实 owned stores（createRecordStore/createRoleStore + 真实临时目录），不用玩具 ctx 嵌套。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRecordStore } from '../../src/collaboration/records.ts'
import { createRoleStore } from '../../src/collaboration/roles.ts'
import { CollaborationError, type RecordStore, type RoleStore } from '../../src/collaboration/types.ts'
import { registerCollaborationRoutes, type CollaborationRouteContext } from '../../src/collaboration/routes.ts'
import { COLLABORATION_RECORDS_PATH, COLLABORATION_RECORD_PATH, COLLABORATION_ROLES_PATH, COLLABORATION_MODELS_PATH, type CollaborationSessionController } from '../../src/collaboration/routes.ts'

const scratch: string[] = []
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'router-routes-'))
  scratch.push(dir)
  return dir
}

/** 把 POST 体拆成任意块序列喂给 handler 的假请求（可逐字节拆字、可末尾追加 end）。 */
function fakeReqChunks(method: string, url: string, chunks: Buffer[]): {
  method: string | undefined
  url: string | undefined
  on(event: string, listener: (chunk?: Buffer) => void): unknown
} {
  const listeners: Record<string, Array<(chunk?: Buffer) => void>> = {}
  const req = {
    method,
    url,
    on(event: string, listener: (chunk?: Buffer) => void) {
      ;(listeners[event] ??= []).push(listener)
      return req
    },
  }
  queueMicrotask(() => {
    for (const chunk of chunks) for (const listener of listeners['data'] ?? []) listener(chunk)
    for (const listener of listeners['end'] ?? []) listener()
  })
  return req
}

function fakeRes(): {
  statusCode: number
  headers: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
} {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

interface RegisteredRoute {
  path: string
  handler: (request: unknown, response: unknown) => void | Promise<void>
}

/** 注册上下文 + 已注册路由表 + admit 行为。 */
function harness(opts: {
  records: RecordStore
  roles: RoleStore
  sessionController?: () => CollaborationSessionController | undefined
  admit?: (request: unknown) => { rejection: number } | { peer: unknown }
}): {
  ctx: CollaborationRouteContext
  routes: RegisteredRoute[]
  invoke(method: string, pathAndQuery: string, body?: string | Buffer[]): Promise<{ status: number; body: string; headers: Record<string, string> }>
} {
  const routes: RegisteredRoute[] = []
  const ctx: CollaborationRouteContext = {
    effect: (factory) => factory(),
    webServer: {
      register: (route) => {
        routes.push(route as RegisteredRoute)
        return () => {}
      },
    },
    connection: {
      admit: (request) => opts.admit?.(request) ?? { peer: {} },
    },
  }
  registerCollaborationRoutes(ctx, { records: opts.records, roles: opts.roles, sessionController: opts.sessionController })
  const invoke = async (method: string, pathAndQuery: string, body?: string | Buffer[]) => {
    const [path, query] = pathAndQuery.split('?')
    const route = routes.find((r) => r.path === path)
    if (route === undefined) return { status: 404, body: '', headers: {} }
    const chunks = body === undefined ? [] : (typeof body === 'string' ? [Buffer.from(body, 'utf8')] : body)
    const req = fakeReqChunks(method, pathAndQuery, chunks)
    const res = fakeRes()
    await route.handler(req, res)
    // 等待 handler 内的异步逻辑（readBody 用 queueMicrotask 喂数据）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { status: res.statusCode, body: res.body, headers: res.headers }
  }
  return { ctx, routes, invoke }
}

describe('routes_reuse_store — UI 模板保存与模型工具共享同一 RoleStore，控制路由不注册', () => {
  it('注册恰好四条协作路由（records/record/roles/models），旧控制路由未注册', async () => {
    const dataDir = await freshDir()
    const { routes } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const paths = routes.map((r) => r.path).sort()
    expect(paths).toEqual([COLLABORATION_RECORDS_PATH, COLLABORATION_RECORD_PATH, COLLABORATION_ROLES_PATH, COLLABORATION_MODELS_PATH].sort())
    // 旧事务协议控制路由一概不挂（首版工作台只读，记录修改由工具负责）。
    for (const legacy of ['/router/tasks/control', '/router/breaker/unfreeze', '/router/emergency-pause', '/router/state']) {
      expect(paths).not.toContain(legacy)
    }
  })

  it('POST /roles 走同一 RoleStore：保存后 GET /roles 与模型工具读到同一条', async () => {
    const dataDir = await freshDir()
    const roles = createRoleStore(dataDir)
    const { invoke } = harness({ records: createRecordStore(dataDir), roles })
    // 用户经工作台保存一条角色模板。
    const saved = await invoke('POST', COLLABORATION_ROLES_PATH, JSON.stringify({ name: '前端开发', description: '负责 UI' }))
    expect(saved.status).toBe(200)
    const savedBody = JSON.parse(saved.body) as { id: string; name: string }
    expect(savedBody.name).toBe('前端开发')
    // 同一 RoleStore 的 list 读到同一条（与模型工具 router_role_list 共享）。
    const listed = await invoke('GET', COLLABORATION_ROLES_PATH)
    expect(listed.status).toBe(200)
    const listBody = JSON.parse(listed.body) as Array<{ name: string }>
    expect(listBody.map((r) => r.name)).toEqual([savedBody.name])
    // 模型工具直接读同一 store 也看得到。
    const viaStore = await roles.list()
    expect(viaStore.map((r) => r.name)).toEqual([savedBody.name])
  })

  it('保存错误不返回 200：空 name 返回 400 {error:{code,message}}', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const res = await invoke('POST', COLLABORATION_ROLES_PATH, JSON.stringify({ name: '', description: 'x' }))
    expect(res.status).toBe(400)
    const body = JSON.parse(res.body) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
    expect(typeof body.error.message).toBe('string')
  })

  it('GET /records 复用 RecordStore.list；GET /record 复用 RecordStore.read', async () => {
    const dataDir = await freshDir()
    const records = createRecordStore(dataDir)
    // 经 store 直接落一条任务记录（模拟模型已保存）。
    const task = await records.create('root-sess-1', { kind: 'task', title: '任务A', body: '目标' })
    await records.create('root-sess-1', { kind: 'report', taskId: task.record.id, title: '报告', body: '成果', workLabel: '进行中' })
    const { invoke } = harness({ records, roles: createRoleStore(dataDir) })
    const list = await invoke('GET', `${COLLABORATION_RECORDS_PATH}?rootSessionId=root-sess-1`)
    expect(list.status).toBe(200)
    const listBody = JSON.parse(list.body) as Array<{ kind: string; title: string }>
    expect(listBody.map((r) => r.title)).toEqual(['任务A', '报告'])
    const one = await invoke('GET', `${COLLABORATION_RECORD_PATH}?rootSessionId=root-sess-1&taskId=${task.record.id}&recordId=${task.record.id}`)
    expect(one.status).toBe(200)
    const oneBody = JSON.parse(one.body) as { record: { id: string }; path: string }
    expect(oneBody.record.id).toBe(task.record.id)
    expect(typeof oneBody.path).toBe('string')
  })
})

describe('request_bad_type/method/body — 坏输入映射到明确状态码', () => {
  it('坏方法（POST 到 GET-only 的 /records）返回 405 且带 allow 头', async () => {
    const dataDir = await freshDir()
    const { invoke, routes } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const res = await invoke('POST', `${COLLABORATION_RECORDS_PATH}?rootSessionId=x`, JSON.stringify({}))
    expect(res.status).toBe(405)
    expect(res.headers['allow']).toContain('GET')
    expect(routes.find((r) => r.path === COLLABORATION_RECORDS_PATH)).toBeTruthy()
  })

  it('坏 JSON（POST /roles 非法 JSON）返回 400', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const res = await invoke('POST', COLLABORATION_ROLES_PATH, '{ not json')
    expect(res.status).toBe(400)
    const body = JSON.parse(res.body) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('GET /records 缺 rootSessionId 返回 400；坏 kind 枚举返回 400', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const missing = await invoke('GET', COLLABORATION_RECORDS_PATH)
    expect(missing.status).toBe(400)
    const badKind = await invoke('GET', `${COLLABORATION_RECORDS_PATH}?rootSessionId=x&kind=bogus`)
    expect(badKind.status).toBe(400)
  })

  it('POST /roles 非对象体（数组）返回 400', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const res = await invoke('POST', COLLABORATION_ROLES_PATH, JSON.stringify([1, 2, 3]))
    expect(res.status).toBe(400)
  })

  it('未识别路径返回 404（不挂到别处）', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const res = await invoke('GET', '/router/collaboration/nope')
    expect(res.status).toBe(404)
  })
})

describe('store_io_error_not_200 — 存储错误映射明确状态码，不伪装成功', () => {
  it('RecordStore.read 抛 IO_ERROR → 500 {error:{code:IO_ERROR}}', async () => {
    const dataDir = await freshDir()
    // 真实 store，但 fs.readFile 抛非 ENOENT 错 → 读记录时包成 IO_ERROR。
    const records = createRecordStore(dataDir, {
      fs: {
        mkdirp: async () => {},
        readFile: async () => { throw new Error('disk on fire') },
        readdir: async () => [],
        writeFile: async () => {},
        rename: async () => {},
        remove: async () => {},
        lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true }),
      },
    })
    const { invoke } = harness({ records, roles: createRoleStore(dataDir) })
    const res = await invoke('GET', `${COLLABORATION_RECORD_PATH}?rootSessionId=x&taskId=11111111-1111-4111-8111-111111111111&recordId=22222222-2222-4222-8222-222222222222`)
    expect(res.status).toBe(500)
    const body = JSON.parse(res.body) as { error: { code: string } }
    expect(body.error.code).toBe('IO_ERROR')
  })

  it('RecordStore.read 缺记录 → NOT_FOUND 404（不返回空 200）', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const res = await invoke('GET', `${COLLABORATION_RECORD_PATH}?rootSessionId=x&taskId=11111111-1111-4111-8111-111111111111&recordId=22222222-2222-4222-8222-222222222222`)
    expect(res.status).toBe(404)
    const body = JSON.parse(res.body) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('坏 UUID taskId 返回 400 INVALID_INPUT', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const res = await invoke('GET', `${COLLABORATION_RECORD_PATH}?rootSessionId=x&taskId=..%2Fetc&recordId=22222222-2222-4222-8222-222222222222`)
    expect(res.status).toBe(400)
  })
})

describe('admit_denied_zero_io — connection.admit 拒绝时 datastore 零 IO', () => {
  it('admit 返回 rejection（401/403）时直接拒绝，不调用 store', async () => {
    const dataDir = await freshDir()
    let readCalled = false
    const records = createRecordStore(dataDir, {
      fs: {
        mkdirp: async () => {},
        readFile: async () => { readCalled = true; throw new Error('should not be called') },
        readdir: async () => { readCalled = true; return [] },
        writeFile: async () => {},
        rename: async () => {},
        remove: async () => {},
        lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true }),
      },
    })
    let roleSaved = false
    const roles = createRoleStore(dataDir, {
      fs: {
        mkdirp: async () => {},
        readFile: async () => { throw new Error('nope') },
        readdir: async () => [],
        writeFile: async () => { roleSaved = true },
        rename: async () => {},
        remove: async () => {},
        lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true }),
      },
    })
    const { invoke } = harness({
      records,
      roles,
      admit: () => ({ rejection: 401 }),
    })
    const res = await invoke('GET', `${COLLABORATION_RECORDS_PATH}?rootSessionId=x`)
    expect(res.status).toBe(401)
    expect(readCalled).toBe(false)
    const post = await invoke('POST', COLLABORATION_ROLES_PATH, JSON.stringify({ name: 'x', description: '' }))
    expect(post.status).toBe(401)
    expect(roleSaved).toBe(false)
  })
})

describe('error contract — 原始失败以 {error:{code,message}} 透出', () => {
  it('CORRUPT_RECORD 映射 500，INVALID_INPUT 映射 400（同一路由按 store 错误分流）', async () => {
    const dataDir = await freshDir()
    // 一个会抛 CORRUPT_RECORD 的 read（坏盘结构）。
    const records = createRecordStore(dataDir, {
      fs: {
        mkdirp: async () => {},
        readFile: async () => JSON.stringify({ not: 'a valid record' }),
        readdir: async () => ['11111111-1111-4111-8111-111111111111'],
        writeFile: async () => {},
        rename: async () => {},
        remove: async () => {},
        lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true }),
      },
    })
    const { invoke } = harness({ records, roles: createRoleStore(dataDir) })
    const res = await invoke('GET', `${COLLABORATION_RECORD_PATH}?rootSessionId=x&taskId=11111111-1111-4111-8111-111111111111&recordId=11111111-1111-4111-8111-111111111111`)
    expect(res.status).toBe(500)
    const body = JSON.parse(res.body) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('CORRUPT_RECORD')
    expect(typeof body.error.message).toBe('string')
  })
})

describe('POST body transport — 跨块多字节解码 + 1MiB 累计字节上限 413', () => {
  const LIMIT = 1024 * 1024

  it('跨块拆字的多字节字符（中文）一次性解码：逐字落盘读回一致', async () => {
    const dataDir = await freshDir()
    const roles = createRoleStore(dataDir)
    const { invoke } = harness({ records: createRecordStore(dataDir), roles })
    const payload = Buffer.from(JSON.stringify({ name: '中文角色', description: '负责界面' }), 'utf8')
    // 逐字节喂（最激进拆字）：每个字节一个 data 事件，把「中」的 UTF-8 字节拆到不同块。
    const chunks = [...payload].map((byte) => Buffer.from([byte]))
    const res = await invoke('POST', COLLABORATION_ROLES_PATH, chunks)
    expect(res.status).toBe(200)
    const saved = JSON.parse(res.body) as { name: string; description: string }
    expect(saved.name).toBe('中文角色')
    expect(saved.description).toBe('负责界面')
    // 同一 store 读回逐字一致（持久化无替换符乱码）。
    const listed = await roles.list()
    expect(listed.map((r) => r.name)).toEqual(['中文角色'])
    expect(listed.map((r) => r.description)).toEqual(['负责界面'])
  })

  it('恰好 1MiB 的合法 JSON 允许；多 1 字节返回 413 BODY_TOO_LARGE', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const overhead = Buffer.byteLength(JSON.stringify({ name: 'x', description: '' }), 'utf8')
    const exactBody = JSON.stringify({ name: 'x', description: 'y'.repeat(LIMIT - overhead) })
    expect(Buffer.byteLength(exactBody, 'utf8')).toBe(LIMIT)
    const ok = await invoke('POST', COLLABORATION_ROLES_PATH, exactBody)
    expect(ok.status).toBe(200)
    // 多 1 字节：超限 413（不是 400 INVALID_INPUT）。
    const over = await invoke('POST', COLLABORATION_ROLES_PATH, `${exactBody}x`)
    expect(over.status).toBe(413)
    const overBody = JSON.parse(over.body) as { error: { code: string; message: string } }
    expect(overBody.error.code).toBe('BODY_TOO_LARGE')
    expect(typeof overBody.error.message).toBe('string')
  })

  it('超限拒绝时不写 store（零落盘）', async () => {
    const dataDir = await freshDir()
    const roles = createRoleStore(dataDir)
    const { invoke } = harness({ records: createRecordStore(dataDir), roles })
    const overhead = Buffer.byteLength(JSON.stringify({ name: 'x', description: '' }), 'utf8')
    const overBody = JSON.stringify({ name: 'x', description: 'y'.repeat(LIMIT - overhead + 1) })
    const res = await invoke('POST', COLLABORATION_ROLES_PATH, overBody)
    expect(res.status).toBe(413)
    expect(await roles.list()).toHaveLength(0)
  })

  it('分块体超限：拒绝后收到 end 仍干净返回 413（不崩、不 200、不半写）', async () => {
    const dataDir = await freshDir()
    const roles = createRoleStore(dataDir)
    const { invoke } = harness({ records: createRecordStore(dataDir), roles })
    // name 本身就超过 1MiB；分两块喂，第一块未过半、第二块越过上限后 end 才到。
    const overhead = Buffer.byteLength(JSON.stringify({ name: '', description: '' }), 'utf8')
    const payload = Buffer.from(JSON.stringify({ name: 'x'.repeat(LIMIT - overhead + 10), description: '' }), 'utf8')
    const mid = Math.floor(payload.length / 2)
    const res = await invoke('POST', COLLABORATION_ROLES_PATH, [payload.subarray(0, mid), payload.subarray(mid)])
    expect(res.status).toBe(413)
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('BODY_TOO_LARGE')
    expect(await roles.list()).toHaveLength(0)
  })
})

describe('GET /router/collaboration/models', () => {
  it('没有 sessionController 时 200 且 unavailable', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({ records: createRecordStore(dataDir), roles: createRoleStore(dataDir) })
    const res = await invoke('GET', COLLABORATION_MODELS_PATH)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ unavailable: true, providers: [] })
  })

  it('modelCatalog() 抛错时仍是 200 unavailable，不让角色路由整组失败', async () => {
    const dataDir = await freshDir()
    const roles = createRoleStore(dataDir)
    const { invoke } = harness({
      records: createRecordStore(dataDir),
      roles,
      sessionController: () => ({
        modelCatalog: async () => { throw new Error('catalog down') },
      }),
    })
    const res = await invoke('GET', COLLABORATION_MODELS_PATH)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ unavailable: true, providers: [] })
    const saved = await invoke('POST', COLLABORATION_ROLES_PATH, JSON.stringify({ name: '执行者', description: '职责' }))
    expect(saved.status).toBe(200)
  })

  it('sessionController 提供 groups 时只返回这些分组里的模型，failures 不进清单', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({
      records: createRecordStore(dataDir),
      roles: createRoleStore(dataDir),
      sessionController: () => ({
        modelCatalog: async () => ({
          default: { provider: 'deepseek', model: 'deepseek-chat' },
          routableProviders: ['deepseek', 'openai'],
          groups: [
            { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }, { id: 'deepseek-reasoner', name: 'Reasoner' }] },
            { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
          ],
          failures: [{ id: 'blocked', name: 'Blocked', message: 'no route' }],
        }),
      }),
    })
    const res = await invoke('GET', COLLABORATION_MODELS_PATH)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      unavailable: false,
      providers: [
        { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }, { id: 'deepseek-reasoner', name: 'Reasoner' }] },
        { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
      ],
    })
  })

  it('modelCatalog() 返回坏形状（无 groups）→ 200 unavailable，绝不退回全集', async () => {
    const dataDir = await freshDir()
    const { invoke } = harness({
      records: createRecordStore(dataDir),
      roles: createRoleStore(dataDir),
      sessionController: () => ({ modelCatalog: async () => ({ notGroups: true }) } as unknown as CollaborationSessionController),
    })
    const res = await invoke('GET', COLLABORATION_MODELS_PATH)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ unavailable: true, providers: [] })
  })
})

describe('POST /roles models', () => {
  it('省略 models 保留旧候选；[] 清空；坏形状 400 且不改文件', async () => {
    const dataDir = await freshDir()
    const roles = createRoleStore(dataDir)
    const { invoke } = harness({ records: createRecordStore(dataDir), roles })
    const created = await invoke('POST', COLLABORATION_ROLES_PATH, JSON.stringify({
      name: '执行者',
      description: '旧',
      models: [{ provider: 'not-registered', model: 'no-such' }],
    }))
    expect(created.status).toBe(200)
    const kept = await invoke('POST', COLLABORATION_ROLES_PATH, JSON.stringify({ name: '执行者', description: '新职责' }))
    expect(kept.status).toBe(200)
    expect(JSON.parse(kept.body).models).toEqual([{ provider: 'not-registered', model: 'no-such' }])
    const path = (await roles.read('执行者')).description
    expect(path.startsWith('新职责')).toBe(true)
    const before = await roles.read('执行者')
    const bad = await invoke('POST', COLLABORATION_ROLES_PATH, JSON.stringify({
      name: '执行者',
      description: '不该写上',
      models: [{ provider: 'p' }],
    }))
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body).error.code).toBe('INVALID_INPUT')
    expect(await roles.read('执行者')).toEqual(before)
    const cleared = await invoke('POST', COLLABORATION_ROLES_PATH, JSON.stringify({ name: '执行者', description: '清空', models: [] }))
    expect(cleared.status).toBe(200)
    expect(JSON.parse(cleared.body).models).toBeUndefined()
    expect((await roles.read('执行者')).description).toBe('清空')
  })
})

// 让 CollaborationError 被引用（类型层使用），避免 lint 误判未使用。
void (null as unknown as CollaborationError)
