/**
 * 上下文管理测试（计划 Task B5）：活动账本快照纯函数 + 派发后压缩驱动。
 */

import { describe, expect, it } from 'vitest'

import { renderLedgerSnapshot } from '../src/host/context/snapshot.ts'
import { CompactionDriver, type CompactionDeps } from '../src/host/context/compaction-driver.ts'
import { task } from './helpers/task-builder.ts'

/* ────────────────────────── 快照 ────────────────────────── */

describe('renderLedgerSnapshot', () => {
  it('空账本输出说明文字，不输出空骨架', () => {
    const text = renderLedgerSnapshot([], { maxCards: 8 })
    expect(text).toContain('没有未结束任务')
  })

  it('覆盖全部未结束任务，字段齐全（目标/验收/类型/会话/状态/进度/依赖）', () => {
    const tasks = [
      task({
        id: 'T-002',
        title: '修登录',
        goal: '登录不再 500',
        acceptance: ['回归通过', '日志有因'],
        role: 'worker',
        templateId: 'coder',
        sessionId: 'session-9',
        status: 'running',
        progress: '定位到鉴权层',
        dependsOn: ['T-001'],
        constraints: ['不得改公开 API', '补充：用 PostgreSQL'],
      }),
    ]
    const text = renderLedgerSnapshot(tasks, { maxCards: 8 })
    expect(text).toContain('T-002')
    expect(text).toContain('修登录')
    expect(text).toContain('登录不再 500')
    expect(text).toContain('回归通过')
    expect(text).toContain('coder')
    expect(text).toContain('session-9')
    expect(text).toContain('执行中')
    expect(text).toContain('定位到鉴权层')
    expect(text).toContain('T-001')
    expect(text).toContain('用 PostgreSQL') // 最新补充约束
  })

  it('completed / cancelled 剔除；failed（失败待处理）保留', () => {
    const tasks = [
      task({ id: 'T-001', status: 'completed', title: '已完' }),
      task({ id: 'T-002', status: 'cancelled', title: '已取消' }),
      task({ id: 'T-003', status: 'failed', title: '失败待处理' }),
      task({ id: 'T-004', status: 'review-pending', title: '待验收' }),
    ]
    const text = renderLedgerSnapshot(tasks, { maxCards: 8 })
    expect(text).not.toContain('已完')
    expect(text).not.toContain('T-001')
    expect(text).not.toContain('已取消')
    expect(text).toContain('失败待处理')
    expect(text).toContain('待验收')
  })

  it('待答问题数渲染进卡片', () => {
    const tasks = [task({ id: 'T-001', status: 'running', title: '有问题的任务' })]
    const text = renderLedgerSnapshot(tasks, { maxCards: 8, openQuestions: { 'T-001': 2 } })
    expect(text).toContain('2 个问题')
  })

  it('memoryBrief 渲染在活动卡之前', () => {
    const tasks = [task({ id: 'T-001', status: 'queued', title: '排队的任务' })]
    const text = renderLedgerSnapshot(tasks, { maxCards: 8, memoryBrief: '项目约定：测试用 vitest' })
    expect(text.indexOf('项目约定')).toBeLessThan(text.indexOf('排队的任务'))
  })

  it('超 maxCards：全部任务转紧凑单行卡，一张不丢', () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      task({ id: `T-00${i + 1}`, title: `任务${i + 1}`, status: 'queued', goal: `目标${i + 1}` }),
    )
    const text = renderLedgerSnapshot(tasks, { maxCards: 2 })
    for (let i = 1; i <= 5; i += 1) {
      expect(text).toContain(`T-00${i}`)
      expect(text).toContain(`任务${i}`)
    }
    // 紧凑模式下不再有完整卡片的验收清单标题
    expect(text).not.toContain('验收条件')
  })
})

/* ────────────────────────── 压缩驱动 ────────────────────────── */

interface DriverHarness {
  driver: CompactionDriver
  calls: { compact: [number, number, string][]; balancedBefore: number[]; balancedAfter: number[] }
  setAgent(sessionId: string | undefined, status?: string): void
  setLastUserSeq(seq: number | null): void
  setBalanced(before: boolean, after: boolean): void
  failCompact(error: Error): void
  clearCompact(): void
  holdCompact(): void
  releaseCompact(): void
}

function harness(): DriverHarness {
  const agents = new Map<string, { session: string; status: string }>()
  let lastUserSeq: number | null = null
  let balanced: [boolean, boolean] = [true, true]
  let compactError: Error | null = null
  let gate: { promise: Promise<void>; release(): void } | null = null
  const calls = { compact: [] as [number, number, string][], balancedBefore: [] as number[], balancedAfter: [] as number[] }
  const deps: CompactionDeps = {
    getAgent(sessionId) {
      return agents.get(sessionId)
    },
    async lastUserMessageSeq() {
      return lastUserSeq
    },
    async balancedBefore(_session, seq) {
      calls.balancedBefore.push(seq)
      return balanced[0]
    },
    async balancedAfter(_session, seq) {
      calls.balancedAfter.push(seq)
      return balanced[1]
    },
    async compactRegion(start, end, agent) {
      calls.compact.push([start, end, (agent as { session: string }).session])
      if (gate !== null) await gate.promise
      if (compactError !== null) throw compactError
      return { endSeq: end }
    },
    now: () => 1,
  }
  return {
    driver: new CompactionDriver(deps),
    calls,
    setAgent(sessionId, status = 'idle') {
      agents.clear()
      if (sessionId !== undefined) agents.set(sessionId, { session: sessionId, status })
    },
    setLastUserSeq(seq) {
      lastUserSeq = seq
    },
    setBalanced(before, after) {
      balanced = [before, after]
    },
    failCompact(error) {
      compactError = error
    },
    clearCompact() {
      compactError = null
    },
    holdCompact() {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      gate = { promise, release }
    },
    releaseCompact() {
      gate?.release()
      gate = null
    },
  }
}

describe('CompactionDriver', () => {
  it('idle 但没有 pending 标记：不动作', async () => {
    const h = harness()
    h.setAgent('s-1')
    h.setLastUserSeq(9)
    expect(await h.driver.onIdle('s-1')).toBe('no-op')
    expect(h.calls.compact).toHaveLength(0)
  })

  it('派发标记 pending，idle 后压缩 [检查点+1 .. 最后一条用户消息前]，成功清标记并推进检查点', async () => {
    const h = harness()
    h.driver.onDispatched('s-1')
    h.setAgent('s-1')
    h.setLastUserSeq(12)
    expect(await h.driver.onIdle('s-1')).toBe('compacted')
    expect(h.calls.compact).toEqual([[0, 11, 's-1']])
    expect(h.calls.balancedBefore).toEqual([0])
    expect(h.calls.balancedAfter).toEqual([11])
    expect(h.driver.isPending('s-1')).toBe(false)
    // 下一次派发：区域从上次检查点之后开始
    h.driver.onDispatched('s-1')
    h.setLastUserSeq(30)
    expect(await h.driver.onIdle('s-1')).toBe('compacted')
    expect(h.calls.compact[1]).toEqual([12, 29, 's-1'])
  })

  it('agent 不存活：跳过并保留 pending', async () => {
    const h = harness()
    h.driver.onDispatched('s-1')
    h.setAgent(undefined)
    h.setLastUserSeq(5)
    expect(await h.driver.onIdle('s-1')).toBe('skipped')
    expect(h.driver.isPending('s-1')).toBe(true)
    expect(h.calls.compact).toHaveLength(0)
  })

  it('agent 仍在运行（非 idle）：跳过并保留 pending', async () => {
    const h = harness()
    h.driver.onDispatched('s-1')
    h.setAgent('s-1', 'running')
    h.setLastUserSeq(5)
    expect(await h.driver.onIdle('s-1')).toBe('skipped')
    expect(h.driver.isPending('s-1')).toBe(true)
  })

  it('没有用户消息锚点：跳过', async () => {
    const h = harness()
    h.driver.onDispatched('s-1')
    h.setAgent('s-1')
    h.setLastUserSeq(null)
    expect(await h.driver.onIdle('s-1')).toBe('skipped')
    expect(h.calls.compact).toHaveLength(0)
  })

  it('区域为空（最后一条用户消息就在检查点处）：跳过', async () => {
    const h = harness()
    h.driver.onDispatched('s-1')
    h.setAgent('s-1')
    h.setLastUserSeq(0)
    expect(await h.driver.onIdle('s-1')).toBe('skipped')
    expect(h.calls.compact).toHaveLength(0)
  })

  it('两端配对校验不通过：不调 compactRegion，保留 pending 留待下次', async () => {
    const h = harness()
    h.driver.onDispatched('s-1')
    h.setAgent('s-1')
    h.setLastUserSeq(10)
    h.setBalanced(false, true)
    expect(await h.driver.onIdle('s-1')).toBe('skipped')
    expect(h.calls.compact).toHaveLength(0)
    h.setBalanced(true, false)
    expect(await h.driver.onIdle('s-1')).toBe('skipped')
    expect(h.calls.compact).toHaveLength(0)
    expect(h.driver.isPending('s-1')).toBe(true)
    h.setBalanced(true, true)
    expect(await h.driver.onIdle('s-1')).toBe('compacted')
    expect(h.calls.compact).toHaveLength(1)
  })

  it('compactRegion 抛错：吞掉、保留 pending 留待下次', async () => {
    const h = harness()
    h.driver.onDispatched('s-1')
    h.setAgent('s-1')
    h.setLastUserSeq(10)
    h.failCompact(new Error('summary failed'))
    expect(await h.driver.onIdle('s-1')).toBe('skipped')
    expect(h.driver.isPending('s-1')).toBe(true)
    expect(h.calls.compact).toHaveLength(1)
    h.clearCompact()
    expect(await h.driver.onIdle('s-1')).toBe('compacted')
    expect(h.calls.compact).toHaveLength(2)
  })

  it('压缩进行中重复 onIdle：直接 no-op（不重入）', async () => {
    const h = harness()
    h.driver.onDispatched('s-1')
    h.setAgent('s-1')
    h.setLastUserSeq(10)
    h.holdCompact()
    const first = h.driver.onIdle('s-1')
    await Promise.resolve()
    expect(await h.driver.onIdle('s-1')).toBe('no-op')
    h.releaseCompact()
    await expect(first).resolves.toBe('compacted')
    expect(h.driver.isPending('s-1')).toBe(false)
  })
})
