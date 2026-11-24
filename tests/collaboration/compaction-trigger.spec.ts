/**
 * 压缩触发器行测试（两级模型 2026-11-24：子会话结束 → 主会话自动压缩）。
 *
 * brief 命名断言：
 *  - trigger_detects_settle：只有 source.kind === 'subagent-settled' 的收件箱消息才标记待压缩。
 *  - trigger_compacts_at_turn_stopping：有标记的 agent 在 turn-stopping 时调 compactNow（agent + 真实 signal），
 *    调完清标记；没标记不调；同一轮多个子会话结束只压一次（去重）。
 *  - trigger_swallows_failures：compactNow 抛 busy/changed 等一律吞掉并 logger.warn，绝不穿透（serial 模式）。
 *  - trigger_defensive：compaction 面缺席、监听器注册失败都不穿透；注销器移除监听并中止 lifetime。
 */

import { describe, expect, it, vi } from 'vitest'

import { apply, isSubagentSettledMessage, SUBAGENT_SETTLED_KIND } from '../../src/compaction-trigger.ts'

interface Harness {
  ctx: { compaction: { compactNow: ReturnType<typeof vi.fn> }; on: ReturnType<typeof vi.fn>; logger: { warn: ReturnType<typeof vi.fn> } }
  listeners: Map<string, (payload: unknown) => unknown>
  dispose: () => void
}

function makeHarness(options: { compactNow?: ReturnType<typeof vi.fn>; onThrows?: boolean } = {}): Harness {
  const listeners = new Map<string, (payload: unknown) => unknown>()
  const compactNow = options.compactNow ?? vi.fn(async () => null)
  const on = vi.fn((name: string, listener: (payload: unknown) => unknown) => {
    if (options.onThrows) throw new Error('registry closed')
    listeners.set(name, listener)
    return () => { listeners.delete(name) }
  })
  const ctx = { compaction: { compactNow }, on, logger: { warn: vi.fn() } }
  const dispose = apply(ctx as unknown as Parameters<typeof apply>[0])
  return { ctx, listeners, dispose }
}

const agentA = { id: 'session-a' }
const agentB = { id: 'session-b' }
const settleMsg = (sender: string) => ({ agent: agentA, message: { source: { kind: SUBAGENT_SETTLED_KIND, senderSessionId: sender } } })

async function fire(h: Harness, name: string, payload: unknown): Promise<void> {
  const listener = h.listeners.get(name)
  if (listener === undefined) throw new Error(`no listener for ${name}`)
  await listener(payload)
}

describe('trigger_detects_settle — 只有子会话结束的 notice 才标记', () => {
  it('isSubagentSettledMessage：认 source.kind，拒绝其他形状', () => {
    expect(isSubagentSettledMessage({ message: { source: { kind: 'subagent-settled' } } })).toBe(true)
    expect(isSubagentSettledMessage({ message: { source: { kind: 'user' } } })).toBe(false)
    expect(isSubagentSettledMessage({ message: {} })).toBe(false)
    expect(isSubagentSettledMessage({})).toBe(false)
    expect(isSubagentSettledMessage(null)).toBe(false)
    expect(isSubagentSettledMessage('x')).toBe(false)
  })

  it('注册了两个监听器：agent/inbox/inserted 与 agent/turn-stopping', () => {
    const h = makeHarness()
    expect([...h.listeners.keys()].sort()).toEqual(['agent/inbox/inserted', 'agent/turn-stopping'])
    h.dispose()
  })
})

describe('trigger_compacts_at_turn_stopping — 标记的 agent 在回合停下时压缩', () => {
  it('settle → turn-stopping：compactNow 收到该 agent 与真实 AbortSignal；调完清标记', async () => {
    const h = makeHarness()
    await fire(h, 'agent/inbox/inserted', settleMsg('child-1'))
    await fire(h, 'agent/turn-stopping', { agent: agentA, turn: 1 })
    expect(h.ctx.compaction.compactNow).toHaveBeenCalledTimes(1)
    const [agent, signal] = h.ctx.compaction.compactNow.mock.calls[0]! as [unknown, AbortSignal]
    expect(agent).toBe(agentA)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    // 再来一次 turn-stopping（没有新 settle）不再压缩
    await fire(h, 'agent/turn-stopping', { agent: agentA, turn: 2 })
    expect(h.ctx.compaction.compactNow).toHaveBeenCalledTimes(1)
    h.dispose()
  })

  it('普通收件箱消息不标记；没标记的 agent 停下不压缩；别的 agent 不受影响', async () => {
    const h = makeHarness()
    await fire(h, 'agent/inbox/inserted', { agent: agentA, message: { source: { kind: 'user' } } })
    await fire(h, 'agent/turn-stopping', { agent: agentA })
    expect(h.ctx.compaction.compactNow).not.toHaveBeenCalled()
    await fire(h, 'agent/inbox/inserted', settleMsg('child-1'))
    await fire(h, 'agent/turn-stopping', { agent: agentB })
    expect(h.ctx.compaction.compactNow).not.toHaveBeenCalled()
    await fire(h, 'agent/turn-stopping', { agent: agentA })
    expect(h.ctx.compaction.compactNow).toHaveBeenCalledTimes(1)
    h.dispose()
  })

  it('同一轮多个子会话结束只压缩一次（Set 去重）', async () => {
    const h = makeHarness()
    await fire(h, 'agent/inbox/inserted', settleMsg('c1'))
    await fire(h, 'agent/inbox/inserted', settleMsg('c2'))
    await fire(h, 'agent/inbox/inserted', settleMsg('c3'))
    await fire(h, 'agent/turn-stopping', { agent: agentA })
    expect(h.ctx.compaction.compactNow).toHaveBeenCalledTimes(1)
    h.dispose()
  })

  it('载荷里没有 agent.id 时不标记、不臆造身份', async () => {
    const h = makeHarness()
    await fire(h, 'agent/inbox/inserted', { message: { source: { kind: 'subagent-settled' } } })
    await fire(h, 'agent/turn-stopping', { agent: { id: '' } })
    expect(h.ctx.compaction.compactNow).not.toHaveBeenCalled()
    h.dispose()
  })
})

describe('trigger_swallows_failures — 压缩失败绝不穿透', () => {
  it.each(['busy', 'changed', 'summary', 'cancelled'])('compactNow 抛 %s：吞掉并 logger.warn', async (code) => {
    const compactNow = vi.fn(async () => { throw new Error(code) })
    const h = makeHarness({ compactNow })
    await fire(h, 'agent/inbox/inserted', settleMsg('c'))
    await expect(fire(h, 'agent/turn-stopping', { agent: agentA })).resolves.toBeUndefined()
    expect(compactNow).toHaveBeenCalledTimes(1)
    expect(h.ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(h.ctx.logger.warn.mock.calls[0]![0]).toContain(code)
    h.dispose()
  })

  it('logger.warn 自己抛错也吞掉', async () => {
    const compactNow = vi.fn(async () => { throw new Error('busy') })
    const listeners = new Map<string, (payload: unknown) => unknown>()
    const ctx = {
      compaction: { compactNow },
      on: (name: string, l: (payload: unknown) => unknown) => { listeners.set(name, l); return () => {} },
      logger: { warn: () => { throw new Error('logger dead') } },
    }
    const dispose = apply(ctx as unknown as Parameters<typeof apply>[0])
    await listeners.get('agent/inbox/inserted')!(settleMsg('c'))
    await expect(listeners.get('agent/turn-stopping')!({ agent: agentA })).resolves.toBeUndefined()
    dispose()
  })
})

describe('trigger_defensive — 防御性边界', () => {
  it('监听器注册失败：吞掉并告警，apply 仍返回注销器（预设树不回滚）', () => {
    const h = makeHarness({ onThrows: true })
    expect(typeof h.dispose).toBe('function')
    expect(h.ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(() => h.dispose()).not.toThrow()
  })

  it('注销器移除两个监听器并中止 lifetime（在途压缩随之取消）', async () => {
    let seenSignal: AbortSignal | undefined
    const compactNow = vi.fn(async (_agent: unknown, signal: AbortSignal) => { seenSignal = signal; return null })
    const h = makeHarness({ compactNow })
    await fire(h, 'agent/inbox/inserted', settleMsg('c'))
    await fire(h, 'agent/turn-stopping', { agent: agentA })
    expect(seenSignal!.aborted).toBe(false)
    h.dispose()
    expect(h.listeners.size).toBe(0)
    expect(seenSignal!.aborted).toBe(true)
  })
})
