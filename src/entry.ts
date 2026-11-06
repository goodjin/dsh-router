/**
 * DSH Router 根服务（宿主入口，计划 B2 的组装点）。
 *
 * 裸包名行加载本文件（浏览器行与宿主根服务共用一行：`name` 恰好等于包名的行
 * 才会被客户端注册表认成浏览器行，浏览器代码经 exports["./client"] 下发，不进
 * 宿主进程）。本文件在宿主进程里组装：
 *
 *   账本 + 文档 + 调度器 + 会话桥 + 问答桥 + 压缩驱动 + UI 状态
 *     → createRouterCore（src/host/core.ts）
 *     → ctx.provide('routerCore', …)（预设树里的工具行/上下文行经作用域链取用）
 *     → user-questions/request 瀑布全局监听（prepend：先于客户端兜底 UI 认领
 *       worker 提问，答案走 Router 界面浮窗）
 *     → 四条 HTTP exact 路由（webServer/connection 机会式注入）
 *
 * 配置照 auto-resume 先例：Config 全部 volatile 可缺省，apply 内再做一层防御性
 * 解析（缺省补默认、负数取 0），宿主各版本 schema 默认值行为不一致时插件自己兜底。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import { TaskLedger, type LedgerFile, type LedgerPersistence } from './host/ledger/store.ts'
import { TaskDocStore } from './host/docs/task-docs.ts'
import { Scheduler } from './host/ledger/scheduler.ts'
import { SessionBridge, type WorkspaceInfo } from './host/bridge/sessions.ts'
import { AnswerRelay } from './host/bridge/questions.ts'
import { UiStateStore, type UiStateFile, type UiStatePersistence } from './host/bridge/tabs.ts'
import { CompactionDriver } from './host/context/compaction-driver.ts'
import { registerRouterRoutes, type RouterRoutesContext } from './host/routes.ts'
import { createRouterCore, type RouterCoreConfig, type RouterCoreHosts } from './host/core.ts'
import { workerInstructions as WORKER_INSTRUCTIONS } from './host/prompts/worker-instructions.ts'
import { BUILTIN_TEMPLATES } from './host/templates.ts'
import { MemoryDocStore } from './host/memory/store.ts'
import { search as searchMemory } from './host/memory/retrieval.ts'
import {
  BackgroundSummarizer,
  createCompletedTaskRecorder,
  createSummaryLlm,
  maxSurfaceSeq,
  summarizeSessionViaQuery,
  type LlmRouteTarget,
  type SessionObservationLike,
} from './host/memory/adapter.ts'
import type { FsAdapter } from './shared/fs-adapter.ts'
import type { WorkerTemplate } from './shared/view-contract.ts'

export { Config } from './host/root-config.ts'

/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
export const name = '@goodjin2/dsh-router'

/** 必需的宿主服务（缺席行装载失败，fail loud，不留静默残废）。 */
export const inject = ['sessionController', 'agents', 'workspaceRegistry', 'sessionQuery', 'llm']

/** 宿主上下文的最小面（窄接口；webServer/connection 走机会式注入）。 */
interface RootContext {
  sessionController: RouterCoreHosts['sessionController']
  agents: RouterCoreHosts['agents']
  workspaceRegistry: { list(): unknown[]; get(id: string): unknown }
  /** B8 起必需：压缩区域的用户消息锚点 + 记忆增量摘要的事件租约。 */
  sessionQuery: {
    observeSession(sessionId: string): Promise<SessionObservationLike>
    readSurface?(sessionId: string): Promise<{ events: { seq: number; type: string }[] } | undefined>
  }
  /** B8 起必需：记忆增量摘要的模型流（purpose:'compaction'）。 */
  llm: { stream(options: Record<string, unknown>): AsyncIterable<unknown> }
  on(event: string, listener: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): unknown
  effect(factory: () => unknown, label?: string): unknown
  inject?(deps: string[], body: (child: unknown) => void): unknown
  provide(name: string, value: unknown): () => void
  get?(name: string): unknown
  logger?(name: string): { info(message: string): void; warn(message: string): void }
}

/** 防御性解析后的完整配置（字段全有）。 */
interface ResolvedRootConfig extends RouterCoreConfig {
  dataDir: string
  tasksDir: string
  maxActiveCards: number
  perTypeConcurrency: number
  maxDepth: number
  summarizationProvider: string
  summarizationModel: string
}

/** 数值钳位：非数值回默认，负数取 0。 */
function nonNegative(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value < 0 ? 0 : value
}

/** 字符串：非空字符串否则回默认。 */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/** 模板清单：形状不对逐条丢弃，全部不合法回内置。 */
function templatesOr(value: unknown): WorkerTemplate[] {
  if (!Array.isArray(value)) return BUILTIN_TEMPLATES
  const parsed: WorkerTemplate[] = []
  for (const entry of value) {
    const candidate = entry as Partial<WorkerTemplate> | null
    if (
      candidate !== null && typeof candidate === 'object'
      && typeof candidate.templateId === 'string' && candidate.templateId !== ''
      && typeof candidate.name === 'string'
      && (candidate.role === 'supervisor' || candidate.role === 'worker')
    ) {
      parsed.push({
        templateId: candidate.templateId,
        name: candidate.name,
        description: typeof candidate.description === 'string' ? candidate.description : '',
        role: candidate.role,
      })
    }
  }
  return parsed.length > 0 ? parsed : BUILTIN_TEMPLATES
}

function resolveRootConfig(raw: unknown): ResolvedRootConfig {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return {
    dataDir: stringOr(source.dataDir, join(home, 'router')),
    tasksDir: stringOr(source.tasksDir, '.router'),
    maxActiveCards: nonNegative(source.maxActiveCards, 12),
    perTypeConcurrency: nonNegative(source.perTypeConcurrency, 3),
    maxDepth: Math.max(1, nonNegative(source.maxDepth, 3)),
    routerPreset: stringOr(source.routerPreset, 'dsh-router'),
    supervisorPreset: stringOr(source.supervisorPreset, 'dsh-router-supervisor'),
    workerPreset: stringOr(source.workerPreset, 'dsh-router-worker'),
    summarizationProvider: stringOr(source.summarizationProvider, ''),
    summarizationModel: stringOr(source.summarizationModel, ''),
    templates: templatesOr(source.templates),
  }
}

/** node:fs/promises 适配成 FsAdapter。 */
function fsAdapter(): FsAdapter {
  return {
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, content) => writeFile(p, content, 'utf8'),
    mkdirp: async (p) => {
      await mkdir(p, { recursive: true })
    },
    exists: async (p) => {
      try {
        await readFile(p)
        return true
      } catch {
        return false
      }
    },
    readdir: async (p) => {
      try {
        return await readdir(p)
      } catch {
        return []
      }
    },
  }
}

/** 一个 JSON 文件的读改写持久化（账本与 UI 状态共用形状）。 */
function jsonFilePersistence<T>(path: string): {
  load(): Promise<T | null>
  save(value: T): Promise<void>
} & LedgerPersistence &
  UiStatePersistence {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as T
      } catch {
        return null
      }
    },
    async save(value: unknown) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
    },
  } as never
}

/** 装载入口：组装根服务并挂接宿主。 */
export function apply(ctx: RootContext, rawConfig: unknown): void {
  const config = resolveRootConfig(rawConfig)
  const log = ctx.logger?.(name) ?? { info: (m: string) => console.info(`[${name}] ${m}`), warn: (m: string) => console.warn(`[${name}] ${m}`) }

  const fs = fsAdapter()
  const ledger = new TaskLedger(jsonFilePersistence<LedgerFile>(join(config.dataDir, 'ledger.json')))
  const docStores = new Map<string, TaskDocStore>()
  const docsFor = (cwd: string): TaskDocStore => {
    const key = cwd === '' ? '.' : cwd
    const existing = docStores.get(key)
    if (existing !== undefined) return existing
    const store = new TaskDocStore(join(key, config.tasksDir), fs)
    docStores.set(key, store)
    return store
  }
  const ui = new UiStateStore(jsonFilePersistence<UiStateFile>(join(config.dataDir, 'ui-state.json')))

  const workspaceRegistry: RouterCoreHosts['workspaceRegistry'] = {
    list: () => (ctx.workspaceRegistry.list() as WorkspaceInfo[]),
    get: (id: string) => ctx.workspaceRegistry.get(id) as WorkspaceInfo | undefined,
  }
  const hosts: RouterCoreHosts = {
    sessionController: ctx.sessionController,
    agents: ctx.agents,
    workspaceRegistry,
    onSessionStatus: (callback) => {
      ctx.on('api-session/status', (sessionId: unknown, running: unknown) => callback(String(sessionId), Boolean(running)))
    },
  }

  const bridge = new SessionBridge({
    ledger,
    docsFor,
    workspaces: workspaceRegistry,
    host: {
      create: async (opts, signal) => (await ctx.sessionController.create(opts, signal)).sessionId,
      prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
      onStatus: (callback) => hosts.onSessionStatus(callback),
      rename: async (sessionId, title) => {
        await ctx.sessionController.rename({ sessionId, title })
      },
    },
    presets: { supervisor: config.supervisorPreset, worker: config.workerPreset },
    workerInstructions: () => workerInstructionsText(),
    signal: undefined,
  })

  const relay = new AnswerRelay({ ledger, newId: () => randomUUID(), now: () => Date.now() })
  const scheduler = new Scheduler(ledger, {
    maxDepth: config.maxDepth,
    concurrency: { default: config.perTypeConcurrency },
  })

  // 记忆服务接线（计划 B8）：三层文档 store 根目录 = <dataDir>/memory/；
  // 事件读走 observeSession 租约（adapter 内 finally 释放）；摘要流走
  // ctx.llm.stream（purpose:'compaction'）。路由对解析链：配置对 → 活任务
  // 会话最近一次路由头（compaction-basic routedTarget 同款）→ 缺失（触发方 warn）。
  const memoryStore = new MemoryDocStore(join(config.dataDir, 'memory'), fs)
  const memoryQuery = {
    observeSession: (sessionId: string) => ctx.sessionQuery.observeSession(sessionId),
  }
  const resolveSummaryTarget = async (): Promise<LlmRouteTarget | undefined> => {
    if (config.summarizationProvider !== '' && config.summarizationModel !== '') {
      return { provider: config.summarizationProvider, model: config.summarizationModel }
    }
    const records = await ledger.listAll()
    for (const record of records) {
      if (record.sessionId === undefined) continue
      const agent = ctx.agents.get(record.sessionId) as
        | { session?: { requestHeader?: () => { config?: { provider?: unknown; model?: unknown } } } }
        | undefined
      const routed = agent?.session?.requestHeader?.()?.config
      if (
        routed !== undefined
        && typeof routed.provider === 'string' && routed.provider !== ''
        && typeof routed.model === 'string' && routed.model !== ''
      ) {
        return { provider: routed.provider, model: routed.model }
      }
    }
    return undefined
  }
  const summaryLlm = createSummaryLlm(ctx.llm, resolveSummaryTarget)

  const summarizer = new BackgroundSummarizer({
    maxSeq: (sessionId) => maxSurfaceSeq(memoryQuery, sessionId),
    run: (sessionId) => summarizeSessionViaQuery(memoryQuery, memoryStore, sessionId, summaryLlm),
    onError: (sessionId, error) => {
      log.warn(`会话 ${sessionId} 记忆增量摘要失败（下次 idle 或新事件后重试）: ${error instanceof Error ? error.message : String(error)}`)
    },
  })

  const recordTaskMemory = createCompletedTaskRecorder({
    store: memoryStore,
    query: memoryQuery,
    llm: summaryLlm,
    onError: (_stage, error) => {
      log.warn(`任务完成的记忆写入失败（不阻塞完成协议）: ${error instanceof Error ? error.message : String(error)}`)
    },
  })

  /** 该会话是否绑定了任务（= worker/主管会话；Router 会话不做增量摘要）。 */
  const isTaskSession = async (sessionId: string): Promise<boolean> => {
    const records = await ledger.listAll()
    return records.some((record) => record.sessionId === sessionId)
  }

  /** routerCore.memory（brief 形状：search 直传 retrieval）。 */
  const memoryFace = {
    search: (query: string, scope: 'project' | 'global') => searchMemory(memoryStore, query, scope),
    onTaskCompleted: (input: Parameters<typeof recordTaskMemory>[0]) => recordTaskMemory(input),
  }

  // 压缩驱动：压缩引擎取会话 agent 自身作用域的 ctx.compaction（预设在 isolate
  // realm 里装载，根 ctx 看不到）；配对函数动态 import 宿主的 dsh-compaction，
  // 缺席时放行为 true（只失去预检保护，compactRegion 自身仍会拒绝不平衡区域）。
  type Pairing = { before(session: unknown, seq: number): Promise<boolean> | boolean; after(session: unknown, seq: number): Promise<boolean> | boolean }
  let pairing: Pairing | null = null
  const queueWarned = new Set<string>()
  const loadPairing = async (): Promise<Pairing> => {
    if (pairing !== null) return pairing
    try {
      const specifier = '@deepseek-ai/dsh-compaction'
      const mod = (await import(specifier)) as Partial<Record<'toolPairingBalancedBefore' | 'toolPairingBalancedAfter', unknown>>
      pairing = {
        before: mod.toolPairingBalancedBefore as Pairing['before'],
        after: mod.toolPairingBalancedAfter as Pairing['after'],
      }
    } catch (error) {
      log.warn(`dsh-compaction 配对函数不可用，压缩区域预检放行: ${error instanceof Error ? error.message : String(error)}`)
      pairing = { before: () => true, after: () => true }
    }
    return pairing
  }

  const driver = new CompactionDriver({
    getAgent: (sessionId) => ctx.agents.get(sessionId) as { session: unknown; status?: string; ctx?: { compaction?: unknown } } | undefined,
    // idle 且无排队消息才驱动压缩（brief 的驱动条件）：排队未清时压缩会把
    // 等着入场的上下文压进旧区域；查询失败按「还有排队」保守跳过（driver 内处理），
    // 这里每会话首次失败自报一声——持续失败 = 压缩永不跑，不能静默。
    queueEmpty: async (sessionId) => {
      try {
        const state = (await (ctx.sessionController as unknown as {
          state(request: { sessionId: string }, signal?: AbortSignal): Promise<{ queue?: unknown[] | null } | undefined>
        }).state({ sessionId })) as { queue?: unknown[] | null } | undefined
        const queue = state?.queue
        return queue === undefined || queue === null || queue.length === 0
      } catch (error) {
        if (!queueWarned.has(sessionId)) {
          queueWarned.add(sessionId)
          log.warn(`会话 ${sessionId} 排队状态查询失败，派发后压缩将暂缓: ${error instanceof Error ? error.message : String(error)}`)
        }
        throw error
      }
    },
    lastUserMessageSeq: async (sessionId) => {
      const sessionQuery = ctx.sessionQuery
      if (sessionQuery === undefined) return null
      try {
        const surface = await sessionQuery.readSurface?.(sessionId)
        const events = surface?.events ?? []
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if (events[i]?.type === 'user/message') return events[i]!.seq
        }
        return null
      } catch {
        return null
      }
    },
    balancedBefore: async (session, seq) => Boolean((await loadPairing()).before(session, seq)),
    balancedAfter: async (session, seq) => Boolean((await loadPairing()).after(session, seq)),
    compactRegion: async (start, end, agent, signal) => {
      const engine = (agent as { ctx?: { compaction?: { compactRegion?: (s: number, e: number, a: unknown, sig?: AbortSignal) => Promise<unknown> } } } | undefined)?.ctx
        ?.compaction
      if (engine?.compactRegion === undefined) {
        throw new Error('compaction engine 在目标会话作用域内不可用（预设未挂 compaction 组？）')
      }
      return engine.compactRegion(start, end, agent, signal)
    },
    now: () => Date.now(),
  })

  const assembled = createRouterCore({
    ledger,
    docsFor,
    bridge,
    relay,
    driver,
    scheduler,
    ui,
    hosts,
    config,
    newId: () => randomUUID(),
    isRunning: (sessionId) => bridge.isRunning(sessionId),
    maxActiveCards: config.maxActiveCards,
    tasksDir: config.tasksDir,
    memory: memoryFace,
    logger: { warn: (message: string) => log.warn(message) },
  })

  // 供预设树的工具行 / 上下文行经作用域链注入；memory 一并挂上（brief 形状）。
  ctx.provide('routerCore', {
    ...assembled.core,
    snapshotText: assembled.snapshotText,
    memory: { search: memoryFace.search },
  })

  // 会话空闲：压缩驱动（pending 只由我方投递打标；idle 且无排队消息才动作）
  // + 记忆增量摘要（worker/主管会话后台跑，同会话同增量位只跑一次）。
  bridge.watchStatus()
  bridge.onStatusChange((sessionId, running) => {
    if (running) return
    void driver.onIdle(sessionId).then((outcome) => {
      if (outcome === 'compacted') log.info(`会话 ${sessionId} 派发后上下文整理完成`)
    })
    void (async () => {
      if (!(await isTaskSession(sessionId))) return
      summarizer.onIdle(sessionId)
    })()
  })

  // 问答瀑布：全局监听收所有会话；prepend 抢在客户端兜底 UI 之前认领 worker 提问
  //（答案走 Router 界面浮窗，见规格 §3.3）。
  ctx.on('user-questions/request', (async (request: unknown, next: () => Promise<unknown>) => {
    const outcome = await relay.claimQuestion(request as never, next)
    // 问答变化影响活动快照的「待回答事项」，同步刷缓存（fire-and-forget）
    void assembled.refreshSnapshot()
    return outcome
  }) as unknown as (...args: unknown[]) => unknown, { prepend: true })

  // 启动恢复：UI 状态装载 + 账本孤儿问题清理 + 快照缓存预热。
  ctx.effect(() => {
    void (async () => {
      await ui.load()
      await ledger.listAll()
      const recovered = await assembled.recoverOrphans()
      if (recovered.length > 0) log.warn(`重启恢复：${recovered.length} 个待答问题已失效，对应任务标为受阻`)
      await assembled.refreshSnapshot()
      log.info('routerCore 就绪')
    })()
  }, 'dsh-router: 启动恢复')

  // 四条 HTTP 路由（webServer/connection 机会式：缺席不挡装载）。
  ctx.inject?.(['webServer', 'connection'], (child) => {
    registerRouterRoutes(child as RouterRoutesContext, {
      getState: (workspaceId) => assembled.workbench.state(workspaceId),
      createRouterSession: (workspaceId, name) => assembled.workbench.createRouterSession(workspaceId, name),
      answerQuestion: async (questionId, answers) => {
        await assembled.workbench.answerQuestion(questionId, answers)
        void assembled.refreshSnapshot()
      },
      closeTab: (workspaceId, sessionId) => assembled.workbench.closeTab(workspaceId, sessionId),
    })
  })

  function workerInstructionsText(): string {
    return WORKER_INSTRUCTIONS
  }
}

