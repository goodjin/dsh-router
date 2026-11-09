/**
 * 路由边界校验回归（审查修复）：坏输入在 HTTP 边界拒成 4xx，不透传成 500，
 * 也不泄露内部 message/路径。
 * - JSON.parse("null")/数字/数组 等「合法 JSON 但非对象」→ 400（不在 null 上取属性炸 500）；
 * - /router/answer 的 answers 逐条校验形状（id 字符串、selected 字符串数组、custom 可选字符串）；
 * - 5xx 内部错误对外只给通用文案（原始 message 可能带绝对路径）。
 */

import { describe, expect, it } from 'vitest'

import {
  ROUTER_ANSWER_PATH,
  ROUTER_SESSION_PATH,
  registerRouterRoutes,
  type RouterRoutesContext,
  type RouterRoutesDeps,
} from '../src/host/routes.ts'
import type { AskUserQuestionAnswerItem } from '../src/shared/view-contract.ts'

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
    connection: { admit() { return { peer: {} } } },
  }
  return { ctx: ctx as unknown as RouterRoutesContext, routes }
}

function fakeExchange(method: string, url: string, body: string) {
  const chunks = [Buffer.from(body)]
  const req = {
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

function harness(overrides: Partial<RouterRoutesDeps> = {}) {
  const answered: Array<{ questionId: string; answers: AskUserQuestionAnswerItem[] }> = []
  const deps = {
    answerQuestion: async (questionId: string, answers: AskUserQuestionAnswerItem[]) => { answered.push({ questionId, answers }) },
    createRouterSession: async () => ({ sessionId: 'sess-new' }),
    ...overrides,
  } as unknown as RouterRoutesDeps
  const { ctx, routes } = fakeHttpContext()
  registerRouterRoutes(ctx, deps)
  const handlerOf = (path: string) => {
    const found = routes.find((route) => route.path === path)
    expect(found, `路由 ${path} 应已挂上`).toBeDefined()
    return found!.handler
  }
  return { answered, handlerOf }
}

describe('路由边界：非对象 JSON 体拒成 400（不在 null 上取属性炸 500）', () => {
  it.each(['null', '42', '"str"', '[]', 'true'])('router-session 体=%s → 400', async (body) => {
    const { handlerOf } = harness()
    const { req, res, captured } = fakeExchange('POST', ROUTER_SESSION_PATH, body)
    await handlerOf(ROUTER_SESSION_PATH)(req, res)
    expect(captured.status).toBe(400)
    expect(JSON.parse(captured.body)).toHaveProperty('error')
  })

  it('坏 JSON（语法错误）仍是 400', async () => {
    const { handlerOf } = harness()
    const { req, res, captured } = fakeExchange('POST', ROUTER_SESSION_PATH, '{not json')
    await handlerOf(ROUTER_SESSION_PATH)(req, res)
    expect(captured.status).toBe(400)
  })
})

describe('路由边界：/router/answer 逐条校验 answers', () => {
  it('合法答案透传给 deps（含可选 custom）', async () => {
    const { answered, handlerOf } = harness()
    const body = JSON.stringify({ questionId: 'q1', answers: [{ id: 'a', selected: ['x'], custom: '补充' }, { id: 'b', selected: [] }] })
    const { req, res, captured } = fakeExchange('POST', ROUTER_ANSWER_PATH, body)
    await handlerOf(ROUTER_ANSWER_PATH)(req, res)
    expect(captured.status).toBe(200)
    expect(answered).toEqual([{ questionId: 'q1', answers: [{ id: 'a', selected: ['x'], custom: '补充' }, { id: 'b', selected: [] }] }])
  })

  it.each([
    ['answers 非数组', { questionId: 'q1', answers: 'nope' }],
    ['条目非对象', { questionId: 'q1', answers: ['x'] }],
    ['缺 id', { questionId: 'q1', answers: [{ selected: ['x'] }] }],
    ['selected 非字符串数组', { questionId: 'q1', answers: [{ id: 'a', selected: [1] }] }],
    ['custom 非字符串', { questionId: 'q1', answers: [{ id: 'a', selected: [], custom: 5 }] }],
  ])('%s → 400 且不透传', async (_label, payload) => {
    const { answered, handlerOf } = harness()
    const { req, res, captured } = fakeExchange('POST', ROUTER_ANSWER_PATH, JSON.stringify(payload))
    await handlerOf(ROUTER_ANSWER_PATH)(req, res)
    expect(captured.status).toBe(400)
    expect(answered).toHaveLength(0)
  })
})

describe('路由边界：5xx 不泄露内部 message/路径', () => {
  it('deps 抛带绝对路径的内部错误 → 500 + 通用文案', async () => {
    const { handlerOf } = harness({
      answerQuestion: async () => { throw new Error('ENOENT /Users/secret/.dsh/ledger.json') },
    })
    const body = JSON.stringify({ questionId: 'q1', answers: [{ id: 'a', selected: [] }] })
    const { req, res, captured } = fakeExchange('POST', ROUTER_ANSWER_PATH, body)
    await handlerOf(ROUTER_ANSWER_PATH)(req, res)
    expect(captured.status).toBe(500)
    expect(JSON.parse(captured.body)).toEqual({ error: 'internal error' })
    expect(captured.body).not.toContain('/Users/secret')
  })
})