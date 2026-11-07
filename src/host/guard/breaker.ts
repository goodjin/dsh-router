/**
 * 全局派发熔断器 DispatchCircuitBreaker（v1.2 规格 §2，计划 Task B1 接口逐字）。
 *
 * 触发（滑动窗，两项任一）：a. infra 失败 ≥ infraThreshold（缺省 3）；
 * b. 窗口内创建任务 ≥ creationThreshold（缺省 10）且零完成（纯创建风暴信号；
 * 按任务 ID 集合对窗口，同一任务重复创建不重复计——主管合法并行拆解不误伤，
 * 误报代价 = 用户一键解除）。
 *
 * 冻结语义：一切 dispatch_task / create_worker_type 被拒（核心在入口检查）；
 * 解除仅用户可解除（unfreeze；B4 的异常卡/紧急暂停按钮是它的通道）。冻结是
 * 锁存态：窗口事件自然滑出不解除。
 *
 * 持久化：状态落 deps.path（entry 装配 dataDir/guard-state.json，FsAdapter 注
 * 入），宿主重启恢复冻结态；窗口事件一并落盘，重启不重置计数。落盘失败只
 * 告警（内存熔断仍生效）——熔断器的职责是拦住失控派发，不该因磁盘故障把自己
 * 变成新的故障源。
 */

import type { FsAdapter } from '../../shared/fs-adapter.ts'
import type { DispatchFailureClass } from './classify.ts'

/** 滑动窗宽（规格 §2：10 分钟）。 */
export const DEFAULT_BREAKER_WINDOW_MS = 600_000
/** 条件 a 阈值：infra 失败次数（规格 §2：≥3）。 */
export const DEFAULT_INFRA_THRESHOLD = 3
/** 条件 b 阈值：窗口内创建任务数且零完成（规格 §2：≥10）。 */
export const DEFAULT_CREATION_THRESHOLD = 10

/** 熔断器计数（模型可见投影 query_tasks.breaker 的数据源之一）。 */
export interface BreakerCounts {
  /** 窗口内 infra 失败次数。 */
  infraFailures: number
  /** 窗口内创建的任务数（按任务 ID 去重）。 */
  creations: number
  /** 窗口内完成任务数（零完成才允许条件 b 触发）。 */
  completions: number
}

/** 熔断器状态（计划接口 `state(): {frozen,reason,frozenAt,counts}`）。 */
export interface BreakerState {
  frozen: boolean
  reason?: string
  frozenAt?: number
  counts: BreakerCounts
}

/** 熔断冻结态的模型可见投影（query_tasks.breaker；lossless：未冻结只带 frozen）。 */
export interface BreakerVisibility {
  frozen: boolean
  reason?: string
  frozenAt?: number
}

/** guard-state.json 落盘形状（含窗口事件，重启不重置计数）。 */
export interface GuardStateFile {
  schemaVersion: 1
  frozen: boolean
  reason?: string
  frozenAt?: number
  infraFailures: { taskId: string; at: number }[]
  creations: { taskId: string; at: number }[]
  completions: { taskId: string; at: number }[]
}

/** recordFailure 的事件形状（计划接口逐字）。 */
export interface DispatchFailureEvent {
  taskId: string
  /** 事件时间（缺省取 deps.now()）。 */
  at?: number
  class: DispatchFailureClass
}

export interface CircuitBreakerDeps {
  fs: FsAdapter
  /** 状态文件路径（entry 装配 <dataDir>/guard-state.json）。 */
  path: string
  now(): number
  /** 滑动窗宽毫秒（缺省 10 分钟；非正数回默认）。 */
  windowMs?: number
  /** 条件 a 阈值（缺省 3；小于 1 回默认）。 */
  infraThreshold?: number
  /** 条件 b 阈值（缺省 10；小于 1 回默认）。 */
  creationThreshold?: number
  /** 落盘失败等非致命问题的日志口（缺席静默）。 */
  logger?: { warn(message: string): void }
}

function sanitizeEvents(raw: unknown): { taskId: string; at: number }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (entry): entry is { taskId: string; at: number } =>
        typeof (entry as { taskId?: unknown })?.taskId === 'string' && typeof (entry as { at?: unknown })?.at === 'number',
    )
    .map((entry) => ({ taskId: entry.taskId, at: entry.at }))
}

/** 一个 JSON 文件的读改写持久化形状（与账本/UI 状态同款）。 */
export class CircuitBreaker {
  private fs: CircuitBreakerDeps['fs']
  private path: string
  private now: CircuitBreakerDeps['now']
  private windowMs: number
  private infraThreshold: number
  private creationThreshold: number
  private logger: CircuitBreakerDeps['logger']
  private file: GuardStateFile = {
    schemaVersion: 1,
    frozen: false,
    infraFailures: [],
    creations: [],
    completions: [],
  }
  private loaded = false

  constructor(deps: CircuitBreakerDeps) {
    this.fs = deps.fs
    this.path = deps.path
    this.now = deps.now
    this.windowMs = typeof deps.windowMs === 'number' && deps.windowMs > 0 ? deps.windowMs : DEFAULT_BREAKER_WINDOW_MS
    this.infraThreshold =
      typeof deps.infraThreshold === 'number' && deps.infraThreshold >= 1 ? Math.floor(deps.infraThreshold) : DEFAULT_INFRA_THRESHOLD
    this.creationThreshold =
      typeof deps.creationThreshold === 'number' && deps.creationThreshold >= 1
        ? Math.floor(deps.creationThreshold)
        : DEFAULT_CREATION_THRESHOLD
    this.logger = deps.logger
  }

  /** 首次访问时从持久化装载（构造函数保持同步；坏文件/版本不符从空白开始）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.path)) as Partial<GuardStateFile> | null
      if (parsed !== null && typeof parsed === 'object' && parsed.schemaVersion === 1) {
        this.file = {
          schemaVersion: 1,
          frozen: parsed.frozen === true,
          ...(typeof parsed.reason === 'string' && parsed.reason !== '' ? { reason: parsed.reason } : {}),
          ...(typeof parsed.frozenAt === 'number' ? { frozenAt: parsed.frozenAt } : {}),
          infraFailures: sanitizeEvents(parsed.infraFailures),
          creations: sanitizeEvents(parsed.creations),
          completions: sanitizeEvents(parsed.completions),
        }
      }
    } catch {
      // 首启无文件或文件损坏：从空白状态开始（未冻结）。
    }
    this.loaded = true
  }

  /** 状态落盘（mkdirp 父目录；失败只告警，内存熔断仍生效）。 */
  private async save(): Promise<void> {
    try {
      const lastSlash = this.path.lastIndexOf('/')
      const parent = lastSlash <= 0 ? '/' : this.path.slice(0, lastSlash)
      await this.fs.mkdirp(parent)
      await this.fs.writeFile(this.path, JSON.stringify(this.file, null, 2))
    } catch (error) {
      this.logger?.warn(
        `guard-state.json 落盘失败（熔断以内存状态继续生效）: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 滑窗修剪：窗口外的失败/创建/完成事件出窗（含边界）。 */
  private prune(nowAt: number): void {
    const cutoff = nowAt - this.windowMs
    this.file.infraFailures = this.file.infraFailures.filter((entry) => entry.at >= cutoff)
    this.file.creations = this.file.creations.filter((entry) => entry.at >= cutoff)
    this.file.completions = this.file.completions.filter((entry) => entry.at >= cutoff)
  }

  private inWindowCounts(): BreakerCounts {
    return {
      infraFailures: this.file.infraFailures.length,
      creations: new Set(this.file.creations.map((entry) => entry.taskId)).size,
      completions: this.file.completions.length,
    }
  }

  /** 阈值判定 + 自动冻结（锁存；已冻结时不覆盖首次原因）。 */
  private async evaluateAutoFreeze(nowAt: number): Promise<void> {
    if (this.file.frozen) return
    const counts = this.inWindowCounts()
    if (counts.infraFailures >= this.infraThreshold) {
      this.file.frozen = true
      this.file.reason = `infra 失败 ${counts.infraFailures} 次（${Math.round(this.windowMs / 60_000)} 分钟窗口）`
      this.file.frozenAt = nowAt
      await this.save()
      return
    }
    if (counts.creations >= this.creationThreshold && counts.completions === 0) {
      this.file.frozen = true
      this.file.reason = `窗口内创建 ${counts.creations} 个任务零完成（疑似创建风暴）`
      this.file.frozenAt = nowAt
      await this.save()
    }
  }

  /** 记录一次派发失败；只有 infra 计数（task 类不进熔断，规格 §1）。 */
  async recordFailure(event: DispatchFailureEvent): Promise<void> {
    await this.ensureLoaded()
    if (event.class !== 'infra') return
    const at = event.at ?? this.now()
    this.prune(at)
    this.file.infraFailures.push({ taskId: event.taskId, at })
    await this.evaluateAutoFreeze(at)
  }

  /** 记录一次任务创建（集合语义：同任务重记只刷新时间）。 */
  async recordCreation(taskId: string, at?: number): Promise<void> {
    await this.ensureLoaded()
    const at2 = at ?? this.now()
    this.prune(at2)
    this.file.creations = this.file.creations.filter((entry) => entry.taskId !== taskId)
    this.file.creations.push({ taskId, at: at2 })
    await this.evaluateAutoFreeze(at2)
  }

  /** 记录一次完成：清该任务的创建计数基准，并把「零完成」信号破掉。 */
  async recordCompletion(taskId: string, at?: number): Promise<void> {
    await this.ensureLoaded()
    const at2 = at ?? this.now()
    this.prune(at2)
    this.file.creations = this.file.creations.filter((entry) => entry.taskId !== taskId)
    this.file.completions.push({ taskId, at: at2 })
    await this.save()
  }

  /** 当前状态（读口做滑窗修剪，冻结态不因事件滑出而解除）。 */
  async state(): Promise<BreakerState> {
    await this.ensureLoaded()
    this.prune(this.now())
    const state: BreakerState = { frozen: this.file.frozen, counts: this.inWindowCounts() }
    if (this.file.frozen) {
      state.reason = this.file.reason
      state.frozenAt = this.file.frozenAt
    }
    return state
  }

  /** 手动冻结（紧急暂停通道用；已冻结时保留首次原因）。 */
  async freeze(reason: string): Promise<void> {
    await this.ensureLoaded()
    if (this.file.frozen) return
    this.file.frozen = true
    this.file.reason = reason
    this.file.frozenAt = this.now()
    await this.save()
  }

  /** 用户解除：清冻结标与原因；窗口事件保留（仍失败会很快再次闭合）。 */
  async unfreeze(): Promise<void> {
    await this.ensureLoaded()
    this.file.frozen = false
    this.file.reason = undefined
    this.file.frozenAt = undefined
    await this.save()
  }
}
