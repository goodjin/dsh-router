/**
 * 预设树工具行入口（`@goodjin2/dsh-router/tools`，派发工具版）。
 *
 * inject ['tools', 'routerCollaboration', 'subagents']：从根实例取记录/模板存储单实例，
 * 另注入宿主子代理服务（base 全局提供）——router_dispatch 经它创建 spawn/fork 子会话。
 * 注册恰好八条工具定义（buildCollaborationTools）。只 register 不 provide：工具行是
 * 纯副作用。无角色配置/角色闸；存储与服务为字段校验与执行的最终权威，失败原样
 * 成为 tool error。
 */

import Schema from '@deepseek-ai/schemastery'

import { buildCollaborationTools, type ToolDefinition } from './collaboration/tools.ts'
import type { ChildModelRun } from './collaboration/model-switch.ts'

/** 本入口的插件名（诊断显示用；装载行的 name 是带子路径说明符）。 */
export const name = 'router-tools'

export const inject = ['tools', 'routerCollaboration', 'subagents'] as const

/**
 * 行配置：无。保留 Config（空对象）以与宿主行校验一致（check-host-rows 对无 config 行
 * 按「跳过校验」处理，但导出 Config 让形状显式、可测）。
 */
export const Config = Schema.object({})

/** 本入口需要的宿主面（窄接口）。 */
interface ToolsContext {
  tools: {
    register(definition: ToolDefinition): unknown
  }
  routerCollaboration: {
    records: Parameters<typeof buildCollaborationTools>[0]['records']
    roles: Parameters<typeof buildCollaborationTools>[0]['roles']
    /** 活跃任务视图缓存（共享单实例）；缺席时写后不刷新，上下文段靠后台刷新自愈。 */
    activeTasks?: { refresh(rootSessionId: string): Promise<unknown> }
    /** 本次入口 apply 的子会话候选游标；缺席时派发不登记自动切换。 */
    childModelRuns?: Map<string, ChildModelRun>
  }
  subagents?: Parameters<typeof buildCollaborationTools>[0]['subagents']
}

/** 注册八条协作工具；返回联合注销器交给宿主 effect 生命周期。disposal 干净。 */
export function apply(ctx: ToolsContext): () => void {
  const definitions = buildCollaborationTools({
    records: ctx.routerCollaboration.records,
    roles: ctx.routerCollaboration.roles,
    subagents: ctx.subagents,
    // 写记录后同步刷新活跃任务视图：下一步装配上下文段时已是最新（零滞后）。
    afterWrite: ctx.routerCollaboration.activeTasks === undefined
      ? undefined
      : async (rootSessionId) => {
          await ctx.routerCollaboration.activeTasks!.refresh(rootSessionId)
        },
    childModelRuns: ctx.routerCollaboration.childModelRuns,
  })
  const disposers = definitions.map((definition) => ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers) {
      (dispose as (() => void) | undefined)?.()
    }
  }
}
