/**
 * 引擎子类测试（2026-11-11 用户裁定流程）：TaskSummaryCompactionEngine
 * 只覆盖 summarize——Router/主管会话（账本里有它派发的活跃任务）用账本拼
 * 描述，不调 LLM；其余会话回退官方默认行为（summarizeWithLlm）。
 *
 * 驱动真 subclass（src/compaction.ts 导出的同一工厂，apply 行内自用），
 * 基类用结构兼容的假类：ctx 注入 reflect（routerCore 账本面）、summarize
 * 记录调用次数——「断言落在哪个对象上，行为就在哪个对象上」。
 */

import { describe, expect, it } from 'vitest'

import { subclass } from '../src/compaction.ts'
import type { TaskRecord } from '../src/shared/types.ts'

/** 造一条任务记录（只填装配消费的字段）。 */
function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    title: `任务 ${overrides.id}`,
    goal: `目标 ${overrides.id}`,
    acceptance: [],
    constraints: [],
    projectId: 'proj',
    cwd: '/tmp',
    role: 'worker',
    dependsOn: [],
    status: 'dispatched',
    docVersion: 1,
    acceptancePolicy: 'auto',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

/** 假基类（结构对齐 BasicCompactionEngine 的本钩子消费面）：summarize 计数。 */
class FakeBasicEngine {
  ctx: { reflect: { get: (name: string) => unknown } }
  summarizeCalls = 0

  constructor(ctx: { reflect: { get: (name: string) => unknown } }) {
    this.ctx = ctx
  }

  async summarize(): Promise<{ summary: { type: 'text'; text: string }[] }> {
    this.summarizeCalls += 1
    return { summary: [{ type: 'text', text: '默认摘要' }] }
  }
}

/** 造一台驱动真子类的引擎：账本记录可选（缺 → reflect 不给 listDispatchedTasks）。 */
function engineWith(records?: readonly TaskRecord[]) {
  const core = records === undefined ? {} : { listDispatchedTasks: async () => records }
  const ctx = { reflect: { get: (name: string) => (name === 'routerCore' ? core : undefined) } }
  const Engine = subclass(FakeBasicEngine as unknown as never) as unknown as new (
    ctx: unknown,
  ) => { ctx: typeof ctx; summarizeCalls: number; summarize: (input: unknown, agent: unknown, signal?: unknown) => Promise<{ summary: { type: 'text'; text: string }[]; provider?: string; model?: string }> }
  return new Engine(ctx)
}

describe('TaskSummaryCompactionEngine.summarize 钩子（真 subclass + 假基类）', () => {
  it('本会话派发的活跃任务 → 拼描述返回，不调基类 summarize', async () => {
    const engine = engineWith([
      task({ id: 'T-001', title: '修登录超时', goal: '登录不再超时', dispatchedBySessionId: 's-router' }),
      task({ id: 'T-002', status: 'completed', dispatchedBySessionId: 's-router' }),
      task({ id: 'T-003', dispatchedBySessionId: 's-other' }),
    ])
    const result = await engine.summarize({ messages: [] }, { session: { id: 's-router' } })
    expect(engine.summarizeCalls).toBe(0)
    expect(result.provider).toBe('router-ledger')
    expect(result.model).toBe('task-summary')
    const text = result.summary.map((block) => block.text).join('')
    expect(text).toContain('T-001')
    expect(text).not.toContain('T-002') // 终态剔除
    expect(text).not.toContain('T-003') // 别的会话派的不归我
  })

  it('本会话没有活跃任务 → 回退基类 summarize（worker 会话行为不变）', async () => {
    const engine = engineWith([task({ id: 'T-009', status: 'completed', dispatchedBySessionId: 's-router' })])
    const result = await engine.summarize({ messages: [] }, { session: { id: 's-router' } })
    expect(engine.summarizeCalls).toBe(1)
    expect(result.summary.map((block) => block.text).join('')).toBe('默认摘要')
  })

  it('账本面缺失（routerCore 不可用）→ 回退基类 summarize（缺面不炸，降级继续）', async () => {
    const engine = engineWith(undefined)
    await engine.summarize({ messages: [] }, { session: { id: 's-router' } })
    expect(engine.summarizeCalls).toBe(1)
  })

  it('会话标识缺失 → 回退基类 summarize', async () => {
    const engine = engineWith([task({ id: 'T-010', dispatchedBySessionId: 's-router' })])
    await engine.summarize({ messages: [] }, {})
    expect(engine.summarizeCalls).toBe(1)
  })
})
