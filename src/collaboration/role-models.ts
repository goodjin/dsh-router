/**
 * 角色 md 文件的三段结构（角色围栏 / 职责正文 / 候选围栏）与派发序列。
 *
 * 文件名 = 角色 ID（稳定，不随名称变）；文件内容：
 *
 *     <!-- dsh-router:role -->
 *     {"id":"<id>","name":"<角色名>"}
 *     <!-- /dsh-router:role -->
 *     <职责正文>
 *     <!-- dsh-router:models -->      ← 可选
 *     {"provider":"p","model":"m"}
 *     <!-- /dsh-router:models -->
 *
 * 角色围栏缺省 = 旧格式文件（文件名当角色名），解析时按旧口径兼容，
 * 由一次性迁移改写成新格式。职责正文 = 角色围栏之后、候选围栏之前的切片；
 * 坏围栏是 INVALID_INPUT，不当成「没配候选」。候选围栏语义不动。
 */

import { createHash } from 'node:crypto'

import { CollaborationError, type RoleModelCandidate } from './types.ts'

export const MODEL_FENCE_START = '<!-- dsh-router:models -->'
export const MODEL_FENCE_END = '<!-- /dsh-router:models -->'

/** 角色元数据围栏：记 id 与 name（文件名是 id，name 可变）。 */
export const ROLE_FENCE_START = '<!-- dsh-router:role -->'
export const ROLE_FENCE_END = '<!-- /dsh-router:role -->'

export interface ParsedRoleDocument {
  /** 角色围栏里的 id（新格式）；旧格式文件缺省（调用方用文件名兜底）。 */
  id?: string
  /** 角色围栏里的 name（新格式）；旧格式文件缺省（调用方用文件名兜底）。 */
  name?: string
  description: string
  /** 有围栏才出现（含合法的空围栏）。没有围栏则缺省。 */
  models?: RoleModelCandidate[]
}

/**
 * 按角色原始名称派生稳定 ID：同一名称永远得到同一 ID（改名不变）。
 * 形式是「名字的可读片段 + 名称哈希前 6 位」——可读片段方便用户认文件，
 * 哈希保证不同名字几乎不会撞；真撞了由存储层加后缀避让。
 */
export function deriveRoleId(name: string): string {
  const trimmed = name.trim()
  const hash = createHash('sha256').update(trimmed).digest('hex').slice(0, 6)
  const slug = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return `${slug === '' ? 'role' : slug}-${hash}`
}

/** 角色围栏块（写文件时放在最前面）。 */
export function roleFenceBlock(id: string, name: string): string {
  return `${ROLE_FENCE_START}\n${JSON.stringify({ id, name })}\n${ROLE_FENCE_END}\n`
}

interface TextLine {
  text: string
  start: number
}

function linesOf(text: string): TextLine[] {
  const lines: TextLine[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push({ text: text.slice(start, i), start })
      start = i + 1
    }
  }
  if (start < text.length) lines.push({ text: text.slice(start), start })
  return lines
}

function invalid(name: string, detail: string): CollaborationError {
  return new CollaborationError('INVALID_INPUT', `角色 ${name} 的候选模型围栏无效：${detail}`)
}

function parseCandidate(name: string, value: unknown, where: string): RoleModelCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CollaborationError('INVALID_INPUT', `角色 ${name} 的候选模型无效：${where} 必须是对象`)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(record, 'provider') || !Object.prototype.hasOwnProperty.call(record, 'model')) {
    throw new CollaborationError('INVALID_INPUT', `角色 ${name} 的候选模型无效：${where} 只能有 provider 与 model`)
  }
  const provider = record.provider
  const model = record.model
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new CollaborationError('INVALID_INPUT', `角色 ${name} 的候选模型无效：${where}.provider 必须是 trim 后的非空字符串`)
  }
  if (typeof model !== 'string' || model.trim() === '') {
    throw new CollaborationError('INVALID_INPUT', `角色 ${name} 的候选模型无效：${where}.model 必须是 trim 后的非空字符串`)
  }
  return { provider: provider.trim(), model: model.trim() }
}

/** 保存入参里的 models。空数组合法（清空）。非数组、坏条目整次拒绝。 */
export function validateRoleModels(name: string, raw: unknown): RoleModelCandidate[] {
  if (!Array.isArray(raw)) {
    throw new CollaborationError('INVALID_INPUT', `角色 ${name} 的候选模型无效：models 必须是数组`)
  }
  return raw.map((item, index) => parseCandidate(name, item, `models[${index}]`))
}

/** 读角色文件字节。fileBase 是文件名主干（新格式是 id，旧格式是角色名）。 */
export function parseRoleDocument(fileBase: string, text: string): ParsedRoleDocument {
  const lines = linesOf(text)
  let body = text
  let id: string | undefined
  let name: string | undefined
  const roleStart = lines.findIndex((line) => line.text === ROLE_FENCE_START)
  if (roleStart >= 0) {
    const roleEnd = lines.findIndex((line, index) => index > roleStart && line.text === ROLE_FENCE_END)
    if (roleEnd < 0) throw invalid(fileBase, '缺少角色围栏的结束标记')
    const payload = lines.slice(roleStart + 1, roleEnd).map((line) => line.text).join('\n').trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch (error) {
      throw invalid(fileBase, `角色围栏不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalid(fileBase, '角色围栏必须是对象')
    }
    const record = parsed as { id?: unknown; name?: unknown }
    if (typeof record.id !== 'string' || record.id.trim() === '') throw invalid(fileBase, '角色围栏缺 id')
    if (typeof record.name !== 'string' || record.name.trim() === '') throw invalid(fileBase, '角色围栏缺 name')
    id = record.id.trim()
    name = record.name.trim()
    // 正文从角色围栏结束行之后开始（围栏本身不进入职责）。
    body = roleEnd + 1 < lines.length ? text.slice(lines[roleEnd + 1]!.start) : ''
  }
  const { description, models } = parseModelsSection(fileBase, body)
  if (id === undefined) return { description, models }
  return { id, name, description, models }
}

/** 正文段与候选围栏：没有围栏时正文就是全部字节。 */
function parseModelsSection(fileBase: string, text: string): { description: string; models?: RoleModelCandidate[] } {
  const lines = linesOf(text)
  const startIndex = lines.findIndex((line) => line.text === MODEL_FENCE_START)
  if (startIndex < 0) return { description: text }
  const start = lines[startIndex]!
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.text === MODEL_FENCE_END)
  if (endIndex < 0) throw invalid(fileBase, '缺少结束标记')
  if (lines.slice(endIndex + 1).length > 0) throw invalid(fileBase, '结束标记之后还有内容')
  const models: RoleModelCandidate[] = []
  for (let index = startIndex + 1; index < endIndex; index++) {
    const line = lines[index]!.text
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw invalid(fileBase, `第 ${index - startIndex} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    models.push(parseCandidate(fileBase, parsed, `models[${index - startIndex}]`))
  }
  return { description: text.slice(0, start.start), models }
}

/**
 * 写回文件字节。角色围栏在最前面（id + name）；无候选不写候选围栏。
 * 有候选时正文不以换行结尾就先补一个，再写独占一行的标记。
 * 读出来的 description 再写回是稳定的。
 */
export function serializeRoleFile(input: {
  id: string
  name: string
  description: string
  models?: readonly RoleModelCandidate[] | undefined
}): string {
  const head = roleFenceBlock(input.id, input.name)
  const body = input.description
  if (input.models === undefined || input.models.length === 0) return `${head}${body}`
  const text = body.endsWith('\n') ? body : `${body}\n`
  const rows = input.models.map((candidate) => JSON.stringify({ provider: candidate.provider, model: candidate.model }))
  return `${head}${text}${MODEL_FENCE_START}\n${rows.join('\n')}\n${MODEL_FENCE_END}\n`
}

/**
 * 随机起点：返回 [0, length-1] 的下标。
 *
 * 随机源缺席用 Math.random；随机源给出坏值（NaN、Infinity、越界、抛错）时退回 0，
 * 也就是「从第一个候选开始」——派发不能因为随机源坏了就不派。
 */
export function pickRotationStart(length: number, random: () => number = Math.random): number {
  if (length <= 1) return 0
  let value: number
  try {
    value = random()
  } catch {
    return 0
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const scaled = Math.floor(value * length)
  if (scaled < 0) return 0
  if (scaled >= length) return length - 1
  return scaled
}

/**
 * 一次派发的候选：角色自己的候选，按 provider+NUL+model 去重（先出现的保留），
 * 再按随机起点旋转成轮转顺序（k, k+1, …, 末尾, 1, …, k-1）。
 *
 * 旋转后的第一项就是子会话的初始模型；失败回退沿这条序列往后走，于是
 * 「到头就从头」天然成立——排在末尾的正是起点之前的那些候选。
 * 候选只有一个时序列不变（没有可轮转的余地）。
 */
export function resolveDispatchSequence(
  models: readonly RoleModelCandidate[] | undefined,
  random: () => number = Math.random,
): RoleModelCandidate[] {
  const deduped: RoleModelCandidate[] = []
  const seen = new Set<string>()
  const push = (candidate: RoleModelCandidate): void => {
    const key = `${candidate.provider}\0${candidate.model}`
    if (seen.has(key)) return
    seen.add(key)
    deduped.push({ provider: candidate.provider, model: candidate.model })
  }
  if (models !== undefined) {
    for (const candidate of models) push(candidate)
  }
  const start = pickRotationStart(deduped.length, random)
  if (start === 0) return deduped
  return [...deduped.slice(start), ...deduped.slice(0, start)]
}
