/**
 * 有界会话头读取器（router-header-index Task 1）。
 *
 * 去重/发现路径只读「最高规范 generation 日志的首行头」，绝不整日志重放：
 * - plain JSONL：按 8KB chunk 读到首个换行即停（宿主 readFirstLine 同款）。
 * - zstd：按 chunk 读、扫**首个完整独立 frame** 的边界，只解压该 frame 并要求
 *   它恰是单行头（宿主 readFirstZstdLine + assertZstdHeaderFrame 同款），随即
 *   关闭句柄——后续 frame（正文）不读不解。
 * - 三重封顶：压缩输入字节、解压输出字节、时间（逐 chunk 检查），外加可选
 *   abort 信号；坏输入（坏 magic/截断/无换行/坏 JSON/形状不符）关死为最终
 *   failure，不回落、不猜。
 * - generation 选择：目录内最高数字 generation 胜出；超过已知最高版本
 *   （future format）整体关死，**不回落旧 generation**（宿主同一拒绝语义）。
 * - 头校验：id 必须等于会话目录解出的会话 id、version 必须等于文件名
 *   generation、type 必须是 'session'、createdAt/delegationDepth 必须是非负
 *   安全整数——坏头不能冒充别的会话去参与正主判定/归档。
 *
 * 布局与形状取证（2026-11-08，宿主提取件 /tmp/dsh_extract/jsonl-index.js 与
 * 官方镜像 docs/official/reference/persistence-catalog.md）：
 * - `<DSH_HOME>/sessions/<项目目录>/<encodeSegment(会话id)>/session[.vN].jsonl[.zstd]`；
 *   v0 用无版本后缀名，v1+ 带 `vN`；前导零/大写/`v0` 标记名都不是规范名。
 * - v0 物理头：无 isSeeded，可选 seedLength（存在即 seeded）；v1-v4 物理头：
 *   必需 isSeeded，不允许 seedLength；agentPreset 在 v0-v4 都是可选字符串。
 */

import { readdir as fsReaddir, lstat as fsLstat, open as fsOpen } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

/** 当前已知的最高会话格式 generation（宿主 SESSION_FORMAT_VERSION=4）。 */
export const MAX_KNOWN_SESSION_VERSION = 4

/** 逐 chunk 读取的块大小（宿主 readFirstLine/readFirstZstdLine 同款 8KB）。 */
const CHUNK_BYTES = 8_192

export const DEFAULT_MAX_COMPRESSED_BYTES = 262_144
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 65_536
export const DEFAULT_DEADLINE_MS = 2_000

/* ────────────────────────── 路径段编码 ────────────────────────── */

/**
 * 任意字符串编码为单个安全路径段（宿主 encodeSegment 移植）：安全字符原样、
 * 其余按码单元 `~XXXX`（大写十六进制）转义，`.`/`..` 整段特判——中和路径
 * 遍历、分隔符与 NUL 后才允许进文件系统。
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** encodeSegment 的逆映射；只认合法转义（大写十六进制、四位、安全字符集）。 */
export function decodeSegment(encoded: string): string | undefined {
  let out = ''
  let i = 0
  while (i < encoded.length) {
    const ch = encoded[i]!
    if (ch === '~') {
      const hex = encoded.slice(i + 1, i + 5)
      if (!/^[0-9A-F]{4}$/.test(hex)) return undefined
      out += String.fromCharCode(Number.parseInt(hex, 16))
      i += 5
      continue
    }
    if (!/^[A-Za-z0-9._-]$/.test(ch)) return undefined
    out += ch
    i += 1
  }
  return out
}

/* ────────────────────────── generation 文件名 ────────────────────────── */

export interface GenerationFile {
  name: string
  version: number
  zstd: boolean
}

const GENERATION_NAME_RE = /^session\.(?:v([1-9][0-9]*)\.)?jsonl(\.zstd)?$/

/**
 * 规范 generation 文件名解析（宿主 parseGenerationLogFilename 语义）：v0 是
 * 无版本后缀名 `session.jsonl[.zstd]`；v1+ 必须带 `vN`（无前导零）；其余名字
 * （lock、临时名、`v0` 标记名、大写、尾缀）一律不识别。
 */
export function parseGenerationFilename(name: string): GenerationFile | undefined {
  const match = GENERATION_NAME_RE.exec(name)
  if (match === null) return undefined
  return { name, version: match[1] === undefined ? 0 : Number(match[1]), zstd: match[2] !== undefined }
}

/* ────────────────────────── 头形状 ────────────────────────── */

/** 分类所需的头事实（generation、身份、时间、种子标记、预设）。 */
export interface SessionHeaderFacts {
  version: number
  id: string
  createdAt: number
  isSeeded: boolean
  agentPreset: string | undefined
}

const V1PLUS_REQUIRED = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const
const V1PLUS_OPTIONAL = ['cwd', 'parentSession', 'origin', 'agentPreset'] as const
const V0_REQUIRED = ['type', 'version', 'id', 'createdAt', 'delegationDepth'] as const
const V0_OPTIONAL = ['cwd', 'parentSession', 'seedLength', 'origin', 'agentPreset'] as const

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * 首行头解析 + 校验。失败给人话错误（进诊断/告警）；成功只取分类所需的
 * 最小事实。fail closed：未知字段、形状不符、id/version 不匹配一律拒绝。
 */
export function parseHeaderLine(
  line: string,
  expect: { version: number; sessionId: string },
): { facts: SessionHeaderFacts } | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    return { error: `header line is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'header line is not a JSON object' }
  }
  const record = value as Record<string, unknown>
  if (record['type'] !== 'session') return { error: `header type is ${JSON.stringify(record['type'])}, expected 'session'` }
  if (record['version'] !== expect.version) {
    return { error: `header version ${JSON.stringify(record['version'])} does not match generation ${expect.version}` }
  }
  if (typeof record['id'] !== 'string') return { error: 'header id is not a string' }
  if (record['id'] !== expect.sessionId) {
    return { error: `header id "${record['id']}" does not match session "${expect.sessionId}"` }
  }
  if (!isCount(record['createdAt'])) return { error: `header createdAt is not a non-negative safe integer: ${JSON.stringify(record['createdAt'])}` }
  if (!isCount(record['delegationDepth'])) {
    return { error: `header delegationDepth is not a non-negative safe integer: ${JSON.stringify(record['delegationDepth'])}` }
  }
  if (record['cwd'] !== undefined && (typeof record['cwd'] !== 'string' || !isAbsolute(record['cwd']))) {
    return { error: 'header cwd must be an absolute path when present' }
  }
  if (record['parentSession'] !== undefined && typeof record['parentSession'] !== 'string') {
    return { error: 'header parentSession must be a string when present' }
  }
  if (record['origin'] !== undefined && record['origin'] !== 'subagent') {
    return { error: `header origin must be "subagent" when present, got ${JSON.stringify(record['origin'])}` }
  }
  if (record['agentPreset'] !== undefined && typeof record['agentPreset'] !== 'string') {
    return { error: 'header agentPreset must be a string when present' }
  }

  let isSeeded: boolean
  if (expect.version === 0) {
    if (Object.hasOwn(record, 'isSeeded')) return { error: 'format v0 header must not carry isSeeded' }
    if (record['seedLength'] !== undefined && !isCount(record['seedLength'])) {
      return { error: `header seedLength is not a non-negative safe integer: ${JSON.stringify(record['seedLength'])}` }
    }
    isSeeded = Object.hasOwn(record, 'seedLength')
  } else {
    if (Object.hasOwn(record, 'seedLength')) return { error: `format v${expect.version} header must not carry seedLength` }
    if (typeof record['isSeeded'] !== 'boolean') return { error: 'header isSeeded must be a boolean' }
    isSeeded = record['isSeeded']
  }

  const required = expect.version === 0 ? V0_REQUIRED : V1PLUS_REQUIRED
  const optional = expect.version === 0 ? V0_OPTIONAL : V1PLUS_OPTIONAL
  const allowed = new Set<string>([...required, ...optional])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { error: `format v${expect.version} header has unexpected field "${key}"` }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) return { error: `format v${expect.version} header lacks required field "${key}"` }
  }

  return {
    facts: {
      version: expect.version,
      id: record['id'],
      createdAt: record['createdAt'],
      isSeeded,
      agentPreset: record['agentPreset'] as string | undefined,
    },
  }
}

/* ────────────────────────── 读取面 ────────────────────────── */

export interface HeaderIoStats {
  /** 从文件读出的字节（压缩侧；plain 即原始字节）。 */
  bytesCompressed: number
  /** 解出的头行字节。 */
  bytesDecompressed: number
}

export type HeaderReadFailureReason =
  | 'missing'
  | 'future-format'
  | 'ambiguous'
  | 'corrupt'
  | 'limit'
  | 'unsupported'
  | 'unreadable'
  | 'aborted'

export type HeaderReadOutcome =
  | { ok: true; header: SessionHeaderFacts; stats: HeaderIoStats }
  | { ok: false; reason: HeaderReadFailureReason; message: string; stats: HeaderIoStats }

/** 流式 zstd 解码器的最小面（默认 node:zlib createZstdDecompress；测试可注入）。 */
export interface ZstdStreamFace {
  write(chunk: Buffer): void
  end(): void
  destroy(error?: Error): void
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

/** 读取依赖的最小 fs/codec 面（默认 node 实现；测试可注入）。 */
export interface HeaderIoDeps {
  readdir(dir: string): Promise<readonly { name: string }[]>
  /** 身份字段（size/mtimeMs/ctimeMs/dev/ino）供 stable-EOF 扫描核对；头读取路径可注入只有 isFile 的窄面。 */
  lstat(path: string): Promise<{
    isFile(): boolean
    size?: number
    mtimeMs?: number
    ctimeMs?: number
    dev?: number
    ino?: number
  }>
  open(path: string): Promise<{
    read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>
    close(): Promise<void>
    /** 已打开句柄的 fstat（stable-EOF 扫描用：句柄身份 vs 路径身份互等）。 */
    stat?(): Promise<{ size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }>
  }>
  zstd?: { createStream(): ZstdStreamFace }
}

/** node:fs/promises + node:zlib 的默认实现；zstd 能力缺席时 zstd 为 undefined。 */
export function defaultHeaderIoDeps(): HeaderIoDeps {
  return {
    readdir: async (dir) => fsReaddir(dir, { withFileTypes: true }),
    lstat: (path) => fsLstat(path),
    open: (path) => fsOpen(path, 'r'),
    zstd: typeof createZstdDecompress === 'function' ? { createStream: () => createZstdDecompress() } : undefined,
  }
}

/** 到期唤醒的计时面（默认真实 setTimeout，unref；now 单位 = 毫秒纪元）。 */
export interface IoTimerFace {
  set(delayMs: number, fn: () => void): () => void
}

/**
 * I1 r3：有限在途 IO 槽位。每个底层操作发起前 tryAcquire——满额立即快速
 * 降级（reason=limit，进冷却），**不在内存排队**；槽位在底层操作真正
 * settle 时才释放（竞速超时返回不释放：迟到的 open/read/close 继续占槽，
 * 直到其 promise 落定、迟到清理执行完毕）。
 */
export class IoBudget {
  private let: number
  constructor(public readonly capacity: number) {
    this.let = capacity
  }
  private readonly pendingReleases = new Set<() => void>()
  tryAcquire(): boolean {
    if (this.let <= 0) return false
    this.let -= 1
    return true
  }
  release(): void {
    this.let = Math.min(this.capacity, this.let + 1)
  }
  /** 槽位在 op 真正 settle 时释放（与竞速结果无关）。 */
  attachRelease<T>(op: Promise<T>): Promise<T> {
    const releaseOnce = (): void => { this.release() }
    op.then(releaseOnce, releaseOnce)
    return op
  }
  inFlight(): number {
    return this.capacity - this.let
  }
  private unused(): void { void this.pendingReleases }
}

export interface SessionHeaderReaderOptions {
  /** 在途底层 IO 槽位数（默认 8）。 */
  ioCapacity?: number
  /** 共享槽位（index 用同一个预算覆盖头读/枚举/复核）。 */
  budget?: IoBudget
}

/** 中止信号：裸 {aborted} 兼容，真实 AbortSignal 还能即时唤醒在途 IO。 */
export interface HeaderIoSignal {
  aborted: boolean
  addEventListener?(type: 'abort', listener: () => void): unknown
  removeEventListener?(type: 'abort', listener: () => void): unknown
}

export interface HeaderReadOptions {
  maxCompressedBytes?: number
  maxDecompressedBytes?: number
  /** 绝对时限（now() 口径的毫秒时间戳）。 */
  deadlineAt?: number
  now?: () => number
  signal?: HeaderIoSignal
  /** 到期唤醒计时面（I1 r2：挂起的 open/read/decoder 由 timer 真正打断）。 */
  timer?: IoTimerFace
}

/* ────────────────────────── 冷会话小日志 stable-EOF 扫描（cold verdict v2） ────────────────────────── */

/** 扫描默认封顶（brief v2：输入 256KiB / 解压 1MiB / 4096 行 / 单行 64KiB / 2s）。 */
export const DEFAULT_SCAN_MAX_INPUT_BYTES = 262_144
export const DEFAULT_SCAN_MAX_DECOMPRESSED_BYTES = 1_048_576
export const DEFAULT_SCAN_MAX_EVENT_LINES = 4_096
export const DEFAULT_SCAN_MAX_LINE_BYTES = 65_536
export const DEFAULT_SCAN_DEADLINE_MS = 2_000

/** 扫描 IO 计数（input=压缩/原始侧；plain 的解压侧与输入同值）。 */
export interface ScanIoStats {
  bytesCompressed: number
  bytesDecompressed: number
  /** 完整解析的事件行数（不含头行）。 */
  lines: number
}

/** 扫描认定的日志文件身份（前后一致性核对用；与索引指纹同源字段）。 */
export interface ScannedFileIdentity {
  dev: number
  ino: number
  mtimeMs: number
  ctimeMs: number
  size: number
}

export type ScanFailureReason =
  | 'missing'
  | 'future-format'
  | 'ambiguous'
  | 'corrupt'
  /** 超封顶（输入/解压/行数/单行）：日志太大——终态 unknown，重试无意义。 */
  | 'cap'
  /** 读中不稳定（路径/句柄身份前后不一致、读未满 size）：瞬态，改期重试。 */
  | 'unstable'
  /** legacy 格式（v0-v3）或编码能力缺席：终态 unknown。 */
  | 'unsupported'
  | 'unreadable'
  /** 时限/额度：瞬态，改期重试。 */
  | 'limit'
  | 'aborted'

export interface LogScanOptions {
  maxInputBytes?: number
  maxDecompressedBytes?: number
  maxEventLines?: number
  maxLineBytes?: number
  deadlineAt?: number
  now?: () => number
  signal?: HeaderIoSignal
  timer?: IoTimerFace
}

export type LogScanOutcome =
  | {
    ok: true
    header: SessionHeaderFacts
    /** 稳定 EOF 时的当前组合快照：header.agentPreset ?? null 起，逐个 selected 覆盖（含首 turn 之后）。 */
    finalPreset: string | null
    file: GenerationFile
    identity: ScannedFileIdentity
    stats: ScanIoStats
  }
  | { ok: false; reason: ScanFailureReason; message: string; stats: ScanIoStats }

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 从 `from` 起扫描下一个完整独立 zstd frame 的边界（宿主 scanZstdFrames 的
 * 单 frame 移植 + 帧头声明解压尺寸提取）。数据不足以判定完整 frame 时返回
 * 空（调用方继续读）；结构性坏输入（坏 magic/保留位）返回 error。
 */
function scanZstdFrame(buffer: Buffer, from: number): { frame?: { start: number; end: number; contentSize?: number }; error?: string } {
  const start = from
  let offset = from
  if (buffer.length - offset < 4) return {}
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { error: `invalid frame magic at byte ${offset}` }
  offset += 4
  if (offset === buffer.length) return {}
  const descriptor = buffer.readUInt8(offset)!
  offset += 1
  if ((descriptor & 24) !== 0) return { error: `reserved frame-header bit at byte ${offset - 1}` }
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buffer.length - offset < remainingHeaderBytes) return {}
  let contentSize: number | undefined
  if (contentSizeBytes > 0) {
    const raw = buffer.readUIntLE(offset, contentSizeBytes)
    if (raw <= Number.MAX_SAFE_INTEGER) contentSize = raw
  }
  offset += remainingHeaderBytes
  for (;;) {
    if (buffer.length - offset < 3) return {}
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    if (blockType === 3) return { error: `reserved block type at byte ${offset - 3}` }
    const payloadBytes = blockType === 1 ? 1 : blockSize
    if (buffer.length - offset < payloadBytes) return {}
    offset += payloadBytes
    if (lastBlock) break
  }
  if (checksum) {
    if (buffer.length - offset < 4) return {}
    offset += 4
  }
  return { frame: { start, end: offset, ...(contentSize !== undefined ? { contentSize } : {}) } }
}

function isENOENT(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
}

/** 从 lstat/fstat 抽出稳定 EOF 核对所需的完整身份（字段缺席 → undefined）。 */
function identityOf(stat: { size?: number; mtimeMs?: number; ctimeMs?: number; dev?: number; ino?: number }): ScannedFileIdentity | undefined {
  if (
    typeof stat.size !== 'number' || typeof stat.mtimeMs !== 'number' || typeof stat.ctimeMs !== 'number'
    || typeof stat.dev !== 'number' || typeof stat.ino !== 'number'
  ) {
    return undefined
  }
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size }
}

function identityEqual(a: ScannedFileIdentity, b: ScannedFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size
}

/**
 * 事件行最小良构信封（宿主 assertSessionEventEnvelope 同款白名单）：字段 ⊆
 * {type,seq,time,data,surfaceOp,sourceEventSeqs,ignorable}；type 字符串、seq
 * 从 0 连续的安全非负整数、time 安全整数、data 必在、ignorable 只许 true。
 * 只对 agent-preset/selected 提取 data.agentPreset（必须字符串），其余事件
 * 解析后即刻丢弃——不重放、不累积。
 */
function parseScanEventLine(line: string, expectedSeq: number): { selected?: string } | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    return { error: `line is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'event line is not a JSON object' }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'type' && key !== 'seq' && key !== 'time' && key !== 'data' && key !== 'surfaceOp' && key !== 'sourceEventSeqs' && key !== 'ignorable') {
      return { error: `unexpected event envelope field "${key}"` }
    }
  }
  if (typeof record['type'] !== 'string') return { error: 'event type is not a string' }
  const seq = record['seq']
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)) {
    return { error: `seq ${JSON.stringify(seq)} is not a non-negative safe integer` }
  }
  if (seq !== expectedSeq) return { error: `seq ${seq} breaks continuity (expected ${expectedSeq})` }
  const time = record['time']
  if (typeof time !== 'number' || !Number.isSafeInteger(time)) return { error: 'time is not a safe integer' }
  if (record['data'] === undefined) return { error: 'data is missing' }
  if (record['ignorable'] !== undefined && record['ignorable'] !== true) return { error: 'ignorable must be true when present' }
  if (record['type'] === 'agent-preset/selected') {
    const data = record['data']
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return { error: 'selected data is not an object' }
    const preset = (data as Record<string, unknown>)['agentPreset']
    if (typeof preset !== 'string') return { error: 'selected agentPreset is not a string' }
    return { selected: preset }
  }
  return {}
}

/** 默认计时面：真实 setTimeout + unref（now 单位 = 毫秒纪元）。 */
const defaultIoTimer: IoTimerFace = {
  set(delayMs, fn) {
    const timer = setTimeout(fn, delayMs)
    ;(timer as { unref?: () => void }).unref?.()
    return () => clearTimeout(timer)
  },
}

/** 读取全程共享的上下文（含到期唤醒计时面）。 */
interface ReadContext {
  maxCompressed: number
  maxDecompressed: number
  deadlineAt: number
  now: () => number
  signal?: HeaderIoSignal
  timer: IoTimerFace
}

/** 单次 IO 的竞速结果：值 / 异常 / 到期（limit 或 aborted）/ 槽位满额。 */
type IoOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  /** 到期/中止：底层操作**仍在途**（`op` 落定前它占着槽位）。 */
  | { kind: 'expired'; reason: 'limit' | 'aborted'; op: Promise<T> }
  | { kind: 'busy' }

/**
 * 槽位租约：一次「底层操作链」占用的额度。
 *
 * I1 r4 纪律：**额度先于 IO**——租约先取到才允许启动底层操作；租约在链内
 * 同一时刻至多承载 1 个在途操作（句柄的 open→读→关 共用同一租约），因此
 * 「真实在途底层操作数 ≤ 槽位容量」。迟到结果的清理链（lateCleanup）沿用
 * 原租约——额度绝不先释放再抢新槽（抢不到就泄句柄）。
 */
interface IoLease {
  release(): void
}

/**
 * 租约归属策略：
 * - `internal`：本方法自取租约（满额 → busy，**底层操作根本不启动**），
 *   操作落定（含迟到清理链）后归还。
 * - `external`：用调用方给的租约，操作落定后归还。
 * - `external-transfer`：用调用方给的租约；**成功时转交**（不归还，由新持有
 *   者负责），失败/迟到清理链落定时归还。
 * - `external-owned`：用调用方给的租约，**永不**归还（持有者自己管）。
 */
type LeasePolicy = 'internal' | 'external' | 'external-transfer' | 'external-owned'

/** 有界首行头读取器。 */
export class SessionHeaderReader {
  private readonly deps: HeaderIoDeps
  /** I1 r3：在途底层 IO 槽位（可与索引共享同一预算）。 */
  private readonly ioBudget: IoBudget

  constructor(deps: HeaderIoDeps = defaultHeaderIoDeps(), options: SessionHeaderReaderOptions = {}) {
    this.deps = deps
    this.ioBudget = options.budget ?? new IoBudget(options.ioCapacity ?? 8)
  }

  /** 当前在途底层 IO 数（诊断/测试）。 */
  ioInFlight(): number {
    return this.ioBudget.inFlight()
  }

  /**
   * 取一个槽位租约（**不发 IO**）；额度满 → undefined（调用方快速降级）。
   */
  private acquireLease(): IoLease | undefined {
    if (!this.ioBudget.tryAcquire()) return undefined
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.ioBudget.release()
      },
    }
  }

  /**
   * I1 r4：把一次**惰性**底层操作与「deadline timer + abort 信号」竞速。
   *
   * - **额度先于 IO**：`start` 是 thunk——先取到租约才调用它；额度满时直接
   *   返回 busy，底层操作**根本没有启动**（不再出现「先发 IO 再发现没额度」
   *   的无界 outstanding）。
   * - 挂起的 open/read/decoder 不再靠 IO 自己返回后的复查，而是到点立即
   *   返回；迟到结果交 `lateCleanup` 清理（如关句柄），迟到 rejection 已在
   *   守护分支吞掉（不产生 unhandledRejection）。
   * - 租约在底层操作**真正落定**时归还（迟到清理链落定后归还）；绝不先释放
   *   再抢新槽（满额时抢不到 = 泄句柄）。
   */
  private async raceOp<T>(
    start: () => Promise<T>,
    ctx: ReadContext,
    hooks: {
      lateCleanup?: (value: T) => Promise<unknown> | void
      onExpire?: () => void
      lease?: IoLease
      policy?: LeasePolicy
    } = {},
  ): Promise<IoOutcome<T>> {
    const policy = hooks.policy ?? 'internal'
    const lease = policy === 'internal' ? this.acquireLease() : hooks.lease
    if (lease === undefined) return { kind: 'busy' }
    const release = (): void => {
      if (policy === 'external-owned') return
      lease.release()
    }
    let io: Promise<T>
    try {
      io = start()
    } catch (error) {
      release()
      return { kind: 'error', error }
    }
    let raceWon = false
    io.then(
      (value) => {
        if (raceWon) {
          if (hooks.lateCleanup !== undefined) {
            void Promise.resolve()
              .then(() => hooks.lateCleanup!(value))
              .then(release, release)
          } else {
            release()
          }
          return
        }
        // 成功：'external-transfer' 把租约转交给新持有者（句柄）。
        if (policy === 'external-transfer') return
        release()
      },
      () => release(),
    )
    let settled = false
    let cancelTimer: () => void = () => undefined
    let detachAbort: (() => void) | undefined
    const expire = new Promise<'limit' | 'aborted'>((resolve) => {
      cancelTimer = ctx.timer.set(Math.max(0, ctx.deadlineAt - ctx.now()), () => {
        if (!settled) resolve(ctx.signal?.aborted === true ? 'aborted' : 'limit')
      })
      const signal = ctx.signal
      if (signal?.addEventListener !== undefined) {
        const listener = (): void => {
          if (!settled) resolve('aborted')
        }
        signal.addEventListener('abort', listener)
        detachAbort = () => signal.removeEventListener?.('abort', listener)
      }
    })
    const guarded = io.then(
      (value) => ({ kind: 'value' as const, value }),
      (error) => ({ kind: 'error' as const, error }),
    )
    const winner = await Promise.race([guarded, expire.then((reason) => ({ kind: 'expired' as const, reason }))])
    settled = true
    cancelTimer()
    detachAbort?.()
    if (winner.kind === 'expired') {
      raceWon = true
      hooks.onExpire?.()
      // 迟到结果进入 lateCleanup 链（持有原租约直到链落定）；rejection 已吞。
      return { kind: 'expired', reason: winner.reason, op: io }
    }
    return winner
  }

  private expiredOutcome(reason: 'limit' | 'aborted', stage: string, stats: { bytesCompressed: number; bytesDecompressed: number }): HeaderReadOutcome {
    if (reason === 'aborted') {
      return { ok: false, reason: 'aborted', message: `header read aborted during ${stage}`, stats }
    }
    return { ok: false, reason: 'limit', message: `header read expired during ${stage}`, stats }
  }

  /** 额度满：快速降级（底层操作根本没启动）。 */
  private busyOutcome(stage: string, stats: { bytesCompressed: number; bytesDecompressed: number }): HeaderReadOutcome {
    return { ok: false, reason: 'limit', message: `io budget exhausted during ${stage}`, stats }
  }

  /** 读一个会话目录的最高规范 generation 首行头（有界；绝不读正文）。 */
  async readSessionHeader(sessionDir: string, sessionId: string, options: HeaderReadOptions = {}): Promise<HeaderReadOutcome> {
    const startAt = options.now !== undefined ? options.now() : Date.now()
    const deadlineAt = options.deadlineAt ?? startAt + DEFAULT_DEADLINE_MS
    const ctx: ReadContext = {
      maxCompressed: options.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES,
      maxDecompressed: options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES,
      deadlineAt,
      now: options.now ?? Date.now,
      signal: options.signal,
      timer: options.timer ?? defaultIoTimer,
    }
    const zero = { bytesCompressed: 0, bytesDecompressed: 0 }

    // I1 r4：额度先于 IO——readdir 只在取到槽位后才启动。
    const listed = await this.raceOp(() => this.deps.readdir(sessionDir), ctx)
    if (listed.kind === 'busy') return this.busyOutcome('directory listing', zero)
    if (listed.kind === 'expired') return this.expiredOutcome(listed.reason, 'directory listing', zero)
    if (listed.kind === 'error') {
      if (isENOENT(listed.error)) {
        return { ok: false, reason: 'missing', message: `session directory not found: ${sessionId}`, stats: zero }
      }
      return { ok: false, reason: 'unreadable', message: `session directory unreadable: ${listed.error instanceof Error ? listed.error.message : String(listed.error)}`, stats: zero }
    }
    const names = listed.value

    // 最高数字 generation 胜出；future 关死不回落；同版本双编码歧义关死。
    const generations: GenerationFile[] = []
    for (const entry of names) {
      const parsed = parseGenerationFilename(entry.name)
      if (parsed !== undefined) generations.push(parsed)
    }
    if (generations.length === 0) {
      return { ok: false, reason: 'missing', message: `no canonical generation log in session directory: ${sessionId}`, stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
    }
    let highest = generations[0]!
    let ambiguous = false
    for (const candidate of generations.slice(1)) {
      if (candidate.version > highest.version) {
        highest = candidate
        ambiguous = false
      } else if (candidate.version === highest.version) {
        ambiguous = true
      }
    }
    if (highest.version > MAX_KNOWN_SESSION_VERSION) {
      return {
        ok: false,
        reason: 'future-format',
        message: `session ${sessionId} highest generation v${highest.version} exceeds known v${MAX_KNOWN_SESSION_VERSION} (failing closed, no fallback)`,
        stats: { bytesCompressed: 0, bytesDecompressed: 0 },
      }
    }
    if (ambiguous) {
      return {
        ok: false,
        reason: 'ambiguous',
        message: `session ${sessionId} has generation v${highest.version} in both encodings`,
        stats: { bytesCompressed: 0, bytesDecompressed: 0 },
      }
    }

    const path = `${sessionDir}/${highest.name}`
    const statted = await this.raceOp(() => this.deps.lstat(path), ctx)
    if (statted.kind === 'busy') return this.busyOutcome('log stat', zero)
    if (statted.kind === 'expired') return this.expiredOutcome(statted.reason, 'log stat', zero)
    if (statted.kind === 'error') {
      if (isENOENT(statted.error)) {
        return { ok: false, reason: 'missing', message: `generation log missing: ${sessionId}`, stats: zero }
      }
      return { ok: false, reason: 'unreadable', message: `generation log unstattable: ${statted.error instanceof Error ? statted.error.message : String(statted.error)}`, stats: zero }
    }
    if (!statted.value.isFile()) {
      return { ok: false, reason: 'corrupt', message: `generation log is not a regular file: ${sessionId}`, stats: zero }
    }
    if (ctx.signal?.aborted === true) {
      return { ok: false, reason: 'aborted', message: 'header read aborted', stats: zero }
    }

    // I1 r4：句柄的额度**先取**（取不到 → 降级，open 根本不启动）；这一额度
    // 一路保留到句柄关闭——关闭永远不需要另抢槽，也绝不重复关闭。
    const handleLease = this.acquireLease()
    if (handleLease === undefined) return this.busyOutcome('log open', zero)
    const opened = await this.raceOp(() => this.deps.open(path), ctx, {
      lease: handleLease,
      policy: 'external-transfer',
      // 迟到的句柄必须关闭且不许泄漏：close 在**原额度内**执行。
      lateCleanup: (late) => late.close().catch(() => undefined),
    })
    if (opened.kind === 'busy') {
      handleLease.release()
      return this.busyOutcome('log open', zero)
    }
    if (opened.kind === 'expired') return this.expiredOutcome(opened.reason, 'log open', zero)
    if (opened.kind === 'error') {
      handleLease.release()
      if (isENOENT(opened.error)) {
        return { ok: false, reason: 'missing', message: `generation log missing: ${sessionId}`, stats: zero }
      }
      return { ok: false, reason: 'unreadable', message: `generation log unopenable: ${opened.error instanceof Error ? opened.error.message : String(opened.error)}`, stats: zero }
    }
    const handle = opened.value

    /** 迟到仍在途的读（超时后）：关闭必须等它落定（同一额度同一时刻 1 个操作）。 */
    let pending: Promise<unknown> | undefined
    try {
      const line = highest.zstd
        ? await this.readZstdFirstLine(handle, sessionId, ctx, handleLease)
        : await this.readPlainFirstLine(handle, sessionId, ctx, handleLease)
      if ('reason' in line) {
        pending = line.pending
        return { ok: false, reason: line.reason, message: line.error, stats: line.stats }
      }
      const parsed = parseHeaderLine(line.line, { version: highest.version, sessionId })
      if ('error' in parsed) {
        return { ok: false, reason: 'corrupt', message: `session ${sessionId}: ${parsed.error}`, stats: line.stats }
      }
      return { ok: true, header: parsed.facts, stats: line.stats }
    } finally {
      if (pending !== undefined) {
        // 迟到的读仍在途：等它落定再关句柄（额度不被绕过、不重复关闭）。
        void pending.then(
          () => { void this.closeHandle(handle, ctx, handleLease) },
          () => { void this.closeHandle(handle, ctx, handleLease) },
        )
      } else {
        await this.closeHandle(handle, ctx, handleLease)
      }
    }
  }

  /**
   * 关闭句柄：沿用句柄保留的额度（不另取槽、不重复关闭）。**返回竞速结果**——
   * 调用方必须传播 expired/error（关闭失败不得被当成成功）。
   */
  private async closeHandle(
    handle: Awaited<ReturnType<HeaderIoDeps['open']>>,
    ctx: ReadContext,
    lease: IoLease,
  ): Promise<IoOutcome<void>> {
    return this.raceOp(() => handle.close(), ctx, { lease, policy: 'external' })
  }

  /* ────────────────────────── 冷会话小日志 stable-EOF 扫描（cold verdict v2） ────────────────────────── */

  /**
   * 有界流式扫描**当前 v4** 小日志到**稳定 EOF**：跟踪 agent-preset/selected
   * （含首 turn/start 之后的——首 turn 不是安全封闭边界，宿主 select() 竞态
   * 已证伪），EOF 时的最后值即当前组合快照（header.agentPreset ?? null 起）。
   *
   * 稳定性 = 路径 lstat 前后身份一致 ∧ 打开句柄 fstat 前后一致 ∧ 句柄身份与
   * 路径身份相等 ∧ 读满文件 size；任一不满足 → unstable（瞬态，调用方改期
   * 重试）。封顶：输入/解压/行数/单行/时限，越界 → cap（终态，日志太大）。
   * torn（尾行无换行/尾帧不完整）、坏 JSON、seq 缺口、信封违规、坏 selected
   * 载荷、legacy（v0-v3）/future/编码歧义 → 关死（终态）。绝不整日志缓冲、
   * 绝不调用宿主整日志服务。
   */
  async scanSessionLog(sessionDir: string, sessionId: string, options: LogScanOptions = {}): Promise<LogScanOutcome> {
    const startAt = options.now !== undefined ? options.now() : Date.now()
    const maxLines = options.maxEventLines ?? DEFAULT_SCAN_MAX_EVENT_LINES
    const maxLine = options.maxLineBytes ?? DEFAULT_SCAN_MAX_LINE_BYTES
    const ctx: ReadContext = {
      maxCompressed: options.maxInputBytes ?? DEFAULT_SCAN_MAX_INPUT_BYTES,
      maxDecompressed: options.maxDecompressedBytes ?? DEFAULT_SCAN_MAX_DECOMPRESSED_BYTES,
      deadlineAt: options.deadlineAt ?? startAt + DEFAULT_SCAN_DEADLINE_MS,
      now: options.now ?? Date.now,
      signal: options.signal,
      timer: options.timer ?? defaultIoTimer,
    }
    const stats: ScanIoStats = { bytesCompressed: 0, bytesDecompressed: 0, lines: 0 }
    const fail = (reason: ScanFailureReason, message: string): LogScanOutcome => ({ ok: false, reason, message, stats: { ...stats } })

    // ── generation 选择（最高规范代；future 关死；legacy 不扫；双编码歧义关死）──
    const listed = await this.raceOp(() => this.deps.readdir(sessionDir), ctx)
    if (listed.kind === 'busy') return fail('limit', 'io budget exhausted during directory listing')
    if (listed.kind === 'expired') return fail(listed.reason, 'scan expired during directory listing')
    if (listed.kind === 'error') {
      if (isENOENT(listed.error)) return fail('missing', `session directory not found: ${sessionId}`)
      return fail('unreadable', `session directory unreadable: ${listed.error instanceof Error ? listed.error.message : String(listed.error)}`)
    }
    const generations: GenerationFile[] = []
    for (const entry of listed.value) {
      const parsed = parseGenerationFilename(entry.name)
      if (parsed !== undefined) generations.push(parsed)
    }
    if (generations.length === 0) return fail('missing', `no canonical generation log in session directory: ${sessionId}`)
    let highest = generations[0]!
    let ambiguous = false
    for (const candidate of generations.slice(1)) {
      if (candidate.version > highest.version) {
        highest = candidate
        ambiguous = false
      } else if (candidate.version === highest.version) {
        ambiguous = true
      }
    }
    if (highest.version > MAX_KNOWN_SESSION_VERSION) {
      return fail('future-format', `session ${sessionId} highest generation v${highest.version} exceeds known v${MAX_KNOWN_SESSION_VERSION} (failing closed, no fallback)`)
    }
    if (highest.version < MAX_KNOWN_SESSION_VERSION) {
      return fail('unsupported', `session ${sessionId}: legacy format v${highest.version} not scannable (stable-EOF scan covers current v${MAX_KNOWN_SESSION_VERSION} only)`)
    }
    if (ambiguous) return fail('ambiguous', `session ${sessionId} has generation v${highest.version} in both encodings`)

    // ── 路径身份（打开前）──
    const path = `${sessionDir}/${highest.name}`
    const preStat = await this.raceOp(() => this.deps.lstat(path), ctx)
    if (preStat.kind === 'busy') return fail('limit', 'io budget exhausted during log stat')
    if (preStat.kind === 'expired') return fail(preStat.reason, 'scan expired during log stat')
    if (preStat.kind === 'error') {
      if (isENOENT(preStat.error)) return fail('missing', `generation log missing: ${sessionId}`)
      return fail('unreadable', `generation log unstattable: ${preStat.error instanceof Error ? preStat.error.message : String(preStat.error)}`)
    }
    if (!preStat.value.isFile()) return fail('corrupt', `generation log is not a regular file: ${sessionId}`)
    const identityA = identityOf(preStat.value)
    if (identityA === undefined) return fail('unstable', `session ${sessionId}: path identity facts unavailable (cannot prove stable EOF)`)

    // ── 打开（额度先于 IO；租约保留到关闭）──
    const handleLease = this.acquireLease()
    if (handleLease === undefined) return fail('limit', 'io budget exhausted during log open')
    const opened = await this.raceOp(() => this.deps.open(path), ctx, {
      lease: handleLease,
      policy: 'external-transfer',
      lateCleanup: (late) => late.close().catch(() => undefined),
    })
    if (opened.kind === 'busy') {
      handleLease.release()
      return fail('limit', 'io budget exhausted during log open')
    }
    if (opened.kind === 'expired') return fail(opened.reason, 'scan expired during log open')
    if (opened.kind === 'error') {
      handleLease.release()
      if (isENOENT(opened.error)) return fail('missing', `generation log missing: ${sessionId}`)
      return fail('unreadable', `generation log unopenable: ${opened.error instanceof Error ? opened.error.message : String(opened.error)}`)
    }
    const handle = opened.value

    let pending: Promise<unknown> | undefined
    let handleClosed = false
    /**
     * 同步关闭（成功路径）：**传播** close 的 expired/error——关闭失败不得被
     * 当成扫描成功（否则既报告了 ok，又留着未关的句柄）。
     */
    const closeNow = async (): Promise<IoOutcome<void>> => {
      if (handleClosed) return { kind: 'value', value: undefined }
      handleClosed = true
      return this.closeHandle(handle, ctx, handleLease)
    }
    /**
     * 后台清理链：迟到操作（read/fstat）落定后**异步**关闭一次（沿用同一租约）
     * ——调用者按 deadline/abort 及时返回，不被永不落定的底层操作拖住；
     * 迟到操作仍在途时不并发占用同一额度（同一时刻至多 1 个在途操作）。
     */
    const closeInBackground = (pendingOp: Promise<unknown> | undefined): void => {
      if (handleClosed) return
      handleClosed = true
      void (async () => {
        if (pendingOp !== undefined) await pendingOp.then(() => undefined, () => undefined)
        await this.closeHandle(handle, ctx, handleLease)
      })().catch(() => undefined)
    }

    try {
      // ── 句柄身份必须与路径身份一致（防 stat 旧 → open 拿到替换文件）──
      if (handle.stat === undefined) return fail('unstable', `session ${sessionId}: opened-handle stat unavailable (cannot prove stable EOF)`)
      const handleStat = await this.raceOp(() => handle.stat!(), ctx, { lease: handleLease, policy: 'external-owned' })
      if (handleStat.kind === 'busy') return fail('limit', 'io budget exhausted during handle stat')
      if (handleStat.kind === 'expired') {
        pending = handleStat.op
        return fail(handleStat.reason, 'scan expired during handle stat')
      }
      if (handleStat.kind === 'error') {
        return fail('unreadable', `session ${sessionId}: handle stat failed: ${handleStat.error instanceof Error ? handleStat.error.message : String(handleStat.error)}`)
      }
      if (!identityEqual(handleStat.value, identityA)) {
        return fail('unstable', `session ${sessionId}: opened file identity differs from path identity (replaced between stat and open)`)
      }

      // ── 行装配 + 事件解析（无累积：只保留当前 partial 行与最终预设值）──
      let partialParts: Buffer[] = []
      let partialLen = 0
      let sawHeader = false
      let headerFacts: SessionHeaderFacts | undefined
      let finalPreset: string | null = null
      let nextSeq = 0
      const handleLineBytes = (lineBytes: Buffer): { reason: ScanFailureReason; message: string } | undefined => {
        if (!sawHeader) {
          const parsed = parseHeaderLine(lineBytes.toString('utf8'), { version: highest.version, sessionId })
          if ('error' in parsed) return { reason: 'corrupt', message: `session ${sessionId}: ${parsed.error}` }
          sawHeader = true
          headerFacts = parsed.facts
          finalPreset = parsed.facts.agentPreset ?? null
          return undefined
        }
        if (stats.lines >= maxLines) return { reason: 'cap', message: `log exceeds ${maxLines} complete event lines` }
        const parsed = parseScanEventLine(lineBytes.toString('utf8'), nextSeq)
        if ('error' in parsed) return { reason: 'corrupt', message: `session ${sessionId}: event at seq ${nextSeq}: ${parsed.error}` }
        if (parsed.selected !== undefined) finalPreset = parsed.selected
        nextSeq += 1
        stats.lines += 1
        return undefined
      }
      const feedBytes = (slice: Buffer): { reason: ScanFailureReason; message: string } | undefined => {
        let start = 0
        for (;;) {
          const newline = slice.indexOf(10, start)
          if (newline === -1) {
            const tail = slice.subarray(start)
            partialLen += tail.length
            if (partialLen > maxLine) return { reason: 'cap', message: `log line exceeds ${maxLine} bytes` }
            partialParts.push(Buffer.from(tail)) // chunk 复用，partial 必须拷贝
            return undefined
          }
          if (partialLen + (newline - start) > maxLine) return { reason: 'cap', message: `log line exceeds ${maxLine} bytes` }
          const lineBytes = partialParts.length === 0
            ? slice.subarray(start, newline)
            : Buffer.concat([...partialParts, slice.subarray(start, newline)])
          partialParts = []
          partialLen = 0
          const err = handleLineBytes(lineBytes)
          if (err !== undefined) return err
          start = newline + 1
          if (start === slice.length) return undefined
        }
      }
      const tornTail = (): string | undefined => (partialLen > 0 ? 'torn trailing bytes without final newline' : undefined)

      // ── 流式读至 EOF（共享额度；probe 1 字节做 cap+1 探测，不整文件缓冲）──
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
      let readTotal = 0
      const readOnce = async (readLen: number): Promise<IoOutcome<{ bytesRead: number }>> =>
        this.raceOp(() => handle.read(chunk, 0, readLen, null), ctx, { lease: handleLease, policy: 'external-owned' })

      const eofBody = (): LogScanOutcome | undefined => {
        const torn = tornTail()
        if (torn !== undefined) return fail('corrupt', `session ${sessionId}: ${torn}`)
        return undefined
      }

      if (!highest.zstd) {
        // plain JSONL：逐 chunk 切行，读到 EOF。
        // M1：输出封顶同样生效——plain 的输出量 = 输入量，按两者剩余预算的
        // **较小者**限制，并做 cap+1 探测（读满预算后只再探 1 字节）。
        for (;;) {
          const gate = this.chunkGate(ctx)
          if (gate !== undefined) return fail(gate.reason, gate.error)
          const remaining = Math.min(ctx.maxCompressed - readTotal, ctx.maxDecompressed - readTotal)
          const read = await readOnce(remaining > 0 ? Math.min(chunk.length, remaining) : 1)
          if (read.kind === 'busy') return fail('limit', 'io budget exhausted during read')
          if (read.kind === 'expired') {
            pending = read.op
            return fail(read.reason, 'scan expired during read')
          }
          if (read.kind === 'error') {
            return fail('unreadable', `session ${sessionId}: log read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`)
          }
          const { bytesRead } = read.value
          const after = this.chunkGate(ctx)
          if (after !== undefined) {
            stats.bytesCompressed = readTotal + bytesRead
            stats.bytesDecompressed = readTotal + bytesRead
            return fail(after.reason, after.error)
          }
          if (bytesRead === 0) break
          if (remaining <= 0) {
            stats.bytesCompressed = readTotal + bytesRead
            stats.bytesDecompressed = readTotal + bytesRead
            return fail('cap', `log exceeds small-log scan limit (input ${ctx.maxCompressed} / output ${ctx.maxDecompressed} bytes)`)
          }
          readTotal += bytesRead
          stats.bytesCompressed = readTotal
          stats.bytesDecompressed = readTotal
          const fed = feedBytes(chunk.subarray(0, bytesRead))
          if (fed !== undefined) return fail(fed.reason, fed.message)
        }
        const torn = eofBody()
        if (torn !== undefined) return torn
      } else {
        // zstd：独立帧串联；逐帧流式解压喂行装配器（不缓冲整帧输出）
        if (this.deps.zstd === undefined) {
          return fail('unsupported', `session ${sessionId}: zstd log but node:zlib zstd unavailable`)
        }
        let content = Buffer.alloc(0)
        let eof = false
        for (;;) {
          // 消费缓冲内所有完整帧
          for (;;) {
            const gate = this.chunkGate(ctx)
            if (gate !== undefined) return fail(gate.reason, gate.error)
            const scan = scanZstdFrame(content, 0)
            if (scan.error !== undefined) return fail('corrupt', `session ${sessionId}: corrupt Zstandard log: ${scan.error}`)
            if (scan.frame === undefined) break
            if (
              scan.frame.contentSize !== undefined
              && scan.frame.contentSize > ctx.maxDecompressed - stats.bytesDecompressed
            ) {
              return fail('cap', `session ${sessionId}: frame declares ${scan.frame.contentSize} decompressed bytes beyond remaining budget (small-log scan limit)`)
            }
            const already = stats.bytesDecompressed
            const decoded = await this.decodeFrameChunked(content.subarray(0, scan.frame.end), sessionId, ctx, handleLease, already, (piece) => feedBytes(piece))
            if ('reason' in decoded) {
              // M1：失败也累计已产出的解压字节（不得从汇总里消失）
              stats.bytesDecompressed += decoded.total
              if (decoded.pending !== undefined) pending = decoded.pending
              return fail(decoded.reason, decoded.message)
            }
            stats.bytesDecompressed += decoded.total
            content = content.subarray(scan.frame.end)
          }
          if (eof) break
          const remaining = ctx.maxCompressed - readTotal
          if (remaining <= 0) {
            // cap+1 探测：恰好读满 vs 文件更大
            const read = await readOnce(1)
            if (read.kind === 'busy') return fail('limit', 'io budget exhausted during read')
            if (read.kind === 'expired') {
              pending = read.op
              return fail(read.reason, 'scan expired during read')
            }
            if (read.kind === 'error') {
              return fail('unreadable', `session ${sessionId}: log read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`)
            }
            if (read.value.bytesRead > 0) {
              stats.bytesCompressed = readTotal + read.value.bytesRead
              return fail('cap', `log input exceeds ${ctx.maxCompressed} bytes (small-log scan limit)`)
            }
            eof = true
            continue
          }
          const read = await readOnce(Math.min(chunk.length, remaining))
          if (read.kind === 'busy') return fail('limit', 'io budget exhausted during read')
          if (read.kind === 'expired') {
            pending = read.op
            return fail(read.reason, 'scan expired during read')
          }
          if (read.kind === 'error') {
            return fail('unreadable', `session ${sessionId}: log read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`)
          }
          const { bytesRead } = read.value
          const after = this.chunkGate(ctx)
          if (after !== undefined) {
            stats.bytesCompressed = readTotal + bytesRead
            return fail(after.reason, after.error)
          }
          if (bytesRead === 0) {
            eof = true
            continue
          }
          readTotal += bytesRead
          stats.bytesCompressed = readTotal
          content = content.length === 0 ? Buffer.from(chunk.subarray(0, bytesRead)) : Buffer.concat([content, chunk.subarray(0, bytesRead)])
        }
        if (content.length > 0) return fail('corrupt', `session ${sessionId}: torn trailing frame bytes without a complete frame`)
        const torn = eofBody()
        if (torn !== undefined) return torn
      }

      // ── 读满 size + 关闭前句柄身份复核 ──
      if (readTotal !== identityA.size) {
        return fail('unstable', `session ${sessionId}: read ${readTotal} bytes but file size is ${identityA.size} (changed during scan)`)
      }
      const postHandleStat = await this.raceOp(() => handle.stat!(), ctx, { lease: handleLease, policy: 'external-owned' })
      if (postHandleStat.kind === 'busy') return fail('limit', 'io budget exhausted during post-scan handle stat')
      if (postHandleStat.kind === 'expired') {
        pending = postHandleStat.op
        return fail(postHandleStat.reason, 'scan expired during post-scan handle stat')
      }
      if (postHandleStat.kind === 'error') {
        return fail('unreadable', `session ${sessionId}: post-scan handle stat failed: ${postHandleStat.error instanceof Error ? postHandleStat.error.message : String(postHandleStat.error)}`)
      }
      if (!identityEqual(postHandleStat.value, identityA)) {
        return fail('unstable', `session ${sessionId}: file changed during scan (handle identity moved)`)
      }

      // ── 关闭（一次；close 的失败必须传播）──
      const closed = await closeNow()
      if (closed.kind === 'expired') return fail(closed.reason, 'scan expired during close')
      if (closed.kind === 'error') {
        return fail('unreadable', `session ${sessionId}: close failed: ${closed.error instanceof Error ? closed.error.message : String(closed.error)}`)
      }

      // ── 关闭后路径身份复核（防在途替换回原身份骗过句柄检查）──
      const postStat = await this.raceOp(() => this.deps.lstat(path), ctx)
      if (postStat.kind === 'busy') return fail('limit', 'io budget exhausted during post-scan stat')
      if (postStat.kind === 'expired') return fail(postStat.reason, 'scan expired during post-scan stat')
      if (postStat.kind === 'error') {
        if (isENOENT(postStat.error)) return fail('missing', `generation log missing after scan: ${sessionId}`)
        return fail('unreadable', `generation log unstattable after scan: ${postStat.error instanceof Error ? postStat.error.message : String(postStat.error)}`)
      }
      if (!identityEqual(identityOf(postStat.value) ?? { dev: NaN, ino: NaN, mtimeMs: NaN, ctimeMs: NaN, size: NaN }, identityA)) {
        return fail('unstable', `session ${sessionId}: path identity moved during scan`)
      }

      // ── 最终接受点：时限/中断门（后置 stat 可能赢过已过期的计时器）──
      const finalGate = this.chunkGate(ctx)
      if (finalGate !== undefined) return fail(finalGate.reason, finalGate.error)

      return {
        ok: true,
        header: headerFacts!,
        finalPreset,
        file: highest,
        identity: identityA,
        stats: { ...stats },
      }
    } finally {
      // 迟到操作仍在途 → 后台关闭（不阻塞返回）；否则同步关闭一次。
      if (pending !== undefined) closeInBackground(pending)
      else await closeNow()
    }
  }

  /** 流式解码一个完整 frame，逐 chunk 喂调用方（不缓冲整帧输出）；越界即毁流。 */
  private async decodeFrameChunked(
    frame: Buffer,
    sessionId: string,
    ctx: ReadContext,
    lease: IoLease,
    alreadyDecompressed: number,
    onChunk: (piece: Buffer) => { reason: ScanFailureReason; message: string } | undefined,
  ): Promise<{ total: number } | { reason: ScanFailureReason; message: string; total: number; pending?: Promise<unknown> }> {
    let stream: ZstdStreamFace | undefined
    // M1：已产出的解压字节必须随失败一起上报（失败不得吞掉消耗）。
    let produced = 0
    const raced = await this.raceOp(
      () => {
        stream = this.deps.zstd!.createStream()
        return new Promise<{ total: number } | { reason: ScanFailureReason; message: string; total: number }>((resolve) => {
          let total = 0
          let settled = false
          const finish = (result: { total: number } | { reason: ScanFailureReason; message: string; total: number }): void => {
            if (settled) return
            settled = true
            resolve(result)
          }
          const abortWith = (reason: ScanFailureReason, message: string): void => {
            stream!.destroy(new Error(message))
            finish({ reason, message, total })
          }
          stream!.on('data', (piece) => {
            if (settled) return
            total += piece.length
            produced = total
            if (alreadyDecompressed + total > ctx.maxDecompressed) {
              abortWith('cap', `decompressed output exceeds ${ctx.maxDecompressed} bytes (small-log scan limit)`)
              return
            }
            if (ctx.signal?.aborted === true) {
              abortWith('aborted', 'scan aborted during decode')
              return
            }
            if (ctx.now() > ctx.deadlineAt) {
              abortWith('limit', 'scan decode exceeded time budget')
              return
            }
            const fed = onChunk(piece)
            if (fed !== undefined) {
              abortWith(fed.reason, fed.message)
              return
            }
          })
          stream!.on('end', () => {
            if (!settled) finish({ total })
          })
          stream!.on('error', (error) => {
            if (settled) return
            if (ctx.signal?.aborted === true) {
              finish({ reason: 'aborted', message: 'scan aborted during decode', total })
              return
            }
            if (ctx.now() > ctx.deadlineAt) {
              finish({ reason: 'limit', message: 'scan decode exceeded time budget', total })
              return
            }
            finish({ reason: 'corrupt', message: `session ${sessionId}: zstd frame failed to decode: ${error.message}`, total })
          })
          stream!.write(frame)
          stream!.end()
        })
      },
      ctx,
      { lease, policy: 'external-owned', onExpire: () => stream?.destroy(new Error('scan decode expired')) },
    )
    if (raced.kind === 'value') return raced.value
    if (raced.kind === 'error') {
      return { reason: 'unreadable', message: `session ${sessionId}: zstd decode failed to start: ${raced.error instanceof Error ? raced.error.message : String(raced.error)}`, total: produced }
    }
    if (raced.kind === 'busy') {
      stream?.destroy(new Error('io budget exhausted'))
      return { reason: 'limit', message: 'io budget exhausted during decode', total: produced }
    }
    return { reason: raced.reason, message: 'scan decode expired', total: produced, pending: raced.op }
  }

  /** 时限/中断门：await 前后都要过（超时/中断 → limit/aborted）。 */
  private chunkGate(ctx: ReadContext): { reason: 'limit' | 'aborted'; error: string } | undefined {
    if (ctx.signal?.aborted === true) return { reason: 'aborted', error: 'header read aborted' }
    if (ctx.now() > ctx.deadlineAt) return { reason: 'limit', error: 'header read exceeded time budget' }
    return undefined
  }

  /** plain JSONL：读到首个换行即停；每次读取不超过剩余输入配额；IO 与到期竞速。 */
  private async readPlainFirstLine(
    handle: Awaited<ReturnType<HeaderIoDeps['open']>>,
    sessionId: string,
    ctx: ReadContext,
    lease: IoLease,
  ): Promise<{ line: string; stats: HeaderIoStats } | { reason: HeaderReadFailureReason; error: string; stats: HeaderIoStats; pending?: Promise<unknown> }> {
    const chunks: Buffer[] = []
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
    let total = 0
    let remaining = ctx.maxCompressed
    for (;;) {
      const gate = this.chunkGate(ctx)
      if (gate !== undefined) return { reason: gate.reason, error: gate.error, stats: { bytesCompressed: total, bytesDecompressed: 0 } }
      if (remaining <= 0) {
        return { reason: 'limit', error: `no header line within ${ctx.maxCompressed} compressed bytes`, stats: { bytesCompressed: total, bytesDecompressed: 0 } }
      }
      const read = await this.raceOp(() => handle.read(chunk, 0, Math.min(chunk.length, remaining), null), ctx, {
        lease,
        policy: 'external-owned',
      })
      if (read.kind === 'busy') return { reason: 'limit', error: 'io budget exhausted during read', stats: { bytesCompressed: total, bytesDecompressed: 0 } }
      if (read.kind === 'expired') {
        return { reason: read.reason, error: 'header read expired during read', stats: { bytesCompressed: total, bytesDecompressed: 0 }, pending: read.op }
      }
      if (read.kind === 'error') {
        return { reason: 'unreadable', error: `session ${sessionId}: log read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`, stats: { bytesCompressed: total, bytesDecompressed: 0 } }
      }
      const { bytesRead } = read.value
      const after = this.chunkGate(ctx)
      if (after !== undefined) return { reason: after.reason, error: after.error, stats: { bytesCompressed: total + bytesRead, bytesDecompressed: 0 } }
      if (bytesRead === 0) {
        return { reason: 'corrupt', error: `session ${sessionId}: log has no complete header line`, stats: { bytesCompressed: total, bytesDecompressed: 0 } }
      }
      const slice = chunk.subarray(0, bytesRead)
      total += bytesRead
      remaining -= bytesRead
      const newline = slice.indexOf(10)
      if (newline !== -1) {
        const parts = newline === 0 ? chunks : [...chunks, slice.subarray(0, newline)]
        const line = Buffer.concat(parts)
        if (line.length > ctx.maxDecompressed) {
          return { reason: 'limit', error: `header line exceeds ${ctx.maxDecompressed} decompressed bytes`, stats: { bytesCompressed: total, bytesDecompressed: line.length } }
        }
        return { line: line.toString('utf8'), stats: { bytesCompressed: total, bytesDecompressed: line.length } }
      }
      chunks.push(Buffer.from(slice))
    }
  }

  /** zstd：扫首个完整独立 frame（输入配额内），流式解压、输出累计到上限即停。 */
  private async readZstdFirstLine(
    handle: Awaited<ReturnType<HeaderIoDeps['open']>>,
    sessionId: string,
    ctx: ReadContext,
    lease: IoLease,
  ): Promise<{ line: string; stats: HeaderIoStats } | { reason: HeaderReadFailureReason; error: string; stats: HeaderIoStats; pending?: Promise<unknown> }> {
    if (this.deps.zstd === undefined) {
      return { reason: 'unsupported', error: `session ${sessionId}: zstd log but node:zlib zstd unavailable`, stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
    }
    let content = Buffer.alloc(0)
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
    let remaining = ctx.maxCompressed
    let frameEnd: number | undefined
    for (;;) {
      const gate = this.chunkGate(ctx)
      if (gate !== undefined) return { reason: gate.reason, error: gate.error, stats: { bytesCompressed: content.length, bytesDecompressed: 0 } }
      if (remaining <= 0) {
        return { reason: 'limit', error: `no complete first zstd frame within ${ctx.maxCompressed} compressed bytes`, stats: { bytesCompressed: content.length, bytesDecompressed: 0 } }
      }
      const read = await this.raceOp(() => handle.read(chunk, 0, Math.min(chunk.length, remaining), null), ctx, {
        lease,
        policy: 'external-owned',
      })
      if (read.kind === 'busy') return { reason: 'limit', error: 'io budget exhausted during read', stats: { bytesCompressed: content.length, bytesDecompressed: 0 } }
      if (read.kind === 'expired') {
        return { reason: read.reason, error: 'header read expired during read', stats: { bytesCompressed: content.length, bytesDecompressed: 0 }, pending: read.op }
      }
      if (read.kind === 'error') {
        return { reason: 'unreadable', error: `session ${sessionId}: log read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`, stats: { bytesCompressed: content.length, bytesDecompressed: 0 } }
      }
      const { bytesRead } = read.value
      const after = this.chunkGate(ctx)
      if (after !== undefined) return { reason: after.reason, error: after.error, stats: { bytesCompressed: content.length + bytesRead, bytesDecompressed: 0 } }
      if (bytesRead === 0) {
        return { reason: 'corrupt', error: `session ${sessionId}: no complete first zstd frame`, stats: { bytesCompressed: content.length, bytesDecompressed: 0 } }
      }
      content = Buffer.concat([content, chunk.subarray(0, bytesRead)])
      remaining -= bytesRead
      const scan = scanZstdFrame(content, 0)
      if (scan.error !== undefined) {
        return { reason: 'corrupt', error: `session ${sessionId}: corrupt Zstandard log: ${scan.error}`, stats: { bytesCompressed: content.length, bytesDecompressed: 0 } }
      }
      if (scan.frame !== undefined) {
        frameEnd = scan.frame.end
        break
      }
    }

    // 流式解压首 frame：输出达上限即停；整个解码与到期/中止竞速，挂起的
    // decoder 由 timer 销毁（onExpire），迟到的解码结果丢弃。
    const decoded = await this.streamDecode(content.subarray(0, frameEnd!), sessionId, ctx, lease)
    if ('reason' in decoded) return decoded
    const plaintext = decoded.plaintext
    if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1) {
      return { reason: 'corrupt', error: `session ${sessionId}: first zstd frame is not exactly one header line`, stats: { bytesCompressed: content.length, bytesDecompressed: plaintext.length } }
    }
    return { line: plaintext.subarray(0, -1).toString('utf8'), stats: { bytesCompressed: content.length, bytesDecompressed: plaintext.length } }
  }

  /** 流式解码一个完整 frame；输出/时限/中断任一越界即销毁流并关死。 */
  private async streamDecode(
    frame: Buffer,
    sessionId: string,
    ctx: ReadContext,
    lease: IoLease,
  ): Promise<
    | { plaintext: Buffer; bytesDecompressed: number }
    | { reason: HeaderReadFailureReason; error: string; stats: HeaderIoStats; pending?: Promise<unknown> }
  > {
    let stream: ZstdStreamFace | undefined
    // 不发任何事件的 decoder（挂在 write/end 上）由到期竞速销毁并返回。
    const raced = await this.raceOp(
      () => {
        stream = this.deps.zstd!.createStream()
        return this.decodeFrame(stream, frame, sessionId, ctx)
      },
      ctx,
      { lease, policy: 'external-owned', onExpire: () => stream?.destroy(new Error('header decode expired')) },
    )
    if (raced.kind === 'value') return raced.value
    if (raced.kind === 'error') {
      // 真同步异常（createStream 抛错/解码失败）是 unreadable，不是 aborted：
      // aborted 会被索引当成可重试的瞬态态重新排到队首，损坏会话永远解码失败
      // 就会卡死队首（饿死后续会话）。真正的中断走 expired/value 的 aborted 路。
      return { reason: 'unreadable' as const, error: `session ${sessionId}: zstd decode failed: ${raced.error instanceof Error ? raced.error.message : String(raced.error)}`, stats: { bytesCompressed: frame.length, bytesDecompressed: 0 } }
    }
    if (raced.kind === 'busy') {
      stream?.destroy(new Error('io budget exhausted'))
      return { reason: 'limit' as const, error: 'io budget exhausted during decode', stats: { bytesCompressed: frame.length, bytesDecompressed: 0 } }
    }
    return { reason: raced.reason, error: 'header decode expired', stats: { bytesCompressed: frame.length, bytesDecompressed: 0 }, pending: raced.op }
  }

  /** 解码一个 frame（流事件 → 结果 promise）。 */
  private decodeFrame(
    stream: ZstdStreamFace,
    frame: Buffer,
    sessionId: string,
    ctx: ReadContext,
  ): Promise<{ plaintext: Buffer; bytesDecompressed: number } | { reason: HeaderReadFailureReason; error: string; stats: HeaderIoStats }> {
    return new Promise((resolve) => {
      const parts: Buffer[] = []
      let total = 0
      let settled = false
      const finish = (result: { plaintext: Buffer; bytesDecompressed: number } | { reason: HeaderReadFailureReason; error: string; stats: HeaderIoStats }): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const abortWith = (reason: HeaderReadFailureReason, error: string, bytesDecompressed: number): void => {
        stream.destroy(new Error(error))
        finish({ reason, error, stats: { bytesCompressed: frame.length, bytesDecompressed } })
      }
      stream.on('data', (piece) => {
        if (settled) return
        total += piece.length
        if (total > ctx.maxDecompressed) {
          abortWith('limit', `header frame exceeds ${ctx.maxDecompressed} decompressed bytes`, total)
          return
        }
        if (ctx.signal?.aborted === true) {
          abortWith('aborted', 'header read aborted', total)
          return
        }
        if (ctx.now() > ctx.deadlineAt) {
          abortWith('limit', 'header decode exceeded time budget', total)
          return
        }
        parts.push(piece)
      })
      stream.on('end', () => {
        if (settled) return
        // end 分支也复限时限/中断（I1 r2）。
        if (ctx.signal?.aborted === true) {
          abortWith('aborted', 'header read aborted', total)
          return
        }
        if (ctx.now() > ctx.deadlineAt) {
          abortWith('limit', 'header decode exceeded time budget', total)
          return
        }
        finish({ plaintext: Buffer.concat(parts), bytesDecompressed: total })
      })
      stream.on('error', (error) => {
        if (settled) return
        if (ctx.signal?.aborted === true) {
          finish({ reason: 'aborted', error: 'header read aborted', stats: { bytesCompressed: frame.length, bytesDecompressed: total } })
          return
        }
        if (ctx.now() > ctx.deadlineAt) {
          finish({ reason: 'limit', error: 'header decode exceeded time budget', stats: { bytesCompressed: frame.length, bytesDecompressed: total } })
          return
        }
        finish({ reason: 'corrupt', error: `session ${sessionId}: first zstd frame failed to decode: ${error.message}`, stats: { bytesCompressed: frame.length, bytesDecompressed: total } })
      })
      stream.write(frame)
      stream.end()
    })
  }
}
