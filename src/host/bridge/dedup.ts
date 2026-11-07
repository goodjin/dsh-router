/**
 * Router 入口去重（计划 v1.1 Task C4 / 规格 §4）。
 *
 * 宿主没有「创建前拦截」钩子，去重走事后收敛：/router/state 构建前扫描各
 * workspace 的会话，识别「用了 dsh-router 预设」的会话；每个 workspace 取
 * **最早**的 router 会话为正主——正主 pin 到顶部（workspaceRegistry 原生
 * pinSession，r2 §5；最近置顶在前、重复 pin 幂等），其余较新的 router 预设
 * 会话 archiveSession 归档，并在 state 上写一条 redirect 指令
 * `{ sessionId: 正主, supersededSessionId: 被归档者 }`，客户端消费后经
 * /router/redirect/ack 清除（未消费前每次 state 都带，轮询幂等）。
 *
 * preset 识别取证（r2 报告 + 真实会话日志，2026-11-07）：
 * - 桌面版 v4 会话日志首行是 session 头，直接带 `agentPreset:"dsh-router"`
 *   （现场样本 session-5db67b2a…/session.v4.jsonl.zstd 首行）；宿主
 *   dsh-session/lib/types/index.js:65 把 agentPreset 当 header 合法字段校验。
 * - 旧格式日志以持久化事件 `agent-preset/selected`（data `{agentPreset}`）
 *   记录（dsh-agent-preset-registry/lib/index.js:52 的折叠与 :776 的写入）。
 * - `permission/preset`（`{preset}`）是 dsh-permission-presets 写的**权限**
 *   预设事件（现场日志第二行即 `danger-full-access`），几乎每个会话都有，
 *   不能用作 router 会话识别依据——排除。
 * 两条证据经一次 sessionQuery.readSession 全取到；判定按会话缓存，只对
 * 「尚不认识的会话」读一次（readSession 是整日志重放校验，成本要压住）。
 *
 * 归档失败（宿主对活动会话拒绝 WorkspaceActiveSessionError 等）：记 warn、
 * 下轮重试；正主判定与 pin 不受影响（不丢「已有 Router」事实，Review Focus 2）。
 */

import type { WorkspaceInfo } from './sessions.ts'
import type { RouterRedirect, RouterState } from '../../shared/view-contract.ts'
/** readSession 快照的最小面（宿主 SessionLogSnapshot：header + 事件）。 */
export interface SessionSnapshotLike {
  session?: { agentPreset?: string; createdAt?: number; isSeeded?: boolean }
  events?: ReadonlyArray<{ type: string; data?: { agentPreset?: string } }>
}

export interface DedupSessionQuery {
  readSession(sessionId: string): Promise<SessionSnapshotLike | undefined>
}

export interface DedupWorkspaceFace {
  list(): WorkspaceInfo[]
}

/** registry 的动作面（r2 §5 实证：pinSession/archiveSession，archivedSessionIds 只读集）。 */
export interface DedupRegistryActions {
  pinSession(sessionId: string): Promise<unknown>
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<unknown>
  /** 缺席时按「无归档信息」处理（重复归档在宿主侧本就幂等）。 */
  archivedSessionIds?: readonly string[] | (() => readonly string[])
}

export interface RouterDedupDeps {
  workspaces: DedupWorkspaceFace
  sessionQuery: DedupSessionQuery
  registry: DedupRegistryActions
  /** router 角色的预设 id（默认 'dsh-router'）。 */
  routerPreset: string
  logger?: { warn(message: string): void }
}

/** 单个会话的判定缓存条目。 */
interface VerdictEntry {
  router: boolean
  /** header.createdAt（排序正主用；缺失按最晚处理）。 */
  createdAt?: number
  /** 已归档收编（发过 redirect 或本就在归档集）：不再归档、不再发指令。 */
  superseded: boolean
}

/**
 * state 合并（entry 接线用）：把该 workspace 最早的未消费 redirect 并进
 * RouterState；无指令时原对象返回、不加键（undefined 键会被 JSON 蒸发，
 * lossless 门禁要求它根本不出现）。
 */
export function stateWithRedirect<T extends RouterState>(state: T, redirect: RouterRedirect | undefined): T {
  if (redirect === undefined) return state
  return { ...state, redirect }
}

export class RouterDedup {
  private deps: RouterDedupDeps
  /** 判定缓存：判定过的会话不再 readSession。 */
  private verdicts = new Map<string, VerdictEntry>()
  /** 每 workspace 已 pin 的正主（变了才重新 pin，避免每拍打 registry）。 */
  private pinnedCanonical = new Map<string, string>()
  /** 待消费指令队列：workspaceId → 指令（先到先消费）。 */
  private pending = new Map<string, RouterRedirect[]>()

  constructor(deps: RouterDedupDeps) {
    this.deps = deps
  }

  private warn(message: string): void {
    this.deps.logger?.warn(message)
  }

  /** 事件/头部双证据判定（取证结论见文件头）。 */
  private snapshotSaysRouter(snapshot: SessionSnapshotLike): boolean {
    // 评审 F2：分叉子会话（cache=宿主 fork；minimal=agents.create 五步）的 header
    // 都带 isSeeded=true，且会继承来源的 agentPreset（cache 模式下正是 'dsh-router'）
    // ——它们是任务会话，绝不是 Router 正主候选，也不进归档收编。
    if (snapshot.session?.isSeeded === true) return false
    if (snapshot.session?.agentPreset === this.deps.routerPreset) return true
    return snapshot.events?.some(
      (event) => event.type === 'agent-preset/selected' && event.data?.agentPreset === this.deps.routerPreset,
    ) ?? false
  }

  /** 判定一个会话；读失败抛给调用方（本轮不缓存、下轮重试）。 */
  private async classify(sessionId: string): Promise<VerdictEntry> {
    const known = this.verdicts.get(sessionId)
    if (known !== undefined) return known
    const snapshot = await this.deps.sessionQuery.readSession(sessionId)
    const entry: VerdictEntry = {
      router: snapshot !== undefined && this.snapshotSaysRouter(snapshot),
      createdAt: snapshot?.session?.createdAt,
      superseded: false,
    }
    this.verdicts.set(sessionId, entry)
    return entry
  }

  /**
   * 一轮扫描：分类新会话 → 每 workspace 定正主并 pin → 其余归档 + 排队指令。
   * 每一步失败都只 warn 当轮跳过，不丢正主事实；下一拍 /router/state 再进来
   * 自然重试。
   */
  async resolve(): Promise<void> {
    // 宿主把 archivedSessionIds 暴露为 getter 属性（数组，dsh-workspace
    // lib/index.js:506-507）；防御性兼容「函数返回数组」的旧假设。
    const rawArchived: unknown = (this.deps.registry as { archivedSessionIds?: unknown }).archivedSessionIds
    const archivedList: readonly string[] =
      typeof rawArchived === 'function'
        ? ((rawArchived as () => readonly string[])() ?? [])
        : Array.isArray(rawArchived)
          ? (rawArchived as readonly string[])
          : []
    const archived = new Set<string>(archivedList)
    for (const workspace of this.deps.workspaces.list()) {
      const members = workspace.sessionIds ?? []
      for (const sessionId of members) {
        if (this.verdicts.has(sessionId)) continue
        try {
          await this.classify(sessionId)
        } catch (error) {
          // 读失败不缓存：下轮重试（判定错了会把正主选歪，宁可多读一次）。
          this.warn(`去重扫描读会话 ${sessionId} 失败（下轮重试）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // 正主候选：已判定为 router、未归档、未收编；按 createdAt 升序取最早。
      const candidates = members
        .filter((sessionId) => {
          const verdict = this.verdicts.get(sessionId)
          return verdict !== undefined && verdict.router && !verdict.superseded && !archived.has(sessionId)
        })
        .sort((a, b) => {
          const at = this.verdicts.get(a)?.createdAt ?? Number.MAX_SAFE_INTEGER
          const bt = this.verdicts.get(b)?.createdAt ?? Number.MAX_SAFE_INTEGER
          return at - bt
        })
      if (candidates.length === 0) continue
      const canonical = candidates[0]!
      if (this.pinnedCanonical.get(workspace.id) !== canonical) {
        try {
          await this.deps.registry.pinSession(canonical)
          this.pinnedCanonical.set(workspace.id, canonical)
        } catch (error) {
          this.warn(`去重扫描 pin 正主 ${canonical} 失败（下轮重试）: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // 其余较新者：归档收编；成功才写指令（跳转与归档保持一致，不留
      // 「跳过去了、重复会话还挂着」的半程状态）。
      for (const duplicate of candidates.slice(1)) {
        const verdict = this.verdicts.get(duplicate)
        if (verdict === undefined || verdict.superseded) continue
        try {
          await this.deps.registry.archiveSession(duplicate)
        } catch (error) {
          this.warn(`去重扫描归档重复会话 ${duplicate} 失败（下轮重试）: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        verdict.superseded = true
        const queue = this.pending.get(workspace.id) ?? []
        queue.push({ sessionId: canonical, supersededSessionId: duplicate })
        this.pending.set(workspace.id, queue)
      }
    }
  }

  /** 该 workspace 最早的一条未消费指令（无则 undefined，state 不加键）。 */
  pendingRedirectFor(workspaceId: string | undefined): RouterRedirect | undefined {
    if (workspaceId === undefined) return undefined
    return this.pending.get(workspaceId)?.[0]
  }

  /**
   * 已 pin 的正主会话清单（workspace 配对；v1.3 A2 供 Router 身份卡的收编
   * 补发——picker 自建的 Router 会话被 dedup 判定为正主后补发一次身份卡）。
   */
  canonicalSessions(): readonly { workspaceId: string; sessionId: string }[] {
    return [...this.pinnedCanonical].map(([workspaceId, sessionId]) => ({ workspaceId, sessionId }))
  }

  /** 客户端消费回执：按被归档会话清掉对应指令（没有匹配就静默）。 */
  ackRedirect(workspaceId: string, supersededSessionId: string): void {
    const queue = this.pending.get(workspaceId)
    if (queue === undefined) return
    this.pending.set(
      workspaceId,
      queue.filter((entry) => entry.supersededSessionId !== supersededSessionId),
    )
  }
}
