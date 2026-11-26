/**
 * 协作工作台独立宿主入口测试（修复工作台路由未挂载，2026-11-26）。
 *
 * 断言：
 *  - (a) workbench 模块 name/inject/Config 形状：name='router-workbench'，
 *    inject=['webServer','connection','routerCollaboration']（必需，缺失可见），Config 空对象；
 *  - (b) apply 后假 webServer 上恰好注册四条路由，路径与方法集合正确（用 405 allow 头验证）；
 *  - (c) 路由用的是注入的 routerCollaboration 同一 store（与工具行同实例：注入 store 存进去、
 *    路由读出来，证明不是新建副本）；
 *  - (d) llm 缺席时 models 路由返回 unavailable:true（降级不致命）；
 *  - (f) 真实 @deepseek-ai/cordis Context 挂 entry + workbench + 假 webServer/connection，
 *    路由真的注册成功（而非静默跳过）。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { apply as workbenchApply, name as workbenchName, inject as workbenchInject, Config as workbenchConfig } from '../../src/workbench.ts'
import { apply as entryApply } from '../../src/entry.ts'
import {
  COLLABORATION_RECORDS_PATH,
  COLLABORATION_RECORD_PATH,
  COLLABORATION_ROLES_PATH,
  COLLABORATION_MODELS_PATH,
} from '../../src/collaboration/routes.ts'
import { createCollaborationRuntime } from '../../src/collaboration/runtime.ts'

/** 路由注册项的最小形状（webServer.register 收到的对象）。 */
interface CapturedRoute {
  kind: string
  path: string
  handler(request: unknown, response: unknown): void | Promise<void>
}

/** 假 webServer：capture register 收到的路由对象。 */
function fakeWebServer() {
  const routes: CapturedRoute[] = []
  return {
    webServer: {
      register(route: CapturedRoute): () => void {
        routes.push(route)
        return () => {}
      },
    },
    routes,
  }
}

/** 假 connection：始终放行（无 rejection）。 */
function fakeConnection() {
  return { admit: () => ({ peer: {} }) }
}

/** 记录型假 response：capture writeHead/end 的状态码、头与体。 */
function fakeResponse() {
  const calls: Array<{ status: number; headers?: Record<string, unknown>; body: string }> = []
  const response = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      calls.push({ status, headers, body: '' })
      return response
    },
    end(body?: unknown) {
      const last = calls[calls.length - 1]
      if (last !== undefined) last.body = String(body ?? '')
      return response
    },
  }
  return { response, calls }
}

/** 假 request：仅 GET 路由所需的 method/url 面。 */
function fakeRequest(method: string, url = '/') {
  return { method, url }
}

/** 构造 workbench 的假 ctx：effect 立即执行工厂；inject 默认不触发 body（llm 缺席）。 */
function workbenchCtx(runtime: ReturnType<typeof createCollaborationRuntime>, opts?: { invokeLlm?: boolean }) {
  const { webServer, routes } = fakeWebServer()
  const injected: string[][] = []
  const ctx = {
    effect(factory: () => unknown) { return factory() },
    webServer,
    connection: fakeConnection(),
    routerCollaboration: runtime,
    inject(deps: string[], body: (child: unknown) => unknown) {
      injected.push([...deps])
      if (opts?.invokeLlm) {
        body({ llm: { listProviders: async () => [], listModels: async () => [] } })
      }
      return { dispose() {} }
    },
  }
  return { ctx, routes, injected }
}

const ALL_PATHS = [COLLABORATION_RECORDS_PATH, COLLABORATION_RECORD_PATH, COLLABORATION_ROLES_PATH, COLLABORATION_MODELS_PATH]

describe('workbench 独立行 — name/inject/Config 形状', () => {
  it('name 是 router-workbench；inject 是三个必需依赖；Config 空对象', () => {
    expect(workbenchName).toBe('router-workbench')
    expect([...workbenchInject]).toEqual(['webServer', 'connection', 'routerCollaboration'])
    expect(typeof workbenchConfig).toBe('function')
    expect(() => workbenchConfig({})).not.toThrow()
  })
})

describe('workbench apply — 假 webServer 上注册四条路由（路径与方法集合）', () => {
  it('恰好注册四条路由，路径正确，方法集合正确（405 allow 头）', async () => {
    const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-workbench-routes' })
    const { ctx, routes } = workbenchCtx(runtime)
    const dispose = workbenchApply(ctx as never)
    expect(typeof dispose).toBe('function')

    expect(routes.map((r) => r.path).sort()).toEqual([...ALL_PATHS].sort())
    expect(routes).toHaveLength(4)

    // 每条路由的 allow 集合（用 OPTIONS 触发 405 + allow 头，验证方法集合）。
    const allowByPath = new Map<string, string>()
    for (const route of routes) {
      const { response, calls } = fakeResponse()
      await route.handler(fakeRequest('OPTIONS', route.path), response)
      const first = calls[0]!
      expect(first.status).toBe(405)
      const allow = String((first.headers as Record<string, unknown>).allow ?? '')
      allowByPath.set(route.path, allow)
    }
    expect(allowByPath.get(COLLABORATION_RECORDS_PATH)).toBe('GET')
    expect(allowByPath.get(COLLABORATION_RECORD_PATH)).toBe('GET')
    expect(allowByPath.get(COLLABORATION_ROLES_PATH)).toBe('GET, POST')
    expect(allowByPath.get(COLLABORATION_MODELS_PATH)).toBe('GET')
  })
})

describe('workbench apply — 路由用注入的 routerCollaboration 同一 store', () => {
  it('注入 store 存角色、路由读出来（不是新建副本）', async () => {
    const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-workbench-samestore' })
    await runtime.roles.save({ name: 'router-workbench-执行者', description: '通用执行角色' })

    const { ctx, routes } = workbenchCtx(runtime)
    workbenchApply(ctx as never)

    const rolesRoute = routes.find((r) => r.path === COLLABORATION_ROLES_PATH)!
    const { response, calls } = fakeResponse()
    await rolesRoute.handler(fakeRequest('GET', COLLABORATION_ROLES_PATH), response)
    const body = JSON.parse(calls[calls.length - 1]!.body) as Array<{ name: string }>
    expect(body.map((r) => r.name)).toContain('router-workbench-执行者')
  })
})

describe('workbench apply — llm 缺席时 models 路由降级', () => {
  it('models 路由返回 unavailable:true（降级不致命）', async () => {
    const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-workbench-nollm' })
    const { ctx, routes } = workbenchCtx(runtime) // 默认不 invokeLlm → llm 缺席
    workbenchApply(ctx as never)

    const modelsRoute = routes.find((r) => r.path === COLLABORATION_MODELS_PATH)!
    const { response, calls } = fakeResponse()
    await modelsRoute.handler(fakeRequest('GET', COLLABORATION_MODELS_PATH), response)
    const body = JSON.parse(calls[calls.length - 1]!.body) as { unavailable: boolean }
    expect(body.unavailable).toBe(true)
  })
})

describe('workbench 真实 cordis 挂载（entry + workbench + 假 webServer/connection）', () => {
  it('entry 提供 routerCollaboration，workbench 经 inject 挂上四条路由', async () => {
    const ctx = new Context()
    const registered: Array<{ path: string }> = []
    ctx.provide('webServer', {
      register: (route: { path: string }) => { registered.push(route); return () => {} },
    })
    ctx.provide('connection', { admit: () => ({ peer: {} }) })

    // 挂 entry（根服务行，提供 routerCollaboration）再挂 workbench（独立工作台行）。
    entryApply(ctx as never, { dataDir: '/tmp/router-workbench-cordis' })
    workbenchApply(ctx as never)

    // 等待 fire-and-forget 的注入/effect fiber 落定（与 host-routes 夹具同款 flush）。
    await new Promise((resolve) => { setTimeout(resolve, 10) })

    expect(registered.map((r) => r.path).sort()).toEqual([...ALL_PATHS].sort())
    // 根服务单实例仍在（记录/工具经作用域链取用）。
    const face = ctx.get('routerCollaboration') as { records: { list: unknown }; roles: { list: unknown } } | undefined
    expect(face).toBeTruthy()
    expect(typeof face?.records.list).toBe('function')
    expect(typeof face?.roles.list).toBe('function')
  })
})
