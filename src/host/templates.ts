/**
 * Worker 类型存储（v1.1 计划 Task C1：templates.ts 由「内置模板常量」改造为
 * 「worker 类型的一等实体存储」，规格 §5/§6）。
 *
 * - 持久化 dataDir/worker-types.json，经 FsAdapter 注入（领域零 node 依赖）；
 * - 内置「通用 worker」（origin builtin）固定：不可删、不可改、不可禁用——它
 *   映射静态 worker 预设（修复后），保证动态注册引擎任何情况下失效都可派发；
 * - 首启把 v1 Config 模板（volatile Settings 的 templates 数组）种子化导入为
 *   user 类型后标记 legacyImported，之后不再导入（升级只发生一次）；
 * - 写路径照账本纪律：先改内存校验、一次落盘、失败回滚抛 persistence-failed。
 *
 * 兼容保留：BUILTIN_TEMPLATES（v1 Config schema 缺省值）继续导出，root-config
 * 与 entry 的防御性解析仍引用它；种子化完成后 v1 模板通道即退役（规格 §6）。
 */

import { LedgerError } from './ledger/errors.ts'
import { workerPrompt } from './prompts/worker.ts'
import { supervisorPrompt } from './prompts/supervisor.ts'
import type { FsAdapter } from '../shared/fs-adapter.ts'
import type { WorkerTemplate, WorkerTypeRecord, WorkerTypeSummary } from '../shared/view-contract.ts'

export type { WorkerTypeRecord } from '../shared/view-contract.ts'

/** v1 Config 模板缺省值（种子化输入的兜底；worker-types.json 建立后退役）。 */
export const BUILTIN_TEMPLATES: WorkerTemplate[] = [
  { templateId: 'coder', name: '编码', description: '在仓库里写代码、跑测试的执行者', role: 'worker' },
  { templateId: 'researcher', name: '调研', description: '查资料、读代码、出结论文档的执行者', role: 'worker' },
  { templateId: 'reviewer', name: '审查', description: '审查交付物与验收依据的执行者', role: 'worker' },
  { templateId: 'lead', name: '主管', description: '可继续拆分子任务的主管型', role: 'supervisor' },
]

/** 内置「通用 worker」的 templateId（固定；派发预设映射静态 dsh-router-worker）。 */
export const BUILTIN_GENERAL_ID = 'general'

/** 内置通用 worker 记录（等价修复后的静态 worker 组合：提示词即静态 worker persona）。 */
export function builtinGeneralType(now: number): WorkerTypeRecord {
  return {
    templateId: BUILTIN_GENERAL_ID,
    name: '通用 worker',
    description: '只执行单个任务的工作型执行者（内置，等价静态 worker 预设）',
    role: 'worker',
    models: [],
    systemPrompt: workerPrompt,
    skills: [],
    enabled: true,
    origin: 'builtin',
    createdAt: now,
    updatedAt: now,
  }
}

/** 落盘形状。 */
export interface WorkerTypeFile {
  schemaVersion: 1
  /** v1 Config 模板种子化导入是否已完成（只发生一次）。 */
  legacyImported: boolean
  types: WorkerTypeRecord[]
}

/** create 输入（name 必填；其余字段有缺省）。 */
export interface WorkerTypeCreateInput {
  name: string
  description?: string
  role?: 'supervisor' | 'worker'
  models?: string[]
  systemPrompt?: string
  skills?: string[]
  enabled?: boolean
  origin?: 'user' | 'router'
}

/** update 补丁（只改给出的字段；builtin 整体只读）。 */
export interface WorkerTypePatch {
  name?: string
  description?: string
  models?: string[]
  systemPrompt?: string
  skills?: string[]
}

export interface WorkerTypeStoreOptions {
  now?: () => number
  /** 首启种子化：v1 Config 模板（缺省 BUILTIN_TEMPLATES）。 */
  seedTemplates?: WorkerTemplate[]
}

/** 名字 → templateId 基名：ASCII 字母数字转小写连 slug，其余（中文等）回退 type。 */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'type' : slug
}

/** 按角色给种子/缺省类型的默认系统提示词（等价 v1 静态预设 persona）。 */
export function defaultPromptForRole(role: 'supervisor' | 'worker'): string {
  return role === 'supervisor' ? supervisorPrompt : workerPrompt
}

export class WorkerTypeStore {
  private fs: FsAdapter
  private file: string
  private now: () => number
  private seedTemplates: WorkerTemplate[]
  private rows: WorkerTypeRecord[] = []
  private legacyImported = false
  private loaded = false

  constructor(fs: FsAdapter, file: string, options: WorkerTypeStoreOptions = {}) {
    this.fs = fs
    this.file = file
    this.now = options.now ?? Date.now
    this.seedTemplates = options.seedTemplates ?? BUILTIN_TEMPLATES
  }

  /** 装载（幂等）：文件缺席或损坏 → 首启种子化（内置 + v1 模板导入）。 */
  async load(): Promise<void> {
    if (this.loaded) return
    let file: WorkerTypeFile | null = null
    try {
      file = JSON.parse(await this.fs.readFile(this.file)) as WorkerTypeFile
    } catch {
      file = null
    }
    if (file !== null && Array.isArray(file.types)) {
      this.rows = file.types.filter(
        (row): row is WorkerTypeRecord =>
          row !== null && typeof row === 'object' && typeof row.templateId === 'string' && row.templateId !== '',
      )
      this.legacyImported = file.legacyImported === true
    }
    if (!this.rows.some((row) => row.templateId === BUILTIN_GENERAL_ID)) {
      // 内置通用 worker 永远在场（文件损坏重建时也恢复）
      this.rows.unshift(builtinGeneralType(this.now()))
    }
    if (!this.legacyImported) {
      this.importLegacy()
      this.legacyImported = true
    }
    this.loaded = true
    await this.save()
  }

  /** v1 Config 模板 → user 类型（一次；同名跳过，提示词按角色补默认）。 */
  private importLegacy(): void {
    const existingNames = new Set(this.rows.map((row) => row.name))
    for (const template of this.seedTemplates) {
      if (
        template === null || typeof template !== 'object'
        || typeof template.templateId !== 'string' || template.templateId === ''
        || typeof template.name !== 'string' || template.name === ''
        || (template.role !== 'supervisor' && template.role !== 'worker')
        || this.rows.some((row) => row.templateId === template.templateId)
        || existingNames.has(template.name)
      ) {
        continue
      }
      const at = this.now()
      existingNames.add(template.name)
      this.rows.push({
        templateId: template.templateId,
        name: template.name,
        description: typeof template.description === 'string' ? template.description : '',
        role: template.role,
        models: [],
        systemPrompt: defaultPromptForRole(template.role),
        skills: [],
        enabled: true,
        origin: 'user',
        createdAt: at,
        updatedAt: at,
      })
    }
  }

  private currentFile(): WorkerTypeFile {
    return { schemaVersion: 1, legacyImported: this.legacyImported, types: structuredClone(this.rows) }
  }

  /** 写通道：备份 → 变更 → save → 失败回滚（账本纪律）。 */
  private async commit<T>(mutate: () => T): Promise<T> {
    await this.load()
    const backup = structuredClone(this.rows)
    const backupLegacy = this.legacyImported
    const result = mutate()
    try {
      await this.save()
    } catch (cause) {
      this.rows = backup
      this.legacyImported = backupLegacy
      throw new LedgerError('persistence-failed', `worker 类型保存失败，内存已回滚: ${String(cause)}`, { cause })
    }
    return result
  }

  private async save(): Promise<void> {
    const parent = this.file.slice(0, this.file.lastIndexOf('/')) || '/'
    await this.fs.mkdirp(parent)
    await this.fs.writeFile(this.file, JSON.stringify(this.currentFile(), null, 2))
  }

  /** 全部类型（含禁用，插入序）。 */
  async list(): Promise<WorkerTypeRecord[]> {
    await this.load()
    return structuredClone(this.rows)
  }

  async get(templateId: string): Promise<WorkerTypeRecord | undefined> {
    await this.load()
    const found = this.rows.find((row) => row.templateId === templateId)
    return found !== undefined ? structuredClone(found) : undefined
  }

  async create(input: WorkerTypeCreateInput): Promise<WorkerTypeRecord> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name === '') throw new LedgerError('invalid-input', 'worker 类型名不能为空')
    const role = input.role ?? 'worker'
    return this.commit(() => {
      if (this.rows.some((row) => row.name === name)) {
        throw new LedgerError('template-exists', `同名 worker 类型已存在: ${name}`)
      }
      const base = slugify(name)
      let templateId = base
      for (let n = 2; this.rows.some((row) => row.templateId === templateId); n += 1) {
        templateId = `${base}-${n}`
      }
      const at = this.now()
      const record: WorkerTypeRecord = {
        templateId,
        name,
        description: input.description ?? '',
        role,
        models: [...(input.models ?? [])],
        systemPrompt: input.systemPrompt ?? defaultPromptForRole(role),
        skills: [...(input.skills ?? [])],
        enabled: input.enabled ?? true,
        origin: input.origin ?? 'user',
        createdAt: at,
        updatedAt: at,
      }
      this.rows.push(record)
      return structuredClone(record)
    })
  }

  async update(templateId: string, patch: WorkerTypePatch): Promise<WorkerTypeRecord> {
    return this.commit(() => {
      const record = this.rows.find((row) => row.templateId === templateId)
      if (record === undefined) throw new LedgerError('template-not-found', `worker 类型不存在: ${templateId}`)
      if (record.origin === 'builtin') {
        throw new LedgerError('builtin-protected', `内置类型 ${templateId} 固定不可改`)
      }
      if (patch.name !== undefined) {
        const name = patch.name.trim()
        if (name === '') throw new LedgerError('invalid-input', 'worker 类型名不能为空')
        if (this.rows.some((row) => row.templateId !== templateId && row.name === name)) {
          throw new LedgerError('template-exists', `同名 worker 类型已存在: ${name}`)
        }
        record.name = name
      }
      if (patch.description !== undefined) record.description = patch.description
      if (patch.models !== undefined) record.models = [...patch.models]
      if (patch.systemPrompt !== undefined) record.systemPrompt = patch.systemPrompt
      if (patch.skills !== undefined) record.skills = [...patch.skills]
      record.updatedAt = this.now()
      return structuredClone(record)
    })
  }

  async setEnabled(templateId: string, enabled: boolean): Promise<WorkerTypeRecord> {
    return this.commit(() => {
      const record = this.rows.find((row) => row.templateId === templateId)
      if (record === undefined) throw new LedgerError('template-not-found', `worker 类型不存在: ${templateId}`)
      if (record.origin === 'builtin' && !enabled) {
        throw new LedgerError('builtin-protected', '内置通用 worker 不可禁用（保证任何情况下可派发）')
      }
      record.enabled = enabled
      record.updatedAt = this.now()
      return structuredClone(record)
    })
  }

  /** 删除（builtin 拒删；删除后动态预设由引擎注销——已关闭会话需重建同名类型才可重开）。 */
  async remove(templateId: string): Promise<WorkerTypeRecord> {
    return this.commit(() => {
      const index = this.rows.findIndex((row) => row.templateId === templateId)
      if (index < 0) throw new LedgerError('template-not-found', `worker 类型不存在: ${templateId}`)
      if (this.rows[index]!.origin === 'builtin') {
        throw new LedgerError('builtin-protected', `内置类型 ${templateId} 不可删除`)
      }
      const [removed] = this.rows.splice(index, 1)
      return structuredClone(removed!)
    })
  }

  /** 启用类型的同步投影（dispatch 描述与 templateId 校验用；load 后可用）。 */
  enabledTemplates(): WorkerTemplate[] {
    return this.rows
      .filter((row) => row.enabled)
      .map((row) => ({ templateId: row.templateId, name: row.name, description: row.description, role: row.role }))
  }

  /** 全类型摘要投影（RouterState.types / 类型清单；含 enabled/origin）。 */
  summaries(): WorkerTypeSummary[] {
    return this.rows.map((row) => ({
      templateId: row.templateId,
      name: row.name,
      description: row.description,
      role: row.role,
      enabled: row.enabled,
      origin: row.origin,
    }))
  }
}

/* ────────────────────────── Router 默认值存储 ────────────────────────── */

import { routerPrompt } from './prompts/router.ts'
import type { RouterDefaults } from '../shared/view-contract.ts'

/** Router 默认值落盘形状。 */
export interface RouterDefaultsFile {
  schemaVersion: 1
  routerSystemPrompt: string
  routerModel: string
}

/**
 * Router 默认值存储（规格 §6：默认系统提示词、默认模型；C1 供动态 Router 预设
 * 与创建即钉模型，C3 的 GET/PUT /router/defaults 路由落在它上面）。缺省值与
 * 静态兜底同源（prompts/router.ts），文件缺席/损坏即回缺省，不炸装载。
 */
export class RouterDefaultsStore {
  private fs: FsAdapter
  private file: string
  private cached: RouterDefaults | null = null

  constructor(fs: FsAdapter, file: string) {
    this.fs = fs
    this.file = file
  }

  async get(): Promise<RouterDefaults> {
    if (this.cached !== null) return { ...this.cached }
    let file: Partial<RouterDefaultsFile> | null = null
    try {
      file = JSON.parse(await this.fs.readFile(this.file)) as Partial<RouterDefaultsFile>
    } catch {
      file = null
    }
    const resolved: RouterDefaults = {
      routerSystemPrompt: typeof file?.routerSystemPrompt === 'string' && file.routerSystemPrompt !== ''
        ? file.routerSystemPrompt
        : routerPrompt,
      routerModel: typeof file?.routerModel === 'string' ? file.routerModel : '',
    }
    this.cached = resolved
    return { ...resolved }
  }

  async set(value: Partial<RouterDefaults>): Promise<RouterDefaults> {
    const current = await this.get()
    const next: RouterDefaults = {
      routerSystemPrompt: typeof value.routerSystemPrompt === 'string' && value.routerSystemPrompt !== ''
        ? value.routerSystemPrompt
        : current.routerSystemPrompt,
      routerModel: typeof value.routerModel === 'string' ? value.routerModel : current.routerModel,
    }
    const parent = this.file.slice(0, this.file.lastIndexOf('/')) || '/'
    await this.fs.mkdirp(parent)
    const file: RouterDefaultsFile = { schemaVersion: 1, ...next }
    await this.fs.writeFile(this.file, JSON.stringify(file, null, 2))
    this.cached = next
    return { ...next }
  }
}
