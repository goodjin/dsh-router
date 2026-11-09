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
 *     → 五条 HTTP exact 路由（webServer/connection 机会式注入；state 前置
 *       入口去重扫描，C4）
 *
 * 配置照 auto-resume 先例：Config 全部 volatile 可缺省，apply 内再做一层防御性
 * 解析（缺省补默认、负数取 0），宿主各版本 schema 默认值行为不一致时插件自己兜底。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import { TaskLedger, type LedgerFile, type LedgerPersistence } from './host/ledger/store.ts'
import { LedgerError } from './host/ledger/errors.ts'
import { TaskDocStore } from './host/docs/task-docs.ts'
import { Scheduler } from './host/ledger/scheduler.ts'
import { SessionBridge, type WorkspaceInfo, type AgentInterruptFace, releaseObservation } from './host/bridge/sessions.ts'
import { AnswerRelay, DEFAULT_QUESTION_BUDGET } from './host/bridge/questions.ts'
import { UiStateStore, type UiStateFile, type UiStatePersistence } from './host/bridge/tabs.ts'
import { createRouterAdoptionCache, routerAdoptionDiagnostics, scanAndAdoptRouterSessions } from './host/bridge/router-adoption.ts'
import { SessionHeaderIndex, type IndexFileState } from './host/session/session-index.ts'
import { CompactionDriver } from './host/context/compaction-driver.ts'
import { registerRouterRoutes, type RouterRoutesContext } from './host/routes.ts'
import { createRouterCore, type RouterCoreConfig, type RouterCoreHosts, type RouterMemory } from './host/core.ts'
import { workerInstructions as WORKER_INSTRUCTIONS } from './host/prompts/worker-instructions.ts'
import { SessionPromptStore } from './host/prompts/session-prompt.ts'
import { routerPrompt } from './host/prompts/router.ts'
import { BUILTIN_GENERAL_ID, BUILTIN_TEMPLATES, RouterDefaultsStore, WorkerTypeStore } from './host/templates.ts'
import { dynamicPresetId } from './host/presets/dynamic.ts'
import { DynamicPresetEngine, type AgentPresetsFace } from './host/presets/lifecycle.ts'
import { MemoryDocStore } from './host/memory/store.ts'
import { ClosureIntentStore, OutcomeAdjudicator } from './host/guard/adjudicator.ts'
import { NotificationStore, anomalyActions } from './host/guard/notifications.ts'
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
import type { SpawnModeResponse, WorkerSpawnMode, WorkerTemplate, WorkerTypeRecord } from './shared/view-contract.ts'
import { CircuitBreaker, DEFAULT_BREAKER_WINDOW_MS, DEFAULT_CREATION_THRESHOLD, DEFAULT_INFRA_THRESHOLD, type BreakerVisibility } from './host/guard/breaker.ts'
import { DispatchBudgets } from './host/guard/budgets.ts'
import { FirstRequestCacheObserver } from './host/observability.ts'

export { Config } from './host/root-config.ts'

/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
export const name = '@goodjin2/dsh-router'

/** 事件订阅面（窄接口：只要求 on）。 */
export interface EventBinder {
  on(event: string, listener: (...args: unknown[]) => unknown): unknown
}

/** 索引的 live 生命周期面（SessionHeaderIndex 的这三个入口）。 */
export interface LiveLifecycleFace {
  onLiveSession(session: unknown): void
  onLiveSessionEvent(session: unknown, event: unknown): void
  onLiveSessionDisposed(session: unknown): void
}

/**
 * live 生命周期接线（宿主契约）：
 * - `session/created`：会话进入 live store → 权威组合投影直达判定；
 * - `session/event`：`agent-preset/selected` 是权威提交信号；
 * - `session/disposed`：会话离开 live store（含发布回滚）→ **撤销 live 权威
 *   代际**，进入受控冷重判/unknown（review I6：离开 live 后不再有投影事件
 *   维护的旧事实不得继续授权）。
 *
 * 三个事件共用同一生命周期 token（索引侧按实例身份判定），旧实例的
 * disposed 不清新实例。
 */
export function bindSessionLifecycle(ctx: EventBinder, index: LiveLifecycleFace): void {
  ctx.on('session/created', ((session: unknown) => { index.onLiveSession(session) }) as (...args: unknown[]) => unknown)
  ctx.on('session/event', ((session: unknown, event: unknown) => { index.onLiveSessionEvent(session, event) }) as (...args: unknown[]) => unknown)
  ctx.on('session/disposed', ((session: unknown) => { index.onLiveSessionDisposed(session) }) as (...args: unknown[]) => unknown)
}

/** 身份卡投递面（桥的幂等投递）。 */
export interface IdentityCardDeliverer {
  /** 投递（失败向上抛）。 */
  (sessionId: string): Promise<void>
}

/**
 * 身份卡投递包装（review I2）：
 * - `strict`：**失败向上抛**——收编面据此判定"投递真的成功了吗"，只有真成功
 *   才记账（否则失败被吞掉后收编器会把候选记成已投递，永久不再补发）。
 * - `lenient`：失败只告警——保留给"创建成功后补发"这类不该被投递失败打断
 *   主流程的路径。
 */
export function makeIdentityCardDeliverer(
  deliver: (sessionId: string) => Promise<void>,
  log: { warn(message: string): void },
): { strict: IdentityCardDeliverer; lenient: IdentityCardDeliverer } {
  return {
    strict: async (sessionId: string) => { await deliver(sessionId) },
    lenient: async (sessionId: string) => {
      try {
        await deliver(sessionId)
      } catch (error) {
        log.warn(`Router 身份卡投递失败（下次 state 重试，requestId 幂等）: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/** 必需的宿主服务（缺席行装载失败，fail loud，不留静默残废）。
 *  agentPresets（r4 §1：动态注册预设的注册表，宿主基础组合常驻服务）。 */
export const inject = ['sessionController', 'agents', 'workspaceRegistry', 'sessionQuery', 'llm', 'agentPresets']

/** 宿主上下文的最小面（窄接口；webServer/connection 走机会式注入）。 */
interface RootContext {
  sessionController: RouterCoreHosts['sessionController']
  /**
   * agents 服务（宿主 Cordis 键 'agents'）。核心逻辑只用 get 取 live agent
   * （模型路由解析/压缩驱动）；紧急暂停（v1.2 B4）另经同一 get 面取
   * cancel——AgentInterruptFace 的形状（r8 §5：
   * agents.get(id)?.cancel({kind:'hook',reason},{keepInbox:true})）。
   */
  agents: AgentInterruptFace
  /** agentPresets 注册表（r4 §1：register 返回注销器，重复 id 当场抛）。 */
  agentPresets: AgentPresetsFace
  workspaceRegistry: {
    list(): unknown[]
    get(id: string): unknown
    /** C4 去重用（r2 §5：registry 原生 pin/归档面；缺席时去重静默降级）。 */
    pinSession?(sessionId: string): Promise<unknown>
    archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<unknown>
    archivedSessionIds?(): readonly string[]
  }
  /** B8 起必需：压缩区域的用户消息锚点 + 记忆增量摘要的事件租约。 */
  sessionQuery: {
    observeSession(sessionId: string): Promise<SessionObservationLike>
    readSurface?(sessionId: string): Promise<{ events: { seq: number; type: string }[] } | undefined>
    /** v1.4 收编扫描用：整日志快照读（r2 §6）；缺席时收编降级跳过。 */
    readSession?(sessionId: string): Promise<unknown>
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
  routerPreset: string
  supervisorPreset: string
  workerPreset: string
  /** worker 派生模式（v1.3 C2）：volatile，运行时经 /router/spawn-mode 可改。 */
  workerSpawnMode: WorkerSpawnMode
  summarizationProvider: string
  summarizationModel: string
  /** 三层记忆总开关（默认停用；见 root-config memoryEnabled 注释）。 */
  memoryEnabled: boolean
  questionBudget: number
  firstResponseTimeoutMs: number
  adjudicationWallClockMs: number
  breakerWindowMs: number
  breakerInfraThreshold: number
  breakerCreationThreshold: number
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

/**
 * 布尔（记忆开关）：volatile 惰性描述符先解引用（同 spawnModeOr 的取证结论），
 * 只有显式 true 才开——缺省、形状不对一律停用（先屏蔽记忆的既定方向）。
 */
function booleanOr(value: unknown): boolean {
  const resolved = typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get: () => unknown }).get()
    : value
  return resolved === true
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

/**
 * 模式解析（v1.3 A1；评审 F1 修正）：宿主 loader 经 Config["~standard"].validate
 * 把 volatile 字段包成 {get} 惰性描述符再传 apply——先解引用再认字面值，只认两个
 * 合法值，其余回默认 cache-priority。导出供测试。
 */
export function spawnModeOr(value: unknown): WorkerSpawnMode {
  const resolved = typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get: () => unknown }).get()
    : value
  return resolved === 'minimal-face' ? 'minimal-face' : 'cache-priority'
}

/** 防御性解析（导出仅为测试与将来复用）：缺省补默认、枚举外回默认、负数取 0。 */
export function resolveRootConfig(raw: unknown): ResolvedRootConfig {
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
    // v1.3 C2（规格 §1）：防御性解析——两枚举值之外一律回默认 cache-priority
    //（宿主各版本对 union schema 缺省行为不一致时插件自己兜底，与 resolveRootConfig 总口径一致）。
    summarizationProvider: stringOr(source.summarizationProvider, ''),
    summarizationModel: stringOr(source.summarizationModel, ''),
    memoryEnabled: booleanOr(source.memoryEnabled),
    questionBudget: nonNegative(source.questionBudget, DEFAULT_QUESTION_BUDGET),
    firstResponseTimeoutMs: nonNegative(source.firstResponseTimeoutMs, 600_000),
    adjudicationWallClockMs: nonNegative(source.adjudicationWallClockMs, 1_800_000),
    breakerWindowMs: nonNegative(source.breakerWindowMs, DEFAULT_BREAKER_WINDOW_MS),
    breakerInfraThreshold: nonNegative(source.breakerInfraThreshold, DEFAULT_INFRA_THRESHOLD),
    breakerCreationThreshold: nonNegative(source.breakerCreationThreshold, DEFAULT_CREATION_THRESHOLD),
    workerSpawnMode: spawnModeOr(source.workerSpawnMode),
    templates: templatesOr(source.templates),
  }
}

/** 原子写序号：与 pid 一起保证同目录临时文件名唯一，并发写不互踩临时文件。 */
let atomicTmpSeq = 0

/**
 * 原子写：写同目录临时文件再 rename 覆盖。rename 原子性保证崩溃时目标文件
 * 要么旧版完整、要么新版完整，绝不留下半写截断的 JSON（账本/索引/类型文件
 * 一旦截断，load 解析失败返 null 会静默清零全部数据）。
 */
async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${++atomicTmpSeq}`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** node:fs/promises 适配成 FsAdapter。 */
function fsAdapter(): FsAdapter {
  return {
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, content) => atomicWriteFile(p, content),
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
      await atomicWriteFile(path, JSON.stringify(value, null, 2))
    },
  } as never
}

/** 装载入口：组装根服务并挂接宿主。 */
export function apply(ctx: RootContext, rawConfig: unknown): void {
  const config = resolveRootConfig(rawConfig)
  const log = ctx.logger?.(name) ?? { info: (m: string) => console.info(`[${name}] ${m}`), warn: (m: string) => console.warn(`[${name}] ${m}`) }

  // v1.3 C2：worker 派生模式的运行时值（规格 §1 volatile）。初值 = 启动配置；
  // 设置页 POST 即改（即时生效，存量任务/会话不受影响）；不落盘——宿主重启
  // 回到启动配置值（要常驻用宿主设置页改 workerSpawnMode 配置）。
  let currentSpawnMode: WorkerSpawnMode = config.workerSpawnMode
  const spawnMode = (): WorkerSpawnMode => currentSpawnMode

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

  // 收编扫描的跨轮护栏（2026-11-07 OOM 现场之后补回）：判定源换成受限索引
  //（冷盘有界扫描 + live 投影直达 + 指纹持久复用），稳态轮询零副作用；
  // 收编只做定点核验与幂等登记/补发，绝不整日志 readSession。
  const adoptionCache = createRouterAdoptionCache()

  // 全局派发熔断器（v1.2 规格 §2）：状态落 <dataDir>/guard-state.json，宿主重启
  // 恢复冻结态（启动 effect 里自报）；窗口/阈值可配（root-config）。
  const breaker = new CircuitBreaker({
    fs,
    path: join(config.dataDir, 'guard-state.json'),
    now: () => Date.now(),
    windowMs: config.breakerWindowMs,
    infraThreshold: config.breakerInfraThreshold,
    creationThreshold: config.breakerCreationThreshold,
    logger: { warn: (message: string) => log.warn(message) },
  })

  // 派发预算（v1.2 规格 §3）：以轮次近似用户消息边界——running→true 即新轮
  //（下方 onStatusChange 接线；ask_user 的回答开启新轮，预算自然重计）。
  const budgets = new DispatchBudgets()

  // guard 通知段（v1.2 B4 最小投影）：B3 的统一通知面未合并前，紧急暂停的异常
  // 通知先落 <dataDir>/guard-notifications.json（guard-state.json 由熔断器独占，

  // worker 类型存储 + Router 默认值（v1.1 规格 §5/§6；首启种子化导入 v1 Config
  // 模板后 legacyImported 落盘，v1 templates 配置通道退役）。
  const typeStore = new WorkerTypeStore(fs, join(config.dataDir, 'worker-types.json'), {
    seedTemplates: config.templates,
  })
  const defaultsStore = new RouterDefaultsStore(fs, join(config.dataDir, 'router-defaults.json'))
  // 会话级系统提示词覆盖（v1.1 C5，规格 §7）：dataDir/router-prompts.json。
  // 默认文本走内存缓存（section 的 text 回调是同步的，不能等 defaults 读盘）：
  // 初值 = prompts/router.ts 静态缺省，启动恢复与每次保存默认后刷新缓存。
  const sessionPrompts = new SessionPromptStore(fs, join(config.dataDir, 'router-prompts.json'))
  let defaultsText = routerPrompt
  /** prompt-section 行的同步文本源：当前会话覆盖 ?? 默认（缓存）。 */
  const sessionPromptText = (sessionId?: string): string => {
    if (sessionId === undefined) return defaultsText
    return sessionPrompts.get(sessionId) ?? defaultsText
  }

  /** templateId → 预设 id：启用类型走动态预设；内置通用 worker 走静态预设
   *  （保证任何情况下可派发）；禁用/未知 → undefined（回退静态角色预设，
   *  由核心的 assertTemplateUsable 拒绝派发）。 */
  const resolvePresetForTemplate = async (
    templateId: string,
    role: 'supervisor' | 'worker',
  ): Promise<string | undefined> => {
    const record = await typeStore.get(templateId)
    if (record === undefined || !record.enabled || record.role !== role) return undefined
    if (record.origin === 'builtin') return role === 'worker' ? config.workerPreset : config.supervisorPreset
    return dynamicPresetId(templateId)
  }

  const workspaceRegistry: RouterCoreHosts['workspaceRegistry'] = {
    list: () => (ctx.workspaceRegistry.list() as WorkspaceInfo[]),
    get: (id: string) => ctx.workspaceRegistry.get(id) as WorkspaceInfo | undefined,
  }

  // 会话候选索引（v1.4 性能修复：router-header-index 已评审版本的接线）：
  // 判定改走有界会话头读取 + 持久化增量索引（SessionHeaderIndex），不再
  // sessionQuery.readSession 整日志重放（2026-11-07 现场：全量重放把宿主读爆）。
  // 索引根 = <DSH_HOME>/sessions（不猜 dataDir）；背景推进/低频对账经 ctx.effect
  // 挂生命周期（UI 不开着也收敛）；live 会话经 session/created 与
  // agent-preset/selected 事件直达判定（零盘读）。收编（v1.4：Router 会话
  // 全部独立，不去重）只消费索引增量候选与定点核验，见 router-adoption.ts。
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // live 会话直达：权威事实 = 宿主 sessionProjections 的 agentPreset 投影
  //（init 自 creation header、apply 前进于 agent-preset/selected）。只对
  // create/resume 事件携带的已 live Session 调用，绝不触发冷重放；读不到
  // 权威值 → unknown（保守）。
  const resolveLivePreset = (session: unknown): string | null | undefined => {
    try {
      const projections = ctx.get?.('sessionProjections') as
        | { stateOf?(session: unknown, key: string): unknown }
        | undefined
      const value = projections?.stateOf?.(session, 'agentPreset')
      if (typeof value === 'string') return value
      if (value === null) return null
      return undefined
    } catch {
      return undefined
    }
  }
  const sessionHeaderIndex = new SessionHeaderIndex({
    root: join(home, 'sessions'),
    routerPreset: config.routerPreset,
    resolveLivePreset,
    // 宿主成员/归档集快照源（低频刷新 + live 事件失效；轮询零宿主调用）。
    membership: {
      list: () => (ctx.workspaceRegistry.list() as WorkspaceInfo[]),
      get: (workspaceId: string) => ctx.workspaceRegistry.get(workspaceId) as WorkspaceInfo | undefined,
      archivedIds: () => {
        // 宿主为 getter 属性（数组）而非方法；兼容两形状。
        const raw: unknown = (ctx.workspaceRegistry as { archivedSessionIds?: unknown }).archivedSessionIds
        return typeof raw === 'function'
          ? ((raw as () => readonly string[])() ?? [])
          : Array.isArray(raw)
            ? (raw as readonly string[])
            : []
      },
    },
    // 新文件名（session-index.json）：不复用旧去重器的 dedup-index.json 语义。
    persistence: jsonFilePersistence<IndexFileState>(join(config.dataDir, 'session-index.json')),
    logger: { warn: (message: string) => log.warn(message) },
  })
  // hydrate 先于一切工作；索引背景推进 + 低频对账挂在 effect（dispose 安全：
  // 在途读取收尾、状态冲刷完成后旧实例才真正消停）。
  void sessionHeaderIndex.hydrate()
  ctx.effect(() => {
    const stop = sessionHeaderIndex.start()
    return () => {
      stop()
      return sessionHeaderIndex.dispose()
    }
  }, 'dsh-router: 会话头候选索引（收编判定源）')
  // live 生命周期接线（session/created / session/event / session/disposed）：
  // 会话离开 live store 时撤销 live 权威代际 → 受控冷重判/unknown
  // （review I6）；旧实例的 disposed 不清新实例（索引侧按生命周期 token 判定）。
  bindSessionLifecycle(ctx as unknown as EventBinder, sessionHeaderIndex)

  const hosts: RouterCoreHosts = {
    sessionController: ctx.sessionController,
    agents: ctx.agents,
    workspaceRegistry,
    onSessionStatus: (callback) => {
      ctx.on('api-session/status', (sessionId: unknown, running: unknown) => callback(String(sessionId), Boolean(running)))
    },
  }

  // v1.2 B3：onDelivered 晚绑判定器（桥先于判定器建成）
  const adjudicatorRef: { current?: OutcomeAdjudicator } = {}
  // v1.3 A3：minimal 五步的 buildForkSeed 面（@deepseek-ai/dsh-session/fork 懒加载；
  // 缺席时桥降级为普通创建并告警——r10 §2：双版本逐字节一致，正常宿主都有）。
  let forkSeedFn: ((events: readonly never[], boundary: number) => unknown[]) | undefined
  const loadForkSeed = async (): Promise<typeof forkSeedFn> => {
    if (forkSeedFn !== undefined) return forkSeedFn
    try {
      const specifier = '@deepseek-ai/dsh-session/fork'
      const mod = (await import(specifier)) as { buildForkSeed?: unknown }
      forkSeedFn = mod.buildForkSeed as typeof forkSeedFn
    } catch (error) {
      log.warn(`@deepseek-ai/dsh-session/fork 不可用，minimal-face 分叉降级为普通创建: ${error instanceof Error ? error.message : String(error)}`)
    }
    return forkSeedFn
  }
  void loadForkSeed()

  const bridge = new SessionBridge({
    ledger,
    docsFor,
    workspaces: workspaceRegistry,
    onDelivered: (taskId) => { void adjudicatorRef.current?.onDispatched(taskId) },
    presets: { supervisor: config.supervisorPreset, worker: config.workerPreset },
    forTemplate: resolvePresetForTemplate,
    types: { get: (templateId) => typeStore.get(templateId) },
    // 紧急暂停的中断面（v1.2 B4，r8 §5）：agents.get(id)?.cancel —— 幂等、
    // 原因留痕 turn/end、keepInbox 保住排队消息；冷会话天然 no-op。
    interruptFace: ctx.agents,
    workerInstructions: () => workerInstructionsText(),
    logger: { warn: (message: string) => log.warn(message) },
    signal: undefined,
    // v1.3 A2：worker 生成模式与身份卡已发标记（Review Focus 5 幂等）。
    // 传 getter 而非快照：设置页改模式后新派发即用新值（M5）。
    mode: spawnMode,
    identityCards: {
      has: (sessionId: string) => ui.hasIdentityCard(sessionId),
      mark: (sessionId: string) => ui.markIdentityCardSent(sessionId),
    },
    // v1.3 A3：分叉创建面（cache=宿主 fork；minimal=五步复刻的宿主砖块，全可缺席）。
    host: {
      create: async (opts, signal) => (await ctx.sessionController.create(opts, signal)).sessionId,
      prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
      onStatus: (callback) => hosts.onSessionStatus(callback),
      rename: async (sessionId, title) => {
        await ctx.sessionController.rename({ sessionId, title })
      },
      // 规格 §5 默认模型钉法（r4 修正）：宿主 selectModel（UI ModelSelect 同通路）；
      // 宿主缺席时桥降级为不钉（类型清单仍如实记录）。
      selectModel: typeof ctx.sessionController.selectModel === 'function'
        ? (request, signal) => ctx.sessionController.selectModel!(request, signal)
        : undefined,
      // wire session/fork（r10 §1：SessionCommandController.fork({sessionId,...})）。
      fork: typeof (ctx.sessionController as { fork?: unknown }).fork === 'function'
        ? (request: { sessionId: string }, signal?: AbortSignal) =>
            (ctx.sessionController as unknown as {
              fork: (r: { sessionId: string }, signal?: AbortSignal) => Promise<{ sessionId: string }>
            }).fork(request, signal)
        : undefined,
      observeSession: async (sessionId) => {
        const observation = await ctx.sessionQuery.observeSession(sessionId) as {
          events?: unknown[]
          dispose?: () => void
        }
        const events = (observation.events ?? []) as { seq: number; type: string; time?: number; data?: unknown }[]
        // 评审 F7：宿主租约经 [Symbol.dispose] 释放——双通道包装，五步路径不漏租约。
        return { events, dispose: () => releaseObservation(observation) }
      },
      buildForkSeed: async (events, boundary) => {
        const fn = await loadForkSeed()
        if (fn === undefined) return undefined
        return fn(events as never, boundary)
      },
      newSessionId: () => `session-${randomUUID()}`,
      agentsCreate: typeof (ctx.agents as { create?: unknown }).create === 'function'
        ? (options) => (ctx.agents as unknown as { create: (o: unknown) => Promise<unknown> }).create(options)
        : undefined,
      resolvePreset: typeof (ctx.agentPresets as { resolve?: unknown }).resolve === 'function'
        ? (presetId) => (ctx.agentPresets as unknown as { resolve: (id: string) => Promise<{ id: string }> }).resolve(presetId)
        : undefined,
      mountPreset: typeof (ctx.agentPresets as { mount?: unknown }).mount === 'function'
        ? (agentCtx, presetId) => (ctx.agentPresets as unknown as { mount: (c: unknown, id: string) => Promise<unknown> }).mount(agentCtx, presetId)
        : undefined,
      attachWorkspace: async (workspaceId, sessionId) => {
        const registry = ctx.workspaceRegistry as { get?: (id: string) => { attachSession?: (sid: string) => Promise<unknown> } | undefined }
        const workspace = registry.get?.(workspaceId)
        const attach = workspace?.attachSession
        if (typeof attach !== 'function') throw new Error('workspace 缺 attachSession 面')
        await attach.call(workspace, sessionId)
      },
    },
  })

  /**
   * Router 身份卡投递（v1.3 A2 规格 §2.2）：两个入口共用——①我们创建的 Router
   * 会话（POST /router/sessions 成功后）②picker 自建、被收编的 Router 会话
   * （GET /router/state 收编扫描后）。桥内按已发标记幂等，requestId=
   * identity-<sessionId> 宿主侧再去重。
   *
   * 两条路径的失败语义不同（review I2）：创建路径失败只告警（不打断主流程）；
   * **收编路径失败必须向上抛**——只有真成功才记账，否则失败被吞掉后收编器会
   * 把候选记成"已投递"，永久不再补发。
   */
  const identityCardDeliverer = makeIdentityCardDeliverer(
    (sessionId: string) => bridge.deliverRouterIdentityCard(sessionId),
    { warn: (message: string) => log.warn(message) },
  )
  const deliverRouterCard = identityCardDeliverer.lenient
  const deliverRouterCardStrict = identityCardDeliverer.strict

  // 动态预设引擎：类型/默认值变更 → unregister+register 增量同步；每次注册的
  // 注销器自接线 ctx.effect（r4 条件①）；Router 动态注册失败回退静态定义。
  const engine = new DynamicPresetEngine({
    presets: ctx.agentPresets,
    effect: (factory, label) => ctx.effect(factory, label),
    skillDirs: () => undefined, // 初始技能目录解析（C3 设置页接入已装技能包时落地）
    logger: { info: (message: string) => log.info(message), warn: (message: string) => log.warn(message) },
  })

  // 类型写路径后的引擎增量同步（C3 路由 deps 用）：只同步「启用」类型
  //（syncTypes 的调用方约定是喂启用清单；禁用 = 保留注册只拒派发，r4 §4）。
  // builtin 不经引擎（映射静态预设，ensureRegistered 对它恒 false）。
  // v1.3.1 巡检：注册表缺位最长 60 秒内自愈（UI 冷恢复路径等不来入口钩子）。
  ctx.effect(() => {
    const timer = setInterval(() => { void engine.ensureRouterPresent(spawnMode()) }, 60_000)
    return () => clearInterval(timer)
  }, 'dsh-router: 预设注册表巡检')

  const syncTypePresets = async (record: WorkerTypeRecord): Promise<void> => {
    if (!record.enabled || record.origin === 'builtin') return
    const outcome = await engine.syncTypes([record], spawnMode())
    for (const failed of outcome.failed) {
      log.warn(`类型 ${failed} 的动态预设注册失败（派发会被拒；保存的类型数据不受影响）`)
    }
  }

  const relay = new AnswerRelay({
    ledger,
    newId: () => randomUUID(),
    now: () => Date.now(),
    // 提问预算（v1.1 规格 §3.6）：每任务澄清提问批次数上限，超限自动回答案。
    questionBudget: config.questionBudget,
    // Router 会话每轮 1 批提问（v1.2 规格 §3）：认领层强制，第二批自动回
    //「请合并为一批重问」。Router 会话清单以 UI 登记为准。
    routerQuestions: {
      isRouterSession: (sessionId: string) => ui.routerSessions().some((entry) => entry.sessionId === sessionId),
      tryConsumeQuestionBatch: (sessionId: string) => budgets.tryConsumeQuestionBatch(sessionId),
    },
    logger: { warn: (message: string) => log.warn(message) },
  })
  const scheduler = new Scheduler(ledger, {
    maxDepth: config.maxDepth,
    concurrency: { default: config.perTypeConcurrency },
  })

  // 记忆服务接线（计划 B8）：三层文档 store 根目录 = <dataDir>/memory/；
  // 事件读走 observeSession 租约（adapter 内 finally 释放）；摘要流走
  // ctx.llm.stream（purpose:'compaction'）。路由对解析链：配置对 → 活任务
  // 会话最近一次路由头（compaction-basic routedTarget 同款）→ 缺失（触发方 warn）。
  //
  // 2026-11-09 起默认整体停用（memoryEnabled，默认 false）：后台增量摘要、完成
  // 记忆写入、事故写入、检索注入全部不接线——那条摘要通道借别的会话路由且
  // 消息形状曾不合宿主契约（「判定模型返回空白」事故）。判定已改为原会话
  // 自判，不再依赖此通道；重新启用前须按需求 §12 的既定方向改为原会话内进行。
  const closureIntents = new ClosureIntentStore({ fs, path: join(config.dataDir, 'closure-intents.json'), logger: { warn: (m) => log.warn(m) } })
  const notifications = new NotificationStore({ fs, path: join(config.dataDir, 'notifications.json'), newId: () => randomUUID(), logger: { warn: (m) => log.warn(m) } })
  let memoryStore: MemoryDocStore | undefined
  let memoryFace: RouterMemory | undefined
  let summarizer: BackgroundSummarizer | undefined
  const recordIncident = (entry: { taskId: string; title: string; text: string }): void => {
    if (!config.memoryEnabled || memoryStore === undefined) return
    void memoryStore.appendSummary('project', `任务 ${entry.taskId}`, {
      sourceRefs: [`task:${entry.taskId}`],
      kind: 'verified-fact',
      text: entry.text,
    }).catch((error) => {
      log.warn(`事故记忆写入失败（${entry.taskId}）: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  if (config.memoryEnabled) {
    memoryStore = new MemoryDocStore(join(config.dataDir, 'memory'), fs)
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
    const store = memoryStore

    summarizer = new BackgroundSummarizer({
      maxSeq: (sessionId) => maxSurfaceSeq(memoryQuery, sessionId),
      run: (sessionId) => summarizeSessionViaQuery(memoryQuery, store, sessionId, summaryLlm),
      onError: (sessionId, error) => {
        log.warn(`会话 ${sessionId} 记忆增量摘要失败（下次 idle 或新事件后重试）: ${error instanceof Error ? error.message : String(error)}`)
      },
    })

    const recordTaskMemory = createCompletedTaskRecorder({
      store,
      query: memoryQuery,
      llm: summaryLlm,
      onError: (_stage, error) => {
        log.warn(`任务完成的记忆写入失败（不阻塞完成协议）: ${error instanceof Error ? error.message : String(error)}`)
      },
    })

    /** routerCore.memory（brief 形状：search 直传 retrieval）。 */
    memoryFace = {
      search: (query: string, scope: 'project' | 'global') => searchMemory(store, query, scope),
      onTaskCompleted: (input: Parameters<typeof recordTaskMemory>[0]) => recordTaskMemory(input),
    }
  } else {
    log.info('三层记忆已停用（memoryEnabled=false）：后台摘要/完成写入/事故写入/检索注入均不接线')
  }

  /** 该会话是否绑定了任务（= worker/主管会话；Router 会话不做增量摘要）。 */
  const isTaskSession = async (sessionId: string): Promise<boolean> => {
    const records = await ledger.listAll()
    return records.some((record) => record.sessionId === sessionId)
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
    notifications,
    ledger,
    docsFor,
    bridge,
    relay,
    driver,
    scheduler,
    ui,
    hosts,
    config,
    types: {
      enabled: () => typeStore.enabledTemplates(),
      summaries: () => typeStore.summaries(),
      // C2 类型工具的创建通道：建 router 来源类型后立刻经 C1 引擎增量同步
      // （注册动态预设）；校验/注册失败返回 false，由 create_worker_type 输出
      // 如实带出（不静默）。
      createRouterType: async (input) => {
        const record = await typeStore.create({ ...input, origin: 'router', enabled: true })
        const presetRegistered = await engine.ensureRegistered(record, spawnMode())
        return { record, presetRegistered }
      },
    },
    routerDefaults: { get: () => defaultsStore.get() },
    newId: () => randomUUID(),
    isRunning: (sessionId) => bridge.isRunning(sessionId),
    maxActiveCards: config.maxActiveCards,
    tasksDir: config.tasksDir,
    // 记忆停用时整个面缺席：search_history 如实回「记忆服务未配置」、完成不写记忆。
    ...(memoryFace === undefined ? {} : { memory: memoryFace }),
    breaker,
    budgets,
    logger: { warn: (message: string) => log.warn(message) },
  })

  // 供预设树的工具行 / 上下文行 / prompt-section 行经作用域链注入；memory 一并挂上（brief 形状）。
  // callerRoleOf（v1.3 A1）：superset 工具行执行层硬闸的角色数据源。
  ctx.provide('routerCore', {
    ...assembled.core,
    snapshotText: assembled.snapshotText,
    // v1.1 C5：会话级系统提示词文本源（prompt-section 行的 complete section 消费）。
    sessionPromptText,
    ...(memoryFace === undefined ? {} : { memory: { search: memoryFace.search } }),
    callerRoleOf: (sessionId: string) => assembled.core.callerRoleOf!(sessionId),
  })

  // 会话空闲：压缩驱动（pending 只由我方投递打标；idle 且无排队消息才动作）
  // + 记忆增量摘要（worker/主管会话后台跑，同会话同增量位只跑一次）。
  // v1.2 B3：结果判定器（事件驱动两级 + 兜底定时器；规格 §4）
  const adjudicator = new OutcomeAdjudicator({
    ledger,
    observeSession: async (sessionId, options) => {
      void options
      const observation = await ctx.sessionQuery.observeSession(sessionId) as { events?: unknown[]; dispose?: () => void }
      try {
        return { events: observation.events ?? [] }
      } finally {
        observation.dispose?.()
      }
    },
    prompt: (request) => ctx.sessionController.prompt(request, AbortSignal.timeout(120_000)) as Promise<{ accepted: boolean }>,
    sessionState: async (sessionId) => {
      const state = (ctx.sessionController as {
        state?: (id: string) => Promise<{ running?: boolean; pendingInput?: readonly string[] } | undefined>
      }).state
      return state === undefined ? undefined : await state(sessionId)
    },
    agentsGet: (sessionId) => {
      const agent = ctx.agents.get(sessionId) as { status?: string } | undefined
      return agent === undefined || agent.status === undefined ? undefined : { status: agent.status }
    },
    core: {
      completeTask: (caller, taskId, input) => assembled.core.completeTask(caller, taskId, input),
      reportBlocker: (caller, taskId, reason) => assembled.core.reportBlocker(caller, taskId, reason),
    },
    intents: closureIntents,
    recordIncident,
    now: () => Date.now(),
    schedule: (delayMs, fn) => {
      const timer = setTimeout(() => { void fn() }, delayMs)
      return () => clearTimeout(timer)
    },
    ...(config.firstResponseTimeoutMs !== undefined ? { firstResponseTimeoutMs: config.firstResponseTimeoutMs } : {}),
    ...(config.adjudicationWallClockMs !== undefined ? { adjudicationWallClockMs: config.adjudicationWallClockMs } : {}),
    logger: { warn: (m) => log.warn(m) },
  })
  adjudicatorRef.current = adjudicator

  bridge.watchStatus()
  // 轮次边界（v1.2 规格 §3）：running→true 即新轮——预算清零重计（ask_user 的
  // 回答开启新轮，自然重计）。
  bridge.onStatusChange((sessionId, running) => {
    if (running) budgets.onTurnStart(sessionId)
  })
  bridge.onStatusChange((sessionId, running) => {
    if (running) return
    void driver.onIdle(sessionId).then((outcome) => {
      if (outcome === 'compacted') log.info(`会话 ${sessionId} 派发后上下文整理完成`)
    })
    void (async () => {
      if (summarizer === undefined) return
      if (!(await isTaskSession(sessionId))) return
      summarizer.onIdle(sessionId)
    })()
  })

  // v1.2 B3：轮沿喂判定器（去抖在判定器内）
  bridge.onStatusChange((sessionId, running) => {
    if (running) adjudicator.onTurnStart(sessionId)
    else adjudicator.onTurnEnd(sessionId)
  })
  void adjudicator.syncWatched()

  // 问答瀑布：全局监听收所有会话；prepend 抢在客户端兜底 UI 之前认领 worker 提问
  //（答案走 Router 界面浮窗，见规格 §3.3）。
  ctx.on('user-questions/request', (async (request: unknown, next: () => Promise<unknown>) => {
    const outcome = await relay.claimQuestion(request as never, next)
    // 问答变化影响活动快照的「待回答事项」，同步刷缓存（fire-and-forget）
    void assembled.refreshSnapshot()
    return outcome
  }) as unknown as (...args: unknown[]) => unknown, { prepend: true })

  // 缓存命中观测（v1.3 C1，规格 §4 / r11）：根作用域 session/event 放行向上，
  // 一个监听器收所有会话的落账事件——过滤任务会话首条 assistant/message 的
  // data.usage.cacheReadTokens 记进账本任务（fire-and-forget，观测不挡事件流）。
  const cacheObserver = new FirstRequestCacheObserver({ ledger, logger: { warn: (message) => log.warn(message) } })
  ctx.on('session/event', ((session: unknown, event: unknown) => {
    void cacheObserver.onSessionEvent(session, event)
  }) as unknown as (...args: unknown[]) => unknown)

  // 启动恢复：动态预设同步（Router 动态化→静态兜底 + 启用类型全量注册）+ UI
  // 状态装载 + 账本孤儿问题清理 + 快照缓存预热 + 会话提示词覆盖装载。
  ctx.effect(() => {
    void (async () => {
      const defaults = await defaultsStore.get()
      defaultsText = defaults.routerSystemPrompt // 默认文本缓存刷新（section 同步读）
      const routerOutcome = await engine.syncRouter(spawnMode())
      const enabledTypes = (await typeStore.list()).filter((record) => record.enabled)
      const outcomes = await engine.syncTypes(enabledTypes, spawnMode())
      if (outcomes.failed.length > 0) {
        log.warn(`动态预设注册失败被跳过的类型（派发会被拒）: ${outcomes.failed.join('、')}`)
      }
      log.info(`动态预设同步完成：Router=${routerOutcome}，类型注册 ${outcomes.registered.length} 个（内置 ${BUILTIN_GENERAL_ID} 走静态预设）`)
      await sessionPrompts.load()
      await ui.load()
      await ledger.listAll()
      const recovered = await assembled.recoverOrphans()
      if (recovered.length > 0) log.warn(`重启恢复：${recovered.length} 个待答问题已失效，对应任务标为受阻`)
      // 熔断状态恢复自报（规格 §2：宿主重启恢复冻结态；冻结时一切派发被拒，
      // 直至用户解除）。
      const guardState = await breaker.state()
      if (guardState.frozen) {
        const frozenAt = guardState.frozenAt !== undefined ? new Date(guardState.frozenAt).toISOString() : '未知时间'
        log.warn(`重启恢复：派发已冻结（${guardState.reason ?? '原因未记录'}，冻结于 ${frozenAt}）——请停止重试并向用户报告，直至用户解除`)
      }
      await assembled.refreshSnapshot()
      log.info('routerCore 就绪')
    })()
  }, 'dsh-router: 启动恢复与动态预设同步')

  // HTTP 路由（webServer/connection 机会式：缺席不挡装载）。
  // C4：GET /router/state 前先收编扫描（判定走受限索引，稳态零副作用）。
  // C3：worker 类型 / Router 默认值七条路由——写操作走 WorkerTypeStore /
  // RouterDefaultsStore，成功后触发动态预设引擎增量同步（重注册即重载工具行，
  // 该类型的 dispatch 描述随之刷新；Router 预设的描述刷新钩子归 C2，见任务报告）。
  // v1.4：GET /router/health 轻量诊断（索引 + 收编计数，无私有内容）。
  ctx.inject?.(['webServer', 'connection'], (child) => {
    registerRouterRoutes(child as RouterRoutesContext, {
      getHealth: async () => ({
        ...sessionHeaderIndex.diagnostics(),
        adoption: routerAdoptionDiagnostics(adoptionCache),
      }),
      getState: async (workspaceId) => {
        // v1.4：Router 会话不再去重——每次新建独立。这里只做收编扫描：把
        // picker 自建的 Router 预设会话登记进 routerSessions 并幂等补发身份卡。
        // 判定源是受限索引（资格授予 + 定点核验），稳态轮询零副作用。
        try {
          await scanAndAdoptRouterSessions({
            // 判定 + 成员定位 + 资格授予都走索引面：收编侧不再遍历宿主全部
            // 工作区/会话（稳态零成员枚举，review I7）。
            index: sessionHeaderIndex,
            known: (sessionId) => ui.routerSessions().some((entry) => entry.sessionId === sessionId),
            register: async (sessionId, wsId) => { await ui.addRouterSession(sessionId, wsId, 'Router') },
            // 收编面的投递**传播失败**：只有真成功才记账（review I2）。
            deliver: async (sessionId) => { await deliverRouterCardStrict(sessionId) },
            logger: { warn: (message: string) => log.warn(message) },
          }, config.routerPreset, adoptionCache)
        } catch (error) {
          log.warn(`Router 会话收编扫描失败（下轮重试）: ${error instanceof Error ? error.message : String(error)}`)
        }
        const state = await assembled.workbench.state(workspaceId)
        // 诊断（v1.5 修正）：以注册表花名册为准（引擎 disposers 只是内部账）。
        const rosterIds = await (ctx.agentPresets as unknown as { list: () => Promise<{ id: string }[]> }).list().then((rows) => rows.map((row) => row.id)).catch(() => [] as string[])
        return { ...state, presets: { routerRegistered: rosterIds.includes('dsh-router'), typePresetIds: rosterIds.filter((id) => id.startsWith('dsh-router')) } }
      },
      createRouterSession: async (workspaceId, name) => {
        // v1.3.1 自愈：创建前确保 Router 预设在册（重应用窗口/注册失败遗留）。
        await engine.ensureRouterPresent(spawnMode())
        const created = await assembled.workbench.createRouterSession(workspaceId, name)
        // v1.3 A2 规格 §2.2：Router 会话创建成功后投递一次身份卡（幂等）。
        await deliverRouterCard(created.sessionId)
        return created
      },
      answerQuestion: async (questionId, answers) => {
        await assembled.workbench.answerQuestion(questionId, answers)
        void assembled.refreshSnapshot()
      },
      closeTab: (workspaceId, sessionId) => assembled.workbench.closeTab(workspaceId, sessionId),
      listWorkerTypes: async () => ({ types: await typeStore.list() }),
      createWorkerType: async (input) => {
        const type = await typeStore.create(input)
        await syncTypePresets(type)
        return { type }
      },
      updateWorkerType: async ({ templateId, patch }) => {
        const type = await typeStore.update(templateId, patch)
        await syncTypePresets(type)
        return { type }
      },
      setWorkerTypeEnabled: async ({ templateId, enabled }) => {
        const type = await typeStore.setEnabled(templateId, enabled)
        // 禁用不注销（保留注册只拒派发，r4 §4）；重新启用时重注册（定义可能在禁用期被改过）。
        await syncTypePresets(type)
        return { type }
      },
      removeWorkerType: async (templateId) => {
        await typeStore.remove(templateId)
        await engine.removeType(templateId) // 删除 = 注销动态预设（已关闭会话需重建同名类型才可重开）
      },
      getDefaults: () => defaultsStore.get(),
      saveDefaults: async (value) => {
        const saved = await defaultsStore.set(value)
        // C5 起 Router 动态定义不烘焙默认文本（prompt-section 运行时经
        // sessionPromptText 现读），默认值变更只需刷新缓存，不再重注册预设——
        // 也避免「保存默认时重注册瞬败 → 回退静态 persona 行 → 丢失会话级
        // 覆盖能力」的回归路径。
        defaultsText = saved.routerSystemPrompt
        return saved
      },
      // v1.3 C2 spawn-mode（规格 §1 volatile）：内存易变 holder——POST 即时生效
      // 不落盘，宿主重启回到启动配置值（要常驻用宿主设置页改 workerSpawnMode
      // 配置）。Part A 的组合引擎/分叉创建消费同一 holder（读 spawnMode()）。
      getSpawnMode: async (): Promise<SpawnModeResponse> => ({ mode: spawnMode() }),
      saveSpawnMode: async (mode: WorkerSpawnMode): Promise<SpawnModeResponse> => {
        currentSpawnMode = mode
        return { mode: spawnMode() }
      },
      // 会话级系统提示词（v1.1 C5）：读带 isDefault 标记；写空串 = 清除回落
      // 默认。写后下一轮 system prompt 组装即生效（section text 每轮现读）。
      getSessionPrompt: async (sessionId) => {
        const override = sessionPrompts.get(sessionId)
        return override !== undefined
          ? { prompt: override, isDefault: false }
          : { prompt: defaultsText, isDefault: true }
      },
      saveSessionPrompt: async (sessionId, prompt) => {
        if (prompt === '') await sessionPrompts.clear(sessionId)
        else await sessionPrompts.set(sessionId, prompt)
      },
      ackNotification: (cardId: string) => notifications.ack(cardId),

      /* ── 用户控制与紧急暂停（v1.2 B4）：用户发起，绕过模型侧预算；caller 记 'user' ── */
      controlTask: async (taskId, action, note) => {
        if (action === 'redispatch') {
          // redispatch 是再派发：受熔断约束（冻结时明确提示先解除；其余闸门
          // ——状态机/依赖/深度——由 supplementTask 的既有路径把守）。
          const breakerState = await breaker.state()
          if (breakerState.frozen) {
            throw new LedgerError(
              'dispatch-frozen',
              `派发已冻结（${breakerState.reason ?? '原因未记录'}）：重派被拒——请先解除冻结（POST /router/breaker/unfreeze 或工作台「解除冻结」），再重派任务 ${taskId}`,
            )
          }
          await assembled.core.supplementTask('user', taskId, ['用户重派：请按任务书当前版本推进（用户经控制路由发起）'])
          const record = assembled.core.getTask(taskId)
          return { status: record?.status ?? 'failed' }
        }
        return assembled.core.controlTask('user', taskId, action, note)
      },
      unfreezeBreaker: async () => {
        const beforeState = await breaker.state()
        const before: BreakerVisibility = { frozen: beforeState.frozen }
        if (beforeState.frozen) {
          if (beforeState.reason !== undefined) before.reason = beforeState.reason
          if (beforeState.frozenAt !== undefined) before.frozenAt = beforeState.frozenAt
        }
        await breaker.unfreeze()
        const afterState = await breaker.state()
        // 冻结期间被跳过的就绪任务（M1）：解冻后立即补派一轮，不靠下一次
        // 完成事件碰巧触发。dispatchReady 内部自带冻结/预算闸门，重复安全。
        await assembled.core.dispatchReady()
        return { before, after: { frozen: afterState.frozen } }
      },
      // v1.4：紧急暂停改成**作用域**——只停该 Router 会话派出的任务 + 其下游
      // 子任务。不碰全局熔断（熔断保持全局且自动）、不留任何全局标记、之后
      // 的新派发不受影响、别的 Router 会话不受影响。
      scopedPause: (routerSessionId: string) => assembled.core.scopedPause(routerSessionId),
    })
  })

  function workerInstructionsText(): string {
    return WORKER_INSTRUCTIONS
  }
}

