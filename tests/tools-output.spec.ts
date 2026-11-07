/**
 * 工具输出 lossless-JSON 门禁（v1.1 计划 Task A3）。
 *
 * 八件套工具逐个经真实 RouterCore（假宿主面、账本数据按 task-builder 造）执行，
 * 返回的 output value 逐个过 assertLosslessJson。v1 现场：query_tasks 返回非无损
 * JSON（draft 任务卡上 progress/sessionId/parentId 是 undefined 值的键，
 * JSON 序列化时静默蒸发）→ 主管全盲。
 *
 * 这是行为门禁：换假 core 就测不到真 toCard 的泄漏，所以这里组装真核心。
 */

import { describe, expect, it } from 'vitest'

import { LedgerError } from '../src/host/ledger/errors.ts'
import { TaskLedger, type LedgerFile, type LedgerPersistence } from '../src/host/ledger/store.ts'
import { Scheduler } from '../src/host/ledger/scheduler.ts'
import { TaskDocStore } from '../src/host/docs/task-docs.ts'
import { SessionBridge } from '../src/host/bridge/sessions.ts'
import { AnswerRelay } from '../src/host/bridge/questions.ts'
import { CompactionDriver, type CompactionDeps } from '../src/host/context/compaction-driver.ts'
import { createRouterCore, type RouterCoreAssemblyDeps, type RouterCoreHosts } from '../src/host/core.ts'
import { UiStateStore, type UiStateFile, type UiStatePersistence } from '../src/host/bridge/tabs.ts'
import { buildToolDefinitions } from '../src/host/tools/index.ts'
import type { FsAdapter } from '../src/shared/fs-adapter.ts'
import type { TaskRecord } from '../src/shared/types.ts'
import type { WorkerTemplate } from '../src/shared/view-contract.ts'
import { task } from './helpers/task-builder.ts'
import { assertLosslessJson } from './helpers/lossless.ts'

/* ────────────────────────── 假件（与 router-core.spec 同款，收敛到最小） ────────────────────────── */

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

function fakeHosts() {
  const created: Record<string, unknown>[] = []
  const prompts: { requestId: string; sessionId: string }[] = []
  let count = 0
  const hosts: RouterCoreHosts = {
    sessionController: {
      async create(opts) {
        count += 1
        created.push(opts as Record<string, unknown>)
        return { sessionId: `session-${count}` }
      },
      async prompt(request) {
        prompts.push({ requestId: request.requestId, sessionId: request.sessionId })
        return { accepted: true }
      },
      async rename() {
        return {}
      },
    },
    agents: { get: () => undefined },
    workspaceRegistry: {
      list: () => [{ id: 'ws-1', path: '/proj', sessionIds: ['router-s-1'] }],
      get: (id: string) => (id === 'ws-1' ? { id: 'ws-1', path: '/proj', sessionIds: ['router-s-1'] } : undefined),
    },
    onSessionStatus() {},
  }
  return { hosts, created, prompts }
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
  ;(driver as unknown as { onDispatched(s: string): void }).onDispatched = () => {}
  return driver
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

async function coreWith(records: TaskRecord[]) {
  const persistence = new MemoryPersistence()
  persistence.file = { schemaVersion: 1, tasks: records, nextTaskNumber: records.length + 1, questions: [] }
  const ledger = new TaskLedger(persistence, () => 1000)
  await ledger.listAll()
  const docs = memoryDocs()
  const { hosts } = fakeHosts()
  const ui = fakeUi()
  await ui.load()
  const bridge = new SessionBridge({
    ledger,
    docsFor: () => docs,
    workspaces: hosts.workspaceRegistry,
    host: {
      create: async (opts) => (await hosts.sessionController.create(opts)).sessionId,
      prompt: (request, signal) => hosts.sessionController.prompt(request, signal),
      onStatus: () => {},
    },
    presets: { supervisor: 'dsh-router-supervisor', worker: 'dsh-router-worker' },
    workerInstructions: () => '【执行指引】',
    signal: new AbortController().signal,
  })
  const relay = new AnswerRelay({ ledger, newId: () => `q-${++questionSeq}`, now: () => 1 })
  const scheduler = new Scheduler(ledger, { maxDepth: 2, concurrency: { default: 3 } })
  const deps: RouterCoreAssemblyDeps = {
    ledger,
    docsFor: () => docs,
    bridge,
    relay,
    driver: fakeDriver(),
    scheduler,
    hosts,
    ui,
    config: {
      routerPreset: 'dsh-router',
      supervisorPreset: 'dsh-router-supervisor',
      workerPreset: 'dsh-router-worker',
      templates: TEMPLATES,
    },
    newId: () => `q-${++questionSeq}`,
    signal: new AbortController().signal,
    isRunning: () => false,
    memory: {
      async search(query) {
        return [{ memoryRef: 'memory://project.md#e1', snippet: `命中 ${query}` }]
      },
      onTaskCompleted() {},
    },
    tasksDir: '.router',
  }
  const assembled = createRouterCore(deps)
  await assembled.refreshSnapshot()
  return { ...assembled, ledger, docs }
}

const execOf = (sessionId: string) => ({ agent: { id: sessionId } })

async function runTool(core: ReturnType<typeof createRouterCore>['core'], role: 'router' | 'worker', name: string, args: Record<string, unknown>) {
  const def = buildToolDefinitions(core, role).find((d) => d.name === name)
  if (def === undefined) throw new Error(`工具 ${name} 不在角色 ${role} 的白名单里`)
  return (await def.execute(args, execOf(role === 'router' ? 'router-s-1' : 'worker-s-1'))) as unknown
}

/* ────────────────────────── 八件套逐个过门禁 ────────────────────────── */

describe('tools-output：八件套工具输出过 lossless-JSON 门禁', () => {
  it('dispatch_task', async () => {
    const { core } = await coreWith([])
    const value = await runTool(core, 'router', 'dispatch_task', {
      title: '修登录',
      goal: '登录不再 500',
      acceptance: ['回归通过'],
      role: 'worker',
      templateId: 'coder',
      materials: ['docs/auth.md'],
    })
    assertLosslessJson(value, 'dispatch_task output')
  })

  it('supplement_task', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running', projectId: 'ws-1', cwd: '/proj' })]
    const { core, ledger, docs } = await coreWith(records)
    await docs.initTask(ledger.get('T-001')!, '# 任务书 T-001')
    const value = await runTool(core, 'router', 'supplement_task', { taskId: 'T-001', additions: ['补充：用 PostgreSQL'] })
    assertLosslessJson(value, 'supplement_task output')
  })

  it('query_tasks（v1 现场案例：draft 任务卡的 undefined 键先红）', async () => {
    const records = [
      task({ id: 'T-001', role: 'worker', status: 'draft', title: '刚建还没派' }),
      task({ id: 'T-002', role: 'worker', sessionId: 'session-2', status: 'running', progress: '一半', parentId: 'T-001', title: '进行中' }),
    ]
    const { core } = await coreWith(records)
    const value = await runTool(core, 'router', 'query_tasks', {})
    assertLosslessJson(value, 'query_tasks output')
  })

  it('control_task', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'session-9', status: 'running' })]
    const { core } = await coreWith(records)
    const value = await runTool(core, 'router', 'control_task', { taskId: 'T-001', action: 'pause' })
    assertLosslessJson(value, 'control_task output')
  })

  it('search_history', async () => {
    const { core } = await coreWith([])
    const value = await runTool(core, 'router', 'search_history', { query: '登录', scope: 'project' })
    assertLosslessJson(value, 'search_history output')
  })

  it('report_progress', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'worker-s-1', status: 'running' })]
    const { core } = await coreWith(records)
    const value = await runTool(core, 'worker', 'report_progress', { taskId: 'T-001', progress: '完成一半' })
    assertLosslessJson(value, 'report_progress output')
  })

  it('complete_task（completed 路径的 pendingFrom: undefined 先红）', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'worker-s-1', status: 'running', projectId: 'ws-1', cwd: '/proj' })]
    const { core } = await coreWith(records)
    const value = await runTool(core, 'worker', 'complete_task', { taskId: 'T-001', docVersion: 1, summary: '做完了' })
    assertLosslessJson(value, 'complete_task output')
  })

  it('report_blocker', async () => {
    const records = [task({ id: 'T-001', role: 'worker', sessionId: 'worker-s-1', status: 'running' })]
    const { core } = await coreWith(records)
    const value = await runTool(core, 'worker', 'report_blocker', { taskId: 'T-001', reason: '缺凭据' })
    assertLosslessJson(value, 'report_blocker output')
  })

  it('query_tasks 修复后语义不变：draft 卡不带会话/进度键，但字段值保持可读', async () => {
    const records = [task({ id: 'T-001', role: 'worker', status: 'draft', title: '刚建还没派' })]
    const { core } = await coreWith(records)
    const value = (await runTool(core, 'router', 'query_tasks', {})) as { tasks: Record<string, unknown>[] }
    expect(value.tasks).toHaveLength(1)
    expect(value.tasks[0]).toMatchObject({ taskId: 'T-001', status: 'draft', title: '刚建还没派', docVersion: 1 })
    expect('sessionId' in value.tasks[0]!).toBe(false)
    expect('progress' in value.tasks[0]!).toBe(false)
    expect('parentId' in value.tasks[0]!).toBe(false)
  })
})
