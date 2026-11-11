/**
 * 压缩引擎行入口（`@goodjin2/dsh-router/compaction`，2026-11-11 用户裁定流程）：
 * Router 会话的压缩摘要不是 LLM 聊天摘要，而是「该会话派发、仍在推进」的任务
 * 描述清单——派发时生成的任务描述即历史，替换自上一检查点以来的聊天段。
 *
 * 行形状与官方 @deepseek-ai/dsh-compaction-basic 同构：apply 函数行，行内动态
 * import 宿主基类（本仓 node_modules 没有该包，类型期解析不到，只能运行时取），
 * 子类只覆盖 summarize 这一个钩子，其余（压力/模型切换/溢出自动压缩、
 * compactNow、范围圈定、/compact 命令入口）全部继承官方基类。行无 config
 * （官方预设里的 compaction-basic 行同样无 config），不导出 Config——宿主对
 * 无 Config 行按「跳过校验」处理，与官方行为一致。
 *
 * 会话归属判定（与 taskSummarySummarize 共用同一套已测逻辑）：
 *  - 账本里有该会话派发的活跃任务 → 任务描述清单替换压缩段，不调 LLM
 *    （provider/model = router-ledger / task-summary，不置 llmStreamCall）；
 *  - 其余会话（worker、未派发任务的主管/Router）→ 回退官方默认 summarize，
 *    worker 会话压缩行为与官方预设逐字节相同。
 *
 * routerCore 的取用不经 inject（必需注入缺面会让整行 never started，预设整树
 * 回滚）：引擎行在压缩 isolate realm 里，routerCore 由根行 provide，isolate
 * 键表沿作用域原型链继承所以可达；取不到（未装载/已失效）时回退默认摘要。
 */

import {
  taskSummarySummarize,
  type SummaryAgent,
  type TaskSummaryEnvelope,
} from './host/compaction/task-summary.ts'
import type { TaskRecord } from './shared/types.ts'

/** 行名字符串（诊断显示用）。 */
export const name = 'task-summary-compaction'

/** 必需注入与官方基类相同（官方引擎行就是这三面；行内实例化会真用它们）。 */
export const inject = ['llm', 'tokenMeter', 'sessions'] as const

/** 引擎行的最小 ctx 面（reflect.get 是 cordis 的正规非注入读）。 */
interface ContextShape {
  reflect?: { get?: (name: string, strict?: boolean) => unknown }
  logger?: { warn?: (message: string) => void }
}

/** routerCore 的账本读取口（根行 provide；经作用域链可达）。 */
interface RouterCoreLedgerFace {
  listDispatchedTasks?(sessionId: string): Promise<TaskRecord[]>
}

/** 基类实例的最小结构面（子类只覆盖 summarize，其余能力照基类）。 */
interface BasicEngineShape {
  ctx: ContextShape
  summarize(input: unknown, agent: SummaryAgent, signal: unknown): Promise<TaskSummaryEnvelope>
}

/** 官方基类构造器的最小结构面（运行时动态 import 后按此收窄）。 */
type BasicEngineCtor = new (ctx: ContextShape, config?: unknown) => BasicEngineShape

/** 会话的任务记录来源：routerCore 可用则读该会话派发的任务，否则 undefined（回退）。 */
async function sessionRecords(
  ctx: ContextShape,
  sessionId: string | undefined,
): Promise<readonly TaskRecord[] | undefined> {
  if (sessionId === undefined) return undefined
  const core = ctx.reflect?.get?.('routerCore') as RouterCoreLedgerFace | undefined
  if (core?.listDispatchedTasks === undefined) return undefined
  try {
    return await core.listDispatchedTasks(sessionId)
  } catch {
    // 账本读失败（卸载竞态窗口等）按「不可用」处理：回退默认摘要，不炸压缩。
    return undefined
  }
}

/**
 * 动态子类化：以宿主运行时的 BasicCompactionEngine 为基类，构造一个只覆盖
 * summarize 的子类。基类构造自注册 compaction 服务（Service 语义），实例化
 * 完成即完成替换。基类 summarize 经原型链显式调用（动态 extends 的值上
 * super 不可静态校验，用 Object.getPrototypeOf 取基类原型）。
 *
 * 导出仅供测试驱动（tests/task-summary-engine.spec.ts 以结构兼容的假基类
 * 驱动真子类）；apply 行内自用。
 */
export function subclass(base: BasicEngineCtor): BasicEngineCtor {
  class TaskSummaryCompactionEngine extends (base as unknown as {
    new (ctx: ContextShape, config?: unknown): object
  }) {
    declare ctx: ContextShape

    constructor(ctx: ContextShape, config?: unknown) {
      super(ctx, config)
    }

    async summarize(input: unknown, agent: SummaryAgent, signal: unknown): Promise<TaskSummaryEnvelope> {
      const sessionId = agent?.session?.id
      const records = await sessionRecords(this.ctx, sessionId)
      const fallback = async (): Promise<TaskSummaryEnvelope> => {
        const baseProto = Object.getPrototypeOf(TaskSummaryCompactionEngine.prototype) as {
          summarize(input: unknown, agent: SummaryAgent, signal: unknown): Promise<TaskSummaryEnvelope>
        }
        return baseProto.summarize.call(this, input, agent, signal)
      }
      const verdict = await taskSummarySummarize(records, fallback, input, agent, signal)
      if (verdict === undefined) {
        throw new Error('summarize 不得返回空（基类与账本路径都必须给出信封）')
      }
      return verdict
    }
  }
  return TaskSummaryCompactionEngine as unknown as BasicEngineCtor
}

/**
 * 行入口：装载宿主基类并实例化子类（实例自注册为 compaction 服务）。
 * 基类装载失败只告警不抛（行已激活、压缩服务缺席——与官方行 import 失败的
 * 后果一致，不额外放大）；子类构造只做 super(ctx, config)，失败即基类失败。
 */
export async function apply(ctx: ContextShape, config?: unknown): Promise<void> {
  let mod: { BasicCompactionEngine?: BasicEngineCtor; default?: BasicEngineCtor } | undefined
  try {
    mod = (await import('@deepseek-ai/dsh-compaction-basic')) as unknown as {
      BasicCompactionEngine?: BasicEngineCtor
      default?: BasicEngineCtor
    }
  } catch (error) {
    ctx.logger?.warn?.(
      `任务描述压缩引擎行未生效（dsh-compaction-basic 装载失败）: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  const Basic = mod.BasicCompactionEngine ?? mod.default
  if (Basic === undefined) {
    ctx.logger?.warn?.('任务描述压缩引擎行未生效（dsh-compaction-basic 未导出 BasicCompactionEngine）')
    return
  }
  new (subclass(Basic))(ctx, config)
}
