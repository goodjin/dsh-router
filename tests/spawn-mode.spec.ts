/**
 * v1.3 Task A1：workerSpawnMode 双模式 + 统一组合引擎（规格 §1/§2）。
 *
 * - cache-priority（默认）：三预设组合统一为同一超集（persona=unified 中立全文
 *   + 工具超集行 + 执行工具行 + delegation 组 + context 行 + 压缩组），行级逐字
 *   节相同（前缀缓存的前提）；静态 yml 两行保持最小面（宿主 agentPresets 无公开
 *   unregister，同 id 无法接管——取证见 .superpowers/sdd 台账 Ruling A1-1）。
 * - minimal-face：与现状完全一致（builder 不带 mode = 现行为，既有测试不改语义）。
 * - tools 行新增 role:'superset'：注册全部十个编排工具，执行层按调用方真实角色
 *   过 assertCallerRole 硬闸（矩阵不变，角色运行期解析——Ruling A1-4）。
 */

import { describe, expect, it } from 'vitest'

import { Config as RootConfigSchema, type RouterRootConfig } from '../src/host/root-config.ts'
import { spawnModeOr } from '../src/entry.ts'
import {
  buildRouterPresetDefinition,
  buildWorkerPresetDefinition,
  buildSupersetPlugins,
  collectHostRows,
  supersetPersona,
  type RowSpec,
} from '../src/host/presets/dynamic.ts'
import { validateRowSpec, type ValidateLoad } from '../src/host/presets/validate-row.ts'
import { buildToolDefinitions, type ToolDefinition } from '../src/host/tools/index.ts'
import { Config as ToolsRowConfig } from '../src/tools.ts'
import { builtinGeneralType, type WorkerTypeRecord } from '../src/host/templates.ts'
import { workerType as sampleType } from './helpers/presets-fixtures.ts'

/* ────────────────────────── 配置声明 ────────────────────────── */

describe('root-config：workerSpawnMode（volatile，默认 cache-priority）', () => {
  it('空 config 校验后 workerSpawnMode 默认 cache-priority（volatile 字段惰性 get）', () => {
    const resolved = RootConfigSchema({}) as { workerSpawnMode: { get(): string } }
    expect(resolved.workerSpawnMode.get()).toBe('cache-priority')
  })

  it('接受 cache-priority 与 minimal-face 两个值', () => {
    expect(() => RootConfigSchema({ workerSpawnMode: 'cache-priority' })).not.toThrow()
    expect(() => RootConfigSchema({ workerSpawnMode: 'minimal-face' })).not.toThrow()
  })

  it('拒绝其它值（union 收紧，不静默放行）', () => {
    expect(() => RootConfigSchema({ workerSpawnMode: 'bogus' as never })).toThrow()
  })

  it('RouterRootConfig 接口带 workerSpawnMode 字段（类型面）', () => {
    const config: RouterRootConfig = { workerSpawnMode: 'minimal-face' }
    expect(config.workerSpawnMode).toBe('minimal-face')
  })

  it('entry 防御解析：非法/缺省回 cache-priority，合法值直通', () => {
    expect(spawnModeOr(undefined)).toBe('cache-priority')
    expect(spawnModeOr('bogus')).toBe('cache-priority')
    expect(spawnModeOr('cache-priority')).toBe('cache-priority')
    expect(spawnModeOr('minimal-face')).toBe('minimal-face')
  })

  it('volatile 描述符解引用（评审 F1）：loader 经 Config validate 传 {get} 时 minimal-face 不被误解析', () => {
    expect(spawnModeOr({ get: () => 'minimal-face' })).toBe('minimal-face')
    expect(spawnModeOr({ get: () => 'cache-priority' })).toBe('cache-priority')
    expect(spawnModeOr({ get: () => 'bogus' })).toBe('cache-priority')
  })
})

/* ────────────────────────── 统一超集组合 ────────────────────────── */

/** 假宿主模块表（与 presets-dynamic.spec 同款；tools Config 需认 superset）。 */
const FAKE_MODULES: Record<string, { Config?: unknown }> = {
  '@deepseek-ai/dsh-persona': { Config: (input: unknown) => input },
  '@goodjin2/dsh-router/tools': { Config: ToolsRowConfig },
  '@deepseek-ai/dsh-tool-fs-search': { Config: (input: unknown) => input },
  '@deepseek-ai/dsh-tool-fs': { Config: (input: unknown) => input },
  '@deepseek-ai/dsh-tool-subagent': { Config: (input: unknown) => input },
  '@deepseek-ai/dsh-tool-ask-user': {},
  '@deepseek-ai/dsh-tool-bash': {},
  '@goodjin2/dsh-router/context': {},
  '@deepseek-ai/dsh-compaction-basic': {},
  '@deepseek-ai/dsh-command-compact': {},
  '@deepseek-ai/dsh-compaction-tool-result-pruner': {},
}
const fakeLoad: ValidateLoad = async (name) => FAKE_MODULES[name]

describe('统一超集组合（cache-priority 模式）', () => {
  const router = buildRouterPresetDefinition({ mode: 'cache-priority' })
  const worker = buildWorkerPresetDefinition(sampleType(), { mode: 'cache-priority' })
  const builtin = buildWorkerPresetDefinition(builtinGeneralType(0), { mode: 'cache-priority' })
  const supervisorType = sampleType({
    templateId: 'lead2',
    name: '主管二',
    role: 'supervisor',
    systemPrompt: '主管提示词',
    skills: [],
  })
  const supervisor = buildWorkerPresetDefinition(supervisorType, { mode: 'cache-priority' })

  it('Router / worker 类型 / builtin / supervisor 类型四来源的 plugins 逐行逐字节相同', () => {
    expect(router.plugins).toEqual(worker.plugins)
    expect(router.plugins).toEqual(builtin.plugins)
    expect(router.plugins).toEqual(supervisor.plugins)
    expect(router.plugins).toEqual(buildSupersetPlugins())
  })

  it('组合形状：persona=unified complete + tools superset + ask-user + 执行工具行 + delegation 组 + context + 压缩组', () => {
    const rows = buildSupersetPlugins()
    const ids = rows.map((row) => row.id)
    expect(ids).toEqual([
      'persona',
      'tools',
      'ask-user',
      'tool-bash',
      'tool-fs',
      'tool-fs-search',
      'delegation',
      'router-context',
      'compaction',
    ])
    expect(rows[0]).toMatchObject({
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: supersetPersona(), complete: true },
    })
    expect(rows[1]).toMatchObject({ name: '@goodjin2/dsh-router/tools', config: { role: 'superset' } })
    expect(rows[2]).toMatchObject({ name: '@deepseek-ai/dsh-tool-ask-user' })
    expect(rows[3]).toMatchObject({ name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' })
    expect(rows[4]).toMatchObject({ name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } })
    expect(rows[5]).toMatchObject({ name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } })
    const delegation = rows[6]!
    expect(delegation).toMatchObject({ name: 'cordis:group', group: true, isolate: { workflowEngine: true } })
    const delegationChildren = delegation.config as RowSpec[]
    expect(delegationChildren.map((row) => row.id)).toEqual(['tool-subagent-control', 'tool-subagent'])
    expect(delegationChildren[1]).toMatchObject({
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { provider: 'spawn', toolName: 'subagent', maxDepth: 2 },
    })
    expect(rows[7]).toMatchObject({ name: '@goodjin2/dsh-router/context' })
    const compaction = rows[8]
    expect(compaction).toMatchObject({ name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true } })
  })

  it('cache 模式 Router 定义无 prompt-section 行（会话覆盖让位逐字节统一）', () => {
    expect(router.plugins.some((row) => row.id === 'router-prompt-section')).toBe(false)
    expect(router.plugins.some((row) => row.name === '@goodjin2/dsh-router/prompt-section')).toBe(false)
    expect(router.id).toBe('dsh-router')
  })

  it('带技能的类型在 cache 模式 = 超集 + 技能行（技能是类型个性，不进超集基准）', () => {
    const skilled = buildWorkerPresetDefinition(sampleType(), {
      mode: 'cache-priority',
      customSkillDirs: ['/plugins/dsh-superpowers/preset/skills'],
    })
    expect(skilled.plugins.slice(0, buildSupersetPlugins().length)).toEqual(buildSupersetPlugins())
    expect(skilled.plugins.slice(buildSupersetPlugins().length).map((row) => row.id)).toEqual(['skill-filesystem', 'tool-skill'])
  })

  it('超集全部行过宿主行校验（含 superset 角色、无跨版本死键）', async () => {
    for (const row of collectHostRows(buildSupersetPlugins())) {
      const verdict = await validateRowSpec(row as never, { load: fakeLoad })
      expect(verdict.ok, verdict.ok ? '' : verdict.problems.join('\n')).toBe(true)
    }
  })

  it('supersetPersona：含 {{model}} 与身份卡协议，身份中立（不自称 Router/执行者），无未知插值', () => {
    const text = supersetPersona()
    expect(text).toContain('{{model}}')
    expect(text).toContain('身份卡')
    expect(text).toContain('【身份切换卡】')
    expect(text).toContain('complete_task')
    expect(text).toContain('report_blocker')
    expect(text).toContain('ask_user')
    expect(text).toMatch(/用户不是执行器/)
    expect(text).toMatch(/派发已冻结|已冻结/)
    // 身份中立：不预设具体身份
    expect(text).not.toContain('你是 Router')
    expect(text).not.toContain('你是工作型执行者')
    expect(text).not.toContain('你是主管')
    // 除 {{model}} 外无其它插值变量
    const variables = [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
    expect(variables).toEqual(['model'])
  })
})

/* ────────────────────────── minimal-face 模式 = 现状 ────────────────────────── */

describe('minimal-face（缺省）：行为与现状完全一致', () => {
  it('builder 不带 mode：worker 类型 = 现行按角色组合（persona=systemPrompt）', () => {
    const def = buildWorkerPresetDefinition(sampleType())
    expect(def.plugins[0]).toMatchObject({ name: '@deepseek-ai/dsh-persona', config: { prefix: '你是文档写手。\n', complete: true } })
    expect(def.plugins.some((row) => row.id === 'delegation')).toBe(false)
    expect(def.plugins.map((row) => row.id)).toEqual(['persona', 'tools', 'ask-user', 'tool-bash', 'tool-fs', 'tool-fs-search', 'compaction'])
  })

  it('builder 不带 mode：Router = 现行 prompt-section 定义', () => {
    const def = buildRouterPresetDefinition()
    expect(def.plugins.some((row) => row.id === 'router-prompt-section')).toBe(true)
    expect(def.plugins.some((row) => row.name === '@deepseek-ai/dsh-persona')).toBe(false)
  })

  it('显式 minimal-face 与缺省同组合', () => {
    expect(buildWorkerPresetDefinition(sampleType(), { mode: 'minimal-face' }).plugins).toEqual(
      buildWorkerPresetDefinition(sampleType()).plugins,
    )
    expect(buildRouterPresetDefinition({ mode: 'minimal-face' }).plugins).toEqual(buildRouterPresetDefinition().plugins)
  })
})

/* ────────────────────────── tools 行 superset 角色 + 运行期角色闸 ────────────────────────── */

describe("tools 行 role:'superset'：全工具注册 + 执行层真实角色硬闸", () => {
  /** 行 Config 认 superset。 */
  it('Config 接受 role=superset', () => {
    expect(() => ToolsRowConfig({ role: 'superset' })).not.toThrow()
    expect(() => ToolsRowConfig({ role: 'worker' })).not.toThrow()
  })

  /** 测试用核心：callerRoleOf 决定角色；getTask 给归属校验；执行/完成按 worker 正常受理。 */
  function fakeCore(callerRole: 'router' | 'supervisor' | 'worker' | undefined) {
    return {
      callerRoleOf: (_sid: string) => callerRole,
      getTask: (taskId: string) =>
        taskId === 'T-1'
          ? { id: 'T-1', sessionId: 'child-session', role: 'worker', status: 'running', docVersion: 1, dependsOn: [] }
          : undefined,
      enabledTemplates: () => [],
      reportProgress: async () => ({ ok: true as const }),
      completeTask: async () => ({ accepted: true, status: 'completed' as const }),
    }
  }

  function toolNames(defs: ToolDefinition[]): string[] {
    return defs.map((def) => def.name)
  }

  it('superset 注册全部十个编排工具（超集清单）', () => {
    const defs = buildToolDefinitions(fakeCore('router') as never, 'superset')
    expect(toolNames(defs).sort()).toEqual([
      'complete_task',
      'control_task',
      'create_worker_type',
      'dispatch_task',
      'list_worker_types',
      'query_tasks',
      'report_blocker',
      'report_progress',
      'search_history',
      'supplement_task',
    ])
  })

  it('worker 角色调 dispatch_task 被硬闸拒绝（角色矩阵不变，角色来自 callerRoleOf）', async () => {
    const defs = buildToolDefinitions(fakeCore('worker') as never, 'superset')
    const dispatch = defs.find((def) => def.name === 'dispatch_task')!
    await expect(
      dispatch.execute(
        { title: 't', goal: 'g', acceptance: [], role: 'worker', templateId: 'general' },
        { agent: { id: 'child-session' } },
      ),
    ).rejects.toThrow(/无权|角色/)
  })

  it('worker 角色对自己任务调 complete_task 放行（执行件正常工作）', async () => {
    const defs = buildToolDefinitions(fakeCore('worker') as never, 'superset')
    const complete = defs.find((def) => def.name === 'complete_task')!
    const value = (await complete.execute(
      { taskId: 'T-1', docVersion: 1, summary: '完成' },
      { agent: { id: 'child-session' } },
    )) as { accepted: boolean; status: string }
    expect(value.accepted).toBe(true)
    expect(value.status).toBe('completed')
  })

  it('callerRoleOf 缺席（旧接线）按 worker 兜底：派发被拒、执行放行（最严默认）', async () => {
    const core = fakeCore('worker') as Record<string, unknown>
    delete core.callerRoleOf
    const defs = buildToolDefinitions(core as never, 'superset')
    const dispatch = defs.find((def) => def.name === 'dispatch_task')!
    await expect(
      dispatch.execute({ title: 't', goal: 'g', acceptance: [], role: 'worker', templateId: 'general' }, { agent: { id: 's' } }),
    ).rejects.toThrow(/无权|角色/)
    const progress = defs.find((def) => def.name === 'report_progress')!
    expect(await progress.execute({ taskId: 'T-1', progress: 'p' }, { agent: { id: 'child-session' } })).toMatchObject({ ok: true })
  })
})

/* ────────────────────────── 生命周期按模式注册 ────────────────────────── */

import { DynamicPresetEngine, type AgentPresetsFace } from '../src/host/presets/lifecycle.ts'

function engineHarness() {
  const registered = new Map<string, unknown>()
  const face: AgentPresetsFace = {
    async register(def) {
      if (registered.has(def.id)) throw new Error(`Duplicate agent preset: ${def.id}`)
      registered.set(def.id, def)
      return async () => {
        registered.delete(def.id)
      }
    },
  }
  const engine = new DynamicPresetEngine({
    presets: face,
    // 只记录不执行：宿主 effect 在行 fiber dispose 时才触发注销器，立即执行会把
    // 刚注册的预设当场注销（presets-dynamic.spec 的 fakeEffect 同款语义）。
    effect: (factory) => factory,
    validate: async () => [],
    logger: { info: () => {}, warn: () => {} },
  })
  return { engine, registered }
}

describe('DynamicPresetEngine：模式感知注册', () => {
  it('syncRouter(cache-priority)：dsh-router 注册统一超集（无 prompt-section、有 superset persona）', async () => {
    const { engine, registered } = engineHarness()
    expect(await engine.syncRouter('cache-priority')).toBe('dynamic')
    const def = registered.get('dsh-router') as { plugins: RowSpec[] }
    expect(def.plugins[0]).toMatchObject({ name: '@deepseek-ai/dsh-persona', config: { prefix: supersetPersona(), complete: true } })
    expect(def.plugins.some((row) => row.id === 'router-prompt-section')).toBe(false)
    expect(def.plugins).toEqual(buildSupersetPlugins())
  })

  it('syncRouter() 缺省：现行 prompt-section 定义（minimal 行为不变）', async () => {
    const { engine, registered } = engineHarness()
    await engine.syncRouter()
    const def = registered.get('dsh-router') as { plugins: RowSpec[] }
    expect(def.plugins.some((row) => row.id === 'router-prompt-section')).toBe(true)
  })

  it('syncTypes(types, cache-priority)：类型预设 = 统一超集（+技能行）', async () => {
    const { engine, registered } = engineHarness()
    const outcome = await engine.syncTypes([sampleType()], 'cache-priority')
    expect(outcome.failed).toEqual([])
    const def = registered.get('dsh-router-worker-docs-writer') as { plugins: RowSpec[] }
    expect(def.plugins.slice(0, buildSupersetPlugins().length)).toEqual(buildSupersetPlugins())
  })

  it('ensureRegistered(record, cache-priority)：单类型同样出超集组合', async () => {
    const { engine, registered } = engineHarness()
    expect(await engine.ensureRegistered(sampleType(), 'cache-priority')).toBe(true)
    const def = registered.get('dsh-router-worker-docs-writer') as { plugins: RowSpec[] }
    expect(def.plugins[0]).toMatchObject({ config: { prefix: supersetPersona(), complete: true } })
  })
})
