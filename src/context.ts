/**
 * 预设树上下文行入口（`@goodjin2/dsh-router/context`，计划 B5）。
 *
 * 只挂 Router 预设：在预设作用域内注册 systemPrompt 动态上下文
 * 「router-task-ledger」，text 是同步回调读根服务缓存的快照（systemPrompt 组装
 * 是同步的，账本读是异步的，所以走缓存——根服务在启动与每次账本写后刷新）。
 * 注意宿主 SystemPrompt.context() 对非有限 order 直接 TypeError，order 必须给。
 */

import Schema from '@deepseek-ai/schemastery'

/** 本入口的插件名（诊断显示用）。 */
export const name = 'router-context'

export const inject = ['systemPrompt', 'routerCore'] as const

/** 行配置：快照段在 runtime context 里的排序。 */
export interface RouterContextConfig {
  order?: number
}

export const Config = Schema.object({
  order: Schema.number().default(100).volatile(),
})

/** 本入口需要的宿主面（窄接口）。 */
interface ContextEntry {
  name: string
  order: number
  text(): string
}

interface SystemPromptFace {
  context(entry: ContextEntry): unknown
}

interface ContextHost {
  systemPrompt: SystemPromptFace
  routerCore: { snapshotText(): string }
}

/** 注册快照上下文；返回注销器交给宿主 effect 生命周期。 */
export function apply(ctx: ContextHost, config: RouterContextConfig): () => void {
  const order = typeof config.order === 'number' && Number.isFinite(config.order) ? config.order : 100
  const dispose = ctx.systemPrompt.context({
    name: 'router-task-ledger',
    order,
    text: () => ctx.routerCore.snapshotText(),
  })
  return () => {
    (dispose as (() => void) | undefined)?.()
  }
}
