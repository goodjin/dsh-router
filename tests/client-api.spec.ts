/**
 * 同源 API 封装（计划 Task B7：四条路由、超时、{error} 透出）。
 *
 * 契约（计划「客户端↔宿主 API 契约」逐字）：
 * - GET  /router/state?workspaceId=        → RouterState
 * - POST /router/router-session {workspaceId, name?} → { sessionId }
 * - POST /router/answer {questionId, answers[]} → { ok: true }；已答 409
 * - POST /router/tabs/close {workspaceId, sessionId} → { ok: true }
 * 错误统一 JSON `{ error: string }` + 4xx/5xx，封装成带 status 的 RouterApiError。
 * 测试注入假 fetch，不启网络。
 */

import { describe, expect, it } from 'vitest'
import { createRouterApi, RouterApiError } from '../src/client/api.ts'
import type { FetchLike, RouterApiDeps } from '../src/client/api.ts'
import type { RouterState } from '../src/shared/view-contract.ts'

const sampleState: RouterState = {
  routerSessions: [{ sessionId: 'router-1', title: 'Router' }],
  tasks: [{
    taskId: 'T-001', title: '写文档', goal: '发布说明', status: 'running', role: 'worker',
    templateId: 'docs', waitingQuestions: 0, docVersion: 1,
  }],
  questions: [],
  tabs: [{ sessionId: 'w-1', title: 'worker 一', running: true }],
  templates: [{ templateId: 'docs', name: '文档', description: '写文档的 worker', role: 'worker' }],
}

function jsonFetch(respond: (input: string, init?: RequestInit) => Response | Promise<Response>): FetchLike {
  return (input, init) => Promise.resolve(respond(input, init)).then((response) => response)
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response
}

describe('GET /router/state', () => {
  it('带 workspaceId 查询参数，解析 RouterState', async () => {
    const seen: string[] = []
    const api = createRouterApi({
      fetch: jsonFetch((input) => {
        seen.push(input)
        return jsonResponse(200, sampleState)
      }),
    })
    const result = await api.getState('ws-1')
    expect(seen[0]).toBe('/router/state?workspaceId=ws-1')
    expect(result).toEqual(sampleState)
  })

  it('没有 workspaceId 时不带查询参数', async () => {
    const seen: string[] = []
    const api = createRouterApi({
      fetch: jsonFetch((input) => {
        seen.push(input)
        return jsonResponse(200, sampleState)
      }),
    })
    await api.getState()
    expect(seen[0]).toBe('/router/state')
  })
})

describe('POST /router/router-session', () => {
  it('POST JSON {workspaceId, name?}，返回 sessionId', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = []
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        calls.push({ input, init })
        return jsonResponse(200, { sessionId: 'router-new' })
      }),
    })
    const result = await api.createRouterSession('ws-1', '我的 Router')
    expect(result).toEqual({ sessionId: 'router-new' })
    expect(calls[0]?.input).toBe('/router/router-session')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ workspaceId: 'ws-1', name: '我的 Router' })
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('name 缺省时不发 name 键', async () => {
    const api = createRouterApi({
      fetch: jsonFetch((_input, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ workspaceId: 'ws-1' })
        return jsonResponse(200, { sessionId: 'r' })
      }),
    })
    await api.createRouterSession('ws-1')
  })
})

describe('POST /router/answer', () => {
  it('POST {questionId, answers}，{ok:true} 时正常返回', async () => {
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        expect(input).toBe('/router/answer')
        expect(JSON.parse(String(init?.body))).toEqual({
          questionId: 'QA',
          answers: [{ id: 'q1', selected: ['A'] }],
        })
        return jsonResponse(200, { ok: true })
      }),
    })
    await expect(api.postAnswer('QA', [{ id: 'q1', selected: ['A'] }])).resolves.toBeUndefined()
  })

  it('409（已答过）抛 RouterApiError 且 status=409——调用方把它视为已完成', async () => {
    const api = createRouterApi({ fetch: jsonFetch(() => jsonResponse(409, { error: 'already answered' })) })
    const error = await api.postAnswer('QA', []).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RouterApiError)
    expect((error as RouterApiError).status).toBe(409)
    expect((error as RouterApiError).message).toContain('already answered')
  })
})

describe('POST /router/tabs/close', () => {
  it('POST {workspaceId, sessionId}，成功返回', async () => {
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        expect(input).toBe('/router/tabs/close')
        expect(JSON.parse(String(init?.body))).toEqual({ workspaceId: 'ws-1', sessionId: 'w-1' })
        return jsonResponse(200, { ok: true })
      }),
    })
    await expect(api.closeWorkerTab('ws-1', 'w-1')).resolves.toBeUndefined()
  })
})

describe('错误与超时', () => {
  it('5xx + {error} 透出为 RouterApiError（message 含 error 字段）', async () => {
    const api = createRouterApi({ fetch: jsonFetch(() => jsonResponse(503, { error: 'core service down' })) })
    const error = await api.getState().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RouterApiError)
    expect((error as RouterApiError).status).toBe(503)
    expect((error as RouterApiError).message).toContain('core service down')
  })

  it('错误体不是 JSON 时退回 HTTP 状态描述', async () => {
    const api = createRouterApi({
      fetch: jsonFetch(() => ({
        ok: false,
        status: 500,
        json: () => Promise.reject(new SyntaxError('not json')),
        text: () => Promise.resolve('boom'),
      } as Response)),
    })
    const error = await api.getState().catch((caught: unknown) => caught)
    expect((error as RouterApiError).status).toBe(500)
    expect((error as RouterApiError).message).toContain('500')
  })

  it('超时：请求在 timeoutMs 后被中止并抛超时错误', async () => {
    const api = createRouterApi({
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
      timeoutMs: 10,
    })
    const error = await api.getState().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RouterApiError)
    expect((error as RouterApiError).message).toMatch(/timeout/i)
  })
})
