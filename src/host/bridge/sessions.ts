/**
 * 会话桥（计划 Task B4）：任务 ↔ 独立持久会话之间的投递通道。
 *
 * 宿主调用面（create / prompt / onStatus / rename）全部注入，测试用假实现。
 * 投递幂等：requestId = `dispatch-<taskId>-v<docVersion>`——同版本重投在宿主侧
 * 去重（r2 §2.1：requestId 已排队或已入账时返回原受理），补充（supplementTo）
 * 用同一条规则带新版本号。workspace 解析：先按任务的 projectId 回查
 * workspaceRegistry，再按已有执行会话扫 workspace 成员，最后回退 cwd 创建。
 */

import { LedgerError } from '../ledger/errors.ts'
import type { TaskLedger } from '../ledger/store.ts'
import type { TaskRecord } from '../../shared/types.ts'
import type { WorkerSpawnMode } from '../../shared/types.ts'
import type { TaskDocStore } from '../docs/task-docs.ts'
import { parseModelRef } from '../model-ref.ts'
import { tagInfraFailure } from '../guard/classify.ts'
import { minimalSwitchHeader, routerIdentityCard, switchCard } from '../prompts/identity-cards.ts'
import type { WorkerTypeRecord } from '../../shared/view-contract.ts'

/** 宿主会话控制器的最小调用面（r2 §1/§2：sessionController.create/prompt）。 */
export interface SessionBridgeHost {
  create(opts: { workspaceId?: string; cwd?: string; agentPreset?: string }, signal?: AbortSignal): Promise<string>
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: { type: 'text'; text: string }[]
  }, signal?: AbortSignal): Promise<unknown>
  /** api-session/status（r2 §3.1：(sessionId, running)）。 */
  onStatus(callback: (sessionId: string, running: boolean) => void): void
  /** session/rename（r2 §1.1：标题只能事后改）。 */
  rename?(sessionId: string, title: string): Promise<void>
  /**
   * v1.1 规格 §5 默认模型钉法（r4 修正的有界探查结论）：宿主
   * sessionController.selectModel（两版本都有，UI ModelSelect 的同一条通路），
   * 建会话后即设该类型 models[0]。缺席或失败都不挡派发。
   */
  selectModel?(request: { sessionId: string; provider: string; model: string }, signal?: AbortSignal): Promise<unknown>
  /**
   * v1.3 A3（cache 模式）：宿主分叉面 = wire `session/fork`（r10 §1：
   * SessionCommandController.fork，参数 {sessionId 必填, atSeq?, allowMigration?}，
   * 返回 {sessionId}；atSeq 缺省 = 最近完成轮前缀）。缺席 = cache 模式创建段
   * infra 分类进熔断（Review Focus 4），不硬撞创建路径。
   */
  fork?(request: { sessionId: string; atSeq?: number; allowMigration?: boolean }, signal?: AbortSignal): Promise<{ sessionId: string }>
  /** 分叉源事件观察（r10 §1 第 2 步同款；minimal 五步第①步）。 */
  observeSession?(sessionId: string): Promise<{
    events: readonly { seq: number; type: string; time?: number; data?: unknown }[]
    dispose?: () => void
  }>
  /**
   * buildForkSeed（`@deepseek-ai/dsh-session/fork`，r10 §2；minimal 第②步）。
   * 返回 undefined = 种子面不可用（创建降级为普通 create，如实告警）。
   */
  buildForkSeed?(
    events: readonly { seq: number; type: string; time?: number; data?: unknown }[],
    boundary: number,
  ): unknown[] | Promise<unknown[] | undefined>
  /** 分叉子会话 ID（宿主同款形状 `session-<uuid>`）。 */
  newSessionId?(): string
  /**
   * 底层创建原语（r10 §2：ctx.agents.create，seed+自选 preset 组合唯一同框可行
   * 的层；minimal 第④步）。setup 在 agent 工厂里被调用（agentCtx 注入）。
   */
  agentsCreate?(options: {
    sessionId: string
    seed: unknown[]
    inheritedEventCount: number
    meta?: Record<string, unknown>
    agentOptions?: { provider: string; model: string }
    setup?: (agentCtx: unknown) => Promise<unknown>
  }): Promise<unknown>
  /** agentPresets.resolve（r10 §3：先解析（未注册抛 agent-preset/not-found）再挂载）。 */
  resolvePreset?(presetId: string): Promise<{ id: string }>
  /** agentPresets.mount（minimal 第③步的 setup 体：把 worker 预设挂进 agent 作用域）。 */
  mountPreset?(agentCtx: unknown, presetId: string): Promise<unknown>
  /** workspace.attachSession（minimal 第⑤步；cwd 与 workspace.path 不等时宿主拒绝，桥降级不炸）。 */
  attachWorkspace?(workspaceId: string, sessionId: string): Promise<void>
}

/** workspaceRegistry 的最小面（r2 §5）。 */
export interface WorkspaceInfo {
  id: string
  path?: string
  sessionIds?: string[]
}

export interface WorkspaceFace {
  list(): WorkspaceInfo[]
  get(id: string): WorkspaceInfo | undefined
}

export interface SessionBridgeDeps {
  ledger: Pick<TaskLedger, 'get' | 'transition' | 'attachSession'>
  /** 任务文档存储按任务工作目录取（每项目一个根：<cwd>/<tasksDir>）。 */
  docsFor(cwd: string): TaskDocStore
  /** registry 可选缺席（缺席即全部回退 cwd 创建）。 */
  workspaces?: WorkspaceFace
  host: SessionBridgeHost
  /** 按任务角色选预设 id；类型在册时用 forTemplate 解析动态预设（v1.1 C1）。 */
  presets: { supervisor: string; worker: string }
  /**
   * templateId → 预设 id 解析（entry 接线：启用类型 → dsh-router-worker-<类型>，
   * builtin 通用 worker → 静态预设）。缺席或解析不出 → 回退静态角色预设。
   */
  forTemplate?(templateId: string, role: 'supervisor' | 'worker'): Promise<string | undefined>
  /** worker 类型存储的最小面（默认模型钉定用；缺席 = 不钉）。 */
  types?: { get(templateId: string): Promise<WorkerTypeRecord | undefined> }
  /**
   * agents 服务的最小中断面（v1.2 B4 紧急暂停，r8 §5 推荐形态：
   * agents.get(id)?.cancel({kind:'hook',reason},{keepInbox:true})）。缺席 =
   * 会话中断如实报 failed（不冒充受理），冻结照常生效。
   */
  interruptFace?: AgentInterruptFace
  /** 钉定失败等非致命问题的日志口（缺席静默）。 */
  logger?: { warn(message: string): void }
  /** 执行指引文本（prompts/worker-instructions 的产物）。 */
  workerInstructions(): string
  /**
   * worker 生成模式（v1.3 A2/A3；缺省 minimal-face）。决定投递内容形态：
   * cache-priority = 切换卡+任务书（重投只带任务书）；minimal-face = 简化身份头
   * + 任务书 + 执行指引（现行格式加头）。
   */
  mode?: WorkerSpawnMode
  /**
   * Router 身份卡已发标记（v1.3 A2，Review Focus 5；entry 接 UiStateStore）。
   * 缺席 = 无幂等标记面（照发——宿主 requestId 去重仍兜底）。
   */
  identityCards?: { has(sessionId: string): boolean; mark(sessionId: string): Promise<void> }
  /** v1.2 B3：投递成功即回调（判定器武装定时器/重置周期）。 */
  onDelivered?(taskId: string, sessionId: string): void
  /** 投递用的中止信号（缺席时每次调用自造 2 分钟超时）。 */
  signal?: AbortSignal
}

/**
 * agents 服务的最小中断面（r8 §2/§5）：get 返回 live agent（冷会话 undefined，
 * 天然 no-op）；cancel 幂等不抛错、原因留痕 turn/end、keepInbox 保住排队消息。
 * 注意边界（r8 §3）：只停本会话活动轮次，不停它派生的 jobs/子代理会话。
 */
export interface AgentInterruptFace {
  get(sessionId: string):
    | {
        cancel?(
          cause: { kind: 'hook'; reason: string },
          options?: { keepInbox?: boolean },
        ): unknown
      }
    | undefined
}

/** 紧急暂停的取消原因（留痕 turn/end；auto-resume 对 hook cause 永不自动续跑）。 */
export const EMERGENCY_STOP_REASON = 'emergency-stop'

/**
 * 宿主观察租约的释放（评审 F7）：宿主 observeSession 的租约经显式资源管理释放
 * （`[Symbol.dispose]`），部分版本同时带 `.dispose` 方法——两个通道都调，缺哪个
 * 跳哪个；undefined/空观察静默。minimal 五步路径用（不释放会泄漏 prepared
 * session 缓存租约）。
 */
export function releaseObservation(observation: unknown): void {
  if (observation === null || observation === undefined) return
  if (typeof observation !== 'object') return
  const record = observation as { dispose?: unknown } & Record<symbol, unknown>
  if (typeof record.dispose === 'function') {
    try {
      record.dispose()
    } catch {
      // 释放失败不外泄（租约泄漏由宿主自身超时回收兜底）
    }
  }
  const disposeSymbol = (Symbol as unknown as { dispose?: symbol }).dispose
  if (disposeSymbol !== undefined && typeof record[disposeSymbol] === 'function') {
    try {
      (record[disposeSymbol] as () => void)()
    } catch {
      // 同上
    }
  }
}

/** 单会话中断结果（逐项如实：accepted 或 failed 带 detail）。 */
export interface InterruptOutcome {
  sessionId: string
  outcome: 'accepted' | 'failed'
  detail?: string
}

/** 宿主 prompt 的 Remote 包装第一行就 throwIfAborted（r2 §2.1），必须有信号。 */
const PROMPT_TIMEOUT_MS = 120_000

export class SessionBridge {
  private ledger: SessionBridgeDeps['ledger']
  private docsFor: (cwd: string) => TaskDocStore
  private workspaces: WorkspaceFace | undefined
  private host: SessionBridgeHost
  private presets: SessionBridgeDeps['presets']
  private forTemplate: SessionBridgeDeps['forTemplate']
  private types: SessionBridgeDeps['types']
  private interruptFace: SessionBridgeDeps['interruptFace']
  private logger: SessionBridgeDeps['logger']
  private workerInstructions: () => string
  private mode: WorkerSpawnMode
  private identityCards: SessionBridgeDeps['identityCards']
  private onDelivered: SessionBridgeDeps['onDelivered']
  private signal: AbortSignal | undefined
  private running = new Map<string, boolean>()
  private statusListeners: ((sessionId: string, running: boolean) => void)[] = []

  constructor(deps: SessionBridgeDeps) {
    this.ledger = deps.ledger
    this.docsFor = deps.docsFor
    this.workspaces = deps.workspaces
    this.host = deps.host
    this.presets = deps.presets
    this.forTemplate = deps.forTemplate
    this.types = deps.types
    this.interruptFace = deps.interruptFace
    this.logger = deps.logger
    this.workerInstructions = deps.workerInstructions
    this.mode = deps.mode ?? 'minimal-face'
    this.identityCards = deps.identityCards
    this.onDelivered = deps.onDelivered
    this.signal = deps.signal
  }

  private hostSignal(): AbortSignal {
    return this.signal ?? AbortSignal.timeout(PROMPT_TIMEOUT_MS)
  }

  /**
   * infra 失败打标（v1.2 规格 §1）：宿主调用面（会话创建/登记/改名/投递）的
   * 失败在抛出前打 `failureClass: 'infra'` 标——分类器（guard/classify）读到标
   * 直接按 infra 计熔断，不靠错误形状推断（宿主可能抛任何形状的错误）。
   */
  private async tagged<T>(stage: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw tagInfraFailure(error, stage)
    }
  }

  /** 任务的执行预设 id（router 角色不该被派发，防御性拒绝；类型在册走动态预设）。 */
  private async presetFor(record: TaskRecord): Promise<string> {
    if (record.role === 'router') {
      throw new LedgerError('role-forbidden', `任务 ${record.id} 指派了不可执行的角色 router`)
    }
    if (record.role !== 'supervisor' && record.role !== 'worker') {
      throw new LedgerError('role-forbidden', `任务 ${record.id} 指派了未知角色 ${String(record.role)}`)
    }
    if (this.forTemplate !== undefined && typeof record.templateId === 'string' && record.templateId !== '') {
      const resolved = await this.forTemplate(record.templateId, record.role)
      if (resolved !== undefined && resolved !== '') return resolved
    }
    return this.presets[record.role]
  }

  /**
   * 默认模型钉定（v1.1 规格 §5 / r4 修正的有界探查）：新会话创建后、首轮投递
   * 前把该类型 models[0]（"provider/model"）设进去——宿主
   * sessionController.selectModel 正是界面 ModelSelect 的同一条通路。缺席、
   * 引用不合法、宿主调用失败都只告警，不挡派发（会话保持宿主默认路由）。
   */
  private async pinDefaultModel(sessionId: string, templateId: string): Promise<void> {
    if (this.host.selectModel === undefined || this.types === undefined || templateId === '') return
    try {
      const record = await this.types.get(templateId)
      const ref = record?.models[0]
      if (ref === undefined) return
      const parsed = parseModelRef(ref)
      if (parsed === undefined) {
        this.logger?.warn(`类型 ${templateId} 的默认模型引用不合法（应为 "provider/model"）：${ref}，跳过钉定`)
        return
      }
      await this.host.selectModel({ sessionId, provider: parsed.provider, model: parsed.model })
    } catch (error) {
      this.logger?.warn(`会话 ${sessionId} 默认模型钉定失败（保持宿主默认路由）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** workspace 解析：projectId 回查 → 已有执行会话扫成员 → undefined（回退 cwd）。 */
  private resolveWorkspace(record: TaskRecord): WorkspaceInfo | undefined {
    if (this.workspaces === undefined) return undefined
    const byId = this.workspaces.get(record.projectId)
    if (byId !== undefined) return byId
    if (record.sessionId !== undefined) {
      const bySession = this.workspaces.list().find((w) => w.sessionIds?.includes(record.sessionId as string))
      if (bySession !== undefined) return bySession
    }
    return undefined
  }

  /** 投递卡片的类型身份（types 面缺席/查不到时回退 templateId 与空提示词）。 */
  private async typeIdentity(templateId: string): Promise<{ name: string; systemPrompt: string }> {
    if (this.types !== undefined && templateId !== '') {
      const record = await this.types.get(templateId)
      if (record !== undefined) return { name: record.name, systemPrompt: record.systemPrompt }
    }
    return { name: templateId === '' ? '执行者' : templateId, systemPrompt: '' }
  }

  /** 会话标题（v1.3 规格 §3.1：`类型名 · T-xxx 任务名`）。 */
  private async sessionTitle(record: TaskRecord): Promise<string> {
    const identity = await this.typeIdentity(record.templateId ?? '')
    return `${identity.name} · ${record.id} ${record.title}`
  }

  /** 分叉来源：显式 forkFrom（派发者会话）优先，其次父任务的执行会话。 */
  private resolveForkSource(record: TaskRecord, forkFrom: string | undefined): string | undefined {
    if (forkFrom !== undefined && forkFrom !== '') return forkFrom
    if (record.parentId !== undefined) {
      const parent = this.ledger.get(record.parentId)
      if (parent?.sessionId !== undefined) return parent.sessionId
    }
    return undefined
  }

  /**
   * cache-priority 创建段（规格 §3.1）：宿主 `session/fork`（继承来源历史/组合/
   * 模型，forkWorkspace 自动归组）→ 登记账本 → 改名；**不 selectModel**。
   * 宿主缺 fork face → infra 分类进熔断（Review Focus 4：不硬撞创建路径，
   * 正路是切 minimal-face 模式）。无分叉源 → undefined（回退创建路径）。
   */
  private async createByFork(record: TaskRecord, title: string, source: string | undefined): Promise<string | undefined> {
    if (source === undefined) return undefined
    if (this.host.fork === undefined) {
      throw tagInfraFailure(
        new Error('宿主缺 session/fork 面（sessionController.fork 缺席），cache-priority 模式无法分叉创建；请在设置切到 minimal-face 模式或升级宿主'),
        '分叉创建失败',
      )
    }
    const forked = await this.tagged('分叉创建失败', () => this.host.fork!({ sessionId: source }, this.hostSignal()))
    const childId = forked.sessionId
    await this.tagged('会话登记失败', () => this.ledger.attachSession(record.id, childId))
    await this.tagged('会话改名失败', async () => {
      await this.host.rename?.(childId, title)
    })
    return childId
  }

  /**
   * minimal-face 创建段（规格 §3.2，r10 §7 五步复刻）：observeSession →
   * boundary（最后 turn/end）→ buildForkSeed → resolvePreset+mount 组 setup →
   * agents.create → attachWorkspace → 登记 → 改名（selectModel 由 dispatchTask
   * 的回退外分支统一处理）。面不全 / 无分叉源 / 种子面不可用 → undefined（回退
   * 既有创建路径）；来源缺位、预设未注册、create 失败 → infra 分类（Review
   * Focus 4）。
   */
  private async createBySeed(
    record: TaskRecord,
    title: string,
    source: string | undefined,
    workspace: WorkspaceInfo | undefined,
  ): Promise<string | undefined> {
    const host = this.host
    if (
      source === undefined
      || host.observeSession === undefined
      || host.newSessionId === undefined
      || host.agentsCreate === undefined
      // 评审 F5：resolvePreset/mountPreset 缺席时五步会裸跑 agents.create（无预设
      // 挂载，worker 没有工具面）——按面不全处理，回退既有创建路径。
      || host.resolvePreset === undefined
      || host.mountPreset === undefined
    ) {
      return undefined
    }
    const observation = await this.tagged('分叉源读取失败', () => host.observeSession!(source))
    try {
      const events = observation?.events ?? []
      let boundary: number | undefined
      for (const event of events) {
        if (event.type === 'turn/end' && typeof event.seq === 'number') boundary = event.seq
      }
      if (boundary === undefined) {
        throw tagInfraFailure(new Error(`分叉源会话 ${source} 没有已完成轮次（无 turn/end），无法构造分叉种子`), '分叉创建失败')
      }
      const seed = host.buildForkSeed === undefined ? undefined : await host.buildForkSeed(events, boundary)
      if (!Array.isArray(seed)) {
        this.logger?.warn('buildForkSeed 面不可用（@deepseek-ai/dsh-session/fork 缺席？），本次分叉降级为普通创建')
        return undefined
      }
      const presetId = await this.presetFor(record)
      const resolved = await this.tagged('预设解析失败', async () =>
        host.resolvePreset === undefined ? { id: presetId } : host.resolvePreset(presetId),
      )
      const childId = host.newSessionId()
      await this.tagged('分叉创建失败', async () => {
        await host.agentsCreate!({
          sessionId: childId,
          seed,
          inheritedEventCount: boundary + 1,
          meta: { cwd: record.cwd, isSeeded: true, agentPreset: resolved.id },
          setup: host.mountPreset === undefined
            ? undefined
            : async (agentCtx: unknown) => {
                await host.mountPreset!(agentCtx, resolved.id)
              },
        })
      })
      if (workspace !== undefined && host.attachWorkspace !== undefined) {
        try {
          await host.attachWorkspace(workspace.id, childId)
        } catch (error) {
          // attach 失败（cwd 与 workspace.path 不等被宿主拒绝等）不炸派发：
          // 会话已建成，重启后宿主按 cwd 自动归组（r2 §1.2）。
          this.logger?.warn(`分叉子会话 ${childId} 挂 workspace ${workspace.id} 失败（不影响派发）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await this.tagged('会话登记失败', () => this.ledger.attachSession(record.id, childId))
      await this.tagged('会话改名失败', async () => {
        await this.host.rename?.(childId, title)
      })
      return childId
    } finally {
      observation?.dispose?.()
    }
  }

  /**
   * 首发投递正文（v1.3 规格 §2.3/§2.4）：cache-priority = 切换卡（①类型系统
   * 提示词 ②角色工具清单 ③禁用提醒）+ 任务书全文；minimal-face = 简化身份头 +
   * 现行格式（任务书 + 执行指引）。
   */
  private async firstDeliveryText(record: TaskRecord, book: string): Promise<string> {
    const identity = await this.typeIdentity(record.templateId ?? '')
    const role = record.role === 'supervisor' ? 'supervisor' : 'worker'
    if (this.mode === 'cache-priority') {
      return `${switchCard(identity, role)}\n${book}`
    }
    return `${minimalSwitchHeader(identity, role)}\n${book}\n\n${this.workerInstructions()}`
  }

  /**
   * Router 身份卡投递（v1.3 A2）：requestId=identity-<sessionId> 宿主侧幂等，
   * 已发标记（ui-state，跨重启）跳过；投递成功才打标，失败不打（下次重试时
   * 同 requestId 在宿主侧去重，不会双发）。
   */
  async deliverRouterIdentityCard(sessionId: string): Promise<void> {
    if (this.identityCards?.has(sessionId)) return
    await this.host.prompt(
      {
        requestId: `identity-${sessionId}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: routerIdentityCard() }],
      },
      this.hostSignal(),
    )
    await this.identityCards?.mark(sessionId)
  }

  /**
   * 派发任务：无会话则建——cache-priority 优先宿主分叉（来源=派发者/父任务会话，
   * r10 §1 fork face；缺面=infra，无源=回退创建），minimal-face 五步复刻
   * （agents.create + buildForkSeed + worker 预设组合，r10 §2/§7；面不全或无源
   * 回退既有创建路径）；随后投任务书（requestId 幂等，cache 用 switch- 前缀），
   * 成功后走状态机到 dispatched。
   */
  async dispatchTask(taskId: string, opts?: { forkFrom?: string }): Promise<{ sessionId: string | undefined }> {
    const record = this.ledger.get(taskId)
    if (record === undefined) throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
    const book = await this.docsFor(record.cwd).readDoc(taskId, 'task', record.docVersion)
    let sessionId = record.sessionId
    if (sessionId === undefined) {
      const workspace = this.resolveWorkspace(record)
      const title = await this.sessionTitle(record)
      const forkSource = this.resolveForkSource(record, opts?.forkFrom)
      if (this.mode === 'cache-priority') {
        // cache 模式：宿主分叉（继承来源历史/组合/模型）；无源回退创建（不钉模型）。
        sessionId = await this.createByFork(record, title, forkSource)
      } else {
        // minimal 模式：五步复刻（带历史 + worker 预设组合 + 钉模型）；面不全或
        // 无源回退既有创建路径。
        sessionId = await this.createBySeed(record, title, forkSource, workspace)
      }
      if (sessionId === undefined) {
        const agentPreset = await this.presetFor(record)
        const createOpts = workspace !== undefined
          ? { workspaceId: workspace.id, agentPreset }
          : { cwd: record.cwd, agentPreset }
        const fresh = await this.tagged('会话创建失败', () => this.host.create(createOpts, this.hostSignal()))
        sessionId = fresh
        await this.tagged('会话登记失败', () => this.ledger.attachSession(taskId, fresh))
        await this.tagged('会话改名失败', async () => {
          await this.host.rename?.(fresh, title)
        })
      }
      // 模型钉定（v1.1 §5 / Review Focus 3）：minimal（含回退创建与五步）钉类型
      // models[0]；cache 模式绝不调 selectModel——分叉继承来源模型（调用即缓存断裂），
      // 类型 models 仅作展示。
      if (this.mode !== 'cache-priority') {
        await this.pinDefaultModel(sessionId, record.templateId ?? '')
      }
    }
    const deliverySessionId: string = sessionId
    const firstText = await this.firstDeliveryText(record, book)
    const requestId = this.mode === 'cache-priority'
      ? `switch-${taskId}-v${record.docVersion}`
      : `dispatch-${taskId}-v${record.docVersion}`
    await this.tagged('任务书投递失败', () =>
      this.host.prompt(
        {
          requestId,
          sessionId: deliverySessionId,
          mode: 'queue',
          content: [{ type: 'text', text: firstText }],
        },
        this.hostSignal(),
      ),
    )
    if (record.status === 'draft') await this.ledger.transition(taskId, 'queued')
    if (record.status === 'draft' || record.status === 'queued') {
      await this.ledger.transition(taskId, 'dispatched')
    }
    this.onDelivered?.(taskId, sessionId)
    return { sessionId }
  }

  /**
   * 补充重投：把当前版本任务书投给原执行会话（requestId 同规则、带新版本号）。
   * 任务还没有执行会话时不投递——它保持 queued 等依赖解锁后按新版本首发。
   */
  async supplementTo(taskId: string): Promise<{ sessionId: string | undefined }> {
    const record = this.ledger.get(taskId)
    if (record === undefined) throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
    if (record.sessionId === undefined) return { sessionId: undefined }
    const book = await this.docsFor(record.cwd).readDoc(taskId, 'task', record.docVersion)
    const existingSessionId: string = record.sessionId
    // 重投正文（v1.3 A2 裁定）：cache-priority = 任务书全文（身份已在会话历史，
    // 不重发切换卡与指引）；minimal-face = 现行格式（任务书 + 执行指引）。
    const supplementText = this.mode === 'cache-priority' ? book : `${book}\n\n${this.workerInstructions()}`
    await this.tagged('任务书投递失败', () =>
      this.host.prompt(
        {
          requestId: `dispatch-${taskId}-v${record.docVersion}`,
          sessionId: existingSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: supplementText }],
        },
        this.hostSignal(),
      ),
    )
    this.onDelivered?.(taskId, existingSessionId)
    return { sessionId: existingSessionId }
  }

  /** 取消通知：steer 插到执行会话最近一步，尽快停下。无会话时静默跳过。 */
  async notifyCancel(taskId: string): Promise<void> {
    const record = this.ledger.get(taskId)
    if (record === undefined) throw new LedgerError('task-not-found', `任务不存在: ${taskId}`)
    if (record.sessionId === undefined) return
    await this.notify(
      record.sessionId,
      `cancel-${taskId}`,
      `任务 ${record.id}「${record.title}」已被取消。请立即停止相关工作，不要继续提交；已产生的中间产物留在原地。`,
    )
  }

  /** 通用投递通道（完成通知、暂停通知等；默认 steer 立即插到最近一步）。 */
  async notify(
    sessionId: string,
    requestId: string,
    text: string,
    mode: 'queue' | 'steer' = 'steer',
  ): Promise<void> {
    await this.host.prompt({ requestId, sessionId, mode, content: [{ type: 'text', text }] }, this.hostSignal())
  }

  /**
   * 紧急暂停的逐会话中断（v1.2 B4，r8 §5 推荐形态）：agents.get(id)?.cancel(
   * {kind:'hook',reason:'emergency-stop'},{keepInbox:true})——幂等、原因留痕
   * turn/end、排队消息保留（keepInbox）；空闲会话静默接受，冷会话天然 no-op。
   * 每会话二值结果聚合：单个失败不拖垮批量、如实上报 detail（Review Focus 5）；
   * 中断面未接线时全部如实 failed，不冒充受理。
   */
  async interruptTaskSessions(sessionIds: readonly string[]): Promise<InterruptOutcome[]> {
    const outcomes: InterruptOutcome[] = []
    for (const sessionId of sessionIds) {
      if (this.interruptFace === undefined) {
        outcomes.push({ sessionId, outcome: 'failed', detail: 'agents 中断面未接线（interruptFace 缺席），无法中断' })
        continue
      }
      try {
        const agent = this.interruptFace.get(sessionId)
        if (agent === undefined) {
          outcomes.push({ sessionId, outcome: 'accepted', detail: '冷会话（无 live agent）：中断为 no-op' })
          continue
        }
        if (typeof agent.cancel !== 'function') {
          outcomes.push({ sessionId, outcome: 'failed', detail: 'agents 中断面缺 cancel 方法（宿主版本不支持）' })
          continue
        }
        await agent.cancel({ kind: 'hook', reason: EMERGENCY_STOP_REASON }, { keepInbox: true })
        outcomes.push({ sessionId, outcome: 'accepted' })
      } catch (error) {
        outcomes.push({
          sessionId,
          outcome: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return outcomes
  }

  /** 订阅 api-session/status：记录运行标志（标签条 running 字段）并转发监听者。 */
  watchStatus(): void {
    this.host.onStatus((sessionId, isRunning) => {
      this.running.set(sessionId, isRunning)
      for (const listener of this.statusListeners) listener(sessionId, isRunning)
    })
  }

  /** 注册状态变化监听（压缩驱动等接线用）。 */
  onStatusChange(listener: (sessionId: string, isRunning: boolean) => void): void {
    this.statusListeners.push(listener)
  }

  /** 会话是否在跑（未观察过 = false）。 */
  isRunning(sessionId: string): boolean {
    return this.running.get(sessionId) ?? false
  }
}
