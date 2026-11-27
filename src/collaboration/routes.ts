/**
 * 轻量协作宿主薄路由（计划 Task 3，Layer 4）。
 *
 * 前缀 `/router/collaboration`，三条只读/模板路由：
 *   GET  /records?rootSessionId=&taskId=&kind=  → WorkRecord[]（复用 RecordStore.list）
 *   GET  /record?rootSessionId=&taskId=&recordId= → SavedRecord（复用 RecordStore.read）
 *   GET  /roles                                 → RoleTemplate[]（复用 RoleStore.list）
 *   POST /roles {id?,name,description,models?}  → RoleTemplate（带 id 按 ID 更新、不带 id 新建）
 *   GET  /models                                → 可路由模型清单（sessionController.modelCatalog；缺席时 200 且 unavailable）
 *
 * 第一版工作台只读任务资料：记录修改由模型工具负责，宿主不挂任务写/控制路由
 * （旧 /router/tasks/control 等一概不注册）。本文件只折叠 HTTP，逻辑全部在注入的
 * 真实 RecordStore/RoleStore——与模型工具 router_role_list/router_role_save 共享同一
 * RoleStore 单实例（routes_reuse_store）。不 import 旧 host/routes（旧 core 依赖树）。
 *
 * 准入与错误口径（与现有 same-origin 协议一致）：
 *  - 每条请求先过 connection.admit 同一登录准入，再进 datastore IO（admit 拒绝零 IO）；
 *  - 未识别方法 405（带 allow 头）；坏 JSON 400；POST 体 1MiB 上限 413；
 *  - CollaborationError 按 code 映射：INVALID_INPUT 400 / NOT_FOUND 404 /
 *    CORRUPT_RECORD 500 / IO_ERROR 500；
 *  - 原始失败一律 `{error:{code,message}}` 透出，不伪装成 200/空列表。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { CollaborationError, type RecordQuery, type RecordStore, type RoleStore } from './types.ts'

/** 三条路由前缀（与客户端 api 一侧逐字对齐）。 */
export const COLLABORATION_RECORDS_PATH = '/router/collaboration/records'
export const COLLABORATION_RECORD_PATH = '/router/collaboration/record'
export const COLLABORATION_ROLES_PATH = '/router/collaboration/roles'
export const COLLABORATION_MODELS_PATH = '/router/collaboration/models'

/** 模型切换（派发时自动选模型）用的 llm 最小面。不要放进 webServer 那组必需 inject。 */
export interface CollaborationLlm {
  listProviders(): Promise<ReadonlyArray<{ id: string; name: string }>> | ReadonlyArray<{ id: string; name: string }>
  listModels(provider: string): Promise<ReadonlyArray<{ id: string; name: string }>> | ReadonlyArray<{ id: string; name: string }>
}

/** Host 模型目录里的一个可路由模型（只取 id/name，其余宿主字段忽略）。 */
export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: unknown
}

/** Host 模型目录里的一个可路由提供方分组（界面模型选择器同一份）。 */
export interface ModelProviderGroup {
  id: string
  name: string
  models: readonly ModelCatalogModel[]
}

/** Host 模型目录里拿不到的提供方（界面模型选择器不显示）。 */
export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** sessionController.modelCatalog() 的返回（宿主类型定义；界面模型选择器同一份）。 */
export interface ModelCatalog {
  default: unknown
  routableProviders: readonly string[]
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
}

/** 会话控制器最小面（models 路由用；可选依赖，缺席即清单 unavailable）。 */
export interface CollaborationSessionController {
  modelCatalog(): Promise<ModelCatalog> | ModelCatalog
}

/** POST 体上限：1MiB（1024×1024）简单 UI 传输限（非源存储约束）；按累计字节计，非 string 长度。 */
const BODY_LIMIT = 1024 * 1024

/**
 * 请求体超过 1MiB 上限。HTTP 层传输契约错误，**不进** CollaborationError 枚举
 * （该枚举只容记录/模板四码），由 errorStatus 映射 413、errorCodeOf 给 BODY_TOO_LARGE。
 */
class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BodyTooLargeError'
  }
}

/** 路由需要的最小宿主面（webServer/connection 可缺席：缺席即不挂路由）。 */
export interface CollaborationRouteContext {
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

/** 三条路由背后的逻辑面（根服务单实例提供的真实 RecordStore/RoleStore）。 */
export interface CollaborationRouteDeps {
  records: RecordStore
  roles: RoleStore
  /** 请求时再读，好让 sessionController 的机会式 inject 晚于路由注册也能用。缺席则清单 unavailable。 */
  sessionController?: () => CollaborationSessionController | undefined
}

/** CollaborationError.code → HTTP 状态。 */
function errorStatus(error: unknown): number {
  if (error instanceof BodyTooLargeError) return 413 // 体超限：传输契约，先于坏 JSON 判定
  if (error instanceof SyntaxError) return 400 // 坏 JSON
  if (error instanceof CollaborationError) {
    switch (error.code) {
      case 'INVALID_INPUT':
        return 400
      case 'NOT_FOUND':
        return 404
      case 'CORRUPT_RECORD':
      case 'IO_ERROR':
        return 500
      default:
        return 500
    }
  }
  return 500
}

/** 错误体里的 code：让客户端按 code 分流（store 错误用其 code，其余给传输码）。 */
function errorCodeOf(error: unknown, status: number): string {
  if (error instanceof CollaborationError) return error.code
  if (error instanceof SyntaxError) return 'INVALID_INPUT'
  if (status === 405) return 'METHOD_NOT_ALLOWED'
  if (status === 413) return 'BODY_TOO_LARGE'
  return 'INTERNAL_ERROR'
}

/** JSON 应答：no-store + 显式长度。 */
function respondJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * 读请求体：按**累计字节**（Buffer.length，非解码后 string 长度）限 1MiB。
 * 跨块的多字节字符在 `end` 时一次性 `Buffer.concat` 解码，避免逐块 toString 把中文拆字成替换符。
 * 越限即拒（停止累计、不销毁 socket，让 413 正常回出）；拒绝后再来的 data/end/error 一律忽略。
 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        settled = true
        reject(new BodyTooLargeError(`请求体过大（超过 ${BODY_LIMIT} 字节上限）`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/**
 * 挂 exact 路由。webServer/connection 缺席时不挂（不挡装载）；
 * 每条路由先过 connection.admit 同一登录准入，再校验方法，再进逻辑。
 */
export function registerCollaborationRoutes(
  ctx: CollaborationRouteContext,
  deps: CollaborationRouteDeps,
): void {
  if (ctx.webServer === undefined || ctx.connection === undefined) return

  const handle = (
    path: string,
    methods: readonly ('GET' | 'POST')[],
    logic: (request: IncomingMessage) => Promise<{ status: number; body: string }>,
  ): void => {
    const allow = methods.join(', ')
    ctx.effect(
      () =>
        ctx.webServer?.register({
          kind: 'exact',
          path,
          async handler(request, response) {
            // 1) 登录准入（普通宿主鉴权，先于任何 datastore IO）。
            const admission = ctx.connection?.admit(request)
            if (admission !== undefined && 'rejection' in admission) {
              response.writeHead(admission.rejection)
              response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
              return
            }
            // 2) 方法校验（未识别方法 405 + allow 头）。
            if (request.method === undefined || !methods.includes(request.method as 'GET' | 'POST')) {
              response.writeHead(405, { allow })
              response.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: `method not allowed（允许 ${allow}）` } }))
              return
            }
            // 3) 逻辑（store IO 在准入之后）。
            try {
              const { status, body } = await logic(request)
              respondJson(response, status, body)
            } catch (error) {
              const status = errorStatus(error)
              // 5xx 原始 message 可能带绝对路径/堆栈，对外只给通用文案；4xx 域错误 message 受控。
              const code = errorCodeOf(error, status)
              const message = status >= 500
                ? (error instanceof CollaborationError ? error.message : 'internal error')
                : error instanceof Error ? error.message : String(error)
              respondJson(response, status, JSON.stringify({ error: { code, message } }))
            }
          },
        }),
      `dsh-router: collaboration ${allow} ${path}`,
    )
  }

  handle(COLLABORATION_RECORDS_PATH, ['GET'], async (request) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const rootSessionId = url.searchParams.get('rootSessionId') ?? ''
    if (rootSessionId === '') throw new CollaborationError('INVALID_INPUT', 'rootSessionId 查询参数必填')
    const taskId = url.searchParams.get('taskId') ?? undefined
    const kindParam = url.searchParams.get('kind') ?? undefined
    const query: RecordQuery = {}
    if (taskId !== undefined) query.taskId = taskId
    if (kindParam !== undefined) {
      // 非法 kind 由 store.list 校验为 INVALID_INPUT（不在此重复枚举）。
      query.kind = kindParam as RecordQuery['kind']
    }
    const records = await deps.records.list(rootSessionId, query)
    return { status: 200, body: JSON.stringify(records) }
  })

  handle(COLLABORATION_RECORD_PATH, ['GET'], async (request) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const rootSessionId = url.searchParams.get('rootSessionId') ?? ''
    const taskId = url.searchParams.get('taskId') ?? ''
    const recordId = url.searchParams.get('recordId') ?? ''
    if (rootSessionId === '') throw new CollaborationError('INVALID_INPUT', 'rootSessionId 查询参数必填')
    if (taskId === '') throw new CollaborationError('INVALID_INPUT', 'taskId 查询参数必填')
    if (recordId === '') throw new CollaborationError('INVALID_INPUT', 'recordId 查询参数必填')
    const saved = await deps.records.read(rootSessionId, taskId, recordId)
    return { status: 200, body: JSON.stringify(saved) }
  })

  handle(COLLABORATION_ROLES_PATH, ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') {
      const roles = await deps.roles.list()
      return { status: 200, body: JSON.stringify(roles) }
    }
    // POST：readBody 在 JSON 解析 try 之外——传输层错误（超限 413/中断）直接透出，
    // 不被「坏 JSON」的 INVALID_INPUT 包装吞掉；只有 JSON.parse 失败才映射 400。
    const raw = await readBody(request)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new CollaborationError('INVALID_INPUT', `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CollaborationError('INVALID_INPUT', '请求体须为 JSON 对象')
    }
    const body = parsed as { id?: unknown; name?: unknown; description?: unknown; models?: unknown }
    const input: { id?: string; name: string; description: string; models?: unknown } = {
      name: typeof body.name === 'string' ? body.name : '',
      description: typeof body.description === 'string' ? body.description : '',
    }
    // 带 id = 按该角色 ID 更新（改名只改内容、文件路径不动）；不带 id = 新建。
    if (typeof body.id === 'string' && body.id.trim() !== '') input.id = body.id.trim()
    if (Object.prototype.hasOwnProperty.call(body, 'models')) input.models = body.models
    // name 非空、名称唯一与 id 合法性由 RoleStore.save 校验（INVALID_INPUT）。
    const saved = await deps.roles.save(input)
    return { status: 200, body: JSON.stringify(saved) }
  })

  handle(COLLABORATION_MODELS_PATH, ['GET'], async () => {
    const sc = deps.sessionController?.()
    if (sc === undefined || typeof sc.modelCatalog !== 'function') {
      return { status: 200, body: JSON.stringify({ unavailable: true, providers: [] }) }
    }
    try {
      // 目录与界面模型选择器同一份：只取可路由的 groups，failures 不进清单，绝不回退全集。
      const catalog: unknown = await sc.modelCatalog()
      if (catalog === null || typeof catalog !== 'object' || !Array.isArray((catalog as { groups?: unknown }).groups)) {
        return { status: 200, body: JSON.stringify({ unavailable: true, providers: [] }) }
      }
      const groups = (catalog as { groups: readonly ModelProviderGroup[] }).groups
      const providers = groups.flatMap((group) => {
        if (group === null || typeof group !== 'object' || typeof group.id !== 'string') return []
        const name = typeof group.name === 'string' ? group.name : group.id
        const models = Array.isArray(group.models)
          ? group.models.flatMap((item) => (
            item !== null && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string'
              ? [{ id: item.id, name: item.name }]
              : []
          ))
          : []
        return [{ id: group.id, name, models }]
      })
      return { status: 200, body: JSON.stringify({ unavailable: false, providers }) }
    } catch {
      return { status: 200, body: JSON.stringify({ unavailable: true, providers: [] }) }
    }
  })
}
