/**
 * Router 预设的 complete section 行（`@goodjin2/dsh-router/prompt-section`，
 * v1.1 计划 Task C5，规格 §7）。
 *
 * 只挂动态 Router 预设：persona complete 行（整段静态替换，C1）换成**本行**——
 * 注册 systemPrompt section「router-prompt」（complete:true），text 回调按
 * **当前会话**读覆盖：有覆盖用覆盖、无覆盖回落 defaults.routerSystemPrompt
 * （两者都由 routerCore.sessionPromptText 会话感知地给，见 entry.ts；默认值
 * 不烘焙进行定义，改默认不必重注册）。
 *
 * 会话 id 取法（宿主 dsh-agent-loop assembleContextFor 的形状，r5/源码取证）：
 * `text(assembly)` 收 `{ agent, scope, signal? }`，会话 id 在
 * `agent.session.id`（0.2.1/0.2.2 双版本同构），退路 `agent.id`；两者都取不到
 * 按「无会话」处理回落默认——绝不抛（组装路径抛错会炸整轮对话）。
 *
 * 注意宿主 SystemPrompt.section() 对非有限 order 直接 TypeError，order 必须给
 * （context 行同款教训）；多 complete 冲突由宿主在组装期报错
 * （`multiple complete prompt sections are active`），所以动态定义里不得残留
 * persona 行（presets-dynamic/bundle 看守）。
 */

import Schema from '@deepseek-ai/schemastery'

/** 本入口的插件名（诊断显示用）。 */
export const name = 'router-prompt-section'

export const inject = ['systemPrompt', 'routerCore'] as const

/** 行配置：section 在 complete 替换语义下 order 不影响内容，只要求有限数。 */
export interface PromptSectionConfig {
  order?: number
}

export const Config = Schema.object({
  order: Schema.number().default(50).volatile(),
})

/** 本入口需要的宿主面（窄接口）。 */
interface PromptSectionEntry {
  name: string
  order: number
  complete?: boolean
  text(assembly?: unknown): string
}

interface SystemPromptFace {
  section(entry: PromptSectionEntry): unknown
}

interface RouterCoreFace {
  /** 当前会话的 Router 系统提示词：有覆盖用覆盖，无覆盖回落默认（同步）。 */
  sessionPromptText(sessionId?: string): string
}

interface PromptSectionHost {
  systemPrompt: SystemPromptFace
  routerCore: RouterCoreFace
}

/**
 * 从组装上下文提取会话 id（形状防御：两代宿主 `agent.session.id` /
 * `agent.id` 都兜住；取不到返回 undefined = 回落默认）。
 */
export function sessionIdOfAssembly(assembly: unknown): string | undefined {
  const agent = (assembly as { agent?: { id?: unknown; session?: { id?: unknown } } } | undefined)?.agent
  for (const candidate of [agent?.session?.id, agent?.id]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** 注册 complete section；返回注销器交给宿主 effect 生命周期。 */
export function apply(ctx: PromptSectionHost, config: PromptSectionConfig): () => void {
  const order = typeof config.order === 'number' && Number.isFinite(config.order) ? config.order : 50
  const dispose = ctx.systemPrompt.section({
    name: 'router-prompt',
    order,
    complete: true,
    text: (assembly?: unknown) => ctx.routerCore.sessionPromptText(sessionIdOfAssembly(assembly)),
  })
  // 注销幂等（r4 纪律：宿主 effect 可能重复触发，重复注销是 no-op）。
  let done = false
  return () => {
    if (done) return
    done = true
    ;(dispose as (() => void) | undefined)?.()
  }
}
