/**
 * 执行者预设合并（2026-11-12 用户裁定）的派发解析与配置收敛测试。
 *
 * 裁定内容：主管执行者与工作执行者两条静态预设合并为单条「执行者」预设
 * （dsh-router-executor，组合 = buildSupersetPlugins 逐字节等价）；
 * supervisorPreset/workerPreset 配置合并为 executorPreset；presetFor/builtin
 * 映射收敛为单值；两模式（cache-priority/minimal-face）解析结果一致。
 *
 * 本文件覆盖：
 * - resolveRootConfig：executorPreset 默认值与旧键迁移回退（executorPreset >
 *   supervisorPreset > workerPreset > 默认）；
 * - root-config schema：单值 volatile 字段（旧键已从 schema 退役）；
 * - 解析矩阵：两模式 × {builtin 类型、自定义类型、未知/禁用/角色不匹配} ×
 *   {supervisor, worker}（resolveDispatchPreset 直测，entry 接线即此函数）；
 * - 桥级兜底：forTemplate 解析不出时两角色同回 executorPreset 单值。
 */

import { describe, expect, it } from 'vitest'

import { Config as rootConfig, resolveRootConfig } from '../src/entry.ts'
import { resolveDispatchPreset, EXECUTOR_PRESET_ID, LEGACY_EXECUTOR_PRESET_IDS } from '../src/host/presets/dynamic.ts'
import { builtinGeneralType, type WorkerTypeRecord } from '../src/host/templates.ts'
import type { RowSpec } from '../src/host/presets/dynamic.ts'
import type { WorkerSpawnMode } from '../src/shared/view-contract.ts'
import { SessionBridge } from '../src/host/bridge/sessions.ts'
import { task } from './helpers/task-builder.ts'
import { TaskLedger } from '../src/host/ledger/store.ts'
import { TaskDocStore } from '../src/host/docs/task-docs.ts'
import type { FsAdapter } from '../src/shared/fs-adapter.ts'

/* ────────────────────────── 配置收敛：executorPreset ────────────────────────── */

describe('配置收敛：supervisorPreset/workerPreset → executorPreset', () => {
  it('缺省 = dsh-router-executor（防御解析；schema 声明面由下一用例看守）', () => {
    expect(resolveRootConfig({}).executorPreset).toBe('dsh-router-executor')
    expect(resolveRootConfig(undefined).executorPreset).toBe('dsh-router-executor')
  })

  it('executorPreset 显式值直通（空串按缺省回默认）', () => {
    expect(resolveRootConfig({ executorPreset: 'my-executor' }).executorPreset).toBe('my-executor')
    expect(resolveRootConfig({ executorPreset: '' }).executorPreset).toBe('dsh-router-executor')
    expect(resolveRootConfig({ executorPreset: '  ' }).executorPreset).toBe('dsh-router-executor')
  })

  it('旧键迁移回退：executorPreset > supervisorPreset > workerPreset > 默认', () => {
    // 用户旧配置显式设过角色预设时不丢（两个旧 id 有兼容别名在册，取到旧值也可解析）
    expect(resolveRootConfig({ supervisorPreset: 'old-sup', workerPreset: 'old-work' }).executorPreset).toBe('old-sup')
    expect(resolveRootConfig({ workerPreset: 'old-work' }).executorPreset).toBe('old-work')
    expect(resolveRootConfig({ executorPreset: 'new-one', supervisorPreset: 'old-sup' }).executorPreset).toBe('new-one')
    // 旧键空串 = 未设置，继续往后回退
    expect(resolveRootConfig({ supervisorPreset: '', workerPreset: 'old-work' }).executorPreset).toBe('old-work')
  })

  it('schema 旧键已退役、新键 volatile（设置面单值）', () => {
    const shape = JSON.stringify(rootConfig)
    expect(shape).toContain('executorPreset')
    expect(shape).not.toContain('supervisorPreset')
    expect(shape).not.toContain('workerPreset')
  })
})

/* ────────────────────────── 派发解析矩阵 ────────────────────────── */

function customType(role: 'supervisor' | 'worker', overrides: Partial<WorkerTypeRecord> = {}): WorkerTypeRecord {
  return {
    templateId: role === 'supervisor' ? 'lead' : 'coder',
    name: role === 'supervisor' ? '主管型' : '编码型',
    description: '',
    role,
    models: [],
    systemPrompt: '',
    skills: [],
    enabled: true,
    origin: 'manual',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as WorkerTypeRecord
}

describe('派发预设解析矩阵（两模式 × builtin/类型 × 两角色；2026-11-12 单值语义）', () => {
  const MODES: WorkerSpawnMode[] = ['cache-priority', 'minimal-face']
  const EXECUTOR = 'dsh-router-executor'

  it('builtin 类型：两模式都解析到 executorPreset（原 supervisor/worker 两条静态行合并）', () => {
    // mode 不参与解析（组合形态由预设本体决定），断言两模式同值
    expect(new Set(MODES).size).toBe(2)
    const builtin = builtinGeneralType(0)
    expect(builtin.origin).toBe('builtin')
    expect(builtin.role).toBe('worker')
    expect(resolveDispatchPreset(builtin, 'worker', EXECUTOR)).toBe(EXECUTOR)
  })

  it('builtin 类型尊重配置值：executorPreset 配了自定义 id 时 builtin 派发跟随', () => {
    expect(resolveDispatchPreset(builtinGeneralType(0), 'worker', 'my-executor')).toBe('my-executor')
  })

  it('自定义类型：角色匹配 → 动态预设 dsh-router-worker-<templateId>（两模式同值）', () => {
    for (const role of ['supervisor', 'worker'] as const) {
      const record = customType(role)
      expect(resolveDispatchPreset(record, role, EXECUTOR)).toBe(`dsh-router-worker-${record.templateId}`)
    }
    expect(resolveDispatchPreset(customType('worker'), 'worker', EXECUTOR)).toBe('dsh-router-worker-coder')
    expect(resolveDispatchPreset(customType('supervisor'), 'supervisor', EXECUTOR)).toBe('dsh-router-worker-lead')
  })

  it('未知/禁用/角色不匹配 → undefined（桥回退 executorPreset 单值，核心拒绝派发）', () => {
    expect(resolveDispatchPreset(undefined, 'worker', EXECUTOR)).toBeUndefined()
    expect(resolveDispatchPreset(customType('worker', { enabled: false }), 'worker', EXECUTOR)).toBeUndefined()
    // 角色不匹配：supervisor 任务配 worker 类型不算可用，交回兜底
    expect(resolveDispatchPreset(customType('worker'), 'supervisor', EXECUTOR)).toBeUndefined()
    expect(resolveDispatchPreset(customType('supervisor'), 'worker', EXECUTOR)).toBeUndefined()
  })
})

/* ────────────────────────── 桥级兜底（SessionBridge.presetFor） ────────────────────────── */

function memoryFs(): FsAdapter {
  const files = new Map<string, string>()
  return {
    async readFile(p) {
      const content = files.get(p)
      if (content === undefined) throw new Error(`文件不存在: ${p}`)
      return content
    },
    async writeFile(p, content) { files.set(p, content) },
    async mkdirp() {},
    async exists(p) { return files.has(p) },
    async readdir() { return [...files.keys()] },
  }
}

class MemoryPersistence {
  file: { schemaVersion: number; tasks: unknown[]; nextTaskNumber: number; questions: unknown[] } | null = null
  async load() { return this.file }
  async save(f: { schemaVersion: number; tasks: unknown[]; nextTaskNumber: number; questions: unknown[] }) {
    this.file = JSON.parse(JSON.stringify(f)) as typeof this.file
  }
}

describe('SessionBridge 兜底：两角色同一条执行者预设', () => {
  async function bridgeFor(role: 'supervisor' | 'worker', executorPreset: string) {
    const record = task({ id: 'T-001', role, status: 'queued' })
    const persistence = new MemoryPersistence()
    persistence.file = { schemaVersion: 1, tasks: [record], nextTaskNumber: 2, questions: [] }
    const ledger = new TaskLedger(persistence as never, () => 1000)
    await ledger.listAll()
    const docs = new TaskDocStore('/tasks', memoryFs())
    await docs.initTask(record, `# 任务书 ${record.id}`)
    const created: { agentPreset?: string }[] = []
    const bridge = new SessionBridge({
      ledger,
      docsFor: () => docs,
      host: {
        async create(opts) { created.push(opts as { agentPreset?: string }); return 'session-1' },
        async prompt() { return { accepted: true } },
        onStatus() {},
        async rename() {},
      },
      executorPreset,
      workerInstructions: () => '指引',
      signal: new AbortController().signal,
    })
    await bridge.dispatchTask('T-001')
    return created
  }

  it('无类型的 supervisor/worker 任务都落到 executorPreset 单值', async () => {
    expect((await bridgeFor('worker', 'dsh-router-executor'))[0]).toMatchObject({ agentPreset: 'dsh-router-executor' })
    expect((await bridgeFor('supervisor', 'dsh-router-executor'))[0]).toMatchObject({ agentPreset: 'dsh-router-executor' })
    expect((await bridgeFor('worker', 'custom-executor'))[0]).toMatchObject({ agentPreset: 'custom-executor' })
  })
})

/* ────────────────────────── 常量一致性 ────────────────────────── */

describe('预设 id 常量与 yml/别名的一致性', () => {
  it('EXECUTOR_PRESET_ID 与 root-config 默认值一致；旧 id 常量恰好两条', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { parse } = await import('yaml')
    const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
    const doc = parse(patch, { logLevel: 'silent' }) as unknown
    const presets = (Array.isArray(doc) ? doc : [doc]).flatMap((d: { insert?: unknown[] }) => d.insert ?? [])
      .filter((row) => (row as { name?: string }).name === '@deepseek-ai/dsh-agent-preset')
      .map((row) => (row as { config: { id: string; plugins: RowSpec[] } }).config.id)
    expect(presets).toEqual([EXECUTOR_PRESET_ID])
    expect(EXECUTOR_PRESET_ID).toBe('dsh-router-executor')
    expect([...LEGACY_EXECUTOR_PRESET_IDS]).toEqual(['dsh-router-supervisor', 'dsh-router-worker'])
    // yml 里旧 id 不再以静态行存在（兼容别名走启动动态注册）
    expect(patch).not.toMatch(/id:\s*dsh-router-supervisor\b/)
    expect(patch).not.toMatch(/id:\s*dsh-router-worker\b/)
  })
})
