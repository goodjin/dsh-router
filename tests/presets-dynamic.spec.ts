/**
 * 动态预设引擎测试（v1.1 计划 Task C1 Step 2/3）。
 *
 * 每个启用 worker 类型运行时注册真实代理预设 `dsh-router-worker-<类型>`（r4 取证：
 * register 是公开运行期 API，组合真生效；注销器必须自接线 ctx.effect）；Router
 * 预设动态注册（id 仍 dsh-router，默认提示词来自 defaults），注册失败回退静态
 * 定义。动态组合的每个宿主行带完整 config 并过 validateRowSpec（A2 共用函数），
 * 坏行拒绝注册。
 *
 * 宿主包 schema 用注入的假模块表（照真宿主行为）；真宿主双版本校验由
 * `scripts/check-subrows.mjs`（静态 yml）与本文件的真宿主条件测试（CLI 安装在
 * 场时）共同把关。
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import {
  buildRouterPresetDefinition,
  buildSupersetPlugins,
  buildWorkerPresetDefinition,
  collectHostRows,
  dynamicPresetId,
  legacyAliasDefinition,
  LEGACY_ALIAS_ORDER,
  LEGACY_EXECUTOR_PRESET_IDS,
  staticRouterDefinition,
  type PresetDefinition,
  type RowSpec,
} from '../src/host/presets/dynamic.ts'
import { validateRowSpec, type ValidateLoad } from '../src/host/presets/validate-row.ts'
import { routerPrompt } from '../src/host/prompts/router.ts'
import { workerPrompt } from '../src/host/prompts/worker.ts'
import { builtinGeneralType, BUILTIN_GENERAL_ID, type WorkerTypeRecord } from '../src/host/templates.ts'
import type { RowSpec as ValidatableRow } from '../src/host/presets/validate-row.ts'

/* ────────────────────────── 假宿主模块表（照真 schema 行为） ────────────────────────── */

function requiredKey(key: string) {
  return (input: unknown): unknown => {
    const config = (input ?? {}) as Record<string, unknown>
    if (config[key] === undefined) throw new Error(`$.${key} missing required value`)
    return config
  }
}

/** 假模块表：必填键照宿主（provider、sampleOverCapGlobResults、role、prefix）；其余无 Config。 */
const FAKE_MODULES: Record<string, { Config?: unknown }> = {
  '@deepseek-ai/dsh-persona': { Config: requiredKey('prefix') },
  '@goodjin2/dsh-router/tools': { Config: requiredKey('role') },
  '@deepseek-ai/dsh-tool-fs-search': { Config: requiredKey('sampleOverCapGlobResults') },
  '@deepseek-ai/dsh-tool-fs': { Config: (input: unknown) => ({ applyPatch: (input ?? {}) !== undefined }) },
  '@deepseek-ai/dsh-tool-subagent': { Config: requiredKey('provider') },
  '@deepseek-ai/dsh-skill-filesystem': { Config: requiredKey('customSkillDirs') },
  '@deepseek-ai/dsh-tool-ask-user': {},
  '@deepseek-ai/dsh-tool-bash': {},
  '@deepseek-ai/dsh-tool-skill': {},
  '@goodjin2/dsh-router/context': {},
  '@goodjin2/dsh-router/prompt-section': {},
  '@goodjin2/dsh-router/compaction': {},
  '@deepseek-ai/dsh-tool-subagent-control': {},
  '@deepseek-ai/dsh-compaction-basic': {},
  '@deepseek-ai/dsh-command-compact': {},
  '@deepseek-ai/dsh-compaction-tool-result-pruner': {},
}

const fakeLoad: ValidateLoad = async (name) => FAKE_MODULES[name]

async function validateDefinition(def: PresetDefinition, load: ValidateLoad = fakeLoad): Promise<string[]> {
  const problems: string[] = []
  for (const row of collectHostRows(def.plugins)) {
    const verdict = await validateRowSpec(row as ValidatableRow, { load })
    if (!verdict.ok) problems.push(...verdict.problems)
  }
  return problems
}

/* ────────────────────────── 样例类型 ────────────────────────── */

function workerType(patch: Partial<WorkerTypeRecord> = {}): WorkerTypeRecord {
  return {
    templateId: 'docs-writer',
    name: '文档写手',
    description: '写文档的执行者',
    role: 'worker',
    models: ['deepseek-official/deepseek-flash', 'minimax-cn/MiniMax-M3.1'],
    systemPrompt: '你是文档写手。\n',
    skills: ['superpowers'],
    enabled: true,
    origin: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}


function rowById(def: PresetDefinition, id: string): RowSpec | undefined {
  return def.plugins.find((row) => row.id === id)
}

/* ────────────────────────── 定义组合 ────────────────────────── */

describe('buildWorkerPresetDefinition：worker 角色组合', () => {
  const def = buildWorkerPresetDefinition(workerType())

  it('预设 id = dsh-router-worker-<templateId>，名称/描述/顺序来自类型', () => {
    expect(def.id).toBe('dsh-router-worker-docs-writer')
    expect(dynamicPresetId('docs-writer')).toBe('dsh-router-worker-docs-writer')
    expect(def.name).toBe('文档写手')
    expect(def.description).toBe('写文档的执行者')
    expect(def.order).toBeGreaterThan(30) // 排在静态三预设之后
    expect(Array.isArray(def.plugins)).toBe(true)
  })

  it('persona = systemPrompt complete 整段替换', () => {
    const persona = rowById(def, 'persona')
    expect(persona).toBeDefined()
    expect(persona!.name).toBe('@deepseek-ai/dsh-persona')
    expect(persona!.config).toMatchObject({ prefix: '你是文档写手。\n', complete: true })
  })

  it('工具行按 role=worker，宿主工具行带完整 config', () => {
    expect(rowById(def, 'tools')).toMatchObject({ name: '@goodjin2/dsh-router/tools', config: { role: 'worker' } })
    expect(rowById(def, 'ask-user')).toMatchObject({ name: '@deepseek-ai/dsh-tool-ask-user' })
    expect(rowById(def, 'tool-bash')).toMatchObject({
      name: '@deepseek-ai/dsh-tool-bash',
      disabled: process.platform === 'win32',
    })
    expect(rowById(def, 'tool-fs')).toMatchObject({ name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } })
    expect(rowById(def, 'tool-fs-search')).toMatchObject({
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    })
  })

  it('压缩组在场且形状同静态（isolate + 三子行）', () => {
    const compaction = rowById(def, 'compaction')
    expect(compaction).toBeDefined()
    expect(compaction!.group).toBe(true)
    expect(compaction!.isolate).toEqual({ compaction: true, toolResultPruner: true })
    const children = compaction!.config as RowSpec[]
    expect(children.map((row) => row.id)).toEqual(['compaction-basic', 'command-compact', 'tool-result-pruner'])
    // 2026-11-11 用户裁定流程：引擎行换成 Router 的任务描述引擎（无活跃任务
    // 时回退官方默认摘要），静态 yml 的 minimal-face 预设不受影响。
    expect(children[0]).toMatchObject({ name: '@goodjin2/dsh-router/compaction' })
    expect(children[2]!.config).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  })

  it('worker 角色不挂 delegation 组（派发工具只在 supervisor 组合）', () => {
    expect(rowById(def, 'delegation')).toBeUndefined()
  })
})

describe('buildWorkerPresetDefinition：supervisor 角色组合（r6 取证）', () => {
  const def = buildWorkerPresetDefinition(workerType({ templateId: 'lead2', name: '主管二', role: 'supervisor', systemPrompt: '主管提示词', skills: [] }))

  it('挂 delegation 组：control 裸行 + tool-subagent（spawn，maxDepth 2）', () => {
    const delegation = rowById(def, 'delegation')
    expect(delegation).toBeDefined()
    expect(delegation!.group).toBe(true)
    expect(delegation!.isolate).toEqual({ workflowEngine: true })
    const children = delegation!.config as RowSpec[]
    expect(children.map((row) => row.id)).toEqual(['tool-subagent-control', 'tool-subagent'])
    expect(children[0]).toMatchObject({ name: '@deepseek-ai/dsh-tool-subagent-control' })
    expect('config' in children[0]! ? children[0]!.config : undefined).toBeUndefined() // 裸行无 config
    expect(children[1]).toMatchObject({
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { provider: 'spawn', toolName: 'subagent', maxDepth: 2 },
    })
  })

  it('supervisor 角色不挂 worker 的 bash/fs/fs-search 行', () => {
    for (const id of ['tool-bash', 'tool-fs', 'tool-fs-search']) {
      expect(rowById(def, id)).toBeUndefined()
    }
  })

  it('全树无跨版本死键、无 ./list-agents 子路径行（r6 §0.3）', () => {
    const deadKeys = ['modelSelectionSettings', 'modelSelection', 'modelDiscovery', 'backgroundMode']
    for (const row of def.plugins) {
      const config = row.config
      if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
        for (const key of deadKeys) expect(config).not.toHaveProperty(key)
      }
      expect(String(row.name)).not.toContain('/list-agents')
    }
    const delegation = rowById(def, 'delegation')!
    for (const child of delegation.config as RowSpec[]) {
      expect(String(child.name)).not.toContain('/list-agents')
      if (child.config !== null && typeof child.config === 'object' && !Array.isArray(child.config)) {
        for (const key of deadKeys) expect(child.config).not.toHaveProperty(key)
      }
    }
  })
})

describe('技能行（2026-11-10 裁定：类型不再挂技能）', () => {
  it('record.skills 有值也不再挂技能行（有提示词就够）', () => {
    const def = buildWorkerPresetDefinition(workerType())
    expect(rowById(def, 'skill-filesystem')).toBeUndefined()
    expect(rowById(def, 'tool-skill')).toBeUndefined()
  })
})

describe('静态执行者预设（2026-11-12 合并裁定：组合 ≡ buildSupersetPlugins）', () => {
  const ymlPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const doc = parse(readFileSync(ymlPath, 'utf8'), { logLevel: 'silent' }) as unknown

  /** 从 yml 收集执行者预设行的 plugins（顶层是 [ { insert: [...] } ]）。 */
  function staticPresetPlugins(presetId: string): RowSpec[] {
    const documents = Array.isArray(doc) ? doc : [doc]
    for (const document of documents) {
      const inserts = (document as { insert?: unknown[] } | null)?.insert ?? []
      for (const row of inserts) {
        const entry = row as { id?: string; config?: { id?: string; plugins?: RowSpec[] } }
        if (entry.config?.id === presetId) return entry.config.plugins ?? []
      }
    }
    throw new Error(`yml 里找不到预设 ${presetId}`)
  }

  // 退役（Task 2B，轻量协作设计）：以下三条断言旧「执行者静态预设行 + yml ≡
  // buildSupersetPlugins」结构——该结构与动态预设引擎整体退役。新单一静态预设
  // dsh-router/Router（complete 提示词 = collaborationPrompt 单一来源、七条协作工具 +
  // DSH 原生执行/用户提问/项目指令/默认压缩/子代理控制）的断言在
  // tests/collaboration/preset.spec.ts（preset_one_entry）与 tests/bundle.spec.ts。
  // 保留本 describe 里仍有效的内部模块断言（通用 worker 提示词逐字一致）。
  void staticPresetPlugins

  it('通用 worker 的提示词与 prompts/worker.ts 逐字一致（类型缺省提示词取值源，含尾换行）', () => {
    const def = buildWorkerPresetDefinition(builtinGeneralType(0))
    expect((rowById(def, 'persona')!.config as { prefix: string }).prefix).toBe(workerPrompt)
  })
})

describe('旧 id 兼容别名（2026-11-12 合并裁定）', () => {
  it('legacyAliasDefinition：两个旧 id、order 999、名称标注旧会话兼容、组合 ≡ 执行者超集', () => {
    for (const legacyId of LEGACY_EXECUTOR_PRESET_IDS) {
      const def = legacyAliasDefinition(legacyId)
      expect(def.id).toBe(legacyId)
      expect(def.order).toBe(LEGACY_ALIAS_ORDER)
      expect(LEGACY_ALIAS_ORDER).toBe(999)
      expect(def.name).toContain('执行者')
      expect(def.name).toContain('旧会话兼容')
      expect(def.description).toContain('请勿手动选用')
      expect(def.plugins).toEqual(buildSupersetPlugins())
    }
    expect([...LEGACY_EXECUTOR_PRESET_IDS]).toEqual(['dsh-router-supervisor', 'dsh-router-worker'])
  })

  it('legacyAliasDefinition 拒绝未知 id（防手滑注册野别名）', () => {
    expect(() => legacyAliasDefinition('dsh-router-executor')).toThrow('未知旧执行预设')
    expect(() => legacyAliasDefinition('dsh-router-ghost')).toThrow('未知旧执行预设')
  })

  it('syncLegacyAliases：两个旧 id 注册进花名册（校验过、注销器自接线）', async () => {
    const { engine, registry, effect } = engineHarness()
    const outcome = await engine.syncLegacyAliases()
    expect(outcome).toEqual({ registered: [...LEGACY_EXECUTOR_PRESET_IDS], failed: [] })
    for (const legacyId of LEGACY_EXECUTOR_PRESET_IDS) {
      expect(registry.registered.has(legacyId)).toBe(true)
      expect(engine.has(legacyId)).toBe(true)
    }
    expect(effect.calls).toHaveLength(2)
    expect(effect.calls.map((call) => call.label).join(' ')).toContain('dsh-router-supervisor')
  })

  it('注册失败仅告警：逐别名独立兜底，一个失败不挡另一个、不炸调用方', async () => {
    const { engine, registry, warns } = engineHarness((def) => def.id === 'dsh-router-worker')
    const outcome = await engine.syncLegacyAliases()
    expect(outcome).toEqual({ registered: ['dsh-router-supervisor'], failed: ['dsh-router-worker'] })
    expect(registry.registered.has('dsh-router-supervisor')).toBe(true)
    expect(registry.registered.has('dsh-router-worker')).toBe(false)
    expect(warns.some((m) => m.includes('dsh-router-worker') && m.includes('旧会话'))).toBe(true)
  })

  it('校验失败也仅告警（坏行不进花名册，别名缺位不炸装载）', async () => {
    const registry = fakeRegistry()
    const effect = fakeEffect()
    const warns: string[] = []
    const engine = new DynamicPresetEngine({
      presets: registry.face,
      effect: effect.effect,
      validate: async () => ['tool-fs-search: Config 校验失败: 假装缺键'],
      logger: { info: () => {}, warn: (m) => warns.push(m) },
    })
    const outcome = await engine.syncLegacyAliases()
    expect(outcome.registered).toEqual([])
    expect(outcome.failed).toEqual([...LEGACY_EXECUTOR_PRESET_IDS])
    expect(registry.registered.size).toBe(0)
    expect(warns.length).toBe(2)
  })
})

describe('buildRouterPresetDefinition：Router 预设动态化（C5：complete section 会话级覆盖）', () => {
  it('id 仍 dsh-router；persona 行移除——complete 换本包 prompt-section 行（动态读覆盖）', () => {
    const def = buildRouterPresetDefinition()
    expect(def.id).toBe('dsh-router')
    expect(def.order).toBe(10)
    expect(rowById(def, 'router-prompt-section')).toMatchObject({ name: '@goodjin2/dsh-router/prompt-section' })
    expect(rowById(def, 'router-tools')).toMatchObject({ name: '@goodjin2/dsh-router/tools', config: { role: 'router' } })
    expect(rowById(def, 'router-ask-user')).toMatchObject({ name: '@deepseek-ai/dsh-tool-ask-user' })
    expect(rowById(def, 'router-context')).toMatchObject({ name: '@goodjin2/dsh-router/context' })
    expect(rowById(def, 'router-compaction')).toBeDefined()
  })

  it('多 complete 冲突看守（宿主组装期抛 multiple complete）：动态定义零 persona 行、零行级 complete 标记', () => {
    const def = buildRouterPresetDefinition()
    expect(def.plugins.some((row) => row.name === '@deepseek-ai/dsh-persona')).toBe(false)
    for (const row of def.plugins) {
      const config = row.config
      if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
        expect(config, row.id).not.toHaveProperty('complete')
      }
    }
  })

  it('静态兜底定义保留 persona 行 + prompts/router.ts 逐字文本（回退源；prompt-section 行不在兜底里）', () => {
    const def = staticRouterDefinition()
    expect(def.id).toBe('dsh-router')
    expect(def.plugins.map((row) => row.id)).toEqual([
      'router-persona',
      'router-tools',
      'router-ask-user',
      'router-context',
      'router-compaction',
    ])
    expect(rowById(def, 'router-persona')!.config).toMatchObject({ prefix: routerPrompt, complete: true })
    expect(rowById(def, 'router-prompt-section')).toBeUndefined()
  })
})

/* ────────────────────────── 子行校验 ────────────────────────── */

describe('动态定义逐行过 validateRowSpec', () => {
  it('worker/supervisor/router 三定义的全部宿主行过假宿主 schema', async () => {
    const defs = [
      buildWorkerPresetDefinition(workerType()),
      buildWorkerPresetDefinition(workerType({ templateId: 'lead2', name: '主管二', role: 'supervisor', skills: [] })),
      buildRouterPresetDefinition(),
    ]
    for (const def of defs) {
      expect(await validateDefinition(def), def.id).toEqual([])
    }
  })

  it('config-less 行也进校验器（不过包 Config 就是 v1 漏洞）', async () => {
    const seen: string[] = []
    const load: ValidateLoad = async (name) => {
      seen.push(name)
      return FAKE_MODULES[name] ?? {}
    }
    await validateDefinition(buildWorkerPresetDefinition(workerType({ skills: [] })), load)
    expect(seen).toContain('@deepseek-ai/dsh-tool-ask-user') // 无 config 行也被装载校验
    expect(seen).toContain('@deepseek-ai/dsh-tool-bash')
  })

  // 退役（Task 2B，轻量协作设计）：真宿主校验 buildRouterPresetDefinition 的三定义——
  // 其 Router 动态定义仍引用已退役的 @goodjin2/dsh-router/compaction 子路径导出
  // （该导出按 brief 移除），真包解析报 ERR_PACKAGE_PATH_NOT_EXPORTED。动态预设引擎
  // 整体退役，新单一静态预设 dsh-router/Router 的宿主行校验由
  // node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs <候选根> 与
  // tests/collaboration/preset.spec.ts 负责。假宿主 schema 校验（上一用例）仍保留，
  // 它用注入的假模块表，不解析被移除的真包导出。
  it('真宿主校验已退役：动态引擎引用已移除的 ./compaction 导出，改由 check-host-rows 把关', () => {
    expect(true).toBe(true)
  })
})

describe('collectHostRows：组行展开', () => {
  it('组行本身不进清单，子行逐条进（含嵌套 delegation/compaction）', () => {
    const def = buildWorkerPresetDefinition(workerType({ role: 'supervisor', skills: [] }))
    const ids = collectHostRows(def.plugins).map((row) => row.id)
    expect(ids).toContain('tool-subagent-control')
    expect(ids).toContain('tool-subagent')
    expect(ids).toContain('compaction-basic')
    expect(ids).not.toContain('delegation')
    expect(ids).not.toContain('compaction')
  })
})

/* ────────────────────────── 注册生命周期（引擎） ────────────────────────── */

import { DynamicPresetEngine, type AgentPresetsFace } from '../src/host/presets/lifecycle.ts'

/** 记录型假注册表：按 id 记最近定义、注销即删；可编程抛错。 */
function fakeRegistry(throwFor?: (def: PresetDefinition) => boolean) {
  const registered = new Map<string, PresetDefinition>()
  const disposals: string[] = []
  const disposers = new Map<string, () => Promise<void>>()
  const face: AgentPresetsFace = {
    async register(def) {
      if (throwFor?.(def)) throw new Error(`simulated register failure: ${def.id}`)
      if (registered.has(def.id)) throw new Error(`Duplicate agent preset: ${def.id}`)
      registered.set(def.id, def)
      const unregister = async () => {
        if (!registered.has(def.id)) return
        registered.delete(def.id)
        disposals.push(def.id)
      }
      disposers.set(def.id, unregister)
      return unregister
    },
  }
  return { face, registered, disposals, disposers }
}

/** 记录型假 ctx.effect（r4 条件①；v1.5 修正语义：工厂立即执行，返回值才是
 * fiber 销毁时的清理函数——清理写在工厂体里 = 注册即卸载，正是现场根因）。 */
function fakeEffect() {
  const factories: Array<{ label?: string; run(): unknown }> = []
  return {
    calls: factories,
    effect(factory: () => unknown, label?: string) {
      const cleanup = (factory as () => (() => void) | undefined)() // 宿主语义：立即执行工厂
      factories.push({ label, run: () => cleanup?.() }) // run = 销毁时执行清理
      return factory
    },
  }
}

function engineHarness(throwFor?: (def: PresetDefinition) => boolean) {
  const registry = fakeRegistry(throwFor)
  const effect = fakeEffect()
  const warns: string[] = []
  const engine = new DynamicPresetEngine({
    presets: registry.face,
    effect: effect.effect,
    validate: async () => [],
    logger: { info: () => {}, warn: (m) => warns.push(m) },
  })
  return { engine, registry, effect, warns }
}

describe('DynamicPresetEngine：类型注册生命周期', () => {
  it('ensureRegistered：注册进花名册并自接线 ctx.effect（r4 条件①：effect 触发注销器）', async () => {
    const { engine, registry, effect } = engineHarness()
    await engine.ensureRegistered(workerType())
    expect(registry.registered.has('dsh-router-worker-docs-writer')).toBe(true)
    expect(engine.registeredIds()).toContain('dsh-router-worker-docs-writer')
    expect(effect.calls).toHaveLength(1)
    expect(effect.calls[0]!.label).toContain('docs-writer')
    // 注册后预设仍在册（工厂体当场执行不得触发清理——v1.5 现场根因回归钉）
    expect(registry.registered.has('dsh-router-worker-docs-writer')).toBe(true)
    // fiber dispose → 清理函数执行 → 注销器生效
    effect.calls[0]!.run()
    expect(registry.disposals).toContain('dsh-router-worker-docs-writer')
    expect(engine.registeredIds()).not.toContain('dsh-router-worker-docs-writer')
  })

  it('类型更新 → unregister + register 增量同步（新提示词生效）', async () => {
    const { engine, registry } = engineHarness()
    await engine.ensureRegistered(workerType())
    await engine.ensureRegistered(workerType({ systemPrompt: '改过 v2', skills: [] }))
    expect(registry.disposals).toEqual(['dsh-router-worker-docs-writer'])
    expect(registry.registered.size).toBe(1)
    const def = registry.registered.get('dsh-router-worker-docs-writer')!
    expect((def.plugins[0]!.config as { prefix: string }).prefix).toBe('改过 v2')
    expect(def.plugins.some((row) => row.id === 'skill-filesystem')).toBe(false)
  })

  it('builtin 通用 worker 不动态注册（派发解析映射静态执行者预设）', async () => {
    const { engine, registry } = engineHarness()
    await engine.ensureRegistered(builtinGeneralType(0))
    expect(registry.registered.size).toBe(0)
    await engine.syncTypes([builtinGeneralType(0)])
    expect(registry.registered.size).toBe(0)
  })

  it('禁用 = 保留注册只拒派发：syncTypes 不清不在清单里的已注册预设', async () => {
    const { engine, registry } = engineHarness()
    await engine.syncTypes([workerType()])
    await engine.syncTypes([]) // 类型被禁用后不在启用清单 → 注册保留
    expect(registry.registered.has('dsh-router-worker-docs-writer')).toBe(true)
    expect(registry.disposals).toEqual([])
  })

  it('删除 = 注销', async () => {
    const { engine, registry } = engineHarness()
    await engine.syncTypes([workerType()])
    await engine.removeType('docs-writer')
    expect(registry.disposals).toEqual(['dsh-router-worker-docs-writer'])
    expect(registry.registered.size).toBe(0)
  })

  it('坏行拒绝注册：校验不过不进花名册、告警带原因，其他类型照常注册（Review Focus 1）', async () => {
    const registry = fakeRegistry()
    const effect = fakeEffect()
    const warns: string[] = []
    const engine = new DynamicPresetEngine({
      presets: registry.face,
      effect: effect.effect,
      // 假校验器：只对 persona 提示词为「坏」的坏类型报问题
      validate: async (rows) =>
        (rows[0]!.config as { prefix: string }).prefix === '坏' ? ['tool-fs-search: Config 校验失败: 假装缺键'] : [],
      logger: { info: () => {}, warn: (m) => warns.push(m) },
    })
    const outcomes = await engine.syncTypes([
      workerType(),
      workerType({ templateId: 'broken', name: '坏类型', systemPrompt: '坏' }),
    ])
    expect(registry.registered.has('dsh-router-worker-docs-writer')).toBe(true)
    expect(registry.registered.has('dsh-router-worker-broken')).toBe(false)
    expect(outcomes.failed).toEqual(['broken'])
    expect(warns.some((m) => m.includes('broken') && m.includes('假装缺键'))).toBe(true)
  })

  it('register 抛错（任何注册异常）：不炸装载、报 failed、后续类型与 Router 兜底继续', async () => {
    const { engine, registry, warns } = engineHarness((def) => def.id === 'dsh-router-worker-docs-writer')
    const outcomes = await engine.syncTypes([
      workerType(),
      workerType({ templateId: 'other', name: '另一个' }),
    ])
    expect(outcomes.failed).toEqual(['docs-writer'])
    expect(registry.registered.has('dsh-router-worker-other')).toBe(true)
    expect(warns.some((m) => m.includes('docs-writer'))).toBe(true)
  })
})

describe('DynamicPresetEngine：Router 预设动态化与静态兜底', () => {
  it('动态注册成功：定义带 prompt-section 行、无 persona 行（覆盖/默认都由运行时解析，不烘焙）', async () => {
    const { engine, registry } = engineHarness()
    await engine.syncRouter()
    const def = registry.registered.get('dsh-router')!
    expect(def.plugins.some((row) => row.id === 'router-prompt-section')).toBe(true)
    expect(def.plugins.some((row) => row.name === '@deepseek-ai/dsh-persona')).toBe(false)
  })

  it('动态注册失败 → 注册静态兜底定义（persona + routerPrompt 逐字）；兜底也失败 → 只告警不炸', async () => {
    const { engine, registry, warns } = engineHarness((def) => def.plugins.some((row) => row.id === 'router-prompt-section'))
    await engine.syncRouter()
    const def = registry.registered.get('dsh-router')!
    expect(rowById(def, 'router-persona')!.config).toMatchObject({ prefix: routerPrompt, complete: true })
    expect(def.plugins.some((row) => row.id === 'router-prompt-section')).toBe(false)

    const { engine: engine2, registry: registry2, warns: warns2 } = engineHarness(() => true)
    await engine2.syncRouter()
    expect(registry2.registered.size).toBe(0)
    expect(warns2.length).toBeGreaterThan(0)
  })

  it('重复 syncRouter → 同 id 重注册（幂等替换）；签名不带 defaults（默认值改走运行时解析）', async () => {
    const { engine, registry } = engineHarness()
    await engine.syncRouter()
    await engine.syncRouter()
    expect(registry.disposals).toEqual(['dsh-router'])
    expect(registry.registered.size).toBe(1)
    expect(registry.registered.get('dsh-router')!.plugins.some((row) => row.id === 'router-prompt-section')).toBe(true)
  })

  it('校验失败的 Router 动态定义不注册、直接走静态兜底', async () => {
    const registry = fakeRegistry()
    const engine = new DynamicPresetEngine({
      presets: registry.face,
      effect: fakeEffect().effect,
      validate: async () => ['bad row'],
      logger: { info: () => {}, warn: () => {} },
    })
    await engine.syncRouter()
    const def = registry.registered.get('dsh-router')!
    expect(rowById(def, 'router-persona')!.config).toMatchObject({ prefix: routerPrompt, complete: true })
  })
})
