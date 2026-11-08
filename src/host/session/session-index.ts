/**
 * 持久化增量会话候选索引（router-header-index Task 2；fix round 1-2 修订）。
 *
 * 职责：把「会话是否为 Router 会话」的判定从整日志重放换成**有界头读取 +
 * 增量维护 + live 权威投影**，并让判定/进度/失败在重启间安全复用：
 *
 * - 首次 bootstrap 对历史候选有界分批（`batchAttempts` 全局尝试预算，**含失败
 *   读取**；不按 workspace 重置）；低频目录对账抓漏（成员跟踪 + 身份指纹
 *   dev/ino/mtime/ctime/size/generation 名集合，不是 mtime 水位线——外部导入
 *   的旧 mtime 会话照样发现；对账读失败按 partial 处理、不清子树）。
 * - 判定规则（C1 修订，宿主 app.asar/官方 catalog 实证）：`agent-preset/
 *   selected` 可覆盖**任何版本**的 creation header——冷盘头不是权威。权威事实
 *   只来自 ① 已 live Session 的 `agentPreset` 会话投影（`resolveLivePreset`
 *   注入，只读、不触发冷重放）② `agent-preset/selected` 事件值本身。冷盘除
 *   seeded 排除（nonrouter，immutable 头可安全证明）外一律显式 unknown；坏头/
 *   future 格式/编码歧义/zstd 能力缺席 → 最终 unknown（fail closed，不重试）；
 *   瞬时失败（limit/unreadable）进到期调度冷却重试。
 * - live 事件经 dispatchLive：hydrate 落定前排队；per-id revision 护住全部
 *   异步复核（reader/指纹复核）之后的提交点，旧盘 IO 不覆盖新 live 事实。
 * - 持久化按 `version + root + preset` 作用域校验（路径段规范 + 事实一致性，
 *   不符即弃）；载入缓存未经成功对账核对指纹前保持 unverified（verdictOf
 *   = pending，不授权副作用）。保存走单 worker：首个变更固定期限（轮询不推
 *   迟）、在途至多一笔合并后续、失败保留待写并只排一个重试计时。
 * - 并发纪律：hydrate 先于一切工作（幂等，所有入口 await）；reconcile/advance
 *   各自单飞且经同一串行链执行；dispose 停定时、abort 在途读取、等待独立
 *   hydrate 与保存 worker 收尾后最终冲刷。
 * - I8 r2：宿主成员/归档集走快照（低频对账刷新 + live 事件失效），队列是
 *   游标 + 墓碑 + 惰性压实，失败重试按 nextRetryAt 到期调度（稳态 O(1)）。
 */

import { readdir as fsReaddir, stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceInfo } from '../bridge/sessions.ts'
import { IoBudget, SessionHeaderReader as _SessionHeaderReader } from './header-io.ts'
import {
  MAX_KNOWN_SESSION_VERSION,
  SessionHeaderReader,
  decodeSegment,
  encodeSegment,
  parseGenerationFilename,
  type GenerationFile,
  type HeaderReadOutcome,
  type LogScanOutcome,
  type SessionHeaderFacts,
} from './header-io.ts'

/** 判定三值：router / nonrouter / unknown（显式未知，保守阻断不安全动作）。 */
export type SessionVerdict = 'router' | 'nonrouter' | 'unknown'

/**
 * 一条已判定的候选（磁盘或 live 事件来源）。
 *
 * `evidence`：disk 判定的依据——'stable-eof' = 小日志有界流式扫到稳定 EOF
 * （cold verdict v2；**当前组合快照**，文件指纹变化即失效重扫，不是永久
 * 不变事实）。seeded 排除与 live 判定不带 evidence。
 */
export interface VerdictEntry {
  sessionId: string
  projectDir: string
  file: string
  fingerprint: string
  verdict: SessionVerdict
  createdAt: number | undefined
  isSeeded: boolean | undefined
  agentPreset: string | undefined
  origin: 'disk' | 'live'
  reason: string | undefined
  evidence?: 'stable-eof'
}

/** 一次可重试的读取失败（冷却到期后由 advance 重试）。 */
export interface FailureEntry {
  sessionId: string
  projectDir: string
  file: string
  fingerprint: string
  retryAt: number
  message: string
}

export type VerdictLookup =
  | { status: 'classified'; verdict: SessionVerdict; createdAt?: number; isSeeded?: boolean; agentPreset?: string; reason?: string; origin?: 'disk' | 'live'; evidence?: 'stable-eof' }
  | { status: 'pending' }
  | { status: 'failed'; retryAt: number }

/**
 * 一次 **router 资格授予**（收编消费方与索引之间的记账点）。
 *
 * 语义（v1.4 review I1）：判定「当前确实是 router」是一份**可重新成立的
 * 资格**——资格代数（generation）每次「不再成立 → 又成立」就 +1。消费方
 * 按 (sessionId, generation) 记账：处理成功才 ack；未 ack 的授予**永远留在
 * 待消费面**（不被"看一眼"就吞掉），因此
 * - 载入缓存尚未核指纹（unverified/pending）时**不授予**——不会把未核验
 *   的候选提前消费掉、丢掉未来资格；
 * - 判定翻到别的值再翻回来（router→other→router）会拿到**新一代**授予，
 *   不会因为旧基线里出现过 id 就永久漏掉；
 * - 消费方 ack 后该授予从待消费面移除（稳态待消费面为空 → 每轮 O(1)）。
 */
export interface RouterGrant {
  sessionId: string
  /** 资格代数：每次重新成立 +1；ack 时代数不符即忽略（新一代未被消费）。 */
  generation: number
}

/**
 * 落盘形状（version/root/preset 作用域校验）。
 *
 * version 2：cold verdict v2——disk 判定可携带 evidence 'stable-eof'（小日志
 * stable-EOF 扫描证据 + 精确指纹）。载入 version 1 旧缓存时只保留 seeded
 * 排除（不可变头事实）；其余按新语义重扫。
 */
export interface IndexFileState {
  version: 1 | 2
  root: string
  preset: string
  savedAt: number
  entries: VerdictEntry[]
  failures: FailureEntry[]
}

export interface IndexPersistence {
  load(): Promise<unknown>
  save(state: IndexFileState): void | Promise<void>
}

/** 头读取面（默认真实读取器；测试可注入计数/失败假件）。 */
export interface HeaderReaderFace {
  readSessionHeader(
    sessionDir: string,
    sessionId: string,
    options?: { signal?: { aborted: boolean }; now?: () => number; deadlineAt?: number; timer?: { set(delayMs: number, fn: () => void): () => void } },
  ): Promise<HeaderReadOutcome>
  /**
   * cold verdict v2：小日志 stable-EOF 有界扫描（可选——缺席时 unseeded 冷盘
   * 保守 unknown，绝不冒充）。真实读取器实现齐全。
   */
  scanSessionLog?(
    sessionDir: string,
    sessionId: string,
    options?: { signal?: { aborted: boolean }; now?: () => number; deadlineAt?: number; timer?: { set(delayMs: number, fn: () => void): () => void } },
  ): Promise<LogScanOutcome>
}

/** 索引自己的 fs 元数据面（目录枚举 + 指纹 stat；含身份 dev/ino/ctime）。 */
export interface IndexFsFace {
  readdir(dir: string): Promise<readonly { name: string; isDirectory(): boolean }[]>
  stat(path: string): Promise<{ mtimeMs: number; size: number; dev: number; ino: number; ctimeMs: number }>
}

/** 宿主成员面（I8 r2）：快照在低频对账/事件失效时刷新，轮询不逐拍打宿主。 */
export interface MembershipFace {
  list(): WorkspaceInfo[]
  archivedIds?(): readonly string[]
  /**
   * 单 workspace 定点查询（针对性权威核验用；缺席则回退到 list() 扫描）。
   * 只读该 workspace 的成员，不重组全成员签名。
   */
  get?(workspaceId: string): WorkspaceInfo | undefined
}

/** 针对性权威事实：目标会话当前是否仍是成员、是否已被宿主归档。 */
export interface TargetAuthority {
  /** 仍是该 workspace 的成员。 */
  member: boolean
  /** 已被宿主归档（归档集是全局的，成员槽位保留）。 */
  archived: boolean
}

export interface SessionIndexDeps {
  root: string
  routerPreset: string
  /** 宿主 workspace/归档集快照源；缺席时快照恒空（dedup 全部 blocked）。 */
  membership?: MembershipFace
  /** I1 r3：在途底层 IO 槽位（头读/枚举/指纹复核共享；默认 8）。 */
  ioCapacity?: number
  reader?: HeaderReaderFace
  fs?: IndexFsFace
  persistence?: IndexPersistence
  /**
   * C1：live Session 的权威最终预设解析面（宿主 sessionProjections 的
   * `agentPreset` 投影——init 自 creation header、apply 前进于
   * agent-preset/selected）。只对已 live 的 Session 调用（create/resume 事件的
   * 载荷），绝不触发冷重放；读不到（undefined）= 无权威值 → unknown。
   */
  resolveLivePreset?: (session: unknown) => string | null | undefined
  logger?: { warn(message: string): void }
  now?: () => number
  schedule?: (delayMs: number, fn: () => void) => () => void
  /** 每次 advance 的全局尝试预算（含失败读取）。默认 10。 */
  batchAttempts?: number
  /** 瞬时失败冷却 ms。默认 10 分钟。 */
  failureRetryMs?: number
  /** 低频对账间隔 ms。默认 60 秒。 */
  reconcileIntervalMs?: number
  /** 背景推进间隔 ms。默认 250ms。 */
  backgroundIntervalMs?: number
}

/** 保存去抖窗口。 */
const SAVE_DEBOUNCE_MS = 2_000
/** 单次头读取的时间预算。 */
const READ_DEADLINE_MS = 2_000
/** 枚举时的礼让间隔（每 N 个会话让一轮事件循环）。 */
const ENUMERATE_YIELD_EVERY = 100

function isENOENT(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
}

function defaultSchedule(delayMs: number, fn: () => void): () => void {
  const timer = setTimeout(() => fn(), delayMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearTimeout(timer)
}

/**
 * 冷盘头 → 判定（C1 修订：撤销「v4 权威头」假设）。官方
 * persistence-catalog 明确 `agent-preset/selected` 记录创建后在空白会话上的
 * 选择、恢复/fork 采用它而非 creation-time 值——**任何版本**的 creation
 * header 都可能是被覆盖的旧值。因此冷盘（无 live 权威投影）只能安全证明
 * seeded 排除；其余一律显式 unknown，绝不冒充 router/nonrouter 去驱动
 * pin/归档。
 */
export function classifyDiskFacts(facts: SessionHeaderFacts): { verdict: SessionVerdict; reason: string } {
  if (facts.isSeeded) return { verdict: 'nonrouter', reason: 'seeded session excluded' }
  return {
    verdict: 'unknown',
    reason: 'cold session: creation header is not authoritative (agent-preset/selected may override it); no live projection available',
  }
}

/**
 * live 权威组合 → 判定。finalPreset 来自已 live Session 的投影/已提交选择
 * 事件：等于 router 预设 → router；任何其他确定值（含 null = 无预设组合）→
 * nonrouter；读不到权威值（undefined）→ unknown。
 */
export function classifyLiveComposition(
  finalPreset: string | null | undefined,
  isSeeded: boolean,
  routerPreset: string,
): { verdict: SessionVerdict; reason: string | undefined } {
  if (isSeeded) return { verdict: 'nonrouter', reason: 'seeded session excluded' }
  if (finalPreset === routerPreset) return { verdict: 'router', reason: undefined }
  if (finalPreset === undefined) return { verdict: 'unknown', reason: 'live authoritative composition unavailable' }
  return { verdict: 'nonrouter', reason: finalPreset === null ? 'preset-free live composition' : `live composition runs under ${finalPreset}` }
}

/** live Session 载荷的头事实（防御性读 `session.header`；`session.id` 兜底）。 */
export function liveHeaderOf(session: unknown): {
  id: string
  version: number
  createdAt: number
  isSeeded: boolean
  agentPreset: string | undefined
} | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const carrier = session as { id?: unknown; header?: unknown }
  const header = carrier.header
  const record = (header !== null && typeof header === 'object' ? header : session) as Record<string, unknown>
  const id = typeof record['id'] === 'string' && record['id'].length > 0
    ? record['id']
    : typeof carrier.id === 'string' && carrier.id.length > 0
      ? carrier.id
      : undefined
  if (id === undefined) return undefined
  if (typeof record['version'] !== 'number' || typeof record['createdAt'] !== 'number') return undefined
  if (typeof record['isSeeded'] !== 'boolean') return undefined
  if (record['agentPreset'] !== undefined && typeof record['agentPreset'] !== 'string') return undefined
  return {
    id,
    version: record['version'],
    createdAt: record['createdAt'],
    isSeeded: record['isSeeded'],
    agentPreset: record['agentPreset'] as string | undefined,
  }
}

/** live Session 载荷的会话 id（头优先，载荷 id 兜底）。 */
function liveSessionId(session: unknown): string | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const carrier = session as { id?: unknown; header?: unknown }
  const header = carrier.header
  const record = (header !== null && typeof header === 'object' ? header : session) as Record<string, unknown>
  const id = typeof record['id'] === 'string' && record['id'].length > 0
    ? record['id']
    : typeof carrier.id === 'string' && carrier.id.length > 0
      ? carrier.id
      : undefined
  return id
}

interface SessionLocation {
  projectDir: string
  file: string
  /** 身份指纹：dev:ino:mtimeMs:ctimeMs:size:generation-名集合（I3）。 */
  fingerprint: string
}

/**
 * 读后指纹复核的 typed 结论（R2-B r4）——IO 受限**不是**「文件变了」：
 * 提前退出必须有明确去处（retry / remove / terminal），不能一律当「变了」
 * 继续（那会让到期失败永远进不了冷却）。
 */
type FingerprintVerdict =
  /** 指纹未变：附带**当前**身份（扫描证据必须与它逐字段相等才算同一实体）。 */
  | { kind: 'unchanged'; identity: IndexIdentity; namesKey: string }
  | { kind: 'changed' }
  | { kind: 'gone' }
  | { kind: 'unavailable'; message: string }

/** 索引位置指纹的身份部分（dev/ino/mtime/ctime/size）。 */
interface IndexIdentity {
  dev: number
  ino: number
  mtimeMs: number
  ctimeMs: number
  size: number
}

/** 目录名清单 →（追踪用最高 generation，全部规范 generation 名的有序集合键）。 */
function pickGenerationForTracking(names: readonly string[]): { name: string; version: number; namesKey: string } | undefined {
  const canonical: string[] = []
  let chosen: { name: string; version: number } | undefined
  for (const name of names) {
    const parsed = parseGenerationFilename(name)
    if (parsed === undefined) continue
    canonical.push(name)
    if (chosen === undefined || parsed.version > chosen.version || (parsed.version === chosen.version && parsed.name > chosen.name)) {
      chosen = parsed
    }
  }
  if (chosen === undefined) return undefined
  return { ...chosen, namesKey: canonical.sort().join('|') }
}

function fingerprintOf(stat: { mtimeMs: number; size: number; dev: number; ino: number; ctimeMs: number }, namesKey: string): string {
  return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${namesKey}`
}

/**
 * 增量会话候选索引。单实例负责一个 root + preset 作用域；所有公开异步入口
 * 先 `await hydrate()`（幂等单飞）再经内部串行链执行。
 */
export class SessionHeaderIndex {
  private readonly root: string
  private readonly routerPreset: string
  private readonly reader: HeaderReaderFace
  private readonly fs: IndexFsFace
  private readonly persistence: IndexPersistence | undefined
  private readonly resolveLivePreset: ((session: unknown) => string | null | undefined) | undefined
  private readonly membership: MembershipFace | undefined
  private readonly logger: { warn(message: string): void } | undefined
  private readonly now: () => number
  private readonly scheduleFn: (delayMs: number, fn: () => void) => () => void
  private readonly batchAttempts: number
  private readonly failureRetryMs: number
  private readonly reconcileIntervalMs: number
  private readonly backgroundIntervalMs: number

  private readonly entries = new Map<string, VerdictEntry>()
  private readonly failures = new Map<string, FailureEntry>()
  /** I8 r2：追加式队列 + 游标（出队是墓碑标记 + 惰性压实，不整体搬移）。 */
  private queueItems: string[] = []
  private queueHead = 0
  private readonly queued = new Set<string>()
  private queuedCount = 0
  /** 到期重试调度（O(1) 判定，不逐 tick 扫全 failures）。 */
  private nextRetryAt = Number.POSITIVE_INFINITY
  /** 到期失败最小堆（惰性失效；批量删除/改期不退化成平方）。 */
  private readonly retryHeap: Array<{ id: string; retryAt: number }> = []
  /** 期限重算时访问的失败条目数（护栏：批量删除不得退化成平方）。 */
  private failureDeadlineScanCount = 0
  /** 优先名单的轮转游标（有界窗口扫描；不从头全扫）。 */
  private prioritizeCursor = 0
  private readonly pendingLocs = new Map<string, SessionLocation>()

  private hydratePromise: Promise<void> | undefined
  private hydrated = false
  /** hydrate 落定前到达的 live 更新排队（载入的旧盘判定不得覆盖新 live 事实）。 */
  private readonly liveQueue: Array<() => void> = []
  /** 每会话 live 事实版本号：在途盘读完成后对照，旧 IO 不得覆盖新事实（I2）。 */
  private readonly revisions = new Map<string, number>()
  /**
   * I10 r2：hydrate 载入的缓存条目在未经成功对账核对位置指纹前保持
   * unverified——verdictOf 一律 pending（不授权 pin/归档/收编）；成功核对
   * 指纹、或经 live 权威事实/新盘读产生，才移出本集。
   */
  private readonly unverified = new Set<string>()
  private chain: Promise<void> = Promise.resolve()
  private inflightReconcile: Promise<void> | undefined
  private inflightAdvance: Promise<void> | undefined

  private readonly abortController = new AbortController()
  private readonly ioBudget: IoBudget
  private disposed = false
  private started = false
  private stopBackground: (() => void) | undefined
  private lastReconcileAt: number | undefined
  private lastReconcileError: string | undefined
  private initialDone = false
  /** I8 r2：宿主成员/归档集快照（低频刷新 + live 事件失效）。 */
  private membershipSnapshot: readonly WorkspaceInfo[] = []
  private archivedSnapshot = new Set<string>()
  private membershipStale = true
  /**
   * 成员快照版本号：**只在成员/归档内容变化时前进**。判定版本号会因任何
   * 判定变化而前进，不能用来缓存成员名单——那会让消费方每轮重建全成员
   * 名单，分批收敛时累计成平方。
   */
  private membershipRevisionCounter = 1
  /**
   * 成员定位表（sessionId → workspaceId）：**增量缓存**，只在成员快照刷新
   * 时重建（低频对账 / 成员失效刷新）。收编侧据此 O(1) 定位目标工作区，
   * 稳态轮次不再遍历宿主全部工作区/会话（review I7）。
   */
  private membershipIndex = new Map<string, string>()
  /**
   * router 资格授予（review I1）：`grantState` 是每个 id 的资格记录
   * （代数 + 当前是否成立），`pendingGrants` 只装**未被消费方 ack** 的授予
   * （插入序；稳态为空 → 每轮 O(1)）。资格"不再成立"时撤下待消费授予；
   * "又成立"时发**新一代**授予（代数 +1）——旧基线不会把 id 永久吞掉。
   */
  private readonly grantState = new Map<string, { generation: number; eligible: boolean }>()
  private readonly pendingGrants = new Map<string, number>()
  private eligibilitySeq = 0
  /**
   * live 实例身份（生命周期 token）：`session/created` 认领当前实例；被替换
   * 的旧实例进 `retiredInstances`（弱引用集）——旧实例的迟到事件与 disposed
   * 都不再影响新实例（review I6）。事件面**不夺走**已认领的实例（宿主可能
   * 用包装对象投递事件），只在还没有实例时认领。
   */
  private readonly liveInstances = new Map<string, object>()
  private readonly retiredInstances = new WeakSet<object>()
  /**
   * 生命周期代际（授权屏障）：判定/权威事实每变一次 +1。消费方在 await
   * 前后比对同一代数，识别"计划已过期"的异步间隙（review I5/I6）。
   */
  private readonly authorityTokens = new Map<string, number>()

  private dirty = false
/** 判定状态版本号：任一判定/队列/失败变化时前进（dedup 稳态缓存键，I8）。 */
  private stateRevision = 1
  /** 变更序号：保存期间的新变更使序号前进，成功回调据此保留 dirty（I6）。 */
  private mutationSeq = 0
  /** 首个未落盘变更的固定保存期限（后续轮询不推迟，I6）。 */
  private saveDueAt: number | undefined
  private saveTimerCancel: (() => void) | undefined
  private saveRunning = false
  private saveChain: Promise<void> = Promise.resolve()

  private readonly counters = {
    headerAttempts: 0,
    headerErrors: 0,
    cacheReused: 0,
    bytesCompressed: 0,
    bytesDecompressed: 0,
    reconcileRuns: 0,
    advanceRuns: 0,
    /** cold verdict v2：stable-EOF 扫描计数。 */
    scanAttempts: 0,
    scanFinals: 0,
    scanCaps: 0,
    scanUnstable: 0,
  }

  constructor(deps: SessionIndexDeps) {
    this.ioBudget = new IoBudget(deps.ioCapacity ?? 8)
    this.root = deps.root
    this.routerPreset = deps.routerPreset
    this.reader = deps.reader ?? new _SessionHeaderReader(undefined, { budget: this.ioBudget })
    this.fs = deps.fs ?? {
      readdir: (dir) => fsReaddir(dir, { withFileTypes: true }),
      stat: (path) => fsStat(path),
    }
    this.persistence = deps.persistence
    this.resolveLivePreset = deps.resolveLivePreset
    this.membership = deps.membership
    this.logger = deps.logger
    this.now = deps.now ?? Date.now
    this.scheduleFn = deps.schedule ?? defaultSchedule
    this.batchAttempts = deps.batchAttempts ?? 10
    this.failureRetryMs = deps.failureRetryMs ?? 10 * 60_000
    this.reconcileIntervalMs = deps.reconcileIntervalMs ?? 60_000
    this.backgroundIntervalMs = deps.backgroundIntervalMs ?? 250
  }

  private warn(message: string): void {
    this.logger?.warn(message)
  }

  /** 载入持久化判定（幂等单飞；作用域不符/损坏整份丢弃）。 */
  hydrate(): Promise<void> {
    if (this.hydratePromise !== undefined) return this.hydratePromise
    this.hydratePromise = this.hydrateOnce()
    return this.hydratePromise
  }

  private async hydrateOnce(): Promise<void> {
    try {
      if (this.persistence !== undefined) {
        let loaded: unknown
        try {
          loaded = await this.persistence.load()
        } catch (error) {
          this.warn(`候选索引载入失败（忽略，按全新开始）: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (isValidStateFile(loaded, this.root, this.routerPreset)) {
          const legacyFile = loaded.version === 1
          for (const entry of loaded.entries) {
            if (!isValidEntry(entry, this.routerPreset) || entry.origin !== 'disk') continue // live 判定不跨进程复用
            if (legacyFile && !(entry.verdict === 'nonrouter' && entry.isSeeded === true)) {
              // v1 旧缓存只保留 seeded 排除（不可变头事实）；旧 unknown/失败
              // 按 cold v2 语义重扫（evidence 语义 v1 不存在）。
              continue
            }
            // 先标 unverified 再落条目：资格同步据此**不授予**（载入缓存
            // 未核指纹前不授权副作用，review I1）。
            this.unverified.add(entry.sessionId)
            this.putEntry(entry.sessionId, { ...entry })
          }
          for (const failure of loaded!.failures) {
            if (!isValidFailure(failure)) continue
            this.failures.set(failure.sessionId, { ...failure })
            this.retryHeapPush(failure.sessionId, failure.retryAt)
          }
          this.recomputeNextRetryAt() // R2-B：载入即初始化，否则到期失败永不重试
          this.markDirty()
        }
      }
    } finally {
      this.hydrated = true
      // I2：hydrate 落定前到达的 live 事实在载入之后顺序应用（压过旧盘判定）。
      const queued = this.liveQueue.splice(0)
      for (const thunk of queued) {
        if (this.disposed) break
        thunk()
      }
    }
  }

  /** 串行链：所有实际工作经此排队执行。 */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.chain.then(work, work)
    this.chain = run.catch(() => undefined)
    return run
  }

  /**
   * 目录对账：全量枚举 root 的会话目录（O(N) 元数据），按成员 + 指纹维护
   * 条目/队列/失败。单飞：并发调用并入同一轮。
   */
  reconcile(): Promise<void> {
    if (this.inflightReconcile !== undefined) return this.inflightReconcile
    this.inflightReconcile = this.enqueue(async () => {
      try {
        await this.reconcileOnce()
      } finally {
        this.inflightReconcile = undefined
      }
    })
    return this.inflightReconcile
  }

  private async reconcileOnce(): Promise<void> {
    await this.hydrate()
    if (this.disposed) return
    this.counters.reconcileRuns += 1
    const enumeration = await this.enumerate()
    if (this.disposed) return
    const discovered = enumeration.discovered

    // M1：对账读失败（非 ENOENT）→ 记错误、**不清成员**（不能把读不到当空库）。
    this.lastReconcileError = enumeration.error
    if (enumeration.error !== undefined) {
      this.warn(`候选索引对账不完整（保留既有条目）: ${enumeration.error}`)
    }

    // 成员移除：磁盘来源的条目/失败，目录消失即删（live 条目保留——
    // 宿主 created-but-unmaterialized 会话可能还没落盘）。
    // 对账不完整时跳过删除（未枚举的子树不代表会话消失）。
    if (enumeration.error === undefined) {
      for (const [id, entry] of this.entries) {
        if (entry.origin === 'live') continue
        if (!discovered.has(id)) {
          this.dropEntry(id)
          this.dequeue(id)
          this.failures.delete(id)
          this.recomputeNextRetryAt()
          this.markDirty()
        }
      }
      for (const id of [...this.failures.keys()]) {
        if (!discovered.has(id)) {
          this.failures.delete(id)
          this.recomputeNextRetryAt()
          this.markDirty()
        }
      }
    }

    for (const [id, loc] of discovered) {
      const existing = this.entries.get(id)
      if (existing !== undefined) {
        if (existing.origin === 'live') {
          if (existing.file !== loc.file || existing.fingerprint !== loc.fingerprint) {
            existing.projectDir = loc.projectDir
            existing.file = loc.file
            existing.fingerprint = loc.fingerprint
            this.markDirty()
          }
          continue
        }
        if (existing.fingerprint === loc.fingerprint && existing.file === loc.file && existing.projectDir === loc.projectDir) {
          this.counters.cacheReused += 1
          // 成功核对位置指纹 → 缓存可信。状态迁移（pending→classified）必须
          // 推进 revision，否则 dedup 的稳态缓存永远命中 blocked 结果（R2-C）。
          // 核指纹后资格才成立 → 此时才发 router 授予（review I1：冷重启
          // 同指纹核对通过前不得把候选消费掉）。
          if (this.unverified.delete(id)) {
            this.markDirty()
            this.syncRouterGrant(id)
          }
          continue
        }
        this.dropEntry(id)
        this.enqueueForClassification(id, loc)
        continue
      }
      const failure = this.failures.get(id)
      if (failure !== undefined) {
        if (failure.file !== loc.file || failure.fingerprint !== loc.fingerprint) {
          failure.projectDir = loc.projectDir
          failure.file = loc.file
          failure.fingerprint = loc.fingerprint
          this.markDirty()
        }
        continue
      }
      this.enqueueForClassification(id, loc)
    }

    this.refreshMembership() // I8 r2：低频（对账节奏）刷新宿主成员/归档快照
    this.lastReconcileAt = this.now()
    this.initialDone = true
    this.scheduleSave()
  }

  /**
   * 枚举 root 下的会话位置（项目目录/会话目录名排序保证确定性）。
   * M1：区分 ENOENT（不存在=空库）与其他读错误（partial，附 error 说明）。
   */
  private async enumerate(): Promise<{ discovered: Map<string, SessionLocation>; error: string | undefined }> {
    const discovered = new Map<string, SessionLocation>()
    let error: string | undefined
    let projects: readonly { name: string; isDirectory(): boolean }[]
    const rootListing = await this.boundedIo(() => this.fs.readdir(this.root))
    if ('expired' in rootListing) {
      if (rootListing.expired === 'abort') return { discovered, error }
      return { discovered, error: `sessions root unreadable: io ${rootListing.expired}` }
    }
    if ('error' in rootListing) {
      if (!isENOENT(rootListing.error)) error = `sessions root unreadable: ${rootListing.error instanceof Error ? rootListing.error.message : String(rootListing.error)}`
      return { discovered, error }
    }
    projects = rootListing.value
    let seen = 0
    for (const project of [...projects].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (this.disposed || this.abortController.signal.aborted) return { discovered, error }
      if (!project.isDirectory()) continue
      const projectListing = await this.boundedIo(() => this.fs.readdir(join(this.root, project.name)))
      if ('expired' in projectListing) {
        if (projectListing.expired === 'abort') return { discovered, error }
        error = `project dir unreadable: ${project.name}: io ${projectListing.expired}`
        continue
      }
      if ('error' in projectListing) {
        if (!isENOENT(projectListing.error)) error = `project dir unreadable: ${project.name}: ${projectListing.error instanceof Error ? projectListing.error.message : String(projectListing.error)}`
        continue
      }
      const sessionDirs = projectListing.value
      for (const sessionDir of [...sessionDirs].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!sessionDir.isDirectory()) continue
        const sessionId = decodeSegment(sessionDir.name)
        if (sessionId === undefined || sessionId.length === 0) continue
        const dirPath = join(this.root, project.name, sessionDir.name)
        const sessionListing = await this.boundedIo(() => this.fs.readdir(dirPath))
        if ('expired' in sessionListing) {
          if (sessionListing.expired === 'abort') return { discovered, error }
          error = `session dir unreadable: ${sessionDir.name}: io ${sessionListing.expired}`
          continue
        }
        if ('error' in sessionListing) {
          if (!isENOENT(sessionListing.error)) error = `session dir unreadable: ${sessionDir.name}: ${sessionListing.error instanceof Error ? sessionListing.error.message : String(sessionListing.error)}`
          continue
        }
        const names = sessionListing.value.map((entry) => entry.name)
        const chosen = pickGenerationForTracking(names)
        if (chosen === undefined) continue
        const stattedLog = await this.boundedIo(() => this.fs.stat(join(dirPath, chosen.name)))
        if ('expired' in stattedLog) {
          if (stattedLog.expired === 'abort') return { discovered, error }
          error = `session log unstattable: ${sessionDir.name}: io ${stattedLog.expired}`
          continue
        }
        if ('error' in stattedLog) {
          if (!isENOENT(stattedLog.error)) error = `session log unstattable: ${sessionDir.name}: ${stattedLog.error instanceof Error ? stattedLog.error.message : String(stattedLog.error)}`
          continue
        }
        const stat = stattedLog.value
        discovered.set(sessionId, {
          projectDir: project.name,
          file: chosen.name,
          fingerprint: fingerprintOf(stat, chosen.namesKey),
        })
        seen += 1
        if (seen % ENUMERATE_YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve))
        if (this.disposed || this.abortController.signal.aborted) return { discovered, error }
      }
    }
    return { discovered, error }
  }

  /**
   * 有界推进一批分类：全局尝试预算（含失败读取）；`prioritize` 把指定会话
   * 提到队首（供去重按 workspace 成员加速收敛）。单飞：并发调用并入同一轮。
   */
  advance(options: { prioritize?: readonly string[] } = {}): Promise<void> {
    if (this.inflightAdvance !== undefined) return this.inflightAdvance
    this.inflightAdvance = this.enqueue(async () => {
      try {
        await this.advanceOnce(options.prioritize ?? [])
      } finally {
        this.inflightAdvance = undefined
      }
    })
    return this.inflightAdvance
  }

  private async advanceOnce(prioritize: readonly string[]): Promise<void> {
    await this.hydrate()
    if (this.disposed) return
    this.counters.advanceRuns += 1

    // I8 r2：无积压且无到期失败 → 立刻返回（O(1)：游标计数 + nextRetryAt）。
    if (this.queuedCount === 0 && this.now() < this.nextRetryAt) {
      this.scheduleSave()
      return
    }

    // 组批：优先名单（在队列或到期失败里）→ 游标后的队列 → 到期失败；
    // 集齐预算即停（O(成员+预算)；失败展开只在到期时发生）。
    const ids: string[] = []
    const seenIds = new Set<string>()
    const push = (id: string): void => {
      if (!seenIds.has(id)) {
        seenIds.add(id)
        ids.push(id)
      }
    }
    const dueNow = this.now() >= this.nextRetryAt
    // 优先名单：**有界窗口 + 轮转游标**（不从头全扫：N 个成员分固定预算批次
    // 收敛时，每轮从头扫全名单会累计成平方组批成本）。
    if (prioritize.length > 0) {
      const scanSpan = Math.min(prioritize.length, Math.max(this.batchAttempts, 1))
      const start = this.prioritizeCursor % prioritize.length
      for (let i = 0; i < scanSpan; i += 1) {
        if (ids.length >= this.batchAttempts) break
        const id = prioritize[(start + i) % prioritize.length]!
        if (this.queued.has(id) || (dueNow && this.failureDue(id))) push(id)
      }
      this.prioritizeCursor = (start + scanSpan) % prioritize.length
    }
    for (let i = this.queueHead; i < this.queueItems.length; i += 1) {
      if (ids.length >= this.batchAttempts) break
      const id = this.queueItems[i]!
      if (this.queued.has(id)) push(id)
    }
    // R2-B r5：到期失败候选从**到期堆真消费**（弹出→本批认领），不再每批从
    // Map 头扫描已改期的冷却前缀（F 条同刻到期 × batchAttempts=1 会累计
    // F(F+1)/2 次 failureDue）。批后未消费/未改期的认领会还原压回（见循环尾部）。
    let claimedDue: Array<{ id: string; retryAt: number }> = []
    if (dueNow && ids.length < this.batchAttempts) {
      claimedDue = this.collectDueFailures(this.batchAttempts - ids.length, ids, seenIds)
    }

    let attempts = 0
    for (const id of ids) {
      if (attempts >= this.batchAttempts) break
      if (this.disposed || this.abortController.signal.aborted) break
      const loc = this.pendingLocs.get(id) ?? this.failureLocation(id)
      if (loc === undefined) continue
      attempts += 1
      this.counters.headerAttempts += 1
      const revisionBefore = this.revisions.get(id) ?? 0
      const dir = join(this.root, loc.projectDir, encodeSegment(id))
      let outcome: HeaderReadOutcome
      try {
        outcome = await this.reader.readSessionHeader(dir, id, {
          signal: this.abortController.signal,
          now: this.now,
          deadlineAt: this.now() + READ_DEADLINE_MS,
          // 计时面与 now 同一座钟（默认真实 setTimeout；手动时钟测试同单位）。
          timer: { set: (delayMs, fn) => this.scheduleFn(delayMs, fn) },
        })
      } catch (error) {
        if (this.abortController.signal.aborted || this.disposed) break
        outcome = {
          ok: false,
          reason: 'unreadable',
          message: error instanceof Error ? error.message : String(error),
          stats: { bytesCompressed: 0, bytesDecompressed: 0 },
        }
      }
      // I2：读在途期间 live 权威事实到达（revision 变了）→ 盘读结果作废。
      if ((this.revisions.get(id) ?? 0) !== revisionBefore) {
        this.dequeue(id)
        this.markDirty()
        continue
      }
      // cold verdict v2：unseeded 且当前 v4 → 小日志 stable-EOF 扫描（判据：
      // selected 可覆盖任何头的预设，且首 turn 不是封闭边界——只有读完整条
      // 小日志才能给最终值）。扫描走共享额度/真 AbortSignal/时限，置于唯一
      // 指纹复核之前，其后立即过 revision/disposed 屏障（与 R4-B 同律）。
      let scan: LogScanOutcome | undefined
      if (
        outcome.ok && !outcome.header.isSeeded && outcome.header.version === MAX_KNOWN_SESSION_VERSION
        && this.reader.scanSessionLog !== undefined
      ) {
        this.counters.scanAttempts += 1
        try {
          scan = await this.reader.scanSessionLog(dir, id, {
            signal: this.abortController.signal,
            now: this.now,
            deadlineAt: this.now() + READ_DEADLINE_MS,
            timer: { set: (delayMs, fn) => this.scheduleFn(delayMs, fn) },
          })
        } catch (error) {
          if (this.abortController.signal.aborted || this.disposed) break
          scan = { ok: false, reason: 'unreadable', message: error instanceof Error ? error.message : String(error), stats: { bytesCompressed: 0, bytesDecompressed: 0, lines: 0 } }
        }
        // R4-B 同律：扫描是 await——一返回先过屏障，live 事实不被盘扫描覆盖。
        if ((this.revisions.get(id) ?? 0) !== revisionBefore || this.disposed) {
          this.dequeue(id)
          this.markDirty()
          continue
        }
      }
      // I3/R2-B r4：读后指纹复核——**typed 结论**。IO 错误/超时/满额**不是**
      // 「文件变了」：那是底层受限，必须走失败冷却（retry），否则到期失败会
      // 每轮被当作「变了」继续、永远进不了冷却。
      const fingerprint = await this.fingerprintVerdict(id, loc)
      // R4-B：指纹复核也是 await——**一返回、任何 typed 分支写入之前**先过
      // revision/disposed 屏障；复核期间到达的 live 权威事实不得被 gone/
      // changed/unavailable 任何分支改写（删除或复活旧失败）。
      if ((this.revisions.get(id) ?? 0) !== revisionBefore || this.disposed) {
        this.dequeue(id)
        this.markDirty()
        continue
      }
      if (fingerprint.kind !== 'unchanged') {
        this.dequeue(id)
        if (fingerprint.kind === 'changed') {
          // 文件确实变了 → 旧读结果作废；等下一轮对账按新指纹重排。
          if (this.failures.delete(id)) this.recomputeNextRetryAt()
          this.markDirty()
          continue
        }
        if (fingerprint.kind === 'gone') {
          // 会话已消失 → 终态：清条目与失败，不再重试。
          this.dropEntry(id)
          if (this.failures.delete(id)) this.recomputeNextRetryAt()
          this.markDirty()
          continue
        }
        // unavailable：底层受限（IO 错误/超时/满额）→ 改期进冷却。
        this.scheduleFailure(id, loc, fingerprint.message)
        this.markDirty()
        continue
      }
      if (
        this.abortController.signal.aborted
        && (!outcome.ok || (outcome as { reason?: string }).reason === 'aborted' || (scan !== undefined && !scan.ok && scan.reason === 'aborted'))
      ) break
      // M1：扫描**失败**也累计已消耗字节（失败不得从字节统计里消失）。
      this.counters.bytesCompressed += outcome.stats.bytesCompressed + (scan !== undefined ? scan.stats.bytesCompressed : 0)
      this.counters.bytesDecompressed += outcome.stats.bytesDecompressed + (scan !== undefined ? scan.stats.bytesDecompressed : 0)
      if (scan !== undefined) {
        // 扫描路径提交（cold verdict v2）。
        if (scan.ok) {
          // I2：扫描证据必须与索引位置指纹指向**同一实体**——文件/代际/编码
          // 与实际打开的身份逐字段相等；否则是跨实体拼接（两套各自稳定的检查
          // 证明不了同一份证据），进入有界冷却，绝不保存/授权。
          if (!this.scanEvidenceMatchesIndex(scan, loc, fingerprint)) {
            this.scheduleFailure(id, loc, 'stable-eof scan evidence does not match the indexed file identity')
            this.dequeue(id)
            this.markDirty()
            continue
          }
          this.counters.scanFinals += 1
          const isRouter = scan.finalPreset === this.routerPreset
          const reason = scan.stats.lines === 0
            ? 'stable-eof snapshot from creation header (header-only log; current state, rescan on change)'
            : isRouter
              ? undefined
              : scan.finalPreset === null
                ? 'stable-eof: preset-free composition'
                : `stable-eof: runs under ${scan.finalPreset}`
          this.unverified.delete(id)
          this.putEntry(id, {
            sessionId: id,
            projectDir: loc.projectDir,
            file: loc.file,
            fingerprint: loc.fingerprint,
            verdict: isRouter ? 'router' : 'nonrouter',
            createdAt: scan.header.createdAt,
            isSeeded: scan.header.isSeeded,
            agentPreset: scan.finalPreset === null ? undefined : scan.finalPreset,
            origin: 'disk',
            reason,
            evidence: 'stable-eof',
          })
          if (this.failures.delete(id)) this.recomputeNextRetryAt()
          this.dequeue(id)
          this.markDirty()
          continue
        }
        // 扫描失败：瞬态（unstable/limit/unreadable）进冷却；missing 交对账收尾；
        // 终态（cap/corrupt/unsupported/ambiguous/future-format）显式 unknown。
        if (scan.reason === 'unstable') this.counters.scanUnstable += 1
        if (scan.reason === 'cap') this.counters.scanCaps += 1
        if (scan.reason === 'aborted') break
        if (scan.reason === 'missing') {
          this.dequeue(id)
          if (this.failures.delete(id)) this.recomputeNextRetryAt()
          this.markDirty()
          continue
        }
        if (scan.reason === 'unstable' || scan.reason === 'limit' || scan.reason === 'unreadable') {
          this.scheduleFailure(id, loc, `stable-eof scan ${scan.reason}: ${scan.message}`)
          this.dequeue(id)
          this.markDirty()
          continue
        }
        this.unverified.delete(id)
        this.putEntry(id, {
          sessionId: id,
          projectDir: loc.projectDir,
          file: loc.file,
          fingerprint: loc.fingerprint,
          verdict: 'unknown',
          createdAt: undefined,
          isSeeded: undefined,
          agentPreset: undefined,
          origin: 'disk',
          reason: `stable-eof scan ${scan.reason}: ${scan.message}`,
        })
        if (this.failures.delete(id)) this.recomputeNextRetryAt()
        this.dequeue(id)
        this.markDirty()
        continue
      }
      if (outcome.ok) {
        const { verdict, reason } = classifyDiskFacts(outcome.header)
        let finalReason = reason
        if (verdict === 'unknown' && !outcome.header.isSeeded) {
          // 保守 unknown 的具体口径：legacy 不扫（当前写入守卫证明不了历史语义）；
          // 读取面缺扫描能力（旧注入面）时如实降级。
          if (outcome.header.version !== MAX_KNOWN_SESSION_VERSION) {
            finalReason = `legacy format v${outcome.header.version}: stable-EOF scan covers current v${MAX_KNOWN_SESSION_VERSION} only`
          } else if (this.reader.scanSessionLog === undefined) {
            finalReason = 'stable-EOF scan unavailable on reader face (conservative unknown)'
          }
        }
        this.unverified.delete(id)
        this.putEntry(id, {
          sessionId: id,
          projectDir: loc.projectDir,
          file: loc.file,
          fingerprint: loc.fingerprint,
          verdict,
          createdAt: outcome.header.createdAt,
          isSeeded: outcome.header.isSeeded,
          agentPreset: outcome.header.agentPreset,
          origin: 'disk',
          reason: finalReason,
        })
        if (this.failures.delete(id)) this.recomputeNextRetryAt()
        this.dequeue(id)
        this.markDirty()
        continue
      }
      this.counters.headerErrors += 1
      if (outcome.reason === 'aborted') break
      if (outcome.reason === 'missing') {
        // 会话在枚举后消失：成员对账会收尾，**清掉旧失败**（不再卡在冷却里）。
        this.dequeue(id)
        if (this.failures.delete(id)) this.recomputeNextRetryAt()
        this.markDirty()
        continue
      }
      if (outcome.reason === 'limit' || outcome.reason === 'unreadable') {
        this.scheduleFailure(id, loc, outcome.message)
        this.dequeue(id)
        this.markDirty()
        continue
      }
      // 最终失败（corrupt / future-format / ambiguous / unsupported）：
      // fail closed 为显式 unknown；不进重试队列。
      this.unverified.delete(id)
      this.putEntry(id, {
        sessionId: id,
        projectDir: loc.projectDir,
        file: loc.file,
        fingerprint: loc.fingerprint,
        verdict: 'unknown',
        createdAt: undefined,
        isSeeded: undefined,
        agentPreset: undefined,
        origin: 'disk',
        reason: `${outcome.reason}: ${outcome.message}`,
      })
      if (this.failures.delete(id)) this.recomputeNextRetryAt()
      this.dequeue(id)
      this.markDirty()
    }
    // R2-B r5：认领还原——批中断（aborted/disposed）或提前 continue 后仍未
    // 改期/未删除的到期失败，把被弹出的期限压回堆，绝不丢一次重试。
    for (const claim of claimedDue) {
      const failure = this.failures.get(claim.id)
      if (failure !== undefined && failure.retryAt === claim.retryAt) this.retryHeapPush(claim.id, claim.retryAt)
    }
    if (claimedDue.length > 0) this.recomputeNextRetryAt()
    this.advanceQueueCursor()
    this.scheduleSave()
  }

  /**
   * R2-B r5：从到期堆取最多 `room` 条**当前真实到期**的失败候选（弹出即认
   * 领）。堆内的失效条目（已删除/已改期）惰性剔除；已被优先名单/队列收录的
   * id 弹出后原期限压回（不认领、不丢期限）。调用后重算 nextRetryAt。
   */
  private collectDueFailures(room: number, ids: string[], seenIds: Set<string>): Array<{ id: string; retryAt: number }> {
    const claimed: Array<{ id: string; retryAt: number }> = []
    const pushedBack: Array<{ id: string; retryAt: number }> = []
    const now = this.now()
    while (claimed.length < room) {
      const top = this.retryHeap[0]
      if (top === undefined || top.retryAt > now) break
      this.retryHeapPop()
      const failure = this.failures.get(top.id)
      if (failure === undefined || failure.retryAt !== top.retryAt) {
        this.failureDeadlineScanCount += 1 // 惰性失效条目：弹出即丢弃
        continue
      }
      if (seenIds.has(top.id)) {
        pushedBack.push({ id: top.id, retryAt: top.retryAt }) // 已由名单收录：期限保留
        continue
      }
      seenIds.add(top.id)
      ids.push(top.id)
      claimed.push({ id: top.id, retryAt: top.retryAt })
    }
    for (const item of pushedBack) this.retryHeapPush(item.id, item.retryAt)
    this.recomputeNextRetryAt()
    return claimed
  }

  /**
   * 变更时重算最早到期时刻（R2-B r4）。
   *
   * **绝不逐条全扫 failures**——批量删除 F 条失败时逐条重算会退化成
   * F(F-1)/2 次访问（平方）。改用**最小堆 + 惰性失效**：新增/改期时压入
   * （id, retryAt）；删除/改期使旧条目失效，重算时从堆顶惰性剔除，
   * 均摊 O(log F)。堆内失效条目堆积过多时按当前 failures 重建（均摊 O(1)/次）。
   */
  private recomputeNextRetryAt(): void {
    for (;;) {
      const top = this.retryHeap[0]
      if (top === undefined) {
        this.nextRetryAt = Number.POSITIVE_INFINITY
        break
      }
      const failure = this.failures.get(top.id)
      if (failure !== undefined && failure.retryAt === top.retryAt) {
        this.nextRetryAt = top.retryAt
        break
      }
      // 失效条目（已删除或已改期）：惰性剔除。
      this.failureDeadlineScanCount += 1
      this.retryHeapPop()
    }
    if (this.retryHeap.length > 4 * this.failures.size + 64) this.rebuildRetryHeap()
  }

  /** 压入一条到期期限（最小堆）。 */
  private retryHeapPush(id: string, retryAt: number): void {
    const heap = this.retryHeap
    heap.push({ id, retryAt })
    let i = heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heap[parent]!.retryAt <= heap[i]!.retryAt) break
      const tmp = heap[parent]!
      heap[parent] = heap[i]!
      heap[i] = tmp
      i = parent
    }
  }

  /** 弹出堆顶（最小 retryAt）。 */
  private retryHeapPop(): { id: string; retryAt: number } | undefined {
    const heap = this.retryHeap
    if (heap.length === 0) return undefined
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      this.retryHeapSiftDown(0)
    }
    return top
  }

  /** 堆内下沉（重建时也用它）。 */
  private retryHeapSiftDown(index: number): void {
    const heap = this.retryHeap
    let i = index
    for (;;) {
      const left = 2 * i + 1
      const right = 2 * i + 2
      let min = i
      if (left < heap.length && heap[left]!.retryAt < heap[min]!.retryAt) min = left
      if (right < heap.length && heap[right]!.retryAt < heap[min]!.retryAt) min = right
      if (min === i) break
      const tmp = heap[min]!
      heap[min] = heap[i]!
      heap[i] = tmp
      i = min
    }
  }

  /** 按当前 failures 重建到期堆（堆内失效条目堆积时的均摊摊平）。 */
  private rebuildRetryHeap(): void {
    this.failureDeadlineScanCount += this.failures.size
    const heap = this.retryHeap
    heap.length = 0
    for (const failure of this.failures.values()) heap.push({ id: failure.sessionId, retryAt: failure.retryAt })
    for (let i = (heap.length >> 1) - 1; i >= 0; i -= 1) this.retryHeapSiftDown(i)
  }

  /** 游标越过已处理/已墓碑的队头；头部堆积时惰性压实（不整体搬移 backlog）。 */
  private advanceQueueCursor(): void {
    while (this.queueHead < this.queueItems.length && !this.queued.has(this.queueItems[this.queueHead]!)) {
      this.queueHead += 1
    }
    if (this.queueHead > 64 && this.queueHead * 2 >= this.queueItems.length) {
      this.queueItems = this.queueItems.slice(this.queueHead).filter((id) => this.queued.has(id))
      this.queueHead = 0
    }
  }

  /**
   * 读后复核的 typed 结论（R2-B r4）：
   * - `unchanged`：指纹一致 → 本次读结果有效。
   * - `changed`：文件确实变了 → 结果作废，等下一轮对账按新指纹重排。
   * - `gone`：会话/代际文件已消失 → 终态（移除，不再重试）。
   * - `unavailable`：底层受限（IO 错误/超时/满额/中止）→ **不是**「变了」，
   *   走失败冷却改期重试（否则到期失败会每轮被当作「变了」继续、永不进冷却）。
   */
  private async fingerprintVerdict(id: string, loc: SessionLocation): Promise<FingerprintVerdict> {
    const sessionDir = join(this.root, loc.projectDir, encodeSegment(id))
    const statRun = await this.boundedIo(() => this.fs.stat(join(sessionDir, loc.file)))
    if ('expired' in statRun) return { kind: 'unavailable', message: `fingerprint stat unavailable: io ${statRun.expired}` }
    if ('error' in statRun) {
      if (isENOENT(statRun.error)) return { kind: 'gone' }
      return { kind: 'unavailable', message: `fingerprint stat failed: ${statRun.error instanceof Error ? statRun.error.message : String(statRun.error)}` }
    }
    const namesRun = await this.boundedIo(() => this.fs.readdir(sessionDir))
    if ('expired' in namesRun) return { kind: 'unavailable', message: `fingerprint listing unavailable: io ${namesRun.expired}` }
    if ('error' in namesRun) {
      if (isENOENT(namesRun.error)) return { kind: 'gone' }
      return { kind: 'unavailable', message: `fingerprint listing failed: ${namesRun.error instanceof Error ? namesRun.error.message : String(namesRun.error)}` }
    }
    const chosen = pickGenerationForTracking(namesRun.value.map((entry) => entry.name))
    if (chosen === undefined) return { kind: 'gone' }
    if (chosen.name !== loc.file) return { kind: 'changed' }
    if (fingerprintOf(statRun.value, chosen.namesKey) !== loc.fingerprint) return { kind: 'changed' }
    return {
      kind: 'unchanged',
      identity: {
        dev: statRun.value.dev,
        ino: statRun.value.ino,
        mtimeMs: statRun.value.mtimeMs,
        ctimeMs: statRun.value.ctimeMs,
        size: statRun.value.size,
      },
      namesKey: chosen.namesKey,
    }
  }

  /**
   * 扫描证据与索引位置是否同一实体（I2）：
   * - 文件名/代际/编码必须与索引追踪的文件一致（且是当前代）；
   * - 扫描实际打开的身份必须与**扫描之后**的索引 stat 身份逐字段相等
   *   （dev/ino/mtime/ctime/size）——扫描期间被替换/改写即不相等。
   */
  private scanEvidenceMatchesIndex(
    scan: { file: GenerationFile; identity: { dev: number; ino: number; mtimeMs: number; ctimeMs: number; size: number } },
    loc: SessionLocation,
    verdict: FingerprintVerdict,
  ): boolean {
    if (verdict.kind !== 'unchanged') return false
    const tracked = parseGenerationFilename(loc.file)
    if (tracked === undefined) return false
    if (scan.file.name !== loc.file) return false
    if (scan.file.version !== tracked.version || scan.file.zstd !== tracked.zstd) return false
    if (scan.file.version !== MAX_KNOWN_SESSION_VERSION) return false
    const identity = verdict.identity
    if (scan.identity.dev !== identity.dev) return false
    if (scan.identity.ino !== identity.ino) return false
    if (scan.identity.mtimeMs !== identity.mtimeMs) return false
    if (scan.identity.ctimeMs !== identity.ctimeMs) return false
    if (scan.identity.size !== identity.size) return false
    return true
  }

  /** 记一条可重试失败（改期进冷却）并推进到期堆。 */
  private scheduleFailure(id: string, loc: SessionLocation, message: string): void {
    const retryAt = this.now() + this.failureRetryMs
    this.failures.set(id, {
      sessionId: id,
      projectDir: loc.projectDir,
      file: loc.file,
      fingerprint: loc.fingerprint,
      retryAt,
      message,
    })
    this.retryHeapPush(id, retryAt)
    this.recomputeNextRetryAt()
  }

  private failureDue(id: string): boolean {
    const failure = this.failures.get(id)
    return failure !== undefined && this.now() >= failure.retryAt
  }

  private failureLocation(id: string): SessionLocation | undefined {
    const failure = this.failures.get(id)
    if (failure === undefined) return undefined
    return { projectDir: failure.projectDir, file: failure.file, fingerprint: failure.fingerprint }
  }

  private enqueueForClassification(id: string, loc: SessionLocation): void {
    this.pendingLocs.set(id, loc)
    if (!this.queued.has(id)) {
      this.queued.add(id)
      this.queueItems.push(id)
      this.queuedCount += 1
    }
    this.markDirty()
  }

  /** 变更标记：置 dirty、推进变更/判定状态序号（保存回调与稳态缓存据此判定）。 */
  private markDirty(): void {
    this.dirty = true
    this.mutationSeq += 1
    this.stateRevision += 1
  }

  private dequeue(id: string): void {
    if (this.queued.delete(id)) this.queuedCount -= 1 // 墓碑；游标/压实负责回收
    this.pendingLocs.delete(id)
  }

  /**
   * live 更新分派（I2）：dispose 后拒绝；hydrate 未落定时排队（应用顺序在
   * 持久化载入之后，旧盘判定压不过新 live 事实）；落定后立即应用。
   */
  private dispatchLive(thunk: () => void): void {
    if (this.disposed) return
    if (this.persistence === undefined || this.hydrated) {
      thunk()
      return
    }
    void this.hydrate()
    if (this.hydrated) {
      thunk()
      return
    }
    this.liveQueue.push(thunk)
  }

  private bumpRevision(sessionId: string): void {
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1)
  }

  /** live 会话创建/恢复（session/created 载荷）：投影权威判定（零盘读）。 */
  onLiveSession(session: unknown): void {
    this.membershipStale = true // 新会话 → 成员快照失效（R2-A：仅 created 置位）
    // 生命周期 token：认领这个 id 的**当前实例**（对象身份）。后续 disposed
    // 只撤同一实例——旧实例卸载不清新实例（review I6）。
    const createdId = liveSessionId(session)
    if (createdId !== undefined) {
      const previous = this.liveInstances.get(createdId)
      if (previous !== undefined && previous !== (session as object)) this.retiredInstances.add(previous)
      this.liveInstances.set(createdId, session as object)
    }
    this.dispatchLive(() => {
      const facts = liveHeaderOf(session)
      if (facts === undefined) return
      let finalPreset: string | null | undefined
      try {
        finalPreset = this.resolveLivePreset?.(session)
      } catch (error) {
        this.warn(`live 预设投影读取失败（按无权威值处理）: ${error instanceof Error ? error.message : String(error)}`)
        finalPreset = undefined
      }
      this.applyLiveVerdict(facts.id, facts, finalPreset)
    })
  }

  /**
   * live 会话离开 live store（`session/disposed`；官方契约：会话离开 store
   * 时发出一次，含发布回滚）。
   *
   * 处置（review I6）：撤销该 id 的 **live 权威代际** → 进入**受控冷重判**
   * （交回盘面重扫）或显式 unknown；离开 live 后不再有投影事件维护的旧事实
   * 不能继续授权（`verifyDiskFacts` 对 origin=live 无条件 fresh 的漏洞因此
   * 关闭）。**旧实例的 disposed 不清新实例**：只有与当前认领实例同一对象
   * 的 disposed 才撤销。
   */
  onLiveSessionDisposed(session: unknown): void {
    const id = liveSessionId(session)
    if (id === undefined) return
    const current = this.liveInstances.get(id)
    if (current !== (session as object)) return // 不是当前实例：不动新实例的权威
    this.liveInstances.delete(id)
    this.dispatchLive(() => {
      this.revokeLiveAuthority(id)
    })
  }

  /**
   * 撤销 live 权威（id 离开 live store）：live 条目作废 → 交回受控冷重判
   * （有位置就重新入队重扫），否则显式 unknown。资格随之失效（待消费授予
   * 撤下；将来重新成立会发新一代）。
   */
  private revokeLiveAuthority(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    this.bumpRevision(sessionId)
    if (entry !== undefined && entry.origin === 'live') {
      this.dropEntry(sessionId) // 条目作废 → 资格失效（待消费授予撤下）
      this.dequeue(sessionId)
      if (this.failures.delete(sessionId)) this.recomputeNextRetryAt()
      if (entry.projectDir !== '' && entry.file !== '') {
        // 受控冷重判：按已知位置重新入队（指纹复核不通过时转由对账重排）。
        this.enqueueForClassification(sessionId, {
          projectDir: entry.projectDir,
          file: entry.file,
          fingerprint: entry.fingerprint,
        })
      }
      this.markDirty()
    }
    this.syncRouterGrant(sessionId)
    this.scheduleSave()
  }

  /**
   * live 会话事件（session/event 载荷）：`agent-preset/selected` 是权威提交
   * 信号——事件值即最终组合（再选会再发事件），无需投影兜底。
   */
  onLiveSessionEvent(session: unknown, event: unknown): void {
    // R2-A：先过滤——无关事件（assistant/message 等每 token 事件）既不判定
    // 也不使成员快照失效；只有权威选择事件才走到 dispatchLive。
    const record = event as { type?: unknown; data?: unknown } | null | undefined
    if (record?.type !== 'agent-preset/selected') return
    const eventId = liveSessionId(session)
    if (eventId === undefined) return
    // 生命周期 token：**被替换的旧实例**的迟到事件不改新实例的事实
    // （review I6）；已认领的实例不被事件夺走（宿主可能用包装对象投递）。
    if (this.retiredInstances.has(session as object)) return
    if (!this.liveInstances.has(eventId)) this.liveInstances.set(eventId, session as object)
    this.membershipStale = true
    this.dispatchLive(() => {
      const data = record.data as { agentPreset?: unknown } | null | undefined
      if (data === null || typeof data !== 'object' || typeof data.agentPreset !== 'string') return
      const facts = liveHeaderOf(session)
      const id = facts?.id ?? eventId
      const existing = this.entries.get(id)
      const isSeeded = existing?.isSeeded ?? facts?.isSeeded ?? false
      this.applyLiveVerdict(id, { ...(facts ?? { id, version: 4, createdAt: existing?.createdAt ?? 0, isSeeded, agentPreset: undefined }), isSeeded }, data.agentPreset)
    })
  }

  /** 落一条 live 权威判定（origin=live；清失败/出队；bump revision）。 */
  private applyLiveVerdict(
    sessionId: string,
    facts: { createdAt: number; isSeeded: boolean; agentPreset: string | undefined },
    finalPreset: string | null | undefined,
  ): void {
    const { verdict, reason } = classifyLiveComposition(finalPreset, facts.isSeeded, this.routerPreset)
    const existing = this.entries.get(sessionId)
    this.unverified.delete(sessionId)
    this.putEntry(sessionId, {
      sessionId,
      projectDir: existing?.projectDir ?? '',
      file: existing?.file ?? '',
      fingerprint: existing?.fingerprint ?? '',
      verdict,
      createdAt: existing?.createdAt ?? facts.createdAt,
      isSeeded: facts.isSeeded,
      agentPreset: finalPreset === null ? undefined : (finalPreset ?? facts.agentPreset),
      origin: 'live',
      reason,
    })
    if (this.failures.delete(sessionId)) this.recomputeNextRetryAt()
    this.dequeue(sessionId)
    this.bumpRevision(sessionId)
    this.markDirty()
    this.scheduleSave()
  }

  /**
   * 待消费的 router 资格授予（review I1：可靠记账，不是"看一眼就吞"）。
   *
   * - 只有**当前确实成立**的资格才在待消费面：载入缓存未核指纹
   *   （unverified → verdictOf=pending）、判定为 unknown/nonrouter 的会话
   *   **不在**待消费面——不会因为"曾经是 router"就被提前消费掉、丢掉未来
   *   资格。
   * - 授予**不被读取即消费**：只有消费方 ack（`ackRouterGrant`）才移除。
   *   消费方因此可以安全地"没处理完就跳过"（延期/退避），候选不会永久漏。
   * - 资格"不再成立 → 又成立"发**新一代**授予（代数 +1）：两个轮询之间
   *   router→other→router 的翻面不会被旧基线吞掉。
   * - 稳态：待消费面为空 → 本方法 O(1)，不做全库重建。
   *
   * @param limit - 本次最多取几条（消费方的单轮预算）。
   * @param skip - 消费方正在**自行排期重试**的 id（跳过它们，避免同一候选
   *   反复占用预算；它们仍在待消费面，恢复后仍会被取到）。
   */
  pendingRouterGrants(limit: number, skip?: ReadonlySet<string>): readonly RouterGrant[] {
    const out: RouterGrant[] = []
    if (limit <= 0) return out
    for (const [sessionId, generation] of this.pendingGrants) {
      if (out.length >= limit) break
      if (skip?.has(sessionId)) continue
      out.push({ sessionId, generation })
    }
    return out
  }

  /** 待消费面上某 id 当前的资格代数（没有待消费授予则 undefined）。 */
  routerGrantGeneration(sessionId: string): number | undefined {
    return this.pendingGrants.get(sessionId)
  }

  /**
   * 消费方 ack（记账点）：代数不符即忽略——新一代资格未被消费，旧的一代
   * 不能把新一代标记成已消费。
   */
  ackRouterGrant(sessionId: string, generation: number): void {
    if (this.pendingGrants.get(sessionId) === generation) this.pendingGrants.delete(sessionId)
  }

  /**
   * 资格同步（唯一入口）：某 id 的资格当前是否成立 = 条目判定为 router
   * **且**已核验（不在 unverified 集里——载入缓存未核指纹前不授权）。
   * 成立且此前不成立 → 发新一代授予；此前成立现在不成立 → 撤下待消费授予。
   */
  private syncRouterGrant(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    const eligible = entry !== undefined && entry.verdict === 'router' && !this.unverified.has(sessionId)
    const state = this.grantState.get(sessionId)
    if (eligible) {
      if (state === undefined || !state.eligible) {
        const generation = ++this.eligibilitySeq
        this.grantState.set(sessionId, { generation, eligible: true })
        this.pendingGrants.set(sessionId, generation)
      }
      return
    }
    if (state !== undefined && state.eligible) {
      state.eligible = false
      this.pendingGrants.delete(sessionId)
    }
  }

  /**
   * 落一条判定（唯一写入口）：判定/来源变化时推进生命周期代际（授权屏障），
   * 并同步 router 资格。
   */
  private putEntry(sessionId: string, entry: VerdictEntry): void {
    const previous = this.entries.get(sessionId)
    this.entries.set(sessionId, entry)
    if (previous === undefined || previous.verdict !== entry.verdict || previous.origin !== entry.origin) {
      this.bumpAuthority(sessionId)
    }
    this.syncRouterGrant(sessionId)
  }

  /** 移除一条判定（同步资格：资格不再成立 → 撤下待消费授予）。 */
  private dropEntry(sessionId: string): void {
    const previous = this.entries.get(sessionId)
    this.entries.delete(sessionId)
    this.unverified.delete(sessionId)
    if (previous !== undefined) this.bumpAuthority(sessionId)
    this.syncRouterGrant(sessionId)
  }

  /** 生命周期代际 +1（任何影响授权的事实变化）。 */
  private bumpAuthority(sessionId: string): void {
    this.authorityTokens.set(sessionId, (this.authorityTokens.get(sessionId) ?? 0) + 1)
  }

  /** 判定状态版本号（稳态缓存键；每次判定/队列/失败变化 +1）。 */
  revision(): number {
    return this.stateRevision
  }

  /**
   * I1 r3：索引自身 fs 元数据操作（枚举/指纹复核）走与头读共享的槽位 +
   * deadline + 真实 AbortSignal——挂起/满额都快速返回，dispose 即刻唤醒；
   * 槽位由底层操作真正 settle 时释放。
   */
  private async boundedIo<T>(op: () => Promise<T>): Promise<{ value: T } | { error: unknown } | { expired: 'deadline' | 'abort' | 'busy' }> {
    if (this.disposed) return { expired: 'abort' }
    if (!this.ioBudget.tryAcquire()) return { expired: 'busy' }
    const signal = this.abortController.signal
    return new Promise((resolve) => {
      let settled = false
      let cancelTimer: () => void = () => undefined
      let detach: (() => void) | undefined
      const finish = (result: { value: T } | { error: unknown } | { expired: 'deadline' | 'abort' | 'busy' }): void => {
        if (settled) return
        settled = true
        cancelTimer()
        detach?.()
        resolve(result)
      }
      cancelTimer = this.scheduleFn(READ_DEADLINE_MS, () => finish({ expired: signal.aborted ? 'abort' : 'deadline' }))
      const onAbort = (): void => finish({ expired: 'abort' })
      signal.addEventListener('abort', onAbort)
      detach = () => signal.removeEventListener('abort', onAbort)
      this.ioBudget.attachRelease(
        op().then(
          (value) => finish({ value }),
          (error: unknown) => finish({ error }),
        ),
      )
    })
  }

  /** 是否还有待分类积压（O(1)：游标计数 + nextRetryAt 到期判定，I8 r2）。 */
  hasBacklog(): boolean {
    return this.queuedCount > 0 || this.now() >= this.nextRetryAt
  }

  /** 宿主成员快照（轮询只读快照，不打宿主面；I8 r2）。 */
  workspaces(): readonly WorkspaceInfo[] {
    return this.membershipSnapshot
  }

  /**
   * 成员定位（增量缓存）：某会话当前在哪个工作区、是否已被宿主归档。
   * O(1)——收编侧据此定位目标工作区，不必每轮遍历宿主全部工作区/会话
   * （review I7）。缓存随成员快照刷新（低频对账 / 事件失效）。
   */
  locateMember(sessionId: string): { workspaceId: string; archived: boolean } | undefined {
    const workspaceId = this.membershipIndex.get(sessionId)
    if (workspaceId === undefined) return undefined
    return { workspaceId, archived: this.archivedSnapshot.has(sessionId) }
  }

  /** 生命周期代际（授权屏障）：await 前后比对同一代数识别过期计划。 */
  authorityToken(sessionId: string): number {
    return this.authorityTokens.get(sessionId) ?? 0
  }

  /** 宿主归档集快照（同上）。 */
  archivedSnapshotIds(): ReadonlySet<string> {
    return this.archivedSnapshot
  }

  /** 同代快照三元组：workspaces/archived 与产出它们的 revision 同读（R2-A）。 */
  membershipState(): { workspaces: readonly WorkspaceInfo[]; archived: ReadonlySet<string>; revision: number } {
    return { workspaces: this.membershipSnapshot, archived: this.archivedSnapshot, revision: this.stateRevision }
  }

  /** 副作用前的权威核验：绕过失效标记强制重读宿主面（R2-A；仅权威变动轮调用）。 */
  forceRefreshMembership(): void {
    this.refreshMembership()
  }

  /**
   * 成员快照版本号（只在成员/归档内容变化时前进）——消费方据此缓存成员名单，
   * 避免每轮重建全成员名单（分批收敛时的平方成本）。
   */
  membershipRevision(): number {
    return this.membershipRevisionCounter
  }

  /**
   * 针对性权威核验（R2-A r4）：只回答「被点名的目标现在还是 workspace 成员
   * 吗/已被宿主归档吗」。**不做全成员 join/签名重组**——只读被问到的
   * workspace 的成员数组与归档集（O(被问到的成员数 + 归档数)），因此可以
   * 在稳态轮询里每轮做一次轻量核验，而不把全成员串行化。
   */
  verifyTargets(
    requests: ReadonlyArray<{ workspaceId: string; sessionIds: readonly string[] }>,
  ): Map<string, TargetAuthority> {
    const facts = new Map<string, TargetAuthority>()
    if (this.membership === undefined) return facts
    const archived = this.membership.archivedIds?.() ?? []
    const archivedSet = new Set(archived)
    let listed: readonly WorkspaceInfo[] | undefined
    for (const request of requests) {
      let workspace = this.membership.get?.(request.workspaceId)
      if (workspace === undefined) {
        listed ??= this.membership.list()
        workspace = listed.find((entry) => entry.id === request.workspaceId)
      }
      // R4-C：成员集**每 workspace 构建一次 Set**，逐目标 O(1) 查询——
      // 逐目标 includes 会把 T 个目标 × M 成员累计成乘积扫描。
      const memberSet = new Set(workspace?.sessionIds ?? [])
      for (const sessionId of request.sessionIds) {
        facts.set(sessionId, { member: memberSet.has(sessionId), archived: archivedSet.has(sessionId) })
      }
    }
    return facts
  }

  /** 快照失效（live 事件置位）后由消费方触发一次刷新；返回是否发生了刷新。 */
  refreshMembershipIfStale(): boolean {
    if (!this.membershipStale || this.membership === undefined) return false
    this.refreshMembership()
    return true
  }

  /** 刷新成员/归档快照；内容变化时推进判定版本号（dedup 稳态缓存随之失效）。 */
  private refreshMembership(): void {
    if (this.membership === undefined) return
    const listed = this.membership.list()
    const archived = this.membership.archivedIds?.() ?? []
    const membershipChanged =
      this.membershipSnapshot.length !== listed.length
      || listed.some((ws, i) => {
        const prev = this.membershipSnapshot[i]
        return prev === undefined || prev.id !== ws.id || (prev.sessionIds ?? []).join(',') !== (ws.sessionIds ?? []).join(',')
      })
    const archivedChanged =
      this.archivedSnapshot.size !== archived.length
      || archived.some((id) => !this.archivedSnapshot.has(id))
    this.membershipSnapshot = listed
    this.archivedSnapshot = new Set(archived)
    // 成员定位表（增量缓存）：随快照一起重建——收编侧 O(1) 定位目标工作区，
    // 稳态轮次不再遍历宿主全部工作区/会话（review I7）。
    const locations = new Map<string, string>()
    for (const workspace of listed) {
      for (const sessionId of workspace.sessionIds ?? []) {
        if (!locations.has(sessionId)) locations.set(sessionId, workspace.id)
      }
    }
    this.membershipIndex = locations
    this.membershipStale = false
    if (membershipChanged || archivedChanged) {
      this.membershipRevisionCounter += 1
      this.markDirty()
    }
  }

  /** 查判定：classified / pending（未判定或未知存在性）/ failed（冷却中）。 */
  verdictOf(sessionId: string): VerdictLookup {
    const entry = this.entries.get(sessionId)
    if (entry !== undefined && this.unverified.has(sessionId)) {
      return { status: 'pending' } // 载入缓存未核指纹：不授权副作用（I10 r2）
    }
    if (entry !== undefined) {
      const lookup: VerdictLookup = { status: 'classified', verdict: entry.verdict }
      if (entry.createdAt !== undefined) lookup.createdAt = entry.createdAt
      if (entry.isSeeded !== undefined) lookup.isSeeded = entry.isSeeded
      if (entry.agentPreset !== undefined) lookup.agentPreset = entry.agentPreset
      if (entry.reason !== undefined) lookup.reason = entry.reason
      lookup.origin = entry.origin
      if (entry.evidence !== undefined) lookup.evidence = entry.evidence
      return lookup
    }
    const failure = this.failures.get(sessionId)
    if (failure !== undefined) return { status: 'failed', retryAt: failure.retryAt }
    return { status: 'pending' }
  }

  /**
   * cold verdict v2：副作用/暴露前的**定点磁盘事实核验**。被点名的 disk 判定
   * 所依据的文件指纹是否仍然当前：
   * - fresh：指纹一致，判定仍可信；
   * - changed：文件/代际变了 → 作废旧判定并按新位置重新入队（受控重扫）；
   * - missing：文件消失 → 移除条目（终态）；
   * - untrusted：IO 错误/超时/满额/在途 live 事实（revision 前进）→ **保留旧
   *   条目但不得授权动作**（fail-closed，不把核验失败当 fresh）。
   * live-origin 判定不依赖文件指纹，直接 fresh。只核验被点名者，绝不整库扫描。
   */
  async verifyDiskFacts(sessionIds: readonly string[]): Promise<Map<string, { ok: boolean; kind?: 'untrusted' | 'changed' | 'missing' }>> {
    const results = new Map<string, { ok: boolean; kind?: 'untrusted' | 'changed' | 'missing' }>()
    for (const id of sessionIds) results.set(id, { ok: false, kind: 'untrusted' }) // 默认 untrusted（fail-closed）
    await this.hydrate()
    if (this.disposed) return results
    const work = async (): Promise<void> => {
      for (const id of sessionIds) {
        const entry = this.entries.get(id)
        if (entry === undefined) {
          results.set(id, { ok: false, kind: 'missing' }) // 判定已不在：不得授权
          continue
        }
        if (entry.origin === 'live') {
          results.set(id, { ok: true })
          continue
        }
        const revisionBefore = this.revisions.get(id) ?? 0
        const sessionDir = join(this.root, entry.projectDir, encodeSegment(id))
        const statRun = await this.boundedIo(() => this.fs.stat(join(sessionDir, entry.file)))
        // 每个 await 之后、写任何 entries/delete/requeue 之前先过 per-id
        // revision/disposed 屏障（R4-B 同律）：核验期间刚到的 live 事实不被删。
        if ((this.revisions.get(id) ?? 0) !== revisionBefore || this.disposed) {
          results.set(id, { ok: false, kind: 'untrusted' })
          continue
        }
        if ('expired' in statRun) {
          results.set(id, { ok: false, kind: 'untrusted' })
          continue
        }
        if ('error' in statRun) {
          if (isENOENT(statRun.error)) {
            this.dropEntry(id)
            this.dequeue(id)
            if (this.failures.delete(id)) this.recomputeNextRetryAt()
            this.markDirty()
            results.set(id, { ok: false, kind: 'missing' })
            continue
          }
          results.set(id, { ok: false, kind: 'untrusted' })
          continue
        }
        const namesRun = await this.boundedIo(() => this.fs.readdir(sessionDir))
        if ((this.revisions.get(id) ?? 0) !== revisionBefore || this.disposed) {
          results.set(id, { ok: false, kind: 'untrusted' })
          continue
        }
        if ('expired' in namesRun || 'error' in namesRun) {
          results.set(id, { ok: false, kind: 'untrusted' })
          continue
        }
        const chosen = pickGenerationForTracking(namesRun.value.map((listed) => listed.name))
        const currentFingerprint = chosen === undefined
          ? undefined
          : chosen.name === entry.file
            ? fingerprintOf(statRun.value, chosen.namesKey)
            : undefined
        if (currentFingerprint === undefined || currentFingerprint !== entry.fingerprint) {
          // 文件/代际/指纹变了：作废旧判定，按新位置重新入队（受控重扫）。
          this.dropEntry(id)
          if (chosen !== undefined) {
            this.enqueueForClassification(id, {
              projectDir: entry.projectDir,
              file: chosen.name,
              fingerprint: fingerprintOf(statRun.value, chosen.namesKey),
            })
          }
          if (this.failures.delete(id)) this.recomputeNextRetryAt()
          this.markDirty()
          results.set(id, { ok: false, kind: 'changed' })
          continue
        }
        results.set(id, { ok: true })
      }
    }
    // 与 advance/reconcile 同一串行链（条目写互斥）；异常吞为默认 untrusted。
    await this.enqueue(work).catch(() => undefined)
    return results
  }

  /**
   * 背景推进 + 低频对账（不依赖 UI 轮询）：初始对账一次，之后定时驱动；
   * 队列非空时按 backgroundIntervalMs 有界推进。返回停止函数。
   */
  start(): () => void {
    if (this.started || this.disposed) return () => undefined
    this.started = true
    void this.reconcile().catch((error) => {
      this.warn(`候选索引初始对账失败（下轮定时重试）: ${error instanceof Error ? error.message : String(error)}`)
    })
    let stopReconcile: () => void = () => undefined
    const tickReconcile = (): void => {
      if (this.disposed) return
      stopReconcile = this.scheduleFn(this.reconcileIntervalMs, tickReconcile)
      void this.reconcile().catch((error) => {
        this.warn(`候选索引对账失败（忽略）: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    stopReconcile = this.scheduleFn(this.reconcileIntervalMs, tickReconcile)
    let stopAdvance: () => void = () => undefined
    const tickAdvance = (): void => {
      if (this.disposed) return
      stopAdvance = this.scheduleFn(this.backgroundIntervalMs, tickAdvance)
      if (this.hasBacklog()) {
        void this.advance().catch((error) => {
          this.warn(`候选索引背景推进失败（忽略）: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }
    stopAdvance = this.scheduleFn(this.backgroundIntervalMs, tickAdvance)
    this.stopBackground = () => {
      stopReconcile()
      stopAdvance()
      this.started = false
    }
    return this.stopBackground
  }

  /** 诊断口径（计数为主，不含会话 id/路径等私有内容）。 */
  diagnostics(): {
    root: string
    preset: string
    queueLength: number
    failures: number
    bootstrap: { initialDone: boolean; lastReconcileAt?: number; lastReconcileError?: string }
    entries: { total: number; router: number; nonrouter: number; unknown: number; live: number; byEvidence: { 'stable-eof': number; 'header-seeded': number; live: number; none: number } }
    header: { attempts: number; errors: number; cacheReused: number; bytesCompressed: number; bytesDecompressed: number }
    scan: { attempts: number; finals: number; caps: number; unstable: number }
    concurrency: { inflightAdvance: boolean; inflightReconcile: boolean; reconcileRuns: number; advanceRuns: number }
    degraded: { unsupportedCodec: boolean }
    /** 资格授予面（review I1）：待消费授予数 + 当前成立资格数。 */
    grant: { pending: number; eligible: number }
  } {
    const breakdown = { total: this.entries.size, router: 0, nonrouter: 0, unknown: 0, live: 0 }
    const byEvidence = { 'stable-eof': 0, 'header-seeded': 0, live: 0, none: 0 }
    for (const entry of this.entries.values()) {
      breakdown[entry.verdict] += 1
      if (entry.origin === 'live') {
        breakdown.live += 1
        byEvidence.live += 1
      } else if (entry.evidence === 'stable-eof') {
        byEvidence['stable-eof'] += 1
      } else if (entry.verdict === 'nonrouter' && entry.isSeeded === true) {
        byEvidence['header-seeded'] += 1
      } else {
        byEvidence.none += 1
      }
    }
    return {
      root: this.root,
      preset: this.routerPreset,
      queueLength: this.queuedCount,
      failures: this.failures.size,
      bootstrap: {
        initialDone: this.initialDone,
        ...(this.lastReconcileAt !== undefined ? { lastReconcileAt: this.lastReconcileAt } : {}),
        ...(this.lastReconcileError !== undefined ? { lastReconcileError: this.lastReconcileError } : {}),
      },
      entries: { ...breakdown, byEvidence },
      header: {
        attempts: this.counters.headerAttempts,
        errors: this.counters.headerErrors,
        cacheReused: this.counters.cacheReused,
        bytesCompressed: this.counters.bytesCompressed,
        bytesDecompressed: this.counters.bytesDecompressed,
      },
      scan: {
        attempts: this.counters.scanAttempts,
        finals: this.counters.scanFinals,
        caps: this.counters.scanCaps,
        unstable: this.counters.scanUnstable,
      },
      concurrency: {
        inflightAdvance: this.inflightAdvance !== undefined,
        inflightReconcile: this.inflightReconcile !== undefined,
        reconcileRuns: this.counters.reconcileRuns,
        advanceRuns: this.counters.advanceRuns,
      },
      // M1 r2：降级标记只从条目事实派生（条目重判即恢复，不粘性）。
      degraded: {
        unsupportedCodec: [...this.entries.values()].some((entry) => entry.reason?.startsWith('unsupported') === true || entry.reason?.includes('scan unsupported') === true),
      },
      grant: {
        pending: this.pendingGrants.size,
        eligible: [...this.grantState.values()].filter((state) => state.eligible).length,
      },
    }
  }

  /** 安全处置：停定时、中断在途读取、等在途工作（含独立 hydrate）落定、冲刷保存。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopBackground?.()
    if (this.saveTimerCancel !== undefined) {
      this.saveTimerCancel()
      this.saveTimerCancel = undefined
    }
    this.abortController.abort() // 真实 AbortSignal：即刻唤醒在途读/枚举/复核
    await this.inflightReconcile?.catch(() => undefined)
    await this.inflightAdvance?.catch(() => undefined)
    await this.chain.catch(() => undefined)
    await this.hydratePromise?.catch(() => undefined) // I7 r2：独立入口的 hydrate 也在处置边界内
    await this.saveChain.catch(() => undefined)
    if (this.dirty) await this.pumpSave() // 最终冲刷（失败只告警，dispose 后不重排）
  }

  private scheduleSave(): void {
    if (!this.dirty || this.persistence === undefined || this.disposed) return
    if (this.saveRunning) return // 保存 worker 在途：它自己会带走最新状态（合并，I6 r2）
    if (this.saveTimerCancel !== undefined) return // 已有到点计时
    const now = this.now()
    if (this.saveDueAt === undefined) this.saveDueAt = now + SAVE_DEBOUNCE_MS
    this.saveTimerCancel = this.scheduleFn(Math.max(0, this.saveDueAt - now), () => {
      this.saveTimerCancel = undefined
      void this.pumpSave()
    })
  }

  /**
   * 保存 worker（I6 r2）：单 worker 串行；每轮取**最新**快照——在途期间
   * 的任何 dirty 都合并进唯一一笔后续保存，不排队完整快照闭包。失败保留
   * dirty 并只排一个重试计时；dispose 后失败不再重排（I7 r2）。
   */
  private async pumpSave(): Promise<void> {
    if (this.saveRunning || this.persistence === undefined) return
    this.saveRunning = true
    this.saveChain = (async () => {
      try {
        while (this.dirty) {
          const state = this.snapshotState()
          const seqAtSave = this.mutationSeq
          try {
            await this.persistence!.save(state)
            if (this.mutationSeq === seqAtSave) {
              this.dirty = false
              this.saveDueAt = undefined
            }
          } catch (error) {
            this.warn(`候选索引保存失败（保留待写，窗口后重试）: ${error instanceof Error ? error.message : String(error)}`)
            if (this.disposed) break // I7 r2：dispose 后不再重排重试
            this.saveDueAt = this.now() + SAVE_DEBOUNCE_MS
            if (this.saveTimerCancel !== undefined) this.saveTimerCancel()
            this.saveTimerCancel = this.scheduleFn(SAVE_DEBOUNCE_MS, () => {
              this.saveTimerCancel = undefined
              void this.pumpSave()
            })
            break
          }
        }
      } finally {
        this.saveRunning = false
      }
    })()
    return this.saveChain
  }

  private snapshotState(): IndexFileState {
    return {
      version: 2,
      root: this.root,
      preset: this.routerPreset,
      savedAt: this.now(),
      entries: [...this.entries.values()].map((entry) => ({ ...entry })),
      failures: [...this.failures.values()].map((failure) => ({ ...failure })),
    }
  }
}

/* ────────────────────────── 落盘校验 ────────────────────────── */

function isValidStateFile(value: unknown, root: string, preset: string): value is IndexFileState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (record['version'] === 1 || record['version'] === 2) && record['root'] === root && record['preset'] === preset
    && Array.isArray(record['entries']) && Array.isArray(record['failures'])
}

/** 缓存路径段必须是规范单段：非空、无分隔符、不是 . / ..、无 NUL（I10）。 */
function isSafeSegment(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false
  return true
}

function isValidEntry(value: unknown, routerPreset: string): value is VerdictEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['sessionId'] !== 'string' || record['sessionId'].length === 0) return false
  if (record['verdict'] !== 'router' && record['verdict'] !== 'nonrouter' && record['verdict'] !== 'unknown') return false
  if (record['origin'] !== 'disk' && record['origin'] !== 'live') return false
  if (!isSafeSegment(record['projectDir'])) return false
  if (typeof record['file'] !== 'string' || parseGenerationFilename(record['file']) === undefined) return false
  if (typeof record['fingerprint'] !== 'string') return false
  if (record['createdAt'] !== undefined && !(typeof record['createdAt'] === 'number' && Number.isSafeInteger(record['createdAt']) && record['createdAt'] >= 0)) return false
  if (record['isSeeded'] !== undefined && typeof record['isSeeded'] !== 'boolean') return false
  if (record['agentPreset'] !== undefined && typeof record['agentPreset'] !== 'string') return false
  if (record['reason'] !== undefined && typeof record['reason'] !== 'string') return false
  // 证据一致性（I10 + cold v2）：evidence 只许 stable-eof、只许出现在 disk 判定。
  if (record['evidence'] !== undefined && record['evidence'] !== 'stable-eof') return false
  if (record['origin'] === 'live' && record['evidence'] !== undefined) return false
  // 事实一致性（I10 + cold v2）：disk router 只能来自 stable-EOF 证据；
  // disk nonrouter 只能来自 seeded 头排除或 stable-EOF 证据；否则是坏缓存。
  if (record['origin'] === 'disk' && record['verdict'] === 'router' && record['evidence'] !== 'stable-eof') return false
  if (record['origin'] === 'disk' && record['verdict'] === 'nonrouter' && record['isSeeded'] !== true && record['evidence'] !== 'stable-eof') return false
  // I4：stable-eof 证据**判别式**校验——证据种类决定哪些事实必须齐备且
  // 互相自洽；不自洽的组合（不是当前代 / seeded / 缺排序事实 / 最终组合与
  // verdict 矛盾 / 指纹不描述该文件）一律弃用（受控重扫），不得提升为权威。
  if (record['evidence'] === 'stable-eof') {
    if (record['origin'] !== 'disk') return false
    const generation = parseGenerationFilename(record['file'] as string)
    if (generation === undefined || generation.version !== MAX_KNOWN_SESSION_VERSION) return false
    if (record['isSeeded'] === true) return false
    if (typeof record['createdAt'] !== 'number') return false
    const preset = record['agentPreset']
    if (record['verdict'] === 'router') {
      if (preset !== routerPreset) return false
    } else if (preset === routerPreset) {
      return false
    }
    if (!fingerprintDescribesFile(record['fingerprint'] as string, record['file'] as string)) return false
  }
  return true
}

/**
 * 指纹是否描述了该文件（fingerprint 形如
 * `dev:ino:mtimeMs:ctimeMs:size:<generation 名集合>`；名集合必须含该文件）。
 */
function fingerprintDescribesFile(fingerprint: string, file: string): boolean {
  const parts = fingerprint.split(':')
  if (parts.length !== 6) return false
  return parts[5]!.split('|').includes(file)
}

function isValidFailure(value: unknown): value is FailureEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['sessionId'] !== 'string' || record['sessionId'].length === 0) return false
  if (!isSafeSegment(record['projectDir'])) return false
  if (typeof record['file'] !== 'string' || parseGenerationFilename(record['file']) === undefined) return false
  if (typeof record['fingerprint'] !== 'string') return false
  if (typeof record['retryAt'] !== 'number' || !Number.isFinite(record['retryAt'])) return false
  if (record['message'] !== undefined && typeof record['message'] !== 'string') return false
  return true
}

/** 目录名清单 → 追踪用 generation 文件（见上方 pickGenerationForTracking；此处为兼容旧引用保留别名）。 */
