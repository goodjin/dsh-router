/**
 * RouterCore 装配测试（计划 B2 根服务组装的核心逻辑，全部假件不启宿主）。
 */

import { describe, expect, it } from 'vitest'

import { LedgerError } from '../src/host/ledger/errors.ts'
import { TaskLedger, type LedgerPersistence, type LedgerFile } from '../src/host/ledger/store.ts'
import { Scheduler } from '../src/host/ledger/scheduler.ts'
import { TaskDocStore } from '../src/host/docs/task-docs.ts'
import { SessionBridge, type SessionBridgeHost, type WorkspaceInfo } from '../src/host/bridge/sessions.ts'
import { AnswerRelay } from '../src/host/bridge/questions.ts'
import { CompactionDriver, type CompactionDeps } from '../src/host/context/compaction-driver.ts'
import { createRouterCore, type RouterCoreAssemblyDeps, type RouterCoreHosts, type RouterMemory } from '../src/host/core.ts'
import { UiStateStore, type UiStatePersistence, type UiStateFile } from '../src/host/bridge/tabs.ts'
import type { FsAdapter } from '../src/shared/fs-adapter.ts'
import type { TaskRecord } from '../src/shared/types.ts'
import type { QuestionCard, WorkerTemplate } from '../src/shared/view-contract.ts'
import { task } from './helpers/task-builder.ts'

/* ────────────────────────── 假件 ────────────────────────── */

class MemoryPersistence implements LedgerPersistence {
  file: LedgerFile | null = null
  async load() {
    return this.file
  }
  async save(f: LedgerFile) {
    this.file = JSON.parse(JSON.stringify(f)) as LedgerFile
  }
}

function memoryDocs(): TaskDocStore & { files: Map<string, string> } {
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
  return Object.assign(new TaskDocStore('/proj/.router', fs), { files })
}

interface HostEvents {
  created: { opts: Record<string, unknown> }[]
  prompts: { requestId: string; sessionId: string; mode: string; text: string }[]
  renames: { sessionId: string; title: string }[]
}

function fakeHosts(opts: { failCreate?: (attempt: number) => Error | undefined; failPrompt?: Error | ((attempt: number) => Error | undefined); failSelectModel?: Error } = {}) {
  const events: HostEvents = { created: [], prompts: [], renames: [] }
  const modelSelects: { sessionId: string; provider: string; model: string }[] = []
  const statusCbs: ((sessionId: string, running: boolean) => void)[] = []
  let count = 0
  let createAttempts = 0
  let promptAttempts = 0
  const hosts: RouterCoreHosts = {
    sessionController: {
      async create(createOpts) {
        createAttempts += 1
        const failure = opts.failCreate?.(createAttempts)
        if (failure !== undefined) throw failure
        count += 1
        events.created.push({ opts: createOpts as Record<string, unknown> })
        return { sessionId: `session-${count}` }
      },
      async prompt(request) {
        promptAttempts += 1
        const failure = typeof opts.failPrompt === 'function' ? opts.failPrompt(promptAttempts) : opts.failPrompt
        if (failure !== undefined) throw failure
        events.prompts.push({
          requestId: request.requestId,
          sessionId: request.sessionId,
          mode: request.mode,
          text: request.content.map((block) => block.text).join('\n'),
        })
        return { accepted: true }
      },
      async rename(request) {
        events.renames.push({ sessionId: request.sessionId, title: request.title })
        return {}
      },
      async selectModel(request) {
        modelSelects.push(request)
        if (opts.failSelectModel !== undefined) throw opts.failSelectModel
        return { selected: request }
      },
    },
    agents: { get: () => undefined },
    workspaceRegistry: {
      list: () => [{ id: 'ws-1', path: '/proj', sessionIds: ['router-s-1'] }] as WorkspaceInfo[],
      get: (id: string) => (id === 'ws-1' ? { id: 'ws-1', path: '/proj', sessionIds: ['router-s-1'] } : undefined),
    },
    onSessionStatus(callback) {
      statusCbs.push(callback)
    },
  }
  return { hosts, events, statusCbs, modelSelects }
}

function fakeDriver(): CompactionDriver & { marked: string[] } {
  const marked: string[] = []
  const deps: CompactionDeps = {
    getAgent: () => undefined,
    async lastUserMessageSeq() {
      return null
    },
    async balancedBefore() {
      return true
    },
    async balancedAfter() {
      return true
    },
    async compactRegion() {
      return {}
    },
    now: () => 1,
  }
  const driver = new CompactionDriver(deps)
  const wrapped = new CompactionDriver({
    ...deps,
    getAgent(sessionId) {
      void sessionId
      return undefined
    },
  })
  void wrapped
  return Object.assign(driver, {
    marked,
    onDispatched(sessionId: string) {
      marked.push(sessionId)
    },
  }) as CompactionDriver & { marked: string[] }
}

function fakeUi(): UiStateStore {
  const persistence: UiStatePersistence & { file: UiStateFile } = {
    file: { schemaVersion: 1, routerSessions: [], tabs: [] },
    async load() {
      return this.file
    },
    async save(f) {
      this.file = JSON.parse(JSON.stringify(f)) as UiStateFile
    },
  }
  return new UiStateStore(persistence, () => 1)
}

const TEMPLATES: WorkerTemplate[] = [
  { templateId: 'coder', name: '编码', description: '写代码', role: 'worker' },
  { templateId: 'lead', name: '主管', description: '再拆分', role: 'supervisor' },
]

let questionSeq = 0

/** 假记忆：search 可注命中/注错，onTaskCompleted 记账。 */
function fakeMemory() {
  const completed: Array<Parameters<RouterMemory['onTaskCompleted']>[0]> = []
  let searchCalls = 0
  let searchResult: { memoryRef: string; snippet: string }[] | Error = []
  return {
    completed,
    calls: () => searchCalls,
    setHits(hits: { memoryRef: string; snippet: string }[]) {
      searchResult = hits
    },
    failSearch(error: Error) {
      searchResult = error
    },
    memory: {
      async search() {
        searchCalls += 1
        if (searchResult instanceof Error) throw searchResult
        return searchResult
      },
      onTaskCompleted(input: Parameters<RouterMemory['onTaskCompleted']>[0]) {
        completed.push(input)
      },
    } satisfies RouterMemory,
  }
}

async function coreWith(
  records: TaskRecord[] = [],
  opts: {
    memory?: RouterMemory | null
    /** v1.1 C1：类型存储投影面（缺省 = config.templates 兜底）；C2 起 createRouterType 可选。 */
    types?: {
      enabled(): WorkerTemplate[]
      summaries(): { templateId: string; name: string; description: string; role: 'supervisor' | 'worker'; enabled: boolean; origin: 'builtin' | 'user' | 'router' }[]
      createRouterType?(input: { name: string; origin?: string }): Promise<{ record: never; presetRegistered: boolean }>
    }
    /** v1.1 C1：Router 默认值（缺省 = 不钉默认模型）。 */
    routerDefaults?: { get(): Promise<{ routerSystemPrompt: string; routerModel: string }> }
    failSelectModel?: Error
    failCreate?: (attempt: number) => Error | undefined
    failPrompt?: Error | ((attempt: number) => Error | undefined)
  } = {},
) {
  const persistence = new MemoryPersistence()
  persistence.file = { schemaVersion: 1, tasks: records, nextTaskNumber: records.length + 1, questions: [] }
  const ledger = new TaskLedger(persistence, () => 1000)
  await ledger.listAll()
  const docs = memoryDocs()
  const { hosts, events, modelSelects } = fakeHosts({ failCreate: opts.failCreate, failPrompt: opts.failPrompt, failSelectModel: opts.failSelectModel })
  const ui = fakeUi()
  await ui.load()
  const bridge = new SessionBridge({
    ledger,
    docsFor: () => docs,
    workspaces: hosts.workspaceRegistry,
    host: {
      create: async (opts) => (await hosts.sessionController.create(opts)).sessionId,
      prompt: (request, signal) => hosts.sessionController.prompt(request, signal),
      onStatus: (cb) => hosts.onSessionStatus(cb),
      rename: async (sessionId, title) => {
        await hosts.sessionController.rename({ sessionId, title })
      },
    },
    presets: { supervisor: 'dsh-router-supervisor', worker: 'dsh-router-worker' },
    workerInstructions: () => '【执行指引】',
    signal: new AbortController().signal,
  })
  const relay = new AnswerRelay({ ledger, newId: () => `q-${++questionSeq}`, now: () => 1 })
  const driver = fakeDriver()
  const scheduler = new Scheduler(ledger, { maxDepth: 2, concurrency: { default: 3 } })
  const memoryState = fakeMemory()
  const memory = opts.memory === undefined ? memoryState.memory : (opts.memory ?? undefined)
  const assemblyDeps: RouterCoreAssemblyDeps = {
    ledger,
    docsFor: () => docs,
    bridge,
    relay,
    driver,
    scheduler,
    hosts,
    ui,
    config: {
      routerPreset: 'dsh-router',
      supervisorPreset: 'dsh-router-supervisor',
      workerPreset: 'dsh-router-worker',
      templates: TEMPLATES,
    },
    types: opts.types,
    routerDefaults: opts.routerDefaults,
    newId: () => `q-${++questionSeq}`,
    signal: new AbortController().signal,
    isRunning: () => false,
    memory,
    tasksDir: '.router',
  }
  const assembled = createRouterCore(assemblyDeps)
  await assembled.refreshSnapshot()
  return { ledger, docs, bridge, relay, driver, events, modelSelects, ui, memoryState, ...assembled }
}

/* ────────────────────────── 派发 ────────────────────────── */

describe('createRouterCore：dispatchTask', () => {
  it('Router 会话派发：workspace 解析、任务书落盘、桥投递、驱动打标（调用者+执行会话）、加标签', async () => {
    const { core, workbench, events, driver, ui, docs } = await coreWith()
    const result = await core.dispatchTask('router-s-1', {
      title: '修登录',
      goal: '登录不再 500',
      acceptance: ['回归通过'],
      role: 'worker',
      templateId: 'coder',
      materials: ['docs/auth.md'],
    })
    expect(result.taskId).toBe('T-001')
    expect(result.docPath).toBe('/proj/.router/tasks/T-001/task.v1.md')
    expect(result.sessionId).toBe('session-1')
    expect(events.created[0]!.opts).toEqual({ workspaceId: 'ws-1', agentPreset: 'dsh-router-worker' })
    // v1.3 规格 §3.1：标题 = `类型名 · T-xxx 任务名`（类型面缺席时退 templateId）。
    expect(events.renames[0]!.title).toBe('coder · T-001 修登录')
    expect(events.prompts[0]!.requestId).toBe('dispatch-T-001-v1')
    expect(events.prompts[0]!.text).toContain('docs/auth.md')
    // 调用者会话（Router）与执行会话都要打 pendingCompaction 标记：Router 自身
    // 的派发讨论段在 idle 后也要被压缩（裁定 5 的补齐，规格 §4）
    expect(driver.marked).toEqual(['router-s-1', 'session-1'])
    expect(ui.tabs('ws-1').map((t) => t.sessionId)).toEqual(['session-1'])
    expect(docs.files.get('/proj/.router/tasks/T-001/task.v1.md')).toContain('# 任务书 T-001')
    void workbench
  })

  it('v1.4：派发时宿主记下派发者会话（作用域紧急暂停的归属依据）', async () => {
    const { core, ledger } = await coreWith()
    const result = await core.dispatchTask('router-s-1', {
      title: '修登录',
      goal: '登录不再 500',
      acceptance: ['回归通过'],
      role: 'worker',
      templateId: 'coder',
    })
    expect(ledger.get(result.taskId)?.dispatchedBySessionId).toBe('router-s-1')
  })

  it('未知模板拒绝', async () => {
    const { core } = await coreWith()
    await expect(
      core.dispatchTask('router-s-1', {
        title: 'x',
        goal: 'y',
        acceptance: [],
        role: 'worker',
        templateId: 'nope',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('nope') })
  })

  it('worker 角色调用派发被拒（role-forbidden）', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'worker-s-1', status: 'running' })]
    const { core } = await coreWith(records)
    await expect(
      core.dispatchTask('worker-s-1', {
        title: 'x',
        goal: 'y',
        acceptance: [],
        role: 'worker',
        templateId: 'coder',
      }),
    ).rejects.toMatchObject({ code: 'role-forbidden' })
  })

  it('深度超限被拒：maxDepth=2 时主管的第二层子任务被拒', async () => {
    const records = [
      task({ id: 'T-001', role: 'supervisor', sessionId: 'sup-s-1', status: 'running', parentId: undefined }),
      task({ id: 'T-002', role: 'supervisor', sessionId: 'sup-s-2', status: 'running', parentId: 'T-001' }),
    ]
    const { core } = await coreWith(records)
    // T-002 已在深度 2，再派第三层被拒
    await expect(
      core.dispatchTask('sup-s-2', {
        title: '第三层',
        goal: 'g',
        acceptance: [],
        role: 'worker',
        templateId: 'coder',
        parentTaskId: 'T-002',
      }),
    ).rejects.toMatchObject({ code: 'depth-exceeded' })
  })

  it('依赖命中祖先链被拒（cycle-risk）', async () => {
    const records = [task({ id: 'T-001', role: 'supervisor', sessionId: 'sup-s-1', status: 'running' })]
    const { core } = await coreWith(records)
    await expect(
      core.dispatchTask('sup-s-1', {
        title: '环任务',
        goal: 'g',
        acceptance: [],
        role: 'worker',
        templateId: 'coder',
        parentTaskId: 'T-001',
        dependsOn: [{ taskId: 'T-001' }],
      }),
    ).rejects.toMatchObject({ code: 'cycle-risk' })
  })

  it('未解析到 workspace 时回退 cwd 伪项目', async () => {
    const { core, ledger } = await coreWith()
    const result = await core.dispatchTask('stranger-s', {
      title: 't',
      goal: 'g',
      acceptance: [],
      role: 'worker',
      templateId: 'coder',
    })
    expect(result.sessionId).toBe('session-1')
    const record = ledger.get(result.taskId)
    expect(record?.cwd).toBe(process.cwd())
    expect(record?.projectId).toContain('cwd:')
    expect(ledger.get(result.taskId)?.status).toBe('dispatched')
  })
})

/* ────────────────────────── 派发失败语义（v1.1 Task A4） ────────────────────────── */

describe('createRouterCore：派发失败语义（v1.1 A4）', () => {
  const INPUT = {
    title: '修登录',
    goal: '登录不再 500',
    acceptance: ['回归通过'],
    role: 'worker' as const,
    templateId: 'coder',
  }

  it('建会话失败：任务回 draft、错误落 progress、retryCount+1，不留 cancelled 空壳', async () => {
    const { core, ledger, ui } = await coreWith([], { failCreate: () => new Error('preset row never started') })
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    const record = ledger.get('T-001')
    expect(record?.status).toBe('draft')
    expect(record?.retryCount).toBe(1)
    expect(record?.progress).toContain('preset row never started')
    expect(record?.sessionId).toBeUndefined()
    expect(ui.tabs('ws-1')).toEqual([])
  })

  it('投递失败（会话已建）：session 保留供重试、状态仍 draft、retryCount+1', async () => {
    const { core, ledger } = await coreWith([], { failPrompt: new Error('prompt rejected by host') })
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    const record = ledger.get('T-001')
    expect(record?.status).toBe('draft')
    expect(record?.sessionId).toBe('session-1')
    expect(record?.retryCount).toBe(1)
    expect(record?.progress).toContain('prompt rejected by host')
  })

  it('同一任务重试累计：dispatch 失败后经 supplement 重派，3 次失败自动 blocked 并通知', async () => {
    const { core, ledger, events } = await coreWith([], { failCreate: () => new Error('boom') })
    // 第 1 次：dispatch_task 失败 → draft、rc=1
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    expect(ledger.get('T-001')?.status).toBe('draft')
    expect(ledger.get('T-001')?.retryCount).toBe(1)
    // 第 2 次：supplement_task 重派（任务无会话）→ 仍失败、rc=2、不通知
    await expect(core.supplementTask('router-s-1', 'T-001', ['改用稳态模板'])).rejects.toMatchObject({ code: 'dispatch-failed' })
    expect(ledger.get('T-001')?.status).toBe('draft')
    expect(ledger.get('T-001')?.retryCount).toBe(2)
    expect(events.prompts.some((p) => p.requestId.startsWith('dispatch-blocked'))).toBe(false)
    // 第 3 次：达上限 → blocked + 通知调用方
    await expect(core.supplementTask('router-s-1', 'T-001', ['再试一次'])).rejects.toMatchObject({ code: 'dispatch-failed' })
    expect(ledger.get('T-001')?.status).toBe('blocked')
    expect(ledger.get('T-001')?.retryCount).toBe(3)
    const notice = events.prompts.find((p) => p.requestId === 'dispatch-blocked-T-001')
    expect(notice).toBeDefined()
    expect(notice!.sessionId).toBe('router-s-1')
    expect(notice!.text).toContain('3')
  })

  it('封顶后不再重试：blocked 任务的 supplement 只升版不派发，retryCount 停在 3', async () => {
    const { core, ledger, events } = await coreWith([], { failCreate: () => new Error('boom') })
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    await expect(core.supplementTask('router-s-1', 'T-001', ['第一次重试'])).rejects.toMatchObject({ code: 'dispatch-failed' })
    await expect(core.supplementTask('router-s-1', 'T-001', ['第二次重试'])).rejects.toMatchObject({ code: 'dispatch-failed' })
    expect(ledger.get('T-001')?.status).toBe('blocked')
    expect(ledger.get('T-001')?.retryCount).toBe(3)
    expect(events.prompts.filter((p) => p.requestId === 'dispatch-blocked-T-001')).toHaveLength(1)
    // 封顶后的 supplement：只升版（前两次补充已到 v3，这次到 v4），不再派发
    const result = await core.supplementTask('router-s-1', 'T-001', ['后续补充'])
    expect(result.docVersion).toBe(4)
    expect(ledger.get('T-001')?.retryCount).toBe(3)
    expect(events.prompts.filter((p) => p.requestId === 'dispatch-blocked-T-001')).toHaveLength(1)
  })

  it('解锁派发失败：queued 任务记账（rc=1、progress 落错）保持 queued 不留空壳', async () => {
    const records = [
      task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' }),
      task({ id: 'T-010', role: 'worker', status: 'queued', dependsOn: ['T-001'], projectId: 'ws-1', cwd: '/proj', title: '解锁后失败' }),
    ]
    const { core, ledger, docs } = await coreWith(records, { failCreate: () => new Error('boom') })
    await docs.initTask(ledger.get('T-010')!, '# 任务书 T-010')
    await core.completeTask('session-9', 'T-001', { docVersion: 1, summary: '依赖完' })
    expect(ledger.get('T-010')?.status).toBe('queued')
    expect(ledger.get('T-010')?.retryCount).toBe(1)
    expect(ledger.get('T-010')?.progress).toContain('boom')
    expect(ledger.get('T-001')?.status).toBe('completed')
  })

  it('未知或已禁用模板抛 template-unavailable，错误带 available 清单', async () => {
    const { core } = await coreWith()
    try {
      await core.dispatchTask('router-s-1', { ...INPUT, templateId: 'nope' })
      expect.unreachable()
    } catch (error) {
      expect((error as LedgerError).code).toBe('template-unavailable')
      expect((error as { available?: string[] }).available).toEqual(['coder', 'lead'])
      expect((error as Error).message).toContain('nope')
      expect((error as Error).message).toContain('coder')
    }
  })
})

/* ────────────────────────── 补充 / 查询 / 控制 ────────────────────────── */

describe('createRouterCore：supplement / query / control', () => {
  it('supplementTask：账本升版 + 文档升版 + 重投原会话 + 驱动打标（执行会话+调用者）', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' })]
    const { core, ledger, docs, events, driver } = await coreWith(records)
    await docs.initTask(ledger.get('T-001')!, '# 任务书 T-001')
    const result = await core.supplementTask('router-s-1', 'T-001', ['补充：用 PostgreSQL'])
    expect(result.docVersion).toBe(2)
    expect(events.prompts[0]!.requestId).toBe('dispatch-T-001-v2')
    expect(events.prompts[0]!.sessionId).toBe('session-9')
    // 补充也是一次成功转交：执行会话与调用者（Router）都打标
    expect(driver.marked).toEqual(['session-9', 'router-s-1'])
    expect(ledger.get('T-001')?.constraints).toContain('补充：用 PostgreSQL')
  })

  it('queryTasks：卡映射 + 待答计数 + 状态过滤', async () => {
    const records = [
      task({ id: 'T-001', role: 'worker', sessionId: 's1', status: 'running', title: '一号' }),
      task({ id: 'T-002', role: 'worker', sessionId: 's2', status: 'completed', title: '二号' }),
    ]
    const { core, ledger, relay } = await coreWith(records)
    await ledger.addQuestion({ id: 'q-1', taskId: 'T-001', question: '？', status: 'open', createdAt: 1 })
    const all = await core.queryTasks()
    expect(all.tasks.map((t) => t.taskId)).toEqual(['T-001', 'T-002'])
    expect(all.tasks[0]!.waitingQuestions).toBe(1)
    const running = await core.queryTasks({ status: ['running'] })
    expect(running.tasks.map((t) => t.taskId)).toEqual(['T-001'])
    const cards = relay.pendingCards()
    expect(cards).toHaveLength(0)
  })

  it('controlTask pause/resume：走状态机并 steer 通知执行会话', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running' })]
    const { core, ledger, events } = await coreWith(records)
    const paused = await core.controlTask('router-s-1', 'T-001', 'pause')
    expect(paused.status).toBe('paused')
    expect(ledger.get('T-001')?.status).toBe('paused')
    expect(events.prompts[0]!.mode).toBe('steer')
    expect(events.prompts[0]!.text).toContain('暂停')
    const resumed = await core.controlTask('router-s-1', 'T-001', 'resume')
    expect(resumed.status).toBe('running')
    expect(events.prompts[1]!.text).toContain('继续')
  })

  it('controlTask cancel：cancelled + 取消通知', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running' })]
    const { core, ledger, events } = await coreWith(records)
    const result = await core.controlTask('router-s-1', 'T-001', 'cancel')
    expect(result.status).toBe('cancelled')
    expect(ledger.get('T-001')?.status).toBe('cancelled')
    expect(events.prompts[0]!.requestId).toBe('cancel-T-001')
  })

  it('controlTask 非法迁移照抛（queued 不能 pause）', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'queued' })]
    const { core } = await coreWith(records)
    await expect(core.controlTask('router-s-1', 'T-001', 'pause')).rejects.toMatchObject({ code: 'illegal-transition' })
  })
})

/* ────────────────────────── 完成协议 ────────────────────────── */

describe('createRouterCore：completeTask', () => {
  it('auto 策略：完成 + result.md + 解锁依赖自动派发 + 通知上级', async () => {
    const records = [
      task({ id: 'T-000', role: 'supervisor', sessionId: 'sup-s-1', status: 'running', title: '父任务' }),
      task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', parentId: 'T-000' }),
      task({ id: 'T-002', role: 'worker', status: 'queued', dependsOn: ['T-001'], projectId: 'ws-1', cwd: '/proj', title: '解锁后可派' }),
    ]
    const { core, ledger, docs, events, driver } = await coreWith(records)
    // 解锁目标 T-002 的任务书（生产路径：任务创建时即落盘）
    await docs.initTask(ledger.get('T-002')!, `# 任务书 T-002`)
    const result = await core.completeTask('session-9', 'T-001', {
      docVersion: 1,
      summary: '做完了',
      deliverables: ['/proj/a.txt'],
      acceptanceEvidence: '测试绿',
    })
    expect(result.accepted).toBe(true)
    expect(result.status).toBe('completed')
    expect(docs.files.get('/proj/.router/tasks/T-001/result.md')).toContain('做完了')
    // 依赖解锁的 T-002 自动派发（无会话 → 建会话投递）
    expect(ledger.get('T-002')?.status).toBe('dispatched')
    expect(ledger.get('T-002')?.sessionId).toBe('session-1')
    expect(driver.marked).toContain('session-1')
    // 通知上级会话
    const notice = events.prompts.find((p) => p.requestId === 'notice-T-001-completed')
    expect(notice?.sessionId).toBe('sup-s-1')
    expect(notice?.text).toContain('T-001')
  })

  it('有未结子任务 → review-pending（accepted=false，pendingFrom=supervisor）', async () => {
    const records = [
      task({ id: 'T-001', role: 'supervisor', sessionId: 'sup-s-1', status: 'running' }),
      task({ id: 'T-002', role: 'worker', sessionId: 'session-2', status: 'running', parentId: 'T-001' }),
    ]
    const { core, ledger } = await coreWith(records)
    const result = await core.completeTask('sup-s-1', 'T-001', { docVersion: 1, summary: '主体完成' })
    expect(result).toEqual({ accepted: false, status: 'review-pending', pendingFrom: 'supervisor' })
    expect(ledger.get('T-001')?.status).toBe('review-pending')
  })

  it('旧 worker 迟到提交：stale-version 照抛', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', docVersion: 2 })]
    const { core } = await coreWith(records)
    await expect(core.completeTask('session-9', 'T-001', { docVersion: 1, summary: 'x' })).rejects.toMatchObject({
      code: 'stale-version',
    })
  })

  it('非本会话的执行者提交被拒（not-task-owner）', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running' })]
    const { core } = await coreWith(records)
    await expect(core.completeTask('stranger-s', 'T-001', { docVersion: 1, summary: 'x' })).rejects.toMatchObject({
      code: 'not-task-owner',
    })
  })

  it('完成触发记忆：project 层拿到 taskId/标题/摘要/result.md 相对路径/执行会话', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', title: '修登录', projectId: 'ws-1', cwd: '/proj' })]
    const { core, memoryState } = await coreWith(records)
    await core.completeTask('session-9', 'T-001', { docVersion: 1, summary: '登录 500 已修复' })
    expect(memoryState.completed).toEqual([
      {
        taskId: 'T-001',
        title: '修登录',
        summary: '登录 500 已修复',
        resultRelPath: '.router/tasks/T-001/result.md',
        sessionId: 'session-9',
      },
    ])
  })

  it('review-pending 与幂等重提不触发记忆（只有首次 completed 才写）', async () => {
    const records = [
      task({ id: 'T-001', role: 'supervisor', sessionId: 'sup-s-1', status: 'running' }),
      task({ id: 'T-002', role: 'worker', sessionId: 'session-2', status: 'running' }),
      task({ id: 'T-003', role: 'worker', sessionId: 'session-3', status: 'running', parentId: 'T-001' }),
    ]
    const { core, memoryState } = await coreWith(records)
    // 有未结子任务 → review-pending：不触发
    await core.completeTask('sup-s-1', 'T-001', { docVersion: 1, summary: '主体完成' })
    expect(memoryState.completed).toEqual([])
    // 首次完成：触发一次
    await core.completeTask('session-2', 'T-002', { docVersion: 1, summary: '全部完成' })
    expect(memoryState.completed).toHaveLength(1)
    // 幂等重提：不重复触发
    await core.completeTask('session-2', 'T-002', { docVersion: 1, summary: '全部完成' })
    expect(memoryState.completed).toHaveLength(1)
  })
})

/* ────────────────────────── 进度 / 阻塞 / 记忆 ────────────────────────── */

describe('createRouterCore：progress / blocker / search', () => {
  it('reportProgress：账本进度 + progress.md', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' })]
    const { core, docs, ledger } = await coreWith(records)
    await core.reportProgress('session-9', 'T-001', '完成一半')
    expect(ledger.get('T-001')?.progress).toBe('完成一半')
    expect(docs.files.get('/proj/.router/tasks/T-001/progress.md')).toContain('完成一半')
  })

  it('reportBlocker：blocked + 原因落进度', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running' })]
    const { core, ledger } = await coreWith(records)
    const result = await core.reportBlocker('session-9', 'T-001', '缺凭据')
    expect(result.status).toBe('blocked')
    expect(ledger.get('T-001')?.progress).toBe('缺凭据')
  })

  it('searchHistory：接真记忆检索，命中与查询词直传', async () => {
    const { core, memoryState } = await coreWith()
    memoryState.setHits([{ memoryRef: 'memory://project.md#e1', snippet: '登录 500 已修复' }])
    const result = await core.searchHistory('router-s-1', '登录', 'project')
    expect(result).toEqual({ hits: [{ memoryRef: 'memory://project.md#e1', snippet: '登录 500 已修复' }] })
    expect(memoryState.calls()).toBe(1)
  })

  it('searchHistory：记忆检索抛错不外抛——空命中+失败注记（模型可见的诚实降级）', async () => {
    const { core, memoryState } = await coreWith()
    memoryState.failSearch(new Error('disk on fire'))
    const result = await core.searchHistory('router-s-1', '任意', 'global')
    expect(result).toEqual({ hits: [], note: '记忆检索失败' })
  })

  it('searchHistory：未装配记忆服务时返回注记（防御性，不伪装成功）', async () => {
    const { core } = await coreWith([], { memory: null })
    expect(await core.searchHistory('router-s-1', '任意', 'project')).toEqual({
      hits: [],
      note: '记忆服务未配置',
    })
  })
})

/* ────────────────────────── 工作台面 ────────────────────────── */

describe('createRouterCore：workbench', () => {
  it('createRouterSession：按 Router 预设建会话、改名、登记', async () => {
    const { workbench, events, ui } = await coreWith()
    const created = await workbench.createRouterSession('ws-1', '我的 Router')
    expect(created.sessionId).toBe('session-1')
    expect(events.created[0]!.opts).toEqual({ workspaceId: 'ws-1', agentPreset: 'dsh-router' })
    expect(events.renames[0]!.title).toBe('我的 Router')
    expect(ui.routerSessions()).toEqual([{ sessionId: 'session-1', title: '我的 Router' }])
  })

  it('state：routerSessions/tasks/questions/tabs/templates 全拼装；tabs 按 workspace 过滤', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', title: '一号' })]
    const { workbench, ui, ledger } = await coreWith(records)
    await ledger.addQuestion({ id: 'q-1', taskId: 'T-001', question: '？', status: 'open', createdAt: 1 })
    await ui.addTab('ws-1', 'session-9', 'T-001')
    await ui.addRouterSession('router-s-1', 'ws-1', 'Router')
    const state = await workbench.state('ws-1')
    expect(state.routerSessions).toEqual([{ sessionId: 'router-s-1', title: 'Router' }])
    expect(state.tasks.map((t) => t.taskId)).toEqual(['T-001'])
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]!.taskId).toBe('T-001')
    expect(state.tabs[0]!.running).toBe(false)
    expect(state.templates).toEqual(TEMPLATES)
    // 其它 workspace 没有标签
    const other = await workbench.state('ws-other')
    expect(other.tabs).toEqual([])
  })

  it('closeTab 移除标签；answerQuestion 走问答桥', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running' })]
    const { workbench, ui, relay, ledger } = await coreWith(records)
    await ui.addTab('ws-1', 'session-9', 'T-001')
    expect(await workbench.closeTab('ws-1', 'session-9')).toBe(true)
    expect(ui.tabs('ws-1')).toEqual([])
    const claim = relay.claimQuestion({ questions: [{ id: 'a1', question: '？' }], agent: { id: 'session-9' } }, async () => 'next')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const questionId = relay.pendingCards()[0]!.questionId
    await workbench.answerQuestion(questionId, [{ id: 'a1', selected: ['x'] }])
    await expect(claim).resolves.toEqual({ answers: [{ id: 'a1', selected: ['x'] }] })
    const record = await ledger.findQuestion(questionId)
    expect(record?.status).toBe('answered')
  })

  it('pendingQuestions 暴露浮窗数据', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running' })]
    const { workbench, relay } = await coreWith(records)
    const claim = relay.claimQuestion({ questions: [{ id: 'a1', question: '？' }], agent: { id: 'session-9' } }, async () => 'next')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const cards: QuestionCard[] = workbench.pendingQuestions()
    expect(cards).toHaveLength(1)
    await relay.answerQuestion(cards[0]!.questionId, [{ id: 'a1', selected: [] }])
    await claim
  })

  it('空壳清理（v1.1 C6）：标签条过滤「cancelled/failed 且无会话」的任务，账本记录保留不删档', async () => {
    const records = [
      // 空壳：cancelled 且无会话 → 标签条不显示（账本记录仍在）
      task({ id: 'T-001', role: 'worker', status: 'cancelled', title: '空壳取消' }),
      // 空壳：failed 且无会话 → 同上
      task({ id: 'T-002', role: 'worker', status: 'failed', title: '空壳失败' }),
      // cancelled 但有会话 → 保留标签（用户可能要看会话）
      task({ id: 'T-003', role: 'worker', sessionId: 'session-3', status: 'cancelled', title: '正常取消' }),
    ]
    const { workbench, ui, ledger, snapshotText, refreshSnapshot } = await coreWith(records)
    await ui.addTab('ws-1', 'stale-1', 'T-001')
    await ui.addTab('ws-1', 'stale-2', 'T-002')
    await ui.addTab('ws-1', 'session-3', 'T-003')
    const state = await workbench.state('ws-1')
    expect(state.tabs.map((t) => t.sessionId)).toEqual(['session-3'])
    // 清理只影响投影：账本文件记录保留（归档可查）
    expect(ledger.get('T-001')?.status).toBe('cancelled')
    expect(ledger.get('T-002')?.status).toBe('failed')
    // 活动快照同步隐藏空壳（cancelled 本就不进快照，completed/终态规则不变）
    await refreshSnapshot()
    expect(snapshotText()).not.toContain('空壳取消')
    expect(snapshotText()).not.toContain('空壳失败')
  })
})

/* ────────────────────────── 快照 ────────────────────────── */

describe('createRouterCore：快照缓存', () => {
  it('refreshSnapshot 后 snapshotText 同步可读；账本变化后刷新即更新', async () => {
    const { core, ledger, snapshotText, refreshSnapshot } = await coreWith()
    expect(snapshotText()).toContain('没有未结束任务')
    await ledger.createTask({ title: '新任务', goal: 'g', projectId: 'ws-1', cwd: '/proj', role: 'worker', templateId: 'coder' })
    await refreshSnapshot()
    expect(snapshotText()).toContain('新任务')
    expect(snapshotText()).not.toContain('没有未结束任务')
    void core
  })
})

/* ────────────────────────── 评审修复：重派记账/依赖闸门/并发串行 ────────────────────────── */

describe('createRouterCore：评审修复（重派记账 / 依赖闸门 / 并发串行）', () => {
  const INPUT = {
    title: '修登录',
    goal: '登录不再 500',
    acceptance: ['回归通过'],
    role: 'worker' as const,
    templateId: 'coder',
  }

  it('依赖未满足的 queued 任务：supplement 只升版，不提前派发', async () => {
    const records = [
      task({ id: 'T-001', role: 'worker', status: 'queued', dependsOn: ['T-999'], projectId: 'ws-1', cwd: '/proj' }),
    ]
    const { core, ledger, docs, events } = await coreWith(records)
    await docs.initTask(ledger.get('T-001')!, '# 任务书 T-001')
    const result = await core.supplementTask('router-s-1', 'T-001', ['补充约束'])
    expect(result.docVersion).toBe(2)
    expect(ledger.get('T-001')?.status).toBe('queued')
    expect(ledger.get('T-001')?.sessionId).toBeUndefined()
    expect(ledger.get('T-001')?.retryCount ?? 0).toBe(0)
    expect(events.created).toEqual([])
  })

  it('会话已建的 draft 任务：重投失败同口径记账（rc+1、dispatch-failed）', async () => {
    const { core, ledger } = await coreWith([], {
      failPrompt: (attempt) => (attempt <= 2 ? new Error('prompt down') : undefined),
    })
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    expect(ledger.get('T-001')?.sessionId).toBe('session-1')
    expect(ledger.get('T-001')?.retryCount).toBe(1)
    await expect(core.supplementTask('router-s-1', 'T-001', ['修正后重投'])).rejects.toMatchObject({ code: 'dispatch-failed' })
    expect(ledger.get('T-001')?.retryCount).toBe(2)
    expect(ledger.get('T-001')?.status).toBe('draft')
    expect(ledger.get('T-001')?.progress).toContain('prompt down')
  })

  it('会话已建的 draft 任务：重投成功 → dispatched + 挂标签 + 驱动打标', async () => {
    const { core, ledger, ui, driver } = await coreWith([], {
      failPrompt: (attempt) => (attempt === 1 ? new Error('prompt down once') : undefined),
    })
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    expect(ledger.get('T-001')?.status).toBe('draft')
    const result = await core.supplementTask('router-s-1', 'T-001', ['恢复后续投'])
    expect(result.docVersion).toBe(2)
    expect(ledger.get('T-001')?.status).toBe('dispatched')
    expect(ui.tabs('ws-1').map((t) => t.sessionId)).toEqual(['session-1'])
    expect(driver.marked).toContain('session-1')
    expect(driver.marked).toContain('router-s-1')
  })

  it('running 任务的 supplement 重投不受影响（无状态迁移、失败照原样抛）', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' })]
    const { core, ledger, docs } = await coreWith(records, { failPrompt: new Error('re-prompt rejected') })
    await docs.initTask(ledger.get('T-001')!, '# 任务书 T-001')
    await expect(core.supplementTask('router-s-1', 'T-001', ['补充'])).rejects.toThrowError(/re-prompt rejected/)
    expect(ledger.get('T-001')?.status).toBe('running')
    expect(ledger.get('T-001')?.retryCount).toBeUndefined()
    expect(ledger.get('T-001')?.docVersion).toBe(2)
  })

  it('并发补充同一任务：串行化重派，封顶不破（rc 停 3、只通知一次、无非法迁移）', async () => {
    const { core, ledger, events } = await coreWith([], { failCreate: () => new Error('boom') })
    await expect(core.dispatchTask('router-s-1', { ...INPUT })).rejects.toMatchObject({ code: 'dispatch-failed' })
    // 串行化后两次补充都获得重派机会（rc 1→2→3），但计数封顶、状态只封一次
    const outcomes = await Promise.allSettled([
      core.supplementTask('router-s-1', 'T-001', ['并发一']),
      core.supplementTask('router-s-1', 'T-001', ['并发二']),
    ])
    expect(ledger.get('T-001')?.status).toBe('blocked')
    expect(ledger.get('T-001')?.retryCount).toBe(3)
    expect(events.prompts.filter((p) => p.requestId === 'dispatch-blocked-T-001')).toHaveLength(1)
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected')
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'dispatch-failed' })
    }
  })
})

/* ────────────────────────── v1.1 C1：类型投影与默认值 ────────────────────────── */

const STORE_TYPES = {
  enabled: () => [
    { templateId: 'general', name: '通用 worker', description: '内置', role: 'worker' as const },
    { templateId: 'coder', name: '编码', description: '写代码', role: 'worker' as const },
  ],
  summaries: () => [
    { templateId: 'general', name: '通用 worker', description: '内置', role: 'worker' as const, enabled: true, origin: 'builtin' as const },
    { templateId: 'coder', name: '编码', description: '写代码', role: 'worker' as const, enabled: true, origin: 'user' as const },
    { templateId: 'lead', name: '主管', description: '再拆分', role: 'supervisor' as const, enabled: false, origin: 'user' as const },
  ],
}

describe('createRouterCore：v1.1 类型工具（C2）', () => {
  /** STORE_TYPES + createRouterType 面（记录引擎同步调用）。 */
  function creatableTypes() {
    const created: { name: string; origin?: string }[] = []
    let duplicateName: string | null = null
    let syncFail = false
    return {
      created,
      get duplicateName() {
        return duplicateName
      },
      setDuplicate(name: string) {
        duplicateName = name
      },
      setSyncFail() {
        syncFail = true
      },
      face: {
        enabled: STORE_TYPES.enabled,
        summaries: STORE_TYPES.summaries,
        async createRouterType(input: { name: string; origin?: string }) {
          if (duplicateName !== null && input.name === duplicateName) {
            throw new LedgerError('template-exists', `同名 worker 类型已存在: ${input.name}`)
          }
          created.push(input)
          return {
            record: { templateId: `id-for-${input.name}` } as never,
            presetRegistered: !syncFail,
          }
        },
      },
    }
  }

  it('createWorkerType 经 createRouterType 创建并带回 templateId + presetRegistered（origin=router 由 face 决定）', async () => {
    const types = creatableTypes()
    const { core } = await coreWith([], { types: types.face })
    const value = await core.createWorkerType('router-s-1', { name: '文档写手', systemPrompt: '写文档' })
    expect(value).toEqual({ templateId: 'id-for-文档写手', presetRegistered: true })
    expect(types.created[0]).toMatchObject({ name: '文档写手' })
  })

  it('重名拒绝（template-exists）原样抛出', async () => {
    const types = creatableTypes()
    types.setDuplicate('编码')
    const { core } = await coreWith([], { types: types.face })
    await expect(core.createWorkerType('router-s-1', { name: '编码', systemPrompt: 'x' })).rejects.toMatchObject({
      code: 'template-exists',
    })
    expect(types.created).toHaveLength(0)
  })

  it('face 缺 createRouterType（未接线）→ types-unavailable 拒绝，不静默', async () => {
    const { core } = await coreWith([], { types: STORE_TYPES })
    await expect(core.createWorkerType('router-s-1', { name: 'x', systemPrompt: 'x' })).rejects.toMatchObject({
      code: 'types-unavailable',
    })
  })

  it('listWorkerTypes 用类型存储摘要（含禁用与来源）', async () => {
    const { core } = await coreWith([], { types: STORE_TYPES })
    expect(core.listWorkerTypes()).toEqual(STORE_TYPES.summaries())
  })

  it('没接类型存储时 listWorkerTypes 从 config.templates 推导（enabled=true, origin=user）', async () => {
    const { core } = await coreWith([])
    expect(core.listWorkerTypes()).toEqual(TEMPLATES.map((t) => ({ ...t, enabled: true, origin: 'user' })))
  })
})

describe('createRouterCore：v1.1 类型投影', () => {
  it('enabledTemplates 来自类型存储投影（禁用类型不在清单，dispatch 校验随之收紧）', async () => {
    const { core } = await coreWith([], { types: STORE_TYPES })
    expect(core.enabledTemplates().map((t) => t.templateId)).toEqual(['general', 'coder'])
    await expect(core.dispatchTask('router-s-1', {
      title: 'x', goal: 'x', acceptance: ['x'], role: 'worker', templateId: 'lead',
    })).rejects.toMatchObject({ code: 'template-unavailable', available: ['general', 'coder'] })
  })

  it('state().types 摘要投影带 enabled/origin；templates 仍为启用类型', async () => {
    const { workbench } = await coreWith([], { types: STORE_TYPES })
    const state = await workbench.state('ws-1')
    expect(state.types).toEqual(STORE_TYPES.summaries())
    expect(state.templates.map((t) => t.templateId)).toEqual(['general', 'coder'])
  })

  it('没接类型存储时退回 config.templates（types 投影从 config 推导，client 兼容不破）', async () => {
    const { core, workbench } = await coreWith()
    expect(core.enabledTemplates()).toEqual(TEMPLATES)
    const state = await workbench.state('ws-1')
    expect(state.templates).toEqual(TEMPLATES)
    expect(state.types).toEqual(TEMPLATES.map((t) => ({ ...t, enabled: true, origin: 'user' })))
  })
})

describe('createRouterCore：Router 默认值钉定', () => {
  it('createRouterSession 在建会话后把 defaults.routerModel 设进该会话', async () => {
    const { workbench, events, modelSelects } = await coreWith([], {
      routerDefaults: { get: async () => ({ routerSystemPrompt: 'x', routerModel: 'deepseek-official/deepseek-flash' }) },
    })
    await workbench.createRouterSession('ws-1', 'Router')
    expect(events.created[0]!.opts.agentPreset).toBe('dsh-router')
    expect(modelSelects).toEqual([{ sessionId: 'session-1', provider: 'deepseek-official', model: 'deepseek-flash' }])
  })

  it('钉定失败只告警，不挡 Router 会话创建', async () => {
    const { workbench, modelSelects } = await coreWith([], {
      routerDefaults: { get: async () => ({ routerSystemPrompt: 'x', routerModel: 'p/m' }) },
      failSelectModel: new Error('session/model-unavailable'),
    })
    const created = await workbench.createRouterSession('ws-1')
    expect(created.sessionId).toBe('session-1')
    expect(modelSelects).toHaveLength(1)
  })

  it('defaults 未接或模型为空 → 不调用 selectModel（跟随宿主默认）', async () => {
    const bare = await coreWith([], {})
    await bare.workbench.createRouterSession('ws-1')
    expect(bare.modelSelects).toHaveLength(0)
    const empty = await coreWith([], { routerDefaults: { get: async () => ({ routerSystemPrompt: 'x', routerModel: '' }) } })
    await empty.workbench.createRouterSession('ws-1')
    expect(empty.modelSelects).toHaveLength(0)
  })
})
