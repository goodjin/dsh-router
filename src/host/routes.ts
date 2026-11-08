/**
 * HTTP 路由（计划「客户端↔宿主 API 契约」四条 exact 路由的薄壳）。
 *
 * 形状照计划逐字：
 *   GET  /router/state?workspaceId=        → RouterState（C4 起可带 redirect 指令）
 *   POST /router/router-session            → { sessionId }
 *   POST /router/answer                    → { ok: true }（已答 409）
 *   POST /router/tabs/close                → { ok: true }
 * 错误统一 { error: string } + 4xx/5xx。注册走 webServer.register({kind:'exact'})
 * + connection.admit 同一登录准入（r3 §3a，chat-power mermaid-asset 样例）；
 * 逻辑全部在注入的 deps（根服务组装的面），本文件只做 HTTP 折叠。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { LedgerError, type LedgerErrorCode } from './ledger/errors.ts'
import type { TaskStatus } from '../shared/types.ts'
import type { BreakerVisibility } from './guard/breaker.ts'
import type { EmergencyPauseReport } from './guard/emergency.ts'
import type {
  AskUserQuestionAnswerItem,
  RouterDefaults,
  RouterState,
  SessionPromptResponse,
  SpawnModeResponse,
  TypesCreateRequest,
  TypesEnabledRequest,
  TypesItemResponse,
  TypesListResponse,
  TypesUpdateRequest,
  WorkerSpawnMode,
  WorkerTypeRecord,
} from '../shared/view-contract.ts'

export const ROUTER_STATE_PATH = '/router/state'
export const ROUTER_SESSION_PATH = '/router/router-session'
export const ROUTER_ANSWER_PATH = '/router/answer'
export const ROUTER_TABS_CLOSE_PATH = '/router/tabs/close'
/** 入口去重指令的消费回执（v1.1 Task C4）。 */
/** Worker 类型管理（v1.1 Task C3，规格 §5/§6）：同路径 GET 列表 / POST 新建 / DELETE 删。 */
export const WORKER_TYPES_PATH = '/router/worker-types'
export const WORKER_TYPES_UPDATE_PATH = '/router/worker-types/update'
export const WORKER_TYPES_ENABLED_PATH = '/router/worker-types/enabled'
/** Router 默认值（规格 §6）：GET 读 / POST 写。 */
export const ROUTER_NOTIFICATIONS_ACK_PATH = '/router/notifications/ack'
export const ROUTER_DEFAULTS_PATH = '/router/defaults'
/** worker 派生模式（v1.3 C2，规格 §1）：GET 读 / POST 写（volatile，即时生效）。 */
export const ROUTER_SPAWN_MODE_PATH = '/router/spawn-mode'
/** 会话级 Router 系统提示词（v1.1 C5，规格 §7）：GET 读 / PUT 写（空串=清除回落默认）。 */
export const ROUTER_PROMPT_PATH = '/router/prompt'
/** 用户发起的任务控制（v1.2 Task B4）：镜像 control_task + 用户专属 redispatch。 */
export const ROUTER_TASKS_CONTROL_PATH = '/router/tasks/control'
/** 用户解除派发冻结（v1.2 Task B4；冻结的解除通道）。 */
export const ROUTER_BREAKER_UNFREEZE_PATH = '/router/breaker/unfreeze'
/** 紧急暂停（v1.2 Task B4）：冻结 + 逐会话中断 + 异常通知。 */
export const ROUTER_EMERGENCY_PAUSE_PATH = '/router/emergency-pause'
/** 轻量诊断（v1.4）：索引 + 收编计数口径，无私有内容。 */
export const ROUTER_HEALTH_PATH = '/router/health'

/** 用户侧任务控制动作（前三个镜像 control_task 工具；redispatch 仅用户通道）。 */
export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'redispatch'

/** 解除冻结的报告：冻结前/后的可见投影（lossless，reason/frozenAt 只在冻结时出现）。 */
export interface BreakerUnfreezeReport {
  before: BreakerVisibility
  after: BreakerVisibility
}

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
    /** Worker 类型管理（v1.1 C3）：读全量记录（含禁用与 builtin）。 */
  listWorkerTypes(): Promise<TypesListResponse>
  createWorkerType(input: TypesCreateRequest): Promise<TypesItemResponse>
  updateWorkerType(request: TypesUpdateRequest): Promise<TypesItemResponse>
  setWorkerTypeEnabled(request: TypesEnabledRequest): Promise<TypesItemResponse>
  removeWorkerType(templateId: string): Promise<void>
  getDefaults(): Promise<RouterDefaults>
  saveDefaults(value: RouterDefaults): Promise<RouterDefaults>
  /** 读当前生效的 worker 派生模式（v1.3 C2；volatile：重启后回到启动配置值）。 */
  getSpawnMode(): Promise<SpawnModeResponse>
  /** 写 worker 派生模式（即时生效；合法值由路由层守卫，非两枚举值 400）。 */
  saveSpawnMode(mode: WorkerSpawnMode): Promise<SpawnModeResponse>
  /** 通知卡确认（v1.2 B3/C1）：消费后清除展示。 */
  ackNotification(cardId: string): Promise<boolean>
  /** 会话级系统提示词（v1.1 C5）：读当前生效文本 + 是否默认标记。 */
  getSessionPrompt(sessionId: string): Promise<SessionPromptResponse>
  /** 写会话覆盖（prompt 空串 = 清除回落默认）；写后下一轮 system prompt 组装即生效。 */
  saveSessionPrompt(sessionId: string, prompt: string): Promise<void>
  /**
   * 用户发起的任务控制（v1.2 B4）：pause/resume/cancel 镜像 control_task 工具
   * 语义（尊重既有状态机），redispatch = 补充「用户重派」+ 重派（受熔断约束，
   * 冻结时以 dispatch-frozen 拒绝并提示先解除）。用户动作绕过模型侧预算。
   */
  controlTask(taskId: string, action: TaskControlAction): Promise<{ status: TaskStatus }>
  /** 用户解除派发冻结（v1.2 B4）：返回冻结前/后的可见投影。 */
  unfreezeBreaker(): Promise<BreakerUnfreezeReport>
  /** 紧急暂停（v1.2 B4）：冻结 + 逐会话中断 + 异常通知；逐项结果失败项如实列出。 */
  emergencyPause(): Promise<EmergencyPauseReport>
  /**
   * 轻量诊断报告（v1.4 GET /router/health）：SessionHeaderIndex 计数 + 收编
   * 计数。只报计数与状态名，不含会话 id/路径等私有内容。
   */
  getHealth(): Promise<Record<string, unknown>>
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
    case 'card-not-found':
    case 'task-not-found':
    case 'question-not-found':
    case 'doc-not-found':
    case 'template-not-found':
      return 404
    case 'role-forbidden':
    case 'not-task-owner':
    case 'caller-unresolved':
      return 403
    /** 派发冻结/预算类拒绝都是「状态冲突，先解除再操作」→ 409。 */
    case 'dispatch-frozen':
    case 'supervisor-failure-budget':
    case 'per-turn-task-budget':
      return 409
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
    methods: readonly ('GET' | 'POST' | 'PUT' | 'DELETE')[],
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
            if (request.method === undefined || !methods.includes(request.method as 'GET' | 'POST' | 'PUT' | 'DELETE')) {
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

  handle(ROUTER_NOTIFICATIONS_ACK_PATH, ['POST'], async (request) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    if (body === null || typeof body !== 'object' || typeof body['cardId'] !== 'string' || body['cardId'] === '') {
      throw new LedgerError('bad-request', 'cardId(字符串) 必填')
    }
    const acked = await deps.ackNotification(body['cardId'])
    if (!acked) throw new LedgerError('card-not-found', `通知卡不存在或已确认: ${body['cardId']}`)
    return { status: 200, body: JSON.stringify({ ok: true }) }
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

  /* ── worker 派生模式（v1.3 Task C2，规格 §1）：GET 读 / POST 写 ── */

  handle(ROUTER_SPAWN_MODE_PATH, ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') {
      return { status: 200, body: JSON.stringify(await deps.getSpawnMode()) }
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    const mode = body['mode']
    if (mode !== 'cache-priority' && mode !== 'minimal-face') {
      throw new LedgerError('bad-request', "mode 必须是 'cache-priority' | 'minimal-face' 之一")
    }
    const saved = await deps.saveSpawnMode(mode)
    return { status: 200, body: JSON.stringify(saved) }
  })

  /* ── 会话级系统提示词（v1.1 Task C5，规格 §7）：GET 读 / PUT 写 ── */

  handle(ROUTER_PROMPT_PATH, ['GET', 'PUT'], async (request) => {
    if (request.method === 'GET') {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (sessionId === '') throw new LedgerError('bad-request', 'sessionId 查询参数必填')
      const prompt = await deps.getSessionPrompt(sessionId)
      return { status: 200, body: JSON.stringify(prompt) }
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    if (body === null || typeof body !== 'object'
      || typeof body['sessionId'] !== 'string' || body['sessionId'] === ''
      || typeof body['prompt'] !== 'string') {
      throw new LedgerError('bad-request', 'sessionId(字符串) 与 prompt(字符串) 必填；prompt 空串 = 清除覆盖')
    }
    await deps.saveSessionPrompt(body['sessionId'], body['prompt'])
    return { status: 200, body: JSON.stringify({ ok: true }) }
  })

  /* ── 用户控制与紧急暂停（v1.2 Task B4）：逻辑在 deps（根服务组装），此处只折叠 HTTP ── */

  handle(ROUTER_TASKS_CONTROL_PATH, ['POST'], async (request) => {
    const body = JSON.parse(await readBody(request)) as { taskId?: unknown; action?: unknown }
    if (typeof body.taskId !== 'string' || body.taskId === '') {
      throw new LedgerError('bad-request', 'taskId 必填')
    }
    const action = body.action
    if (action !== 'pause' && action !== 'resume' && action !== 'cancel' && action !== 'redispatch') {
      throw new LedgerError('bad-request', "action 必须是 'pause' | 'resume' | 'cancel' | 'redispatch' 之一")
    }
    const result = await deps.controlTask(body.taskId, action)
    return { status: 200, body: JSON.stringify(result) }
  })

  handle(ROUTER_BREAKER_UNFREEZE_PATH, ['POST'], async () => {
    const report = await deps.unfreezeBreaker()
    return { status: 200, body: JSON.stringify(report) }
  })

  handle(ROUTER_EMERGENCY_PAUSE_PATH, ['POST'], async () => {
    const report = await deps.emergencyPause()
    return { status: 200, body: JSON.stringify(report) }
  })

  /* ── 轻量诊断（v1.4）：索引 + 收编计数口径，无私有内容 ── */

  handle(ROUTER_HEALTH_PATH, ['GET'], async () => {
    const report = await deps.getHealth()
    return { status: 200, body: JSON.stringify(report) }
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
