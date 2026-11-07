/**
 * v1.3 Task A3：分叉创建 worker（规格 §3；Review Focus 2/3/4）。
 *
 * cache-priority：dispatchTask 创建段 = 宿主 fork face
 * `sessionController.fork({ sessionId: 来源 })`（缺面 → infra 分类进熔断，
 * 不硬撞创建路径）；绝不调 selectModel；requestId=switch-<taskId>-v<docVersion>；
 * 改名 `类型名 · T-xxx 任务名`。
 * minimal-face：插件复刻五步（observeSession → buildForkSeed → resolve+mount →
 * agents.create → attach workspace）→ rename → selectModel(类型 models[0])；
 * 来源缺位/预设未注册 → infra（Review Focus 4）。
 */

import { describe, expect, it } from 'vitest'

import { SessionBridge, type SessionBridgeDeps, type SessionBridgeHost } from '../src/host/bridge/sessions.ts'
import { TaskLedger, type LedgerFile, type LedgerPersistence } from '../src/host/ledger/store.ts'
import { TaskDocStore } from '../src/host/docs/task-docs.ts'
import { classifyDispatchFailure } from '../src/host/guard/classify.ts'
import type { FsAdapter } from '../src/shared/fs-adapter.ts'
import type { WorkerTypeRecord } from '../src/shared/view-contract.ts'

/* ────────────────────────── 装配 ────────────────────────── */

class MemoryPersistence implements LedgerPersistence {
  file: LedgerFile | null = null
  async load() {
    return this.file
  }
  async save(f: LedgerFile) {
    this.file = JSON.parse(JSON.stringify(f)) as LedgerFile
  }
}

function looseDocs(): TaskDocStore {
  const files = new Map<string, string>()
  const fs: FsAdapter = {
    async readFile(p) {
      const content = files.get(p)
      if (content === undefined) throw new Error(`文档不存在: ${p}`)
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
  return new TaskDocStore('/proj/.router', fs)
}

const CODER_TYPE: WorkerTypeRecord = {
  templateId: 'coder',
  name: '编码',
  description: '写代码',
  role: 'worker',
  models: ['prov/model-a'],
  systemPrompt: '你是编码执行者。',
  skills: [],
  enabled: true,
  origin: 'user',
  createdAt: 1,
  updatedAt: 1,
}

/** 分叉源会话的假事件日志（最后一个 turn/end 在 seq 1）。 */
const SOURCE_EVENTS = [
  { type: 'user/message', seq: 0, time: 1, data: { text: '开始' } },
  { type: 'assistant/message', seq: 1, time: 1, data: {} },
  { type: 'turn/end', seq: 2, time: 1, data: {} },
] as const

interface HarnessOptions {
  mode: 'cache-priority' | 'minimal-face'
  /** 宿主 fork face（cache 模式用；缺省提供成功实现）。 */
  fork?: (request: { sessionId: string }) => Promise<{ sessionId: string }>
  /** 缺省 true = 不给宿主 fork face（旧宿主）。 */
  omitForkFace?: boolean
  /** observeSession 实现（minimal 五步第①步）。 */
  observe?: (sessionId: string) => Promise<{ events: readonly { seq: number; type: string; time?: number; data?: unknown }[]; dispose?: () => void }>
  /** resolvePreset 抛错（agent-preset/not-found 模拟）。 */
  presetNotFound?: boolean
  /** agents.create 拒绝。 */
  createFails?: Error
  /** 不给 resolvePreset/mountPreset 面（评审 F5：五步能力检查应回退创建）。 */
  omitPresetFaces?: boolean
}

function harness(opts: HarnessOptions) {
  const persistence = new MemoryPersistence()
  persistence.file = { schemaVersion: 1, tasks: [], nextTaskNumber: 1, questions: [] }
  const ledger = new TaskLedger(persistence, () => 1000)
  const docs = looseDocs()
  const captured = {
    forkCalls: [] as { sessionId: string }[],
    createCalls: [] as { opts: Record<string, unknown> }[],
    promptCalls: [] as { requestId: string; sessionId: string; text: string }[],
    renameCalls: [] as { sessionId: string; title: string }[],
    selectModelCalls: [] as { sessionId: string; provider: string; model: string }[],
    agentsCreateCalls: [] as { sessionId: string; seed: unknown[]; inheritedEventCount: number; meta: Record<string, unknown>; setupGiven: boolean }[],
    attachCalls: [] as { workspaceId: string; sessionId: string }[],
  }
  const host: SessionBridgeHost = {
    create: async (createOpts) => {
      captured.createCalls.push({ opts: createOpts as Record<string, unknown> })
      return 'created-session-1'
    },
    prompt: async (request) => {
      captured.promptCalls.push({ requestId: request.requestId, sessionId: request.sessionId, text: request.content.map((b) => b.text).join('\n') })
      return {}
    },
    onStatus: () => {},
    rename: async (sessionId, title) => {
      captured.renameCalls.push({ sessionId, title })
    },
    selectModel: async (request) => {
      captured.selectModelCalls.push(request)
      return {}
    },
    // cache 模式的宿主 fork face（wire session/fork 的同款形状）
    fork: opts.omitForkFace === true ? undefined : (opts.fork ?? (async (request) => {
      captured.forkCalls.push(request)
      return { sessionId: `forked-${captured.forkCalls.length}` }
    })),
    // minimal 五步的注入面（entry 从宿主服务组装；这里是假件）
    observeSession: opts.observe ?? (async (sessionId) => ({ events: SOURCE_EVENTS, dispose: () => {} })),
    buildForkSeed: (events, boundary) => [
      ...events.slice(0, boundary + 1),
      { type: 'session/end-seed', seq: boundary + 1, time: 1, data: { inherited: true } },
    ],
    newSessionId: () => `child-${captured.agentsCreateCalls.length + 1}`,
    agentsCreate: async (options) => {
      if (opts.createFails !== undefined) throw opts.createFails
      captured.agentsCreateCalls.push({
        sessionId: options.sessionId,
        seed: options.seed as unknown[],
        inheritedEventCount: options.inheritedEventCount,
        meta: options.meta as Record<string, unknown>,
        setupGiven: typeof options.setup === 'function',
      })
      return {}
    },
    resolvePreset: opts.presetNotFound === true
      ? async () => {
          throw new Error('agent-preset/not-found: Unknown agent preset: dsh-router-worker')
        }
      : opts.omitPresetFaces === true
        ? undefined
        : async (presetId) => ({ id: presetId }),
    mountPreset: opts.omitPresetFaces === true ? undefined : async () => ({}),
    attachWorkspace: async (workspaceId, sessionId) => {
      captured.attachCalls.push({ workspaceId, sessionId })
    },
  }
  const deps: SessionBridgeDeps = {
    ledger,
    docsFor: () => docs,
    host,
    presets: { supervisor: 'dsh-router-supervisor', worker: 'dsh-router-worker' },
    workerInstructions: () => '【执行指引】',
    mode: opts.mode,
    types: { get: async (templateId) => (templateId === 'coder' ? CODER_TYPE : undefined) },
    signal: new AbortController().signal,
  }
  return { bridge: new SessionBridge(deps), ledger, docs, captured, seed: null }
}

async function createTask(h: ReturnType<typeof harness>) {
  const record = await h.ledger.createTask({
    title: '写文档',
    goal: '写出文档',
    acceptance: ['文档存在'],
    constraints: [],
    projectId: 'ws-1',
    cwd: '/proj',
    role: 'worker',
    templateId: 'coder',
    dependsOn: [],
    acceptancePolicy: 'auto',
  })
  // dispatchTask 读任务书全文：先落盘（core 的真实路径由 initTask 落）
  await h.docs.initTask(record, `# 任务书 ${record.id} v1\n目标：写出文档`)
  return record
}

/* ────────────────────────── cache-priority：宿主 fork ────────────────────────── */

describe('cache-priority：创建段 = 宿主 fork face（规格 §3.1）', () => {
  it('fork 来源 = 显式 forkFrom（派发者会话）；子会话入账本；改名「类型名 · T-xxx 任务名」', async () => {
    const h = harness({ mode: 'cache-priority' })
    const record = await createTask(h)
    const outcome = await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' })
    expect(h.captured.forkCalls).toEqual([{ sessionId: 'router-session-1' }])
    expect(h.captured.createCalls).toHaveLength(0)
    expect(outcome.sessionId).toBe('forked-1')
    expect(h.captured.renameCalls).toEqual([{ sessionId: 'forked-1', title: '编码 · T-001 写文档' }])
    expect((await h.ledger.listAll())[0]!.sessionId).toBe('forked-1')
  })

  it('requestId = switch-<taskId>-v<docVersion>（Review Focus 2：同版本重试沿用同 requestId）', async () => {
    const h = harness({ mode: 'cache-priority' })
    const record = await createTask(h)
    await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' })
    expect(h.captured.promptCalls[0]!.requestId).toBe(`switch-${record.id}-v1`)
  })

  it('Review Focus 3：cache 模式绝不调 selectModel（fork 继承来源模型）', async () => {
    const h = harness({ mode: 'cache-priority' })
    const record = await createTask(h)
    await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' })
    expect(h.captured.selectModelCalls).toHaveLength(0)
  })

  it('无分叉源（无 forkFrom 且父任务无会话）→ 回退创建路径：仍不 selectModel、投递仍 switch 卡格式', async () => {
    const h = harness({ mode: 'cache-priority' })
    const record = await createTask(h)
    await h.bridge.dispatchTask(record.id)
    expect(h.captured.forkCalls).toHaveLength(0)
    expect(h.captured.createCalls).toHaveLength(1)
    expect(h.captured.selectModelCalls).toHaveLength(0)
    expect(h.captured.promptCalls[0]!.text).toContain('【身份切换卡】')
    expect(h.captured.promptCalls[0]!.requestId).toBe(`switch-${record.id}-v1`)
  })

  it('宿主缺 fork face → infra 分类进熔断，不硬撞创建路径（Review Focus 4）', async () => {
    const h = harness({ mode: 'cache-priority', omitForkFace: true })
    const record = await createTask(h)
    const error = await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(classifyDispatchFailure(error).class).toBe('infra')
    expect(h.captured.createCalls).toHaveLength(0)
  })

  it('fork 失败（来源已删 session/not-found）→ infra 分类（Review Focus 4）', async () => {
    const h = harness({
      mode: 'cache-priority',
      fork: async () => {
        throw new Error('session/not-found: session "gone" not found')
      },
    })
    const record = await createTask(h)
    const error = await h.bridge.dispatchTask(record.id, { forkFrom: 'gone' }).catch((e: unknown) => e)
    expect(classifyDispatchFailure(error).class).toBe('infra')
    expect(h.captured.createCalls).toHaveLength(0)
  })
})

/* ────────────────────────── minimal-face：五步复刻 ────────────────────────── */

describe('minimal-face：五步复刻（规格 §3.2）', () => {
  it('observe 源 → buildForkSeed → agents.create（seed/inheritedEventCount/meta）→ attach workspace', async () => {
    const h = harness({ mode: 'minimal-face' })
    const record = await createTask(h)
    const outcome = await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' })
    expect(outcome.sessionId).toBe('child-1')
    const create = h.captured.agentsCreateCalls[0]!
    expect(create.sessionId).toBe('child-1')
    expect(create.seed.length).toBe(4) // 前缀 3 + 合成 end-seed
    expect(create.seed[3]).toMatchObject({ type: 'session/end-seed', data: { inherited: true } })
    expect(create.inheritedEventCount).toBe(3)
    expect(create.meta).toMatchObject({ cwd: '/proj', isSeeded: true, agentPreset: 'dsh-router-worker' })
    expect(create.setupGiven).toBe(true)
    expect(h.captured.attachCalls).toHaveLength(0) // 无 workspace 解析面时跳过
  })

  it('后接 rename + selectModel(models[0])（minimal 才钉模型）', async () => {
    const h = harness({ mode: 'minimal-face' })
    const record = await createTask(h)
    await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' })
    expect(h.captured.renameCalls).toEqual([{ sessionId: 'child-1', title: '编码 · T-001 写文档' }])
    expect(h.captured.selectModelCalls).toEqual([{ sessionId: 'child-1', provider: 'prov', model: 'model-a' }])
  })

  it('minimal 投递 = 简化身份头 + 任务书 + 执行指引；requestId 维持 dispatch-（现状不变）', async () => {
    const h = harness({ mode: 'minimal-face' })
    const record = await createTask(h)
    await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' })
    const delivery = h.captured.promptCalls[0]!
    expect(delivery.requestId).toBe(`dispatch-${record.id}-v1`)
    expect(delivery.text).toContain('【身份切换卡】')
    expect(delivery.text).toContain('【执行指引】')
  })

  it('源缺位（observeSession 找不到会话）→ infra（Review Focus 4）', async () => {
    const h = harness({
      mode: 'minimal-face',
      observe: async () => {
        throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
      },
    })
    const record = await createTask(h)
    const error = await h.bridge.dispatchTask(record.id, { forkFrom: 'gone' }).catch((e: unknown) => e)
    expect(classifyDispatchFailure(error).class).toBe('infra')
    expect(h.captured.agentsCreateCalls).toHaveLength(0)
  })

  it('源无完成轮（无 turn/end）→ infra（不硬造 seed）', async () => {
    const h = harness({
      mode: 'minimal-face',
      observe: async () => ({ events: [{ type: 'user/message', seq: 0, time: 1, data: {} }] }),
    })
    const record = await createTask(h)
    const error = await h.bridge.dispatchTask(record.id, { forkFrom: 'fresh' }).catch((e: unknown) => e)
    expect(classifyDispatchFailure(error).class).toBe('infra')
  })

  it('预设未注册（agent-preset/not-found）→ infra（Review Focus 4），不静默换预设', async () => {
    const h = harness({ mode: 'minimal-face', presetNotFound: true })
    const record = await createTask(h)
    const error = await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' }).catch((e: unknown) => e)
    expect(classifyDispatchFailure(error).class).toBe('infra')
    expect(h.captured.agentsCreateCalls).toHaveLength(0)
  })

  it('resolvePreset/mountPreset 缺面（评审 F5）→ 不做五步，回退创建路径（不裸跑 agents.create）', async () => {
    const h = harness({ mode: 'minimal-face', omitPresetFaces: true })
    const record = await createTask(h)
    await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' })
    expect(h.captured.agentsCreateCalls).toHaveLength(0)
    expect(h.captured.createCalls).toHaveLength(1)
  })

  it('无分叉源 → 回退既有创建路径（host.create + 钉模型）', async () => {
    const h = harness({ mode: 'minimal-face' })
    const record = await createTask(h)
    await h.bridge.dispatchTask(record.id)
    expect(h.captured.agentsCreateCalls).toHaveLength(0)
    expect(h.captured.createCalls).toHaveLength(1)
    expect(h.captured.selectModelCalls).toEqual([{ sessionId: 'created-session-1', provider: 'prov', model: 'model-a' }])
  })

  it('agents.create 失败 → infra 分类', async () => {
    const h = harness({ mode: 'minimal-face', createFails: new Error('seed validation failed') })
    const record = await createTask(h)
    const error = await h.bridge.dispatchTask(record.id, { forkFrom: 'router-session-1' }).catch((e: unknown) => e)
    expect(classifyDispatchFailure(error).class).toBe('infra')
  })
})
