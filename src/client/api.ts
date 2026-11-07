/**
 * 同源 API 封装（计划 Task B7：四条路由、超时、{error} 透出）。
 *
 * 契约（计划「客户端↔宿主 API 契约」逐字，不得偏离）：
 * - GET  /router/state?workspaceId= → RouterState
 * - POST /router/router-session { workspaceId, name? } → { sessionId }
 * - POST /router/answer { questionId, answers } → { ok: true }；已答 409
 * - POST /router/tabs/close { workspaceId, sessionId } → { ok: true }
 * - POST /router/redirect/ack { workspaceId, supersededSessionId } → { ok: true }（C4）
 * 错误统一 `{ error: string }` + 4xx/5xx，封装成带 status 的 RouterApiError；
 * 409 语义是「已答过」——调用方把它视为已完成（question-state 的 accept）。
 * fetch 可注入：默认 globalThis.fetch，测试给假实现。
 */

import type {
  AskUserQuestionAnswerItem,
  RouterDefaults,
  RouterState,
  TypesCreateRequest,
  TypesEnabledRequest,
  TypesUpdateRequest,
  WorkerTypeRecord,
} from '../shared/view-contract.ts'

/** 请求失败（网络/超时/HTTP 错误体）；status 是 HTTP 状态码（超时/网络错时缺省）。 */
export class RouterApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'RouterApiError'
    this.status = status
  }
}

/** api 需要的 fetch 最小面（结构化，测试可用任何形状相近的对象充当）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** createRouterApi 的依赖（全部可注入，缺省走浏览器全局）。 */
export interface RouterApiDeps {
  fetch?: FetchLike
  /** 单请求超时毫秒数；缺省 8000。 */
  timeoutMs?: number
}

/** 五条路由的封装面。 */
export interface RouterApi {
  getState(workspaceId?: string): Promise<RouterState>
  /**
   * 契约体是 { workspaceId, name? }；templateId 是可选扩展键（模板偏好，
   * 宿主不识别时忽略）——只在显式给出时上送。
   */
  createRouterSession(workspaceId: string, name?: string, templateId?: string): Promise<{ sessionId: string }>
  /** 已答 409 会以 RouterApiError(status=409) 抛出——调用方视为已完成。 */
  postAnswer(questionId: string, answers: AskUserQuestionAnswerItem[]): Promise<void>
  closeWorkerTab(workspaceId: string, sessionId: string): Promise<void>
  /** 消费去重指令的回执（v1.1 Task C4）：幂等，失败抛 RouterApiError。 */
  ackRedirect(workspaceId: string, supersededSessionId: string): Promise<void>
  /* ── v1.1 Task C3：worker 类型 / Router 默认值管理（api 只增函数） ── */
  /** 全量类型记录（含禁用与 builtin），设置管理栏目消费。 */
  listWorkerTypes(): Promise<WorkerTypeRecord[]>
  createWorkerType(input: TypesCreateRequest): Promise<WorkerTypeRecord>
  updateWorkerType(request: TypesUpdateRequest): Promise<WorkerTypeRecord>
  setWorkerTypeEnabled(request: TypesEnabledRequest): Promise<WorkerTypeRecord>
  /** 删除类型（builtin 拒 409，错误带 status 透出给 UI）。 */
  removeWorkerType(templateId: string): Promise<void>
  getDefaults(): Promise<RouterDefaults>
  saveDefaults(value: RouterDefaults): Promise<RouterDefaults>
}

const DEFAULT_TIMEOUT_MS = 8000

/** 五条路由的路径常量（与宿主 routes 一侧逐字对齐）。 */
export const ROUTER_STATE_PATH = '/router/state'
export const ROUTER_SESSION_PATH = '/router/router-session'
export const ROUTER_ANSWER_PATH = '/router/answer'
export const ROUTER_TABS_CLOSE_PATH = '/router/tabs/close'
export const ROUTER_REDIRECT_ACK_PATH = '/router/redirect/ack'
/** v1.1 Task C3：worker 类型 / Router 默认值（与宿主 routes 一侧逐字对齐）。 */
export const WORKER_TYPES_PATH = '/router/worker-types'
export const WORKER_TYPES_UPDATE_PATH = '/router/worker-types/update'
export const WORKER_TYPES_ENABLED_PATH = '/router/worker-types/enabled'
export const ROUTER_DEFAULTS_PATH = '/router/defaults'

function defaultFetch(): FetchLike {
  return (input, init) => globalThis.fetch(input, init)
}

/** 把响应体收成 JSON；解析失败给 null（错误分支用它兜回状态文本）。 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** 从错误体提取 {error}；取不到就退回 HTTP 状态描述。 */
function errorMessageFromBody(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object') {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `router: HTTP ${status}`
}

export function createRouterApi(deps: RouterApiDeps = {}): RouterApi {
  const doFetch = deps.fetch ?? defaultFetch()
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // 每个请求一个控制器：到时即中止；**截止线横跨头与响应体**（审查 F8）——
  // headers 早到、body 迟迟不来时也必须按超时收场，否则提交/关闭会悬死、
  // 轮询会越积越多。json 的读取与中止信号赛跑，谁先到听谁的。
  async function request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await doFetch(path, { ...init, signal: controller.signal })
      const body = await Promise.race([
        readJson(response),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        }),
      ])
      if (!response.ok) {
        throw new RouterApiError(errorMessageFromBody(body, response.status), response.status)
      }
      return body
    } catch (error) {
      // 协议错误（HTTP 状态 + {error}）原样上抛，不得被包装丢掉 status。
      if (error instanceof RouterApiError) throw error
      // 超时中止与网络错误在这里分不开太多——按调用方的可读性统一命名。
      const message = error instanceof Error ? error.message : String(error)
      throw new RouterApiError(/abort/i.test(message) ? 'router: request timeout' : `router: network error (${message})`)
    } finally {
      clearTimeout(timer)
    }
  }

  function postJson(path: string, payload: Record<string, unknown>): Promise<unknown> {
    return request(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  function deleteJson(path: string): Promise<unknown> {
    return request(path, { method: 'DELETE', headers: { accept: 'application/json' } })
  }

  /** {type} 响应的解包（缺 type 即协议错误）。 */
  function unwrapType(body: unknown): WorkerTypeRecord {
    const type = (body as { type?: unknown } | null)?.type
    if (type === null || typeof type !== 'object') {
      throw new RouterApiError('router: worker-type response missing type')
    }
    return type as WorkerTypeRecord
  }

  return {
    async getState(workspaceId?: string): Promise<RouterState> {
      const query = typeof workspaceId === 'string' && workspaceId.length > 0
        ? `?workspaceId=${encodeURIComponent(workspaceId)}`
        : ''
      const body = await request(`${ROUTER_STATE_PATH}${query}`, { headers: { accept: 'application/json' } })
      return body as RouterState
    },

    async createRouterSession(workspaceId: string, name?: string, templateId?: string): Promise<{ sessionId: string }> {
      const payload: Record<string, unknown> = { workspaceId }
      if (typeof name === 'string' && name.length > 0) payload['name'] = name
      if (typeof templateId === 'string' && templateId.length > 0) payload['templateId'] = templateId
      const body = await postJson(ROUTER_SESSION_PATH, payload)
      const sessionId = (body as { sessionId?: unknown }).sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new RouterApiError('router: router-session response missing sessionId')
      }
      return { sessionId }
    },

    async postAnswer(questionId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
      // 409 = 已答过：原样带状态抛出，调用方（workbench-store）把它视为 done。
      await postJson(ROUTER_ANSWER_PATH, { questionId, answers })
    },

    async closeWorkerTab(workspaceId: string, sessionId: string): Promise<void> {
      await postJson(ROUTER_TABS_CLOSE_PATH, { workspaceId, sessionId })
    },

    async ackRedirect(workspaceId: string, supersededSessionId: string): Promise<void> {
      await postJson(ROUTER_REDIRECT_ACK_PATH, { workspaceId, supersededSessionId })
    },

    /* ── v1.1 Task C3：worker 类型 / Router 默认值 ── */

    async listWorkerTypes(): Promise<WorkerTypeRecord[]> {
      const body = await request(WORKER_TYPES_PATH, { headers: { accept: 'application/json' } })
      const types = (body as { types?: unknown } | null)?.types
      if (!Array.isArray(types)) throw new RouterApiError('router: worker-types response missing types')
      return types as WorkerTypeRecord[]
    },

    async createWorkerType(input: TypesCreateRequest): Promise<WorkerTypeRecord> {
      return unwrapType(await postJson(WORKER_TYPES_PATH, input as unknown as Record<string, unknown>))
    },

    async updateWorkerType(req: TypesUpdateRequest): Promise<WorkerTypeRecord> {
      return unwrapType(await postJson(WORKER_TYPES_UPDATE_PATH, req as unknown as Record<string, unknown>))
    },

    async setWorkerTypeEnabled(req: TypesEnabledRequest): Promise<WorkerTypeRecord> {
      return unwrapType(await postJson(WORKER_TYPES_ENABLED_PATH, req as unknown as Record<string, unknown>))
    },

    async removeWorkerType(templateId: string): Promise<void> {
      await deleteJson(`${WORKER_TYPES_PATH}?templateId=${encodeURIComponent(templateId)}`)
    },

    async getDefaults(): Promise<RouterDefaults> {
      const body = await request(ROUTER_DEFAULTS_PATH, { headers: { accept: 'application/json' } })
      if (body === null || typeof body !== 'object') throw new RouterApiError('router: defaults response missing body')
      return body as RouterDefaults
    },

    async saveDefaults(value: RouterDefaults): Promise<RouterDefaults> {
      const body = await postJson(ROUTER_DEFAULTS_PATH, value as unknown as Record<string, unknown>)
      if (body === null || typeof body !== 'object') throw new RouterApiError('router: defaults response missing body')
      return body as RouterDefaults
    },
  }
}
