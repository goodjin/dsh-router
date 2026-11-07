/**
 * 动态预设注册生命周期（v1.1 计划 Task C1 Step 3，r4 条件①③⑤落地）。
 *
 * - ensureRegistered / syncTypes：类型创建/更新 → unregister + register 增量同步；
 *   注册前对每条宿主行过 validateRowSpec（与离线脚本共用一套校验语义），坏行
 *   拒绝注册（Review Focus 1：任何注册异常不炸装载，逐类型兜底）。
 * - 禁用 = 保留注册只拒派发：syncTypes 只做增量注册，从不清掉不在启用清单里的
 *   已注册预设（注销会使已关闭会话无法重开，r4 §4 取证）。
 * - 删除 = removeType 注销。
 * - syncRouter：Router 预设动态注册（id 不变 dsh-router，默认提示词来自
 *   defaults）；失败 catch → 注册静态兜底定义；兜底也失败 → 告警不炸。
 * - 每次注册成功后把注销器自接线 ctx.effect（r4 条件①）——不接线的话插件热
 *   重载后旧注册还在 → 重注册撞 Duplicate agent preset，preset 泄漏到进程退出。
 *
 * builtin 通用 worker 不经过本引擎（映射静态 dsh-router-worker 预设，保证任何
 * 情况下可派发——引擎全挂也不影响 builtin 派发）。
 */

import { validateRowSpec, makeHostLoader, discoverAllHostBases, type ValidateLoad } from './validate-row.ts'
import {
  buildRouterPresetDefinition,
  buildWorkerPresetDefinition,
  collectHostRows,
  dynamicPresetId,
  staticRouterDefinition,
  type PresetDefinition,
  type RowSpec,
} from './dynamic.ts'
import type { WorkerSpawnMode } from '../../shared/types.ts'
import type { WorkerTypeRecord } from '../../shared/view-contract.ts'

/** agentPresets 注册表的最小面（r4 §1：register 返回注销器）。 */
export interface AgentPresetsFace {
  register(definition: PresetDefinition): Promise<() => Promise<void>>
}

export interface SyncOutcome {
  /** 本轮成功确保在册的预设 id。 */
  registered: string[]
  /** 本轮注册失败被跳过的 templateId（引擎已告警带原因）。 */
  failed: string[]
}

export interface DynamicPresetEngineDeps {
  presets: AgentPresetsFace
  /** 每次注册成功后接线注销器（r4 条件①；幂等：重复触发注销器是 no-op）。 */
  effect(factory: () => unknown, label?: string): unknown
  /** 行校验口（缺省 = collectHostRows + validateRowSpec 多宿主装载）。 */
  validate?(rows: RowSpec[]): Promise<string[]>
  /** record.skills → 技能目录解析（缺省 = 无目录，不挂技能行）。 */
  skillDirs?(record: WorkerTypeRecord): string[] | undefined
  logger?: { info(message: string): void; warn(message: string): void }
}

export class DynamicPresetEngine {
  private deps: DynamicPresetEngineDeps
  /** 已由本引擎注册的预设 id → 注销器（增量同步与删除的依据）。 */
  private disposers = new Map<string, () => Promise<void>>()
  private validate: (rows: RowSpec[]) => Promise<string[]>
  private load: ValidateLoad

  constructor(deps: DynamicPresetEngineDeps) {
    this.deps = deps
    this.validate = deps.validate ?? this.validateWithHost.bind(this)
    // 多宿主基准一次装配（桌面 asar 在 Electron 进程里可读；CLI 安装在纯 node
    // 进程里可读；两个候选都试，全部失败时 validateRowSpec 报第一条错误）。
    this.load = makeHostLoader({ bases: discoverAllHostBases() })
  }

  private async validateWithHost(rows: RowSpec[]): Promise<string[]> {
    const problems: string[] = []
    for (const row of collectHostRows(rows)) {
      const verdict = await validateRowSpec(row, { load: this.load })
      if (!verdict.ok) problems.push(...verdict.problems)
    }
    return problems
  }

  /** 已在册的预设 id（诊断用）。 */
  registeredIds(): string[] {
    return [...this.disposers.keys()]
  }

  has(id: string): boolean {
    return this.disposers.has(id)
  }

  private async register(def: PresetDefinition): Promise<string> {
    // 先撤旧再注册同 id（更新场景）；未注册时注销是 no-op。
    const previous = this.disposers.get(def.id)
    if (previous !== undefined) await previous()
    const unregister = await this.deps.presets.register(def)
    this.disposers.set(def.id, unregister)
    // r4 条件①：注销器必须自接线 ctx.effect——插件行 fiber dispose 时由宿主
    // 触发，保证热重载/进程回收不留幽灵预设（重复触发是 no-op，安全）。
    this.deps.effect(() => {
      // 注销器自接线（r4 条件①）。先同步清引擎登记再异步注销：effect 可能在
      // 注册表 promise 落定前后被触发，重复触发注销器是 no-op（r4 §1）。
      if (this.disposers.get(def.id) === unregister) this.disposers.delete(def.id)
      void unregister()
    }, `dsh-router: 预设 ${def.id} 注销器`)
    return def.id
  }

  /**
   * 确保一个 worker 类型的动态预设按当前记录在册（创建/更新共用；builtin 类型
   * 映射静态预设，不经引擎）。mode 决定组合形态（v1.3 A1：cache-priority 出
   * 统一超集）。校验不过或注册抛错 → 告警并返回 false（不炸装载）。
   */
  async ensureRegistered(record: WorkerTypeRecord, mode: WorkerSpawnMode = 'minimal-face'): Promise<boolean> {
    if (record.origin === 'builtin') return false
    const id = dynamicPresetId(record.templateId)
    const definition = buildWorkerPresetDefinition(record, {
      customSkillDirs: this.deps.skillDirs?.(record),
      mode,
    })
    try {
      const problems = await this.validate(definition.plugins)
      if (problems.length > 0) {
        this.deps.logger?.warn(`worker 类型 ${record.templateId} 的动态预设校验未过，拒绝注册（${id}）:\n${problems.join('\n')}`)
        return false
      }
      await this.register(definition)
      return true
    } catch (error) {
      this.deps.logger?.warn(`worker 类型 ${record.templateId} 的动态预设注册失败（${id}）: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * 增量同步：启用清单里的每个类型确保在册（缺失补注册、变更重注册；mode 决定
   * 组合形态，v1.3 A1）。不在清单里的已注册预设一律保留——禁用语义是「只拒新
   * 派发」（r4 §4）。
   */
  async syncTypes(types: readonly WorkerTypeRecord[], mode: WorkerSpawnMode = 'minimal-face'): Promise<SyncOutcome> {
    const registered: string[] = []
    const failed: string[] = []
    for (const record of types) {
      if (await this.ensureRegistered(record, mode)) registered.push(dynamicPresetId(record.templateId))
      else if (record.origin !== 'builtin') failed.push(record.templateId)
    }
    return { registered, failed }
  }

  /** 删除类型 → 注销其动态预设（已关闭会话需重建同名类型才可重开，r4 §4）。 */
  async removeType(templateId: string): Promise<boolean> {
    const id = dynamicPresetId(templateId)
    const unregister = this.disposers.get(id)
    if (unregister === undefined) return false
    this.disposers.delete(id)
    await unregister()
    return true
  }

  /**
   * Router 预设同步：动态定义（C5：complete section 运行时按会话组装文本，
   * 定义不烘焙默认值——签名因此不带 defaults；mode='cache-priority' 时改出统一
   * 超集组合，规格 §1）优先，校验或注册失败 → 静态兜底定义（persona +
   * prompts/router.ts 逐字）；兜底也失败 → 只告警。
   * 返回值语义不变：'dynamic' | 'static' | 'failed'。
   */
  async syncRouter(mode: WorkerSpawnMode = 'minimal-face'): Promise<'dynamic' | 'static' | 'failed'> {
    const dynamic = buildRouterPresetDefinition({ mode })
    try {
      const problems = await this.validate(dynamic.plugins)
      if (problems.length > 0) throw new Error(`校验未过:\n${problems.join('\n')}`)
      await this.register(dynamic)
      return 'dynamic'
    } catch (dynamicError) {
      this.deps.logger?.warn(`Router 预设动态注册失败，回退静态定义: ${dynamicError instanceof Error ? dynamicError.message : String(dynamicError)}`)
      try {
        await this.register(staticRouterDefinition())
        return 'static'
      } catch (staticError) {
        this.deps.logger?.warn(`Router 预设静态兜底注册也失败（花名册暂无 Router，可重建会话重试）: ${staticError instanceof Error ? staticError.message : String(staticError)}`)
        return 'failed'
      }
    }
  }

  /** 停机/重载辅助：注销全部由本引擎注册的预设（正常路径由 ctx.effect 接管）。 */
  async disposeAll(): Promise<void> {
    for (const [id, unregister] of [...this.disposers]) {
      this.disposers.delete(id)
      await unregister()
    }
  }
}
