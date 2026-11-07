/**
 * v1.2 Task B3：事件驱动结果判定（规格 §4）。
 *
 * 钉住的语义（r7/r9 取证结论落地）：
 * - 触发：bridge watchStatus 的 running→false 沿 + 400ms 去抖（翻回 running 取消，
 *   吸收唤醒翻抖）；watched 集合 = 账本中 dispatched|running 任务的会话。
 * - 豁免链（任一命中不动作）：任务不在 dispatched|running；本任务有已认领待答
 *   问题（自家问题库，pendingInput 不可信）；点读（projectionMode:'none'）末轮
 *   reason.kind!=='completed'；零步空轮（无 assistant/message）；桌面 pendingInput
 *   含 question/approval；CLI 老宿主用 agents.get(id)?.status 兜底。
 * - 第一级 injectClosurePrompt：requestId=closure-<taskId>-<seq>（写前意图账，
 *   重试沿用同 requestId）；文本自报「系统收尾提醒」；错误四码分治。
 * - 第二级 judgeOutcome 三态：completed→completeTask(deliveryOrigin='system-judged')
 *   + 完成卡；partial|failed→blocked + 异常卡；判定失败→blocked「判定不可用」。
 * - 兜底定时器：firstResponseTimeoutMs（默认 10min）/ adjudicationWallClockMs
 *   （默认 30min）走同一判定入口，状态机防双跑；每任务每周期提醒一次。
 */

import { describe, expect, it } from 'vitest'

import { TaskLedger, type LedgerFile, type LedgerPersistence } from '../src/host/ledger/store.ts'
import {
  ClosureIntentStore,
  DEFAULT_ADJUDICATION_WALL_CLOCK_MS,
  DEFAULT_CLOSURE_DEBOUNCE_MS,
  DEFAULT_FIRST_RESPONSE_TIMEOUT_MS,
  OutcomeAdjudicator,
  type OutcomeAdjudicatorDeps,
  type SessionObservation,
} from '../src/host/guard/adjudicator.ts'
import { NotificationStore, anomalyActions, completionActions } from '../src/host/guard/notifications.ts'
import { judgeOutcome, parseOutcomeJudgement } from '../src/host/memory/adapter.ts'
import type { SummaryLlm } from '../src/host/memory/summarizer.ts'
import { makeMemFs, type MemFs } from './helpers/mem-fs.ts'
import { guardCoreWith } from './helpers/guard-core.ts'
import { task } from './helpers/task-builder.ts'
import type { TaskRecord } from '../src/shared/types.ts'
import type { NotificationCard, NotificationSink } from '../src/shared/view-contract.ts'
import { SessionBridge, type SessionBridgeHost } from '../src/host/bridge/sessions.ts'
import { registerRouterRoutes, type RouterRoutesContext, type RouterRoutesDeps } from '../src/host/routes.ts'

/* ────────────────────────── 假件与装配 ────────────────────────── */

function tickingClock(start = 1_000) {
  let t = start
  return {
    now: () => t,
    advance(delta: number) {
      t += delta
    },
  }
}

/** 手动定时器：测试按 delay 精确触发（去抖 400 / 首响 600_000 / 墙钟 1_800_000）。 */
function manualScheduler() {
  let seq = 0
  const pending = new Map<number, { delay: number; fn: () => void | Promise<void> }>()
  const schedule = (delayMs: number, fn: () => void | Promise<void>) => {
    const id = ++seq
    pending.set(id, { delay: delayMs, fn })
    return () => {
      pending.delete(id)
    }
  }
  const fireDelay = async (delay: number): Promise<void> => {
    const batch = [...pending.entries()].filter(([, timer]) => timer.delay === delay)
    for (const [id, timer] of batch) {
      pending.delete(id)
      await timer.fn()
    }
  }
  const delays = (): number[] => [...pending.values()].map((timer) => timer.delay).sort((a, b) => a - b)
  return { schedule, fireDelay, delays }
}

class MemoryPersistence implements LedgerPersistence {
  file: LedgerFile | null = null
  async load() {
    return this.file
  }
  async save(f: LedgerFile) {
    this.file = JSON.parse(JSON.stringify(f)) as LedgerFile
  }
}

const ev = (seq: number, type: string, data: unknown = {}) => ({ seq, type, data })

/** 一轮干完活但没调交付工具的 completed 轮（判定触发的标准样本）。 */
function workTurn(s: number, text = '已把登录 500 修复完成，测试全绿'): unknown[] {
  return [
    ev(s, 'turn/start', { turn: 1 }),
    ev(s + 1, 'user/message', { content: [{ type: 'text', text: '任务书' }] }),
    ev(s + 2, 'assistant/message', { message: { content: [{ type: 'text', text }] } }),
    ev(s + 3, 'step/end', {}),
    ev(s + 4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** 中断轮（aborted ≠ 完成输出，豁免）。 */
function abortedTurn(s: number): unknown[] {
  return [
    ev(s, 'turn/start', { turn: 1 }),
    ev(s + 1, 'assistant/message', { message: { content: [{ type: 'text', text: '干到一半' }] } }),
    ev(s + 2, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: '用户中断' } }),
  ]
}

/** 零步空轮（completed 但无 assistant/message，豁免）。 */
function emptyTurn(s: number): unknown[] {
  return [
    ev(s, 'turn/start', { turn: 1 }),
    ev(s + 1, 'user/message', { content: [{ type: 'text', text: '任务书' }] }),
    ev(s + 2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** 挂死轮（只有 start 与消息，没有 turn/end——首响超时的样本）。 */
function hungTurn(s: number): unknown[] {
  return [
    ev(s, 'turn/start', { turn: 1 }),
    ev(s + 1, 'user/message', { content: [{ type: 'text', text: '任务书' }] }),
    ev(s + 2, 'assistant/message', { message: { content: [{ type: 'text', text: '还在干' }] } }),
  ]
}

interface RecordedPrompt {
  requestId: string
  sessionId: string
  mode: string
  text: string
  /** prompt 调用时意图账文件内容（写前账的时序取证）。 */
  intentsAtCall: string | undefined
}

interface HarnessOptions {
  records?: TaskRecord[]
  logs?: Record<string, unknown[]>
  /** prompt 逐次失败（返回 undefined = 成功）。 */
  failPrompt?: (attempt: number) => Error | undefined
  llm?: (attempt: number) => Promise<string>
  sessionState?: (sessionId: string) => Promise<{ running?: boolean; pendingInput?: readonly string[] } | undefined> | undefined
  agentStatus?: string
  firstResponseTimeoutMs?: number
  adjudicationWallClockMs?: number
}

async function adjudicatorWith(opts: HarnessOptions = {}) {
  const memfs: MemFs = makeMemFs()
  await memfs.fs.mkdirp('/guard')
  const clock = tickingClock()
  const persistence = new MemoryPersistence()
  const records = opts.records ?? [task({ id: 'T-001', sessionId: 'session-9', status: 'dispatched' })]
  persistence.file = { schemaVersion: 1, tasks: records, nextTaskNumber: records.length + 1, questions: [] }
  const ledger = new TaskLedger(persistence, clock.now)
  await ledger.listAll()
  const intents = new ClosureIntentStore({ fs: memfs.fs, path: '/guard/closure-intents.json' })
  const notifications = new NotificationStore({
    fs: memfs.fs,
    path: '/guard/notifications.json',
    newId: () => `card-${notifications.seq + 1}`,
    now: clock.now,
  })

  const logs = new Map<string, unknown[]>(Object.entries(opts.logs ?? { 'session-9': workTurn(1) }))
  const pointReads: { sessionId: string; projectionMode?: unknown }[] = []
  const observeSession = async (sessionId: string, options?: { projectionMode?: 'none' }): Promise<SessionObservation> => {
    pointReads.push({ sessionId, projectionMode: options?.projectionMode })
    return { events: logs.get(sessionId) ?? [] }
  }

  const prompts: RecordedPrompt[] = []
  let promptAttempts = 0
  const prompt = async (request: { requestId: string; sessionId: string; mode: string; content: { type: 'text'; text: string }[] }) => {
    promptAttempts += 1
    const failure = opts.failPrompt?.(promptAttempts)
    if (failure !== undefined) throw failure
    prompts.push({
      requestId: request.requestId,
      sessionId: request.sessionId,
      mode: request.mode,
      text: request.content.map((block) => block.text).join('\n'),
      intentsAtCall: memfs.files.get('/guard/closure-intents.json'),
    })
    return { accepted: true }
  }

  let llmAttempts = 0
  const llm: SummaryLlm = {
    async stream() {
      llmAttempts += 1
      const produce = opts.llm ?? (async () => JSON.stringify({ verdict: 'completed', summary: '系统判定：登录 500 已修复，活已干完' }))
      return await produce(llmAttempts)
    },
  }

  const coreCalls = { completed: [] as unknown[], blocked: [] as unknown[] }
  const core = {
    async completeTask(callerSessionId: string, taskId: string, input: unknown) {
      coreCalls.completed.push({ callerSessionId, taskId, input })
      return { accepted: true, status: 'completed' }
    },
    async reportBlocker(callerSessionId: string, taskId: string, reason: string) {
      coreCalls.blocked.push({ callerSessionId, taskId, reason })
      return { status: 'blocked' }
    },
  }

  const incidents: { taskId: string; title: string; text: string }[] = []
  const timers = manualScheduler()
  const deps: OutcomeAdjudicatorDeps = {
    ledger,
    observeSession,
    prompt,
    ...(opts.sessionState !== undefined ? { sessionState: opts.sessionState } : {}),
    agentsGet: (sessionId: string) => (opts.agentStatus !== undefined ? { status: opts.agentStatus } : { status: 'idle' }),
    llm,
    core,
    intents,
    recordIncident: (input) => incidents.push(input),
    now: clock.now,
    schedule: timers.schedule,
    ...(opts.firstResponseTimeoutMs !== undefined ? { firstResponseTimeoutMs: opts.firstResponseTimeoutMs } : {}),
    ...(opts.adjudicationWallClockMs !== undefined ? { adjudicationWallClockMs: opts.adjudicationWallClockMs } : {}),
  }
  const adjudicator = new OutcomeAdjudicator(deps)
  return {
    adjudicator,
    ledger,
    prompts,
    pointReads,
    timers,
    clock,
    memfs,
    incidents,
    coreCalls,
    intents,
    notifications,
    llmAttempts: () => llmAttempts,
    promptAttempts: () => promptAttempts,
  }
}

/** 走完「第一级提醒」：turn-end → 去抖 → 注入收尾提醒（nudged）。 */
async function nudgeThrough(h: Awaited<ReturnType<typeof adjudicatorWith>>, sessionId = 'session-9') {
  h.adjudicator.onTurnEnd(sessionId)
  await h.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
}

/* ────────────────────────── ClosureIntentStore ────────────────────────── */

describe('ClosureIntentStore：写前意图账（r9 §3.2/§5.2）', () => {
  it('prepare 分配单调 seq，requestId=closure-<taskId>-<seq>；pending 同文本复用同 seq', async () => {
    const memfs = makeMemFs()
    await memfs.fs.mkdirp('/guard')
    const store = new ClosureIntentStore({ fs: memfs.fs, path: '/guard/closure-intents.json' })
    const first = await store.prepare('T-001', '提醒文本', 1000)
    expect(first.seq).toBe(1)
    expect(first.requestId).toBe('closure-T-001-1')
    // 未 markDelivered：同文本 prepare 复用（重试同 requestId）
    const retry = await store.prepare('T-001', '提醒文本', 1001)
    expect(retry.seq).toBe(1)
    expect(retry.requestId).toBe('closure-T-001-1')
    // 不同文本 → 新 seq（绝不复用旧 rpcId 撞掉新内容）
    const next = await store.prepare('T-001', '另一条提醒', 1002)
    expect(next.seq).toBe(2)
    // 交付后 → 新 seq
    await store.markDelivered('T-001', 1)
    const after = await store.prepare('T-001', '提醒文本', 1003)
    expect(after.seq).toBe(3)
    // 落盘形状：(taskId, seq, text) 先于投递存在
    const file = JSON.parse(memfs.files.get('/guard/closure-intents.json')!) as { intents: { taskId: string; seq: number; text: string }[] }
    expect(file.intents.some((intent) => intent.taskId === 'T-001' && intent.seq === 1 && intent.text === '提醒文本')).toBe(true)
  })

  it('宿主重启恢复：已落盘的 pending 意图跨实例复用同 requestId', async () => {
    const memfs = makeMemFs()
    await memfs.fs.mkdirp('/guard')
    const first = new ClosureIntentStore({ fs: memfs.fs, path: '/guard/closure-intents.json' })
    await first.prepare('T-001', '提醒文本', 1000)
    const restarted = new ClosureIntentStore({ fs: memfs.fs, path: '/guard/closure-intents.json' })
    const reused = await restarted.prepare('T-001', '提醒文本', 2000)
    expect(reused.requestId).toBe('closure-T-001-1')
  })
})

/* ────────────────────────── NotificationStore ────────────────────────── */

describe('NotificationStore：持久化通知存储（规格 §5 卡通道的宿主半边）', () => {
  it('push 落盘、list 新在前、pending 过滤 ack、ack 幂等返回', async () => {
    const memfs = makeMemFs()
    await memfs.fs.mkdirp('/guard')
    let seq = 0
    const store = new NotificationStore({ fs: memfs.fs, path: '/guard/notifications.json', newId: () => `card-${++seq}`, now: () => 1000 })
    const done = await store.push({
      kind: 'completion',
      taskId: 'T-001',
      title: 'T-001 示例任务',
      summary: '完成了',
      actions: completionActions(),
      deliveryOrigin: 'system-judged',
    })
    expect(done.cardId).toBe('card-1')
    expect(done.ack).toBe(false)
    expect(done.at).toBe(1000)
    const stuck = await store.push({ kind: 'anomaly', taskId: 'T-002', title: 'T-002 卡住', summary: '停滞', actions: anomalyActions() })
    // 新在前
    const all = await store.list()
    expect(all.map((card) => card.cardId)).toEqual(['card-2', 'card-1'])
    // ack 后移出 pending；再 ack 返回 false
    expect(await store.ack('card-1')).toBe(true)
    expect(await store.ack('card-1')).toBe(false)
    const pending = await store.pending()
    expect(pending.map((card) => card.cardId)).toEqual(['card-2'])
    expect((await store.list()).map((card) => card.cardId)).toEqual(['card-2', 'card-1'])
    expect(stuck.ack).toBe(false)
  })

  it('持久化恢复 + 修剪：新实例读出旧卡；超上限先丢最老的已读卡', async () => {
    const memfs = makeMemFs()
    await memfs.fs.mkdirp('/guard')
    let seq = 0
    const first = new NotificationStore({ fs: memfs.fs, path: '/guard/notifications.json', newId: () => `card-${++seq}`, now: () => 1000 })
    const keep = await first.push({ kind: 'anomaly', taskId: 'T-001', title: 't', summary: 's', actions: anomalyActions() })
    const old = await first.push({ kind: 'anomaly', taskId: 'T-002', title: 't', summary: 's', actions: anomalyActions() })
    await first.ack(old.cardId)
    const restarted = new NotificationStore({
      fs: memfs.fs,
      path: '/guard/notifications.json',
      newId: () => `card-${++seq}`,
      now: () => 1000,
      maxCards: 2,
    })
    expect((await restarted.pending()).map((card) => card.cardId)).toEqual([keep.cardId])
    await restarted.push({ kind: 'anomaly', taskId: 'T-003', title: 't', summary: 's', actions: anomalyActions() })
    await restarted.push({ kind: 'anomaly', taskId: 'T-004', title: 't', summary: 's', actions: anomalyActions() })
    const cards = await restarted.list()
    expect(cards.length).toBe(2)
    expect(cards.map((card) => card.taskId)).toEqual(['T-004', 'T-003']) // 最老的已读卡被修剪
  })
})

/* ────────────────────────── judgeOutcome（memory/adapter 摘要面） ────────────────────────── */

describe('judgeOutcome：独立总结判定（规格 §4 第二级）', () => {
  const events = workTurn(1)

  it('llm 返回合法 JSON → 三态判定 + 摘要', async () => {
    const llm: SummaryLlm = { async stream() {
      return JSON.stringify({ verdict: 'partial', summary: '还剩部署没做' })
    } }
    const verdict = await judgeOutcome('session-9', events, llm)
    expect(verdict).toEqual({ verdict: 'partial', summary: '还剩部署没做' })
  })

  it('不可解析 / 非法 verdict / 空白 → 抛错（判定不可用路径）', async () => {
    const bad: SummaryLlm = { async stream() {
      return '我觉得差不多完成了吧'
    } }
    await expect(judgeOutcome('session-9', events, bad)).rejects.toThrow()
    const illegal: SummaryLlm = { async stream() {
      return JSON.stringify({ verdict: 'fine', summary: 'x' })
    } }
    await expect(judgeOutcome('session-9', events, illegal)).rejects.toThrow()
    expect(() => parseOutcomeJudgement('')).toThrow()
  })

  it('无语义事件 → 抛错（无从判定）', async () => {
    const llm: SummaryLlm = { async stream() {
      return JSON.stringify({ verdict: 'completed', summary: 'x' })
    } }
    await expect(judgeOutcome('session-9', [], llm)).rejects.toThrow()
  })
})

/* ────────────────────────── OutcomeAdjudicator：触发与去抖 ────────────────────────── */

describe('OutcomeAdjudicator：触发与去抖（r7 §5.1/§5.2）', () => {
  it('running=false 后 400ms 去抖到期才动作；期间翻回 running 取消', async () => {
    const h = await adjudicatorWith()
    h.adjudicator.onTurnEnd('session-9')
    // 去抖窗口内：不动作
    expect(h.prompts).toHaveLength(0)
    // 翻回 running（新一轮开始）→ 取消
    h.adjudicator.onTurnStart('session-9')
    await h.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
    expect(h.prompts).toHaveLength(0)
    // 再次结束、没有翻回 → 去抖到期动作
    h.adjudicator.onTurnEnd('session-9')
    await h.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
    expect(h.prompts).toHaveLength(1)
    expect(h.timers.delays()).toEqual([DEFAULT_FIRST_RESPONSE_TIMEOUT_MS, DEFAULT_ADJUDICATION_WALL_CLOCK_MS])
  })

  it('watched 集合：不在册 / 非 dispatched|running 任务的会话不触发', async () => {
    const h = await adjudicatorWith({
      records: [
        task({ id: 'T-001', sessionId: 'session-9', status: 'dispatched' }),
        task({ id: 'T-002', sessionId: 'session-8', status: 'completed' }),
        task({ id: 'T-003', sessionId: undefined, status: 'queued' }),
      ],
      logs: { 'session-9': workTurn(1), 'session-8': workTurn(1), 'session-7': workTurn(1) },
    })
    h.adjudicator.onTurnEnd('session-8') // completed 任务
    h.adjudicator.onTurnEnd('session-7') // 在册任务不存在
    await h.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
    expect(h.prompts).toHaveLength(0)
    h.adjudicator.onTurnEnd('session-9') // dispatched 任务 → 触发
    await h.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
    expect(h.prompts).toHaveLength(1)
  })

  it('点读用一次性 projectionMode:none 租约（r7 §3.2 口径）', async () => {
    const h = await adjudicatorWith()
    await nudgeThrough(h)
    expect(h.pointReads).toEqual([{ sessionId: 'session-9', projectionMode: 'none' }])
  })
})

/* ────────────────────────── OutcomeAdjudicator：豁免链 ────────────────────────── */

describe('OutcomeAdjudicator：豁免链（规格 §4 waiting-user 结构性豁免等）', () => {
  it('豁免：末轮 reason.kind !== completed（aborted/error/interrupted ≠ 完成输出）', async () => {
    const h = await adjudicatorWith({ logs: { 'session-9': abortedTurn(1) } })
    await nudgeThrough(h)
    expect(h.prompts).toHaveLength(0)
  })

  it('豁免：零步空轮（末轮无 assistant/message）', async () => {
    const h = await adjudicatorWith({ logs: { 'session-9': emptyTurn(1) } })
    await nudgeThrough(h)
    expect(h.prompts).toHaveLength(0)
  })

  it('豁免：本任务有已认领待答问题（自家问题库，不信任 pendingInput）', async () => {
    const h = await adjudicatorWith()
    await h.ledger.addQuestion({ id: 'q-1', taskId: 'T-001', question: '用哪个端口？', status: 'open', createdAt: 1 })
    await nudgeThrough(h)
    expect(h.prompts).toHaveLength(0)
    // 应答后不再豁免
    await h.ledger.settleQuestion('q-1', 'answered', '[]')
    await nudgeThrough(h)
    expect(h.prompts).toHaveLength(1)
  })

  it('豁免：桌面 session/state 的 pendingInput 含 question/approval', async () => {
    const h = await adjudicatorWith({
      sessionState: async (sessionId) => ({ running: false, pendingInput: ['question'], sessionId }),
    })
    await nudgeThrough(h)
    expect(h.prompts).toHaveLength(0)
    // pendingInput 为空 → 正常动作
    const h2 = await adjudicatorWith({ sessionState: async () => ({ running: false, pendingInput: [] }) })
    await nudgeThrough(h2)
    expect(h2.prompts).toHaveLength(1)
  })

  it('CLI 老宿主（无 session/state）：agents.get(id)?.status 兜底——running 推迟、idle 放行', async () => {
    const h = await adjudicatorWith({ agentStatus: 'running' })
    await nudgeThrough(h)
    expect(h.prompts).toHaveLength(0)
    const h2 = await adjudicatorWith({ agentStatus: 'idle' })
    await nudgeThrough(h2)
    expect(h2.prompts).toHaveLength(1)
  })
})

/* ────────────────────────── OutcomeAdjudicator：第一级收尾提醒 ────────────────────────── */

describe('OutcomeAdjudicator：第一级 injectClosurePrompt（r9 §3/§5）', () => {
  it('watching → 注入提醒：requestId=closure-T-001-1、queue 模式、文本自报系统收尾提醒', async () => {
    const h = await adjudicatorWith()
    await nudgeThrough(h)
    expect(h.prompts).toHaveLength(1)
    const prompt = h.prompts[0]!
    expect(prompt.requestId).toBe('closure-T-001-1')
    expect(prompt.mode).toBe('queue')
    expect(prompt.text).toContain('系统收尾提醒')
    expect(prompt.text).toContain('complete_task')
    expect(prompt.text).toContain('report_blocker')
    expect(prompt.sessionId).toBe('session-9')
    // 写前意图账：prompt 调用时意图已落盘
    expect(prompt.intentsAtCall).toContain('closure-T-001-1')
    // 记账：progress + [事实] 事故条目
    expect((await h.ledger.get('T-001'))?.progress).toContain('收尾提醒')
    expect(h.incidents.some((entry) => entry.taskId === 'T-001' && entry.text.includes('收尾提醒'))).toBe(true)
  })

  it('幂等（Review Focus 3）：每周期只提醒一次；judged 后再触发无动作', async () => {
    const h = await adjudicatorWith()
    await nudgeThrough(h)
    expect(h.prompts).toHaveLength(1)
    // 首响定时器在 nudged 相位再来 → 不重复提醒、不判定（等提醒轮结束）
    h.adjudicator.onFirstResponseTimeout('T-001')
    expect(h.prompts).toHaveLength(1)
    expect(h.llmAttempts()).toBe(0)
    // 模拟提醒轮结束且已判完（直接推到 judged：llm 返回 completed）
    await h.adjudicator.onWallClock('T-001')
    expect(h.coreCalls.completed).toHaveLength(1)
    // judged 之后任何触发都不再动作
    await nudgeThrough(h)
    expect(h.prompts).toHaveLength(1)
    expect(h.coreCalls.completed).toHaveLength(1)
  })

  it('gateway/internal：同一 requestId 限时重试；重试耗尽保留 pending（下轮同 id 续投）', async () => {
    const h = await adjudicatorWith({
      failPrompt: (attempt) =>
        attempt <= 2 ? Object.assign(new Error('gateway exploded'), { code: 'gateway/internal' }) : undefined,
    })
    await nudgeThrough(h)
    expect(h.promptAttempts()).toBe(3)
    expect(h.prompts.map((p) => p.requestId)).toEqual(['closure-T-001-1'])
    expect(h.prompts.at(-1)!.intentsAtCall).toContain('closure-T-001-1')
    // 重试成功 → delivered、phase=nudged
    expect(h.incidents.some((entry) => entry.text.includes('收尾提醒'))).toBe(true)

    // 重试耗尽：意图保持 pending，下一触发沿用同一 requestId
    const h2 = await adjudicatorWith({
      failPrompt: () => Object.assign(new Error('gateway exploded'), { code: 'gateway/internal' }),
    })
    await nudgeThrough(h2)
    expect(h2.promptAttempts()).toBe(3)
    expect(h2.prompts.every((p) => p.requestId === 'closure-T-001-1')).toBe(true)
    await nudgeThrough(h2)
    expect(h2.promptAttempts()).toBe(6)
    expect(h2.prompts.every((p) => p.requestId === 'closure-T-001-1')).toBe(true)
  })

  it('writer-held：停手不重试（本轮不投、phase 保持 watching、下轮再来）', async () => {
    const h = await adjudicatorWith({
      failPrompt: () => Object.assign(new Error('writer held'), { code: 'session/writer-held' }),
    })
    await nudgeThrough(h)
    expect(h.promptAttempts()).toBe(1)
    expect(h.prompts).toHaveLength(0)
    expect((await h.ledger.get('T-001'))?.progress).toContain('writer-held')
    // 下轮（解除后）再触发：重新投递，phase 仍在 watching → 再试一次
    const h2 = await adjudicatorWith({
      failPrompt: (attempt) =>
        attempt === 1 ? Object.assign(new Error('writer held'), { code: 'session/writer-held' }) : undefined,
    })
    await nudgeThrough(h2)
    expect(h2.prompts).toHaveLength(0)
    await nudgeThrough(h2)
    expect(h2.prompts).toHaveLength(1)
    expect(h2.prompts[0]!.requestId).toBe('closure-T-001-1')
  })

  it('not-found：记账不重试（progress + 事故条目，无第二次投递）', async () => {
    const h = await adjudicatorWith({
      failPrompt: () => Object.assign(new Error('session not found'), { code: 'session/not-found' }),
    })
    await nudgeThrough(h)
    expect(h.promptAttempts()).toBe(1)
    expect((await h.ledger.get('T-001'))?.progress).toContain('not-found')
    expect(h.incidents.some((entry) => entry.text.includes('not-found'))).toBe(true)
  })

  it('agent-busy：按文本分辨（子代理持有），不崩、不重试、下轮再试', async () => {
    const h = await adjudicatorWith({
      failPrompt: () => Object.assign(new Error('use subagent delivery'), { code: 'session/agent-busy' }),
    })
    await nudgeThrough(h)
    expect(h.promptAttempts()).toBe(1)
    expect(h.prompts).toHaveLength(0)
    expect((await h.ledger.get('T-001'))?.progress).toContain('agent-busy')
  })
})

/* ────────────────────────── OutcomeAdjudicator：第二级判定与兜底定时器 ────────────────────────── */

describe('OutcomeAdjudicator：第二级 judgeOutcome 三态落位（规格 §4）', () => {
  it('completed → core.completeTask（deliveryOrigin=system-judged、判定摘要为 result）', async () => {
    const h = await adjudicatorWith({ llm: async () => JSON.stringify({ verdict: 'completed', summary: '判定：活已干完' }) })
    await nudgeThrough(h)
    h.adjudicator.onTurnEnd('session-9') // 提醒轮结束（点读读到 completed 末轮）
    await h.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
    expect(h.coreCalls.completed).toHaveLength(1)
    const call = h.coreCalls.completed[0] as { callerSessionId: string; taskId: string; input: { docVersion: number; summary: string; deliveryOrigin: string } }
    expect(call.callerSessionId).toBe('session-9')
    expect(call.taskId).toBe('T-001')
    expect(call.input.deliveryOrigin).toBe('system-judged')
    expect(call.input.summary).toBe('判定：活已干完')
    expect(call.input.docVersion).toBe(1)
    // dispatched → running 的转接（状态机无 dispatched→completed 直达边）
    expect((await h.ledger.get('T-001'))?.status).toBe('running')
    // 完成卡由 core 完成路径写入（集成测试另证）；判定路径本身写 progress + 事故
    expect((await h.ledger.get('T-001'))?.progress).toContain('系统判定')
    expect(h.incidents.some((entry) => entry.text.includes('系统判定交付'))).toBe(true)
    // 定时器清理
    expect(h.timers.delays()).toEqual([])
  })

  it('partial → blocked 附判定 + progress；failed 同理', async () => {
    const h = await adjudicatorWith({ llm: async () => JSON.stringify({ verdict: 'partial', summary: '还差部署' }) })
    await nudgeThrough(h)
    h.adjudicator.onTurnEnd('session-9')
    await h.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
    expect(h.coreCalls.blocked).toHaveLength(1)
    const call = h.coreCalls.blocked[0] as { callerSessionId: string; taskId: string; reason: string }
    expect(call.reason).toContain('partial')
    expect(call.reason).toContain('还差部署')
    expect(h.incidents.some((entry) => entry.text.includes('partial'))).toBe(true)

    const h2 = await adjudicatorWith({ llm: async () => JSON.stringify({ verdict: 'failed', summary: '方向错了' }) })
    await nudgeThrough(h2)
    h2.adjudicator.onTurnEnd('session-9')
    await h2.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
    const call2 = h2.coreCalls.blocked[0] as { reason: string }
    expect(call2.reason).toContain('failed')
    expect(call2.reason).toContain('方向错了')
  })

  it('判定失败（llm 挂）→ blocked 附「判定不可用」', async () => {
    const h = await adjudicatorWith({ llm: async () => {
      throw new Error('NO_ADAPTER')
    } })
    await nudgeThrough(h)
    h.adjudicator.onTurnEnd('session-9')
    await h.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
    expect(h.coreCalls.blocked).toHaveLength(1)
    const call = h.coreCalls.blocked[0] as { reason: string }
    expect(call.reason).toContain('判定不可用')
    expect(call.reason).toContain('NO_ADAPTER')
    expect(h.incidents.some((entry) => entry.text.includes('判定不可用'))).toBe(true)
  })

  it('状态机防双跑：并发触发（去抖 + 定时器同时到期）只跑一次判定', async () => {
    const h = await adjudicatorWith()
    await nudgeThrough(h)
    // 提醒轮结束（去抖）与墙钟同时到期
    h.adjudicator.onTurnEnd('session-9')
    await h.adjudicator.onWallClock('T-001')
    await h.timers.fireDelay(DEFAULT_CLOSURE_DEBOUNCE_MS)
    expect(h.coreCalls.completed).toHaveLength(1)
    expect(h.coreCalls.blocked).toHaveLength(0)
    expect(h.llmAttempts()).toBe(1)
  })

  it('兜底定时器：首响超时（无任何轮结束）也走同一判定入口（nudge）', async () => {
    const h = await adjudicatorWith({ logs: { 'session-9': hungTurn(1) } })
    h.adjudicator.onDispatched('T-001')
    expect(h.timers.delays()).toEqual([DEFAULT_FIRST_RESPONSE_TIMEOUT_MS, DEFAULT_ADJUDICATION_WALL_CLOCK_MS])
    await h.timers.fireDelay(DEFAULT_FIRST_RESPONSE_TIMEOUT_MS)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.requestId).toBe('closure-T-001-1')
    // 挂死会话不误判：无 turn/end 时首响超时只提醒，不判定
    expect(h.llmAttempts()).toBe(0)
  })

  it('墙钟兜底：nudged 且提醒轮一直没结束 → 墙钟触发判定', async () => {
    const h = await adjudicatorWith({ logs: { 'session-9': hungTurn(1) } })
    h.adjudicator.onDispatched('T-001')
    await h.timers.fireDelay(DEFAULT_FIRST_RESPONSE_TIMEOUT_MS) // nudge
    h.clock.advance(1)
    await h.timers.fireDelay(DEFAULT_ADJUDICATION_WALL_CLOCK_MS)
    expect(h.coreCalls.completed).toHaveLength(1) // 默认 llm 返回 completed
  })

  it('onDispatched 重置周期：supplement 升版后重新 watching，新周期用新 seq 提醒', async () => {
    const h = await adjudicatorWith()
    await nudgeThrough(h)
    expect(h.prompts[0]!.requestId).toBe('closure-T-001-1')
    await h.ledger.supplement('T-001', ['补充约束'])
    h.adjudicator.onDispatched('T-001') // bridge.onDelivered 接线（重置 + 重新武装定时器）
    expect(h.timers.delays()).toEqual([DEFAULT_FIRST_RESPONSE_TIMEOUT_MS, DEFAULT_ADJUDICATION_WALL_CLOCK_MS])
    await nudgeThrough(h)
    expect(h.prompts.map((p) => p.requestId)).toEqual(['closure-T-001-1', 'closure-T-001-2'])
  })

  it('syncWatched：启动恢复时给已在飞的 dispatched|running 任务武装定时器', async () => {
    const h = await adjudicatorWith({
      records: [
        task({ id: 'T-001', sessionId: 'session-9', status: 'running' }),
        task({ id: 'T-002', sessionId: 'session-8', status: 'completed' }),
      ],
    })
    expect(h.timers.delays()).toEqual([])
    await h.adjudicator.syncWatched()
    expect(h.timers.delays()).toEqual([DEFAULT_FIRST_RESPONSE_TIMEOUT_MS, DEFAULT_ADJUDICATION_WALL_CLOCK_MS])
  })

  it('可配超时：firstResponseTimeoutMs/adjudicationWallClockMs 用注入值武装', async () => {
    const h = await adjudicatorWith({ firstResponseTimeoutMs: 60_000, adjudicationWallClockMs: 120_000 })
    h.adjudicator.onDispatched('T-001')
    expect(h.timers.delays()).toEqual([60_000, 120_000])
  })
})

/* ────────────────────────── 集成：core 完成卡 / 异常卡 / deliveryOrigin ────────────────────────── */

describe('core 通知接线（规格 §5 完成卡/异常卡的宿主写入）', () => {
  it('TaskResult.deliveryOrigin 进账本（system-judged 落 result）', async () => {
    const memfs = makeMemFs()
    await memfs.fs.mkdirp('/guard')
    const persistence = new MemoryPersistence()
    persistence.file = {
      schemaVersion: 1,
      tasks: [task({ id: 'T-001', sessionId: 'session-9', status: 'running' })],
      nextTaskNumber: 2,
      questions: [],
    }
    const ledger = new TaskLedger(persistence, () => 1000)
    await ledger.listAll()
    const done = await ledger.complete('T-001', { docVersion: 1, summary: '判定摘要', deliveryOrigin: 'system-judged' })
    expect(done.result?.deliveryOrigin).toBe('system-judged')
    expect(done.result?.summary).toBe('判定摘要')
  })

  it('worker 首次完成 → 完成卡（deliveryOrigin=worker、动作含 view-result）', async () => {
    const memfs = makeMemFs()
    const sink = new NotificationStore({ fs: memfs.fs, path: '/guard/notifications.json', newId: () => `card-${Math.random()}`, now: () => 1 })
    const { core } = await guardCoreWith({
      records: [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' })],
      notifications: sink,
    })
    await core.completeTask('session-9', 'T-001', { docVersion: 1, summary: '干完了' })
    const pending = await sink.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('completion')
    expect(pending[0]!.taskId).toBe('T-001')
    expect(pending[0]!.deliveryOrigin).toBe('worker')
    expect(pending[0]!.summary).toBe('干完了')
    expect(pending[0]!.actions.some((action) => action.action === 'view-result')).toBe(true)
  })

  it('系统判定完成 → 完成卡 deliveryOrigin=system-judged；幂等重提不重复发卡', async () => {
    const memfs = makeMemFs()
    const sink = new NotificationStore({ fs: memfs.fs, path: '/guard/notifications.json', newId: () => `card-${Math.random()}`, now: () => 1 })
    const { core } = await guardCoreWith({
      records: [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' })],
      notifications: sink,
    })
    await core.completeTask('session-9', 'T-001', { docVersion: 1, summary: '判定：活已干完', deliveryOrigin: 'system-judged' })
    await core.completeTask('session-9', 'T-001', { docVersion: 1, summary: '判定：活已干完', deliveryOrigin: 'system-judged' })
    const pending = await sink.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.deliveryOrigin).toBe('system-judged')
  })

  it('reportBlocker → 异常卡；派发失败封顶 blocked → 异常卡', async () => {
    const memfs = makeMemFs()
    const sink = new NotificationStore({ fs: memfs.fs, path: '/guard/notifications.json', newId: () => `card-${Math.random()}`, now: () => 1 })
    const { core } = await guardCoreWith({
      records: [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' })],
      notifications: sink,
    })
    await core.reportBlocker('session-9', 'T-001', '缺部署凭据')
    let cards = await sink.pending()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.kind).toBe('anomaly')
    expect(cards[0]!.summary).toContain('缺部署凭据')
    expect(cards[0]!.actions.some((action) => action.action === 'redispatch')).toBe(true)

    const sink2 = new NotificationStore({ fs: (await Promise.resolve(makeMemFs())).fs, path: '/guard/notifications.json', newId: () => `card-${Math.random()}`, now: () => 1 })
    const { core: core2 } = await guardCoreWith({ notifications: sink2, failCreate: () => new Error('boom') })
    await core2.dispatchTask('router-s-1', { title: '示例', goal: 'g', acceptance: ['a'], role: 'worker', templateId: 'coder' }).catch(() => {})
    await core2.supplementTask('router-s-1', 'T-001', ['再试']).catch(() => {})
    await core2.supplementTask('router-s-1', 'T-001', ['再试']).catch(() => {}) // 第 3 次失败 → blocked
    cards = await sink2.pending()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.kind).toBe('anomaly')
    expect(cards[0]!.taskId).toBe('T-001')
  })

  it('workbench.state 的 notifications 投影：未 ack 卡出现，ack 后消失', async () => {
    const memfs = makeMemFs()
    const sink = new NotificationStore({ fs: memfs.fs, path: '/guard/notifications.json', newId: () => `card-${Math.random()}`, now: () => 1 })
    const assembled = await guardCoreWith({
      records: [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' })],
      notifications: sink,
    })
    await assembled.core.completeTask('session-9', 'T-001', { docVersion: 1, summary: '干完了' })
    const state = await assembled.workbench.state('ws-1')
    expect(state.notifications).toHaveLength(1)
    expect(state.notifications?.[0]!.taskId).toBe('T-001')
    await sink.ack(state.notifications![0]!.cardId)
    const after = await assembled.workbench.state('ws-1')
    expect(after.notifications ?? []).toHaveLength(0)
  })
})

/* ────────────────────────── bridge onDelivered（B3 触发接线点） ────────────────────────── */

describe('SessionBridge onDelivered：投递成功即回调（B3 定时器武装点）', () => {
  async function bridgeWith(records: TaskRecord[], delivered: { taskId: string; sessionId: string }[]) {
    const persistence = new MemoryPersistence()
    persistence.file = { schemaVersion: 1, tasks: records, nextTaskNumber: records.length + 1, questions: [] }
    const ledger = new TaskLedger(persistence, () => 1000)
    await ledger.listAll()
    const docsFiles = new Map<string, string>([['/proj/.router/tasks/T-001/task.v1.md', '# 任务书']])
    const docsFs = {
      readFile: async (p: string) => {
        const content = docsFiles.get(p)
        if (content === undefined) throw new Error(`ENOENT ${p}`)
        return content
      },
      writeFile: async (p: string, content: string) => {
        docsFiles.set(p, content)
      },
      mkdirp: async () => {},
      exists: async (p: string) => docsFiles.has(p),
      readdir: async () => [...docsFiles.keys()],
    }
    const docs = new (await import('../src/host/docs/task-docs.ts')).TaskDocStore('/proj/.router', docsFs)
    const prompts: { requestId: string }[] = []
    const host: SessionBridgeHost = {
      create: async () => `session-${prompts.length + 1}`,
      async prompt(request) {
        prompts.push({ requestId: request.requestId })
        return { accepted: true }
      },
      onStatus: () => {},
    }
    const bridge = new SessionBridge({
      ledger,
      docsFor: () => docs,
      host,
      presets: { supervisor: 'sup-p', worker: 'worker-p' },
      workerInstructions: () => '【执行指引】',
      onDelivered: (taskId, sessionId) => delivered.push({ taskId, sessionId }),
    })
    return { bridge, ledger, prompts, delivered }
  }

  it('dispatchTask 成功 → onDelivered(taskId, sessionId)', async () => {
    const delivered: { taskId: string; sessionId: string }[] = []
    const { bridge, ledger, prompts } = await bridgeWith([task({ id: 'T-001', status: 'queued', cwd: '/proj' })], delivered)
    await ledger.updateProgress('T-001', '占位') // 确保 createTask 文档已在（dispatchTask 要读任务书）
    await bridge.dispatchTask('T-001')
    expect(prompts).toHaveLength(1)
    expect(delivered).toEqual([{ taskId: 'T-001', sessionId: 'session-1' }])
  })

  it('投递失败 → 不回调 onDelivered', async () => {
    const delivered: { taskId: string; sessionId: string }[] = []
    const persistence = new MemoryPersistence()
    persistence.file = { schemaVersion: 1, tasks: [task({ id: 'T-001', status: 'queued', cwd: '/proj' })], nextTaskNumber: 2, questions: [] }
    const ledger = new TaskLedger(persistence, () => 1000)
    await ledger.listAll()
    const docsFs = {
      readFile: async () => '# 任务书',
      writeFile: async () => {},
      mkdirp: async () => {},
      exists: async () => true,
      readdir: async () => [] as string[],
    }
    const docs = new (await import('../src/host/docs/task-docs.ts')).TaskDocStore('/proj/.router', docsFs)
    const bridge = new SessionBridge({
      ledger,
      docsFor: () => docs,
      host: {
        create: async () => 'session-1',
        async prompt() {
          throw new Error('boom')
        },
        onStatus: () => {},
      },
      presets: { supervisor: 'sup-p', worker: 'worker-p' },
      workerInstructions: () => '【执行指引】',
      onDelivered: (taskId, sessionId) => delivered.push({ taskId, sessionId }),
    })
    await expect(bridge.dispatchTask('T-001')).rejects.toThrow()
    expect(delivered).toEqual([])
  })
})

/* ────────────────────────── routes：POST /router/notifications/ack ────────────────────────── */

describe('POST /router/notifications/ack（C1 只消费）', () => {
  interface CapturedResponse { status?: number; body?: string }

  function fakeHttpContext() {
    const routes: Array<{ path: string; handler: (req: never, res: never) => Promise<void> | void }> = []
    const ctx = {
      effect(factory: () => unknown) {
        ;(factory as () => unknown)()
        return () => {}
      },
      webServer: {
        register(route: { path: string; handler: (req: never, res: never) => Promise<void> | void }) {
          routes.push(route)
        },
      },
      connection: { admit: () => ({ peer: {} }) },
    }
    return { ctx: ctx as unknown as RouterRoutesContext, routes }
  }

  function fakeExchange(method: string, url: string, body?: string) {
    const chunks = body === undefined ? [] : [Buffer.from(body)]
    const req = {
      method,
      url,
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === 'data') chunks.forEach((chunk) => listener(chunk))
        if (event === 'end') listener()
      },
    }
    const captured = {} as CapturedResponse
    const res = {
      writeHead(status: number) {
        captured.status = status
      },
      end(payload?: string) {
        captured.body = payload ?? ''
      },
    }
    return { req, res, captured }
  }

  it('ack 已知卡 → {ok:true}；未知卡 → 404', async () => {
    const memfs = makeMemFs()
    await memfs.fs.mkdirp('/guard')
    const store = new NotificationStore({ fs: memfs.fs, path: '/guard/notifications.json', newId: () => 'card-1', now: () => 1 })
    const card = await store.push({ kind: 'completion', taskId: 'T-001', title: 't', summary: 's', actions: completionActions() })
    const { ctx, routes } = fakeHttpContext()
    const deps: RouterRoutesDeps = {
      getState: async () => {
        throw new Error('not used')
      },
      createRouterSession: async () => {
        throw new Error('not used')
      },
      answerQuestion: async () => {},
      closeTab: async () => true,
      ackRedirect: async () => {},
      listWorkerTypes: async () => ({ types: [] }),
      createWorkerType: async () => {
        throw new Error('not used')
      },
      updateWorkerType: async () => {
        throw new Error('not used')
      },
      setWorkerTypeEnabled: async () => {
        throw new Error('not used')
      },
      removeWorkerType: async () => {},
      getDefaults: async () => ({ routerSystemPrompt: '', routerModel: '' }),
      saveDefaults: async (value) => value,
      getSessionPrompt: async () => ({ prompt: '', isDefault: true }),
      saveSessionPrompt: async () => {},
      ackNotification: async (cardId: string) => store.ack(cardId),
    }
    registerRouterRoutes(ctx, deps)
    const route = routes.find((entry) => entry.path === '/router/notifications/ack')
    expect(route).toBeDefined()
    const ok = fakeExchange('POST', '/router/notifications/ack', JSON.stringify({ cardId: card.cardId }))
    await route!.handler(ok.req as never, ok.res as never)
    expect(ok.captured.status).toBe(200)
    expect(JSON.parse(ok.captured.body!)).toEqual({ ok: true })
    const missing = fakeExchange('POST', '/router/notifications/ack', JSON.stringify({ cardId: 'nope' }))
    await route!.handler(missing.req as never, missing.res as never)
    expect(missing.captured.status).toBe(404)
  })
})

/* ────────────────────────── 类型面 ────────────────────────── */

describe('通知卡形状（view-contract，照计划 C1）', () => {
  it('NotificationCard 满足 C1 形状 + ack（sink 面可赋值）', async () => {
    const sink: NotificationSink = new NotificationStore({
      fs: (await Promise.resolve(makeMemFs())).fs,
      path: '/guard/notifications.json',
      newId: () => 'c',
      now: () => 1,
    })
    const card: NotificationCard = await sink.push({
      kind: 'completion',
      taskId: 'T-001',
      title: 'T-001 t',
      summary: 's',
      actions: [{ action: 'open-session', label: '打开会话' }],
      deliveryOrigin: 'system-judged',
    })
    expect(card.kind).toBe('completion')
    expect(card.actions[0]!.action).toBe('open-session')
  })
})
