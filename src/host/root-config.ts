/**
 * 根服务的配置声明（计划 B2：照 auto-resume 先例，全部 volatile 可缺省）。
 *
 * 只有 volatile 字段能被 Settings 页编辑；volatile 里不能再嵌 volatile。
 * 运行时的防御性解析（缺省补默认、负数取 0）在 entry.ts 的 resolveRootConfig。
 */

import Schema from '@deepseek-ai/schemastery'

import { BUILTIN_TEMPLATES } from './templates.ts'
import type { WorkerSpawnMode } from '../shared/view-contract.ts'

/** 挂载行 config 的声明形状（字段全部可选，volatile 可编辑）。 */
export interface RouterRootConfig {
  dataDir?: string
  tasksDir?: string
  maxActiveCards?: number
  perTypeConcurrency?: number
  maxDepth?: number
  routerPreset?: string
  supervisorPreset?: string
  workerPreset?: string
  templates?: WorkerTemplate[]
  /**
   * worker 派生模式（v1.3 规格 §1）：cache-priority = 统一组合 + 分叉继承
   * （默认）；minimal-face = 各预设最小工具 + 类型钉模型。volatile：设置页
   * 可改，存量任务/会话不受影响。
   */
  workerSpawnMode?: WorkerSpawnMode
  /** 记忆摘要的模型路由对（都非空才生效；缺省用活任务会话的最近路由）。 */
  summarizationProvider?: string
  summarizationModel?: string
  /** 每任务澄清提问批次数上限（v1.1 规格 §3.6；缺省 2）。 */
  questionBudget?: number
  /** 判定兜底：派发后无首响超时毫秒（v1.2 规格 §4；缺省 600000）。 */
  firstResponseTimeoutMs?: number
  /** 判定兜底：任务墙钟上限毫秒（v1.2 规格 §4；缺省 1800000）。 */
  adjudicationWallClockMs?: number
  /** 熔断滑动窗宽毫秒（v1.2 规格 §2；缺省 600000 = 10 分钟）。 */
  breakerWindowMs?: number
  /** 熔断条件 a 阈值：infra 失败次数（缺省 3）。 */
  breakerInfraThreshold?: number
  /** 熔断条件 b 阈值：窗口内创建任务数且零完成（缺省 10）。 */
  breakerCreationThreshold?: number
}

import type { WorkerTemplate } from '../shared/view-contract.ts'

/** 根服务的宿主 schema（check-host-rows 用它校验行的 config）。 */
export const Config = Schema.object({
  dataDir: Schema.string().default('').volatile(),
  tasksDir: Schema.string().default('.router').volatile(),
  maxActiveCards: Schema.number().default(12).volatile(),
  perTypeConcurrency: Schema.number().default(3).volatile(),
  maxDepth: Schema.number().default(3).volatile(),
  routerPreset: Schema.string().default('dsh-router').volatile(),
  supervisorPreset: Schema.string().default('dsh-router-supervisor').volatile(),
  workerPreset: Schema.string().default('dsh-router-worker').volatile(),
  workerSpawnMode: Schema.union(['cache-priority', 'minimal-face']).default('cache-priority').volatile(),
  summarizationProvider: Schema.string().default('').volatile(),
  summarizationModel: Schema.string().default('').volatile(),
  questionBudget: Schema.number().default(2).volatile(),
  firstResponseTimeoutMs: Schema.number().default(600_000).volatile(),
  adjudicationWallClockMs: Schema.number().default(1_800_000).volatile(),
  breakerWindowMs: Schema.number().default(600_000).volatile(),
  breakerInfraThreshold: Schema.number().default(3).volatile(),
  breakerCreationThreshold: Schema.number().default(10).volatile(),
  templates: Schema.array(
    Schema.object({
      templateId: Schema.string().required(),
      name: Schema.string().required(),
      description: Schema.string().default(''),
      role: Schema.union(['supervisor', 'worker']).default('worker'),
    }),
  )
    .default(BUILTIN_TEMPLATES as unknown as WorkerTemplate[])
    .volatile(),
})
