/**
 * DSH Router — 浏览器半边工厂（协作视图页版）。
 *
 * 页面把 exports["./client"]（lib/client.js，tsdown 产物）当普通脚本加载，
 * 本文件编译进 `window.__ModuleLoader__.load({ id, factory })` 的 factory：
 * factory 返回 { name, inject, apply }，页面在物化时调 apply。
 *
 * 浏览器半边是**协作视图页**：会话标签行（conversation.view）的「协作」页，
 * 与官方统计页同款挂法——整页显示在会话界面里，取代旧「头部按钮 + 弹出卡片」。
 * 工作台经同源薄 HTTP（/router/collaboration/*）取数，DSH 仍负责通信与执行。
 *
 * inject 声明页面真实服务名：slots（表面座位）、sessions（子会话目录按需加载）、
 * uiSession（当前会话——根会话默认值）、uiWorkspace（openSession 会话跳转）。
 * 组件绝不收 ctx：apply 把服务组装成业务面，经 registration 的 inject 工厂下发。
 * 所有服务可选、缺失即降级，不炸整条 entry。
 */

import { createCollaborationApi } from './collaboration-api.ts'
import type { CollaborationStore } from './collaboration-store.ts'
import { startCollaborationStore } from './collaboration-store.ts'
import { registerCollaborationView } from './collaboration-view.tsx'

/** Loader 行与诊断里看到的插件名；与 cordis.patch.yml 的裸包名行一致。 */
export const name = '@goodjin2/dsh-router'

/**
 * 依赖的页面服务（确切服务名）。视图页需要 slots/sessions/uiSession/uiWorkspace；
 * sessions 用于按需加载子会话目录（画布父子树），缺失时画布降级为无子层。
 */
export const inject = ['slots', 'sessions', 'uiSession', 'uiWorkspace'] as const

/** slots 服务的最小面（结构化；真实 face 由页面提供）。 */
export interface SlotsHost {
  inject(key: string, prepare: () => unknown): unknown
  register(options: { name: string; id?: string; order?: number; label?: string | (() => string) }, component: unknown): unknown
}

/** apply 收到的 ctx 的最小面（全部可选：缺失时降级，不抛）。 */
export interface PluginContext {
  logger?(name: string): { info(message: string): void; warn(message: string): void }
  effect?(callback: () => unknown): unknown
  slots?: SlotsHost
  sessions?: { refreshProjections?(sessionId: string): unknown }
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

/**
 * sessions.refreshProjections：守卫读取 + 调用；不可用 → no-op（画布降级为无子层）。
 * 诊断只警告一次（每次画布节点请求都会走这里，逐次刷屏没意义）；调用返回的 Promise 就地兜底。
 */
function makeRefreshProjection(safeCtx: PluginContext, log: ReturnType<typeof makeLogger>): (sessionId: string) => void {
  const sessions = safeGet(() => safeCtx.sessions)
  const refresh = sessions === undefined ? undefined : safeGet(() => (sessions as { refreshProjections?: unknown }).refreshProjections)
  if (typeof refresh !== 'function') {
    let warned = false
    return () => {
      if (warned) return
      warned = true
      log.warn('sessions.refreshProjections unavailable — canvas catalogs degrade to loaded projections only')
    }
  }
  return (sessionId: string) => {
    try {
      const result = (refresh as (id: string) => unknown).call(sessions, sessionId)
      if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
        ;(result as Promise<void>).catch((error: unknown) => {
          log.warn(`sessions.refreshProjections failed for ${sessionId}: ${errorMessageOf(error)}`)
        })
      }
    } catch (error) {
      log.warn(`sessions.refreshProjections threw for ${sessionId}: ${errorMessageOf(error)}`)
    }
  }
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

/**
 * 把订阅清理绑到插件生命周期（ctx.effect）。官方 cordis 契约：effect setup **返回 disposer**，
 * 卸载时由 Cordis 调用——插件自身不在激活期调用它。setup 返回**受守卫的 disposer**（dispose 调用
 * 失败 log.warn 不穿透）；effect 缺失/抛错 → 返回 false，调用方立即清理订阅（不留无限残留）。
 */
function bindLifecycle(safeCtx: PluginContext, dispose: () => void, log: ReturnType<typeof makeLogger>): boolean {
  const effect = safeGet(() => safeCtx.effect)
  if (typeof effect !== 'function') return false
  try {
    effect(() => () => {
      try {
        dispose()
      } catch (error) {
        log.warn(`uiSession dispose failed: ${errorMessageOf(error)}`)
      }
    })
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
  const sync = (): void => {
    store.setCurrentSession(readCurrentSessionId(safeCtx))
    void store.refreshRecords()
  }
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
 * 组装依赖并注册协作视图页。**全体最后兜底**：任何意外都不穿透 apply——
 * 真实宿主里 apply 抛错 = fiber 标记 failed、web boot 报 entry did not activate、整行功能消失。
 * 逐块守卫：slots 不可用 → 不挂表面；uiSession 不可用 → 根会话留空、表面仍注册；
 * uiWorkspace 不可用 → no-op 跳转 + 可见诊断、表面仍注册；sessions 不可用 → 画布降级、表面仍注册。
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
  log.info('Router client loaded — collaboration view')

  // slots 守卫读取：不可用（缺失/抛错/方法非函数）则警告、不注册表面、不抛。
  const slots = safeGet(() => safeCtx.slots)
  const inject = safeGet(() => slots?.inject)
  const register = safeGet(() => slots?.register)
  if (typeof inject !== 'function' || typeof register !== 'function') {
    log.warn('slots service unavailable — no surfaces registered (client half idle)')
    return
  }

  const uiWorkspace = makeUiWorkspace(safeCtx, log)
  const refreshProjection = makeRefreshProjection(safeCtx, log)

  // 工作台 store：经同源薄 API 取数；失败可见、不冒充空。诊断接 logger.warn。
  const store: CollaborationStore = startCollaborationStore({
    api: createCollaborationApi(),
    report: (message) => { log.warn(message) },
  })

  // 当前会话 → store（根会话默认值）；订阅清理经 ctx.effect，绑不上立即清理。
  subscribeCurrentSession(safeCtx, store, log)

  // 会话标签行的「协作」视图页（与官方统计页同款挂法，取代旧头部按钮 + 弹出卡片）。
  try {
    registerCollaborationView(slots!, { store, uiWorkspace, refreshProjection })
  } catch (error) {
    log.warn(`collaboration view failed to register: ${errorMessageOf(error)}`)
  }
}
