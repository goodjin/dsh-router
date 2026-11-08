/**
 * GET /router/health：轻量诊断路由（v1.4 索引 + 收编口径）。
 *
 * 报告内容 = SessionHeaderIndex.diagnostics()（bootstrap/队列/判定分布/头 IO/
 * 字节/单飞）+ adoption 段（轮次/登记/投递/重试队列/核验拒绝/stale 跳过/错误
 * 计数）。只报计数与状态名，不含会话 id/路径等私有内容。deps 用假件驱动
 * HTTP 折叠层；wire 形状与既有 exact 路由一致（no-store JSON）。
 */

import { describe, expect, it } from 'vitest'

import { ROUTER_HEALTH_PATH, registerRouterRoutes, type RouterRoutesContext, type RouterRoutesDeps } from '../src/host/routes.ts'

/* ────────────────────────── 假 HTTP 上下文（照 routes-worker-types 同款） ────────────────────────── */

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

interface IncomingMessageLike {
  method?: string
  url?: string
  on(event: string, listener: (...args: unknown[]) => void): void
}

function fakeExchange(method: string, url: string) {
  const req: IncomingMessageLike = {
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

/** 最小 deps：只实现 getHealth，其余路由面不会被健康路由碰到。 */
function healthDeps(report: Record<string, unknown> | (() => Promise<Record<string, unknown>>)): RouterRoutesDeps {
  return {
    getHealth: typeof report === 'function' ? report : async () => report,
  } as unknown as RouterRoutesDeps
}

describe('GET /router/health：诊断路由', () => {
  it('注册 exact 路由；GET 返回 200 + JSON 计数（no-store）', async () => {
    const { ctx, routes } = fakeHttpContext()
    const report = {
      preset: 'dsh-router',
      queueLength: 3,
      failures: 1,
      bootstrap: { initialDone: true },
      entries: { total: 42, router: 5, nonrouter: 36, unknown: 1, live: 0 },
      header: { attempts: 50, errors: 1, cacheReused: 8, bytesCompressed: 12345, bytesDecompressed: 678 },
      scan: { attempts: 20, finals: 18, caps: 1, unstable: 1 },
      concurrency: { inflightAdvance: false, inflightReconcile: false, reconcileRuns: 4, advanceRuns: 6 },
      degraded: { unsupportedCodec: false },
      adoption: { rounds: 12, registered: 5, delivered: 5, retryQueue: 0, verifyRejected: 1, staleSkipped: 0, retriesDropped: 0, errors: 0, inflight: false },
    }
    registerRouterRoutes(ctx, healthDeps(report))
    const route = routes.find((entry) => entry.path === ROUTER_HEALTH_PATH)
    expect(route).toBeDefined()
    const { req, res, captured } = fakeExchange('GET', ROUTER_HEALTH_PATH)
    await route!.handler(req, res)
    expect(captured.status).toBe(200)
    expect((captured.headers as { 'content-type'?: string })['content-type']).toBe('application/json')
    expect((captured.headers as { 'cache-control'?: string })['cache-control']).toBe('no-store')
    expect(JSON.parse(captured.body)).toEqual(report)
  })

  it('非 GET 方法 405（allow: GET）', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, healthDeps({}))
    const route = routes.find((entry) => entry.path === ROUTER_HEALTH_PATH)
    const { req, res, captured } = fakeExchange('POST', ROUTER_HEALTH_PATH)
    await route!.handler(req, res)
    expect(captured.status).toBe(405)
  })

  it('getHealth 抛错：500 + { error }（不裸崩）', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, healthDeps(async () => {
      throw new Error('boom')
    }))
    const route = routes.find((entry) => entry.path === ROUTER_HEALTH_PATH)!
    const { req, res, captured } = fakeExchange('GET', ROUTER_HEALTH_PATH)
    await route.handler(req, res)
    expect(captured.status).toBe(500)
    expect(JSON.parse(captured.body)).toEqual({ error: 'boom' })
  })
})
