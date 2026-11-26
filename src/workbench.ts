/**
 * 协作工作台独立宿主入口（`@goodjin2/dsh-router/workbench`，修复工作台路由未挂载）。
 *
 * 背景（2026-11-26 实测）：工作台「角色」列表走 GET /router/collaboration/roles，
 * 桌面宿主对这条路径返回 404（路由根本没挂上），而别家插件同款接口返回 401（路由在、
 * 只是未登录）。原因：这四条路由原先挂在根服务 src/entry.ts 的可选注入
 * `ctx.inject?.(['webServer','connection'], …)` 上——可选链号 + 零日志，走不通就静默
 * 跳过，宿主不报错、日志无痕。
 *
 * 修复：把工作台路由拆成**独立一行**，模块级声明 `inject = ['webServer', 'connection',
 * 'routerCollaboration']`（必需依赖，缺失即 PENDING/失败，可见而非静默），由宿主装载器
 * 接线。路由与模型工具行共用同一 RecordStore/RoleStore 单实例（routes_reuse_store 语义
 * 不变）。llm 是可选依赖（models 路由用），用 ctx.inject?.(['llm'], …) 捕获并缓存，
 * 取不到时 models 路由返回 unavailable:true（降级不致命）。
 */

import Schema from '@deepseek-ai/schemastery'

import {
  registerCollaborationRoutes,
  type CollaborationLlm,
  type CollaborationRouteContext,
} from './collaboration/routes.ts'
import type { RecordStore, RoleStore } from './collaboration/types.ts'

/** 本入口的插件名（诊断显示用）。 */
export const name = 'router-workbench'

/** 必需依赖：webServer/connection 挂路由，routerCollaboration 取共享存储单实例。 */
export const inject = ['webServer', 'connection', 'routerCollaboration'] as const

/** 行配置：无（与 tools 行同款空对象，让形状显式、可测）。 */
export const Config = Schema.object({})

/** 本入口需要的宿主面（注入后都必然在）。 */
interface WorkbenchContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: NonNullable<CollaborationRouteContext['webServer']>
  connection: NonNullable<CollaborationRouteContext['connection']>
  routerCollaboration: {
    records: RecordStore
    roles: RoleStore
  }
  inject?(deps: string[], body: (child: unknown) => unknown): unknown
}

/**
 * 注册四条工作台路由（records / record / roles / models），与工具行共享同一
 * RecordStore/RoleStore 单实例。llm 可选注入（models 路由用）；取不到时 models
 * 路由返回 unavailable:true。返回联合注销器交给宿主 effect 生命周期。
 */
export function apply(ctx: WorkbenchContext): () => void {
  // llm 是可选依赖：捕获并缓存，models 路由在请求时再读。捕获不到（ctx.inject 不可用，
  // 或注入回调里 llm 形状不符）就打一条一次性警告（只打一次、不刷屏），说明 models
  // 路由会返回 unavailable:true；路由仍注册、models 降级不致命。
  let llmFace: CollaborationLlm | undefined
  let llmWarned = false
  const warnLlmUnavailable = (): void => {
    if (llmWarned) return
    llmWarned = true
    console.warn('[dsh-router] workbench: llm 不可用，models 路由将返回 unavailable:true')
  }

  const fibers: Array<{ dispose?: () => void | Promise<void> }> = []
  const track = (fiber: unknown): void => {
    if (typeof fiber === 'object' && fiber !== null) fibers.push(fiber as { dispose?: () => void | Promise<void> })
  }
  const injectFn = ctx.inject
  if (typeof injectFn !== 'function') {
    // 宿主没有 inject 通道：llm 必然捕获不到，models 路由只能 unavailable。
    warnLlmUnavailable()
  } else {
    track(injectFn(['llm'], (child) => {
      const llm = (child as { llm?: CollaborationLlm }).llm
      if (llm !== undefined && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
        llmFace = llm
      } else {
        warnLlmUnavailable()
      }
    }))
  }

  // 注册四条路由；失败（例如宿主 webServer 契约不匹配）打警告日志——不再静默。
  try {
    registerCollaborationRoutes(ctx, {
      records: ctx.routerCollaboration.records,
      roles: ctx.routerCollaboration.roles,
      llm: () => llmFace,
    })
    console.log(
      '[dsh-router] workbench routes registered: /router/collaboration/records, /router/collaboration/record, /router/collaboration/roles, /router/collaboration/models',
    )
  } catch (error) {
    console.warn(
      '[dsh-router] workbench routes registration failed:',
      error instanceof Error ? error.message : String(error),
    )
  }

  return () => {
    for (const fiber of fibers) {
      try {
        const result = fiber.dispose?.()
        if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>).catch(() => {})
        }
      } catch {
        // 注销失败不挡卸载
      }
    }
  }
}
