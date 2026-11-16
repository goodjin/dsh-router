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

/** 从 uiSession 的 binding source 读当前主视图会话 id（根会话默认值来源）。 */
function currentSessionIdOf(ctx: PluginContext): string | undefined {
  const snapshot = ctx.uiSession?.adapter?.current?.getSnapshot?.()
  const key = snapshot?.key
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

function makeLogger(ctx: PluginContext): { info(message: string): void; warn(message: string): void } {
  try {
    const log = ctx.logger?.(name)
    if (typeof log?.info === 'function' && typeof log?.warn === 'function') return log
  } catch {
    // logger 拿不到就落下去用 console，绝不因为日志把整条 entry 弄挂。
  }
  return {
    info: (message) => { console.info(`[${name}] ${message}`) },
    warn: (message) => { console.warn(`[${name}] ${message}`) },
  }
}

/**
 * 组装依赖并注册协作工作台。任何一块失败都只损失那一块（warn + 继续）：
 * slots 缺失则不挂表面；uiSession 缺失则根会话留空（工作台显示「请输入根会话 ID」）。
 */
export function apply(ctx?: PluginContext): void {
  const safeCtx: PluginContext = ctx ?? {}
  const log = makeLogger(safeCtx)
  log.info('Router client loaded — collaboration workbench')

  const slots = safeCtx.slots
  if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') {
    log.warn('slots service unavailable — no surfaces registered (client half idle)')
    return
  }
  const uiWorkspace = safeCtx.uiWorkspace?.openSession !== undefined
    ? safeCtx.uiWorkspace
    : { openSession: () => { log.warn('uiWorkspace unavailable: openSession skipped') } }

  // 工作台 store：经同源薄 API 取数；失败可见、不冒充空。诊断接 logger.warn。
  const store: CollaborationStore = startCollaborationStore({
    api: createCollaborationApi(),
    report: (message) => { log.warn(message) },
  })

  // 当前会话 → store（根会话默认值）。订阅清理经 ctx.effect 挂到插件生命周期；
  // effect 缺席时泄漏一条订阅（页面级插件可容忍）。
  const current = safeCtx.uiSession?.adapter?.current
  if (current !== undefined && typeof current.subscribe === 'function') {
    try {
      const sync = (): void => { store.setCurrentSession(currentSessionIdOf(safeCtx)) }
      const dispose = current.subscribe(sync)
      sync()
      if (typeof dispose === 'function' && typeof safeCtx.effect === 'function') {
        safeCtx.effect(() => dispose)
      }
    } catch (error) {
      log.warn(`uiSession subscription failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    log.warn('uiSession service unavailable — root session defaults to blank (no current session)')
  }

  // 头部按钮「协作工作台」+ 可关闭浮层（取代旧标签条/浮窗/设置段/返回按钮）。
  try {
    registerCollaborationPanel(slots, { store, uiWorkspace })
  } catch (error) {
    log.warn(`collaboration panel failed to register: ${error instanceof Error ? error.message : String(error)}`)
  }
}
