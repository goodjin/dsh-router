/**
 * 轻量角色模板存储 RoleStore（md 按名键版）。
 *
 * 一个角色一个 md 文件：文件名 = 角色名、正文 = 职责说明。用户与模型通过同一
 * save 能力按名 upsert；也可以用任何编辑器直接改 md 文件（文件是唯一事实源，
 * 读取方按缓存节奏看到）。不注册 preset、不含运行时插件树、无业务授权语义。
 *
 * 名字即文件名：保存前校验（非空、无路径分隔符、不藏头、长度受限），中文合法；
 * 目录链与符号链接守卫沿用 PathGuard。旧版 <uuid>.json 角色经 migrateLegacyJson
 * 一次性迁为 md（json 保留不删、坏文件跳过）。
 */

import { readFile, readdir, rename, rm, mkdir, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CollaborationError,
  type CollaborationFs,
  type RoleStore,
  type RoleStoreDeps,
  type RoleTemplate,
} from './types.ts'
import { PathGuard } from './path-guard.ts'

const ROLE_EXT = '.md'
const LEGACY_EXT = '.json'
const NAMESPACE = 'collaboration'
/** 名字（=文件名）长度上限。 */
const NAME_MAX = 64

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
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

/**
 * 校验角色名（=文件名）：去两端空白后必须非空、长度 ≤ 64、无路径分隔符/空字节、
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
    if (ch === '/' || ch === '\\' || ch === '\0' || code < 0x20) {
      throw new CollaborationError('INVALID_INPUT', `${what} 含非法字符（路径分隔符或控制字符）`)
    }
  }
  return name
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

/** 创建 RoleStore。dataDir 为插件数据根，内部拼一次 collaboration 命名空间。 */
export function createRoleStore(dataDir: string, deps: RoleStoreDeps = {}): RoleStore {
  const base = join(dataDir, NAMESPACE)
  const rolesDir = join(base, 'roles')
  const fs = deps.fs ?? nodeFs()
  const guard = new PathGuard(fs, base)
  const rolePath = (name: string): string => join(rolesDir, `${name}${ROLE_EXT}`)

  /** 进程内写队列：完整写操作从调用入口排队，按提交顺序而非 IO 完成时刻排序。 */
  let writeChain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(task, task)
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  const readRoleFile = async (name: string): Promise<RoleTemplate> => {
    const path = rolePath(name)
    await guard.assertDirChain(path)
    await guard.assertRegularFile(path, '角色模板')
    let text: string
    try {
      text = await fs.readFile(path)
    } catch (error) {
      if (isEnoent(error)) throw new CollaborationError('NOT_FOUND', `角色模板不存在: ${path}`)
      throw new CollaborationError('IO_ERROR', `角色模板读取失败: ${path}`, { cause: error })
    }
    return { name, description: text }
  }

  return {
    async list(): Promise<RoleTemplate[]> {
      let names: string[]
      try {
        await guard.assertDirectory(rolesDir) // readdir 前校验目录自身链，符号链接目录不当空目录
        names = await fs.readdir(rolesDir)
      } catch (error) {
        if (isEnoent(error)) return []
        if (error instanceof CollaborationError) throw error
        throw new CollaborationError('IO_ERROR', '列举角色模板失败', { cause: error })
      }
      const roles: RoleTemplate[] = []
      for (const filename of names) {
        if (!filename.endsWith(ROLE_EXT)) continue // 旧 json 等非 md 文件不进清单
        const name = filename.slice(0, -ROLE_EXT.length)
        if (name === '') continue
        roles.push(await readRoleFile(name))
      }
      roles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return roles
    },

    async read(name: string): Promise<RoleTemplate> {
      const validated = validateRoleName(name)
      return readRoleFile(validated)
    },

    async save(input: { name: string; description: string }): Promise<RoleTemplate> {
      const name = validateRoleName(input.name)
      if (typeof input.description !== 'string') {
        throw new CollaborationError('INVALID_INPUT', 'description 必须是字符串')
      }
      return enqueue(async () => {
        const path = rolePath(name)
        await guard.assertDirChain(path)
        await atomicWrite(fs, path, input.description)
        return { name, description: input.description }
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
      for (const filename of names) {
        if (!filename.endsWith(LEGACY_EXT)) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(await fs.readFile(join(rolesDir, filename)))
        } catch {
          continue // 坏 json 跳过（不删、不炸迁移）
        }
        if (typeof parsed !== 'object' || parsed === null) continue
        const legacy = parsed as { name?: unknown; description?: unknown }
        if (typeof legacy.name !== 'string' || typeof legacy.description !== 'string') continue
        let name: string
        try {
          name = validateRoleName(legacy.name)
        } catch {
          continue
        }
        // 已有同名 md（用户已手工迁移或预置已种）则跳过，不覆盖。
        try {
          await fs.readFile(rolePath(name))
          continue
        } catch (error) {
          if (!isEnoent(error)) throw error
        }
        await atomicWrite(fs, rolePath(name), legacy.description)
      }
    },
  }
}

/** 预置角色模板（专业类型；职责说明随协作上下文注入摘要、随派发拼装全文）。 */
export type { PresetRoleTemplate } from './preset-roles.ts'

/** 首次启用种入 / 升级到的最新预置角色（v2：16 个专业角色，文本单一来源在 preset-roles.ts）。 */
export { PRESET_ROLE_TEMPLATES } from './preset-roles.ts'

import { HISTORICAL_PRESET_DESCRIPTIONS, PRESET_ROLE_TEMPLATES } from './preset-roles.ts'

/**
 * 幂等种入预置角色，带「历史文本精确升级」：
 * - 缺失 → 新建（并发双开最坏是同路径同内容覆盖，不产生重复角色）；
 * - 现有内容等于最新预置 → 跳过；
 * - 现有内容等于某版历史预置文本（= 用户没改过）→ 升级到最新；
 * - 现有内容与任何历史文本都不一致（用户改过）→ 永远不动。
 */
export async function seedPresetRoles(store: Pick<RoleStore, 'list' | 'save'>): Promise<void> {
  const existing = new Map((await store.list()).map((role) => [role.name, role.description]))
  for (const preset of PRESET_ROLE_TEMPLATES) {
    const current = existing.get(preset.name)
    if (current === undefined) {
      await store.save({ name: preset.name, description: preset.description })
      continue
    }
    if (current === preset.description) continue
    const history = HISTORICAL_PRESET_DESCRIPTIONS[preset.name]
    if (history !== undefined && history.includes(current)) {
      await store.save({ name: preset.name, description: preset.description })
    }
  }
}
