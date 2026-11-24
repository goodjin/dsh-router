/**
 * 压缩触发器行（`@goodjin2/dsh-router/compaction-trigger`，两级模型 2026-11-24 起）。
 *
 * 用户诉求 ②：每个任务（= 一个派发出去的子会话）结束时，主会话自动压缩。
 *
 * 为什么单独一行、而且必须挂在 compaction isolate 组里面：`ctx.compaction` 是那个组的
 * 入口局部 realm（cordis.patch.yml 的 `isolate: { compaction: true }`），组外的行（如 tools
 * 行）解析不到它（拿到 undefined）。宿主原生 `/compact` 命令就是这么拿 agent 调
 * `compactNow(agent, signal, commandId)` 的；本行复刻同一调用，只是触发点换成「子会话结束」。
 *
 * 两步走，因为 compactNow 要求 agent 空闲（忙时抛 busy）：
 * 1. 监听 `agent/inbox/inserted`：消息 `source.kind === 'subagent-settled'`（宿主把子会话
 *    结束作为一条 notice 投进父会话收件箱）→ 给该 agent 记一个「待压缩」标记。同一轮里多个
 *    子会话结束只会记一次（Set 去重）。
 * 2. 监听 `agent/turn-stopping`（该轮没有工具/steering 后续、即将空闲）：有标记的 agent
 *    才调 `compactNow`，调完清标记。
 *
 * 失败口径：compactNow 的 busy / cancelled / changed / summary / commit / persistence 都是
 * 预期内「这次跳过」的情况，只记一条 warn，绝不穿透——turn-stopping 是 serial 模式，
 * 抛出去会卡住整轮收尾。返回 null（没有可压缩的范围）也是正常结果。
 *
 * 两个监听器都注册在本行作用域（不是 agent 作用域），按宿主 scope-filtered 规则收到本预设
 * 下所有 agent 的事件，再在 JS 里按 agent.id 过滤。
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'router-compaction-trigger'

/** 只要 compaction 服务；它由 isolate 组提供，本行必须在组内。 */
export const inject = ['compaction'] as const

export const Config = Schema.object({})

/** 宿主 compaction 服务的最小面（只用到 compactNow）。 */
export interface CompactionEngineFace {
  compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: string): Promise<unknown>
}

/** 宿主事件面的最小面：on 返回注销器（cordis 契约）。 */
export interface EventListenerFace {
  on(name: string, listener: (payload: unknown) => unknown): () => void
}

export interface CompactionTriggerHost {
  compaction: CompactionEngineFace
  on: EventListenerFace['on']
  logger?: { warn?(message: string): void }
}

/** 子会话结束在父会话收件箱里的消息来源种类（宿主 SubagentSettledMessageSource.kind）。 */
export const SUBAGENT_SETTLED_KIND = 'subagent-settled'

/** 从事件载荷里取 agent.id；取不到返回 undefined（不臆造身份）。 */
function agentIdOf(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 从收件箱载荷里判断「这条消息是不是子会话结束的 notice」。 */
export function isSubagentSettledMessage(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const message = (payload as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return false
  const source = (message as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return false
  return (source as { kind?: unknown }).kind === SUBAGENT_SETTLED_KIND
}

/**
 * 注册两个监听器；返回注销器交给宿主 effect 生命周期。
 * 整个 apply 包在一层 try 里：这一行在 compaction 组内，抛出去会让整棵预设树回滚，
 * 代价远大于「自动压缩不工作」。
 */
export function apply(ctx: CompactionTriggerHost): () => void {
  const pending = new Set<string>()
  const lifetime = new AbortController()
  const warn = (message: string): void => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // logger 不可用就吞掉：诊断信息丢失可接受，穿透不可接受。
    }
  }

  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.on('agent/inbox/inserted', (payload) => {
      if (!isSubagentSettledMessage(payload)) return
      const agentId = agentIdOf((payload as { agent?: unknown } | null)?.agent)
      if (agentId === undefined) return
      pending.add(agentId)
    }))

    disposers.push(ctx.on('agent/turn-stopping', async (payload) => {
      const agent = (payload as { agent?: unknown } | null)?.agent
      const agentId = agentIdOf(agent)
      if (agentId === undefined || !pending.delete(agentId)) return
      try {
        await ctx.compaction.compactNow(agent, lifetime.signal)
      } catch (error) {
        // busy / cancelled / changed / summary / commit / persistence：这次跳过，下一轮再有机会。
        warn(`[router-compaction-trigger] 自动压缩未完成（已跳过）: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
  } catch (error) {
    warn(`[router-compaction-trigger] 监听器注册失败，自动压缩不生效: ${error instanceof Error ? error.message : String(error)}`)
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 注销失败不覆盖真正的卸载流程。
      }
    }
    lifetime.abort()
  }
}
