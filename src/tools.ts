/**
 * 预设树工具行入口（`@goodjin2/dsh-router/tools`，计划 B2）。
 *
 * 按行上的 role 注册对应的编排工具子集——**只 register 不 provide**：preset 树内
 * provide 服务必须裹 isolate，否则泄漏审计整树回滚（r1 §5.3）；工具行是纯副作用，
 * 无需 realm。核心服务经 inject ['routerCore'] 从根实例（根服务行 provide 的
 * 'routerCore'）经作用域链取用。
 */

import Schema from '@deepseek-ai/schemastery'

import { buildToolDefinitions } from './host/tools/index.ts'
import type { RoleKind } from './shared/types.ts'

/** 本入口的插件名（诊断显示用；装载行的 name 是带子路径的说明符）。 */
export const name = 'router-tools'

export const inject = ['tools', 'routerCore'] as const

/** 行配置：角色必填，决定注册哪个工具子集。 */
export interface RouterToolsConfig {
  role: RoleKind
}

export const Config = Schema.object({
  role: Schema.union(['router', 'supervisor', 'worker']).required(),
})

/** 本入口需要的宿主面（窄接口）。 */
interface ToolsContext {
  tools: {
    register(definition: unknown): unknown
  }
  routerCore: unknown
}

/** 按角色注册编排工具子集；返回联合注销器。 */
export function apply(ctx: ToolsContext, config: RouterToolsConfig): () => void {
  const definitions = buildToolDefinitions(
    ctx.routerCore as Parameters<typeof buildToolDefinitions>[0],
    config.role,
  )
  const disposers = definitions.map((definition) => ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers) {
      (dispose as (() => void) | undefined)?.()
    }
  }
}
