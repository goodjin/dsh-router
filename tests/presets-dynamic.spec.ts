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
  buildWorkerPresetDefinition,
  collectHostRows,
  dynamicPresetId,
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

const SKILL_DIRS = ['/plugins/dsh-superpowers/preset/skills']

function rowById(def: PresetDefinition, id: string): RowSpec | undefined {
  return def.plugins.find((row) => row.id === id)
}

/* ────────────────────────── 定义组合 ────────────────────────── */

describe('buildWorkerPresetDefinition：worker 角色组合', () => {
  const def = buildWorkerPresetDefinition(workerType(), { customSkillDirs: SKILL_DIRS })

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

  it('技能行照 r4 §6 样板（skill-filesystem customSkillDirs + tool-skill，无 realm）', () => {
    expect(rowById(def, 'skill-filesystem')).toMatchObject({
      name: '@deepseek-ai/dsh-skill-filesystem',
      config: { customSkillDirs: SKILL_DIRS },
    })
    expect(rowById(def, 'tool-skill')).toMatchObject({ name: '@deepseek-ai/dsh-tool-skill' })
  })

  it('压缩组在场且形状同静态（isolate + 三子行）', () => {
    const compaction = rowById(def, 'compaction')
    expect(compaction).toBeDefined()
    expect(compaction!.group).toBe(true)
    expect(compaction!.isolate).toEqual({ compaction: true, toolResultPruner: true })
    const children = compaction!.config as RowSpec[]
    expect(children.map((row) => row.id)).toEqual(['compaction-basic', 'command-compact', 'tool-result-pruner'])
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

describe('技能行挂载条件', () => {
  it('类型无技能 → 不挂技能行', () => {
    const def = buildWorkerPresetDefinition(workerType({ skills: [] }), { customSkillDirs: SKILL_DIRS })
    expect(rowById(def, 'skill-filesystem')).toBeUndefined()
    expect(rowById(def, 'tool-skill')).toBeUndefined()
  })

  it('有技能但解析不出目录 → 不挂技能行（不注册坏行）', () => {
    const def = buildWorkerPresetDefinition(workerType())
    expect(rowById(def, 'skill-filesystem')).toBeUndefined()
  })
})

describe('内置通用 worker：等价修复后的静态 worker 组合', () => {
  const ymlPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const doc = parse(readFileSync(ymlPath, 'utf8'), { logLevel: 'silent' }) as unknown

  /** 从 yml 收集预设行的 plugins（顶层是 [ { insert: [...] } ]）。 */
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

  it('动态生成的通用 worker 组合 ≡ 静态 yml worker 预设（逐行 name/config）', () => {
    const def = buildWorkerPresetDefinition(builtinGeneralType(0))
    const staticPlugins = staticPresetPlugins('dsh-router-worker')
    // 行 id 约定不同（静态带 worker- 前缀、动态统一无前缀）：剥前缀后逐行比对
    // name/config/结构。yml 的 `|-` 块标量剥掉末尾换行（bundle.spec 的原文还原
    // 会补回），person a 前缀两侧各剥一个尾换行再比；disabled 单独断言。
    const normalize = (rows: RowSpec[]): RowSpec[] =>
      rows.map((row) => {
        const clone: RowSpec = { ...row, id: row.id.replace(/^worker-/, '') }
        delete clone.disabled
        const config = clone.config
        if (config !== null && typeof config === 'object' && !Array.isArray(config) && typeof (config as { prefix?: unknown }).prefix === 'string') {
          clone.config = { ...(config as Record<string, unknown>), prefix: (config as { prefix: string }).prefix.replace(/\n$/, '') }
        }
        return clone
      })
    expect(normalize(def.plugins)).toEqual(normalize(staticPlugins))
  })

  it('通用 worker 的提示词与 prompts/worker.ts 逐字一致（含尾换行）', () => {
    const def = buildWorkerPresetDefinition(builtinGeneralType(0))
    expect((rowById(def, 'persona')!.config as { prefix: string }).prefix).toBe(workerPrompt)
  })

  it('bash 行禁用语义一致：yml !!js 表达式 ⇄ 动态布尔', () => {
    const staticBash = staticPresetPlugins('dsh-router-worker').find((row) => row.id === 'worker-tool-bash')
    const dynamicBash = buildWorkerPresetDefinition(builtinGeneralType(0)).plugins.find((row) => row.id === 'tool-bash')
    expect(String(staticBash?.disabled)).toContain('process.platform')
    expect(dynamicBash?.disabled).toBe(process.platform === 'win32')
  })
})

describe('buildRouterPresetDefinition：Router 预设动态化', () => {
  it('id 仍 dsh-router；默认提示词来自 defaults；组合含 router 工具/上下文/压缩组', () => {
    const def = buildRouterPresetDefinition({ routerSystemPrompt: '自定义 Router 提示词' })
    expect(def.id).toBe('dsh-router')
    expect(def.order).toBe(10)
    expect(rowById(def, 'router-persona')).toMatchObject({
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: '自定义 Router 提示词', complete: true },
    })
    expect(rowById(def, 'router-tools')).toMatchObject({ name: '@goodjin2/dsh-router/tools', config: { role: 'router' } })
    expect(rowById(def, 'router-ask-user')).toMatchObject({ name: '@deepseek-ai/dsh-tool-ask-user' })
    expect(rowById(def, 'router-context')).toMatchObject({ name: '@goodjin2/dsh-router/context' })
    expect(rowById(def, 'router-compaction')).toBeDefined()
  })

  it('静态兜底定义 ≡ 旧静态 yml 行：提示词与 prompts/router.ts 逐字同步、行序不变', () => {
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
  })
})

/* ────────────────────────── 子行校验 ────────────────────────── */

describe('动态定义逐行过 validateRowSpec', () => {
  it('worker（含技能）/supervisor/router 三定义的全部宿主行过假宿主 schema', async () => {
    const defs = [
      buildWorkerPresetDefinition(workerType(), { customSkillDirs: SKILL_DIRS }),
      buildWorkerPresetDefinition(workerType({ templateId: 'lead2', name: '主管二', role: 'supervisor', skills: [] })),
      buildRouterPresetDefinition({ routerSystemPrompt: 'x' }),
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

  it('真宿主（CLI 安装在场时）：三定义全部行过真包 Config', async () => {
    const cliBase = globSync(join(homedir(), '.local/share/node-*/lib/node_modules/@deepseek-ai/dsh/package.json'))
      .find((p) => existsSync(p))
    if (cliBase === undefined) {
      expect(true).toBe(true) // 本机无 CLI 宿主安装：跳过（双宿主门禁另有 check-subrows）
      return
    }
    const { makeHostLoader } = await import('../src/host/presets/validate-row.ts')
    const load = makeHostLoader({ base: cliBase })
    const defs = [
      buildWorkerPresetDefinition(workerType(), { customSkillDirs: SKILL_DIRS }),
      buildWorkerPresetDefinition(workerType({ templateId: 'lead2', name: '主管二', role: 'supervisor', skills: [] })),
      buildRouterPresetDefinition({ routerSystemPrompt: 'x' }),
    ]
    for (const def of defs) {
      expect(await validateDefinition(def, load), `${def.id} @ ${cliBase}`).toEqual([])
    }
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

/** 记录型假 ctx.effect（r4 条件①：注销器必须自接线）。 */
function fakeEffect() {
  const factories: Array<{ label?: string; run(): unknown }> = []
  return {
    calls: factories,
    effect(factory: () => unknown, label?: string) {
      factories.push({ label, run: factory })
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
    // effect 工厂被宿主在行 fiber dispose 时调用 → 注销器执行
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

  it('builtin 通用 worker 不动态注册（映射静态 dsh-router-worker）', async () => {
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
  it('动态注册成功：默认提示词来自 defaults', async () => {
    const { engine, registry } = engineHarness()
    await engine.syncRouter({ routerSystemPrompt: '动态提示词' })
    const def = registry.registered.get('dsh-router')!
    expect((def.plugins[0]!.config as { prefix: string }).prefix).toBe('动态提示词')
  })

  it('动态注册失败 → 注册静态兜底定义（routerPrompt 逐字）；兜底也失败 → 只告警不炸', async () => {
    const { engine, registry, warns } = engineHarness((def) => (def.plugins[0]!.config as { prefix: string }).prefix === '动态提示词')
    await engine.syncRouter({ routerSystemPrompt: '动态提示词' })
    const def = registry.registered.get('dsh-router')!
    expect((def.plugins[0]!.config as { prefix: string }).prefix).toBe(routerPrompt)

    const { engine: engine2, registry: registry2, warns: warns2 } = engineHarness(() => true)
    await engine2.syncRouter({ routerSystemPrompt: '动态提示词' })
    expect(registry2.registered.size).toBe(0)
    expect(warns2.length).toBeGreaterThan(0)
  })

  it('defaults 变更 → unregister + register（Router 重注册同 id）', async () => {
    const { engine, registry } = engineHarness()
    await engine.syncRouter({ routerSystemPrompt: 'v1' })
    await engine.syncRouter({ routerSystemPrompt: 'v2' })
    expect(registry.disposals).toEqual(['dsh-router'])
    expect(registry.registered.size).toBe(1)
    expect((registry.registered.get('dsh-router')!.plugins[0]!.config as { prefix: string }).prefix).toBe('v2')
  })

  it('校验失败的 Router 动态定义不注册、直接走静态兜底', async () => {
    const registry = fakeRegistry()
    const engine = new DynamicPresetEngine({
      presets: registry.face,
      effect: fakeEffect().effect,
      validate: async () => ['bad row'],
      logger: { info: () => {}, warn: () => {} },
    })
    await engine.syncRouter({ routerSystemPrompt: '动态提示词' })
    const def = registry.registered.get('dsh-router')!
    expect((def.plugins[0]!.config as { prefix: string }).prefix).toBe(routerPrompt)
  })
})
