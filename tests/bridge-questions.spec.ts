/**
 * 会话桥测试（计划 Task B4）：问答桥纯逻辑 + 会话桥 + HTTP 路由，全用假件。
 */

import { describe, expect, it, vi } from 'vitest'

import { LedgerError } from '../src/host/ledger/errors.ts'
import { TaskLedger, type LedgerFile, type LedgerPersistence } from '../src/host/ledger/store.ts'
import type { TaskRecord } from '../src/shared/types.ts'
import { task } from './helpers/task-builder.ts'
import { AnswerRelay } from '../src/host/bridge/questions.ts'
import { SessionBridge, type SessionBridgeHost, type WorkspaceFace } from '../src/host/bridge/sessions.ts'
import { registerRouterRoutes, type RouterRoutesContext, type RouterRoutesDeps } from '../src/host/routes.ts'
import type { AskUserQuestionAnswerItem, RouterState } from '../src/shared/view-contract.ts'
import { TaskDocStore } from '../src/host/docs/task-docs.ts'
import type { FsAdapter } from '../src/shared/fs-adapter.ts'

/* ────────────────────────── 假件 ────────────────────────── */

/** 内存账本持久化（测试间独立）。 */
class MemoryPersistence implements LedgerPersistence {
  file: LedgerFile | null = null
  failNextSave = false
  async load() {
    return this.file
  }
  async save(f: LedgerFile) {
    if (this.failNextSave) {
      this.failNextSave = false
      throw new Error('disk gone')
    }
    this.file = JSON.parse(JSON.stringify(f)) as LedgerFile
  }
}

let questionSeq = 0
function newId() {
  questionSeq += 1
  return `q-${String(questionSeq).padStart(3, '0')}`
}

async function ledgerWith(records: TaskRecord[] = []): Promise<{ ledger: TaskLedger; persistence: MemoryPersistence }> {
  const persistence = new MemoryPersistence()
  persistence.file = { schemaVersion: 1, tasks: records, nextTaskNumber: records.length + 1, questions: [] }
  const ledger = new TaskLedger(persistence, () => 1000)
  await ledger.listAll() // 触发装载
  return { ledger, persistence }
}

/** 问答桥 + 一个在册 worker 会话（worker-s-1 ↔ T-001）与一个主管会话。 */
async function relayWithTasks() {
  const records = [
    task({ id: 'T-001', role: 'worker', sessionId: 'worker-s-1', status: 'running' }),
    task({ id: 'T-002', role: 'supervisor', sessionId: 'sup-s-1', status: 'running' }),
    task({ id: 'T-003', role: 'router', sessionId: 'router-s-1', status: 'running' }),
  ]
  const { ledger, persistence } = await ledgerWithTasks(records)
  const relay = new AnswerRelay({ ledger, newId, now: () => 42 })
  return { ledger, persistence, relay }
}

/** 等认领落稳（parked 进列表、账本记录落库）——不数微任务，轮询到确定态。 */
async function awaitParked(relay: { pendingCards(): unknown[] }, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(relay.pendingCards()).toHaveLength(count)
  })
}

async function ledgerWithTasks(records: TaskRecord[]) {
  return ledgerWith(records)
}

const askRequest = (sessionId: string, questions = [{ id: 'a1', question: '用哪个端口？' }], signal?: AbortSignal) => ({
  questions,
  agent: { id: sessionId },
  signal,
})

/* ────────────────────────── 问答桥 ────────────────────────── */

describe('AnswerRelay：瀑布认领', () => {
  it('在册 worker 会话的问题被认领：pending 出现卡片、账本落 open 记录', async () => {
    const { ledger, relay } = await relayWithTasks()
    const next = async () => {
      throw new Error('不应放行')
    }
    const pending = relay.claimQuestion(askRequest('worker-s-1'), next)
    await awaitParked(relay, 1)
    const cards = relay.pendingCards()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.taskId).toBe('T-001')
    expect(cards[0]!.taskTitle).toBe('示例任务')
    expect(cards[0]!.questions).toEqual([{ id: 'a1', question: '用哪个端口？' }])
    const open = await ledger.openQuestions()
    expect(open).toHaveLength(1)
    expect(open[0]!.status).toBe('open')
    await relay.answerQuestion(cards[0]!.questionId, [{ id: 'a1', selected: ['3000'] }])
    const answer = await pending
    expect(answer).toEqual({ answers: [{ id: 'a1', selected: ['3000'] }] })
  })

  it('主管会话的问题同样认领', async () => {
    const { relay } = await relayWithTasks()
    const claim = relay.claimQuestion(askRequest('sup-s-1'), async () => 'passed-through')
    await awaitParked(relay, 1)
    expect(relay.pendingCards()[0]!.taskId).toBe('T-002')
    await relay.answerQuestion(relay.pendingCards()[0]!.questionId, [{ id: 'a1', selected: [] }])
    await expect(claim).resolves.toEqual({ answers: [{ id: 'a1', selected: [] }] })
  })

  it('不在册会话放行 next()（含无 agent 的全局请求）', async () => {
    const { relay } = await relayWithTasks()
    let passed = 0
    const next = async () => {
      passed += 1
      return 'passed'
    }
    await expect(relay.claimQuestion(askRequest('stranger-s'), next)).resolves.toBe('passed')
    await expect(relay.claimQuestion({ questions: [{ id: 'x', question: '?' }] }, next)).resolves.toBe('passed')
    expect(passed).toBe(2)
    expect(relay.pendingCards()).toHaveLength(0)
  })

  it('router 会话放行 next()（任务在册但角色是 router）', async () => {
    const { relay } = await relayWithTasks()
    const next = async () => 'passed'
    await expect(relay.claimQuestion(askRequest('router-s-1'), next)).resolves.toBe('passed')
    expect(relay.pendingCards()).toHaveLength(0)
  })

  it('多问题并行排队互不覆盖，各自应答', async () => {
    const { relay } = await relayWithTasks()
    const first = relay.claimQuestion(askRequest('worker-s-1', [{ id: 'q1', question: '第一个？' }]), async () => 'no')
    const second = relay.claimQuestion(askRequest('sup-s-1', [{ id: 'q2', question: '第二个？' }]), async () => 'no')
    await awaitParked(relay, 2)
    expect(relay.pendingCards()).toHaveLength(2)
    await relay.answerQuestion(relay.pendingCards()[1]!.questionId, [{ id: 'q2', selected: ['b'] }])
    await relay.answerQuestion(relay.pendingCards()[0]!.questionId, [{ id: 'q1', selected: ['a'] }])
    await expect(second).resolves.toEqual({ answers: [{ id: 'q2', selected: ['b'] }] })
    await expect(first).resolves.toEqual({ answers: [{ id: 'q1', selected: ['a'] }] })
    expect(relay.pendingCards()).toHaveLength(0)
  })

  it('等待中的问题被中止信号取消：claim 拒绝、卡片移除', async () => {
    const { relay } = await relayWithTasks()
    const controller = new AbortController()
    const claim = relay.claimQuestion(askRequest('worker-s-1', undefined, controller.signal), async () => 'no')
    await awaitParked(relay, 1)
    expect(relay.pendingCards()).toHaveLength(1)
    controller.abort()
    await expect(claim).rejects.toThrowError(LedgerError)
    expect(relay.pendingCards()).toHaveLength(0)
  })
})

describe('AnswerRelay：应答与 409 语义', () => {
  it('重复应答抛 already-answered（409）', async () => {
    const { relay } = await relayWithTasks()
    const claim = relay.claimQuestion(askRequest('worker-s-1'), async () => 'no')
    await awaitParked(relay, 1)
    const questionId = relay.pendingCards()[0]!.questionId
    await relay.answerQuestion(questionId, [{ id: 'a1', selected: [] }])
    await claim
    await expect(relay.answerQuestion(questionId, [{ id: 'a1', selected: [] }])).rejects.toMatchObject({
      code: 'already-answered',
    })
  })

  it('未知问题抛 question-not-found（404）', async () => {
    const { relay } = await relayWithTasks()
    await expect(relay.answerQuestion('q-nope', [{ id: 'a1', selected: [] }])).rejects.toMatchObject({
      code: 'question-not-found',
    })
  })

  it('应答先落账本后放行：落库失败时不 resolve（worker 继续等待，可重试）', async () => {
    const { ledger, persistence, relay } = await relayWithTasks()
    const claim = relay.claimQuestion(askRequest('worker-s-1'), async () => 'no')
    await awaitParked(relay, 1)
    persistence.failNextSave = true
    const questionId = relay.pendingCards()[0]!.questionId
    await expect(relay.answerQuestion(questionId, [{ id: 'a1', selected: [] }])).rejects.toThrowError(LedgerError)
    persistence.failNextSave = false
    await relay.answerQuestion(questionId, [{ id: 'a1', selected: [] }])
    await expect(claim).resolves.toEqual({ answers: [{ id: 'a1', selected: [] }] })
    expect(await ledger.openQuestions()).toHaveLength(0)
  })
})

describe('AnswerRelay：重启孤儿恢复', () => {
  it('账本里遗留的 open 问题：任务标 blocked、问题记 expired', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'worker-s-1', status: 'waiting-user' })]
    const { ledger } = await ledgerWith(records)
    await ledger.addQuestion({ id: 'q-old', taskId: 'T-001', question: '旧的等待', status: 'open', createdAt: 1 })
    const relay = new AnswerRelay({ ledger, newId, now: () => 42 })
    const recovered = await relay.recoverOrphans()
    expect(recovered).toEqual(['q-old'])
    expect(ledger.get('T-001')?.status).toBe('blocked')
    const open = await ledger.openQuestions()
    expect(open).toHaveLength(0)
  })

  it('终态任务不强行标 blocked（只过期问题记录）', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'worker-s-1', status: 'completed' })]
    const { ledger } = await ledgerWith(records)
    await ledger.addQuestion({ id: 'q-old', taskId: 'T-001', question: '旧的等待', status: 'open', createdAt: 1 })
    const relay = new AnswerRelay({ ledger, newId, now: () => 42 })
    expect(await relay.recoverOrphans()).toEqual(['q-old'])
    expect(ledger.get('T-001')?.status).toBe('completed')
  })

  it('paused 任务状态机不允许直接 blocked：只过期问题，不动状态', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'worker-s-1', status: 'paused' })]
    const { ledger } = await ledgerWith(records)
    await ledger.addQuestion({ id: 'q-old', taskId: 'T-001', question: '旧的等待', status: 'open', createdAt: 1 })
    const relay = new AnswerRelay({ ledger, newId, now: () => 42 })
    expect(await relay.recoverOrphans()).toEqual(['q-old'])
    expect(ledger.get('T-001')?.status).toBe('paused')
  })
})

/* ────────────────────────── 会话桥 ────────────────────────── */

interface FakeHostEvents {
  created: { opts: { workspaceId?: string; cwd?: string; agentPreset?: string } }[]
  prompts: { requestId: string; sessionId: string; mode: string; text: string }[]
  renames: { sessionId: string; title: string }[]
}

function fakeHost(presets = { router: 'dsh-router', supervisor: 'dsh-router-supervisor', worker: 'dsh-router-worker' }) {
  const events: FakeHostEvents = { created: [], prompts: [], renames: [] }
  const statusCallbacks: ((sessionId: string, running: boolean) => void)[] = []
  let createdCount = 0
  const host: SessionBridgeHost = {
    async create(opts) {
      createdCount += 1
      events.created.push({ opts })
      return `session-${createdCount}`
    },
    async prompt(request) {
      const text = request.content.map((block) => block.text).join('\n')
      events.prompts.push({ requestId: request.requestId, sessionId: request.sessionId, mode: request.mode, text })
      return { accepted: true }
    },
    onStatus(callback) {
      statusCallbacks.push(callback)
    },
    async rename(sessionId, title) {
      events.renames.push({ sessionId, title })
    },
  }
  return { host, events, presets, statusCallbacks }
}

function fakeWorkspaces(list: { id: string; path?: string; sessionIds?: string[] }[] = []): WorkspaceFace {
  return {
    list: () => list,
    get: (id: string) => list.find((w) => w.id === id),
  }
}

function fakeDocs(): TaskDocStore {
  const files = new Map<string, string>()
  const fs: FsAdapter = {
    async readFile(p) {
      const content = files.get(p)
      if (content === undefined) throw new LedgerError('doc-not-found', `文档不存在: ${p}`)
      return content
    },
    async writeFile(p, content) {
      files.set(p, content)
    },
    async mkdirp() {},
    async exists(p) {
      return files.has(p)
    },
    async readdir() {
      return [...files.keys()]
    },
  }
  const docs = new TaskDocStore('/tasks', fs)
  return Object.assign(docs, { files })
}

async function bridgeWith(taskPatch: Partial<TaskRecord> = {}) {
  const record = task({ id: 'T-001', role: 'worker', projectId: 'ws-1', cwd: '/tmp/proj', status: 'queued', ...taskPatch })
  const { ledger } = await ledgerWith([record])
  const docs = fakeDocs()
  const { host, events, presets, statusCallbacks } = fakeHost()
  const instructions = '【执行指引】完成必须用 complete_task。'
  const bridge = new SessionBridge({
    ledger,
    docsFor: () => docs,
    workspaces: fakeWorkspaces([{ id: 'ws-1', path: '/tmp/proj' }]),
    host,
    presets,
    workerInstructions: () => instructions,
    signal: new AbortController().signal,
  })
  await docs.initTask(record, `# 任务书 ${record.id}\n目标：${record.goal}`)
  return { ledger, docs, bridge, events, presets, statusCallbacks, instructions }
}

describe('SessionBridge：派发', () => {
  it('queued 任务派发：建会话（按 projectId 解析 workspace）、改名、投任务书+执行指引、转 dispatched', async () => {
    const { ledger, bridge, events, presets, instructions } = await bridgeWith()
    const result = await bridge.dispatchTask('T-001')
    expect(result.sessionId).toBe('session-1')
    expect(events.created).toEqual([{ opts: { workspaceId: 'ws-1', agentPreset: presets.worker } }])
    expect(events.renames).toEqual([{ sessionId: 'session-1', title: 'T-001 示例任务' }])
    expect(events.prompts).toHaveLength(1)
    expect(events.prompts[0]!.sessionId).toBe('session-1')
    expect(events.prompts[0]!.mode).toBe('queue')
    expect(events.prompts[0]!.requestId).toBe('dispatch-T-001-v1')
    expect(events.prompts[0]!.text).toContain('# 任务书 T-001')
    expect(events.prompts[0]!.text).toContain(instructions)
    expect(ledger.get('T-001')?.status).toBe('dispatched')
    expect(ledger.get('T-001')?.sessionId).toBe('session-1')
  })

  it('draft 任务经 draft→queued→dispatched 两步走表边', async () => {
    const { ledger, bridge } = await bridgeWith({ status: 'draft' })
    await bridge.dispatchTask('T-001')
    expect(ledger.get('T-001')?.status).toBe('dispatched')
  })

  it('重复派发同版本：复用已有会话（不重建），requestId 幂等相同', async () => {
    const { bridge, events } = await bridgeWith({ sessionId: 'session-9', status: 'running' })
    await bridge.dispatchTask('T-001')
    await bridge.dispatchTask('T-001')
    expect(events.created).toHaveLength(0)
    expect(events.prompts).toHaveLength(2)
    expect(events.prompts[0]!.sessionId).toBe('session-9')
    expect(events.prompts[1]!.requestId).toBe('dispatch-T-001-v1')
  })

  it('projectId 解析不到 workspace 时回退 cwd 创建', async () => {
    const { bridge, events, presets } = await bridgeWith({ projectId: 'ws-gone' })
    await bridge.dispatchTask('T-001')
    expect(events.created).toEqual([{ opts: { cwd: '/tmp/proj', agentPreset: presets.worker } }])
  })

  it('无 workspace 面时也回退 cwd（registry 可选缺席）', async () => {
    const { ledger, docs } = await bridgeWith()
    const { host, events, presets } = fakeHost()
    const bare = new SessionBridge({
      ledger,
      docsFor: () => docs,
      workspaces: undefined,
      host,
      presets,
      workerInstructions: () => '指引',
      signal: new AbortController().signal,
    })
    await bare.dispatchTask('T-001')
    expect(events.created[0]!.opts.cwd).toBe('/tmp/proj')
    expect(events.created[0]!.opts.workspaceId).toBeUndefined()
  })

  it('任务不存在抛 task-not-found', async () => {
    const { bridge } = await bridgeWith()
    await expect(bridge.dispatchTask('T-999')).rejects.toMatchObject({ code: 'task-not-found' })
  })

  it('supervisor 角色任务用主管预设建会话', async () => {
    const { bridge, events, presets } = await bridgeWith({ role: 'supervisor' })
    await bridge.dispatchTask('T-001')
    expect(events.created[0]!.opts.agentPreset).toBe(presets.supervisor)
  })
})

describe('SessionBridge：补充与通知', () => {
  it('supplementTo：按当前版本重投原会话（requestId 带新版本号）', async () => {
    const { ledger, docs, bridge, events } = await bridgeWith({ sessionId: 'session-9', status: 'running', docVersion: 1 })
    await ledger.supplement('T-001', ['补充：用 PostgreSQL'])
    await docs.supplement('T-001', 1, ['补充：用 PostgreSQL'])
    await bridge.supplementTo('T-001')
    expect(events.prompts).toHaveLength(1)
    expect(events.prompts[0]!.requestId).toBe('dispatch-T-001-v2')
    expect(events.prompts[0]!.sessionId).toBe('session-9')
    expect(events.prompts[0]!.text).toContain('v2 补充')
  })

  it('supplementTo：还没绑会话的任务不投递（保持 queued 等解锁）', async () => {
    const { bridge, events } = await bridgeWith({ status: 'queued' })
    await bridge.supplementTo('T-001')
    expect(events.prompts).toHaveLength(0)
  })

  it('notifyCancel 用 steer 送停止通知；无会话时静默跳过', async () => {
    const { bridge, events } = await bridgeWith({ sessionId: 'session-9', status: 'running' })
    await bridge.notifyCancel('T-001')
    expect(events.prompts[0]!.mode).toBe('steer')
    expect(events.prompts[0]!.requestId).toBe('cancel-T-001')
    expect(events.prompts[0]!.text).toContain('取消')
  })
})

describe('SessionBridge：运行状态观察', () => {
  it('watchStatus 记录 running 标志并转发回调（压缩驱动接线点）', async () => {
    const { bridge, statusCallbacks } = await bridgeWith({ sessionId: 'session-9' })
    const seen: [string, boolean][] = []
    bridge.watchStatus()
    for (const callback of statusCallbacks) callback('session-9', true)
    for (const callback of statusCallbacks) callback('session-9', false)
    expect(bridge.isRunning('session-9')).toBe(false)
    expect(bridge.isRunning('session-other')).toBe(false)
    bridge.onStatusChange((sid, running) => seen.push([sid, running]))
    for (const callback of statusCallbacks) callback('session-9', true)
    expect(bridge.isRunning('session-9')).toBe(true)
    expect(seen).toEqual([['session-9', true]])
  })
})

describe('SessionBridge：notify 通用投递', () => {
  it('按给定 requestId/mode/文本投递（完成通知、暂停通知等共用通道）', async () => {
    const { bridge, events } = await bridgeWith({ sessionId: 'session-9', status: 'running' })
    await bridge.notify('session-9', 'notice-T-001-completed', '子任务 T-001 已完成', 'steer')
    expect(events.prompts[0]).toEqual({
      requestId: 'notice-T-001-completed',
      sessionId: 'session-9',
      mode: 'steer',
      text: '子任务 T-001 已完成',
    })
  })
})

/* ────────────────────────── HTTP 路由 ────────────────────────── */

interface CapturedResponse {
  status: number
  headers: Record<string, unknown>
  body: string
}

function fakeHttpContext(): { ctx: RouterRoutesContext; routes: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }[] } {
  const routes: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }[] = []
  const ctx: RouterRoutesContext = {
    // 宿主的 effect 会立刻调用 factory 拿 disposer——假件必须同样调用，
    // 否则路由注册体根本不会执行。
    effect(factory) {
      ;(factory as () => unknown)()
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push({ path: route.path, handler: route.handler as (req: unknown, res: unknown) => Promise<void> | void })
      },
    },
    connection: {
      admit(request) {
        const headers = (request as { headers?: Record<string, string> }).headers ?? {}
        return headers.cookie === 'bad' ? { rejection: 403 } : { peer: {} }
      },
    },
  }
  return { ctx, routes }
}

/** 组一个假请求/应答对；body 为 JSON 字符串。 */
function fakeExchange(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const req = {
    method,
    url,
    headers: { 'content-length': String(body?.length ?? 0), ...headers },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'data') chunks.forEach((chunk) => listener(chunk))
      if (event === 'end') listener()
    },
  }
  const captured = {} as CapturedResponse
  const res = {
    writeHead(status: number, hdrs?: Record<string, unknown>) {
      captured.status = status
      captured.headers = hdrs ?? {}
    },
    end(payload?: string) {
      captured.body = payload ?? ''
    },
  }
  return { req, res, captured }
}

function fakeDeps(state: Partial<RouterRoutesDeps> = {}): RouterRoutesDeps & { calls: string[] } {
  const calls: string[] = []
  const routerState: RouterState = {
    routerSessions: [{ sessionId: 'router-s-1', title: 'Router' }],
    tasks: [],
    questions: [],
    tabs: [],
    templates: [],
  }
  return {
    calls,
    async getState(workspaceId) {
      calls.push(`state:${workspaceId ?? '-'}`)
      return routerState
    },
    async createRouterSession(workspaceId, name) {
      calls.push(`create:${workspaceId ?? '-'}:${name ?? '-'}`)
      return { sessionId: 'router-new-1' }
    },
    async answerQuestion(questionId, answers) {
      calls.push(`answer:${questionId}:${JSON.stringify(answers)}`)
    },
    async closeTab(workspaceId, sessionId) {
      calls.push(`close:${workspaceId}:${sessionId}`)
      return true
    },
    ...state,
  }
}

describe('HTTP 路由（exact + admit）', () => {
  it('四条 exact 路由全部挂上', () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    expect(routes.map((r) => r.path)).toEqual([
      '/router/state',
      '/router/router-session',
      '/router/answer',
      '/router/tabs/close',
    ])
  })

  it('GET /router/state 透传 workspaceId 查询参数并回 JSON', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('GET', '/router/state?workspaceId=ws-1')
    await routes[0]!.handler(req, res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toMatchObject({ routerSessions: [{ sessionId: 'router-s-1' }] })
    expect(captured.headers['cache-control']).toBe('no-store')
  })

  it('admit 拒绝时原样状态码短体', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('GET', '/router/state', undefined, { cookie: 'bad' })
    await routes[0]!.handler(req, res)
    expect(captured.status).toBe(403)
    expect(captured.body).toBe('forbidden')
  })

  it('方法不对回 405', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('POST', '/router/state', '{}')
    await routes[0]!.handler(req, res)
    expect(captured.status).toBe(405)
  })

  it('POST /router/router-session 解析 body 调 createRouterSession', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const { req, res, captured } = fakeExchange('POST', '/router/router-session', JSON.stringify({ workspaceId: 'ws-1', name: '我的 Router' }))
    await routes[1]!.handler(req, res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ sessionId: 'router-new-1' })
    expect(deps.calls[0]).toBe('create:ws-1:我的 Router')
  })

  it('POST body 坏 JSON 回 400', async () => {
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, fakeDeps())
    const { req, res, captured } = fakeExchange('POST', '/router/router-session', '{oops')
    await routes[1]!.handler(req, res)
    expect(captured.status).toBe(400)
    expect(JSON.parse(captured.body)).toMatchObject({ error: expect.any(String) })
  })

  it('POST /router/answer：200/404/409 三态', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const answers: AskUserQuestionAnswerItem[] = [{ id: 'a1', selected: ['3000'] }]
    const ok = fakeExchange('POST', '/router/answer', JSON.stringify({ questionId: 'q-1', answers }))
    await routes[2]!.handler(ok.req, ok.res)
    expect(ok.captured.status).toBe(200)
    expect(JSON.parse(ok.captured.body)).toEqual({ ok: true })

    const missing = fakeDeps({
      async answerQuestion() {
        throw new LedgerError('question-not-found', '问题不存在')
      },
    })
    const { ctx: ctx2, routes: routes2 } = fakeHttpContext()
    registerRouterRoutes(ctx2, missing)
    const notFound = fakeExchange('POST', '/router/answer', JSON.stringify({ questionId: 'q-1', answers }))
    await routes2[2]!.handler(notFound.req, notFound.res)
    expect(notFound.captured.status).toBe(404)

    const answered = fakeDeps({
      async answerQuestion() {
        throw new LedgerError('already-answered', '已应答')
      },
    })
    const { ctx: ctx3, routes: routes3 } = fakeHttpContext()
    registerRouterRoutes(ctx3, answered)
    const conflict = fakeExchange('POST', '/router/answer', JSON.stringify({ questionId: 'q-1', answers }))
    await routes3[2]!.handler(conflict.req, conflict.res)
    expect(conflict.captured.status).toBe(409)
  })

  it('POST /router/tabs/close 调 closeTab 并回 ok', async () => {
    const { ctx, routes } = fakeHttpContext()
    const deps = fakeDeps()
    registerRouterRoutes(ctx, deps)
    const { req, res, captured } = fakeExchange('POST', '/router/tabs/close', JSON.stringify({ workspaceId: 'ws-1', sessionId: 'session-3' }))
    await routes[3]!.handler(req, res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ ok: true })
    expect(deps.calls[0]).toBe('close:ws-1:session-3')
  })
})
