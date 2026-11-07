/**
 * guard 通知段（v1.2 Task B4 的最小落地）。
 *
 * B3（结果判定，含统一 notifications 面）尚未合并到本分支；紧急暂停成功的
 * 异常通知（kind:'anomaly'）先落在这里，并经 withGuardNotifications 投到
 * RouterState.notifications（C1 计划的同一键名）。两个落地决定（与 B3 合并
 * 时对齐，届时可整段收编）：
 *   1. 落盘为独立文件 <dataDir>/guard-notifications.json——guard-state.json 由
 *      熔断器独占（保留内存副本整体改写，B4 红线不动其内部），两个写者共写
 *      同一 JSON 会互相覆盖，通知段独立成文件才不丢卡。
 *   2. 卡形状是最小 GuardNotification（cardId/kind/title/summary/at）；B3/C1
 *      的 NotificationCard（actions/deliveryOrigin 等）合并后由它扩展。
 * 落盘失败只告警（内存里卡仍在、本轮响应已如实带逐项结果）——通知不该因磁盘
 * 故障把紧急暂停本身变成失败。
 */

import type { FsAdapter } from '../../shared/fs-adapter.ts'
import type { GuardNotification, RouterState } from '../../shared/view-contract.ts'

/** guard-notifications.json 的落盘形状。 */
export interface GuardNotificationsFile {
  schemaVersion: 1
  /** cardId 的单调序号源（重启后继续，不重号）。 */
  seq: number
  notifications: GuardNotification[]
}

export interface GuardNotificationsStoreDeps {
  fs: FsAdapter
  /** 状态文件路径（entry 装配 <dataDir>/guard-notifications.json）。 */
  path: string
  now(): number
  /** 落盘失败等非致命问题的日志口（缺席静默）。 */
  logger?: { warn(message: string): void }
}

const EMPTY_FILE: GuardNotificationsFile = { schemaVersion: 1, seq: 0, notifications: [] }

export class GuardNotificationsStore {
  private fs: GuardNotificationsStoreDeps['fs']
  private path: GuardNotificationsStoreDeps['path']
  private now: GuardNotificationsStoreDeps['now']
  private logger: GuardNotificationsStoreDeps['logger']
  private file: GuardNotificationsFile = { ...EMPTY_FILE, notifications: [] }
  private loaded = false

  constructor(deps: GuardNotificationsStoreDeps) {
    this.fs = deps.fs
    this.path = deps.path
    this.now = deps.now
    this.logger = deps.logger
  }

  /** 首次访问时装载（坏文件/版本不符从空白开始，与熔断器同口径）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.path)) as Partial<GuardNotificationsFile> | null
      if (parsed !== null && typeof parsed === 'object' && parsed.schemaVersion === 1 && Array.isArray(parsed.notifications)) {
        this.file = {
          schemaVersion: 1,
          seq: typeof parsed.seq === 'number' && parsed.seq >= 0 ? Math.floor(parsed.seq) : parsed.notifications.length,
          notifications: parsed.notifications.filter(
            (card): card is GuardNotification =>
              card !== null && typeof card === 'object'
              && typeof (card as GuardNotification).cardId === 'string'
              && (card as GuardNotification).kind === 'anomaly'
              && typeof (card as GuardNotification).title === 'string'
              && typeof (card as GuardNotification).summary === 'string'
              && typeof (card as GuardNotification).at === 'number',
          ),
        }
      }
    } catch {
      // 首启无文件或文件损坏：从空白开始。
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    try {
      const lastSlash = this.path.lastIndexOf('/')
      const parent = lastSlash <= 0 ? '/' : this.path.slice(0, lastSlash)
      await this.fs.mkdirp(parent)
      await this.fs.writeFile(this.path, JSON.stringify(this.file, null, 2))
    } catch (error) {
      this.logger?.warn(
        `guard-notifications.json 落盘失败（内存通知仍在）: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 追加一张异常通知卡（cardId 由单调序号生成，重启不重号）。 */
  async append(input: { title: string; summary: string }): Promise<GuardNotification> {
    await this.ensureLoaded()
    const card: GuardNotification = {
      cardId: `gn-${++this.file.seq}`,
      kind: 'anomaly',
      title: input.title,
      summary: input.summary,
      at: this.now(),
    }
    this.file.notifications.push(card)
    await this.save()
    return card
  }

  /** 当前全部通知卡（写入序；ack/清理面归 B3/C1 的通知通道）。 */
  async list(): Promise<GuardNotification[]> {
    await this.ensureLoaded()
    return [...this.file.notifications]
  }
}

/** RouterState 的最小通知投影：空清单不进键（lossless），非空整体带出。 */
export function withGuardNotifications<T extends RouterState>(state: T, notifications: GuardNotification[]): T {
  return notifications.length > 0 ? ({ ...state, notifications }) : state
}
