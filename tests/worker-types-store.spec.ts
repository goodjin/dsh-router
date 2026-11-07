/**
 * WorkerTypeStore 测试（v1.1 计划 Task C1 Step 1）。
 *
 * worker 类型是 v1.1 的一等实体（规格 §5）：持久化 JSON（dataDir/worker-types.json）、
 * 内置「通用 worker」受保护（固定、不可删、不可禁用——保证任何情况下可派发）、
 * 首启把 v1 Config 模板种子化导入一次后标记完成。CRUD 全走「先改内存校验、
 * 一次落盘、失败回滚」的账本纪律。
 */

import { describe, expect, it } from 'vitest'

import { LedgerError } from '../src/host/ledger/errors.ts'
import {
  BUILTIN_GENERAL_ID,
  WorkerTypeStore,
  type WorkerTypeRecord,
} from '../src/host/templates.ts'
import type { WorkerTemplate } from '../src/shared/view-contract.ts'
import { makeMemFs } from './helpers/mem-fs.ts'

const FILE = '/data/worker-types.json'

/** v1 Config 模板样例（首启种子化导入的输入）。 */
const V1_TEMPLATES: WorkerTemplate[] = [
  { templateId: 'coder', name: '编码', description: '写代码的执行者', role: 'worker' },
  { templateId: 'lead', name: '主管', description: '可拆子任务的主管型', role: 'supervisor' },
]

let clock = 1000
function makeStore(seedTemplates: WorkerTemplate[] = V1_TEMPLATES): { store: WorkerTypeStore; files: Map<string, string> } {
  clock = 1000
  const { fs, files } = makeMemFs()
  const store = new WorkerTypeStore(fs, FILE, { now: () => ++clock, seedTemplates })
  return { store, files }
}

function errorCode(error: unknown): string {
  expect(error).toBeInstanceOf(LedgerError)
  return (error as LedgerError).code
}

async function loadFile(files: Map<string, string>): Promise<{ schemaVersion: number; legacyImported: boolean; types: WorkerTypeRecord[] }> {
  return JSON.parse(files.get(FILE)!) as { schemaVersion: number; legacyImported: boolean; types: WorkerTypeRecord[] }
}

describe('WorkerTypeStore：首启种子化', () => {
  it('首次装载：内置通用 worker 在场，v1 Config 模板导入为 user 类型并标记 legacyImported', async () => {
    const { store, files } = makeStore()
    const all = await store.list()
    const general = all.find((t) => t.templateId === BUILTIN_GENERAL_ID)
    expect(general).toBeDefined()
    expect(general!.origin).toBe('builtin')
    expect(general!.enabled).toBe(true)
    expect(general!.role).toBe('worker')
    expect(general!.systemPrompt.length).toBeGreaterThan(0) // 等价静态 worker 组合的提示词

    const coder = await store.get('coder')
    expect(coder).toBeDefined()
    expect(coder!.origin).toBe('user')
    expect(coder!.enabled).toBe(true)
    expect(coder!.name).toBe('编码')
    expect(coder!.systemPrompt.length).toBeGreaterThan(0) // worker 角色种子默认提示词
    const lead = await store.get('lead')
    expect(lead!.role).toBe('supervisor')
    expect(lead!.systemPrompt.length).toBeGreaterThan(0) // supervisor 角色种子默认提示词

    const file = await loadFile(files)
    expect(file.legacyImported).toBe(true)
    expect(file.schemaVersion).toBe(1)
  })

  it('二次启动不重复导入：文件存在且 legacyImported 后，改种子清单不再进新类型', async () => {
    const first = makeStore()
    await first.store.list()
    const { fs, files } = makeMemFs()
    // 同一份已导入文件 + 不同的种子清单 → 不再导入
    for (const [key, value] of first.files) files.set(key, value)
    const second = new WorkerTypeStore(fs, FILE, {
      now: () => ++clock,
      seedTemplates: [{ templateId: 'newcomer', name: '新类型', description: '', role: 'worker' }],
    })
    const all = await second.list()
    expect(all.some((t) => t.templateId === 'newcomer')).toBe(false)
    expect(all.some((t) => t.templateId === 'coder')).toBe(true)
  })
})

describe('WorkerTypeStore：CRUD', () => {
  it('create：生成 templateId、默认值齐全、落盘', async () => {
    const { store, files } = makeStore()
    const created = await store.create({ name: '文档写手', description: '写文档', models: ['deepseek-official/deepseek-flash'] })
    expect(created.templateId).toBe('type')
    expect(created.origin).toBe('user')
    expect(created.enabled).toBe(true)
    expect(created.models).toEqual(['deepseek-official/deepseek-flash'])
    expect(created.skills).toEqual([])
    expect(created.createdAt).toBe(created.updatedAt)
    const file = await loadFile(files)
    expect(file.types.some((t) => t.templateId === created.templateId)).toBe(true)
  })

  it('create：重名拒绝；id 撞了自动加序号', async () => {
    const { store } = makeStore()
    const first = await store.create({ name: '写手' })
    await expect(store.create({ name: '写手' })).rejects.toSatisfy((e: unknown) => errorCode(e) === 'template-exists')
    expect(first.templateId).toBe('type')
  })

  it('create：名字为空拒绝', async () => {
    const { store } = makeStore()
    await expect(store.create({ name: '  ' })).rejects.toSatisfy((e: unknown) => errorCode(e) === 'invalid-input')
  })

  it('update：只改给出的字段并升 updatedAt；未知 id 报 template-not-found', async () => {
    const { store } = makeStore()
    await store.list()
    const before = (await store.get('coder'))!
    const updated = await store.update('coder', { description: '改过的描述', models: ['p/m'] })
    expect(updated.description).toBe('改过的描述')
    expect(updated.models).toEqual(['p/m'])
    expect(updated.name).toBe(before.name)
    expect(updated.updatedAt).toBeGreaterThan(before.updatedAt)
    await expect(store.update('ghost', { description: 'x' })).rejects.toSatisfy((e: unknown) => errorCode(e) === 'template-not-found')
  })

  it('setEnabled：禁用后保留记录；builtin 禁用被拒（保证任何情况下可派发）', async () => {
    const { store } = makeStore()
    await store.list()
    const disabled = await store.setEnabled('coder', false)
    expect(disabled.enabled).toBe(false)
    expect((await store.get('coder'))!.enabled).toBe(false)
    expect(store.enabledTemplates().some((t) => t.templateId === 'coder')).toBe(false)
    await expect(store.setEnabled(BUILTIN_GENERAL_ID, false)).rejects.toSatisfy((e: unknown) => errorCode(e) === 'builtin-protected')
  })

  it('remove：删得掉、落盘；builtin 拒删；未知 id 拒', async () => {
    const { store, files } = makeStore()
    const created = await store.create({ name: '临时工' })
    const removed = await store.remove(created.templateId)
    expect(removed.templateId).toBe(created.templateId)
    expect(await store.get(created.templateId)).toBeUndefined()
    expect((await loadFile(files)).types.some((t) => t.templateId === created.templateId)).toBe(false)
    await expect(store.remove(BUILTIN_GENERAL_ID)).rejects.toSatisfy((e: unknown) => errorCode(e) === 'builtin-protected')
    await expect(store.remove('ghost')).rejects.toSatisfy((e: unknown) => errorCode(e) === 'template-not-found')
  })

  it('update/setEnabled 对 builtin 的只读保护：改字段被拒', async () => {
    const { store } = makeStore()
    await store.list()
    await expect(store.update(BUILTIN_GENERAL_ID, { description: 'x' })).rejects.toSatisfy((e: unknown) => errorCode(e) === 'builtin-protected')
  })
})

describe('WorkerTypeStore：持久化与投影', () => {
  it('往返：新实例从同一文件读回全部类型', async () => {
    const first = makeStore()
    const created = await first.store.create({ name: '跨实例', role: 'supervisor' })
    await first.store.setEnabled('coder', false)
    const { fs, files } = makeMemFs()
    for (const [key, value] of first.files) files.set(key, value)
    const second = new WorkerTypeStore(fs, FILE, { now: () => ++clock })
    const all = await second.list()
    expect(all.some((t) => t.templateId === created.templateId && t.role === 'supervisor')).toBe(true)
    expect((await second.get('coder'))!.enabled).toBe(false)
    expect((await second.get(BUILTIN_GENERAL_ID))!.origin).toBe('builtin')
  })

  it('enabledTemplates()：同步投影启用类型（含 builtin），禁用类型不进清单', async () => {
    const { store } = makeStore()
    await store.list()
    await store.setEnabled('coder', false)
    const enabled = store.enabledTemplates()
    expect(enabled.some((t) => t.templateId === BUILTIN_GENERAL_ID)).toBe(true)
    expect(enabled.some((t) => t.templateId === 'lead')).toBe(true)
    expect(enabled.some((t) => t.templateId === 'coder')).toBe(false)
    for (const entry of enabled) {
      expect(Object.keys(entry).sort()).toEqual(['description', 'name', 'role', 'templateId'])
    }
  })

  it('summaries()：全类型投影带 enabled/origin（管理界面与状态投影用）', async () => {
    const { store } = makeStore()
    await store.list()
    await store.setEnabled('coder', false)
    const summaries = store.summaries()
    const coder = summaries.find((t) => t.templateId === 'coder')!
    expect(coder.enabled).toBe(false)
    expect(coder.origin).toBe('user')
    expect(summaries.find((t) => t.templateId === BUILTIN_GENERAL_ID)!.origin).toBe('builtin')
  })

  it('落盘失败回滚：writeFile 抛错时内存状态不变并报 persistence-failed', async () => {
    const { fs } = makeMemFs()
    let fail = false
    const store = new WorkerTypeStore(
      {
        ...fs,
        async writeFile(p, content) {
          if (fail) throw new Error('disk full')
          return fs.writeFile(p, content)
        },
      },
      FILE,
      { now: () => ++clock, seedTemplates: [] },
    )
    await store.list()
    fail = true
    await expect(store.create({ name: '会失败' })).rejects.toSatisfy((e: unknown) => errorCode(e) === 'persistence-failed')
    fail = false
    const all = await store.list()
    expect(all.some((t) => t.name === '会失败')).toBe(false)
  })
})

/* ────────────────────────── RouterDefaultsStore ────────────────────────── */

import { RouterDefaultsStore } from '../src/host/templates.ts'
import { routerPrompt } from '../src/host/prompts/router.ts'

const DEFAULTS_FILE = '/data/router-defaults.json'

describe('RouterDefaultsStore：Router 默认值（规格 §6）', () => {
  it('缺省值：默认提示词 = prompts/router.ts（与静态兜底同源），模型为空（不钉）', async () => {
    const { fs } = makeMemFs()
    const store = new RouterDefaultsStore(fs, DEFAULTS_FILE)
    const defaults = await store.get()
    expect(defaults.routerSystemPrompt).toBe(routerPrompt)
    expect(defaults.routerModel).toBe('')
  })

  it('set 落盘并读回；get 缺席字段回缺省（文件被手改坏时防御）', async () => {
    const first = makeMemFs()
    const store = new RouterDefaultsStore(first.fs, DEFAULTS_FILE)
    await store.set({ routerSystemPrompt: '自定义提示词', routerModel: 'p/m' })
    expect(JSON.parse(first.files.get(DEFAULTS_FILE)!)).toMatchObject({ schemaVersion: 1, routerSystemPrompt: '自定义提示词', routerModel: 'p/m' })
    const second = makeMemFs()
    for (const [key, value] of first.files) second.files.set(key, value)
    const reloaded = new RouterDefaultsStore(second.fs, DEFAULTS_FILE)
    expect(await reloaded.get()).toEqual({ routerSystemPrompt: '自定义提示词', routerModel: 'p/m' })
  })

  it('损坏文件回缺省（不炸装载）', async () => {
    const { fs, files } = makeMemFs()
    files.set(DEFAULTS_FILE, '{ not json')
    const store = new RouterDefaultsStore(fs, DEFAULTS_FILE)
    expect((await store.get()).routerSystemPrompt).toBe(routerPrompt)
  })
})
