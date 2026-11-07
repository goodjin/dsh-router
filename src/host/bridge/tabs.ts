/**
 * UI 状态存储（计划 B4/B2）：Router 会话登记 + 各 workspace 的持久标签序。
 *
 * GET /router/state 的 tabs 字段「该 workspace 持久标签序」、POST
 * /router/tabs/close 的落点、以及 Router 会话（客户端标签条固定首位）的登记
 * 都在这里；落盘到注入的持久化（宿主装配用 <dataDir>/ui-state.json），重启后
 * 恢复。写路径照账本纪律：先改内存校验、一次 save、失败回滚抛
 * persistence-failed。
 */

import { LedgerError } from '../ledger/errors.ts'
import type { TaskRecord } from '../../shared/types.ts'

/**
 * 空壳任务判定（v1.1 规格 §3.7 / Review Focus 5）：cancelled/failed 且无会话。
 * 清理只影响标签条与活动快照的**投影**，账本文件记录一律保留（归档可查）。
 * record 缺省（标签行没有可判定的任务）→ 不是空壳，照常显示。
 */
export function isHuskTask(record: Pick<TaskRecord, 'status' | 'sessionId'> | undefined): boolean {
  if (record === undefined) return false
  return (record.status === 'cancelled' || record.status === 'failed') && record.sessionId === undefined
}

/** 落盘形状。 */
export interface UiStateFile {
  schemaVersion: 1
  routerSessions: { sessionId: string; workspaceId?: string; name: string; createdAt: number }[]
  tabs: { workspaceId: string; sessionId: string; taskId?: string; addedAt: number }[]
  /**
   * 已投递过 Router 身份卡的会话 ID（v1.3 A2，Review Focus 5）：落盘幂等标记——
   * 重启/多次派发都不重发。旧文件缺该字段 = 空表（load 兼容）。
   */
  identityCards?: string[]
}

export interface UiStatePersistence {
  load(): Promise<UiStateFile | null>
  save(f: UiStateFile): Promise<void>
}

/** RouterSessionInfo 的投影形状（与共享视图契约对齐）。 */
export interface RouterSessionRow {
  sessionId: string
  title: string
}

/** WorkerTabInfo 的落盘侧形状（running 由调用面并上）。 */
export interface TabRow {
  workspaceId: string
  sessionId: string
  taskId?: string
  addedAt: number
}

export class UiStateStore {
  private persistence: UiStatePersistence
  private now: () => number
  private routerRows: UiStateFile['routerSessions'] = []
  private tabRows: UiStateFile['tabs'] = []
  /** 已投递身份卡的会话集（v1.3 A2；hasIdentityCard 同步读）。 */
  private identityCardSessions = new Set<string>()
  private loaded = false

  constructor(persistence: UiStatePersistence, now: () => number = Date.now) {
    this.persistence = persistence
    this.now = now
  }

  /** 装载（幂等；宿主装配时调用一次）。 */
  async load(): Promise<void> {
    if (this.loaded) return
    const file = await this.persistence.load()
    if (file !== null) {
      this.routerRows = structuredClone(file.routerSessions)
      this.tabRows = structuredClone(file.tabs)
      this.identityCardSessions = new Set(
        Array.isArray(file.identityCards) ? file.identityCards.filter((id) => typeof id === 'string' && id !== '') : [],
      )
    }
    this.loaded = true
  }

  private currentFile(): UiStateFile {
    return {
      schemaVersion: 1,
      routerSessions: structuredClone(this.routerRows),
      tabs: structuredClone(this.tabRows),
      identityCards: [...this.identityCardSessions],
    }
  }

  /** 写通道：备份 → 变更 → save → 失败回滚。 */
  private async commit(mutate: () => void): Promise<void> {
    await this.load()
    const backupSessions = structuredClone(this.routerRows)
    const backupTabs = structuredClone(this.tabRows)
    const backupCards = new Set(this.identityCardSessions)
    mutate()
    try {
      await this.persistence.save(this.currentFile())
    } catch (cause) {
      this.routerRows = backupSessions
      this.tabRows = backupTabs
      this.identityCardSessions = backupCards
      throw new LedgerError('persistence-failed', `UI 状态保存失败，内存已回滚: ${String(cause)}`, { cause })
    }
  }

  /** 登记 Router 会话（同 sessionId 重复登记保持原位置，只更新名字）。 */
  async addRouterSession(sessionId: string, workspaceId: string | undefined, name: string): Promise<void> {
    await this.commit(() => {
      const existing = this.routerRows.find((row) => row.sessionId === sessionId)
      if (existing !== undefined) {
        existing.name = name
        if (workspaceId !== undefined) existing.workspaceId = workspaceId
        return
      }
      this.routerRows.push({ sessionId, workspaceId, name, createdAt: this.now() })
    })
  }

  /** RouterSessionInfo[]（登记序）。 */
  routerSessions(): RouterSessionRow[] {
    return this.routerRows.map((row) => ({ sessionId: row.sessionId, title: row.name }))
  }

  /** 该会话是否已投递过 Router 身份卡（同步读；未标记 = false）。 */
  hasIdentityCard(sessionId: string): boolean {
    return this.identityCardSessions.has(sessionId)
  }

  /** 打「已投递身份卡」标记（幂等；重复标记保持单条，落盘持久化）。 */
  async markIdentityCardSent(sessionId: string): Promise<void> {
    if (this.identityCardSessions.has(sessionId)) return
    await this.commit(() => {
      this.identityCardSessions.add(sessionId)
    })
  }

  /** 加标签（同 workspace+sessionId 已存在则更新 taskId，不新增）。 */
  async addTab(workspaceId: string, sessionId: string, taskId?: string): Promise<void> {
    await this.commit(() => {
      const existing = this.tabRows.find((row) => row.workspaceId === workspaceId && row.sessionId === sessionId)
      if (existing !== undefined) {
        if (taskId !== undefined) existing.taskId = taskId
        return
      }
      this.tabRows.push({ workspaceId, sessionId, taskId, addedAt: this.now() })
    })
  }

  /** 关标签：只移出标签条，返回是否真的移除了。 */
  async removeTab(workspaceId: string, sessionId: string): Promise<boolean> {
    let removed = false
    await this.commit(() => {
      const before = this.tabRows.length
      this.tabRows = this.tabRows.filter((row) => !(row.workspaceId === workspaceId && row.sessionId === sessionId))
      removed = this.tabRows.length < before
    })
    return removed
  }

  /** 某 workspace 的标签序（加入序）。 */
  tabs(workspaceId: string): TabRow[] {
    return this.tabRows.filter((row) => row.workspaceId === workspaceId)
  }

  /** 全量标签（state 路由缺省 workspaceId 时用；加入序）。 */
  allTabs(): TabRow[] {
    return [...this.tabRows]
  }
}
