/**
 * DSH Router 宿主根服务入口（轻量协作版，计划 Task 3 起接入薄路由）。
 *
 * 裸包名行加载本文件（`name` 恰好等于包名的行既是浏览器资产行、也是宿主根服务行）。
 * 本文件在宿主进程里做两件事：
 *  1. 用标准 Cordis provide/lifecycle 组装根服务 `routerCollaboration`——一次解析 dataDir、
 *     创建一条 RecordStore 与一条 RoleStore 单实例，供预设树里的 tools 行 / context 行
 *     经 inject ['routerCollaboration'] 取用（记录与工具，CLI 也有）。
 *  2. 经官方 ctx.inject 机会式注入 webServer+connection，挂三条薄路由
 *     （/router/collaboration/*）给工作台 UI 用——与模型工具共享同一 RecordStore/RoleStore。
 *     webServer/connection 缺席（如纯 CLI 宿主）时不挂路由、不挡记录/工具服务。
 *
 * 不再装配：旧 routerCore、旧 HTTP 路由、会话收编/监听、派发预算、摘要替换、动态预设引擎、
 * 压缩驱动、问答瀑布、紧急暂停熔断。这些是旧事务协议的控制面，本设计明确排除；旧代码与
 * 用户数据保留，但不接入新入口。浏览器半边（src/client）由 Task 3 的协作工作台取代旧表面。
 *
 * 配置只有 dataDir（可缺省，缺省 DSH_HOME/router）。构造是纯内存的：不扫描、不建目录、
 * 不起引擎；存储真正做 IO 时才碰文件系统。
 */

import Schema from '@deepseek-ai/schemastery'

import { createCollaborationRuntime } from './collaboration/runtime.ts'
import { registerCollaborationRoutes, type CollaborationLlm, type CollaborationRouteContext } from './collaboration/routes.ts'
import { seedPresetRoles } from './collaboration/roles.ts'
import { createActiveTaskCache, type ActiveTaskCache } from './collaboration/active-tasks.ts'
import {
  createModelSwitch,
  type ChildModelRun,
  type ModelSwitchAgents,
  type ModelSwitchSubagents,
} from './collaboration/model-switch.ts'

/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
export const name = '@goodjin2/dsh-router'

/**
 * 根服务不 require 任何旧宿主服务：它只 provide 一个纯内存运行时。
 * webServer/connection 经官方 ctx.inject 机会式注入（见 apply），不进全局必需数组——
 * 否则缺席时整行装载失败、CLI 记录/工具服务也被拖死（brief：不能 required 使 CLI 不可用）。
 */
export const inject = [] as const

/** 根配置：只有 dataDir，全部可缺省（缺省 DSH_HOME/router，运行时解析一次）。 */
export const Config = Schema.object({
  dataDir: Schema.string().default(''),
})

/** 根服务对外暴露的面（tools/context 行经作用域链取用）。 */
export interface RouterCollaborationFace {
  records: ReturnType<typeof createCollaborationRuntime>['records']
  roles: ReturnType<typeof createCollaborationRuntime>['roles']
  dataDir: string
  /** 活跃任务视图缓存：tools/dispatch 行写后刷新，context 行同步读（见 active-tasks.ts）。 */
  activeTasks: ActiveTaskCache
  /** 本次 apply 的子会话候选游标。不落盘，卸载后不重建。 */
  childModelRuns: Map<string, ChildModelRun>
}

/** apply 收到的 ctx 最小面：provide 必需；root 用于全局服务发布；inject 机会式。 */
interface EntryContext {
  provide(name: string, value: unknown): () => void
  root?: { provide(name: string, value: unknown): () => void }
  inject?(deps: string[], body: (child: unknown) => unknown): unknown
  effect?(factory: () => unknown, label?: string): unknown
}

/**
 * 装载入口：组装根服务并 provide，再机会式挂三条薄路由。标准 Cordis 生命周期——
 * 返回注销器（路由注册与存储单实例随 fiber 销毁自然回收；保留 disposer 形状）。
 */
export function apply(ctx: EntryContext, rawConfig: unknown): () => void {
  const config = (rawConfig ?? {}) as { dataDir?: unknown }
  const runtime = createCollaborationRuntime({ dataDir: typeof config.dataDir === 'string' ? config.dataDir : undefined })
  const childModelRuns = new Map<string, ChildModelRun>()
  const face: RouterCollaborationFace = {
    records: runtime.records,
    roles: runtime.roles,
    dataDir: runtime.dataDir,
    activeTasks: createActiveTaskCache(runtime.records),
    childModelRuns,
  }
  // 服务必须发布到根作用域：预设内部插件（tools/context 行）经 isolate 符号解析服务，
  // 只有根级 provide 才能让所有子上下文（含预设 realm）看见。ctx.provide 只发布到
  // 当前 fiber 的隔离作用域，预设内部 inject 永远等不到。
  const useRoot = !!(ctx.root?.provide)
  const provideRoot = useRoot ? ctx.root!.provide.bind(ctx.root) : ctx.provide.bind(ctx)
  const released = provideRoot('routerCollaboration', face)
  const disposeService = typeof released === 'function' ? released : () => {}

  // 旧 JSON 角色一次性迁成 md，再幂等种入预置角色（按名判断，不覆盖用户改动）。
  // fire-and-forget 必须就地兜底（宿主把未捕获 rejection 当致命错误）；失败只告警不挡装载。
  runtime.roles.migrateLegacyJson()
    .then(() => seedPresetRoles(runtime.roles))
    .catch((error: unknown) => {
      console.warn('[dsh-router] migrate/seed roles failed:', error instanceof Error ? error.message : String(error))
    })

  // 监听与 llm/agents 都是机会式的：缺了就跳过自动切换或清单，不挡派发和记录。
  // llm 不进 webServer 那组必需 inject，否则缺 llm 时整组路由不挂。
  const watcher = new AbortController()
  let llmFace: CollaborationLlm | undefined
  let agentsFace: ModelSwitchAgents | undefined
  let subagentsFace: ModelSwitchSubagents | undefined
  const switcher = createModelSwitch({
    runs: childModelRuns,
    records: runtime.records,
    activeTasks: face.activeTasks,
    signal: watcher.signal,
    getAgents: () => agentsFace,
    getSubagents: () => subagentsFace,
    getLlm: () => llmFace,
  })
  const fibers: Array<{ dispose?: () => void | Promise<void> }> = []
  const track = (fiber: unknown): void => {
    if (typeof fiber === 'object' && fiber !== null) fibers.push(fiber as { dispose?: () => void | Promise<void> })
  }
  const warnSwitch = (error: unknown): void => {
    console.warn('[dsh-router] model switch failed:', error instanceof Error ? error.message : String(error))
  }
  track(ctx.inject?.(['llm'], (child) => {
    const llm = (child as { llm?: CollaborationLlm }).llm
    if (llm !== undefined && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
      llmFace = llm
    }
  }))
  track(ctx.inject?.(['agents', 'subagents'], (child) => {
    const got = child as { agents?: ModelSwitchAgents; subagents?: ModelSwitchSubagents }
    agentsFace = got.agents
    subagentsFace = got.subagents
    void switcher.onAgentsAvailable().catch(warnSwitch)
  }))
  // 机会式注入 webServer+connection：缺席（CLI）则跳过，工作台路由不挂、记录/工具照常。
  // 与模型工具共享同一 runtime 的 records/roles（routes_reuse_store）。
  track(ctx.inject?.(['webServer', 'connection'], (child) => {
    registerCollaborationRoutes(child as CollaborationRouteContext, {
      records: runtime.records,
      roles: runtime.roles,
      llm: () => llmFace,
    })
  }))

  const offs: Array<() => void> = []
  const host = ctx as EntryContext & {
    on?: (name: string, listener: (...args: unknown[]) => void) => unknown
  }
  if (typeof host.on === 'function') {
    const offEvent = host.on('session/event', (session: unknown, event: unknown) => {
      void switcher.onSessionEvent(session, event).catch(warnSwitch)
    })
    const offStatus = host.on('agent/status', (payload: unknown) => {
      void switcher.onAgentStatus(payload).catch(warnSwitch)
    })
    if (typeof offEvent === 'function') offs.push(() => { offEvent() })
    if (typeof offStatus === 'function') offs.push(() => { offStatus() })
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    watcher.abort()
    for (const off of offs) {
      try {
        off()
      } catch (error) {
        warnSwitch(error)
      }
    }
    for (const fiber of fibers) {
      try {
        const result = fiber.dispose?.()
        if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>).catch(() => {})
        }
      } catch (error) {
        warnSwitch(error)
      }
    }
    try {
      disposeService()
    } catch (error) {
      warnSwitch(error)
    }
  }
}
