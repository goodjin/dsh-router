/**
 * 同源 API 封装（计划 Task B7：四条路由、超时、{error} 透出）。
 *
 * 契约（计划「客户端↔宿主 API 契约」逐字）：
 * - GET  /router/state?workspaceId=        → RouterState
 * - POST /router/router-session {workspaceId, name?} → { sessionId }
 * - POST /router/answer {questionId, answers[]} → { ok: true }；已答 409
 * - POST /router/tabs/close {workspaceId, sessionId} → { ok: true }
 * - POST /router/redirect/ack {workspaceId, supersededSessionId} → { ok: true }（C4）
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

describe('POST /router/emergency-pause（v1.4 作用域暂停）', () => {
  it('带上 routerSessionId 调宿主，解析逐任务如实结果', async () => {
    const seen: string[] = []
    let sentBody: unknown
    const report = {
      tasks: [
        { taskId: 'T-001', title: '写文档', sessionId: 'w-1', paused: true, interrupted: true },
        { taskId: 'T-002', title: '跑批', sessionId: 'w-2', paused: true, interrupted: false, detail: '中断失败：宿主拒绝' },
      ],
      pausedCount: 1,
      failedCount: 1,
      notified: true,
    }
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        seen.push(input)
        sentBody = JSON.parse(String(init?.body ?? '{}'))
        return jsonResponse(200, report)
      }),
    })
    const result = await api.emergencyPause('router-1')
    expect(seen[0]).toBe('/router/emergency-pause')
    expect(sentBody).toEqual({ routerSessionId: 'router-1' })
    expect(result).toEqual(report)
    expect(result.tasks[1]!.detail).toContain('宿主拒绝')
  })
})

describe('POST /router/tasks/control（验收动作扩展，H2）', () => {
  it('accept/reject/rework 透传；note 只在给出时上送', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const api = createRouterApi({
      fetch: jsonFetch((_input, init) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return jsonResponse(200, { status: 'completed' })
      }),
    })
    expect(await api.controlTask('T-001', 'accept')).toEqual({ status: 'completed' })
    await api.controlTask('T-001', 'reject', '缺章节')
    await api.controlTask('T-001', 'rework')
    expect(bodies).toEqual([
      { taskId: 'T-001', action: 'accept' },
      { taskId: 'T-001', action: 'reject', note: '缺章节' },
      { taskId: 'T-001', action: 'rework' },
    ])
  })
})

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

  it('模板偏好是可选扩展键：给了才带 templateId（宿主可忽略）', async () => {
    const api = createRouterApi({
      fetch: jsonFetch((_input, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ workspaceId: 'ws-1', templateId: 'docs' })
        return jsonResponse(200, { sessionId: 'r2' })
      }),
    })
    await expect(api.createRouterSession('ws-1', undefined, 'docs')).resolves.toEqual({ sessionId: 'r2' })
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

describe('C3 worker 类型 / Router 默认值（api 只增函数）', () => {
  const createdType = {
    templateId: 't-1', name: '文档写手', description: '写文档', role: 'worker' as const,
    models: ['p/m1'], systemPrompt: '提示词', skills: ['doc'], enabled: true,
    origin: 'user' as const, createdAt: 1, updatedAt: 1,
  }

  it('listWorkerTypes：GET /router/worker-types → WorkerTypeRecord[]', async () => {
    const seen: string[] = []
    const api = createRouterApi({
      fetch: jsonFetch((input) => {
        seen.push(input)
        return jsonResponse(200, { types: [createdType] })
      }),
    })
    const result = await api.listWorkerTypes()
    expect(seen[0]).toBe('/router/worker-types')
    expect(result).toEqual([createdType])
  })

  it('createWorkerType：POST body 即 TypesCreateRequest，回 {type}', async () => {
    let body = ''
    const api = createRouterApi({
      fetch: jsonFetch((_input, init) => {
        body = String(init?.body)
        return jsonResponse(200, { type: createdType })
      }),
    })
    const input = { name: '文档写手', description: '写文档', role: 'worker' as const, models: ['p/m1'], systemPrompt: '提示词', skills: ['doc'], enabled: true }
    const result = await api.createWorkerType(input)
    expect(JSON.parse(body)).toEqual(input)
    expect(result).toEqual(createdType)
  })

  it('updateWorkerType：POST /router/worker-types/update {templateId, patch}', async () => {
    let path = ''
    let body = ''
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        path = input
        body = String(init?.body)
        return jsonResponse(200, { type: { ...createdType, name: '新名' } })
      }),
    })
    const result = await api.updateWorkerType({ templateId: 't-1', patch: { name: '新名', models: ['x/y'] } })
    expect(path).toBe('/router/worker-types/update')
    expect(JSON.parse(body)).toEqual({ templateId: 't-1', patch: { name: '新名', models: ['x/y'] } })
    expect(result.name).toBe('新名')
  })

  it('setWorkerTypeEnabled：POST /router/worker-types/enabled {templateId, enabled}', async () => {
    let path = ''
    let body = ''
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        path = input
        body = String(init?.body)
        return jsonResponse(200, { type: { ...createdType, enabled: false } })
      }),
    })
    const result = await api.setWorkerTypeEnabled({ templateId: 't-1', enabled: false })
    expect(path).toBe('/router/worker-types/enabled')
    expect(JSON.parse(body)).toEqual({ templateId: 't-1', enabled: false })
    expect(result.enabled).toBe(false)
  })

  it('removeWorkerType：DELETE /router/worker-types?templateId= → {ok:true}；409 带错误透出', async () => {
    const calls: Array<{ input: string; method?: string }> = []
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        calls.push({ input, method: init?.method })
        return jsonResponse(200, { ok: true })
      }),
    })
    await expect(api.removeWorkerType('t-1')).resolves.toBeUndefined()
    expect(calls[0]).toEqual({ input: '/router/worker-types?templateId=t-1', method: 'DELETE' })

    const refused = createRouterApi({ fetch: jsonFetch(() => jsonResponse(409, { error: '内置类型不可删除' })) })
    const error = await refused.removeWorkerType('general').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RouterApiError)
    expect((error as RouterApiError).status).toBe(409)
    expect((error as RouterApiError).message).toContain('内置类型不可删除')
  })

  it('getDefaults / saveDefaults：GET 读、POST 写回 RouterDefaults', async () => {
    const calls: Array<{ input: string; method?: string; body?: string }> = []
    const defaultsValue = { routerSystemPrompt: '默认提示词', routerModel: 'p/m' }
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        calls.push({ input, method: init?.method, body: init?.body === undefined ? undefined : String(init?.body) })
        return jsonResponse(200, defaultsValue)
      }),
    })
    await expect(api.getDefaults()).resolves.toEqual(defaultsValue)
    await expect(api.saveDefaults(defaultsValue)).resolves.toEqual(defaultsValue)
    expect(calls[0]).toEqual({ input: '/router/defaults', method: undefined })
    expect(calls[1]?.method).toBe('POST')
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual(defaultsValue)
  })
})

describe('C5 会话系统提示词（GET/PUT /router/prompt）', () => {
  it('getPrompt：GET ?sessionId=，返回 {prompt, isDefault}', async () => {
    const calls: Array<{ input: string; method?: string }> = []
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        calls.push({ input, method: init?.method })
        return jsonResponse(200, { prompt: '本会话覆盖', isDefault: false })
      }),
    })
    await expect(api.getPrompt('s-router')).resolves.toEqual({ prompt: '本会话覆盖', isDefault: false })
    expect(calls[0]).toEqual({ input: '/router/prompt?sessionId=s-router', method: undefined })
  })

  it('getPrompt 的 sessionId 走 URL 编码', async () => {
    const calls: string[] = []
    const api = createRouterApi({
      fetch: jsonFetch((input) => {
        calls.push(input)
        return jsonResponse(200, { prompt: 'x', isDefault: true })
      }),
    })
    await api.getPrompt('a b&c')
    expect(calls[0]).toBe('/router/prompt?sessionId=a%20b%26c')
  })

  it('saveSessionPrompt：PUT JSON {sessionId, prompt}', async () => {
    const calls: Array<{ input: string; method?: string; body?: string }> = []
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        calls.push({ input, method: init?.method, body: init?.body === undefined ? undefined : String(init?.body) })
        return jsonResponse(200, { ok: true })
      }),
    })
    await expect(api.saveSessionPrompt('s-router', '新文本')).resolves.toBeUndefined()
    expect(calls[0]?.input).toBe('/router/prompt')
    expect(calls[0]?.method).toBe('PUT')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ sessionId: 's-router', prompt: '新文本' })
    // 空串 = 清除回落默认，也走 PUT（宿主按空串语义 clear）
    await api.saveSessionPrompt('s-router', '')
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ sessionId: 's-router', prompt: '' })
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

  it('超时横跨响应体（审查 F8）：headers 早到但 body 悬死，同样按超时收场', async () => {
    const api = createRouterApi({
      fetch: (_input, init) => Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
        text: () => Promise.resolve(''),
      } as Response),
      timeoutMs: 10,
    })
    const error = await api.getState().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RouterApiError)
    expect((error as RouterApiError).message).toMatch(/timeout/i)
  })
})

describe('C2 派生模式（GET/POST /router/spawn-mode）', () => {
  it('getSpawnMode：GET 读 {mode}；saveSpawnMode：POST 写 {mode} 并回显', async () => {
    const calls: Array<{ input: string; method?: string; body?: string }> = []
    const api = createRouterApi({
      fetch: jsonFetch((input, init) => {
        calls.push({ input, method: init?.method, body: init?.body === undefined ? undefined : String(init?.body) })
        const requested = calls.length >= 2 ? { mode: 'minimal-face' } : { mode: 'cache-priority' }
        return jsonResponse(200, requested)
      }),
    })
    await expect(api.getSpawnMode()).resolves.toEqual({ mode: 'cache-priority' })
    await expect(api.saveSpawnMode('minimal-face')).resolves.toEqual({ mode: 'minimal-face' })
    expect(calls[0]).toEqual({ input: '/router/spawn-mode', method: undefined })
    expect(calls[1]?.method).toBe('POST')
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ mode: 'minimal-face' })
  })

  it('saveSpawnMode 400 错误体透出（非法 mode 被宿主拒）', async () => {
    const api = createRouterApi({ fetch: jsonFetch(() => jsonResponse(400, { error: "mode 必须是 'cache-priority' | 'minimal-face' 之一" })) })
    const error = await api.saveSpawnMode('bogus' as 'cache-priority').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RouterApiError)
    expect((error as RouterApiError).status).toBe(400)
    expect((error as RouterApiError).message).toContain('mode')
  })
})
