/**
 * 轻量工作记录存储 RecordStore（计划 Task 1）。
 *
 * 模型主导的资料读写：一项记录对应一个独立 JSON 文件，文件是唯一事实源。
 * 进程内写队列串行化写入、临时文件 rename 原子替换；rename/写失败不改动原文件。
 * 不引入事件日志、序号、token、数据库或自动动作。仅依赖 node 与 ./types.ts。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import {
  CollaborationError,
  type CollaborationFs,
  type RecordDraft,
  type RecordKind,
  type RecordPatch,
  type RecordQuery,
  type RecordStore,
  type RecordStoreDeps,
  type SavedRecord,
  type WorkRecord,
} from './types.ts'

const RECORD_KINDS = new Set<string>(['task', 'assignment', 'report', 'summary'])
const WORK_LABELS = new Set<string>(['待处理', '进行中', '受阻', '已报告'])
const RECORD_EXT = '.json'
const NAMESPACE = 'collaboration'

/** UUID v4 形态（含版本位 4、变体位 8/9/a/b）——taskId/recordId 必须匹配，拒绝任意路径。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** 进程内临时文件序号：与 pid 一起保证同目录临时名唯一，并发写不互踩。 */
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

/** 非空字符串校验（title/name 等非空必需字段）。 */
function requireNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CollaborationError('INVALID_INPUT', `${what} 必须是非空字符串`)
  }
  return value
}

/** UUID 校验（taskId/recordId/parentRecordId/roleId）。 */
function requireUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new CollaborationError('INVALID_INPUT', `${what} 必须是 UUID`)
  }
  return value
}

function validateSessionLinks(links: RecordDraft['sessions']): void {
  if (links === undefined) return
  if (!Array.isArray(links)) throw new CollaborationError('INVALID_INPUT', 'sessions 必须是数组')
  for (const link of links) {
    requireNonEmptyString(link?.sessionId, 'sessions[].sessionId')
    requireNonEmptyString(link?.label, 'sessions[].label')
  }
}

function validateArtifactRefs(refs: RecordDraft['artifacts']): void {
  if (refs === undefined) return
  if (!Array.isArray(refs)) throw new CollaborationError('INVALID_INPUT', 'artifacts 必须是数组')
  for (const ref of refs) {
    requireNonEmptyString(ref?.location, 'artifacts[].location')
    requireNonEmptyString(ref?.label, 'artifacts[].label')
  }
}

/** 校验新建记录入参（种类、字段类型、枚举、父记录编号）。 */
function validateDraft(input: RecordDraft): void {
  if (!RECORD_KINDS.has(input.kind)) {
    throw new CollaborationError('INVALID_INPUT', `未知记录种类: ${String(input.kind)}`)
  }
  requireNonEmptyString(input.title, 'title')
  if (typeof input.body !== 'string') {
    throw new CollaborationError('INVALID_INPUT', 'body 必须是字符串')
  }
  if (input.workLabel !== undefined && !WORK_LABELS.has(input.workLabel)) {
    throw new CollaborationError('INVALID_INPUT', `未知工作标签: ${input.workLabel}`)
  }
  validateSessionLinks(input.sessions)
  validateArtifactRefs(input.artifacts)
  if (input.parentRecordId !== undefined) requireUuid(input.parentRecordId, 'parentRecordId')
}

/** 校验更新补丁（只允许 title/body/workLabel/sessions/artifacts，且各自合法）。 */
function validatePatch(patch: RecordPatch): void {
  if (patch === null || typeof patch !== 'object') {
    throw new CollaborationError('INVALID_INPUT', 'patch 必须是对象')
  }
  if (patch.title !== undefined) requireNonEmptyString(patch.title, 'title')
  if (patch.body !== undefined && typeof patch.body !== 'string') {
    throw new CollaborationError('INVALID_INPUT', 'body 必须是字符串')
  }
  if (patch.workLabel !== undefined && !WORK_LABELS.has(patch.workLabel)) {
    throw new CollaborationError('INVALID_INPUT', `未知工作标签: ${patch.workLabel}`)
  }
  if (patch.sessions !== undefined) validateSessionLinks(patch.sessions)
  if (patch.artifacts !== undefined) validateArtifactRefs(patch.artifacts)
}

/** 落库记录的形状校验：JSON 合法但结构不符也算损坏。 */
function isWorkRecordShape(value: unknown): value is WorkRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.taskId === 'string' &&
    typeof r.rootSessionId === 'string' &&
    typeof r.title === 'string' &&
    typeof r.body === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.updatedAt === 'number' &&
    RECORD_KINDS.has(r.kind as RecordKind)
  )
}

function parseRecord(text: string, path: string): WorkRecord {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new CollaborationError('CORRUPT_RECORD', `记录 JSON 损坏: ${path}`, { cause: error })
  }
  if (!isWorkRecordShape(raw)) {
    throw new CollaborationError('CORRUPT_RECORD', `记录结构不符: ${path}`)
  }
  return raw
}

/** 原子写：同目录临时文件 → rename 覆盖；失败清理临时文件并保旧文件，抛 IO_ERROR。 */
async function atomicWrite(fs: CollaborationFs, target: string, content: string): Promise<void> {
  await fs.mkdirp(dirname(target))
  const tmp = `${target}.tmp-${process.pid}-${++tmpSeq}`
  try {
    await fs.writeFile(tmp, content)
    await fs.rename(tmp, target)
  } catch (error) {
    await fs.remove(tmp).catch(() => {})
    throw new CollaborationError('IO_ERROR', `写入失败: ${target}`, { cause: error })
  }
}

/** 创建 RecordStore。dataDir 为插件数据根，内部拼一次 collaboration 命名空间。 */
export function createRecordStore(dataDir: string, deps: RecordStoreDeps = {}): RecordStore {
  const base = join(dataDir, NAMESPACE)
  const now = deps.now ?? (() => Date.now())
  const uuid = deps.uuid ?? randomUUID
  const fs = deps.fs ?? nodeFs()

  const tasksDir = (rootSessionId: string): string =>
    join(base, 'roots', createHash('sha256').update(rootSessionId).digest('hex'), 'tasks')
  const recordPath = (rootSessionId: string, taskId: string, recordId: string): string =>
    join(tasksDir(rootSessionId), taskId, `${recordId}${RECORD_EXT}`)

  /** 进程内写队列：串行化写入，单次失败不毒化后续写入。 */
  let writeChain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(task, task)
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** lstat 记录文件：拒绝符号链接；缺失抛 NOT_FOUND；其他错误抛 IO_ERROR。 */
  const statRecord = async (path: string, what: string): Promise<void> => {
    try {
      const stat = await fs.lstat(path)
      if (stat.isSymbolicLink()) {
        throw new CollaborationError('INVALID_INPUT', `${what}不接受符号链接: ${path}`)
      }
    } catch (error) {
      if (error instanceof CollaborationError) throw error
      if (isEnoent(error)) throw new CollaborationError('NOT_FOUND', `${what}不存在`)
      throw new CollaborationError('IO_ERROR', `${what}读取失败`, { cause: error })
    }
  }

  const readRecordFile = async (path: string): Promise<WorkRecord> => {
    await statRecord(path, '记录')
    let text: string
    try {
      text = await fs.readFile(path)
    } catch (error) {
      if (isEnoent(error)) throw new CollaborationError('NOT_FOUND', `记录不存在: ${path}`)
      throw new CollaborationError('IO_ERROR', `记录读取失败: ${path}`, { cause: error })
    }
    return parseRecord(text, path)
  }

  /** 校验某任务记录存在（非任务记录须引用已存在任务）。 */
  const requireTask = async (rootSessionId: string, taskId: string): Promise<void> => {
    await statRecord(recordPath(rootSessionId, taskId, taskId), '任务')
  }

  /** 校验父记录存在且同任务（parentRecordId 只核同任务记录存在，不校验权限/任务图）。 */
  const requireParent = async (rootSessionId: string, taskId: string, parentRecordId: string): Promise<void> => {
    await statRecord(recordPath(rootSessionId, taskId, parentRecordId), '父记录')
  }

  return {
    async create(rootSessionId: string, input: RecordDraft): Promise<SavedRecord> {
      requireNonEmptyString(rootSessionId, 'rootSessionId')
      validateDraft(input)
      const nowMs = now()
      const recordId = uuid()
      let taskId: string
      if (input.kind === 'task') {
        taskId = recordId
      } else {
        if (input.taskId === undefined) {
          throw new CollaborationError('INVALID_INPUT', '非任务记录必须提供 taskId')
        }
        requireUuid(input.taskId, 'taskId')
        taskId = input.taskId
        await requireTask(rootSessionId, taskId)
      }
      if (input.parentRecordId !== undefined) {
        await requireParent(rootSessionId, taskId, input.parentRecordId)
      }
      const record: WorkRecord = {
        kind: input.kind,
        taskId,
        rootSessionId,
        id: recordId,
        title: input.title,
        body: input.body,
        createdAt: nowMs,
        updatedAt: nowMs,
        ...(input.workLabel === undefined ? {} : { workLabel: input.workLabel }),
        ...(input.sessions === undefined ? {} : { sessions: input.sessions }),
        ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
        ...(input.parentRecordId === undefined ? {} : { parentRecordId: input.parentRecordId }),
      }
      const path = recordPath(rootSessionId, taskId, recordId)
      await enqueue(() => atomicWrite(fs, path, JSON.stringify(record, null, 2)))
      return { record, path }
    },

    async read(rootSessionId: string, taskId: string, recordId: string): Promise<SavedRecord> {
      requireNonEmptyString(rootSessionId, 'rootSessionId')
      requireUuid(taskId, 'taskId')
      requireUuid(recordId, 'recordId')
      const path = recordPath(rootSessionId, taskId, recordId)
      const record = await readRecordFile(path)
      return { record, path }
    },

    async list(rootSessionId: string, query?: RecordQuery): Promise<WorkRecord[]> {
      requireNonEmptyString(rootSessionId, 'rootSessionId')
      if (query?.taskId !== undefined) requireUuid(query.taskId, 'taskId')
      if (query?.kind !== undefined && !RECORD_KINDS.has(query.kind)) {
        throw new CollaborationError('INVALID_INPUT', `未知记录种类: ${query.kind}`)
      }
      const dir = tasksDir(rootSessionId)
      let taskNames: string[]
      try {
        taskNames = await fs.readdir(dir)
      } catch (error) {
        if (isEnoent(error)) return []
        throw new CollaborationError('IO_ERROR', `列举任务失败: ${rootSessionId}`, { cause: error })
      }
      const records: WorkRecord[] = []
      for (const taskName of taskNames) {
        if (!isUuid(taskName)) continue
        if (query?.taskId !== undefined && taskName !== query.taskId) continue
        let fileNames: string[]
        try {
          fileNames = await fs.readdir(join(dir, taskName))
        } catch (error) {
          if (isEnoent(error)) continue
          throw new CollaborationError('IO_ERROR', `列举记录失败: ${taskName}`, { cause: error })
        }
        for (const fileName of fileNames) {
          if (!fileName.endsWith(RECORD_EXT)) continue
          const recordId = fileName.slice(0, -RECORD_EXT.length)
          if (!isUuid(recordId)) continue
          const record = await readRecordFile(join(dir, taskName, fileName))
          if (query?.kind !== undefined && record.kind !== query.kind) continue
          records.push(record)
        }
      }
      records.sort(
        (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      return records
    },

    async update(
      rootSessionId: string,
      taskId: string,
      recordId: string,
      patch: RecordPatch,
    ): Promise<SavedRecord> {
      requireNonEmptyString(rootSessionId, 'rootSessionId')
      requireUuid(taskId, 'taskId')
      requireUuid(recordId, 'recordId')
      validatePatch(patch)
      return enqueue(async () => {
        const path = recordPath(rootSessionId, taskId, recordId)
        const current = await readRecordFile(path)
        const applied: Record<string, unknown> = {}
        for (const key of ['title', 'body', 'workLabel', 'sessions', 'artifacts'] as const) {
          if (patch[key] !== undefined) applied[key] = patch[key]
        }
        // 种类、归属与创建时间不可更新：显式保持原值。
        const record: WorkRecord = {
          ...current,
          ...applied,
          id: current.id,
          taskId: current.taskId,
          rootSessionId: current.rootSessionId,
          createdAt: current.createdAt,
          updatedAt: now(),
        }
        await atomicWrite(fs, path, JSON.stringify(record, null, 2))
        return { record, path }
      })
    },
  }
}
