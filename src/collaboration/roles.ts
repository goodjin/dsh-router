/**
 * 轻量角色模板存储 RoleStore（md 按 ID 键版）。
 *
 * 一个角色一个 md 文件：**文件名 = 角色 ID**（稳定，不随名称变），文件内容分三段——
 * 角色围栏（id + name）、职责正文、可选的候选模型围栏。名称可变：改名只改文件内容、
 * 文件路径不动，因此不会再出现「改名多出一个角色」。
 *
 * ID 按角色**原始名称**确定性派生（同一名称永远同一 ID），冲突时加后缀避让；
 * ID 一经分配永不变化。用户与模型通过同一 save 能力写入；也可以用任何编辑器直接改
 * md 文件（文件是唯一事实源，读取方按缓存节奏看到）。不注册 preset、不含运行时插件树、
 * 无业务授权语义。
 *
 * 名字即文件名（迁移前的老格式）已由一次性迁移改写：旧格式文件（无角色围栏）按名称
 * 派生 ID、写成新格式、确认可读后再删旧文件；迁移前整个 roles 目录备份到
 * collaboration/roles.bak-<时间戳>/（只备一次）。旧版 <uuid>.json 角色经 migrateLegacyJson
 * 一次性迁为 md（json 保留不删、坏文件跳过）。
 */

import { readFile, readdir, rename, rm, mkdir, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CollaborationError,
  type CollaborationFs,
  type RoleMigrationReport,
  type RoleModelCandidate,
  type RoleStore,
  type RoleStoreDeps,
  type RoleTemplate,
} from './types.ts'
import { PathGuard } from './path-guard.ts'
import { deriveRoleId, parseRoleDocument, roleFenceBlock, serializeRoleFile, validateRoleModels } from './role-models.ts'

const ROLE_EXT = '.md'
const LEGACY_EXT = '.json'
const NAMESPACE = 'collaboration'
/** 名字长度上限。 */
const NAME_MAX = 64
/** ID 长度上限（ID 是文件名主干）。 */
const ID_MAX = 64
/** 备份目录名前缀（collaboration/roles.bak-<时间戳>/）。 */
const BACKUP_PREFIX = 'roles.bak-'

let tmpSeq = 0

/** 生产用 node:fs/promises 适配器。 */
function nodeFs(): CollaborationFs {
  return {
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true })
    },
    readFile: (p) => readFile(p, 'utf8'),
    readdir: (p) => readdir(p, { withFileTypes: false }),
    writeFile: (p, content) => writeFile(p, content, 'utf8'),
    rename: (from, to) => rename(from, to),
    remove: (p) => rm(p, { force: true }),
    lstat: (p) => lstat(p),
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * 校验角色名：去两端空白后必须非空、长度 ≤ 64、无路径分隔符/空字节、
 * 不以点开头、不是 . / ..、无控制字符。中文与常见标点合法。
 */
function validateRoleName(raw: unknown, what = 'name'): string {
  if (typeof raw !== 'string') throw new CollaborationError('INVALID_INPUT', `${what} 必须是字符串`)
  const name = raw.trim()
  if (name.length === 0 || name.length > NAME_MAX) {
    throw new CollaborationError('INVALID_INPUT', `${what} 长度须在 1..${NAME_MAX} 之间（去空白后）`)
  }
  if (name.startsWith('.') || name === '.' || name === '..') {
    throw new CollaborationError('INVALID_INPUT', `${what} 不得以点开头`)
  }
  for (const ch of name) {
    const code = ch.codePointAt(0)!
    if (code === 47 || code === 92 || code === 0 || code < 0x20) {
      throw new CollaborationError('INVALID_INPUT', `${what} 含非法字符（路径分隔符或控制字符）`)
    }
  }
  return name
}

/** 校验角色 ID（=文件名主干）：非空、长度受限、不含路径分隔符与控制字符、不以点开头。 */
function validateRoleId(raw: unknown): string {
  if (typeof raw !== 'string') throw new CollaborationError('INVALID_INPUT', 'id 必须是字符串')
  const id = raw.trim()
  if (id.length === 0 || id.length > ID_MAX) {
    throw new CollaborationError('INVALID_INPUT', `id 长度须在 1..${ID_MAX} 之间（去空白后）`)
  }
  if (id.startsWith('.') || id === '.' || id === '..') {
    throw new CollaborationError('INVALID_INPUT', 'id 不得以点开头')
  }
  for (const ch of id) {
    const code = ch.codePointAt(0)!
    if (code === 47 || code === 92 || code === 0 || code < 0x20) {
      throw new CollaborationError('INVALID_INPUT', 'id 含非法字符（路径分隔符或控制字符）')
    }
  }
  return id
}

/** 原子写：同目录临时文件 → rename 覆盖；目录准备也纳入 IO_ERROR 包装。 */
async function atomicWrite(fs: CollaborationFs, target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${++tmpSeq}`
  try {
    await fs.mkdirp(join(target, '..'))
    await fs.writeFile(tmp, content)
    await fs.rename(tmp, target)
  } catch (error) {
    await fs.remove(tmp).catch(() => {})
    throw new CollaborationError('IO_ERROR', `写入失败: ${target}`, { cause: error })
  }
}

/** 盘上一个角色文件的解析结果。 */
interface RoleFile {
  /** 角色 ID（新格式取围栏里的 id；旧格式取文件名主干）。 */
  id: string
  /** 角色名（新格式取围栏里的 name；旧格式取文件名主干）。 */
  name: string
  description: string
  models?: RoleModelCandidate[]
  /** 旧格式文件（无角色围栏）：还没迁成 ID 命名。 */
  legacy: boolean
}

/** 对外模板：models 为空数组时不出现（与存储口径一致）。 */
function toTemplate(file: RoleFile): RoleTemplate {
  if (file.models !== undefined && file.models.length > 0) {
    return { id: file.id, name: file.name, description: file.description, models: file.models }
  }
  return { id: file.id, name: file.name, description: file.description }
}

/** 创建 RoleStore。dataDir 为插件数据根，内部拼一次 collaboration 命名空间。 */
export function createRoleStore(dataDir: string, deps: RoleStoreDeps = {}): RoleStore {
  const base = join(dataDir, NAMESPACE)
  const rolesDir = join(base, 'roles')
  const fs = deps.fs ?? nodeFs()
  const now = deps.now ?? (() => Date.now())
  const guard = new PathGuard(fs, base)

  const rolePath = (id: string): string => join(rolesDir, `${id}${ROLE_EXT}`)

  /** 进程内写队列：完整写操作从调用入口排队，按提交顺序而非 IO 完成时刻排序。 */
  let writeChain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(task, task)
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** 读一个角色文件（按文件名主干）。 */
  const readRoleFile = async (base: string): Promise<RoleFile> => {
    const path = rolePath(base)
    await guard.assertDirChain(path)
    await guard.assertRegularFile(path, '角色模板')
    let text: string
    try {
      text = await fs.readFile(path)
    } catch (error) {
      if (isEnoent(error)) throw new CollaborationError('NOT_FOUND', `角色模板不存在: ${path}`)
      throw new CollaborationError('IO_ERROR', `角色模板读取失败: ${path}`, { cause: error })
    }
    const parsed = parseRoleDocument(base, text)
    if (parsed.id !== undefined && parsed.name !== undefined) {
      const file: RoleFile = { id: parsed.id, name: parsed.name, description: parsed.description, legacy: false }
      if (parsed.models !== undefined) file.models = parsed.models
      return file
    }
    // 旧格式文件：文件名就是角色名（ID 暂用文件名主干，迁移后转成稳定 ID）。
    const legacy: RoleFile = { id: base, name: base, description: parsed.description, legacy: true }
    if (parsed.models !== undefined) legacy.models = parsed.models
    return legacy
  }

  /** 读出全部角色文件（不做名字映射，不排序）。 */
  const readAll = async (): Promise<RoleFile[]> => {
    let names: string[]
    try {
      await guard.assertDirectory(rolesDir) // readdir 前校验目录自身链，符号链接目录不当空目录
      names = await fs.readdir(rolesDir)
    } catch (error) {
      if (isEnoent(error)) return []
      if (error instanceof CollaborationError) throw error
      throw new CollaborationError('IO_ERROR', '列举角色模板失败', { cause: error })
    }
    const files: RoleFile[] = []
    for (const filename of names) {
      if (!filename.endsWith(ROLE_EXT)) continue // 旧 json 等非 md 文件不进清单
      const base = filename.slice(0, -ROLE_EXT.length)
      if (base === '') continue
      files.push(await readRoleFile(base))
    }
    return files
  }

  /** 取一个未被占用的 ID（冲突时加 -2、-3 后缀）。 */
  const uniqueId = (taken: ReadonlySet<string>, base: string): string => {
    if (!taken.has(base)) return base
    let n = 2
    while (taken.has(`${base}-${n}`)) n += 1
    return `${base}-${n}`
  }

  /** 迁移前的整目录备份：只备一次（已有 roles.bak-* 就不再备）。 */
  const backupRolesDir = async (fileNames: readonly string[]): Promise<string | undefined> => {
    let existing: string[] = []
    try {
      existing = await fs.readdir(base)
    } catch (error) {
      if (!isEnoent(error)) throw new CollaborationError('IO_ERROR', `读取协作目录失败: ${base}`, { cause: error })
    }
    const previous = existing.filter((name) => name.startsWith(BACKUP_PREFIX)).sort()
    if (previous.length > 0) return join(base, previous[0]!)
    const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    const dir = join(base, `${BACKUP_PREFIX}${stamp}`)
    await fs.mkdirp(dir)
    for (const file of fileNames) {
      try {
        const content = await fs.readFile(join(rolesDir, file))
        await fs.writeFile(join(dir, file), content)
      } catch {
        // 单个文件读不到就跳过（不阻断迁移；备份目录里少一个文件而已）。
      }
    }
    return dir
  }

  return {
    async list(): Promise<RoleTemplate[]> {
      const files = await readAll()
      const roles = files.map(toTemplate)
      roles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return roles
    },

    async read(key: string): Promise<RoleTemplate> {
      if (typeof key !== 'string' || key.trim() === '') {
        throw new CollaborationError('INVALID_INPUT', '角色名或 id 不能为空')
      }
      const wanted = key.trim()
      const files = await readAll()
      const byName = files.find((file) => file.name === wanted)
      if (byName !== undefined) return toTemplate(byName)
      const byId = files.find((file) => file.id === wanted)
      if (byId !== undefined) return toTemplate(byId)
      throw new CollaborationError('NOT_FOUND', `角色模板不存在: ${wanted}`)
    },

    async save(input: { id?: string; name: string; description: string; models?: unknown }): Promise<RoleTemplate> {
      const name = validateRoleName(input.name)
      if (typeof input.description !== 'string') {
        throw new CollaborationError('INVALID_INPUT', 'description 必须是字符串')
      }
      // 形状不合法在入队前拒绝，避免坏保存排到写队列里才失败。
      const explicit = input.models === undefined ? undefined : validateRoleModels(name, input.models)
      const wantedId = input.id === undefined ? undefined : validateRoleId(input.id)
      return enqueue(async () => {
        const files = await readAll()
        if (wantedId !== undefined) {
          const target = files.find((file) => file.id === wantedId)
          if (target === undefined) throw new CollaborationError('NOT_FOUND', `角色不存在: ${wantedId}`)
          const clash = files.find((file) => file.id !== wantedId && file.name === name)
          if (clash !== undefined) throw new CollaborationError('INVALID_INPUT', `角色名称已被占用: ${name}`)
          // models 缺省 = 保留该角色盘上已有候选。
          const models = explicit !== undefined ? explicit : target.models
          const content = serializeRoleFile({ id: target.id, name, description: input.description, models })
          await atomicWrite(fs, rolePath(target.id), content)
          const saved: RoleFile = { id: target.id, name, description: input.description, legacy: false }
          if (models !== undefined) saved.models = models
          return toTemplate(saved)
        }
        // 新建：名称必须没被别人占用（不静默产生两个同名角色）。
        const clash = files.find((file) => file.name === name)
        if (clash !== undefined) throw new CollaborationError('INVALID_INPUT', `角色名称已存在: ${name}`)
        const id = uniqueId(new Set(files.map((file) => file.id)), deriveRoleId(name))
        const models = explicit ?? []
        const content = serializeRoleFile({ id, name, description: input.description, models })
        await atomicWrite(fs, rolePath(id), content)
        const saved: RoleFile = { id, name, description: input.description, legacy: false }
        if (models.length > 0) saved.models = models
        return toTemplate(saved)
      })
    },

    async remove(key: string): Promise<boolean> {
      if (typeof key !== 'string' || key.trim() === '') {
        throw new CollaborationError('INVALID_INPUT', '角色名或 id 不能为空')
      }
      const wanted = key.trim()
      if (wanted === '.' || wanted === '..' || wanted.startsWith('.') || /[/\\\0]/.test(wanted)) {
        throw new CollaborationError('INVALID_INPUT', `非法角色名或 id: ${wanted}`)
      }
      return enqueue(async () => {
        const files = await readAll()
        const target = files.find((file) => file.id === wanted || file.name === wanted)
        if (target === undefined) return false
        await guard.assertDirChain(rolePath(target.id))
        await fs.remove(rolePath(target.id))
        return true
      })
    },

    async migrateLegacyJson(): Promise<void> {
      let names: string[]
      try {
        await guard.assertDirectory(rolesDir)
        names = await fs.readdir(rolesDir)
      } catch (error) {
        if (isEnoent(error)) return
        if (error instanceof CollaborationError) throw error
        throw new CollaborationError('IO_ERROR', '迁移旧角色时列举目录失败', { cause: error })
      }
      const legacyFiles = names.filter((filename) => filename.endsWith(LEGACY_EXT))
      if (legacyFiles.length === 0) return
      const existing = await readAll()
      const taken = new Set(existing.map((file) => file.id))
      for (const filename of legacyFiles) {
        const path = join(rolesDir, filename)
        let parsed: unknown
        try {
          parsed = JSON.parse(await fs.readFile(path))
        } catch {
          continue // 坏 json 跳过
        }
        if (typeof parsed !== 'object' || parsed === null) continue
        const record = parsed as { name?: unknown; description?: unknown }
        if (typeof record.name !== 'string' || typeof record.description !== 'string') continue
        let name: string
        try {
          name = validateRoleName(record.name)
        } catch {
          continue
        }
        // 已有同名角色（不论 ID）就跳过，不覆盖、不产生同名重复。
        if (existing.some((file) => file.name === name)) continue
        const id = uniqueId(taken, deriveRoleId(name))
        taken.add(id)
        await atomicWrite(fs, rolePath(id), serializeRoleFile({ id, name, description: record.description }))
      }
    },

    async migrateToIds(): Promise<RoleMigrationReport> {
      return enqueue(async () => {
        let names: string[]
        try {
          await guard.assertDirectory(rolesDir)
          names = await fs.readdir(rolesDir)
        } catch (error) {
          if (isEnoent(error)) return { migrated: 0, removed: 0 }
          if (error instanceof CollaborationError) throw error
          throw new CollaborationError('IO_ERROR', '迁移旧角色时列举目录失败', { cause: error })
        }
        const mdNames = names.filter((filename) => filename.endsWith(ROLE_EXT))
        const entries: Array<{ file: string; base: string; text: string; parsed: ReturnType<typeof parseRoleDocument> }> = []
        for (const file of mdNames) {
          const base = file.slice(0, -ROLE_EXT.length)
          if (base === '') continue
          const path = join(rolesDir, file)
          let text: string
          try {
            text = await fs.readFile(path)
          } catch {
            continue // 读不到的文件不参与迁移（不阻断其余角色）
          }
          let parsed: ReturnType<typeof parseRoleDocument>
          try {
            parsed = parseRoleDocument(base, text)
          } catch {
            // 坏围栏的文件原样留着（用户自己修），不阻断其余角色的迁移与预置种入。
            continue
          }
          entries.push({ file, base, text, parsed })
        }
        const legacy = entries.filter((entry) => entry.parsed.id === undefined)
        if (legacy.length === 0) return { migrated: 0, removed: 0 }
        // 迁移前先备份整个 roles 目录（只备一次）。
        const backupPath = await backupRolesDir(names)
        const ids = new Map<string, string>()
        for (const entry of entries) {
          if (entry.parsed.id !== undefined) ids.set(entry.parsed.id, entry.parsed.name ?? entry.parsed.id)
        }
        let migrated = 0
        let removed = 0
        for (const entry of legacy) {
          const name = entry.base
          const baseId = deriveRoleId(name)
          let id = baseId
          const taken = ids.get(id)
          if (taken !== undefined) {
            if (taken === name) {
              // 迁移残留：同一个角色已经在新格式文件里 → 删旧文件，不重复建角色。
              await fs.remove(join(rolesDir, entry.file))
              removed += 1
              continue
            }
            id = uniqueId(new Set(ids.keys()), baseId)
          }
          // 新文件 = 角色围栏 + 原文件字节（职责正文与候选围栏逐字保留）。
          const content = roleFenceBlock(id, name) + entry.text
          await atomicWrite(fs, rolePath(id), content)
          // 确认新文件可读且内容与旧文件一致，再删旧文件。
          const written = await fs.readFile(rolePath(id))
          const check = parseRoleDocument(id, written)
          if (check.id !== id || check.name !== name) {
            throw new CollaborationError('IO_ERROR', `角色迁移后校验失败: ${name}`)
          }
          if (check.description !== entry.parsed.description) {
            throw new CollaborationError('IO_ERROR', `角色迁移后职责正文不一致: ${name}`)
          }
          if (JSON.stringify(check.models ?? null) !== JSON.stringify(entry.parsed.models ?? null)) {
            throw new CollaborationError('IO_ERROR', `角色迁移后候选不一致: ${name}`)
          }
          await fs.remove(join(rolesDir, entry.file))
          ids.set(id, name)
          migrated += 1
        }
        return backupPath === undefined ? { migrated, removed } : { migrated, removed, backupPath }
      })
    },
  }
}

/** 预置角色模板（专业类型；职责说明随协作上下文注入摘要、随派发拼装全文）。 */
export type { PresetRoleTemplate } from './preset-roles.ts'

/** 首次启用种入 / 升级到的最新预置角色（v2：16 个专业角色，文本单一来源在 preset-roles.ts）。 */
export { PRESET_ROLE_TEMPLATES } from './preset-roles.ts'

import { HISTORICAL_PRESET_DESCRIPTIONS, PRESET_ROLE_TEMPLATES, RETIRED_PRESET_ROLES } from './preset-roles.ts'

/**
 * 幂等种入预置角色，与被替换文本都精确比较：
 * - 按**名称**找已有角色（不论它的 ID）——迁移后 ID 变了也不会重复种入。
 * - 「用户有没有改过」只看职责正文（忽略围栏）：正文等于某版历史预置文本 = 用户没改过，
 *   可安全升级到最新；与任何一版都不一致 = 用户改过，永不覆盖。
 * - 退役预置角色：正文等于任一版历史文本就删（用户改过的保留，宁可留一个孤立角色）。
 * - 新建预置角色用确定性 ID（与迁移派生规则一致）——迁移过来的预置角色与新建的 ID 相同，
 *   不会因为迁移而多出一份。
 */
export async function seedPresetRoles(store: Pick<RoleStore, 'list' | 'save' | 'remove'>): Promise<void> {
  const existing = new Map((await store.list()).map((role) => [role.name, role]))
  for (const [name, texts] of Object.entries(RETIRED_PRESET_ROLES)) {
    const current = existing.get(name)
    if (current === undefined) continue
    if (!texts.includes(current.description)) continue
    await store.remove(current.id)
    existing.delete(name)
  }
  for (const preset of PRESET_ROLE_TEMPLATES) {
    const current = existing.get(preset.name)
    if (current === undefined) {
      await store.save({ name: preset.name, description: preset.description })
      continue
    }
    if (current.description === preset.description) continue
    const history = HISTORICAL_PRESET_DESCRIPTIONS[preset.name]
    if (history !== undefined && history.includes(current.description)) {
      // 升级只改正文，保留该角色已有的 ID 与文件路径、保留已有候选。
      await store.save({ id: current.id, name: preset.name, description: preset.description })
    }
  }
}
