/**
 * Worker 类型 / Router 默认值路由测试（v1.1 计划 Task C3，规格 §5/§6）。
 *
 * 七条新 exact 路由（简报逐字；路径不含 ：id，body/query 携带标识）：
 *   GET    /router/worker-types            → { types: WorkerTypeRecord[] }
 *   POST   /router/worker-types            → { type }（新建；templateId/origin/时间戳宿主生成）
 *   POST   /router/worker-types/update     → { type }（body {templateId, patch}）
 *   POST   /router/worker-types/enabled    → { type }（body {templateId, enabled}）
 *   DELETE /router/worker-types?templateId → { ok: true }（builtin 拒 409）
 *   GET    /router/defaults                → RouterDefaults
 *   POST   /router/defaults                → RouterDefaults
 *
 * deps 用假 store（内存 CRUD，与 WorkerTypeStore 同错误码语义）驱动，
 * 断言 HTTP 折叠层：路径/方法/请求体/响应体/状态码。不启网络。
 */

import { describe, expect, it } from 'vitest'

import { LedgerError } from '../src/host/ledger/errors.ts'
import {
  registerRouterRoutes,
  type RouterRoutesContext,
  type RouterRoutesDeps,
} from '../src/host/routes.ts'
import {
  builtinGeneralType,
} from '../src/host/templates.ts'
import type {
  RouterDefaults,
  TypesCreateRequest,
  TypesUpdateRequest,
  WorkerSpawnMode,
  WorkerTypeRecord,
} from '../src/shared/view-contract.ts'

/* ────────────────────────── 假 HTTP 上下文（照 bridge-questions 同款） ────────────────────────── */

interface CapturedResponse { status: number; headers: Record<string, unknown>; body: string }

function fakeHttpContext() {
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }> = []
  const ctx = {
    effect(factory: () => unknown) {
      ;(factory as () => unknown)()
      return () => {}
    },
    webServer: {
      register(route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) {
        routes.push({ path: route.path, handler: route.handler })
      },
    },
    connection: {
      admit() {
        return { peer: {} }
      },
    },
  }
  return { ctx: ctx as unknown as RouterRoutesContext, routes: routes as Array<{ path: string; handler: (req: IncomingMessageLike, res: unknown) => Promise<void> | void }> }
}

interface IncomingMessageLike {
  method?: string
  url?: string
  on(event: string, listener: (...args: unknown[]) => void): void
}

/** 组一个假请求/应答对；body 为 JSON 字符串。 */
function fakeExchange(method: string, url: string, body?: string) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const req: IncomingMessageLike = {
    method,
    url,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'data') chunks.forEach((chunk) => listener(chunk))
      if (event === 'end') listener()
    },
  }
  const captured = {} as CapturedResponse
  const res = {
    writeHead(status: number, hdrs?: Record<string, unknown>) {
      captured.status = status
      captured.headers = hdrs ?? {}
    },
    end(payload?: string) {
      captured.body = payload ?? ''
    },
  }
  return { req, res, captured }
}

/* ────────────────────────── 假 store（内存版，错误码与 WorkerTypeStore 同语义） ────────────────────────── */

const BUILTIN = builtinGeneralType(1)

function fakeStores(seed: WorkerTypeRecord[] = []) {
  let rows: WorkerTypeRecord[] = [structuredClone(BUILTIN), ...seed]
  let defaults: RouterDefaults = { routerSystemPrompt: '静态兜底 Router 提示词', routerModel: '' }
  const promptsMap = new Map<string, string>()
  let clock = 10
  const calls: string[] = []
  const store = {
    async list(): Promise<WorkerTypeRecord[]> {
      calls.push('list')
      return structuredClone(rows)
    },
    async create(input: TypesCreateRequest): Promise<WorkerTypeRecord> {
      calls.push(`create:${input.name}`)
      const name = input.name.trim()
      if (name === '') throw new LedgerError('invalid-input', 'worker 类型名不能为空')
      if (rows.some((row) => row.name === name)) throw new LedgerError('template-exists', `同名: ${name}`)
      const at = ++clock
      const record: WorkerTypeRecord = {
        templateId: `t-${at}`,
        name,
        description: input.description ?? '',
        role: input.role ?? 'worker',
        models: [...(input.models ?? [])],
        systemPrompt: input.systemPrompt ?? '缺省提示词',
        skills: [...(input.skills ?? [])],
        enabled: input.enabled ?? true,
        origin: 'user',
        createdAt: at,
        updatedAt: at,
      }
      rows = [...rows, record]
      return structuredClone(record)
    },
    async update(templateId: string, patch: Partial<Pick<WorkerTypeRecord, 'name' | 'description' | 'models' | 'systemPrompt' | 'skills'>>): Promise<WorkerTypeRecord> {
      calls.push(`update:${templateId}`)
      const index = rows.findIndex((row) => row.templateId === templateId)
      if (index < 0) throw new LedgerError('template-not-found', `不存在: ${templateId}`)
      if (rows[index]!.origin === 'builtin') throw new LedgerError('builtin-protected', '内置不可改')
      const next = { ...rows[index]!, ...structuredClone(patch), updatedAt: ++clock }
      rows = rows.map((row, i) => (i === index ? next : row))
      return structuredClone(next)
    },
    async setEnabled(templateId: string, enabled: boolean): Promise<WorkerTypeRecord> {
      calls.push(`enabled:${templateId}:${String(enabled)}`)
      const index = rows.findIndex((row) => row.templateId === templateId)
      if (index < 0) throw new LedgerError('template-not-found', `不存在: ${templateId}`)
      if (rows[index]!.origin === 'builtin' && !enabled) throw new LedgerError('builtin-protected', '内置不可禁用')
      const next = { ...rows[index]!, enabled, updatedAt: ++clock }
      rows = rows.map((row, i) => (i === index ? next : row))
      return structuredClone(next)
    },
    async remove(templateId: string): Promise<void> {
      calls.push(`remove:${templateId}`)
      const found = rows.find((row) => row.templateId === templateId)
      if (found === undefined) throw new LedgerError('template-not-found', `不存在: ${templateId}`)
      if (found.origin === 'builtin') throw new LedgerError('builtin-protected', '内置不可删')
      rows = rows.filter((row) => row.templateId !== templateId)
    },
  }
  const defaultsStore = {
    async get(): Promise<RouterDefaults> {
      calls.push('defaults:get')
      return { ...defaults }
    },
    async set(value: RouterDefaults): Promise<RouterDefaults> {
      calls.push(`defaults:set:${value.routerModel}`)
      defaults = { ...value }
      return { ...defaults }
    },
  }
  /** 会话提示词假面（与 SessionPromptStore + 默认值缓存同语义；记录调用）。 */
  const prompts = {
    get(sessionId: string): { prompt: string; isDefault: boolean } {
      const override = promptsMap.get(sessionId)
      return override !== undefined
        ? { prompt: override, isDefault: false }
        : { prompt: defaults.routerSystemPrompt, isDefault: true }
    },
    async set(sessionId: string, text: string): Promise<void> {
      calls.push(`set-prompt:${sessionId}`)
      promptsMap.set(sessionId, text)
    },
    async clear(sessionId: string): Promise<void> {
      calls.push(`clear-prompt:${sessionId}`)
      promptsMap.delete(sessionId)
    },
  }
  return { store, defaultsStore, prompts, calls }
}

/** 组路由 deps：假 store + 引擎同步桩（记录调用，断言写路径触发同步）。 */
function fakeDeps(factories?: {
  store?: ReturnType<typeof fakeStores>['store']
  defaultsStore?: ReturnType<typeof fakeStores>['defaultsStore']
  prompts?: ReturnType<typeof fakeStores>['prompts']
}): RouterRoutesDeps & { calls: string[]; synced: string[] } {
  const { store, defaultsStore, prompts, calls } = fakeStores()
  const usedStore = factories?.store ?? store
  const usedDefaults = factories?.defaultsStore ?? defaultsStore
  const usedPrompts = factories?.prompts ?? prompts
  const synced: string[] = []
  return {
    calls,
    synced,
    async getSessionPrompt(sessionId: string) {
      return usedPrompts.get(sessionId)
    },
    async saveSessionPrompt(sessionId: string, text: string) {
      if (text === '') await usedPrompts.clear(sessionId)
      else await usedPrompts.set(sessionId, text)
    },
    // v1.2 B3 通知确认桩：本文件用例不触达。
    async ackNotification() {
      return false
    },
    // v1.4 诊断路由桩：本文件用例不触达。
    async getHealth() {
      return {}
    },
    // B4 控制路由桩：本文件用例只打类型/默认值/提示词路由，桩只为满足 deps 形状。
    async controlTask(taskId: string, action: string) {
      calls.push(`control:${taskId}:${action}`)
      return { status: 'paused' as const }
    },
    async unfreezeBreaker() {
      calls.push('unfreeze')
      return { before: { frozen: true }, after: { frozen: false } }
    },
    async scopedPause(routerSessionId: string) {
      calls.push('scoped-pause')
      return { tasks: [], pausedCount: 0, failedCount: 0, notified: true }
    },
    async getState() {
      return {
        routerSessions: [], tasks: [], questions: [], tabs: [],
        templates: [], types: [],
      }
    },
    async createRouterSession() {
      return { sessionId: 'r' }
    },
    async answerQuestion() {},
    async closeTab() {
      return true
    },
    async listWorkerTypes() {
      return { types: await usedStore.list() }
    },
    async createWorkerType(input) {
      const type = await usedStore.create(input)
      if (type.enabled) synced.push(`register:${type.templateId}`)
      return { type }
    },
    async updateWorkerType(request: TypesUpdateRequest) {
      const type = await usedStore.update(request.templateId, request.patch)
      if (type.enabled) synced.push(`register:${type.templateId}`)
      return { type }
    },
    async setWorkerTypeEnabled(request: { templateId: string; enabled: boolean }) {
      const type = await usedStore.setEnabled(request.templateId, request.enabled)
      if (type.enabled) synced.push(`register:${type.templateId}`)
      return { type }
    },
    async removeWorkerType(templateId: string) {
      await usedStore.remove(templateId)
      synced.push(`unregister:${templateId}`)
    },
    async getDefaults() {
      return usedDefaults.get()
    },
    async saveDefaults(value: RouterDefaults) {
      const saved = await usedDefaults.set(value)
      synced.push('router-preset')
      return saved
    },
    // v1.3 C2 spawn-mode 桩：本文件用例不触达，只为满足 deps 形状。
    async getSpawnMode() {
      return { mode: 'cache-priority' as const }
    },
    async saveSpawnMode(mode: WorkerSpawnMode) {
      return { mode }
    },
  }
}

/** 按路径找 handler。 */
function handlerOf(routes: Array<{ path: string; handler: unknown }>, path: string): (req: unknown, res: unknown) => Promise<void> {
  const found = routes.find((route) => route.path === path)
  expect(found, `路由 ${path} 应已挂上`).toBeDefined()
  return found!.handler as (req: unknown, res: unknown) => Promise<void>
}

/* ────────────────────────── 断言 ────────────────────────── */

describe('worker 类型路由（C3）', () => {
  it('新 exact 路由全部挂上（C3 七条 + C5 会话提示词一条 + B4 控制三条 + v1.3 C2 spawn-mode）', () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    expect(routes.map((r) => r.path)).toEqual([
      '/router/state',
      '/router/router-session',
      '/router/answer',
      '/router/tabs/close',
      '/router/worker-types',
      '/router/worker-types/update',
      '/router/worker-types/enabled',
      '/router/notifications/ack',
      '/router/defaults',
      '/router/spawn-mode',
      '/router/prompt',
      '/router/tasks/control',
      '/router/breaker/unfreeze',
      '/router/emergency-pause',
      '/router/health',
    ])
  })

  it('GET /router/worker-types → {types:[...]}（全量记录，含 builtin）', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('GET', '/router/worker-types')
    await handlerOf(routes, '/router/worker-types')(req, res)
    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body!) as { types: WorkerTypeRecord[] }
    expect(body.types).toHaveLength(1)
    expect(body.types[0]).toMatchObject({ templateId: 'general', origin: 'builtin' })
    expect(captured.headers['cache-control']).toBe('no-store')
  })

  it('POST /router/worker-types 新建 → {type}（宿主生成 templateId/origin/时间戳，body 里的不采纳）', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const payload = {
      name: '文档写手',
      description: '写文档',
      role: 'worker',
      models: ['p/m1', 'p/m2'],
      systemPrompt: '你是文档写手',
      skills: ['doc'],
      enabled: true,
      // 客户端不应送、宿主也不采纳的字段：
      templateId: 'hacked',
      origin: 'builtin',
      createdAt: 1,
      updatedAt: 1,
    }
    const { req, res, captured } = fakeExchange('POST', '/router/worker-types', JSON.stringify(payload))
    await handlerOf(routes, '/router/worker-types')(req, res)
    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body!) as { type: WorkerTypeRecord }
    expect(body.type.name).toBe('文档写手')
    expect(body.type.templateId).not.toBe('hacked')
    expect(body.type.origin).toBe('user')
    expect(body.type.models).toEqual(['p/m1', 'p/m2'])
    expect(deps.synced).toEqual([`register:${body.type.templateId}`]) // 创建即触发引擎同步
  })

  it('POST /router/worker-types 名字为空 → 400 invalid-input', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('POST', '/router/worker-types', JSON.stringify({ name: '  ' }))
    await handlerOf(routes, '/router/worker-types')(req, res)
    expect(captured.status).toBe(400)
    expect(JSON.parse(captured.body!)).toMatchObject({ error: expect.any(String) })
  })

  it('POST /router/worker-types/update {templateId, patch} → {type}', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const created = await deps.createWorkerType({ name: '旧名' })
    const request: TypesUpdateRequest = {
      templateId: created.type.templateId,
      patch: { description: '改过', models: ['x/y'], systemPrompt: '新提示词', skills: [], name: '新名' },
    }
    const { req, res, captured } = fakeExchange('POST', '/router/worker-types/update', JSON.stringify(request))
    await handlerOf(routes, '/router/worker-types/update')(req, res)
    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body!) as { type: WorkerTypeRecord }
    expect(body.type).toMatchObject({ templateId: created.type.templateId, name: '新名', description: '改过', models: ['x/y'], systemPrompt: '新提示词' })
    expect(deps.synced).toEqual([`register:${created.type.templateId}`, `register:${created.type.templateId}`])
  })

  it('POST /router/worker-types/enabled {templateId, enabled:false} → {type}（禁用不触发注册同步）', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const created = await deps.createWorkerType({ name: '停用我' })
    deps.synced.length = 0
    const { req, res, captured } = fakeExchange(
      'POST',
      '/router/worker-types/enabled',
      JSON.stringify({ templateId: created.type.templateId, enabled: false }),
    )
    await handlerOf(routes, '/router/worker-types/enabled')(req, res)
    expect(captured.status).toBe(200)
    expect((JSON.parse(captured.body!) as { type: WorkerTypeRecord }).type.enabled).toBe(false)
    expect(deps.synced).toEqual([]) // 禁用 = 保留注册只拒派发（r4 §4），不重注册
  })

  it('DELETE /router/worker-types?templateId= → {ok:true}；builtin 拒 409；未知 404', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const created = await deps.createWorkerType({ name: '删得掉' })

    const del = fakeExchange('DELETE', `/router/worker-types?templateId=${created.type.templateId}`)
    await handlerOf(routes, '/router/worker-types')(del.req, del.res)
    expect(del.captured.status).toBe(200)
    expect(JSON.parse(del.captured.body!)).toEqual({ ok: true })
    expect(deps.synced).toEqual([`register:${created.type.templateId}`, `unregister:${created.type.templateId}`])

    const delBuiltin = fakeExchange('DELETE', '/router/worker-types?templateId=general')
    await handlerOf(routes, '/router/worker-types')(delBuiltin.req, delBuiltin.res)
    expect(delBuiltin.captured.status).toBe(409)
    expect(JSON.parse(delBuiltin.captured.body!)).toMatchObject({ error: expect.any(String) })

    const delGhost = fakeExchange('DELETE', '/router/worker-types?templateId=ghost')
    await handlerOf(routes, '/router/worker-types')(delGhost.req, delGhost.res)
    expect(delGhost.captured.status).toBe(404)
  })

  it('DELETE 缺 templateId 查询参数 → 400', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('DELETE', '/router/worker-types')
    await handlerOf(routes, '/router/worker-types')(req, res)
    expect(captured.status).toBe(400)
  })

  it('写路径对 builtin 的保护：update / enabled(false) 都 409', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const upd = fakeExchange('POST', '/router/worker-types/update', JSON.stringify({ templateId: 'general', patch: { name: '改名' } }))
    await handlerOf(routes, '/router/worker-types/update')(upd.req, upd.res)
    expect(upd.captured.status).toBe(409)

    const dis = fakeExchange('POST', '/router/worker-types/enabled', JSON.stringify({ templateId: 'general', enabled: false }))
    await handlerOf(routes, '/router/worker-types/enabled')(dis.req, dis.res)
    expect(dis.captured.status).toBe(409)
  })

  it('update 未知 templateId → 404', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('POST', '/router/worker-types/update', JSON.stringify({ templateId: 'ghost', patch: { name: 'x' } }))
    await handlerOf(routes, '/router/worker-types/update')(req, res)
    expect(captured.status).toBe(404)
  })

  it('update/enabled 请求体缺字段 → 400', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const noId = fakeExchange('POST', '/router/worker-types/update', JSON.stringify({ patch: { name: 'x' } }))
    await handlerOf(routes, '/router/worker-types/update')(noId.req, noId.res)
    expect(noId.captured.status).toBe(400)

    const noEnabled = fakeExchange('POST', '/router/worker-types/enabled', JSON.stringify({ templateId: 't-1' }))
    await handlerOf(routes, '/router/worker-types/enabled')(noEnabled.req, noEnabled.res)
    expect(noEnabled.captured.status).toBe(400)
  })

  it('同路径方法不对 → 405（GET/POST 双方法路径各自校验）', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const wrongDelete = fakeExchange('PUT', '/router/worker-types', '{}')
    await handlerOf(routes, '/router/worker-types')(wrongDelete.req, wrongDelete.res)
    expect(wrongDelete.captured.status).toBe(405)

    const wrongGet = fakeExchange('POST', '/router/defaults', JSON.stringify({ routerSystemPrompt: 'x', routerModel: '' }))
    await handlerOf(routes, '/router/defaults')(wrongGet.req, wrongGet.res)
    expect(wrongGet.captured.status).toBe(200) // POST /router/defaults 是合法方法（合法体 → 200）
    const wrongOnUpdate = fakeExchange('GET', '/router/worker-types/update')
    await handlerOf(routes, '/router/worker-types/update')(wrongOnUpdate.req, wrongOnUpdate.res)
    expect(wrongOnUpdate.captured.status).toBe(405)
  })
})

describe('Router 默认值路由（C3）', () => {
  it('GET /router/defaults → RouterDefaults', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('GET', '/router/defaults')
    await handlerOf(routes, '/router/defaults')(req, res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ routerSystemPrompt: '静态兜底 Router 提示词', routerModel: '' })
  })

  it('POST /router/defaults 存值 → 回写后的 RouterDefaults，并触发 Router 预设同步', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const payload: RouterDefaults = { routerSystemPrompt: '自定义默认提示词', routerModel: 'p/model-a' }
    const { req, res, captured } = fakeExchange('POST', '/router/defaults', JSON.stringify(payload))
    await handlerOf(routes, '/router/defaults')(req, res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual(payload)
    expect(deps.synced).toEqual(['router-preset'])
    // 读回也是新值
    const got = fakeExchange('GET', '/router/defaults')
    await handlerOf(routes, '/router/defaults')(got.req, got.res)
    expect(JSON.parse(got.captured.body!)).toEqual(payload)
  })

  it('POST /router/defaults 体不是对象或缺字符串字段 → 400', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const bad = fakeExchange('POST', '/router/defaults', JSON.stringify({ routerSystemPrompt: 42, routerModel: '' }))
    await handlerOf(routes, '/router/defaults')(bad.req, bad.res)
    expect(bad.captured.status).toBe(400)

    const worse = fakeExchange('POST', '/router/defaults', '[]')
    await handlerOf(routes, '/router/defaults')(worse.req, worse.res)
    expect(worse.captured.status).toBe(400)
  })
})

/* ────────────────────────── 会话提示词路由（v1.1 Task C5，规格 §7） ────────────────────────── */

describe('会话系统提示词路由（C5）', () => {
  it('路径挂上：/router/prompt 进 exact 路由清单', () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    expect(routes.map((r) => r.path)).toContain('/router/prompt')
  })

  it('GET /router/prompt?sessionId= 有覆盖 → {prompt, isDefault:false}', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    await deps.saveSessionPrompt('s-router', '本会话覆盖')
    const { req, res, captured } = fakeExchange('GET', '/router/prompt?sessionId=s-router')
    await handlerOf(routes, '/router/prompt')(req, res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ prompt: '本会话覆盖', isDefault: false })
  })

  it('GET /router/prompt?sessionId= 无覆盖 → 回落默认文本 + isDefault:true 标记', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const { req, res, captured } = fakeExchange('GET', '/router/prompt?sessionId=s-other')
    await handlerOf(routes, '/router/prompt')(req, res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ prompt: '静态兜底 Router 提示词', isDefault: true })
  })

  it('GET 缺 sessionId 查询参数 → 400', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('GET', '/router/prompt')
    await handlerOf(routes, '/router/prompt')(req, res)
    expect(captured.status).toBe(400)
  })

  it('PUT /router/prompt {sessionId, prompt} → {ok:true}，覆盖生效（写后下一轮组装即用新文本）', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const { req, res, captured } = fakeExchange('PUT', '/router/prompt', JSON.stringify({ sessionId: 's-router', prompt: '改后的提示词' }))
    await handlerOf(routes, '/router/prompt')(req, res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body!)).toEqual({ ok: true })
    expect(deps.calls).toContain('set-prompt:s-router')
    const got = fakeExchange('GET', '/router/prompt?sessionId=s-router')
    await handlerOf(routes, '/router/prompt')(got.req, got.res)
    expect(JSON.parse(got.captured.body!)).toEqual({ prompt: '改后的提示词', isDefault: false })
  })

  it('PUT prompt 为空串 → 清除覆盖回落默认（isDefault 回 true）', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    await deps.saveSessionPrompt('s-router', '旧覆盖')
    const { req, res, captured } = fakeExchange('PUT', '/router/prompt', JSON.stringify({ sessionId: 's-router', prompt: '' }))
    await handlerOf(routes, '/router/prompt')(req, res)
    expect(captured.status).toBe(200)
    expect(deps.calls).toContain('clear-prompt:s-router')
    const got = fakeExchange('GET', '/router/prompt?sessionId=s-router')
    await handlerOf(routes, '/router/prompt')(got.req, got.res)
    expect(JSON.parse(got.captured.body!)).toEqual({ prompt: '静态兜底 Router 提示词', isDefault: true })
  })

  it('PUT 体缺 sessionId / prompt 不是字符串 → 400', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    for (const body of [
      JSON.stringify({ prompt: 'x' }),
      JSON.stringify({ sessionId: 's' }),
      JSON.stringify({ sessionId: 's', prompt: 42 }),
      '[]',
    ]) {
      const { req, res, captured } = fakeExchange('PUT', '/router/prompt', body)
      await handlerOf(routes, '/router/prompt')(req, res)
      expect(captured.status, body).toBe(400)
    }
  })

  it('GET/PUT 之外的方法 → 405（allow 头带 PUT）', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('POST', '/router/prompt', '{}')
    await handlerOf(routes, '/router/prompt')(req, res)
    expect(captured.status).toBe(405)
    expect(captured.headers['allow']).toContain('PUT')
  })
})