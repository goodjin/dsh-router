/**
 * GET /router/session-output：某会话最新一段助手输出（v1.5 浮窗预览）。
 *
 * 契约：只回一段有界文字 + 取数来源；浏览器侧不再留驻整条会话事件流。
 * deps 用假件驱动 HTTP 折叠层；wire 形状与既有 exact 路由一致（no-store JSON）。
 */

import { describe, expect, it } from 'vitest'

import {
  ROUTER_SESSION_OUTPUT_PATH,
  registerRouterRoutes,
  type RouterRoutesContext,
  type RouterRoutesDeps,
} from '../src/host/routes.ts'

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

function fakeExchange(method: string, url: string) {
  const req = {
    method,
    url,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'end') listener()
    },
  }
  const captured = {} as CapturedResponse
  const res = {
    writeHead(status: number, hdrs?: Record<string, unknown>) {
      captured.status = status
      captured.headers = hdrs ?? {}
    },
    end(body?: string) {
      captured.body = body ?? ''
    },
  }
  return { req, res, captured }
}

function outputDeps(sessionOutput: RouterRoutesDeps['sessionOutput']): RouterRoutesDeps {
  return { sessionOutput } as unknown as RouterRoutesDeps
}

describe('GET /router/session-output：会话输出尾部', () => {
  it('注册 exact 路由；GET 带 sessionId 返回 200 + { text, source }（no-store）', async () => {
    const { ctx, routes } = fakeHttpContext()
    const seen: string[] = []
    registerRouterRoutes(ctx, outputDeps(async (sessionId) => {
      seen.push(sessionId)
      return { text: '最新一段输出', source: 'live' }
    }))
    const route = routes.find((entry) => entry.path === ROUTER_SESSION_OUTPUT_PATH)
    expect(route).toBeDefined()
    const { req, res, captured } = fakeExchange('GET', `${ROUTER_SESSION_OUTPUT_PATH}?sessionId=w-1`)
    await route!.handler(req, res)
    expect(seen).toEqual(['w-1'])
    expect(captured.status).toBe(200)
    expect((captured.headers as { 'cache-control'?: string })['cache-control']).toBe('no-store')
    expect(JSON.parse(captured.body)).toEqual({ text: '最新一段输出', source: 'live' })
  })

  it('缺 sessionId → 400（bad-request 文案）', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, outputDeps(async () => ({ text: '', source: 'none' as const })))
    const route = routes.find((entry) => entry.path === ROUTER_SESSION_OUTPUT_PATH)!
    const { req, res, captured } = fakeExchange('GET', ROUTER_SESSION_OUTPUT_PATH)
    await route.handler(req, res)
    expect(captured.status).toBe(400)
    expect(JSON.parse(captured.body).error).toContain('sessionId')
  })

  it('非 GET 方法 405（allow: GET）', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, outputDeps(async () => ({ text: '', source: 'none' as const })))
    const route = routes.find((entry) => entry.path === ROUTER_SESSION_OUTPUT_PATH)!
    const { req, res, captured } = fakeExchange('POST', ROUTER_SESSION_OUTPUT_PATH)
    await route.handler(req, res)
    expect(captured.status).toBe(405)
  })

  it('deps 抛错：500 + 通用 { error }（不泄露路径）', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, outputDeps(async () => {
      throw new Error('boom /Users/secret/path')
    }))
    const route = routes.find((entry) => entry.path === ROUTER_SESSION_OUTPUT_PATH)!
    const { req, res, captured } = fakeExchange('GET', `${ROUTER_SESSION_OUTPUT_PATH}?sessionId=w-1`)
    await route.handler(req, res)
    expect(captured.status).toBe(500)
    expect(JSON.parse(captured.body)).toEqual({ error: 'internal error' })
  })
})
