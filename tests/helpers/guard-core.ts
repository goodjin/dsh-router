/**
 * guard 测试共享装配（v1.2 Task B1/B2）：真 RouterCore + 假宿主面，熔断器
 * （内存 FsAdapter）按 opts 注入。与 router-core.spec.ts 的 coreWith 同款收敛：
 * 领域件全部真实现，只有宿主调用面是假件。
 */

import { LedgerError } from '../../src/host/ledger/errors.ts'
import { TaskLedger, type LedgerPersistence, type LedgerFile } from '../../src/host/ledger/store.ts'
import { Scheduler } from '../../src/host/ledger/scheduler.ts'
import { TaskDocStore } from '../../src/host/docs/task-docs.ts'
import { SessionBridge, type SessionBridgeHost, type WorkspaceInfo, type AgentInterruptFace } from '../../src/host/bridge/sessions.ts'
import { AnswerRelay } from '../../src/host/bridge/questions.ts'
import { CompactionDriver, type CompactionDeps } from '../../src/host/context/compaction-driver.ts'
import { UiStateStore, type UiStatePersistence, type UiStateFile } from '../../src/host/bridge/tabs.ts'
import { CircuitBreaker } from '../../src/host/guard/breaker.ts'
import { DispatchBudgets } from '../../src/host/guard/budgets.ts'
import type { NotificationSink } from '../../src/host/guard/notifications.ts'
import { createRouterCore, type RouterCoreAssemblyDeps, type RouterCoreHosts } from '../../src/host/core.ts'
import { makeMemFs, type MemFs } from './mem-fs.ts'
import type { FsAdapter } from '../../src/shared/fs-adapter.ts'
import type { TaskRecord } from '../../src/shared/types.ts'
import type { WorkerTemplate } from '../../src/shared/view-contract.ts'
import { task } from './task-builder.ts'

export const GUARD_TEMPLATES: WorkerTemplate[] = [
  { templateId: 'coder', name: '编码', description: '写代码', role: 'worker' },
  { templateId: 'lead', name: '主管', description: '再拆分', role: 'supervisor' },
]

class MemoryPersistence implements LedgerPersistence {
  file: LedgerFile | null = null
  async load() {
    return this.file
  }
  async save(f: LedgerFile) {
    this.file = JSON.parse(JSON.stringify(f)) as LedgerFile
  }
}

function looseDocs(): TaskDocStore & { files: Map<string, string> } {
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

function fakeHosts(opts: { failCreate?: (attempt: number) => Error | undefined; failPrompt?: Error | ((attempt: number) => Error | undefined) } = {}) {
  const events: HostEvents = { created: [], prompts: [], renames: [] }
  const statusCbs: ((sessionId: string, running: boolean) => void)[] = []
  let count = 0
  let createAttempts = 0
  let promptAttempts = 0
  const sessionCreate = async (createOpts: { workspaceId?: string; cwd?: string; agentPreset?: string }) => {
    createAttempts += 1
    const failure = opts.failCreate?.(createAttempts)
    if (failure !== undefined) throw failure
    count += 1
    events.created.push({ opts: createOpts as Record<string, unknown> })
    return { sessionId: `session-${count}` }
  }
  const hosts: RouterCoreHosts = {
    sessionController: {
      create: sessionCreate,
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
  /** 派发给 SessionBridge 的宿主面（同一批假件的桥接视图）。 */
  const bridgeHost: SessionBridgeHost = {
    create: async (opts) => (await sessionCreate(opts)).sessionId,
    prompt: (request, signal) => hosts.sessionController.prompt(request, signal),
    onStatus: (cb) => hosts.onSessionStatus(cb),
    rename: async (sessionId, title) => {
      await hosts.sessionController.rename({ sessionId, title })
    },
  }
  return { hosts, bridgeHost, events, statusCbs }
}

function fakeDriver(): CompactionDriver {
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
  return Object.assign(driver, {
    marked: [] as string[],
    onDispatched(sessionId: string) {
      this.marked.push(sessionId)
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

export interface GuardCoreOptions {
  /** 注入通知 sink（v1.2 B3；缺省 = 无通知）。 */
  notifications?: NotificationSink
  records?: TaskRecord[]
  failCreate?: (attempt: number) => Error | undefined
  failPrompt?: Error | ((attempt: number) => Error | undefined)
  /** 注入预制熔断器（缺省 = memfs 新建，时钟取 opts.now；显式 null = 不接熔断器）。 */
  breaker?: CircuitBreaker | null
  /** 注入预制预算（缺省 = 新建默认预算 1/1/3；显式 null = 不接预算层）。 */
  budgets?: DispatchBudgets | null
  /** agents 中断面（v1.2 B4 紧急暂停；缺席 = 中断面未接线，逐项如实 failed）。 */
  interruptFace?: AgentInterruptFace
  /** 全局时钟（breaker 默认件与核心记账共用；缺省恒 1000）。 */
  now?: () => number
}

export async function guardCoreWith(opts: GuardCoreOptions = {}) {
  const records = opts.records ?? []
  const now = opts.now ?? (() => 1000)
  const persistence = new MemoryPersistence()
  persistence.file = { schemaVersion: 1, tasks: records, nextTaskNumber: records.length + 1, questions: [] }
  const ledger = new TaskLedger(persistence, now)
  await ledger.listAll()
  const docs = looseDocs()
  const { hosts, bridgeHost, events, statusCbs } = fakeHosts({ failCreate: opts.failCreate, failPrompt: opts.failPrompt })
  const ui = fakeUi()
  await ui.load()
  const bridge = new SessionBridge({
    ledger,
    docsFor: () => docs,
    workspaces: hosts.workspaceRegistry,
    host: bridgeHost,
    presets: { supervisor: 'dsh-router-supervisor', worker: 'dsh-router-worker' },
    workerInstructions: () => '【执行指引】',
    interruptFace: opts.interruptFace,
    signal: new AbortController().signal,
  })
  const relay = new AnswerRelay({ ledger, newId: () => `q-${Math.random()}`, now })
  const driver = fakeDriver()
  const scheduler = new Scheduler(ledger, { maxDepth: 2, concurrency: { default: 3 } })
  const memfs: MemFs = makeMemFs()
  await memfs.fs.mkdirp('/guard')
  const breaker = opts.breaker === null ? undefined : opts.breaker ?? new CircuitBreaker({ fs: memfs.fs, path: '/guard/guard-state.json', now })
  const budgets = opts.budgets === null ? undefined : opts.budgets ?? new DispatchBudgets()
  const deps: RouterCoreAssemblyDeps = {
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
      templates: GUARD_TEMPLATES,
    },
    breaker,
    budgets,
    notifications: opts.notifications,
    newId: () => `q-${Math.random()}`,
    signal: new AbortController().signal,
    isRunning: () => false,
    now,
    tasksDir: '.router',
  }
  const assembled = createRouterCore(deps)
  await assembled.refreshSnapshot()
  return { ledger, docs, bridge, relay, driver, events, statusCbs, ui, breaker, budgets, memfs, now, ...assembled }
}
