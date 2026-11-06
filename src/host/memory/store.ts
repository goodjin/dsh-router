/**
 * MemoryDocStore：三层记忆文档的持久化（规格 §6「记忆：所有会话的文档化记忆」）。
 *
 * 三层各一份 Markdown 文档，同一形状：
 *   sessions/<sessionId>.md   会话摘要（每会话一份，增量更新，头部记 lastSummarizedSeq）
 *   project.md                项目记忆（key=主题，同主题重复按冲突保留）
 *   global.md                 全局记忆（同上）
 *
 * 文档形状：YAML 头（scope/sessionId?/title?/updatedAt/lastSummarizedSeq）+
 * 「## 摘要」节（session，最近一次增量总结的条目化文本，整体替换）+
 * 「## 条目」节（追加式条目，三类标记 [决定]/[建议]/[事实]，带锚点/来源/时间，
 * 同主题重复时新条目照写并带 conflicts-with 指向旧条目锚——冲突保留不合成）。
 *
 * 规格规则落地情况：结论带来源（sources）；三类分别标记（kind）；冲突保留
 * （conflicts-with，不合成）；记录摘要已处理到的事件位（lastSummarizedSeq）；
 * 低信息内容不入记忆（text 去空白后不足 20 字符的条目拒绝写入）。
 *
 * 零宿主依赖：磁盘访问全部经注入的 FsAdapter；时间为注入时钟，便于确定性测试。
 */

import { join } from 'node:path'
import type { FsAdapter } from '../../shared/fs-adapter.ts'

export type MemoryScope = 'session' | 'project' | 'global'

export type MemoryEntryKind = 'user-decision' | 'worker-suggestion' | 'verified-fact'

export interface MemoryEntryInput {
  sourceRefs: string[]
  kind: MemoryEntryKind
  text: string
}

/** 一条记忆条目（解析后形态）。anchor 为文档内锚（e1、e2……单调递增）。 */
export interface MemoryEntry {
  anchor: string
  kind: MemoryEntryKind
  /** 主题 key。session 文档的条目没有主题（key=sessionId 只是文档选择器）。 */
  key?: string
  sourceRefs: string[]
  /** 条目写入时间（epoch ms），检索按它倒序。 */
  at: number
  text: string
  /** 与哪条旧条目同主题冲突（冲突保留不合成）。 */
  conflictsWith?: string
}

/** 一份记忆文档（解析后形态）。summary 仅 session 文档可能有。 */
export interface MemoryDoc {
  scope: MemoryScope
  sessionId?: string
  title?: string
  updatedAt: number
  /** 摘要已处理到的事件位（session）。 */
  lastSummarizedSeq: number
  summary?: string
  entries: MemoryEntry[]
}

export type AppendSummaryResult =
  | { skipped: 'low-info' }
  | { written: true; anchor: string; conflictsWith?: string }

export interface MemoryDocStoreOptions {
  /** 注入时钟，缺省 Date.now。 */
  now?: () => number
}

const LOW_INFO_MIN_CHARS = 20

const KIND_TO_MARKER: Record<MemoryEntryKind, string> = {
  'user-decision': '决定',
  'worker-suggestion': '建议',
  'verified-fact': '事实',
}

const MARKER_TO_KIND: Record<string, MemoryEntryKind> = {
  决定: 'user-decision',
  建议: 'worker-suggestion',
  事实: 'verified-fact',
}

const SUMMARY_HEADING = '## 摘要'
const ENTRIES_HEADING = '## 条目'

/** 文本落盘一律扁平化为单行（记忆条目单行存放；标题同）。 */
function flattenText(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/[\n\r]/g, ' ').trim()
}

/**
 * 文档相对 rootDir 的路径（POSIX 形状，供 memoryRef 引用与落盘共用）：
 * sessions/<enc(sessionId)>.md | project.md | global.md
 */
export function memoryDocRelPath(scope: MemoryScope, key?: string): string {
  if (scope === 'session') {
    if (!key) throw new Error('MemoryDocStore: session 作用域需要 key=sessionId')
    return `sessions/${encodeURIComponent(key)}.md`
  }
  return scope === 'project' ? 'project.md' : 'global.md'
}

function nextAnchor(entries: MemoryEntry[]): string {
  let max = 0
  for (const entry of entries) {
    const match = /^e(\d+)$/.exec(entry.anchor)
    const n = match?.[1] === undefined ? Number.NaN : Number(match[1])
    if (Number.isFinite(n) && n > max) max = n
  }
  return `e${max + 1}`
}

function serializeDoc(doc: MemoryDoc): string {
  const lines: string[] = ['---', `scope: ${doc.scope}`]
  if (doc.sessionId !== undefined) lines.push(`sessionId: ${doc.sessionId}`)
  if (doc.title !== undefined) lines.push(`title: ${doc.title}`)
  lines.push(`updatedAt: ${doc.updatedAt}`, `lastSummarizedSeq: ${doc.lastSummarizedSeq}`, '---', '')
  if (doc.summary !== undefined) {
    lines.push(SUMMARY_HEADING, '', doc.summary, '')
  }
  lines.push(ENTRIES_HEADING, '')
  for (const entry of doc.entries) {
    lines.push(`- [${KIND_TO_MARKER[entry.kind]}] ${entry.text}`)
    lines.push(`  anchor: ${entry.anchor}`)
    if (entry.key !== undefined) lines.push(`  key: ${entry.key}`)
    if (entry.sourceRefs.length > 0) lines.push(`  sources: ${entry.sourceRefs.join('; ')}`)
    lines.push(`  at: ${entry.at}`)
    if (entry.conflictsWith !== undefined) lines.push(`  conflicts-with: ${entry.conflictsWith}`)
    lines.push('')
  }
  return lines.join('\n')
}

const ENTRY_LINE = /^- \[(决定|建议|事实)\] (.*)$/
const META_LINE = /^  ([A-Za-z-]+): ?(.*)$/

function parseEntries(zone: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  let current: MemoryEntry | null = null
  for (const line of zone.split('\n')) {
    if (line === '') continue
    const entryMatch = ENTRY_LINE.exec(line)
    if (entryMatch !== null) {
      const marker = entryMatch[1]
      const text = entryMatch[2]
      if (marker === undefined || text === undefined) continue
      current = { anchor: '', kind: MARKER_TO_KIND[marker]!, sourceRefs: [], at: 0, text }
      entries.push(current)
      continue
    }
    const metaMatch = META_LINE.exec(line)
    if (metaMatch !== null && current !== null) {
      const field = metaMatch[1]
      const value = metaMatch[2]
      if (field === undefined || value === undefined) continue
      if (field === 'anchor') current.anchor = value
      else if (field === 'key') current.key = value
      else if (field === 'sources') {
        current.sourceRefs = value
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s !== '')
      } else if (field === 'at') current.at = Number(value)
      else if (field === 'conflicts-with') current.conflictsWith = value
    }
  }
  for (const entry of entries) {
    if (entry.anchor === '' || !Number.isFinite(entry.at)) {
      throw new Error('MemoryDocStore: 条目缺少 anchor/at，文档可能被外部改坏')
    }
  }
  return entries
}

function parseDoc(raw: string): MemoryDoc {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) throw new Error('MemoryDocStore: 记忆文档缺少 YAML 头')
  const headerEnd = text.indexOf('\n---\n', 4)
  if (headerEnd < 0) throw new Error('MemoryDocStore: 记忆文档 YAML 头未闭合')
  const headerLines = text.slice(4, headerEnd).split('\n')
  const body = text.slice(headerEnd + 5)

  const header = new Map<string, string>()
  for (const line of headerLines) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    header.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  const scope = header.get('scope')
  if (scope !== 'session' && scope !== 'project' && scope !== 'global') {
    throw new Error(`MemoryDocStore: 记忆文档 scope 非法：${String(scope)}`)
  }
  const updatedAt = Number(header.get('updatedAt'))
  if (!Number.isFinite(updatedAt)) throw new Error('MemoryDocStore: updatedAt 非法')
  const seqRaw = header.get('lastSummarizedSeq')
  const lastSummarizedSeq = seqRaw === undefined || seqRaw === '' ? 0 : Number(seqRaw)
  if (!Number.isFinite(lastSummarizedSeq)) throw new Error('MemoryDocStore: lastSummarizedSeq 非法')

  const doc: MemoryDoc = { scope, updatedAt, lastSummarizedSeq, entries: [] }
  const sessionId = header.get('sessionId')
  if (sessionId !== undefined && sessionId !== '') doc.sessionId = sessionId
  const title = header.get('title')
  if (title !== undefined && title !== '') doc.title = title

  // 「## 条目」恒为本仓序列化器写出的最后一节（摘要条目化文本也可能出现
  // 「- [决定] …」形状的行，但不会先于真节头出现），取 lastIndexOf 最稳。
  const entriesIdx = body.lastIndexOf(ENTRIES_HEADING)
  if (entriesIdx >= 0) {
    const beforeEntries = body.slice(0, entriesIdx)
    const summaryIdx = beforeEntries.indexOf(SUMMARY_HEADING)
    if (summaryIdx >= 0) {
      const summary = beforeEntries.slice(summaryIdx + SUMMARY_HEADING.length).trim()
      if (summary !== '') doc.summary = summary
    }
    doc.entries = parseEntries(body.slice(entriesIdx + ENTRIES_HEADING.length))
  } else {
    const summaryIdx = body.indexOf(SUMMARY_HEADING)
    if (summaryIdx >= 0) {
      const summary = body.slice(summaryIdx + SUMMARY_HEADING.length).trim()
      if (summary !== '') doc.summary = summary
    }
  }
  return doc
}

export class MemoryDocStore {
  private readonly rootDir: string
  private readonly fs: FsAdapter
  private readonly now: () => number

  constructor(rootDir: string, fs: FsAdapter, options: MemoryDocStoreOptions = {}) {
    this.rootDir = rootDir
    this.fs = fs
    this.now = options.now ?? Date.now
  }

  /** 文档绝对路径：rootDir + memoryDocRelPath。 */
  private docPath(scope: MemoryScope, key?: string): string {
    return join(this.rootDir, memoryDocRelPath(scope, key))
  }

  async readDoc(scope: MemoryScope, key?: string): Promise<MemoryDoc | null> {
    const path = this.docPath(scope, key)
    if (!(await this.fs.exists(path))) return null
    return parseDoc(await this.fs.readFile(path))
  }

  /**
   * 追加一条记忆。
   * - scope='session'：key=sessionId（只选文档，不参与主题冲突）；
   * - scope='project'|'global'：key=主题；同主题重复时新条目照写，
   *   自动带 conflicts-with 指向最近一条同主题旧条目（冲突保留不合成）。
   * - 低信息门：text 去空白后不足 20 字符 → 拒绝写入，返回 { skipped:'low-info' }。
   */
  async appendSummary(
    scope: MemoryScope,
    key: string | undefined,
    entry: MemoryEntryInput,
  ): Promise<AppendSummaryResult> {
    if (scope === 'session' && !key) {
      throw new Error('MemoryDocStore: appendSummary session 作用域需要 key=sessionId')
    }
    const text = flattenText(entry.text)
    if (text.length < LOW_INFO_MIN_CHARS) return { skipped: 'low-info' }
    const at = this.now()
    const doc = (await this.readDoc(scope, key)) ?? this.emptyDoc(scope, key, at)
    const anchor = nextAnchor(doc.entries)
    const conflictsWith =
      scope === 'session' || key === undefined
        ? undefined
        : [...doc.entries].reverse().find((e) => e.key === key)?.anchor
    doc.entries.push({
      anchor,
      kind: entry.kind,
      key: scope === 'session' ? undefined : key,
      sourceRefs: [...entry.sourceRefs],
      at,
      text,
      conflictsWith,
    })
    doc.updatedAt = at
    await this.writeDoc(scope, key, doc)
    return conflictsWith === undefined
      ? { written: true, anchor }
      : { written: true, anchor, conflictsWith }
  }

  /** 推进会话摘要的增量位（已处理到的事件 seq）。文档不存在则创建只有头部的文档。 */
  async setLastSummarizedSeq(sessionId: string, seq: number): Promise<void> {
    const at = this.now()
    const doc = (await this.readDoc('session', sessionId)) ?? this.emptyDoc('session', sessionId, at)
    doc.lastSummarizedSeq = seq
    doc.updatedAt = at
    await this.writeDoc('session', sessionId, doc)
  }

  /** 写会话标题（头部 title 字段；单行化）。文档不存在则创建。 */
  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    const at = this.now()
    const doc = (await this.readDoc('session', sessionId)) ?? this.emptyDoc('session', sessionId, at)
    doc.title = flattenText(title)
    doc.updatedAt = at
    await this.writeDoc('session', sessionId, doc)
  }

  /** 替换会话摘要节（最近一次增量总结的条目化文本，整体替换；传空白即清除）。 */
  async setSessionSummary(sessionId: string, summary: string): Promise<void> {
    const at = this.now()
    const doc = (await this.readDoc('session', sessionId)) ?? this.emptyDoc('session', sessionId, at)
    const trimmed = summary.trim()
    if (trimmed === '') delete doc.summary
    else doc.summary = trimmed
    doc.updatedAt = at
    await this.writeDoc('session', sessionId, doc)
  }

  /** 列出已有会话文档的 sessionId（文件名解码回原值）；sessions 目录不存在返回空数组。 */
  async listSessionIds(): Promise<string[]> {
    const dir = join(this.rootDir, 'sessions')
    if (!(await this.fs.exists(dir))) return []
    const names = await this.fs.readdir(dir)
    const ids: string[] = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const bare = name.slice(0, -'.md'.length)
      try {
        ids.push(decodeURIComponent(bare))
      } catch {
        ids.push(bare)
      }
    }
    return ids
  }

  private emptyDoc(scope: MemoryScope, key: string | undefined, at: number): MemoryDoc {
    const doc: MemoryDoc = { scope, updatedAt: at, lastSummarizedSeq: 0, entries: [] }
    if (scope === 'session') {
      if (!key) throw new Error('MemoryDocStore: session 作用域需要 key=sessionId')
      doc.sessionId = key
    }
    return doc
  }

  private async writeDoc(scope: MemoryScope, key: string | undefined, doc: MemoryDoc): Promise<void> {
    await this.fs.mkdirp(scope === 'session' ? join(this.rootDir, 'sessions') : this.rootDir)
    await this.fs.writeFile(this.docPath(scope, key), serializeDoc(doc))
  }
}
