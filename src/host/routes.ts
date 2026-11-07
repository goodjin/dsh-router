/**
 * HTTP 路由（计划「客户端↔宿主 API 契约」四条 exact 路由的薄壳）。
 *
 * 形状照计划逐字：
 *   GET  /router/state?workspaceId=        → RouterState（C4 起可带 redirect 指令）
 *   POST /router/router-session            → { sessionId }
 *   POST /router/answer                    → { ok: true }（已答 409）
 *   POST /router/tabs/close                → { ok: true }
 *   POST /router/redirect/ack              → { ok: true }（C4：消费去重指令）
 * 错误统一 { error: string } + 4xx/5xx。注册走 webServer.register({kind:'exact'})
 * + connection.admit 同一登录准入（r3 §3a，chat-power mermaid-asset 样例）；
 * 逻辑全部在注入的 deps（根服务组装的面），本文件只做 HTTP 折叠。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { LedgerError, type LedgerErrorCode } from './ledger/errors.ts'
import type {
  AskUserQuestionAnswerItem,
  RouterDefaults,
  RouterState,
  TypesCreateRequest,
  TypesEnabledRequest,
  TypesUpdateRequest,
  WorkerTypeRecord,
} from '../shared/view-contract.ts'

export const ROUTER_STATE_PATH = '/router/state'
export const ROUTER_SESSION_PATH = '/router/router-session'
export const ROUTER_ANSWER_PATH = '/router/answer'
export const ROUTER_TABS_CLOSE_PATH = '/router/tabs/close'
/** 入口去重指令的消费回执（v1.1 Task C4）。 */
export const ROUTER_REDIRECT_ACK_PATH = '/router/redirect/ack'
/** Worker 类型管理（v1.1 Task C3，规格 §5/§6）：同路径 GET 列表 / POST 新建 / DELETE 删。 */
export const WORKER_TYPES_PATH = '/router/worker-types'
export const WORKER_TYPES_UPDATE_PATH = '/router/worker-types/update'
export const WORKER_TYPES_ENABLED_PATH = '/router/worker-types/enabled'
/** Router 默认值（规格 §6）：GET 读 / POST 写。 */
export const ROUTER_DEFAULTS_PATH = '/router/defaults'

/** 路由需要的最小宿主面（webServer/connection 可缺席：缺席即不挂路由）。 */
export interface RouterRoutesContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer?: {
    register(route: {
      kind: 'exact'
      path: string
      handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
    }): unknown
  }
  connection?: {
    admit(request: IncomingMessage): { rejection: number } | { peer: unknown }
  }
}

/** 五条工作台路由 + 七条类型/默认值路由背后的逻辑面（根服务实现；测试用假件）。 */
export interface RouterRoutesDeps {
  getState(workspaceId?: string): Promise<RouterState>
  createRouterSession(workspaceId: string | undefined, name?: string): Promise<{ sessionId: string }>
  answerQuestion(questionId: string, answers: AskUserQuestionAnswerItem[]): Promise<void>
  closeTab(workspaceId: string, sessionId: string): Promise<boolean>
  /** 消费回执：清掉该 workspace 上指向被归档会话的 redirect 指令（幂等）。 */
  ackRedirect(workspaceId: string, supersededSessionId: string): Promise<void>
  /** Worker 类型管理（v1.1 C3）：读全量记录（含禁用与 builtin）。 */
  listWorkerTypes(): Promise<{ types: WorkerTypeRecord[] }>
  createWorkerType(input: TypesCreateRequest): Promise<{ type: WorkerTypeRecord }>
  updateWorkerType(request: TypesUpdateRequest): Promise<{ type: WorkerTypeRecord }>
  setWorkerTypeEnabled(request: TypesEnabledRequest): Promise<{ type: WorkerTypeRecord }>
  removeWorkerType(templateId: string): Promise<void>
  getDefaults(): Promise<RouterDefaults>
  saveDefaults(value: RouterDefaults): Promise<RouterDefaults>
}

/** 域错误码 → HTTP 状态。 */
function errorStatus(error: unknown): number {
  if (error instanceof SyntaxError) return 400 // 坏 JSON
  const code = error instanceof LedgerError ? (error.code as LedgerErrorCode) : undefined
  switch (code) {
    case 'already-answered':
    case 'stale-version':
    case 'illegal-transition':
    case 'dependency-cycle':
    case 'doc-exists':
    case 'template-exists':
    case 'builtin-protected':
      return 409
    case 'task-not-found':
    case 'question-not-found':
    case 'doc-not-found':
    case 'template-not-found':
      return 404
    case 'role-forbidden':
    case 'not-task-owner':
    case 'caller-unresolved':
      return 403
    case 'unknown-tool':
    case 'bad-request':
    case 'invalid-input':
      return 400
    default:
      return 500
  }
}

/** JSON 应答：no-store + 显式长度（照 auto-resume / chat-power 路由的写法）。 */
function respondJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** 读请求体（上限 1 MB，超出 413）。 */
const BODY_LIMIT = 1_000_000

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(chunks.map((chunk) => chunk.toString('utf8')).join('')))
    request.on('error', reject)
  })
}

/**
 * 挂 exact 路由。webServer/connection 缺席时不挂（观测面不挡装载）；
 * 每条路由先过 connection.admit 同一登录准入，再校验方法（一条路径可声明
 * 多个合法方法，如 worker-types 的 GET/POST/DELETE），再进逻辑。
 */
export function registerRouterRoutes(ctx: RouterRoutesContext, deps: RouterRoutesDeps): void {
  if (ctx.webServer === undefined || ctx.connection === undefined) return

  const handle = (
    path: string,
    methods: readonly ('GET' | 'POST' | 'DELETE')[],
    logic: (request: IncomingMessage) => Promise<{ status: number; body: string }>,
  ): void => {
    const allow = methods.join(', ')
    ctx.effect(
      () =>
        ctx.webServer?.register({
          kind: 'exact',
          path,
          async handler(request, response) {
            const admission = ctx.connection?.admit(request)
            if (admission !== undefined && 'rejection' in admission) {
              response.writeHead(admission.rejection)
              response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
              return
            }
            if (request.method === undefined || !methods.includes(request.method as 'GET' | 'POST' | 'DELETE')) {
              response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow })
              response.end('method not allowed')
              return
            }
            try {
              const { status, body } = await logic(request)
              respondJson(response, status, body)
            } catch (error) {
              respondJson(response, errorStatus(error), JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
            }
          },
        }),
      `dsh-router: ${allow} ${path}`,
    )
  }

  handle(ROUTER_STATE_PATH, ['GET'], async (request) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined
    const state = await deps.getState(workspaceId)
    return { status: 200, body: JSON.stringify(state) }
  })

  handle(ROUTER_SESSION_PATH, ['POST'], async (request) => {
    const body = JSON.parse(await readBody(request)) as { workspaceId?: unknown; name?: unknown }
    if (typeof body.workspaceId !== 'string' || body.workspaceId === '') {
      throw new LedgerError('bad-request', 'workspaceId 必填')
    }
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : undefined
    const created = await deps.createRouterSession(body.workspaceId, name)
    return { status: 200, body: JSON.stringify({ sessionId: created.sessionId }) }
  })

  handle(ROUTER_ANSWER_PATH, ['POST'], async (request) => {
    const body = JSON.parse(await readBody(request)) as { questionId?: unknown; answers?: unknown }
    if (typeof body.questionId !== 'string' || !Array.isArray(body.answers)) {
      throw new LedgerError('bad-request', 'questionId 与 answers 必填')
    }
    await deps.answerQuestion(body.questionId, body.answers as AskUserQuestionAnswerItem[])
    return { status: 200, body: JSON.stringify({ ok: true }) }
  })

  handle(ROUTER_TABS_CLOSE_PATH, ['POST'], async (request) => {
    const body = JSON.parse(await readBody(request)) as { workspaceId?: unknown; sessionId?: unknown }
    if (typeof body.workspaceId !== 'string' || typeof body.sessionId !== 'string') {
      throw new LedgerError('bad-request', 'workspaceId 与 sessionId 必填')
    }
    await deps.closeTab(body.workspaceId, body.sessionId)
    return { status: 200, body: JSON.stringify({ ok: true }) }
  })

  handle(ROUTER_REDIRECT_ACK_PATH, ['POST'], async (request) => {
    const body = JSON.parse(await readBody(request)) as { workspaceId?: unknown; supersededSessionId?: unknown }
    if (typeof body.workspaceId !== 'string' || typeof body.supersededSessionId !== 'string') {
      throw new LedgerError('bad-request', 'workspaceId 与 supersededSessionId 必填')
    }
    await deps.ackRedirect(body.workspaceId, body.supersededSessionId)
    return { status: 200, body: JSON.stringify({ ok: true }) }
  })

  /* ── Worker 类型管理（v1.1 Task C3）：写路径走 WorkerTypeStore，变更后由 deps 实现方触发引擎同步 ── */

  handle(WORKER_TYPES_PATH, ['GET', 'POST', 'DELETE'], async (request) => {
    if (request.method === 'GET') {
      return { status: 200, body: JSON.stringify(await deps.listWorkerTypes()) }
    }
    if (request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>
      const input = sanitizeCreateInput(body)
      const created = await deps.createWorkerType(input)
      return { status: 200, body: JSON.stringify(created) }
    }
    // DELETE：templateId 走 query
    const url = new URL(request.url ?? '/', 'http://localhost')
    const templateId = url.searchParams.get('templateId') ?? ''
    if (templateId === '') throw new LedgerError('bad-request', 'templateId 查询参数必填')
    await deps.removeWorkerType(templateId)
    return { status: 200, body: JSON.stringify({ ok: true }) }
  })

  handle(WORKER_TYPES_UPDATE_PATH, ['POST'], async (request) => {
    const body = JSON.parse(await readBody(request)) as { templateId?: unknown; patch?: unknown }
    if (typeof body.templateId !== 'string' || body.templateId === '' || body.patch === null || typeof body.patch !== 'object') {
      throw new LedgerError('bad-request', 'templateId 与 patch 必填')
    }
    const request_: TypesUpdateRequest = { templateId: body.templateId, patch: sanitizePatch(body.patch as Record<string, unknown>) }
    const updated = await deps.updateWorkerType(request_)
    return { status: 200, body: JSON.stringify(updated) }
  })

  handle(WORKER_TYPES_ENABLED_PATH, ['POST'], async (request) => {
    const body = JSON.parse(await readBody(request)) as { templateId?: unknown; enabled?: unknown }
    if (typeof body.templateId !== 'string' || body.templateId === '' || typeof body.enabled !== 'boolean') {
      throw new LedgerError('bad-request', 'templateId 与 enabled(布尔) 必填')
    }
    const request_: TypesEnabledRequest = { templateId: body.templateId, enabled: body.enabled }
    const updated = await deps.setWorkerTypeEnabled(request_)
    return { status: 200, body: JSON.stringify(updated) }
  })

  handle(ROUTER_DEFAULTS_PATH, ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') {
      return { status: 200, body: JSON.stringify(await deps.getDefaults()) }
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    if (body === null || typeof body !== 'object'
      || typeof body['routerSystemPrompt'] !== 'string' || typeof body['routerModel'] !== 'string') {
      throw new LedgerError('bad-request', 'routerSystemPrompt 与 routerModel(字符串) 必填')
    }
    const saved = await deps.saveDefaults({ routerSystemPrompt: body['routerSystemPrompt'], routerModel: body['routerModel'] })
    return { status: 200, body: JSON.stringify(saved) }
  })
}

/** 请求体字段守卫：字符串字段（缺席放行为 undefined）。 */
function pickString(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new LedgerError('bad-request', `${field} 必须是字符串`)
  return value
}

/** 请求体字段守卫：字符串数组字段（缺席放行为 undefined）。 */
function pickStringArray(source: Record<string, unknown>, field: string): string[] | undefined {
  const value = source[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new LedgerError('bad-request', `${field} 必须是字符串数组`)
  }
  return [...(value as string[])]
}

/**
 * POST /router/worker-types 的建型输入：只采纳业务字段，templateId/origin/
 * 时间戳等同名字段一律不采纳（宿主生成）；name 必填。
 */
function sanitizeCreateInput(body: Record<string, unknown>): TypesCreateRequest {
  const name = pickString(body, 'name')
  if (name === undefined || name.trim() === '') throw new LedgerError('bad-request', 'name 必填')
  const role = pickString(body, 'role')
  if (role !== undefined && role !== 'worker' && role !== 'supervisor') {
    throw new LedgerError('bad-request', 'role 只能是 worker 或 supervisor')
  }
  const input: TypesCreateRequest = { name }
  const description = pickString(body, 'description')
  const systemPrompt = pickString(body, 'systemPrompt')
  const models = pickStringArray(body, 'models')
  const skills = pickStringArray(body, 'skills')
  if (description !== undefined) input['description'] = description
  if (systemPrompt !== undefined) input['systemPrompt'] = systemPrompt
  if (models !== undefined) input['models'] = models
  if (skills !== undefined) input['skills'] = skills
  if (role !== undefined) input['role'] = role
  if (typeof body['enabled'] === 'boolean') input['enabled'] = body['enabled']
  return input
}

/** update 的 patch：只采纳可改字段（角色/启用态走各自通道，不进 patch）。 */
function sanitizePatch(raw: Record<string, unknown>): TypesUpdateRequest['patch'] {
  const patch: TypesUpdateRequest['patch'] = {}
  const name = pickString(raw, 'name')
  const description = pickString(raw, 'description')
  const systemPrompt = pickString(raw, 'systemPrompt')
  const models = pickStringArray(raw, 'models')
  const skills = pickStringArray(raw, 'skills')
  if (name !== undefined) patch['name'] = name
  if (description !== undefined) patch['description'] = description
  if (systemPrompt !== undefined) patch['systemPrompt'] = systemPrompt
  if (models !== undefined) patch['models'] = models
  if (skills !== undefined) patch['skills'] = skills
  return patch
}
