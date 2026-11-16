/**
 * 协作工作台客户端 API（计划 Task 3，Layer 4）。
 *
 * 四条方法与宿主薄路由（/router/collaboration/*）逐字对齐：
 *   listRecords(rootSessionId, query?) → WorkRecord[]
 *   readRecord(rootSessionId, taskId, recordId) → SavedRecord
 *   listRoles() → RoleTemplate[]
 *   saveRole({id?,name,description}) → RoleTemplate
 *
 * 浏览器半边纪律：fetch 可注入（缺省 globalThis.fetch，同源会话登录传输沿用宿主既有
 * transport，不自建传输层）；失败**不**变成空数组——抛 CollaborationApiError 并保留
 * {error:{code,message}} 的 code/message/status，调用方据此显示错误与重试。只 type-only
 * 引入新类型（types.ts 零 node 依赖），不 bundle node:path/fs/oldcore。
 */

import type { RecordQuery, RoleTemplate, SavedRecord, WorkRecord } from '../collaboration/types.ts'

/** 宿主路由前缀（与 src/collaboration/routes.ts 逐字对齐；此处重复字符串，避免客户端 import 宿主 node 模块）。 */
export const COLLABORATION_API_RECORDS_PATH = '/router/collaboration/records'
export const COLLABORATION_API_RECORD_PATH = '/router/collaboration/record'
export const COLLABORATION_API_ROLES_PATH = '/router/collaboration/roles'

/** 请求失败（网络/HTTP 错误体）；code 是宿主错误码（INVALID_INPUT/NOT_FOUND/…），status 是 HTTP 状态。 */
export class CollaborationApiError extends Error {
  readonly code?: string
  readonly status?: number

  constructor(message: string, code?: string, status?: number) {
    super(message)
    this.name = 'CollaborationApiError'
    this.code = code
    this.status = status
  }
}

/** api 需要的 fetch 最小面（结构化，测试可用任何形状相近的对象充当）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** createCollaborationApi 的依赖（fetch 可缺省，缺省走浏览器全局）。 */
export interface CollaborationApiDeps {
  fetch?: FetchLike
}

/** 工作台四条 API 的封装面。失败一律抛 CollaborationApiError，绝不返回空数组冒充成功。 */
export interface CollaborationApi {
  listRecords(rootSessionId: string, query?: RecordQuery): Promise<WorkRecord[]>
  readRecord(rootSessionId: string, taskId: string, recordId: string): Promise<SavedRecord>
  listRoles(): Promise<RoleTemplate[]>
  saveRole(input: { id?: string; name: string; description: string }): Promise<RoleTemplate>
}

/** 把响应体收成 JSON；解析失败给 null。 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** 从错误体提取 {code,message}；缺则退回 HTTP 状态描述。 */
function errorFromBody(body: unknown, status: number): { code?: string; message: string } {
  if (body !== null && typeof body === 'object') {
    const error = (body as { error?: unknown }).error
    if (error !== null && typeof error === 'object') {
      const code = (error as { code?: unknown }).code
      const message = (error as { message?: unknown }).message
      return {
        code: typeof code === 'string' ? code : undefined,
        message: typeof message === 'string' && message.length > 0 ? message : `router: HTTP ${status}`,
      }
    }
    if (typeof error === 'string' && error.length > 0) {
      return { message: error }
    }
  }
  return { message: `router: HTTP ${status}` }
}

export function createCollaborationApi(deps: CollaborationApiDeps = {}): CollaborationApi {
  const doFetch = deps.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init))

  /** 发请求并解包：非 2xx 抛 CollaborationApiError（保留 code/message/status）。 */
  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await doFetch(path, init)
    const body = await readJson(response)
    if (!response.ok) {
      const { code, message } = errorFromBody(body, response.status)
      throw new CollaborationApiError(message, code, response.status)
    }
    return body
  }

  return {
    async listRecords(rootSessionId: string, query?: RecordQuery): Promise<WorkRecord[]> {
      const params = new URLSearchParams({ rootSessionId })
      if (query?.taskId !== undefined) params.set('taskId', query.taskId)
      if (query?.kind !== undefined) params.set('kind', query.kind)
      const body = await request(`${COLLABORATION_API_RECORDS_PATH}?${params.toString()}`, { headers: { accept: 'application/json' } })
      if (!Array.isArray(body)) throw new CollaborationApiError('router: records response missing array')
      return body as WorkRecord[]
    },

    async readRecord(rootSessionId: string, taskId: string, recordId: string): Promise<SavedRecord> {
      const params = new URLSearchParams({ rootSessionId, taskId, recordId })
      const body = await request(`${COLLABORATION_API_RECORD_PATH}?${params.toString()}`, { headers: { accept: 'application/json' } })
      const saved = body as SavedRecord | null
      if (saved === null || typeof saved !== 'object' || typeof saved.record !== 'object' || saved.record === null) {
        throw new CollaborationApiError('router: record response missing record')
      }
      return saved as SavedRecord
    },

    async listRoles(): Promise<RoleTemplate[]> {
      const body = await request(COLLABORATION_API_ROLES_PATH, { headers: { accept: 'application/json' } })
      if (!Array.isArray(body)) throw new CollaborationApiError('router: roles response missing array')
      return body as RoleTemplate[]
    },

    async saveRole(input: { id?: string; name: string; description: string }): Promise<RoleTemplate> {
      // id 优先（编辑既有模板时先带定位键），与宿主读取顺序一致。
      const payload: Record<string, unknown> = input.id !== undefined
        ? { id: input.id, name: input.name, description: input.description }
        : { name: input.name, description: input.description }
      const body = await request(COLLABORATION_API_ROLES_PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const role = body as RoleTemplate | null
      if (role === null || typeof role !== 'object' || typeof role.id !== 'string') {
        throw new CollaborationApiError('router: roles response missing role')
      }
      return role as RoleTemplate
    },
  }
}
