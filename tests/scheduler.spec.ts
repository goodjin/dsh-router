/**
 * 依赖解锁与调度就绪判定测试（计划 Task 4）。
 *
 * 覆盖计划「步骤」列出的断言集合：A→B 依赖链完成后 B 就绪；worker 派发被拒；
 * 深度=2 时第三层被拒；依赖 completed 才就绪（running 不算）。
 * 另加：readyTasks 按创建序、无依赖的 queued 也算就绪、环拒绝（依赖含自身祖先）、
 * onCompleted 无解锁时返回空。
 */

import { describe, expect, it } from 'vitest'
import { Scheduler } from '../src/host/ledger/scheduler.ts'
import { TaskLedger } from '../src/host/ledger/store.ts'
import type { LedgerFile, LedgerPersistence } from '../src/host/ledger/store.ts'

/** 内存持久化（与账本测试同一形状）。 */
class MemoryPersistence implements LedgerPersistence {
  file: LedgerFile | null = null

  async load(): Promise<LedgerFile | null> {
    return this.file === null ? null : structuredClone(this.file)
  }

  async save(f: LedgerFile): Promise<void> {
    this.file = structuredClone(f)
  }
}

/** 步进时钟。 */
function stepClock(): () => number {
  let t = 1000
  return () => (t += 1000)
}

/** 最小任务入参。 */
function taskInput(overrides: Partial<Parameters<TaskLedger['createTask']>[0]> = {}) {
  return { title: '任务', goal: '目标', projectId: 'proj-1', cwd: '/tmp/proj', role: 'worker' as const, ...overrides }
}

/** 把任务推到 completed（draft→queued→dispatched→running→completed，auto 策略）。 */
async function driveToCompleted(ledger: TaskLedger, id: string): Promise<void> {
  await ledger.transition(id, 'queued')
  await ledger.transition(id, 'dispatched')
  await ledger.transition(id, 'running')
  await ledger.complete(id, { docVersion: 1, summary: '完成' })
}

/** 造一个 maxDepth=2 的调度器。 */
function scheduler(ledger: TaskLedger): Scheduler {
  return new Scheduler(ledger, { maxDepth: 2, concurrency: { coder: 2 } })
}

describe('readyTasks：依赖 completed 才就绪', () => {
  it('A→B 链：A 未完成时 B 不就绪；A 完成后 B 就绪且排创建序', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock())
    const a = await ledger.createTask(taskInput({ title: 'A' }))
    const b = await ledger.createTask(taskInput({ title: 'B', dependsOn: [a.id] }))
    const c = await ledger.createTask(taskInput({ title: 'C', dependsOn: [a.id] }))
    const sched = scheduler(ledger)
    // B、C 都是 queued（依赖未满足），但 A 还没完成
    expect((await sched.readyTasks()).map((t) => t.id)).toEqual([])
    await driveToCompleted(ledger, a.id)
    const ready = await sched.readyTasks()
    expect(ready.map((t) => t.id)).toEqual([b.id, c.id])
    expect(ready.map((t) => t.status)).toEqual(['queued', 'queued'])
  })

  it('依赖处于 running 不算就绪', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock())
    const a = await ledger.createTask(taskInput({ title: 'A' }))
    const b = await ledger.createTask(taskInput({ title: 'B', dependsOn: [a.id] }))
    const sched = scheduler(ledger)
    await ledger.transition(a.id, 'queued')
    await ledger.transition(a.id, 'dispatched')
    await ledger.transition(a.id, 'running')
    expect((await sched.readyTasks()).map((t) => t.id)).toEqual([])
    await ledger.complete(a.id, { docVersion: 1, summary: '完成' })
    expect((await sched.readyTasks()).map((t) => t.id)).toEqual([b.id])
  })

  it('无依赖的 queued 任务本身算就绪', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock())
    const a = await ledger.createTask(taskInput({ title: 'A' }))
    const sched = scheduler(ledger)
    await ledger.transition(a.id, 'queued')
    expect((await sched.readyTasks()).map((t) => t.id)).toEqual([a.id])
  })
})

describe('onCompleted：完成后新解锁的任务', () => {
  it('只返回依赖该任务且现已全部依赖完成的 queued 任务', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock())
    const a = await ledger.createTask(taskInput({ title: 'A' }))
    const b = await ledger.createTask(taskInput({ title: 'B', dependsOn: [a.id] }))
    await ledger.createTask(taskInput({ title: 'C', dependsOn: [] }))
    await ledger.transition('T-003', 'queued')
    const sched = scheduler(ledger)
    // 先完成 A，再问"这次完成解锁了谁"；C 与 A 的完成无关
    await driveToCompleted(ledger, a.id)
    const unlocked = await sched.onCompleted(a.id)
    expect(unlocked.map((t) => t.id)).toEqual([b.id])
    expect((await sched.onCompleted('T-003')).map((t) => t.id)).toEqual([])
  })
})

describe('dispatchGuard：角色 / 深度 / 环', () => {
  it('worker 角色派发被拒（role-forbidden）', () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock())
    const sched = scheduler(ledger)
    expect(sched.dispatchGuard({ sessionIdRole: 'worker', depth: 1 }, { role: 'worker' })).toEqual({
      ok: false,
      code: 'role-forbidden',
    })
  })

  it('深度=2 时第三层被拒：depth 1 放行、depth 2 拒绝（depth-exceeded）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock())
    const sched = scheduler(ledger)
    expect(sched.dispatchGuard({ sessionIdRole: 'router', depth: 0 }, { role: 'supervisor' })).toEqual({ ok: true })
    expect(sched.dispatchGuard({ sessionIdRole: 'supervisor', depth: 1 }, { role: 'worker' })).toEqual({ ok: true })
    expect(sched.dispatchGuard({ sessionIdRole: 'supervisor', depth: 2 }, { role: 'worker' })).toEqual({
      ok: false,
      code: 'depth-exceeded',
    })
  })

  it('目标依赖含自身祖先拒绝（cycle-risk）；含无关任务放行', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock())
    // T-001（根）→ T-002（parentId=T-001）
    await ledger.createTask(taskInput({ title: '根' }))
    await ledger.createTask(taskInput({ title: '子', parentId: 'T-001' }))
    const sched = scheduler(ledger)
    // 从 T-002 向下派发，目标依赖 T-001（自身祖先）→ 环风险
    expect(
      sched.dispatchGuard({ sessionIdRole: 'supervisor', parentTaskId: 'T-002', depth: 2 }, { role: 'worker', dependsOn: ['T-001'] }),
    ).toEqual({ ok: false, code: 'cycle-risk' })
    // 直接依赖父任务自身同样拒绝
    expect(
      sched.dispatchGuard({ sessionIdRole: 'supervisor', parentTaskId: 'T-002', depth: 1 }, { role: 'worker', dependsOn: ['T-002'] }),
    ).toEqual({ ok: false, code: 'cycle-risk' })
    // 依赖无关任务（或未传 dependsOn）→ 放行
    expect(
      sched.dispatchGuard({ sessionIdRole: 'supervisor', parentTaskId: 'T-002', depth: 1 }, { role: 'worker', dependsOn: ['T-999'] }),
    ).toEqual({ ok: true })
    expect(sched.dispatchGuard({ sessionIdRole: 'supervisor', parentTaskId: 'T-002', depth: 1 }, { role: 'worker' })).toEqual({
      ok: true,
    })
  })

  it('parentId 链成环时祖先回溯必须终止（不挂起）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock())
    // T-001 与 T-002 互为父任务（parentId 环；createTask 只查 dependsOn 环）
    await ledger.createTask(taskInput({ title: 'A', parentId: 'T-002' }))
    await ledger.createTask(taskInput({ title: 'B', parentId: 'T-001' }))
    const sched = scheduler(ledger)
    // 依赖不涉祖先：放行且立刻返回
    expect(
      sched.dispatchGuard({ sessionIdRole: 'supervisor', parentTaskId: 'T-001', depth: 1 }, { role: 'worker', dependsOn: ['T-003'] }),
    ).toEqual({ ok: true })
    // 依赖命中环上任一祖先：环风险
    expect(
      sched.dispatchGuard({ sessionIdRole: 'supervisor', parentTaskId: 'T-001', depth: 1 }, { role: 'worker', dependsOn: ['T-002'] }),
    ).toEqual({ ok: false, code: 'cycle-risk' })
  })
})
