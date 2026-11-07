/**
 * 缓存命中观测测试（v1.3 计划 Task C1，规格 §4，取证 r11）。
 *
 * 三块：
 * 1. FirstRequestCacheObserver：假 session/event 流——任务会话首条
 *    assistant/message 的 data.usage.cacheReadTokens 记入账本任务；仅首条
 *    （一次性标记）；无字段降级（未上报 = 不写）；非任务会话忽略；
 *    非 assistant/message 事件不消耗首条标记；观察失败自包含不外抛。
 * 2. TaskCard.firstRequestCacheReadTokens 投影：有值才进卡（lossless：
 *    undefined 的键不得出现在 JSON 投影里）。
 * 3. 完成卡摘要可选行：已上报的任务带「首请求缓存命中 X tok」，未上报不带。
 */

import { describe, expect, it } from 'vitest'

import { TaskLedger, type LedgerFile, type LedgerPersistence } from '../src/host/ledger/store.ts'
import { FirstRequestCacheObserver } from '../src/host/observability.ts'
import { guardCoreWith } from './helpers/guard-core.ts'
import type { NotificationSink } from '../src/host/guard/notifications.ts'
import type { NotificationCard } from '../src/shared/view-contract.ts'
import type { TaskRecord } from '../src/shared/types.ts'

/* ────────────────────────── 假件与工具 ────────────────────────── */

class MemoryPersistence implements LedgerPersistence {
  file: LedgerFile | null = null
  async load(): Promise<LedgerFile | null> {
    return this.file === null ? null : structuredClone(this.file)
  }
  async save(f: LedgerFile): Promise<void> {
    this.file = structuredClone(f)
  }
}

/** 建一个绑定了 worker 会话的任务的账本（已 attachSession）。 */
async function ledgerWithTask(sessionId: string): Promise<{ ledger: TaskLedger; taskId: string }> {
  const ledger = new TaskLedger(new MemoryPersistence())
  const created = await ledger.createTask({
    title: '观测目标',
    goal: '达成',
    projectId: 'cwd:/proj',
    cwd: '/proj',
    role: 'worker',
    dependsOn: [],
    acceptancePolicy: 'auto',
  })
  await ledger.transition(created.id, 'queued')
  await ledger.attachSession(created.id, sessionId)
  return { ledger, taskId: created.id }
}

/** 一条 assistant/message 落账事件（usage 可缺席 = 适配器不回缓存字段）。 */
function assistantMessage(seq: number, usage?: Record<string, unknown>): { type: string; seq: number; time: number; data: Record<string, unknown> } {
  return {
    type: 'assistant/message',
    seq,
    time: 1793960511364 + seq,
    data: {
      turn: 1,
      step: seq,
      message: { role: 'assistant', content: [], id: `m-${seq}` },
      ...(usage !== undefined ? { usage } : {}),
    },
  }
}

function userMessage(seq: number): { type: string; seq: number; time: number; data: Record<string, unknown> } {
  return { type: 'user/message', seq, time: 1793960511000 + seq, data: { content: '干活' } }
}

/* ────────────────────────── 1. FirstRequestCacheObserver ────────────────────────── */

describe('FirstRequestCacheObserver：假 session/event 流（v1.3 C1，r11）', () => {
  it('首条记录：任务会话第一条 assistant/message 的 cacheReadTokens 记入任务', async () => {
    const { ledger, taskId } = await ledgerWithTask('session-1')
    const warns: string[] = []
    const observer = new FirstRequestCacheObserver({ ledger, logger: { warn: (m) => warns.push(m) } })

    const session = { id: 'session-1' }
    await observer.onSessionEvent(session, assistantMessage(16, { inputTokens: 8272, outputTokens: 5127, cacheReadTokens: 5632 }))

    expect(ledger.get(taskId)?.firstRequestCacheReadTokens).toBe(5632)
    expect(warns).toEqual([])
  })

  it('仅首条：后续 assistant/message 的命中量不覆盖首条记录', async () => {
    const { ledger, taskId } = await ledgerWithTask('session-1')
    const observer = new FirstRequestCacheObserver({ ledger })
    const session = { id: 'session-1' }

    await observer.onSessionEvent(session, assistantMessage(16, { cacheReadTokens: 5632 }))
    await observer.onSessionEvent(session, assistantMessage(17, { cacheReadTokens: 99999 }))
    await observer.onSessionEvent(session, assistantMessage(18, { cacheReadTokens: 0 }))

    expect(ledger.get(taskId)?.firstRequestCacheReadTokens).toBe(5632)
  })

  it('无字段降级：首条不回 cacheReadTokens → 投影 undefined（未上报），且首条标记已消耗（后续不补记）', async () => {
    const { ledger, taskId } = await ledgerWithTask('session-1')
    const observer = new FirstRequestCacheObserver({ ledger })
    const session = { id: 'session-1' }

    // 首条无 usage（自定义网关不回缓存字段，r11 §5）
    await observer.onSessionEvent(session, assistantMessage(15))
    expect(ledger.get(taskId)?.firstRequestCacheReadTokens).toBeUndefined()
    expect('firstRequestCacheReadTokens' in (ledger.get(taskId) as TaskRecord)).toBe(false)

    // 后续即使回数也不补记（首请求没上报就是未上报）
    await observer.onSessionEvent(session, assistantMessage(16, { cacheReadTokens: 777 }))
    expect(ledger.get(taskId)?.firstRequestCacheReadTokens).toBeUndefined()
  })

  it('非任务会话忽略：不记录、不抛错；该会话之后绑定任务时，绑定后的首条 assistant/message 正常记入', async () => {
    const ledger = new TaskLedger(new MemoryPersistence())
    const observer = new FirstRequestCacheObserver({ ledger })

    // 尚未绑定任何任务的普通会话
    await observer.onSessionEvent({ id: 'chat-9' }, assistantMessage(1, { cacheReadTokens: 12345 }))
    for (const record of await ledger.listAll()) {
      expect(record.firstRequestCacheReadTokens).toBeUndefined()
    }

    // 之后这个会话被绑定为任务会话（真实时序：attach 先于 prompt，但绑定晚于
    // 无关事件也不该丢真正的首条）
    const created = await ledger.createTask({
      title: '晚绑定',
      goal: '达成',
      projectId: 'cwd:/proj',
      cwd: '/proj',
      role: 'worker',
      dependsOn: [],
      acceptancePolicy: 'auto',
    })
    await ledger.attachSession(created.id, 'chat-9')
    await observer.onSessionEvent({ id: 'chat-9' }, assistantMessage(2, { cacheReadTokens: 4321 }))
    expect(ledger.get(created.id)?.firstRequestCacheReadTokens).toBe(4321)
  })

  it('非 assistant/message 事件不消耗首条标记：user/message 在前不影响首条 assistant/message 记入', async () => {
    const { ledger, taskId } = await ledgerWithTask('session-1')
    const observer = new FirstRequestCacheObserver({ ledger })
    const session = { id: 'session-1' }

    await observer.onSessionEvent(session, userMessage(10))
    await observer.onSessionEvent(session, assistantMessage(16, { cacheReadTokens: 5632 }))
    expect(ledger.get(taskId)?.firstRequestCacheReadTokens).toBe(5632)
  })

  it('cacheReadTokens 为 0 也如实记录（最小面模式命中=0 是验收证据，规格 §4）', async () => {
    const { ledger, taskId } = await ledgerWithTask('session-1')
    const observer = new FirstRequestCacheObserver({ ledger })

    await observer.onSessionEvent({ id: 'session-1' }, assistantMessage(16, { cacheReadTokens: 0 }))
    expect(ledger.get(taskId)?.firstRequestCacheReadTokens).toBe(0)
  })

  it('观察失败自包含：账本写失败时 warn 落日志、不外抛（fire-and-forget 监听不炸宿主）', async () => {
    const { ledger } = await ledgerWithTask('session-1')
    const warns: string[] = []
    const observer = new FirstRequestCacheObserver({
      ledger: {
        listAll: () => ledger.listAll(),
        recordFirstCacheRead: async () => {
          throw new Error('disk full')
        },
      },
      logger: { warn: (m) => warns.push(m) },
    })

    await expect(
      observer.onSessionEvent({ id: 'session-1' }, assistantMessage(16, { cacheReadTokens: 5632 })),
    ).resolves.toBeUndefined()
    expect(warns.join(' ')).toContain('disk full')
  })

  it('形状防御：session 无 id / 事件非对象 → 静默忽略', async () => {
    const { ledger, taskId } = await ledgerWithTask('session-1')
    const observer = new FirstRequestCacheObserver({ ledger })

    await expect(observer.onSessionEvent(undefined, assistantMessage(1, { cacheReadTokens: 5 }))).resolves.toBeUndefined()
    await expect(observer.onSessionEvent({ header: { id: 'session-1' } }, assistantMessage(2, { cacheReadTokens: 5 }))).resolves.toBeUndefined()
    await expect(observer.onSessionEvent({ id: 'session-1' }, undefined)).resolves.toBeUndefined()
    await expect(observer.onSessionEvent({ id: 'session-1' }, { type: 'assistant/message', data: 'not-object' })).resolves.toBeUndefined()
    expect(ledger.get(taskId)?.firstRequestCacheReadTokens).toBeUndefined()
  })
})

/* ────────────────────────── 2. TaskCard 投影 + 3. 完成卡可选行 ────────────────────────── */

/** 记录型通知 sink：capture push 的输入（完成卡摘要断言用）。 */
function captureSink(): NotificationSink & { pushed: Array<{ kind: string; taskId?: string; title: string; summary: string }> } {
  const pushed: Array<{ kind: string; taskId?: string; title: string; summary: string }> = []
  return {
    pushed,
    async push(input) {
      pushed.push({ kind: input.kind, ...(input.taskId !== undefined ? { taskId: input.taskId } : {}), title: input.title, summary: input.summary })
      const card: NotificationCard = { cardId: `card-${pushed.length}`, kind: input.kind, ...(input.taskId !== undefined ? { taskId: input.taskId } : {}), title: input.title, summary: input.summary, actions: [...input.actions], at: 1, ack: false }
      return card
    },
    async pending() {
      return []
    },
    async list() {
      return []
    },
    async ack() {
      return true
    },
  }
}

async function dispatchWorkerTask(h: Awaited<ReturnType<typeof guardCoreWith>>, title: string): Promise<{ taskId: string; sessionId: string }> {
  const result = await h.core.dispatchTask('router-s-1', {
    title,
    goal: '把事情做完',
    acceptance: ['完成'],
    role: 'worker',
    templateId: 'coder',
  })
  return { taskId: result.taskId, sessionId: result.sessionId ?? '' }
}

describe('TaskCard.firstRequestCacheReadTokens 投影（v1.3 C1，lossless）', () => {
  it('已上报的任务带字段；未上报的任务无该键（undefined 不进投影）', async () => {
    // budgets 关闭：同一调用轮里要连派两个任务构造「已上报/未上报」对照
    const h = await guardCoreWith({ budgets: null })
    const reported = await dispatchWorkerTask(h, '已上报命中')
    await h.ledger.recordFirstCacheRead(reported.taskId, 800)
    const unreported = await dispatchWorkerTask(h, '未上报')

    const state = await h.workbench.state('ws-1')
    const reportedCard = state.tasks.find((card) => card.taskId === reported.taskId)
    const unreportedCard = state.tasks.find((card) => card.taskId === unreported.taskId)
    expect(reportedCard?.firstRequestCacheReadTokens).toBe(800)
    expect(unreportedCard).toBeDefined()
    expect('firstRequestCacheReadTokens' in unreportedCard!).toBe(false)
  })
})

describe('完成卡摘要可选行「首请求缓存命中 X tok」（v1.3 C1）', () => {
  it('已上报：完成卡 summary 追加一行；未上报：不带该行', async () => {
    const sink = captureSink()
    // budgets 关闭：同一调用轮里要连派两个任务构造「已上报/未上报」对照
    const h = await guardCoreWith({ notifications: sink, budgets: null })
    const withHit = await dispatchWorkerTask(h, '带命中的活')
    await h.ledger.recordFirstCacheRead(withHit.taskId, 800)
    await h.ledger.transition(withHit.taskId, 'running')
    await h.core.completeTask(withHit.sessionId, withHit.taskId, { docVersion: 1, summary: '搞定' })

    const plain = await dispatchWorkerTask(h, '没上报的活')
    await h.ledger.transition(plain.taskId, 'running')
    await h.core.completeTask(plain.sessionId, plain.taskId, { docVersion: 1, summary: '也搞定' })

    expect(sink.pushed).toHaveLength(2)
    expect(sink.pushed[0]!.summary).toContain('首请求缓存命中 800 tok')
    // 原始摘要保留（不动既有卡结构语义，只追加可选行）
    expect(sink.pushed[0]!.summary).toContain('搞定')
    expect(sink.pushed[1]!.summary).not.toContain('首请求缓存命中')
    expect(sink.pushed[1]!.summary).toBe('也搞定')
  })
})
