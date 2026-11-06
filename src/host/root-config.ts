/**
 * 根服务的配置声明（计划 B2：照 auto-resume 先例，全部 volatile 可缺省）。
 *
 * 只有 volatile 字段能被 Settings 页编辑；volatile 里不能再嵌 volatile。
 * 运行时的防御性解析（缺省补默认、负数取 0）在 entry.ts 的 resolveRootConfig。
 */

import Schema from '@deepseek-ai/schemastery'

import { BUILTIN_TEMPLATES } from './templates.ts'

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
