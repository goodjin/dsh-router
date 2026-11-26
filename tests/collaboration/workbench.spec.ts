/**
 * 协作工作台独立宿主入口测试（修复工作台路由未挂载，2026-11-26）。
 *
 * 断言：
 *  - (a) workbench 模块 name/inject/Config 形状：name='router-workbench'，
 *    inject=['webServer','connection','routerCollaboration']（必需，缺失可见），Config 空对象；
 *  - (b) apply 后假 webServer 上恰好注册四条路由，路径与方法集合正确（用 405 allow 头验证）；
 *  - (c) 路由用的是注入的 routerCollaboration 同一 store（与工具行同实例：注入 store 存进去、
 *    路由读出来，证明不是新建副本）；
 *  - (d) sessionController 缺席时 models 路由返回 unavailable:true（降级不致命）；
 *  - (f) 真实 @deepseek-ai/cordis Context 挂 entry + workbench + 假 webServer/connection，
 *    路由真的注册成功（而非静默跳过）。
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply as workbenchApply, name as workbenchName, inject as workbenchInject, Config as workbenchConfig } from '../../src/workbench.ts'
import { apply as entryApply } from '../../src/entry.ts'
import {
  COLLABORATION_RECORDS_PATH,
  COLLABORATION_RECORD_PATH,
  COLLABORATION_ROLES_PATH,
  COLLABORATION_MODELS_PATH,
} from '../../src/collaboration/routes.ts'
import { createCollaborationRuntime } from '../../src/collaboration/runtime.ts'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

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

/** 构造 workbench 的假 ctx：effect 立即执行工厂；inject 默认不触发 body（sessionController 缺席）。 */
function workbenchCtx(runtime: ReturnType<typeof createCollaborationRuntime>, opts?: { invokeSessionController?: boolean }) {
  const { webServer, routes } = fakeWebServer()
  const injected: string[][] = []
  const ctx = {
    effect(factory: () => unknown) { return factory() },
    webServer,
    connection: fakeConnection(),
    routerCollaboration: runtime,
    inject(deps: string[], body: (child: unknown) => unknown) {
      injected.push([...deps])
      if (opts?.invokeSessionController) {
        body({ sessionController: { modelCatalog: async () => ({ default: {}, routableProviders: [], groups: [], failures: [] }) } })
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

describe('workbench apply — sessionController 缺席时 models 路由降级', () => {
  it('models 路由返回 unavailable:true（降级不致命）', async () => {
    const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-workbench-nosessioncontroller' })
    const { ctx, routes } = workbenchCtx(runtime) // 默认不 invokeSessionController → sessionController 缺席
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

describe('workbench apply — sessionController 捕获不到打一次性警告（不静默、不刷屏）', () => {
  it('ctx.inject 不可用 → 打一次警告，models 会 unavailable，路由仍注册', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-workbench-no-inject' })
      const { webServer, routes } = fakeWebServer()
      const ctx = {
        effect(factory: () => unknown) { return factory() },
        webServer,
        connection: fakeConnection(),
        routerCollaboration: runtime,
        // 无 inject 通道：sessionController 必然捕获不到。
      }
      workbenchApply(ctx as never)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('unavailable')
      // sessionController 缺席不挡挂载：四条路由照常注册。
      expect(routes).toHaveLength(4)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('注入回调里 sessionController 形状不符 → 打一次警告（不重复）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-workbench-bad-sessioncontroller' })
      const { webServer, routes } = fakeWebServer()
      const ctx = {
        effect(factory: () => unknown) { return factory() },
        webServer,
        connection: fakeConnection(),
        routerCollaboration: runtime,
        inject(_deps: string[], body: (child: unknown) => unknown) {
          // sessionController 服务存在但缺 modelCatalog：形状不符。
          body({ sessionController: { modelCatalog: undefined } })
          return { dispose() {} }
        },
      }
      workbenchApply(ctx as never)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('unavailable')
      expect(routes).toHaveLength(4)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('装载面覆盖 — 声明行名经 exports 解析到宿主产物', () => {
  it('@goodjin2/dsh-router/workbench 经 exports["./workbench"] 解析到可导入产物，name/inject 与声明一致', async () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { types?: string; default?: string }>
    }
    const exp = pkg.exports['./workbench']
    expect(exp?.default, 'exports["./workbench"].default 缺失').toBe('./dist/workbench.js')
    const artifact = resolve(repoRoot, exp!.default!)
    expect(existsSync(artifact), 'dist/workbench.js 不存在——先 npm run build').toBe(true)

    // 声明行在 cordis.patch.yml 里存在且 name 与子路径一致。
    const patchText = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8')
    expect(patchText).toMatch(/-\s+id:\s*dsh-router-workbench\b/)
    expect(patchText).toMatch(/name:\s*['"]@goodjin2\/dsh-router\/workbench['"]/)

    // 产物可导入，且 name/inject 与源模块级声明一致。
    const mod = (await import(pathToFileURL(artifact).href)) as { name: string; inject: readonly string[] }
    expect(mod.name).toBe(workbenchName)
    expect([...mod.inject]).toEqual([...workbenchInject])
  })
})
