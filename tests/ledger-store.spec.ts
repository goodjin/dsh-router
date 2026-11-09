/**
 * 任务账本 TaskLedger 测试（计划 Task 2）。
 *
 * 覆盖计划「步骤」列出的断言集合：ID 单调、环检测（A→B→A 抛错含路径）、
 * 非法迁移拒绝、complete 幂等、stale-version 拒绝、persistence 失败回滚、
 * listActive 过滤终态；另加边角：初始状态落点（draft/queued）、
 * supplement 升版、accept/reject/reportBlocker、updatedAt 单调、task-not-found。
 * 持久化用内存实现（照计划：IO 走注入式适配器）。
 */

import { describe, expect, it } from 'vitest'
import { LedgerError } from '../src/host/ledger/errors.ts'
import { TaskLedger } from '../src/host/ledger/store.ts'
import type { LedgerFile, LedgerPersistence, TaskStatus } from '../src/host/ledger/store.ts'
import type { TaskRecord } from '../src/shared/types.ts'

/** 内存持久化：save 深拷贝落"盘"，可注入保存失败。 */
class MemoryPersistence implements LedgerPersistence {
  file: LedgerFile | null = null
  saveCalls = 0
  failNextSave = false

  async load(): Promise<LedgerFile | null> {
    return this.file === null ? null : structuredClone(this.file)
  }

  async save(f: LedgerFile): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false
      throw new Error('disk full')
    }
    this.saveCalls += 1
    this.file = structuredClone(f)
  }
}

/** 步进时钟：每次调用前进 1000，保证 updatedAt 可观察地单调。 */
function stepClock(): { now: () => number } {
  let t = 1000
  return { now: () => (t += 1000) }
}

/** 新任务入参（最小必填）。 */
function taskInput(overrides: Partial<Parameters<TaskLedger['createTask']>[0]> = {}) {
  return {
    title: '任务',
    goal: '达成某目标',
    projectId: 'proj-1',
    cwd: '/tmp/proj',
    role: 'worker' as const,
    ...overrides,
  }
}

/** 把任务从 draft 推到 running（draft→queued→dispatched→running）。 */
async function driveToRunning(ledger: TaskLedger, id: string): Promise<void> {
  await ledger.transition(id, 'queued')
  await ledger.transition(id, 'dispatched')
  await ledger.transition(id, 'running')
}

/** 完成一个 draft 任务的最短路径：推到 running 后按 auto 策略完成。 */
async function completeFromDraft(ledger: TaskLedger, id: string, docVersion = 1): Promise<TaskRecord> {
  await driveToRunning(ledger, id)
  return ledger.complete(id, { docVersion, summary: '完成' })
}

describe('派发溯源：dispatchedBySessionId（v1.4 作用域暂停的归属依据）', () => {
  it('createTask 落库派发者会话', async () => {
    const p = new MemoryPersistence()
    const ledger = new TaskLedger(p, stepClock().now)
    const record = await ledger.createTask(taskInput({ dispatchedBySessionId: 'router-s-1' }))
    expect(record.dispatchedBySessionId).toBe('router-s-1')
  })

  it('未给派发者 → 字段缺席（旧任务：无法归属，不臆造）', async () => {
    const p = new MemoryPersistence()
    const ledger = new TaskLedger(p, stepClock().now)
    const record = await ledger.createTask(taskInput())
    expect(record.dispatchedBySessionId).toBeUndefined()
  })
})

describe('ID 分配：T-%03d 单调', () => {
  it('同一账本内 T-001、T-002 依次分配', async () => {
    const p = new MemoryPersistence()
    const ledger = new TaskLedger(p, stepClock().now)
    const a = await ledger.createTask(taskInput({ title: 'A' }))
    const b = await ledger.createTask(taskInput({ title: 'B' }))
    expect(a.id).toBe('T-001')
    expect(b.id).toBe('T-002')
  })

  it('nextTaskNumber 持久化：重启（新账本同 persistence）后继续单调', async () => {
    const p = new MemoryPersistence()
    const first = new TaskLedger(p, stepClock().now)
    await first.createTask(taskInput())
    await first.createTask(taskInput())
    const second = new TaskLedger(p, stepClock().now)
    const next = await second.createTask(taskInput())
    expect(next.id).toBe('T-003')
  })
})

describe('createTask 初始状态落点', () => {
  it('无依赖或依赖全部完成 → draft', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const a = await ledger.createTask(taskInput())
    expect(a.status).toBe('draft')
    expect(a.docVersion).toBe(1)
  })

  it('依赖存在但未完成 → queued（依赖未满足落 queued）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const a = await ledger.createTask(taskInput())
    const b = await ledger.createTask(taskInput({ dependsOn: [a.id] }))
    expect(b.status).toBe('queued')
  })

  it('依赖已全部 completed → draft', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const a = await ledger.createTask(taskInput())
    await completeFromDraft(ledger, a.id)
    const b = await ledger.createTask(taskInput({ dependsOn: [a.id] }))
    expect(b.status).toBe('draft')
  })
})

describe('依赖环检测', () => {
  it('A→B→A 抛 dependency-cycle 且消息含环路径', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    // A 前向引用尚未创建的 T-002，创建 T-002 时成环
    await ledger.createTask(taskInput({ title: 'A', dependsOn: ['T-002'] }))
    try {
      await ledger.createTask(taskInput({ title: 'B', dependsOn: ['T-001'] }))
      expect.fail('应抛 dependency-cycle')
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError)
      expect((err as LedgerError).code).toBe('dependency-cycle')
      expect((err as Error).message).toContain('T-001')
      expect((err as Error).message).toContain('T-002')
      expect((err as Error).message).toContain('→')
    }
  })

  it('环检测失败后账本状态不变：任务未落库、ID 计数器回滚', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    await ledger.createTask(taskInput({ title: 'A', dependsOn: ['T-002'] }))
    await expect(ledger.createTask(taskInput({ title: 'B', dependsOn: ['T-001'] }))).rejects.toBeInstanceOf(LedgerError)
    expect(ledger.get('T-002')).toBeUndefined()
    const next = await ledger.createTask(taskInput({ title: 'C' }))
    expect(next.id).toBe('T-002')
  })

  it('菱形依赖（D→B→A、D→C→A）不是环：共享祖先重复可达不误报（审查修复）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const a = await ledger.createTask(taskInput({ title: 'A' }))
    const b = await ledger.createTask(taskInput({ title: 'B', dependsOn: [a.id] }))
    const c = await ledger.createTask(taskInput({ title: 'C', dependsOn: [a.id] }))
    // D 同时依赖 B、C：A 经两条路径可达。无 done 集的 DFS 会把第二次到访的 A
    // 误判成环（A 仍在 visiting 栈里）；三色标记修复后应正常落库。
    const d = await ledger.createTask(taskInput({ title: 'D', dependsOn: [b.id, c.id] }))
    expect(d.id).toBe('T-004')
    expect(d.dependsOn).toEqual([b.id, c.id])
  })
})

describe('transition：非法迁移拒绝、合法链通过', () => {
  it('draft→running 抛 illegal-transition；合法链 draft→queued→dispatched→running 可过', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await expect(ledger.transition(t.id, 'running')).rejects.toMatchObject({ code: 'illegal-transition' })
    await driveToRunning(ledger, t.id)
    expect(ledger.get(t.id)?.status).toBe('running')
  })

  it('终态后任何迁移非法：completed→running 抛', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await completeFromDraft(ledger, t.id)
    await expect(ledger.transition(t.id, 'running')).rejects.toMatchObject({ code: 'illegal-transition' })
  })

  it('不存在的任务：get 返回 undefined，transition 抛 task-not-found', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    expect(ledger.get('T-999')).toBeUndefined()
    await expect(ledger.transition('T-999', 'queued')).rejects.toMatchObject({ code: 'task-not-found' })
  })
})

describe('R-1：worker 在 dispatched 上直接交付（需求 §3）', () => {
  it('auto 策略：draft→queued→dispatched 后直接 complete → completed（不必先转 running）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await ledger.transition(t.id, 'queued')
    await ledger.transition(t.id, 'dispatched')
    const done = await ledger.complete(t.id, { docVersion: 1, summary: '完成' })
    expect(done.status).toBe('completed')
    expect(done.result?.summary).toBe('完成')
  })

  it('有未结子任务：dispatched 上直接 complete → review-pending（同样不被缺边卡死）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const parent = await ledger.createTask(taskInput({ role: 'supervisor' }))
    await ledger.createTask(taskInput({ parentId: parent.id }))
    await ledger.transition(parent.id, 'queued')
    await ledger.transition(parent.id, 'dispatched')
    const pending = await ledger.complete(parent.id, { docVersion: 1, summary: '父任务交付' })
    expect(pending.status).toBe('review-pending')
  })
})

describe('complete：auto 策略、幂等、stale-version', () => {
  it('policy auto 且无未结子任务 → completed，result 落库带完成时间', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput({ acceptancePolicy: 'auto' }))
    const done = await completeFromDraft(ledger, t.id)
    expect(done.status).toBe('completed')
    expect(done.result?.summary).toBe('完成')
    expect(typeof done.result?.completedAt).toBe('number')
  })

  it('重复完成（同任务同 docVersion）幂等返回首次完成记录，不再触发 save', async () => {
    const p = new MemoryPersistence()
    const ledger = new TaskLedger(p, stepClock().now)
    const t = await ledger.createTask(taskInput())
    const first = await completeFromDraft(ledger, t.id)
    const saves = p.saveCalls
    const again = await ledger.complete(t.id, { docVersion: 1, summary: '再交一次' })
    expect(again).toBe(first)
    expect(again.result?.summary).toBe('完成')
    expect(again.result?.completedAt).toBe(first.result?.completedAt)
    expect(p.saveCalls).toBe(saves)
  })

  it('completed 后旧版本提交抛 stale-version', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await completeFromDraft(ledger, t.id)
    await expect(ledger.complete(t.id, { docVersion: 2, summary: '迟到提交' })).rejects.toMatchObject({ code: 'stale-version' })
  })

  it('draft 上直接 complete 抛 illegal-transition（状态机守住）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await expect(ledger.complete(t.id, { docVersion: 1, summary: '没派发就交' })).rejects.toMatchObject({ code: 'illegal-transition' })
  })

  it('子任务未结时 policy auto 也只到 review-pending；子任务结后 complete 幂等返回原记录', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const parent = await ledger.createTask(taskInput({ acceptancePolicy: 'auto' }))
    await driveToRunning(ledger, parent.id)
    const child = await ledger.createTask(taskInput({ parentId: parent.id }))
    const first = await ledger.complete(parent.id, { docVersion: 1, summary: '父完成申请' })
    expect(first.status).toBe('review-pending')
    // review-pending 态的重复提交（同版本）同样幂等
    expect(await ledger.complete(parent.id, { docVersion: 1, summary: '重复' })).toBe(first)
    // 子任务完成后 complete 仍幂等（首次记录不重建）
    await completeFromDraft(ledger, child.id)
    expect(await ledger.complete(parent.id, { docVersion: 1, summary: '再交' })).toBe(first)
  })
})

describe('accept / reject：验收协议', () => {
  it('policy supervisor：complete → review-pending，accept → completed', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput({ acceptancePolicy: 'supervisor' }))
    await driveToRunning(ledger, t.id)
    const submitted = await ledger.complete(t.id, { docVersion: 1, summary: '待验收' })
    expect(submitted.status).toBe('review-pending')
    const accepted = await ledger.accept(t.id, 'supervisor')
    expect(accepted.status).toBe('completed')
    expect(accepted.result?.summary).toBe('待验收')
  })

  it('reject：review-pending → running，note 落 progress；再 complete 重新进 review-pending', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput({ acceptancePolicy: 'user' }))
    await driveToRunning(ledger, t.id)
    await ledger.complete(t.id, { docVersion: 1, summary: '第一版' })
    const rejected = await ledger.reject(t.id, '验收不过，重做')
    expect(rejected.status).toBe('running')
    expect(rejected.progress).toBe('验收不过，重做')
    // 驳回仅适用于 review-pending：running 上直接驳回抛非法迁移
    await expect(ledger.reject(t.id, '再驳一次')).rejects.toMatchObject({ code: 'illegal-transition' })
    const resubmitted = await ledger.complete(t.id, { docVersion: 1, summary: '第二版' })
    expect(resubmitted.status).toBe('review-pending')
  })
})

describe('rework：退回重做（需求 §14.2 完成卡动作，协议专属不走表边）', () => {
  it('completed → running，note 落 progress；返工后可重新 complete', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput({ acceptancePolicy: 'auto' }))
    await completeFromDraft(ledger, t.id)
    const reopened = await ledger.rework(t.id, '用户退回：验收条件没达成')
    expect(reopened.status).toBe('running')
    expect(reopened.progress).toBe('用户退回：验收条件没达成')
    const redone = await ledger.complete(t.id, { docVersion: 1, summary: '返工后完成' })
    expect(redone.status).toBe('completed')
    expect(redone.result?.summary).toBe('返工后完成')
  })

  it('非 completed 起点照抛 illegal-transition（running / review-pending）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput({ acceptancePolicy: 'user' }))
    await driveToRunning(ledger, t.id)
    await expect(ledger.rework(t.id, '还没完成就退')).rejects.toMatchObject({ code: 'illegal-transition' })
    await ledger.complete(t.id, { docVersion: 1, summary: '待验收' })
    await expect(ledger.rework(t.id, '待验收不能退')).rejects.toMatchObject({ code: 'illegal-transition' })
  })

  it('迁移表终态仍无出边：transition(completed→running) 照抛（rework 是唯一 reopen 通道）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput({ acceptancePolicy: 'auto' }))
    await completeFromDraft(ledger, t.id)
    await expect(ledger.transition(t.id, 'running')).rejects.toMatchObject({ code: 'illegal-transition' })
  })
})

describe('supplement：升版与约束追加', () => {
  it('docVersion+1、追加约束、updatedAt 前进', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput({ constraints: ['只用标准库'] }))
    const before = t.updatedAt
    const v2 = await ledger.supplement(t.id, ['补：禁用网络'])
    expect(v2).toBe(2)
    const after = ledger.get(t.id)
    expect(after?.docVersion).toBe(2)
    expect(after?.constraints).toEqual(['只用标准库', '补：禁用网络'])
    expect(after!.updatedAt).toBeGreaterThan(before)
  })

  it('升版后旧版本 complete 提交抛 stale-version', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await driveToRunning(ledger, t.id)
    await ledger.supplement(t.id, ['新约束'])
    await expect(ledger.complete(t.id, { docVersion: 1, summary: '旧 worker 迟到' })).rejects.toMatchObject({ code: 'stale-version' })
    const done = await ledger.complete(t.id, { docVersion: 2, summary: '按新版完成' })
    expect(done.status).toBe('completed')
  })

  it('终态任务不可 supplement', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await completeFromDraft(ledger, t.id)
    await expect(ledger.supplement(t.id, ['迟来的约束'])).rejects.toBeInstanceOf(LedgerError)
  })
})

describe('reportBlocker / cancel / fail / attachSession / updateProgress', () => {
  it('reportBlocker：running → blocked，reason 落 progress', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await driveToRunning(ledger, t.id)
    const blocked = await ledger.reportBlocker(t.id, '缺凭据')
    expect(blocked.status).toBe('blocked')
    expect(blocked.progress).toBe('缺凭据')
    const resumed = await ledger.transition(t.id, 'running')
    expect(resumed.status).toBe('running')
  })

  it('cancel：running → cancelled 进终态；fail：blocked → failed', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const a = await ledger.createTask(taskInput())
    await driveToRunning(ledger, a.id)
    expect((await ledger.cancel(a.id, '不要了')).status).toBe('cancelled')
    const b = await ledger.createTask(taskInput())
    await driveToRunning(ledger, b.id)
    await ledger.reportBlocker(b.id, '卡住')
    expect((await ledger.fail(b.id, '修不好')).status).toBe('failed')
  })

  it('attachSession / updateProgress 落库，updatedAt 单调前进', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    const created = t.updatedAt
    const withSession = await ledger.attachSession(t.id, 'sess-1')
    expect(withSession.sessionId).toBe('sess-1')
    expect(withSession.updatedAt).toBeGreaterThan(created)
    // 记录是活引用：先快照数值，再做单调比较
    const sessionUpdatedAt = withSession.updatedAt
    const progressed = await ledger.updateProgress(t.id, '跑了一半')
    expect(progressed.progress).toBe('跑了一半')
    expect(progressed.updatedAt).toBeGreaterThan(sessionUpdatedAt)
  })
})

describe('listActive / listAll / 持久化形状', () => {
  it('listActive 过滤终态并按创建序，listAll 全量', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const a = await ledger.createTask(taskInput({ title: 'A' }))
    const b = await ledger.createTask(taskInput({ title: 'B' }))
    const c = await ledger.createTask(taskInput({ title: 'C' }))
    await completeFromDraft(ledger, b.id)
    await ledger.cancel(c.id, '取消')
    const active = await ledger.listActive()
    expect(active.map((t: TaskRecord) => t.id)).toEqual([a.id])
    const all = await ledger.listAll()
    expect(all.map((t: TaskRecord) => t.id)).toEqual(['T-001', 'T-002', 'T-003'])
  })

  it('保存的 LedgerFile 带 schemaVersion=1、tasks、nextTaskNumber、questions', async () => {
    const p = new MemoryPersistence()
    const ledger = new TaskLedger(p, stepClock().now)
    await ledger.createTask(taskInput())
    expect(p.file?.schemaVersion).toBe(1)
    expect(p.file?.tasks).toHaveLength(1)
    expect(p.file?.nextTaskNumber).toBe(2)
    expect(Array.isArray(p.file?.questions)).toBe(true)
  })
})

describe('persistence 失败：内存回滚', () => {
  it('M6：并发首访共用同一次装载——只读与写并发时后完成的装载不覆盖已提交的增量', async () => {
    // 先用真实路径造一个盘上快照（1 个种子任务）。
    const p = new MemoryPersistence()
    p.file = { schemaVersion: 1, tasks: [], nextTaskNumber: 1, questions: [] }
    const warm = new TaskLedger(p, stepClock().now)
    await warm.createTask(taskInput({ title: '种子任务' }))
    // 读盘时立刻取快照、延迟返回：复现「各自读盘→后完成者把先提交的增量整片
    // 覆盖回磁盘快照」的竞态（只读首访不走 writeChain，与 commit 并发时成立）。
    const slowP = {
      load: async () => {
        const snapshot = await p.load()
        await new Promise((resolve) => setTimeout(resolve, 5))
        return snapshot
      },
      save: (f: LedgerFile) => p.save(f),
    }
    const ledger = new TaskLedger(slowP as LedgerPersistence, stepClock().now)
    const creating = ledger.createTask(taskInput({ title: '并发新建' }))
    await new Promise((resolve) => setTimeout(resolve, 0)) // 让 commit 先进入装载
    const listing = ledger.listAll()
    await Promise.all([creating, listing])
    const names = (await ledger.listAll()).map((t) => t.title)
    expect(names).toContain('种子任务')
    expect(names).toContain('并发新建') // 未被第二次装载覆盖回快照
    expect(await ledger.listAll()).toHaveLength(2)
  })

  it('createTask 保存失败抛 persistence-failed，内存与 ID 计数器回滚', async () => {
    const p = new MemoryPersistence()
    const ledger = new TaskLedger(p, stepClock().now)
    p.failNextSave = true
    await expect(ledger.createTask(taskInput())).rejects.toMatchObject({ code: 'persistence-failed' })
    expect(await ledger.listAll()).toEqual([])
    expect(ledger.get('T-001')).toBeUndefined()
    const retry = await ledger.createTask(taskInput())
    expect(retry.id).toBe('T-001')
  })

  it('transition 保存失败抛 persistence-failed，状态回滚', async () => {
    const p = new MemoryPersistence()
    const ledger = new TaskLedger(p, stepClock().now)
    const t = await ledger.createTask(taskInput())
    await ledger.transition(t.id, 'queued')
    p.failNextSave = true
    await expect(ledger.transition(t.id, 'dispatched')).rejects.toMatchObject({ code: 'persistence-failed' })
    expect(ledger.get(t.id)?.status).toBe('queued')
    await ledger.transition(t.id, 'dispatched')
    expect(ledger.get(t.id)?.status).toBe('dispatched')
  })

  it('校验失败（非法迁移）根本不触发 save', async () => {
    const p = new MemoryPersistence()
    const ledger = new TaskLedger(p, stepClock().now)
    const t = await ledger.createTask(taskInput())
    const saves = p.saveCalls
    await expect(ledger.transition(t.id, 'completed')).rejects.toBeInstanceOf(LedgerError)
    expect(p.saveCalls).toBe(saves)
  })
})

describe('recordDispatchFailure：派发失败记账（v1.1 A4）', () => {
  it('累计封顶：第 3 次自动 blocked', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await ledger.recordDispatchFailure(t.id, '第1次失败')
    await ledger.recordDispatchFailure(t.id, '第2次失败')
    const capped = await ledger.recordDispatchFailure(t.id, '第3次失败')
    expect(capped.status).toBe('blocked')
    expect(capped.retryCount).toBe(3)
    expect(capped.progress).toBe('第3次失败')
  })

  it('封顶后幂等：再记账不抛 blocked→blocked、retryCount 停在上限、错误文本照更新', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    for (const reason of ['第1次', '第2次', '第3次']) {
      await ledger.recordDispatchFailure(t.id, reason)
    }
    const again = await ledger.recordDispatchFailure(t.id, '第4次')
    expect(again.status).toBe('blocked')
    expect(again.retryCount).toBe(3)
    expect(again.progress).toBe('第4次')
  })

  it('封顶迁移非法时先校验后变更：内存不留半程脏写（计数未增、状态未动）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await ledger.transition(t.id, 'queued')
    await ledger.transition(t.id, 'dispatched')
    await ledger.transition(t.id, 'running')
    await ledger.recordDispatchFailure(t.id, 'running 上第 1 次')
    await ledger.recordDispatchFailure(t.id, 'running 上第 2 次')
    // running→blocked 合法：第 3 次封顶
    const capped = await ledger.recordDispatchFailure(t.id, 'running 上第 3 次')
    expect(capped.status).toBe('blocked')
    expect(capped.retryCount).toBe(3)
    // blocked→再记账：幂等不抛
    const again = await ledger.recordDispatchFailure(t.id, '第 4 次')
    expect(again.status).toBe('blocked')
    expect(again.retryCount).toBe(3)
  })
})

describe('recordFirstCacheRead：首请求缓存命中记账（v1.3 C1）', () => {
  it('写入 firstRequestCacheReadTokens 并落盘', async () => {
    const persistence = new MemoryPersistence()
    const ledger = new TaskLedger(persistence, stepClock().now)
    const t = await ledger.createTask(taskInput())
    await ledger.recordFirstCacheRead(t.id, 5632)
    expect(ledger.get(t.id)?.firstRequestCacheReadTokens).toBe(5632)
    const saved = persistence.file?.tasks.find((task) => task.id === t.id)
    expect(saved?.firstRequestCacheReadTokens).toBe(5632)
  })

  it('一次性语义：已有值不覆盖（观察器只对首条调用，账本层兜底防覆盖）', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    const t = await ledger.createTask(taskInput())
    await ledger.recordFirstCacheRead(t.id, 5632)
    await ledger.recordFirstCacheRead(t.id, 99999)
    expect(ledger.get(t.id)?.firstRequestCacheReadTokens).toBe(5632)
  })

  it('任务不存在 → task-not-found', async () => {
    const ledger = new TaskLedger(new MemoryPersistence(), stepClock().now)
    await expect(ledger.recordFirstCacheRead('T-999', 100)).rejects.toMatchObject({ code: 'task-not-found' })
  })
})
