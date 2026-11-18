/**
 * 协作工作台客户端 API 测试（计划 Task 3，Layer 4）。
 *
 * brief 命名断言：
 *  - createCollaborationApi(fetch) 四条方法：listRecords/readRecord/listRoles/saveRole；
 *    默认 fetch 同源；失败不变成空数组（抛 CollaborationApiError，保留 code/status/message）；
 *    浏览器侧只 type-only 引入新类型，不 bundle node:path/fs/oldcore。
 */

import { describe, expect, it } from 'vitest'

import {
  CollaborationApiError,
  createCollaborationApi,
  COLLABORATION_API_RECORDS_PATH,
  COLLABORATION_API_RECORD_PATH,
  COLLABORATION_API_ROLES_PATH,
} from '../../src/client/collaboration-api.ts'
import type { RecordQuery, RoleTemplate, SavedRecord, WorkRecord } from '../../src/collaboration/types.ts'

interface Call { url: string; init?: RequestInit }

/** 记录每次调用的假 fetch：按序返回预设响应（每调用一个）。 */
function fakeFetch(opts: {
  responses?: Array<{ status?: number; body?: unknown }>
  status?: number
  body?: unknown
  capture?: Call[]
}): (input: string, init?: RequestInit) => Promise<Response> {
  let call = 0
  return async (input, init) => {
    opts.capture?.push({ url: input, init })
    const next = opts.responses?.[call] ?? { status: opts.status, body: opts.body }
    call += 1
    const status = next.status ?? 200
    const response = {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.body ?? null,
    }
    return response as unknown as Response
  }
}

const sampleRecord: WorkRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  taskId: '11111111-1111-4111-8111-111111111111',
  rootSessionId: 'root-1',
  kind: 'report',
  title: '报告',
  body: '成果',
  workLabel: '进行中',
  createdAt: 1,
  updatedAt: 1,
}

describe('createCollaborationApi — 四条方法与默认同源 fetch', () => {
  it('listRecords 走 GET /records 带 rootSessionId/taskId/kind 查询串', async () => {
    const capture: Call[] = []
    const api = createCollaborationApi({ fetch: fakeFetch({ body: [sampleRecord], capture }) })
    const query: RecordQuery = { taskId: '11111111-1111-4111-8111-111111111111', kind: 'report' }
    const records = await api.listRecords('root-1', query)
    expect(records).toHaveLength(1)
    expect(records[0]!.title).toBe('报告')
    expect(capture[0]!.url).toContain(COLLABORATION_API_RECORDS_PATH)
    expect(capture[0]!.url).toContain('rootSessionId=root-1')
    expect(capture[0]!.url).toContain('taskId=')
    expect(capture[0]!.url).toContain('kind=report')
    expect(capture[0]!.init?.method).toBeUndefined() // GET 默认
  })

  it('readRecord 走 GET /record 带三参；返回 SavedRecord（record + path）', async () => {
    const saved: SavedRecord = { record: sampleRecord, path: '/x/y.json' }
    const api = createCollaborationApi({ fetch: fakeFetch({ body: saved }) })
    const result = await api.readRecord('root-1', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
    expect(result.record.id).toBe(sampleRecord.id)
    expect(result.path).toBe('/x/y.json')
  })

  it('listRoles 走 GET /roles；saveRole 走 POST /roles 带 JSON 体', async () => {
    const role: RoleTemplate = { name: '前端', description: '' }
    const capture: Call[] = []
    const api = createCollaborationApi({ fetch: fakeFetch({ responses: [{ body: [role] }, { body: role }], capture }) })
    const listed = await api.listRoles()
    expect(listed).toHaveLength(1)
    expect(capture[0]!.url).toBe(COLLABORATION_API_ROLES_PATH)
    expect(capture[0]!.init?.method).toBeUndefined()
    const saved = await api.saveRole({ name: '前端', description: 'UI' })
    expect(saved.name).toBe('前端')
    expect(capture[1]!.init?.method).toBe('POST')
    expect(capture[1]!.init?.body).toBe(JSON.stringify({ name: '前端', description: 'UI' }))
  })

  it('saveRole 按名 upsert：POST 体只含 name/description', async () => {
    const capture: Call[] = []
    const role: RoleTemplate = { name: '前端', description: 'UI' }
    const api = createCollaborationApi({ fetch: fakeFetch({ body: role, capture }) })
    await api.saveRole({ name: '前端', description: 'UI' })
    expect(capture[0]!.init!.body).toBe(JSON.stringify({ name: '前端', description: 'UI' }))
  })
})

describe('createCollaborationApi — 失败保留不变空数组', () => {
  it('非 2xx 抛 CollaborationApiError，保留 {error:{code,message}} 的 code 与 message', async () => {
    const api = createCollaborationApi({ fetch: fakeFetch({ status: 500, body: { error: { code: 'IO_ERROR', message: '写入失败' } } }) })
    await expect(api.listRoles()).rejects.toMatchObject({ code: 'IO_ERROR', message: '写入失败', status: 500 })
    await expect(api.listRoles()).rejects.toBeInstanceOf(CollaborationApiError)
  })

  it('读取类失败不返回 []：listRecords 失败抛错而非空数组', async () => {
    const api = createCollaborationApi({ fetch: fakeFetch({ status: 404, body: { error: { code: 'NOT_FOUND', message: '记录不存在' } } }) })
    await expect(api.listRecords('root-1')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('saveRole 失败抛错（调用方据此显示并保留草稿）', async () => {
    const api = createCollaborationApi({ fetch: fakeFetch({ status: 400, body: { error: { code: 'INVALID_INPUT', message: 'name 必须是非空字符串' } } }) })
    await expect(api.saveRole({ name: '', description: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 })
  })

  it('错误体缺 code/message 时退回 HTTP 状态描述（仍有 status）', async () => {
    const api = createCollaborationApi({ fetch: fakeFetch({ status: 503, body: null }) })
    await expect(api.listRoles()).rejects.toMatchObject({ status: 503 })
  })
})
