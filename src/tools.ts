/**
 * 预设树工具行入口（`@goodjin2/dsh-router/tools`，轻量协作版，计划 Task 2B）。
 *
 * inject ['tools', 'routerCollaboration']：从根实例（根服务行 provide 的
 * 'routerCollaboration'）经作用域链取记录/模板存储单实例，注册恰好七条 Layer2 工具
 * 定义（buildCollaborationTools）。只 register 不 provide：工具行是纯副作用，无需 realm。
 * 无角色配置/角色闸（旧 role:'superset' 的 assertCallerRole 退役）；存储为字段校验与
 * 执行的最终权威，工具执行失败原样成为 tool error。
 */

import Schema from '@deepseek-ai/schemastery'

import { buildCollaborationTools, type ToolDefinition } from './collaboration/tools.ts'

/** 本入口的插件名（诊断显示用；装载行的 name 是带子路径说明符）。 */
export const name = 'router-tools'

export const inject = ['tools', 'routerCollaboration'] as const

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
    records: Parameters<typeof buildCollaborationTools>[0]
    roles: Parameters<typeof buildCollaborationTools>[1]
  }
}

/** 注册七条协作工具；返回联合注销器交给宿主 effect 生命周期。disposal 干净。 */
export function apply(ctx: ToolsContext): () => void {
  const definitions = buildCollaborationTools(ctx.routerCollaboration.records, ctx.routerCollaboration.roles)
  const disposers = definitions.map((definition) => ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers) {
      (dispose as (() => void) | undefined)?.()
    }
  }
}
