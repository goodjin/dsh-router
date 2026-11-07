/**
 * 持久化通知存储（v1.2 规格 §5 统一卡片通道的宿主半边，计划 Task B3/C1）。
 *
 * core 在完成/异常路径写入完成卡/异常卡；RouterState.notifications 只投影未
 * 确认卡，客户端消费后 POST /router/notifications/ack 清除展示（记录保留供
 * 审计）。落盘 <dataDir>/notifications.json（FsAdapter 读改写，与
 * guard-state / closure-intents 同款）；落盘失败只告警——通知是体验层，不该
 * 因磁盘故障阻断完成协议。
 *
 * 卡的形状（NotificationCard）定义在 shared/view-contract（C1 的消费契约）；
 * 动作集 builders 在这里，core/判定器共用，保证完成/异常两套动作语义一致。
 */

import type { FsAdapter } from '../../shared/fs-adapter.ts'
import type { NotificationAction, NotificationCard } from '../../shared/view-contract.ts'

/** 完成卡动作集（规格 §5：打开会话 / 查看结果文档 / 退回重做 + 确认）。 */
export function completionActions(): NotificationAction[] {
  return [
    { action: 'open-session', label: '打开会话' },
    { action: 'view-result', label: '查看结果' },
    { action: 'rework', label: '退回重做' },
    { action: 'ack', label: '知道了' },
  ]
}

/** 异常卡动作集（规格 §5：重派 / 取消 + 确认；unfreeze 由 B4 冻结卡追加）。 */
export function anomalyActions(): NotificationAction[] {
  return [
    { action: 'open-session', label: '打开会话' },
    { action: 'redispatch', label: '重派' },
    { action: 'cancel', label: '取消任务' },
    { action: 'ack', label: '知道了' },
  ]
}

/** 写卡入参（cardId/at/ack 由存储生成，调用方不产 ID）。 */
export interface NotificationInput {
  kind: 'completion' | 'anomaly'
  taskId?: string
  title: string
  summary: string
  actions: NotificationAction[]
  deliveryOrigin?: 'worker' | 'system-judged'
}

/** 宿主侧消费面（core / 判定器只认这个；测试给内存假件）。 */
export interface NotificationSink {
  push(input: NotificationInput): Promise<NotificationCard>
  /** 未确认卡（新在前）。 */
  pending(): Promise<NotificationCard[]>
  /** 全量保留卡（新在前；审计用）。 */
  list(): Promise<NotificationCard[]>
  /** 确认；卡不存在返回 false（幂等：重复 ack 同一张卡第二次起返回 false）。 */
  ack(cardId: string): Promise<boolean>
}

/** 落盘形状。 */
export interface NotificationFile {
  schemaVersion: 1
  cards: NotificationCard[]
}

/** 保留上限（超出先丢最老的已读卡，再丢最老卡）。 */
export const DEFAULT_MAX_NOTIFICATION_CARDS = 100

export interface NotificationStoreDeps {
  fs: FsAdapter
  /** 落盘路径（entry 装配 <dataDir>/notifications.json）。 */
  path: string
  /** 卡 ID 生成器（entry 注入 uuid；测试注入计数器）。 */
  newId(): string
  now?(): number
  maxCards?: number
  logger?: { warn(message: string): void }
}

export class NotificationStore implements NotificationSink {
  private fs: NotificationStoreDeps['fs']
  private path: NotificationStoreDeps['path']
  private newId: NotificationStoreDeps['newId']
  private now: () => number
  private maxCards: number
  private logger: NotificationStoreDeps['logger']
  private cards: NotificationCard[] = []
  private loaded = false
  /** 观测口（测试的新 ID 计数器用）。 */
  seq = 0

  constructor(deps: NotificationStoreDeps) {
    this.fs = deps.fs
    this.path = deps.path
    this.newId = deps.newId
    this.now = deps.now ?? (() => Date.now())
    this.maxCards =
      typeof deps.maxCards === 'number' && deps.maxCards >= 1 ? Math.floor(deps.maxCards) : DEFAULT_MAX_NOTIFICATION_CARDS
    this.logger = deps.logger
  }

  /** 首次访问装载（坏文件/版本不符从空白开始）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.path)) as Partial<NotificationFile> | null
      if (parsed !== null && typeof parsed === 'object' && parsed.schemaVersion === 1 && Array.isArray(parsed.cards)) {
        this.cards = parsed.cards.filter(
          (card): card is NotificationCard =>
            typeof (card as { cardId?: unknown })?.cardId === 'string'
            && ((card as { kind?: unknown })?.kind === 'completion' || (card as { kind?: unknown })?.kind === 'anomaly'),
        )
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
      await this.fs.writeFile(this.path, JSON.stringify({ schemaVersion: 1, cards: this.cards } satisfies NotificationFile, null, 2))
    } catch (error) {
      this.logger?.warn(`notifications.json 落盘失败（内存通知继续生效）: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 修剪：超上限先丢最老的已读卡，再丢最老卡。 */
  private prune(): void {
    while (this.cards.length > this.maxCards) {
      // 手写倒序找最老的已读卡（tsconfig lib 未开 es2023，不用 findLastIndex）
      let oldestAcked = -1
      for (let i = this.cards.length - 1; i >= 0; i -= 1) {
        if (this.cards[i]!.ack) {
          oldestAcked = i
          break
        }
      }
      const dropAt = oldestAcked >= 0 ? oldestAcked : 0
      this.cards.splice(dropAt, 1)
    }
  }

  async push(input: NotificationInput): Promise<NotificationCard> {
    await this.ensureLoaded()
    const card: NotificationCard = {
      cardId: this.newId(),
      kind: input.kind,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      title: input.title,
      summary: input.summary,
      actions: [...input.actions],
      ...(input.deliveryOrigin !== undefined ? { deliveryOrigin: input.deliveryOrigin } : {}),
      at: this.now(),
      ack: false,
    }
    this.cards.unshift(card) // 新在前
    this.prune()
    await this.save()
    return card
  }

  async ack(cardId: string): Promise<boolean> {
    await this.ensureLoaded()
    const card = this.cards.find((entry) => entry.cardId === cardId && !entry.ack)
    if (card === undefined) return false
    card.ack = true
    await this.save()
    return true
  }

  async pending(): Promise<NotificationCard[]> {
    await this.ensureLoaded()
    return this.cards.filter((card) => !card.ack)
  }

  async list(): Promise<NotificationCard[]> {
    await this.ensureLoaded()
    return [...this.cards]
  }
}
