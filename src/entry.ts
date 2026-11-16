/**
 * DSH Router 宿主根服务入口（轻量协作版，计划 Task 2B，Layer 3）。
 *
 * 裸包名行加载本文件（`name` 恰好等于包名的行既是浏览器资产行、也是宿主根服务行）。
 * 本文件在宿主进程里只做一件事：用标准 Cordis provide/lifecycle 组装根服务
 * `routerCollaboration`——一次解析 dataDir、创建一条 RecordStore 与一条 RoleStore 单实例，
 * 供预设树里的 tools 行 / context 行经 inject ['routerCollaboration'] 取用。
 *
 * 不再装配：旧 routerCore、HTTP 路由、会话收编/监听、派发预算、摘要替换、动态预设引擎、
 * 角色模板存储、压缩驱动、问答瀑布、紧急暂停熔断。这些是旧事务协议的控制面，本设计
 * （docs/superpowers/specs/2026-11-16-router-lightweight-design.md）明确排除；旧代码与
 * 用户数据保留，但不接入新入口。浏览器半边（src/client）仍是旧实现，直到下一层（Task 3）
 * 接工作台——此入口明确不是产品就绪 UI。
 *
 * 配置只有 dataDir（可缺省，缺省 DSH_HOME/router）。构造是纯内存的：不扫描、不建目录、
 * 不起引擎；存储真正做 IO 时才碰文件系统。
 */

import Schema from '@deepseek-ai/schemastery'

import { createCollaborationRuntime } from './collaboration/runtime.ts'

/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
export const name = '@goodjin2/dsh-router'

/**
 * 根服务不 require 任何旧宿主服务：它只 provide 一个纯内存运行时。
 * （旧版 require sessionController/agents/workspaceRegistry/sessionQuery/llm/agentPresets
 * 的那套装配整体退役。）
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
}

/**
 * 装载入口：组装根服务并 provide。标准 Cordis 生命周期——返回注销器（此处无副作用可清理，
 * 存储单实例随 fiber 销毁自然回收；保留 disposer 形状以供宿主 effect 统一调度）。
 */
export function apply(ctx: { provide(name: string, value: unknown): () => void }, rawConfig: unknown): () => void {
  const config = (rawConfig ?? {}) as { dataDir?: unknown }
  const runtime = createCollaborationRuntime({ dataDir: typeof config.dataDir === 'string' ? config.dataDir : undefined })
  const face: RouterCollaborationFace = {
    records: runtime.records,
    roles: runtime.roles,
    dataDir: runtime.dataDir,
  }
  ctx.provide('routerCollaboration', face)
  return () => {}
}
