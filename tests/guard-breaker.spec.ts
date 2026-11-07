/**
 * v1.2 Task B1：故障分类器 + 全局熔断器（规格 §1/§2，接口照计划逐字）。
 *
 * 钉住的语义：熔断只计 infra 失败（滑窗 10min、阈值 3）；创建风暴按任务 ID
 * 集合对窗口（≥10 零完成才冻，9 个不冻——主管合法并行拆解不误伤）；完成清
 * 创建计数基准；冻结态经 guard-state.json 持久化、宿主重启恢复；冻结时
 * dispatch_task / create_worker_type 都被拦且错误信息含指定文案。
 */

import { describe, expect, it } from 'vitest'

import { LedgerError } from '../src/host/ledger/errors.ts'
import { CircuitBreaker } from '../src/host/guard/breaker.ts'
import { classifyDispatchFailure, tagInfraFailure } from '../src/host/guard/classify.ts'
import { makeMemFs } from './helpers/mem-fs.ts'
import { guardCoreWith } from './helpers/guard-core.ts'
import { task } from './helpers/task-builder.ts'

const WINDOW_MS = 600_000

/** 手动推进的时钟（可重拨）。 */
function tickingClock(start = 1000) {
  let t = start
  return {
    now: () => t,
    advance(delta: number) {
      t += delta
    },
  }
}

async function breakerWith(clock = tickingClock()) {
  const memfs = makeMemFs()
  await memfs.fs.mkdirp('/guard')
  const breaker = new CircuitBreaker({ fs: memfs.fs, path: '/guard/guard-state.json', now: clock.now })
  return { breaker, memfs, clock }
}

/* ────────────────────────── 熔断器单元 ────────────────────────── */

describe('CircuitBreaker：infra 失败滑窗熔断（规格 §2 条件 a）', () => {
  it('infra 失败 ×3 冻结：frozen=true、reason 说明 infra、frozenAt、counts 如实', async () => {
    const { breaker, clock } = await breakerWith()
    await breaker.recordFailure({ taskId: 'T-001', at: clock.now(), class: 'infra' })
    await breaker.recordFailure({ taskId: 'T-002', at: clock.now() + 1, class: 'infra' })
    expect((await breaker!.state()).frozen).toBe(false)
    await breaker.recordFailure({ taskId: 'T-003', at: clock.now() + 2, class: 'infra' })
    const state = await breaker!.state()
    expect(state.frozen).toBe(true)
    expect(state.reason).toContain('infra')
    expect(state.frozenAt).toBe(clock.now() + 2)
    expect(state.counts.infraFailures).toBe(3)
  })

  it('task 类失败不进熔断：×5 仍不冻、计数为 0', async () => {
    const { breaker } = await breakerWith()
    for (let i = 0; i < 5; i += 1) {
      await breaker.recordFailure({ taskId: `T-00${i + 1}`, at: 1000 + i, class: 'task' })
    }
    const state = await breaker!.state()
    expect(state.frozen).toBe(false)
    expect(state.counts.infraFailures).toBe(0)
  })

  it('滑窗：窗内 2 次 + 窗外 2 次 → 只有窗内 2 次计数，不冻', async () => {
    const { breaker, clock } = await breakerWith()
    await breaker.recordFailure({ taskId: 'T-001', at: 100, class: 'infra' })
    await breaker.recordFailure({ taskId: 'T-002', at: 200, class: 'infra' })
    clock.advance(WINDOW_MS + 300) // 前两条滑出窗口
    await breaker.recordFailure({ taskId: 'T-003', at: clock.now(), class: 'infra' })
    await breaker.recordFailure({ taskId: 'T-004', at: clock.now() + 1, class: 'infra' })
    const state = await breaker!.state()
    expect(state.frozen).toBe(false)
    expect(state.counts.infraFailures).toBe(2)
  })
})

describe('CircuitBreaker：创建风暴熔断（规格 §2 条件 b，按任务 ID 集合对窗口）', () => {
  it('9 个不同任务创建零完成不冻，第 10 个冻结且 reason 提及创建', async () => {
    const { breaker } = await breakerWith()
    for (let i = 1; i <= 9; i += 1) {
      await breaker.recordCreation(`T-${String(i).padStart(3, '0')}`, 1000 + i)
    }
    expect((await breaker!.state()).frozen).toBe(false)
    await breaker.recordCreation('T-010', 1010)
    const state = await breaker!.state()
    expect(state.frozen).toBe(true)
    expect(state.reason).toContain('创建')
    expect(state.counts.creations).toBe(10)
  })

  it('同一任务重复创建不重复计（集合语义）', async () => {
    const { breaker } = await breakerWith()
    for (let i = 0; i < 3; i += 1) {
      await breaker.recordCreation('T-001', 1000 + i)
    }
    expect((await breaker!.state()).counts.creations).toBe(1)
  })

  it('完成清基准：9 创建 → 完成 1 个 → 第 10 创建不冻（计数回落 + 零完成被破）', async () => {
    const { breaker } = await breakerWith()
    for (let i = 1; i <= 9; i += 1) {
      await breaker.recordCreation(`T-${String(i).padStart(3, '0')}`, 1000 + i)
    }
    await breaker.recordCompletion('T-005', 1100)
    await breaker.recordCreation('T-010', 1200)
    const state = await breaker!.state()
    expect(state.frozen).toBe(false)
    expect(state.counts.creations).toBe(9) // 9 - 完成 1 + 新 1
    expect(state.counts.completions).toBe(1)
  })
})

describe('CircuitBreaker：持久化与解除（规格 §2 解除仅用户）', () => {
  it('持久化往返：冻结后新实例恢复 frozen/reason/frozenAt', async () => {
    const { breaker, memfs, clock } = await breakerWith()
    await breaker.recordFailure({ taskId: 'T-001', at: 1, class: 'infra' })
    await breaker.recordFailure({ taskId: 'T-002', at: 2, class: 'infra' })
    await breaker.recordFailure({ taskId: 'T-003', at: 3, class: 'infra' })
    const before = await breaker.state()
    const restored = new CircuitBreaker({ fs: memfs.fs, path: '/guard/guard-state.json', now: clock.now })
    const after = await restored.state()
    expect(after.frozen).toBe(true)
    expect(after.reason).toBe(before.reason)
    expect(after.frozenAt).toBe(before.frozenAt)
  })

  it('unfreeze 解除并持久化：新实例不冻；窗口内既有失败仍在，再 1 次 infra 失败即重新冻结', async () => {
    const { breaker, memfs, clock } = await breakerWith()
    await breaker.recordFailure({ taskId: 'T-001', at: 1, class: 'infra' })
    await breaker.recordFailure({ taskId: 'T-002', at: 2, class: 'infra' })
    await breaker.recordFailure({ taskId: 'T-003', at: 3, class: 'infra' })
    expect((await breaker!.state()).frozen).toBe(true)
    await breaker.unfreeze()
    expect((await breaker!.state()).frozen).toBe(false)
    const restored = new CircuitBreaker({ fs: memfs.fs, path: '/guard/guard-state.json', now: clock.now })
    expect((await restored.state()).frozen).toBe(false)
    await restored.recordFailure({ taskId: 'T-004', at: 4, class: 'infra' })
    expect((await restored.state()).frozen).toBe(true)
  })

  it('手动 freeze/unfreeze 对称：freeze 带原因，unfreeze 清除', async () => {
    const { breaker } = await breakerWith()
    await breaker.freeze('用户紧急暂停')
    let state = await breaker.state()
    expect(state.frozen).toBe(true)
    expect(state.reason).toBe('用户紧急暂停')
    await breaker.unfreeze()
    state = await breaker.state()
    expect(state.frozen).toBe(false)
    expect(state.reason).toBeUndefined()
    expect(state.frozenAt).toBeUndefined()
  })
})

/* ────────────────────────── 故障分类器 ────────────────────────── */

describe('classifyDispatchFailure：infra/task 分类（规格 §1）', () => {
  it('bridge 打标的 infra 错误 → infra，detail 带阶段与原始消息', () => {
    const verdict = classifyDispatchFailure(tagInfraFailure(new Error('preset row never started'), '会话创建失败'))
    expect(verdict.class).toBe('infra')
    expect(verdict.detail).toContain('会话创建失败')
    expect(verdict.detail).toContain('preset row never started')
  })

  it('账本域拒绝（模板/角色）→ task', () => {
    expect(classifyDispatchFailure(new LedgerError('template-unavailable', '未知模板')).class).toBe('task')
    expect(classifyDispatchFailure(new LedgerError('role-forbidden', '角色不对')).class).toBe('task')
    expect(classifyDispatchFailure(new LedgerError('doc-not-found', '任务书缺失')).class).toBe('task')
  })

  it('持久化失败 → infra（磁盘/落盘是系统故障）', () => {
    expect(classifyDispatchFailure(new LedgerError('persistence-failed', '写盘失败')).class).toBe('infra')
  })

  it('未打标的未知错误按 infra 计（误报代价=用户一键解除，漏报代价=失控）', () => {
    expect(classifyDispatchFailure(new Error('ECONNRESET')).class).toBe('infra')
    expect(classifyDispatchFailure('字符串错误').class).toBe('infra')
  })
})

/* ────────────────────────── 核心挂接（派发链路） ────────────────────────── */

const INPUT = {
  title: '修登录',
  goal: '登录不再 500',
  acceptance: ['回归通过'],
  role: 'worker' as const,
  templateId: 'coder',
}

describe('RouterCore ×熔断器：派发链路（规格 §2 冻结语义）', () => {
  it('infra 失败 ×3 全局冻结：第 4 次 dispatch_task 被 dispatch-frozen 拦下，文案含停止重试与向用户报告', async () => {
    const { core, breaker } = await guardCoreWith({ failCreate: () => new Error('boom'), budgets: null })
    for (let i = 0; i < 3; i += 1) {
      await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    }
    expect((await breaker!.state()).frozen).toBe(true)
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({
      code: 'dispatch-frozen',
      message: expect.stringContaining('派发已冻结'),
    })
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toThrowError(/请停止重试并向用户报告/)
  })

  it('冻结时 create_worker_type 同拦：同文案', async () => {
    const { core, breaker } = await guardCoreWith({ failCreate: () => new Error('boom'), budgets: null })
    for (let i = 0; i < 3; i += 1) {
      await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    }
    expect((await breaker!.state()).frozen).toBe(true)
    await expect(core.createWorkerType('router-s-1', { name: '新类型' })).rejects.toMatchObject({
      code: 'dispatch-frozen',
      message: expect.stringContaining('请停止重试并向用户报告'),
    })
  })

  it('bridge 层打标优先于错误形状：宿主抛域形状错误也按 infra 计（会话创建阶段）', async () => {
    // 宿主 API 抛出的是它自己的错误（哪怕形似域内拒绝）：会话创建失败是 infra，
    // 由 bridge 在失败路径打标，不靠错误形状推断。
    const { core, breaker } = await guardCoreWith({
      budgets: null,
      failCreate: () => new LedgerError('template-unavailable', 'host internal row broken'),
    })
    for (let i = 0; i < 3; i += 1) {
      await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    }
    expect((await breaker!.state()).frozen).toBe(true)
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-frozen' })
  })

  it('task 类拒绝不计熔断：未知模板连拒 5 次，熔断不冻', async () => {
    const { core, breaker } = await guardCoreWith({ budgets: null })
    for (let i = 0; i < 5; i += 1) {
      await expect(core.dispatchTask('router-s-1', { ...INPUT, templateId: 'nope' })).rejects.toMatchObject({
        code: 'template-unavailable',
      })
    }
    const state = await breaker!.state()
    expect(state.frozen).toBe(false)
    expect(state.counts.infraFailures).toBe(0)
  })

  it('成功派发进创建计数：第 10 个任务创建后冻结，第 11 次派发被拦', async () => {
    const { core, breaker } = await guardCoreWith({ budgets: null })
    for (let i = 0; i < 10; i += 1) {
      // 第 10 次：冻结检查在创建计数之前 → 本次仍成功，随后熔断闭合
      await core.dispatchTask('router-s-1', { ...INPUT, title: `任务 ${i + 1}` })
    }
    expect((await breaker!.state()).frozen).toBe(true)
    await expect(core.dispatchTask('router-s-1', { ...INPUT, title: '第 11 个' })).rejects.toMatchObject({
      code: 'dispatch-frozen',
    })
  })

  it('完成清基准接线：9 次派发 + 完成 1 个 → 第 10 次派发放行', async () => {
    const { core, breaker, ledger } = await guardCoreWith({ budgets: null })
    const results = []
    for (let i = 0; i < 9; i += 1) {
      results.push(await core.dispatchTask('router-s-1', { ...INPUT, title: `任务 ${i + 1}` }))
    }
    // 状态机没有 dispatched → completed 边：执行会话先开跑（→ running）再提交完成
    await ledger.transition(results[0]!.taskId, 'running')
    await core.completeTask(results[0]!.sessionId!, results[0]!.taskId, { docVersion: 1, summary: '完成' })
    const tenth = await core.dispatchTask('router-s-1', { ...INPUT, title: '任务 10' })
    expect(tenth.taskId).toBe('T-010')
    expect((await breaker!.state()).frozen).toBe(false)
  })

  it('解锁自动派发失败也计熔断（infra）：完成解锁后建会话失败 → counts.infraFailures=1', async () => {
    const records = [
      { ...task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' }) },
      { ...task({ id: 'T-010', role: 'worker', status: 'queued', dependsOn: ['T-001'], projectId: 'ws-1', cwd: '/proj', title: '解锁后派发' }) },
    ]
    const { core, breaker, docs, ledger } = await guardCoreWith({ records, failCreate: () => new Error('boom') })
    await docs.initTask(ledger.get('T-010')!, '# 任务书 T-010')
    await core.completeTask('session-9', 'T-001', { docVersion: 1, summary: '依赖完' })
    expect(ledger.get('T-010')?.status).toBe('queued')
    const state = await breaker!.state()
    expect(state.counts.infraFailures).toBe(1)
    expect(state.frozen).toBe(false) // 只 1 次，未达阈值
  })
})
