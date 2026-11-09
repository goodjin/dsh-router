/**
 * DSH Router — 浏览器半边工厂（计划 Task B7 的接线层）。
 *
 * 页面把 exports["./client"]（lib/client.js，tsdown 产物）当普通脚本加载，
 * 本文件编译进 `window.__ModuleLoader__.load({ id, factory })` 的 factory：
 * factory 返回 { name, inject, apply }，页面在物化时调 apply。
 *
 * inject 声明页面真实服务名（R3 报告 §4.2 核实）：slots（界面座位）、
 * uiSession（当前会话——激活映射与 workspace 推导）、uiWorkspace（openSession
 * 导航）、workspaces（workspace 列表——把会话映射成 workspaceId 供路由过滤）。
 * 组件绝不收 ctx：apply 在这里把服务组装成业务 face，经 registration 的
 * inject 工厂下发（R3 报告 §7「组件输入的五个来源」）。
 *
 * 表面清单（键名以 R3 报告为准，集中在 surface-ids.ts）：
 * - conversation.header.leading  → 会话导航标签条（Router 固定首位）
 * - shell.overlay                → worker 问题浮窗（收起 chip + 展开表单）
 * - shell.overlay                → 「返回 Router」浮动按钮（worker/主管会话时显示）
 * - shell.overlay                → 统一通知卡浮层（完成/异常卡 + 紧急暂停/解除冻结）
 * - settings.section             → 插件设置段（偏好展示 + 类型管理 + 默认模型）
 *
 * 自报一行状态（仓库纪律：会静默失败的程序动手时就要留能自报的入口）；
 * 每个表面各自 try/catch——一块挂不上只损失那一块，不炸整条 entry。
 */

import { createRouterApi } from './api.ts'
import { registerBackButton } from './back-button.tsx'
import { browserPrefsStorage, startClientPrefs } from './client-prefs.ts'
import { registerNotificationCards } from './notification-cards.tsx'
import { registerSettingsSection } from './settings.tsx'
import { registerWorkbenchTabs } from './workbench-tabs.tsx'
import type { SlotsHost } from './workbench-tabs.tsx'
import { startWorkbenchPolling, startWorkbenchStore } from './workbench-store.ts'
import type { WorkspacesListLike, WorkbenchStore } from './workbench-store.ts'

/** Loader 行与诊断里看到的插件名；与 cordis.patch.yml 的裸包名行一致。 */
export const name = '@goodjin2/dsh-router'

/**
 * 依赖的页面服务（R3 报告核实的确切服务名）。注意不是计划草稿里的
 * 'ui-workspace'/'ui-session'——页面注册表里没有连字符名，声明错 = 整条
 * entry 启动失败（启动审计判 failed，整页打不开）。
 */
export const inject = ['slots', 'uiSession', 'uiWorkspace', 'workspaces', 'sessions'] as const

/** apply 收到的 ctx 的最小面（全部可选：缺失时降级，不抛）。 */
export interface PluginContext {
  logger?(name: string): { info(message: string): void; warn(message: string): void }
  effect?(callback: () => unknown): unknown
  slots?: Partial<SlotsHost>
  uiSession?: {
    adapter?: {
      current?: {
        subscribe(listener: () => void): unknown
        getSnapshot?(): { key?: string } | undefined
      }
    }
  }
  uiWorkspace?: { openSession(target: string): void }
  workspaces?: { list?: WorkspacesListLike }
}

/** 从 uiSession 的 binding source 读当前主视图会话 id（R3 报告 §5 的用法）。 */
function currentSessionIdOf(ctx: PluginContext): string | undefined {
  const snapshot = ctx.uiSession?.adapter?.current?.getSnapshot?.()
  const key = snapshot?.key
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

function makeLogger(ctx: PluginContext): { info(message: string): void; warn(message: string): void } {
  try {
    const log = ctx.logger?.(name)
    if (typeof log?.info === 'function' && typeof log.warn === 'function') return log
  } catch {
    // logger 拿不到就落下去用 console，绝不因为日志把整条 entry 弄挂。
  }
  return {
    info: (message) => { console.info(`[${name}] ${message}`) },
    warn: (message) => { console.warn(`[${name}] ${message}`) },
  }
}

/**
 * 组装依赖并注册全部表面。任何一块失败都只损失那一块（warn + 继续）：
 * 标签条挂不上，浮窗与创建入口照常工作；服务整体缺失则降级为只自报。
 */
export function apply(ctx?: PluginContext): void {
  const safeCtx: PluginContext = ctx ?? {}
  const log = makeLogger(safeCtx)
  const message = 'Router client loaded — workbench tabs / question overlay / back button / create entry / settings section'
  log.info(message)

  const slots = safeCtx.slots
  if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') {
    log.warn('slots service unavailable — no surfaces registered (client half idle)')
    return
  }
  const slotsHost = slots as SlotsHost
  if (safeCtx.uiWorkspace === undefined || typeof safeCtx.uiWorkspace.openSession !== 'function') {
    log.warn('uiWorkspace service unavailable — tab switching, back button and create-open disabled')
  }
  const uiWorkspace = safeCtx.uiWorkspace?.openSession !== undefined
    ? safeCtx.uiWorkspace
    : { openSession: () => { log.warn('uiWorkspace unavailable: openSession skipped') } }

  const api = createRouterApi()
  const prefs = startClientPrefs(browserPrefsStorage())
  let store: WorkbenchStore
  try {
    store = startWorkbenchStore({
      api,
      prefs,
      workspacesList: safeCtx.workspaces?.list,
      uiWorkspace,
      report: (warnMessage) => { log.warn(warnMessage) },
    })
  } catch (error) {
    log.warn(`workbench store failed to start: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  // 当前会话 → store（激活映射 + workspace 过滤都吃这个值）。订阅的清理经
  // ctx.effect 挂到插件生命周期；effect 缺席时泄漏一条订阅（页面级插件可容忍）。
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
    log.warn('uiSession service unavailable — active tab mapping disabled')
  }

  // 四个表面：问题卡并入通知队列，合计最多五项；提示词视图不再注册。
  try {
    registerWorkbenchTabs(slotsHost, { store, uiWorkspace })
  } catch (error) {
    log.warn(`workbench tabs failed to register: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    registerNotificationCards(slotsHost, { store, api, prefs, uiWorkspace })
  } catch (error) {
    log.warn(`question overlay failed to register: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    registerBackButton(slotsHost, { store, uiWorkspace })
  } catch (error) {
    log.warn(`back button failed to register: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    registerSettingsSection(slotsHost, { prefs, api })
  } catch (error) {
    log.warn(`settings section failed to register: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 轮询 2.5s（仅当本 workspace 有 router 会话、页面隐藏即暂停）；
  // 生命周期挂在插件上：卸载即停。
  if (typeof safeCtx.effect === 'function') {
    safeCtx.effect(() => startWorkbenchPolling(store, prefs))
  }
}
