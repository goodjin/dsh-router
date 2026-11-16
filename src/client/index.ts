/**
 * DSH Router — 浏览器半边工厂（轻量协作版，计划 Task 3 起）。
 *
 * 页面把 exports["./client"]（lib/client.js，tsdown 产物）当普通脚本加载，
 * 本文件编译进 `window.__ModuleLoader__.load({ id, factory })` 的 factory：
 * factory 返回 { name, inject, apply }，页面在物化时调 apply。
 *
 * Task 3 起浏览器半边是**协作工作台**：头部一个按钮「协作工作台」开合可关闭浮层，
 * 集中展示任务资料/记录详情/会话跳转/角色模板编辑。旧的工作台标签条、问题浮窗、
 * 返回按钮、设置段一概不再注册（oldsurfacesnotregistered；旧模块文件保留待 Task 4
 * 退役）。工作台经同源薄 HTTP（/router/collaboration/*）取数，DSH 仍负责通信与执行。
 *
 * inject 声明页面真实服务名：slots（表面座位）、uiSession（当前会话——根会话默认值）、
 * uiWorkspace（openSession 会话跳转）。组件绝不收 ctx：apply 把服务组装成业务面，
 * 经 registration 的 inject 工厂下发。所有服务可选、缺失即降级，不炸整条 entry。
 */

import { createCollaborationApi } from './collaboration-api.ts'
import { registerCollaborationPanel } from './collaboration-panel.tsx'
import type { CollaborationStore } from './collaboration-store.ts'
import { startCollaborationStore } from './collaboration-store.ts'

/** Loader 行与诊断里看到的插件名；与 cordis.patch.yml 的裸包名行一致。 */
export const name = '@goodjin2/dsh-router'

/**
 * 依赖的页面服务（确切服务名）。工作台只需 slots/uiSession/uiWorkspace；
 * 旧的 workspaces 列表映射随旧标签条退役，不再声明。
 */
export const inject = ['slots', 'uiSession', 'uiWorkspace'] as const

/** slots 服务的最小面（结构化；真实 face 由页面提供）。 */
export interface SlotsHost {
  inject(key: string, prepare: () => unknown): unknown
  register(options: { name: string; id?: string; order?: number }, component: unknown): unknown
}

/** apply 收到的 ctx 的最小面（全部可选：缺失时降级，不抛）。 */
export interface PluginContext {
  logger?(name: string): { info(message: string): void; warn(message: string): void }
  effect?(callback: () => unknown): unknown
  slots?: SlotsHost
  uiSession?: {
    adapter?: {
      current?: {
        subscribe(listener: () => void): unknown
        getSnapshot?(): { key?: string } | undefined
      }
    }
  }
  uiWorkspace?: { openSession(target: string): void }
}

/** 守卫读取：访问可能抛错的属性（getter throw / 服务降级）时返回 undefined，绝不外抛。 */
function safeGet<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** 错误文案（仅用于诊断）。 */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 诊断日志：logger 对象的方法本身也可能抛——info/warn 实现保证**不穿透**：
 * 先试宿主 logger（抛错或不可用即放弃），再落 console（console 也守一遍）。绝不因日志把整条 entry 弄挂。
 */
function makeLogger(ctx: PluginContext): { info(message: string): void; warn(message: string): void } {
  const emit = (method: 'info' | 'warn', message: string): void => {
    let logged = false
    try {
      const sink = ctx.logger?.(name)
      const fn = sink?.[method]
      if (typeof fn === 'function') {
        fn.call(sink, message)
        logged = true
      }
    } catch {
      // logger 获取/调用抛错 → 落 console。
    }
    if (!logged) {
      try {
        if (method === 'info') console.info(`[${name}] ${message}`)
        else console.warn(`[${name}] ${message}`)
      } catch {
        // 连 console 都没有：最后兜底也只能放弃，绝不抛。
      }
    }
  }
  return {
    info: (message) => { emit('info', message) },
    warn: (message) => { emit('warn', message) },
  }
}

/** uiWorkspace.openSession：守卫读取 + 调用；不可用 → no-op + 可见诊断，表面仍注册。 */
function makeUiWorkspace(safeCtx: PluginContext, log: ReturnType<typeof makeLogger>): { openSession(target: string): void } {
  const workspace = safeGet(() => safeCtx.uiWorkspace)
  const openSession = workspace === undefined ? undefined : safeGet(() => (workspace as { openSession?: unknown }).openSession)
  if (typeof openSession === 'function') {
    return {
      openSession: (target: string) => {
        try {
          ;(openSession as (t: string) => void).call(workspace, target)
        } catch (error) {
          log.warn(`uiWorkspace.openSession failed: ${errorMessageOf(error)}`)
        }
      },
    }
  }
  return { openSession: () => { log.warn('uiWorkspace unavailable: openSession skipped') } }
}

/** 从 uiSession binding source 读当前主视图会话 id（根会话默认值来源）；全程守卫，抛错按无会话。 */
function readCurrentSessionId(safeCtx: PluginContext): string | undefined {
  const uiSession = safeGet(() => safeCtx.uiSession)
  const adapter = uiSession === undefined ? undefined : safeGet(() => (uiSession as { adapter?: unknown }).adapter)
  const current = adapter === undefined ? undefined : safeGet(() => (adapter as { current?: unknown }).current)
  const getSnapshot = current === undefined ? undefined : safeGet(() => (current as { getSnapshot?: unknown }).getSnapshot)
  if (typeof getSnapshot !== 'function') return undefined
  try {
    const snapshot = (getSnapshot as () => unknown).call(current)
    const key = snapshot !== null && typeof snapshot === 'object'
      ? (snapshot as { key?: unknown }).key
      : undefined
    return typeof key === 'string' && key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

/** 把订阅清理绑到插件生命周期（ctx.effect）；守卫读取/调用，失败返回 false（调用方立即清理订阅）。 */
function bindLifecycle(safeCtx: PluginContext, dispose: () => void, log: ReturnType<typeof makeLogger>): boolean {
  const effect = safeGet(() => safeCtx.effect)
  if (typeof effect !== 'function') return false
  try {
    effect(() => dispose())
    return true
  } catch (error) {
    log.warn(`uiSession effect binding failed: ${errorMessageOf(error)}`)
    return false
  }
}

/**
 * 当前会话 → store（根会话默认值）。订阅只在能绑定生命周期（ctx.effect）时保留；
 * 否则立即清理，不留无限残留。uiSession 任意一环抛错 → 根会话留空，表面仍注册。
 */
function subscribeCurrentSession(safeCtx: PluginContext, store: CollaborationStore, log: ReturnType<typeof makeLogger>): void {
  const uiSession = safeGet(() => safeCtx.uiSession)
  const adapter = uiSession === undefined ? undefined : safeGet(() => (uiSession as { adapter?: unknown }).adapter)
  const current = adapter === undefined ? undefined : safeGet(() => (adapter as { current?: unknown }).current)
  const subscribe = current === undefined ? undefined : safeGet(() => (current as { subscribe?: unknown }).subscribe)
  if (current === undefined || typeof subscribe !== 'function') {
    log.warn('uiSession service unavailable — root session defaults to blank (no current session)')
    return
  }
  const sync = (): void => { store.setCurrentSession(readCurrentSessionId(safeCtx)) }
  let dispose: unknown
  try {
    dispose = (subscribe as (listener: () => void) => unknown).call(current, sync)
  } catch (error) {
    log.warn(`uiSession subscribe failed: ${errorMessageOf(error)}`)
    return
  }
  // 立即同步一次当前会话（守卫：抛错不影响已建立的订阅）。
  try {
    sync()
  } catch (error) {
    log.warn(`uiSession initial sync failed: ${errorMessageOf(error)}`)
  }
  // 只有能绑定生命周期时才保留订阅；否则立即清理，避免无限残留。
  if (typeof dispose === 'function') {
    if (!bindLifecycle(safeCtx, dispose as () => void, log)) {
      try {
        ;(dispose as () => void)()
      } catch (error) {
        log.warn(`uiSession dispose failed: ${errorMessageOf(error)}`)
      }
    }
  }
}

/**
 * 组装依赖并注册协作工作台。**全体最后兜底**：任何意外都不穿透 apply——
 * 真实宿主里 apply 抛错 = fiber 标记 failed、web boot 报 entry did not activate、整行功能消失。
 * 逐块守卫：slots 不可用 → 不挂表面；uiSession 不可用 → 根会话留空、表面仍注册；
 * uiWorkspace 不可用 → no-op 跳转 + 可见诊断、表面仍注册。
 */
export function apply(ctx?: PluginContext): void {
  try {
    applyWorkbench(ctx)
  } catch (error) {
    // 最后一道兜底只能走 console（logger 本身可能抛）；仍不抛。
    try {
      console.warn(`[${name}] collaboration apply failed: ${errorMessageOf(error)}`)
    } catch {
      /* 连 console 也没有也只能放弃 */
    }
  }
}

function applyWorkbench(ctx?: PluginContext): void {
  const safeCtx: PluginContext = ctx ?? {}
  const log = makeLogger(safeCtx)
  log.info('Router client loaded — collaboration workbench')

  // slots 守卫读取：不可用（缺失/抛错/方法非函数）则警告、不注册表面、不抛。
  const slots = safeGet(() => safeCtx.slots)
  const inject = safeGet(() => slots?.inject)
  const register = safeGet(() => slots?.register)
  if (typeof inject !== 'function' || typeof register !== 'function') {
    log.warn('slots service unavailable — no surfaces registered (client half idle)')
    return
  }

  const uiWorkspace = makeUiWorkspace(safeCtx, log)

  // 工作台 store：经同源薄 API 取数；失败可见、不冒充空。诊断接 logger.warn。
  const store: CollaborationStore = startCollaborationStore({
    api: createCollaborationApi(),
    report: (message) => { log.warn(message) },
  })

  // 当前会话 → store（根会话默认值）；订阅清理经 ctx.effect，绑不上立即清理。
  subscribeCurrentSession(safeCtx, store, log)

  // 头部按钮「协作工作台」+ 可关闭浮层（取代旧标签条/浮窗/设置段/返回按钮）。
  try {
    registerCollaborationPanel(slots!, { store, uiWorkspace })
  } catch (error) {
    log.warn(`collaboration panel failed to register: ${errorMessageOf(error)}`)
  }
}
