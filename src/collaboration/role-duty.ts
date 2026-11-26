/**
 * 子会话角色职责的解析与缓存（职责进系统提示词，2026-11-26 起）。
 *
 * 职责不再拼进派发初始指令，而是由上下文行按会话贡献：被派发的子会话在组装系统提示词时
 * 拿到「你的角色与职责」段。角色归属从记录反查——分工记录（assignment）的 sessions[].label
 * 就是角色名，找到 sessions 含当前会话 id 的那条分工记录即得角色。
 *
 * 反查要先知道根会话（records.list 按根会话列），所以派发时把「子会话 → 根会话/任务」的
 * 映射落到盘上：collaboration/sessions/<sha256(sessionId)>.json。子会话跨宿主重启后仍能
 * 反查——盘上是事实源，内存缓存只是加速层。
 *
 * text() 是同步回调，不能 await：命中缓存即渲染；没有就后台解析一次（fire-and-forget），
 * 这一拍宁缺勿错（不渲染职责段），绝不抛、绝不出声。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RecordStore, RoleStore } from './types.ts'

/** 协作命名空间（与 RecordStore/RoleStore 一致）。 */
const NAMESPACE = 'collaboration'
/** 会话绑定目录名（collaboration/sessions/）。 */
const SESSIONS_DIR = 'sessions'

/** 一个会话的角色职责：角色名 + 角色模板里的职责正文。 */
export interface RoleDuty {
  /** 角色名（= 分工记录 sessions[].label）。 */
  roleName: string
  /** 角色模板的职责正文（围栏前切片；可能为空——角色没写职责说明）。 */
  description: string
}

/** 盘上的会话绑定：子会话 → 根会话/任务（反查分工记录用）。 */
export interface SessionBinding {
  sessionId: string
  rootSessionId: string
  taskId: string
}

/** 职责服务面：上下文行同步读缓存 + 后台解析；派发工具登记绑定与预热缓存。 */
export interface RoleDutyService {
  /** 同步读缓存：命中返回职责；未命中/过期返回 undefined（渲染层据此宁缺勿错）。 */
  get(sessionId: string): RoleDuty | undefined
  /** 后台解析：盘上绑定 → 分工记录 → 角色模板。任何一步失败都静默返回 undefined。 */
  refresh(sessionId: string): Promise<RoleDuty | undefined>
  /** 派发后立刻把职责放进缓存（同步，子会话首轮组装就能命中）。 */
  prime(sessionId: string, duty: RoleDuty): void
  /** 落盘「子会话 → 根会话/任务」映射（跨重启仍能反查角色）。 */
  bind(input: { sessionId: string; rootSessionId: string; taskId: string }): Promise<void>
}

/** RoleDutyService 的依赖（records/roles 是存储的窄面，便于测试注入）。 */
export interface RoleDutyDeps {
  /** 插件数据根（内部拼 collaboration/sessions/）。 */
  dataDir: string
  /** 工作记录存储（按根会话列分工记录）。 */
  records: Pick<RecordStore, 'list'>
  /** 角色模板存储（按名读职责正文）。 */
  roles: Pick<RoleStore, 'read'>
  /** 命中缓存的有效期（毫秒）。 */
  ttlMs?: number
  /** 未命中（不是派生子会话/记录或角色缺失）的重试间隔（毫秒）：宁缺勿错，但要能很快补上。 */
  missTtlMs?: number
}

/** 绑定文件路径：会话 id 哈希做文件名（只用于文件名，不产生权限）。 */
function bindingPath(dataDir: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex')
  return join(dataDir, NAMESPACE, SESSIONS_DIR, `${hash}.json`)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/** 读绑定文件：没有/坏了/形状不对都当「没有绑定」（不抛）。 */
async function readBinding(dataDir: string, sessionId: string): Promise<SessionBinding | undefined> {
  let text: string
  try {
    text = await readFile(bindingPath(dataDir, sessionId), 'utf8')
  } catch (error) {
    if (isEnoent(error)) return undefined
    return undefined
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (!isNonEmptyString(record.sessionId)) return undefined
  if (!isNonEmptyString(record.rootSessionId)) return undefined
  if (!isNonEmptyString(record.taskId)) return undefined
  return { sessionId: record.sessionId, rootSessionId: record.rootSessionId, taskId: record.taskId }
}

/** 写绑定文件：临时文件 + rename 原子替换（半截文件不算绑定）。 */
async function writeBinding(dataDir: string, binding: SessionBinding): Promise<void> {
  const path = bindingPath(dataDir, binding.sessionId)
  await mkdir(join(dataDir, NAMESPACE, SESSIONS_DIR), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  try {
    await writeFile(tmp, JSON.stringify(binding, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rmQuiet(tmp)
    throw error
  }
}

async function rmQuiet(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    // 清临时文件失败不掩盖原始错误。
  }
}

/**
 * 创建职责服务。缓存是加速层：盘上绑定 + 分工记录 + 角色模板才是事实源。
 */
export function createRoleDutyService(deps: RoleDutyDeps): RoleDutyService {
  const ttlMs = typeof deps.ttlMs === 'number' && Number.isFinite(deps.ttlMs) && deps.ttlMs >= 0 ? deps.ttlMs : 30_000
  const missTtlMs = typeof deps.missTtlMs === 'number' && Number.isFinite(deps.missTtlMs) && deps.missTtlMs >= 0 ? deps.missTtlMs : 5_000
  const cache = new Map<string, { duty: RoleDuty | undefined; at: number }>()
  const loading = new Set<string>()

  /** 反查职责：绑定 → 分工记录（sessions[].label = 角色名）→ 角色模板正文。 */
  const resolveDuty = async (sessionId: string): Promise<RoleDuty | undefined> => {
    const binding = await readBinding(deps.dataDir, sessionId)
    if (binding === undefined) return undefined
    const assignments = await deps.records.list(binding.rootSessionId, { taskId: binding.taskId, kind: 'assignment' })
    let roleName: string | undefined
    for (const record of assignments) {
      for (const link of record.sessions ?? []) {
        if (link.sessionId === sessionId) {
          roleName = link.label
          break
        }
      }
      if (roleName !== undefined) break
    }
    if (roleName === undefined) return undefined
    const role = await deps.roles.read(roleName)
    return { roleName, description: role.description.trim() }
  }

  return {
    get(sessionId: string): RoleDuty | undefined {
      const entry = cache.get(sessionId)
      if (entry === undefined) return undefined
      const age = Date.now() - entry.at
      const limit = entry.duty === undefined ? missTtlMs : ttlMs
      return age < limit ? entry.duty : undefined
    },
    async refresh(sessionId: string): Promise<RoleDuty | undefined> {
      if (loading.has(sessionId)) return this.get(sessionId)
      loading.add(sessionId)
      try {
        const duty = await resolveDuty(sessionId)
        cache.set(sessionId, { duty, at: Date.now() })
        return duty
      } catch {
        // 记录/角色读不到（文件缺失、盘坏了）：静默降级为「没有职责」。
        cache.set(sessionId, { duty: undefined, at: Date.now() })
        return undefined
      } finally {
        loading.delete(sessionId)
      }
    },
    prime(sessionId: string, duty: RoleDuty): void {
      cache.set(sessionId, { duty, at: Date.now() })
    },
    async bind(input: { sessionId: string; rootSessionId: string; taskId: string }): Promise<void> {
      await writeBinding(deps.dataDir, {
        sessionId: input.sessionId,
        rootSessionId: input.rootSessionId,
        taskId: input.taskId,
      })
    },
  }
}
