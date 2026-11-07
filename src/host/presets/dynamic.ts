/**
 * 动态预设定义构建（v1.1 计划 Task C1 Step 2，规格 §5；r4/r6 取证落地）。
 *
 * - buildWorkerPresetDefinition(t)：每个启用 worker 类型 → 真实代理预设
 *   `dsh-router-worker-<templateId>`（persona=systemPrompt complete 整段替换、
 *   工具行按角色、技能行照 r4 §6 样板、压缩组）；
 * - buildRouterPresetDefinition(defaults)：Router 预设动态化（id 不变
 *   dsh-router，默认提示词来自 defaults）；
 * - staticRouterDefinition()：静态兜底（逐行等价 v1 yml 的 dsh-router 行；
 *   动态注册失败时由生命周期接线注册它，保证 Router 花名册不消失）。
 *
 * r4 条件②：本文件所有行只注册工具/提示词/技能，不 provide 服务（组行只裹
 * compaction 与 workflowEngine 的 isolate），无需额外 realm。
 * r6 取证：delegation 组 = tool-subagent-control 裸行 + tool-subagent
 * （provider: spawn, maxDepth: 2）；禁挂 ./list-agents 子路径；禁写
 * modelSelectionSettings / modelSelection / modelDiscovery / backgroundMode
 * 四个跨版本死键。
 *
 * 行内不出现 {{...}} 以外的宿主插值变量；{{model}} 允许（宿主注册的模板变量）。
 * 本文件零宿主依赖（RowSpec 与 validate-row.ts 同构），测试与运行时可直载。
 */

import { routerPrompt } from '../prompts/router.ts'
import type { WorkerTypeRecord } from '../../shared/view-contract.ts'

/** 一条声明行（与 validate-row.ts 的 RowSpec 兼容，另含组行字段）。 */
export interface RowSpec {
  id: string
  name: string
  config?: unknown
  group?: boolean
  isolate?: Record<string, boolean>
  disabled?: boolean
}

/** 代理预设定义（= dsh-agent-preset 行的 Config 形状，r4 §1）。 */
export interface PresetDefinition {
  id: string
  name: string
  description: string
  order: number
  plugins: RowSpec[]
}

/** 动态 worker 预设的 id 前缀（规格 §5：dsh-router-worker-<类型>）。 */
export const DYNAMIC_WORKER_PRESET_PREFIX = 'dsh-router-worker-'

export function dynamicPresetId(templateId: string): string {
  return `${DYNAMIC_WORKER_PRESET_PREFIX}${templateId}`
}

/** 动态预设排在静态三预设（10/20/30）之后。 */
const DYNAMIC_ORDER = 100

/** Router 预设的动态化输入（默认提示词来自设置）。 */
export interface RouterPresetDefaults {
  routerSystemPrompt: string
}

export interface BuildWorkerOptions {
  /** record.skills 解析出的技能目录（有技能且目录非空才挂技能行）。 */
  customSkillDirs?: string[]
}

/** 压缩组（与静态三预设同款；isolate realm，r4 条件②的例外形态）。 */
function compactionGroup(): RowSpec {
  return {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      },
    ],
  }
}

/** 主管子代理组（r6 §5 推荐清单；禁 list-agents 子路径、禁四死键）。 */
function delegationGroup(): RowSpec {
  return {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      // 控制与发现工具；裸行无 config（该包两版本都不导出 Config）。
      // 0.2.2 起 list_agents 就在这行里，绝不单挂 ./list-agents 行。
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', maxDepth: 2 },
      },
    ],
  }
}

/** 技能行（r4 §6.2 样板：只注册进本预设 scope 层，无需 realm）。 */
function skillRows(customSkillDirs: string[]): RowSpec[] {
  return [
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [...customSkillDirs] } },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  ]
}

/**
 * worker 类型 → 动态预设定义。persona 用类型提示词 complete 整段替换；工具行
 * 按 role（worker 带宿主执行工具行，supervisor 带 delegation 组）；技能行按
 * 解析出的目录挂载；压缩组收尾。调用方（生命周期）注册前对全部行过
 * validateRowSpec，坏行拒绝注册。
 */
export function buildWorkerPresetDefinition(t: WorkerTypeRecord, options: BuildWorkerOptions = {}): PresetDefinition {
  const plugins: RowSpec[] = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: t.systemPrompt, complete: true },
    },
    { id: 'tools', name: '@goodjin2/dsh-router/tools', config: { role: t.role } },
    { id: 'ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  ]
  if (t.role === 'worker') {
    plugins.push(
      // 动态行直接求值平台条件（与静态 yml 的 !!js 表达式同义）
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
      // 宿主必填（无默认；v1 缺它整树回滚的锚点键）
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    )
  } else {
    plugins.push(delegationGroup())
  }
  if (t.skills.length > 0 && options.customSkillDirs !== undefined && options.customSkillDirs.length > 0) {
    plugins.push(...skillRows(options.customSkillDirs))
  }
  plugins.push(compactionGroup())
  return {
    id: dynamicPresetId(t.templateId),
    name: t.name,
    description: t.description,
    order: DYNAMIC_ORDER,
    plugins,
  }
}

/** Router 预设动态定义（id 不变 dsh-router；默认提示词来自 defaults）。 */
export function buildRouterPresetDefinition(defaults: RouterPresetDefaults): PresetDefinition {
  const compaction = compactionGroup()
  compaction.id = 'router-compaction'
  return {
    id: 'dsh-router',
    name: 'Router',
    description: '任务编排器：理解需求、拆解派发、追踪汇总',
    order: 10,
    plugins: [
      {
        id: 'router-persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: defaults.routerSystemPrompt, complete: true },
      },
      { id: 'router-tools', name: '@goodjin2/dsh-router/tools', config: { role: 'router' } },
      { id: 'router-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
      { id: 'router-context', name: '@goodjin2/dsh-router/context' },
      compaction,
    ],
  }
}

/**
 * Router 静态兜底定义：逐行等价 v1 cordis.patch.yml 的 dsh-router 行（该行已从
 * yml 移除——yml 版与动态注册同 id 会撞 Duplicate agent preset，r4 §1；兜底改由
 * 本函数携带，提示词与 prompts/router.ts 同源 import，无第二份文本可漂移）。
 */
export function staticRouterDefinition(): PresetDefinition {
  return buildRouterPresetDefinition({ routerSystemPrompt: routerPrompt })
}

/**
 * 递归展开定义里的全部非组行（组行是结构容器没有包可校验，其子行各自独立成行）。
 * 生命周期注册前用它把每条宿主行送进 validateRowSpec。
 */
export function collectHostRows(rows: RowSpec[], out: RowSpec[] = []): RowSpec[] {
  for (const row of rows) {
    if (row.group === true) {
      if (Array.isArray(row.config)) collectHostRows(row.config as RowSpec[], out)
      continue
    }
    out.push(row)
  }
  return out
}
