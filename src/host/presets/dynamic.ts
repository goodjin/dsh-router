/**
 * 动态预设定义构建（v1.1 计划 Task C1 Step 2，规格 §5；r4/r6 取证落地）。
 *
 * - buildWorkerPresetDefinition(t)：每个启用 worker 类型 → 真实代理预设
 *   `dsh-router-worker-<templateId>`（persona=systemPrompt complete 整段替换、
 *   工具行按角色、技能行照 r4 §6 样板、压缩组）；
 * - buildRouterPresetDefinition()：Router 预设动态化（id 不变 dsh-router；
 *   C5 起 complete 提示词由本包 prompt-section 行运行时组装：会话覆盖 ?? 默认，
 *   定义本身不烘焙文本）；
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
import { unifiedPrompt } from '../prompts/unified.ts'
import type { WorkerSpawnMode } from '../../shared/view-contract.ts'
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

/** 动态预设排在静态预设（Router 10 动态 / 执行者 20 静态）之后。 */
const DYNAMIC_ORDER = 100

/** Router 动态预设 id（会话保存的就是它；v1.3.1 热修供自愈巡检引用）。 */
export const ROUTER_PRESET_ID = 'dsh-router'

/** 静态执行者预设 id（cordis.patch.yml 的 dsh-router-executor 行；2026-11-12 合并裁定：
 *  supervisor/worker 两条静态预设合并为单条「执行者」，组合与 buildSupersetPlugins
 *  逐字节一致，config 的 executorPreset 默认指向它）。 */
export const EXECUTOR_PRESET_ID = 'dsh-router-executor'

/** 合并前的两条静态预设 id：启动时注册同名兼容别名保旧会话重开（r4 §4：会话日志
 *  记录的 preset id 必须在册，不在册即 agent-preset/not-found 无法重开）。 */
export const LEGACY_EXECUTOR_PRESET_IDS = ['dsh-router-supervisor', 'dsh-router-worker'] as const

/** 兼容别名排在花名册最尾（宿主 PresetDefinition 无隐藏字段，只能靠 order 压尾）。 */
export const LEGACY_ALIAS_ORDER = 999

/** cache-priority 模式的统一 persona 文本（= prompts/unified.ts 全文，唯一源）。 */
export function supersetPersona(): string {
  return unifiedPrompt
}

export interface BuildWorkerOptions {
  /** 组合模式（v1.3 A1；缺省 minimal-face = 现行组合，静态行为不变）。 */
  mode?: WorkerSpawnMode
}

export interface BuildRouterOptions {
  /** 组合模式（缺省 minimal-face = 现行 prompt-section 定义）。 */
  mode?: WorkerSpawnMode
}

/** 压缩组（与静态三预设同款；isolate realm，r4 条件②的例外形态）。 */
function compactionGroup(): RowSpec {
  return {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      // 压缩引擎行换成 Router 的任务描述引擎（2026-11-11 用户裁定流程）：
      // summarize 钩子按「该会话派发、仍在推进」的任务描述清单替换压缩段，
      // 不调 LLM；无活跃任务/worker 会话回退官方默认摘要（行为见
      // src/compaction.ts）。行 id 保持 compaction-basic——静态 yml 的
      // minimal-face 预设与动态超集各持一份组，id 只需组内唯一。
      { id: 'compaction-basic', name: '@goodjin2/dsh-router/compaction' },
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

/**
 * cache-priority 统一超集组合（v1.3 规格 §1/§2；每次调用产全新数组，调用方可
 * 自由追加技能行不改基准）。cache 模式的三处动态定义（Router / worker 类型 /
 * 兜底场景的类型）与 2026-11-12 合并裁定后的静态执行者预设行（yml 的
 * dsh-router-executor）及旧 id 兼容别名全部由它组成——行级逐字节相同是前缀缓存
 * 的前提，spawn-mode.spec 钉住。注意：
 * - persona = unified 中立全文（身份进历史不进系统提示词，规格 §2.1）；
 * - tools 行 role:'superset'：注册全部编排工具，角色闸在执行层按真实调用者
 *   过 assertCallerRole（矩阵不变，规格 §1「执行层硬闸不变」）；
 * - 执行工具行 / delegation 组 / context 行全部在场（「模型可见全部工具」），
 *   context 行的快照文本全局一致，不破坏跨会话前缀一致；
 * - 技能行不进基准（类型个性，追加在超集之后）。
 */
export function buildSupersetPlugins(): RowSpec[] {
  const rows: RowSpec[] = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: unifiedPrompt, complete: true },
    },
    { id: 'tools', name: '@goodjin2/dsh-router/tools', config: { role: 'superset' } },
    { id: 'ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    // 动态行直接求值平台条件（与静态 yml 的 !!js 表达式同义）
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
    // 宿主必填（无默认；v1 缺它整树回滚的锚点键）
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    // 执行支撑三件（2026-11-10 工具面补齐）：web 上网查资料、todo 待办、jobs
    // 后台任务——配置抄 superpowers 双宿主验证过的挂法；没有它们 worker 会把
    // 「需要上网」的任务如实报成「没有合适的工具」。
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60_000 } },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    delegationGroup(),
    { id: 'router-context', name: '@goodjin2/dsh-router/context' },
  ]
  rows.push(compactionGroup())
  return rows
}

/**
 * 旧 id 兼容别名定义（2026-11-12 合并裁定）：dsh-router-supervisor / dsh-router-worker
 * 各得一条与执行者组合完全一致的定义（order 999 压花名册尾部、名称标注旧会话兼容），
 * 由生命周期在启动时注册——旧执行会话的 preset id 由此保持在册可解析。别名不是
 * 派发目标：config 的 executorPreset 与 builtin 解析都指向 dsh-router-executor。
 */
export function legacyAliasDefinition(legacyId: string): PresetDefinition {
  if (!(LEGACY_EXECUTOR_PRESET_IDS as readonly string[]).includes(legacyId)) {
    throw new Error(`未知旧执行预设 id: ${legacyId}`)
  }
  const label = legacyId === 'dsh-router-supervisor' ? 'supervisor' : 'worker'
  return {
    id: legacyId,
    name: `Router-执行者（旧会话兼容·${label}）`,
    description: '旧会话重开兼容别名：组合与「Router-执行者」完全一致，请勿手动选用',
    order: LEGACY_ALIAS_ORDER,
    plugins: buildSupersetPlugins(),
  }
}

/**
 * 派发预设解析（2026-11-12 合并裁定后的单值语义；entry 接线与解析矩阵测试共用）：
 * - 启用且角色匹配的非 builtin 类型 → 动态预设 dsh-router-worker-<templateId>；
 * - builtin 类型 → executorPreset（原 supervisor/worker 两条静态行已合并）；
 * - 未知/禁用/角色不匹配 → undefined（桥回退 executorPreset 单值兜底，由核心
 *   assertTemplateUsable 拒绝派发）。两模式（cache-priority/minimal-face）解析同值。
 */
export function resolveDispatchPreset(
  record: WorkerTypeRecord | undefined,
  role: 'supervisor' | 'worker',
  executorPreset: string,
): string | undefined {
  if (record === undefined || !record.enabled || record.role !== role) return undefined
  if (record.origin === 'builtin') return executorPreset
  return dynamicPresetId(record.templateId)
}

/**
 * worker 类型 → 动态预设定义。persona 用类型提示词 complete 整段替换；工具行
 * 按 role（worker 带宿主执行工具行，supervisor 带 delegation 组）；技能行按
 * 解析出的目录挂载；压缩组收尾。调用方（生命周期）注册前对全部行过
 * validateRowSpec，坏行拒绝注册。
 */
export function buildWorkerPresetDefinition(t: WorkerTypeRecord, options: BuildWorkerOptions = {}): PresetDefinition {
  const plugins: RowSpec[] =
    options.mode === 'cache-priority'
      ? [...buildSupersetPlugins()]
      : [
          {
            id: 'persona',
            name: '@deepseek-ai/dsh-persona',
            config: { prefix: t.systemPrompt, complete: true },
          },
          { id: 'tools', name: '@goodjin2/dsh-router/tools', config: { role: t.role } },
          { id: 'ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
        ]
  if (options.mode !== 'cache-priority') {
    if (t.role === 'worker') {
      plugins.push(
        // 动态行直接求值平台条件（与静态 yml 的 !!js 表达式同义）
        { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
        // 宿主必填（无默认；v1 缺它整树回滚的锚点键）
        { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
        // 执行支撑三件（2026-11-10 工具面补齐，与超集同配置同语义）
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60_000 } },
        { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
        { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
      )
    } else {
      plugins.push(delegationGroup())
    }
  }
  // 2026-11-10 裁定：类型不再挂技能行（有提示词就够）——record.skills 字段
  // 保留在存量数据里，但预设组合不再消费它。
  if (options.mode !== 'cache-priority') {
    plugins.push(compactionGroup())
  }
  return {
    id: dynamicPresetId(t.templateId),
    name: t.name,
    description: t.description,
    order: DYNAMIC_ORDER,
    plugins,
  }
}

/**
 * Router 预设动态定义（id 不变 dsh-router；v1.1 C5：persona complete 行换成
 * 本包 prompt-section 行——complete section 运行时按「当前会话覆盖 ?? 默认」
 * 组装文本，默认值不烘焙进行定义，改默认无需重注册；多 complete 冲突由宿主
 * 组装期报错，所以动态定义里不得残留 persona 行，presets-dynamic/bundle 看守）。
 */
export function buildRouterPresetDefinition(options: BuildRouterOptions = {}): PresetDefinition {
  const compaction = compactionGroup()
  compaction.id = 'router-compaction'
  if (options.mode === 'cache-priority') {
    // cache 模式：与 worker 类型同款统一超集（含 compaction 组，组 id 用基准
    // 'compaction' 保持逐字节一致）。prompt-section 行退场——会话级提示词覆盖
    // 与逐字节统一不可兼得，cache 模式身份进历史（规格 §2），覆盖编辑器在
    // 该模式下不再生效（Part C 设置文案说明模式语义）。
    return {
      id: 'dsh-router',
      name: 'Router',
      description: '任务编排器：理解需求、拆解派发、追踪汇总',
      order: 10,
      plugins: buildSupersetPlugins(),
    }
  }
  return {
    id: 'dsh-router',
    name: 'Router',
    description: '任务编排器：理解需求、拆解派发、追踪汇总',
    order: 10,
    plugins: [
      { id: 'router-prompt-section', name: '@goodjin2/dsh-router/prompt-section' },
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
 * C5 起它保留 persona complete 行（prompts/router.ts 逐字），是动态注册失败时
 * 的回退源——回退形态丢会话级覆盖能力，但保证 Router 花名册不消失。
 */
export function staticRouterDefinition(): PresetDefinition {
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
        config: { prefix: routerPrompt, complete: true },
      },
      { id: 'router-tools', name: '@goodjin2/dsh-router/tools', config: { role: 'router' } },
      { id: 'router-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
      { id: 'router-context', name: '@goodjin2/dsh-router/context' },
      compaction,
    ],
  }
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
