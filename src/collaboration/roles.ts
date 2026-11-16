/**
 * 轻量角色模板存储 RoleStore（计划 Task 1）。
 *
 * 角色模板仅为数据（编号、名称、职责说明）：用户与模型通过同一 save 能力创建/修改，
 * 不注册 preset、不含运行时插件树、无业务授权语义。一项模板对应一个独立 JSON 文件。
 * 仅依赖 node 与 ./types.ts。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  CollaborationError,
  type CollaborationFs,
  type RoleStore,
  type RoleStoreDeps,
  type RoleTemplate,
} from './types.ts'
import { PathGuard } from './path-guard.ts'

const RECORD_EXT = '.json'
const NAMESPACE = 'collaboration'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function requireNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CollaborationError('INVALID_INPUT', `${what} 必须是非空字符串`)
  }
  return value
}

function requireUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new CollaborationError('INVALID_INPUT', `${what} 必须是 UUID`)
  }
  return value
}

/** 落库模板的形状校验。 */
function isRoleTemplateShape(value: unknown): value is RoleTemplate {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.description === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.updatedAt === 'number'
  )
}

function parseRole(text: string, path: string): RoleTemplate {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new CollaborationError('CORRUPT_RECORD', `角色模板 JSON 损坏: ${path}`, { cause: error })
  }
  if (!isRoleTemplateShape(raw)) {
    throw new CollaborationError('CORRUPT_RECORD', `角色模板结构不符: ${path}`)
  }
  return raw
}

/** 原子写：同目录临时文件 → rename 覆盖；目录准备也纳入 IO_ERROR 包装。 */
async function atomicWrite(fs: CollaborationFs, target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${++tmpSeq}`
  try {
    await fs.mkdirp(dirname(target))
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
  const now = deps.now ?? (() => Date.now())
  const uuid = deps.uuid ?? randomUUID
  const fs = deps.fs ?? nodeFs()
  const guard = new PathGuard(fs, base)
  const rolePath = (id: string): string => join(rolesDir, `${id}${RECORD_EXT}`)

  /** 进程内写队列：完整写操作（读/检查/写）从调用入口排队，按提交顺序而非 IO 完成时刻排序。 */
  let writeChain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(task, task)
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  const readRoleFile = async (id: string): Promise<RoleTemplate> => {
    const path = rolePath(id)
    await guard.assertDirChain(path)
    await guard.assertRegularFile(path, '角色模板')
    let text: string
    try {
      text = await fs.readFile(path)
    } catch (error) {
      if (isEnoent(error)) throw new CollaborationError('NOT_FOUND', `角色模板不存在: ${path}`)
      throw new CollaborationError('IO_ERROR', `角色模板读取失败: ${path}`, { cause: error })
    }
    return parseRole(text, path)
  }

  return {
    async list(): Promise<RoleTemplate[]> {
      let names: string[]
      try {
        names = await fs.readdir(rolesDir)
      } catch (error) {
        if (isEnoent(error)) return []
        throw new CollaborationError('IO_ERROR', `列举角色模板失败`, { cause: error })
      }
      const roles: RoleTemplate[] = []
      for (const name of names) {
        if (!name.endsWith(RECORD_EXT)) continue
        const id = name.slice(0, -RECORD_EXT.length)
        if (!isUuid(id)) continue
        roles.push(await readRoleFile(id))
      }
      roles.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return roles
    },

    async read(id: string): Promise<RoleTemplate> {
      requireUuid(id, 'roleId')
      return readRoleFile(id)
    },

    async save(input: { id?: string; name: string; description: string }): Promise<RoleTemplate> {
      // 同步快照实际使用字段（name/description 为字符串原值），调用方在 await 后改入参不改变已提交内容。
      const name = input.name
      const description = input.description
      requireNonEmptyString(name, 'name')
      if (typeof description !== 'string') {
        throw new CollaborationError('INVALID_INPUT', 'description 必须是字符串')
      }
      const requestId = input.id
      if (requestId !== undefined) requireUuid(requestId, 'roleId')
      return enqueue(async () => {
        const nowMs = now()
        let id: string
        let createdAt: number
        if (requestId !== undefined) {
          // 已有记录读取在队列内；落盘路径坚持已校验的请求 id，不用盘内可能被改写的 id。
          const existing = await readRoleFile(requestId)
          id = requestId
          createdAt = existing.createdAt
        } else {
          id = uuid()
          createdAt = nowMs
        }
        const template: RoleTemplate = {
          id,
          name,
          description,
          createdAt,
          updatedAt: nowMs,
        }
        const path = rolePath(id)
        await guard.assertDirChain(path)
        await atomicWrite(fs, path, JSON.stringify(template, null, 2))
        return template
      })
    },
  }
}
