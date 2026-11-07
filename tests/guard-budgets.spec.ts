/**
 * v1.2 Task B2：派发预算（规格 §3，接口照计划逐字）。
 *
 * 钉住的语义：预算按「轮次」近似「用户消息」边界——会话 running→true 即新轮，
 * ask_user 的回答开启新轮、预算自然重计；Router 每轮 1 任务 + 1 批提问（第二批
 * 在认领层自动回「请合并为一批重问」）；主管连续 3 次派发失败（infra 或 task 均
 * 计）冻结、成功或新轮解除；query_tasks 返回附 budgets 与 breaker 冻结态（模型
 * 可见）。budgets 与 per-task retry（v1.1 的 3 次自动 blocked）是两层，互不替代。
 */

import { describe, expect, it } from 'vitest'

import { TaskLedger, type LedgerFile, type LedgerPersistence } from '../src/host/ledger/store.ts'
import { SessionBridge, type SessionBridgeHost } from '../src/host/bridge/sessions.ts'
import { AnswerRelay, ROUTER_QUESTION_BATCH_EXHAUSTED_ANSWER } from '../src/host/bridge/questions.ts'
import { DispatchBudgets } from '../src/host/guard/budgets.ts'
import { guardCoreWith } from './helpers/guard-core.ts'
import { task } from './helpers/task-builder.ts'

const INPUT = {
  title: '修登录',
  goal: '登录不再 500',
  acceptance: ['回归通过'],
  role: 'worker' as const,
  templateId: 'coder',
}

/* ────────────────────────── 预算单元 ────────────────────────── */

describe('DispatchBudgets：每轮任务与提问预算（规格 §3 硬限）', () => {
  it('Router 每轮 1 个任务：第二个被拒 per-turn-task-budget；提问批次同形', () => {
    const budgets = new DispatchBudgets()
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: true })
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: false, code: 'per-turn-task-budget' })
    expect(budgets!.tryConsumeQuestionBatch('router-s-1')).toEqual({ ok: true })
    expect(budgets!.tryConsumeQuestionBatch('router-s-1')).toEqual({ ok: false, code: 'per-turn-question-budget' })
  })

  it('轮开始清零：ask_user 的回答开启新轮（running→true），任务与提问预算重计', () => {
    const budgets = new DispatchBudgets()
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: true })
    expect(budgets!.tryConsumeQuestionBatch('router-s-1')).toEqual({ ok: true })
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: false, code: 'per-turn-task-budget' })
    // 用户确认（视为新指令）→ 新轮 → 清零重计
    budgets!.onTurnStart('router-s-1')
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: true })
    expect(budgets!.tryConsumeQuestionBatch('router-s-1')).toEqual({ ok: true })
  })

  it('不同会话的预算互不影响', () => {
    const budgets = new DispatchBudgets()
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: true })
    expect(budgets!.tryConsumeTaskDispatch('router-s-2')).toEqual({ ok: true })
  })
})

describe('DispatchBudgets：主管失败预算（规格 §3）', () => {
  it('连续 3 次派发失败冻结（infra 或 task 均计）；新轮解除', () => {
    const budgets = new DispatchBudgets()
    budgets!.recordDispatchFailure('sup-s-1')
    budgets!.recordDispatchFailure('sup-s-1')
    expect(budgets!.supervisorFrozen('sup-s-1')).toBe(false)
    budgets!.recordDispatchFailure('sup-s-1')
    expect(budgets!.supervisorFrozen('sup-s-1')).toBe(true)
    // 新轮（如用户应答后）解除
    budgets!.onTurnStart('sup-s-1')
    expect(budgets!.supervisorFrozen('sup-s-1')).toBe(false)
  })

  it('成功派发清零连续失败计数：2 败 + 成功 + 2 败不冻（成功子任务不设上限）', () => {
    const budgets = new DispatchBudgets()
    budgets!.recordDispatchFailure('sup-s-1')
    budgets!.recordDispatchFailure('sup-s-1')
    budgets!.recordDispatchSuccess('sup-s-1')
    budgets!.recordDispatchFailure('sup-s-1')
    budgets!.recordDispatchFailure('sup-s-1')
    expect(budgets!.supervisorFrozen('sup-s-1')).toBe(false)
    budgets!.recordDispatchFailure('sup-s-1')
    expect(budgets!.supervisorFrozen('sup-s-1')).toBe(true)
  })

  it('冻结按会话隔离：sup-s-1 冻结不影响 sup-s-2', () => {
    const budgets = new DispatchBudgets()
    for (let i = 0; i < 3; i += 1) budgets!.recordDispatchFailure('sup-s-1')
    expect(budgets!.supervisorFrozen('sup-s-1')).toBe(true)
    expect(budgets!.supervisorFrozen('sup-s-2')).toBe(false)
  })

  it('snapshot：模型可见投影的形状（计数、上限、冻结态）', () => {
    const budgets = new DispatchBudgets()
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: true })
    budgets!.recordDispatchFailure('sup-s-1')
    expect(budgets!.snapshot('router-s-1')).toEqual({
      taskDispatchesThisTurn: 1,
      taskLimitPerTurn: 1,
      questionBatchesThisTurn: 0,
      questionLimitPerTurn: 1,
      consecutiveDispatchFailures: 0,
      supervisorFailureLimit: 3,
      supervisorFrozen: false,
    })
    expect(budgets!.snapshot('sup-s-1')).toMatchObject({ consecutiveDispatchFailures: 1, supervisorFrozen: false })
  })
})

/* ────────────────────────── 轮次接线：running→true 即新轮 ────────────────────────── */

describe('轮次边界接线：bridge watchStatus 的 running→true 映射 onTurnStart', () => {
  it('会话开跑（新轮）后预算清零重计', () => {
    const budgets = new DispatchBudgets()
    let statusListener: ((sessionId: string, running: boolean) => void) | undefined
    const host: SessionBridgeHost = {
      async create() {
        return 'unused'
      },
      async prompt() {
        return {}
      },
      onStatus(callback) {
        statusListener = callback
      },
    }
    const bridge = new SessionBridge({
      // 这两个用例不触达账本写路径；形状对齐 TaskLedger 的 Pick 面即可。
      ledger: {
        get: () => undefined,
        transition: (async () => undefined) as never,
        attachSession: (async () => undefined) as never,
      },
      docsFor: () => {
        throw new Error('unused')
      },
      host,
      presets: { supervisor: 'sup', worker: 'worker' },
      workerInstructions: () => '',
    })
    bridge.watchStatus()
    bridge.onStatusChange((sessionId, running) => {
      if (running) budgets!.onTurnStart(sessionId)
    })
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: true })
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: false, code: 'per-turn-task-budget' })
    // ask_user 的回答送达 → 会话重新开跑（running→true）→ 新轮
    statusListener!('router-s-1', true)
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: true })
  })

  it('idle（running→false）不清预算：轮次在下一轮开跑时才翻页', () => {
    const budgets = new DispatchBudgets()
    let statusListener: ((sessionId: string, running: boolean) => void) | undefined
    const host: SessionBridgeHost = {
      async create() {
        return 'unused'
      },
      async prompt() {
        return {}
      },
      onStatus(callback) {
        statusListener = callback
      },
    }
    const bridge = new SessionBridge({
      ledger: {
        get: () => undefined,
        transition: (async () => undefined) as never,
        attachSession: (async () => undefined) as never,
      },
      docsFor: () => {
        throw new Error('unused')
      },
      host,
      presets: { supervisor: 'sup', worker: 'worker' },
      workerInstructions: () => '',
    })
    bridge.watchStatus()
    bridge.onStatusChange((sessionId, running) => {
      if (running) budgets!.onTurnStart(sessionId)
    })
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: true })
    statusListener!('router-s-1', false)
    expect(budgets!.tryConsumeTaskDispatch('router-s-1')).toEqual({ ok: false, code: 'per-turn-task-budget' })
  })
})

/* ────────────────────────── Router 提问预算：认领层强制 ────────────────────────── */

class MemoryPersistence implements LedgerPersistence {
  file: LedgerFile | null = null
  async load() {
    return this.file
  }
  async save(f: LedgerFile) {
    this.file = JSON.parse(JSON.stringify(f)) as LedgerFile
  }
}

async function relayWith(opts: { withRouterQuestions?: boolean } = {}) {
  const records = [
    task({ id: 'T-001', role: 'worker', sessionId: 'worker-s-1', status: 'running' }),
    task({ id: 'T-003', role: 'router', sessionId: 'router-s-1', status: 'running' }),
  ]
  const persistence = new MemoryPersistence()
  persistence.file = { schemaVersion: 1, tasks: records, nextTaskNumber: records.length + 1, questions: [] }
  const ledger = new TaskLedger(persistence, () => 1000)
  await ledger.listAll()
  const budgets = new DispatchBudgets()
  const relay = new AnswerRelay({
    ledger,
    newId: (() => {
      let seq = 0
      return () => `q-${String(++seq).padStart(3, '0')}`
    })(),
    now: () => 1000,
    ...(opts.withRouterQuestions === false
      ? {}
      : {
          routerQuestions: {
            isRouterSession: (sessionId: string) => sessionId === 'router-s-1',
            tryConsumeQuestionBatch: (sessionId: string) => budgets!.tryConsumeQuestionBatch(sessionId),
          },
        }),
  })
  return { ledger, relay, budgets }
}

describe('AnswerRelay：Router 提问每轮 1 批（认领层自动回答）', () => {
  it('第一批放行（走客户端兜底 UI），不 park、不落账', async () => {
    const { relay, budgets } = await relayWith()
    let nextCalled = false
    const outcome = await relay.claimQuestion(
      { questions: [{ id: 'a1', question: '要不要拆两步？' }], agent: { id: 'router-s-1' } },
      async () => {
        nextCalled = true
        return 'passed-through'
      },
    )
    expect(nextCalled).toBe(true)
    expect(outcome).toBe('passed-through')
    expect(relay.pendingCards()).toEqual([])
    expect(budgets!.snapshot('router-s-1').questionBatchesThisTurn).toBe(1)
  })

  it('第二批自动回「请合并为一批重问」：不 park、不弹卡、不动账本', async () => {
    const { relay, ledger, budgets } = await relayWith()
    await relay.claimQuestion(
      { questions: [{ id: 'a1', question: '第一批？' }], agent: { id: 'router-s-1' } },
      async () => 'passed-through',
    )
    let nextCalled = false
    const outcome = (await relay.claimQuestion(
      { questions: [{ id: 'a2', question: '第二批？' }], agent: { id: 'router-s-1' } },
      async () => {
        nextCalled = true
        return 'passed-through'
      },
    )) as { answers: { id: string; selected: string[]; custom?: string }[] }
    expect(nextCalled).toBe(false)
    expect(outcome.answers).toEqual([{ id: 'a2', selected: [], custom: ROUTER_QUESTION_BATCH_EXHAUSTED_ANSWER }])
    expect(outcome.answers[0]!.custom).toContain('请合并为一批重问')
    expect(relay.pendingCards()).toEqual([])
    expect(await ledger.openQuestions()).toEqual([])
    expect(budgets!.snapshot('router-s-1').questionBatchesThisTurn).toBe(1)
  })

  it('新轮后 Router 又可提一批（ask_user 回答开启新轮，自然重计）', async () => {
    const { relay, budgets } = await relayWith()
    await relay.claimQuestion(
      { questions: [{ id: 'a1', question: '第一批？' }], agent: { id: 'router-s-1' } },
      async () => 'passed-through',
    )
    budgets!.onTurnStart('router-s-1')
    let nextCalled = false
    await relay.claimQuestion(
      { questions: [{ id: 'a2', question: '新轮第一批？' }], agent: { id: 'router-s-1' } },
      async () => {
        nextCalled = true
        return 'passed-through'
      },
    )
    expect(nextCalled).toBe(true)
  })

  it('worker 提问照旧 park（v1.1 每任务预算不受影响）', async () => {
    const { relay } = await relayWith()
    const claim = relay.claimQuestion(
      { questions: [{ id: 'w1', question: '缺哪个依赖？' }], agent: { id: 'worker-s-1' } },
      async () => 'passed-through',
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(relay.pendingCards()).toHaveLength(1)
    expect(relay.pendingCards()[0]!.taskId).toBe('T-001')
    await relay.answerQuestion(relay.pendingCards()[0]!.questionId, [{ id: 'w1', selected: [] }])
    await expect(claim).resolves.toEqual({ answers: [{ id: 'w1', selected: [] }] })
  })

  it('未接预算面时 Router 提问照旧放行（降级兼容）', async () => {
    const { relay } = await relayWith({ withRouterQuestions: false })
    let nextCalled = false
    await relay.claimQuestion(
      { questions: [{ id: 'a1', question: '第一批？' }], agent: { id: 'router-s-1' } },
      async () => {
        nextCalled = true
        return 'passed-through'
      },
    )
    expect(nextCalled).toBe(true)
  })
})

/* ────────────────────────── 核心挂接：派发与查询 ────────────────────────── */

describe('RouterCore ×预算：dispatch_task 与 query_tasks', () => {
  it('Router 同轮第二个任务被拒 per-turn-task-budget，文案指明 ask_user 出路；新轮放行', async () => {
    const { core, budgets } = await guardCoreWith()
    await core.dispatchTask('router-s-1', { ...INPUT, title: '第一个' })
    await expect(core.dispatchTask('router-s-1', { ...INPUT, title: '第二个' })).rejects.toMatchObject({
      code: 'per-turn-task-budget',
      message: expect.stringContaining('ask_user'),
    })
    // 用户经 ask_user 确认（视为新指令）→ 新轮 → 预算重计
    budgets!.onTurnStart('router-s-1')
    const third = await core.dispatchTask('router-s-1', { ...INPUT, title: '确认后的第二个' })
    expect(third.taskId).toBe('T-002')
  })

  it('主管同轮连派多个任务不受每轮预算限制（合法并行拆解不误伤）', async () => {
    const records = [task({ id: 'T-100', role: 'supervisor', sessionId: 'sup-s-1', status: 'running' })]
    const { core, budgets } = await guardCoreWith({ records })
    for (let i = 0; i < 3; i += 1) {
      const result = await core.dispatchTask('sup-s-1', { ...INPUT, title: `子任务 ${i + 1}` })
      expect(result.sessionId).toBe(`session-${i + 1}`)
    }
    expect(budgets!.snapshot('sup-s-1').taskDispatchesThisTurn).toBe(0) // 主管不进每轮任务预算
  })

  it('主管连续 3 次派发失败冻结：第 4 次被拒 supervisor-failure-budget，文案指明 report_blocker 出路', async () => {
    const records = [task({ id: 'T-100', role: 'supervisor', sessionId: 'sup-s-1', status: 'running' })]
    // 关掉熔断器，隔离「infra×3 全局冻结」与本预算（两层并存，互不抢答）
    const { core, budgets } = await guardCoreWith({ records, breaker: null, failCreate: () => new Error('boom') })
    for (let i = 0; i < 3; i += 1) {
      await expect(core.dispatchTask('sup-s-1', { ...INPUT, title: `子任务 ${i + 1}` })).rejects.toMatchObject({
        code: 'dispatch-failed',
      })
    }
    expect(budgets!.supervisorFrozen('sup-s-1')).toBe(true)
    await expect(core.dispatchTask('sup-s-1', { ...INPUT, title: '再试' })).rejects.toMatchObject({
      code: 'supervisor-failure-budget',
      message: expect.stringContaining('report_blocker'),
    })
    await expect(core.dispatchTask('sup-s-1', { ...INPUT })).rejects.toThrowError(/停止重试/)
  })

  it('主管失败后成功派发清零计数：2 败 + 成功 + 2 败仍可派（成功子任务不设上限）', async () => {
    const records = [task({ id: 'T-100', role: 'supervisor', sessionId: 'sup-s-1', status: 'running' })]
    const { core, budgets } = await guardCoreWith({
      records,
      breaker: null,
      failCreate: (attempt) => (attempt === 1 || attempt === 2 || attempt === 4 || attempt === 5 ? new Error('boom') : undefined),
    })
    await expect(core.dispatchTask('sup-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    await expect(core.dispatchTask('sup-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    const ok1 = await core.dispatchTask('sup-s-1', { ...INPUT }) // 成功清零
    expect(ok1.sessionId).toBe('session-1')
    await expect(core.dispatchTask('sup-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    await expect(core.dispatchTask('sup-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    expect(budgets!.supervisorFrozen('sup-s-1')).toBe(false)
    const ok2 = await core.dispatchTask('sup-s-1', { ...INPUT })
    expect(ok2.sessionId).toBe('session-2')
    expect(budgets!.snapshot('sup-s-1').consecutiveDispatchFailures).toBe(0)
  })

  it('派发失败计入调用者失败预算：Router 连败不动主管冻结', async () => {
    const { core, budgets } = await guardCoreWith({ failCreate: () => new Error('boom') })
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    expect(budgets!.snapshot('router-s-1').consecutiveDispatchFailures).toBe(1)
    expect(budgets!.snapshot('sup-s-1').consecutiveDispatchFailures).toBe(0)
  })

  it('queryTasks 附 budgets 与 breaker（模型可见）：冻结后 reason 随附', async () => {
    const { core, budgets, breaker } = await guardCoreWith()
    await core.dispatchTask('router-s-1', { ...INPUT })
    const view = await core.queryTasks(undefined, 'router-s-1')
    expect(view.budgets).toMatchObject({ taskDispatchesThisTurn: 1, taskLimitPerTurn: 1, supervisorFrozen: false })
    expect(view.breaker).toEqual({ frozen: false })
    for (let i = 0; i < 3; i += 1) budgets!.recordDispatchFailure('sup-s-1')
    await breaker!.freeze('用户紧急暂停')
    const frozen = await core.queryTasks({ status: ['draft', 'dispatched', 'queued'] }, 'sup-s-1')
    expect(frozen.breaker).toMatchObject({ frozen: true, reason: '用户紧急暂停' })
    expect(frozen.budgets).toMatchObject({ supervisorFrozen: true })
    // 输出无 undefined 值键（lossless）：reason/frozenAt 只在冻结时出现
    expect(Object.keys(frozen.breaker!)).toEqual(['frozen', 'reason', 'frozenAt'])
    expect((await core.queryTasks(undefined, 'router-s-1')).tasks.length).toBeGreaterThan(0)
  })

  it('未传 viewer 会话时不附 budgets（breaker 全局态仍随附）', async () => {
    const { core } = await guardCoreWith()
    const view = await core.queryTasks()
    expect(view.budgets).toBeUndefined()
    expect(view.breaker).toEqual({ frozen: false })
  })
})

/* ────────────────────────── 与 v1.1 失败语义的衔接 ────────────────────────── */

describe('预算 ×熔断共存：检查顺序与分层', () => {
  it('全局冻结先于每轮预算：两者都触发时拒绝码是 dispatch-frozen（冻结拦一切派发）', async () => {
    const { core, breaker } = await guardCoreWith()
    await core.dispatchTask('router-s-1', { ...INPUT }) // 消耗本轮任务预算
    await breaker!.freeze('用户紧急暂停')
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-frozen' })
    await breaker!.unfreeze()
    // 解除后同一轮的预算拒绝重新可见（两层各管各的）
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'per-turn-task-budget' })
  })
})

describe('预算 ×既有失败语义：两层不互相替代', () => {
  it('预算拒绝不产生任务记录、不动 retryCount（v1.1 的 3 次自动 blocked 只数真实派发失败）', async () => {
    const { core, ledger } = await guardCoreWith()
    await core.dispatchTask('router-s-1', { ...INPUT })
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'per-turn-task-budget' })
    const records = await ledger.listAll()
    expect(records).toHaveLength(1) // 只有第一个任务（拒绝发生在创建之前）
    expect(records[0]!.retryCount).toBe(0) // 预算拒绝不碰 per-task 计数
  })

  it('每轮预算拒绝发生在角色守卫之后：worker 角色仍被 role-forbidden 拒', async () => {
    const records = [task({ id: 'T-100', role: 'worker', sessionId: 'worker-s-1', status: 'running' })]
    const { core } = await guardCoreWith({ records })
    await expect(core.dispatchTask('worker-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'role-forbidden' })
  })

  it('基础设施故障仍按 v1.1 记账（retryCount/progress/draft 不变），同时冻结主管——两层并存', async () => {
    const records = [task({ id: 'T-100', role: 'supervisor', sessionId: 'sup-s-1', status: 'running' })]
    const { core, ledger, budgets } = await guardCoreWith({ records, breaker: null, failCreate: () => new Error('boom') })
    for (let i = 0; i < 3; i += 1) {
      await expect(core.dispatchTask('sup-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    }
    // v1.1 层：每个任务各记一次失败（rc=1、错误落 progress、任务保持 draft）——
    // 连续派发是三个独立任务，v1.1 的 3 次封顶只在同一任务重试时触发（不动）。
    const created = (await ledger.listAll()).filter((record) => record.id !== 'T-100')
    expect(created).toHaveLength(3)
    for (const record of created) {
      expect(record.retryCount).toBe(1)
      expect(record.status).toBe('draft')
      expect(record.progress).toContain('boom')
    }
    // v1.2 层：主管失败预算（跨任务连败）同点冻结
    expect(budgets!.supervisorFrozen('sup-s-1')).toBe(true)
  })
})
