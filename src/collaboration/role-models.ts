/**
 * 角色 md 文末候选围栏的读写与派发序列。
 *
 * 无围栏时文件字节就是职责正文。有围栏时职责只取开始标记之前的切片，
 * 标记与 JSON 不进入 description。坏围栏是 INVALID_INPUT，不当成「没配候选」。
 */

import { CollaborationError, type RoleModelCandidate } from './types.ts'

export const MODEL_FENCE_START = '<!-- dsh-router:models -->'
export const MODEL_FENCE_END = '<!-- /dsh-router:models -->'

export interface ParsedRoleDocument {
  description: string
  /** 有围栏才出现（含合法的空围栏）。没有围栏则缺省。 */
  models?: RoleModelCandidate[]
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

/** 读角色文件字节。没有单独成行的开始标记时 models 缺省，description 等于原文。 */
export function parseRoleDocument(name: string, text: string): ParsedRoleDocument {
  const lines = linesOf(text)
  const startIndex = lines.findIndex((line) => line.text === MODEL_FENCE_START)
  if (startIndex < 0) return { description: text }
  const start = lines[startIndex]!
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.text === MODEL_FENCE_END)
  if (endIndex < 0) throw invalid(name, '缺少结束标记')
  if (lines.slice(endIndex + 1).length > 0) throw invalid(name, '结束标记之后还有内容')
  const models: RoleModelCandidate[] = []
  for (let index = startIndex + 1; index < endIndex; index++) {
    const line = lines[index]!.text
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw invalid(name, `第 ${index - startIndex} 行不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
    }
    try {
      models.push(parseCandidate(name, parsed, `围栏第 ${index - startIndex} 行`))
    } catch (error) {
      if (error instanceof CollaborationError) {
        throw invalid(name, error.message)
      }
      throw error
    }
  }
  return { description: text.slice(0, start.start), models }
}

/**
 * 写回文件字节。无候选不写围栏。有候选时正文不以换行结尾就先补一个，
 * 再写独占一行的标记。读出来的 description 再写回是稳定的。
 */
export function serializeRoleFile(description: string, models: readonly RoleModelCandidate[] | undefined): string {
  if (models === undefined || models.length === 0) return description
  const body = description.endsWith('\n') ? description : `${description}\n`
  const rows = models.map((candidate) => JSON.stringify({ provider: candidate.provider, model: candidate.model }))
  return `${body}${MODEL_FENCE_START}\n${rows.join('\n')}\n${MODEL_FENCE_END}\n`
}

/** 一次派发的候选：角色自己的候选，按 provider+NUL+model 去重（先出现的保留）。 */
export function resolveDispatchSequence(
  models: readonly RoleModelCandidate[] | undefined,
): RoleModelCandidate[] {
  const sequence: RoleModelCandidate[] = []
  const seen = new Set<string>()
  const push = (candidate: RoleModelCandidate): void => {
    const key = `${candidate.provider}\0${candidate.model}`
    if (seen.has(key)) return
    seen.add(key)
    sequence.push({ provider: candidate.provider, model: candidate.model })
  }
  if (models !== undefined) {
    for (const candidate of models) push(candidate)
  }
  return sequence
}
