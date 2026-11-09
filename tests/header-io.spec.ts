/**
 * 有界会话头读取器。
 *
 * 取代旧收编扫描的整日志重放：分类/发现路径只读会话目录里最高规范
 * generation 的**首行头**（plain JSONL 首行；zstd 首个独立 frame），压缩输入、
 * 解压输出、时间三重封顶；future generation 关死（不回落旧代）；头按
 * id/type/version/id 校验，坏头不能冒充别的会话。全部用真实 tmp FS
 * 夹具驱动（2026-11-08 取证：宿主 readFirstLine/readFirstZstdLine/
 * resolveGenerationInDirectory，/tmp/dsh_extract/jsonl-index.js）。
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

import {
  MAX_KNOWN_SESSION_VERSION,
  SessionHeaderReader,
  decodeSegment,
  defaultHeaderIoDeps,
  encodeSegment,
  parseGenerationFilename,
} from '../src/host/session/header-io.ts'

const zstdCompressAsync = promisify(zstdCompress) as (input: Buffer, options?: { params?: Record<string, number> }) => Promise<Buffer>

/** 真正开启 checksum 的 zstd 压缩（M2：Node 用 params[ZSTD_c_checksumFlag]=1；`{checksum:true}` 不生效）。 */
const zstdCompressChecksummed = (input: Buffer): Promise<Buffer> =>
  zstdCompressAsync(input, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
const zstdDecompressAsync = promisify(zstdDecompress) as (input: Buffer) => Promise<Buffer>

/* ────────────────────────── 夹具 ────────────────────────── */

let roots: string[] = []
async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'router-header-io-'))
  roots.push(root)
  return root
}
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

/** 会话头行（v1-v4 形状；字段取舍同宿主 isHeaderLine）。 */
function headerLine(fields: {
  id: string
  version: number
  createdAt?: number
  isSeeded?: boolean
  delegationDepth?: number
  agentPreset?: string
  cwd?: string
  extra?: Record<string, unknown>
  drop?: string[]
}): string {
  const record: Record<string, unknown> = {
    type: 'session',
    version: fields.version,
    id: fields.id,
    createdAt: fields.createdAt ?? 1_700_000_000_000,
    ...(fields.isSeeded === undefined ? { isSeeded: false } : { isSeeded: fields.isSeeded }),
    delegationDepth: fields.delegationDepth ?? 0,
    ...(fields.agentPreset === undefined ? {} : { agentPreset: fields.agentPreset }),
    ...(fields.cwd === undefined ? {} : { cwd: fields.cwd }),
    ...(fields.extra ?? {}),
  }
  for (const key of fields.drop ?? []) delete record[key]
  return JSON.stringify(record)
}

/** v0 头行（isSeeded 缺席、seedLength 可选）。 */
function v0HeaderLine(fields: { id: string; seedLength?: number; agentPreset?: string }): string {
  return JSON.stringify({
    type: 'session',
    version: 0,
    id: fields.id,
    createdAt: 1_700_000_000_000,
    delegationDepth: 0,
    ...(fields.seedLength === undefined ? {} : { seedLength: fields.seedLength }),
    ...(fields.agentPreset === undefined ? {} : { agentPreset: fields.agentPreset }),
  })
}

/** 事件行（正文样本，撑大日志用）。 */
function eventLine(seq: number): string {
  return JSON.stringify({ type: 'user/message', seq, time: 1_700_000_000_000, data: { text: 'x'.repeat(600) } })
}

/** 写一个会话目录（files：文件名 → 内容 Buffer/字符串）。 */
async function writeSession(
  root: string,
  sessionId: string,
  files: Record<string, string | Buffer>,
  projectDirName = '--proj--',
): Promise<string> {
  const dir = join(root, projectDirName, encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
  return dir
}

/** 整个日志（头行 + N 条事件行）压成逐行独立 zstd frame。 */
async function zstdLog(lines: string[], options?: { checksum?: boolean }): Promise<Buffer> {
  const frames: Buffer[] = []
  for (const line of lines) {
    frames.push(
      options?.checksum === true
        ? await zstdCompressChecksummed(Buffer.from(`${line}\n`))
        : await zstdCompressAsync(Buffer.from(`${line}\n`)),
    )
  }
  return Buffer.concat(frames)
}

const reader = new SessionHeaderReader()

/* ────────────────────────── 路径段编码 ────────────────────────── */

describe('encodeSegment/decodeSegment：路径段安全', () => {
  it('安全字符原样保留，往返恒等（UUID 形会话 id）', () => {
    const id = 'session-5db67b2a-9f0a-4c1e-8c21-0a1b2c3d4e5f'
    expect(encodeSegment(id)).toBe(id)
    expect(decodeSegment(encodeSegment(id))).toBe(id)
  })

  it('遍历载体被中和：段内无分隔符、不为 . / ..，往返仍恒等', () => {
    for (const hostile of ['..', '.', '../..', 'a/b', 'a\\b', 'x\0y', '~', '围栏']) {
      const encoded = encodeSegment(hostile)
      expect(encoded).not.toMatch(/[/\\]/)
      expect(encoded).not.toBe('.')
      expect(encoded).not.toBe('..')
      expect(encoded.includes('\0')).toBe(false)
      expect(decodeSegment(encoded)).toBe(hostile)
    }
  })

  it('decodeSegment 只认合法转义：坏转义/裸波浪线外字符拒绝（undefined）', () => {
    expect(decodeSegment('~0041')).toBe('A')
    expect(decodeSegment('~00zz')).toBeUndefined()
    expect(decodeSegment('~41')).toBeUndefined()
    expect(decodeSegment('abc~')).toBeUndefined()
  })
})

/* ────────────────────────── generation 文件名 ────────────────────────── */

describe('parseGenerationFilename/pickGeneration：最高规范 generation', () => {
  it('session.v4.jsonl.zstd → v4 zstd；session.jsonl → v0 plain；lock 忽略', () => {
    expect(parseGenerationFilename('session.v4.jsonl.zstd')).toEqual({ name: 'session.v4.jsonl.zstd', version: 4, zstd: true })
    expect(parseGenerationFilename('session.v3.jsonl')).toEqual({ name: 'session.v3.jsonl', version: 3, zstd: false })
    expect(parseGenerationFilename('session.jsonl')).toEqual({ name: 'session.jsonl', version: 0, zstd: false })
    expect(parseGenerationFilename('session.jsonl.zstd')).toEqual({ name: 'session.jsonl.zstd', version: 0, zstd: true })
    expect(parseGenerationFilename('session.lock')).toBeUndefined()
    expect(parseGenerationFilename('session.v4.jsonl.zstd.tmp')).toBeUndefined()
  })

  it('非规范名不识别 generation：前导零、v0 标记名、大写 V', () => {
    expect(parseGenerationFilename('session.v04.jsonl.zstd')).toBeUndefined()
    expect(parseGenerationFilename('session.v0.jsonl.zstd')).toBeUndefined()
    expect(parseGenerationFilename('session.V4.jsonl.zstd')).toBeUndefined()
    expect(parseGenerationFilename('session.v4.jsonl.zstd~')).toBeUndefined()
  })
})

/* ────────────────────────── 首行读取（有界） ────────────────────────── */

describe('SessionHeaderReader：plain JSONL 首行读取', () => {
  it('读首行即停：大正文只花一个 chunk 的字节（v4 头 facts 完整）', async () => {
    const root = await tmpRoot()
    const id = 's-plain-big'
    const body = Array.from({ length: 4_000 }, (_, i) => eventLine(i)).join('\n')
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4, agentPreset: 'dsh-router' })}\n${body}\n` })
    const dir = join(root, '--proj--', id)
    const outcome = await reader.readSessionHeader(dir, id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.header).toEqual({ version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false, agentPreset: 'dsh-router' })
    expect(outcome.stats.bytesCompressed).toBeLessThanOrEqual(8_192)
    expect(outcome.stats.bytesCompressed).toBeLessThan(body.length / 10)
  })

  it('v0 后缀名 session.jsonl：seedLength 存在即 seeded', async () => {
    const root = await tmpRoot()
    const id = 's-v0'
    await writeSession(root, id, { 'session.jsonl': `${v0HeaderLine({ id, seedLength: 3 })}\n` })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.header.isSeeded).toBe(true)
    expect(outcome.header.version).toBe(0)
  })

  it('v0 无 seedLength：isSeeded=false', async () => {
    const root = await tmpRoot()
    const id = 's-v0-unseeded'
    await writeSession(root, id, { 'session.jsonl': `${v0HeaderLine({ id })}\n` })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.header.isSeeded).toBe(false)
  })

  it('更高 generation 优先：v4 与 v3 并存读 v4', async () => {
    const root = await tmpRoot()
    const id = 's-mixed-gen'
    await writeSession(root, id, {
      'session.v3.jsonl': `${headerLine({ id, version: 3, isSeeded: false })}\n`,
      'session.v4.jsonl': `${headerLine({ id, version: 4, agentPreset: 'dsh-router' })}\n`,
    })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.header.version).toBe(4)
    expect(outcome.header.agentPreset).toBe('dsh-router')
  })

  it('同版本双编码并存：ambiguous 关死', async () => {
    const root = await tmpRoot()
    const id = 's-ambiguous'
    await writeSession(root, id, {
      'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n`,
      'session.v4.jsonl.zstd': await zstdLog([headerLine({ id, version: 4 })]),
    })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('ambiguous')
  })

  it('目录缺席/无 generation 文件：missing', async () => {
    const root = await tmpRoot()
    const id = 's-gone'
    expect((await reader.readSessionHeader(join(root, '--proj--', id), id)).ok).toBe(false)
    const empty = await writeSession(root, 's-empty', { 'session.lock': '' })
    const outcome = await reader.readSessionHeader(empty, 's-empty')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('missing')
  })
})

describe('SessionHeaderReader：zstd 首独立 frame 读取', () => {
  it('只解首 frame：大日志的压缩输入有界（后续 frame 不读不解）', async () => {
    const root = await tmpRoot()
    const id = 's-zstd-big'
    const log = await zstdLog([headerLine({ id, version: 4, agentPreset: 'dsh-router' }), ...Array.from({ length: 2_000 }, (_, i) => eventLine(i))])
    await writeSession(root, id, { 'session.v4.jsonl.zstd': log })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.header.agentPreset).toBe('dsh-router')
    expect(outcome.stats.bytesCompressed).toBeLessThanOrEqual(16_384)
    expect(outcome.stats.bytesCompressed).toBeLessThan(log.length / 10)
    expect(outcome.stats.bytesDecompressed).toBeLessThanOrEqual(2_048)
  })

  it('带 checksum 的 frame（宿主写法，真实开启）同样可读', async () => {
    const root = await tmpRoot()
    const id = 's-zstd-checksum'
    const log = await zstdLog([headerLine({ id, version: 4 })], { checksum: true })
    // 夹具自证：帧描述符的 checksum 位真的开着（M2：{checksum:true} 并不生效）
    expect(log.readUInt8(4) & 4).toBe(4)
    await writeSession(root, id, { 'session.v4.jsonl.zstd': log })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id)
    expect(outcome.ok).toBe(true)
  })

  it('zstd 解出的是独立 frame 的明文行：坏 magic/截断 frame 按 corrupt/limit 关死', async () => {
    const root = await tmpRoot()
    const idBad = 's-zstd-badmagic'
    await writeSession(root, idBad, { 'session.v4.jsonl.zstd': Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.alloc(64, 1)]) })
    const bad = await reader.readSessionHeader(join(root, '--proj--', idBad), idBad)
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.reason).toBe('corrupt')

    // 首个 frame 未完结且输入封顶小于已读字节 → limit（不读完整个文件）
    const idTorn = 's-zstd-torn'
    const frame = await zstdCompressAsync(Buffer.from(`${headerLine({ id: idTorn, version: 4 })}\n`))
    await writeSession(root, idTorn, { 'session.v4.jsonl.zstd': frame.subarray(0, frame.length - 3) })
    const torn = await reader.readSessionHeader(join(root, '--proj--', idTorn), idTorn, {
      maxCompressedBytes: Math.max(8, Math.floor(frame.length / 2)),
    })
    expect(torn.ok).toBe(false)
    if (torn.ok) return
    expect(torn.reason).toBe('limit')

    // 文件比封顶小、读到 EOF 仍无完整 frame → corrupt
    const idShort = 's-zstd-short'
    await writeSession(root, idShort, { 'session.v4.jsonl.zstd': frame.subarray(0, 10) })
    const short = await reader.readSessionHeader(join(root, '--proj--', idShort), idShort)
    expect(short.ok).toBe(false)
    if (short.ok) return
    expect(short.reason).toBe('corrupt')
  })

  it('首 frame 不是恰一行（多行/无尾换行）：corrupt', async () => {
    const root = await tmpRoot()
    const idMulti = 's-zstd-multi'
    await writeSession(root, idMulti, {
      'session.v4.jsonl.zstd': await zstdLog([headerLine({ id: idMulti, version: 4 }), eventLine(0)]),
    })
    // 首行+事件同 frame：把两行压进一个 frame
    await rm(join(root, '--proj--', encodeSegment(idMulti)), { recursive: true, force: true })
    const twoLineFrame = await zstdCompressAsync(Buffer.from(`${headerLine({ id: idMulti, version: 4 })}\n${eventLine(0)}\n`))
    await writeSession(root, idMulti, { 'session.v4.jsonl.zstd': twoLineFrame })
    const multi = await reader.readSessionHeader(join(root, '--proj--', idMulti), idMulti)
    expect(multi.ok).toBe(false)
    if (multi.ok) return
    expect(multi.reason).toBe('corrupt')

    const idNoNl = 's-zstd-nonl'
    const noNlFrame = await zstdCompressAsync(Buffer.from(headerLine({ id: idNoNl, version: 4 })))
    await writeSession(root, idNoNl, { 'session.v4.jsonl.zstd': noNlFrame })
    const noNl = await reader.readSessionHeader(join(root, '--proj--', idNoNl), idNoNl)
    expect(noNl.ok).toBe(false)
    if (noNl.ok) return
    expect(noNl.reason).toBe('corrupt')
  })
})

/* ────────────────────────── future generation 与头校验 ────────────────────────── */

describe('SessionHeaderReader：future generation 关死（不回落旧代）', () => {
  it('只有 v5：future-format；v5 与 v4 并存同样 future-format', async () => {
    const root = await tmpRoot()
    const idOnly = 's-future-only'
    await writeSession(root, idOnly, { [`session.v${MAX_KNOWN_SESSION_VERSION + 1}.jsonl`]: `${headerLine({ id: idOnly, version: MAX_KNOWN_SESSION_VERSION + 1 })}\n` })
    const only = await reader.readSessionHeader(join(root, '--proj--', idOnly), idOnly)
    expect(only.ok).toBe(false)
    if (only.ok) return
    expect(only.reason).toBe('future-format')

    const idBoth = 's-future-both'
    await writeSession(root, idBoth, {
      'session.v4.jsonl': `${headerLine({ id: idBoth, version: 4 })}\n`,
      [`session.v${MAX_KNOWN_SESSION_VERSION + 1}.jsonl`]: `${headerLine({ id: idBoth, version: MAX_KNOWN_SESSION_VERSION + 1 })}\n`,
    })
    const both = await reader.readSessionHeader(join(root, '--proj--', idBoth), idBoth)
    expect(both.ok).toBe(false)
    if (both.ok) return
    expect(both.reason).toBe('future-format')
  })
})

describe('SessionHeaderReader：头形状校验（坏头不能冒充别的会话）', () => {
  async function outcomeFor(id: string, content: string, name = 'session.v4.jsonl', expectedId = id) {
    const root = await tmpRoot()
    await writeSession(root, id, { [name]: content })
    return reader.readSessionHeader(join(root, '--proj--', id), expectedId)
  }

  it('id 与目录不符：corrupt（不能选/归档无关会话）', async () => {
    const outcome = await outcomeFor('s-a', `${headerLine({ id: 's-OTHER', version: 4 })}\n`)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
    expect(outcome.message).toContain('s-OTHER')
  })

  it('version 与文件名不符：corrupt', async () => {
    const outcome = await outcomeFor('s-b', `${headerLine({ id: 's-b', version: 3 })}\n`)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
  })

  it('type 不是 session / 非对象 / 非 JSON：corrupt', async () => {
    for (const content of [
      `${JSON.stringify({ type: 'user/message', version: 4, id: 's-c', createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`,
      `not-json\n`,
      `[]\n`,
    ]) {
      const outcome = await outcomeFor('s-c', content)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('corrupt')
    }
  })

  it('缺必需字段（v4 缺 isSeeded）：corrupt', async () => {
    const outcome = await outcomeFor('s-d', `${headerLine({ id: 's-d', version: 4, drop: ['isSeeded'] })}\n`)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
  })

  it('未知字段：corrupt（fail closed，不猜测语义）', async () => {
    const outcome = await outcomeFor('s-e', `${headerLine({ id: 's-e', version: 4, extra: { mystery: 1 } })}\n`)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
  })

  it('createdAt 非法（负数/小数/字符串）：corrupt', async () => {
    for (const createdAt of [-1, 1.5, 'x'] as unknown[]) {
      const outcome = await outcomeFor('s-f', `${headerLine({ id: 's-f', version: 4, createdAt: createdAt as number })}\n`)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('corrupt')
    }
  })

  it('v1-v4 不接受 seedLength；v0 不接受 isSeeded：corrupt', async () => {
    const v4withSeed = await outcomeFor('s-g', `${headerLine({ id: 's-g', version: 4, extra: { seedLength: 2 } })}\n`)
    expect(v4withSeed.ok).toBe(false)
    const v0withIsSeeded = await outcomeFor('s-h', `${JSON.stringify({ type: 'session', version: 0, id: 's-h', createdAt: 1, delegationDepth: 0, isSeeded: false })}\n`, 'session.jsonl')
    expect(v0withIsSeeded.ok).toBe(false)
  })

  it('plain 无换行/空文件：corrupt（无完整首行）', async () => {
    const noNl = await outcomeFor('s-i', headerLine({ id: 's-i', version: 4 }))
    expect(noNl.ok).toBe(false)
    if (noNl.ok) return
    expect(noNl.reason).toBe('corrupt')
    const empty = await outcomeFor('s-j', '')
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.reason).toBe('corrupt')
  })
})

/* ────────────────────────── 封顶与降级 ────────────────────────── */

describe('SessionHeaderReader：封顶是实际执行上限（I1 回归）', () => {
  it('输入配额在读取前生效：cap 小于首行长度 → limit（不因换行落在首 chunk 内而放行）', async () => {
    const root = await tmpRoot()
    const id = 's-tiny-input-cap'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id, { maxCompressedBytes: 8 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    expect(outcome.stats.bytesCompressed).toBeLessThanOrEqual(8)
  })

  it('zstd 高压缩比炸弹：流式解压在输出上限处停住并销毁 decoder（不整块分配）', async () => {
    const root = await tmpRoot()
    const id = 's-zstd-bomb'
    // ~1MB 全零明文 → 压缩后很小的 frame；输出上限 4KB 必须在流中打断。
    const bomb = await zstdCompressAsync(Buffer.concat([Buffer.from(`${headerLine({ id, version: 4 })}\n`), Buffer.alloc(1_048_576)]))
    expect(bomb.length).toBeLessThan(2_000)
    await writeSession(root, id, { 'session.v4.jsonl.zstd': bomb })
    let destroyed = false
    const spyingZstd = {
      createStream() {
        const real = defaultHeaderIoDeps().zstd!.createStream()
        return {
          on: real.on.bind(real),
          write: (chunk: Buffer) => real.write(chunk),
          end: () => real.end(),
          destroy: (error?: Error) => {
            destroyed = true
            real.destroy(error)
          },
        }
      },
    }
    const bombReader = new SessionHeaderReader({ ...defaultHeaderIoDeps(), zstd: spyingZstd as never })
    const outcome = await bombReader.readSessionHeader(join(root, '--proj--', id), id, { maxDecompressedBytes: 4_096 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    expect(destroyed).toBe(true)
  })

  it('慢速最终 read：deadline 在 await 返回后也生效（limit，不是 ok）', async () => {
    const root = await tmpRoot()
    const id = 's-slow-read'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let readCount = 0
    let firstReadDone = false
    const startAt = 1_000_000
    const slowReader = new SessionHeaderReader({
      ...base,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
            readCount += 1
            if (readCount === 1) {
              // 首块延迟：读取前 gate 通过、返回后时钟越过 deadline，必须复查。
              await new Promise((resolve) => setTimeout(resolve, 10))
              firstReadDone = true
            }
            return handle.read(buffer, offset, length, position)
          },
          close: () => handle.close(),
        }
      },
    })
    const outcome = await slowReader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: startAt,
      now: () => (firstReadDone ? startAt + 1_000 : startAt),
      // 本用例检验 read 返回后的复查路径：timer 不触发（真·唤醒由 I1 r2 组覆盖）。
      timer: { set: () => () => undefined },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    // 读取本身完成了（post-await 复查才拦下），证明走的是「返回后复查」路径。
    expect(readCount).toBeGreaterThanOrEqual(1)
  })

  it('慢速 codec：deadline 到点销毁流（limit）并关闭文件句柄', async () => {
    const root = await tmpRoot()
    const id = 's-slow-codec'
    const frame = await zstdCompressAsync(Buffer.from(`${headerLine({ id, version: 4 })}\n`))
    await writeSession(root, id, { 'session.v4.jsonl.zstd': frame })
    const base = defaultHeaderIoDeps()
    let streamDestroyed = false
    let handleClosed = false
    let codecStarted = false
    const startAt = 1_000_000
    const gatedZstd = {
      createStream() {
        const real = base.zstd!.createStream()
        return {
          on: real.on.bind(real),
          // 数据喂入 = codec 开始：此后 now() 越过 deadline。
          write: (chunk: Buffer) => {
            codecStarted = true
            real.write(chunk)
          },
          end: () => real.end(),
          destroy: (error?: Error) => {
            streamDestroyed = true
            real.destroy(error)
          },
        }
      },
    }
    const slowReader = new SessionHeaderReader({
      ...base,
      zstd: gatedZstd as never,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: (buffer: Buffer, offset: number, length: number, position: number | null) => handle.read(buffer, offset, length, position),
          close: async () => {
            handleClosed = true
            await handle.close()
          },
        }
      },
    })
    const outcome = await slowReader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: startAt,
      now: () => (codecStarted ? startAt + 1_000 : startAt),
      // 本用例检验解码事件内的时限复查（r2 之前的行为面）：timer 不触发，
      // 真·到期唤醒由「I1 r2」组的真实计时用例覆盖。
      timer: { set: () => () => undefined },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    expect(streamDestroyed).toBe(true)
    expect(handleClosed).toBe(true)
  })

  it('aborted 在解压途中：销毁流、关闭句柄、回 aborted', async () => {
    const root = await tmpRoot()
    const id = 's-abort-mid-codec'
    const frame = await zstdCompressAsync(Buffer.from(`${headerLine({ id, version: 4 })}\n`))
    await writeSession(root, id, { 'session.v4.jsonl.zstd': frame })
    const base = defaultHeaderIoDeps()
    let streamDestroyed = false
    const signal = { aborted: false }
    const hangingZstd = {
      createStream() {
        const real = base.zstd!.createStream()
        return {
          on: real.on.bind(real),
          write: (chunk: Buffer) => {
            real.write(chunk)
            // 数据已喂入但流挂着不出结果；随后外部置 aborted。
            signal.aborted = true
          },
          end: () => real.end(),
          destroy: (error?: Error) => {
            streamDestroyed = true
            real.destroy(error)
          },
        }
      },
    }
    const abortReader = new SessionHeaderReader({ ...base, zstd: hangingZstd as never })
    const outcome = await abortReader.readSessionHeader(join(root, '--proj--', id), id, { signal })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('aborted')
    expect(streamDestroyed).toBe(true)
  })
})

describe('SessionHeaderReader：输入/输出/时间封顶与降级', () => {
  it('首行超过解压输出上限：limit', async () => {
    const root = await tmpRoot()
    const id = 's-long-line'
    const padded = `${headerLine({ id, version: 4 })} ${' '.repeat(80_000)}`
    await writeSession(root, id, { 'session.v4.jsonl': `${padded}\n` })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id, { maxDecompressedBytes: 4_096 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
  })

  it('plain 首行迟迟不出现，压缩输入超上限：limit（不读完整个文件）', async () => {
    const root = await tmpRoot()
    const id = 's-no-newline-big'
    await writeSession(root, id, { 'session.v4.jsonl': 'x'.repeat(300_000) })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id, { maxCompressedBytes: 4_096 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    expect(outcome.stats.bytesCompressed).toBeLessThanOrEqual(4_096 + 8_192)
  })

  it('时间封顶：超时的下一次 chunk 读取前放弃（limit）', async () => {
    const root = await tmpRoot()
    const id = 's-slow'
    // 首行无换行且不超字节上限 → 只能靠时间封顶停住。
    await writeSession(root, id, { 'session.v4.jsonl': 'x'.repeat(20_000) })
    let ticks = 0
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id, {
      maxCompressedBytes: 1_000_000,
      now: () => {
        ticks += 1
        return ticks <= 1 ? 0 : 10_000_000
      },
      deadlineAt: 1_000,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
  })

  it('zstd 能力缺席：unsupported（降级可报告，不抛）', async () => {
    const root = await tmpRoot()
    const id = 's-no-zstd'
    await writeSession(root, id, { 'session.v4.jsonl.zstd': await zstdLog([headerLine({ id, version: 4 })]) })
    const noZstdReader = new SessionHeaderReader({ ...defaultHeaderIoDeps(), zstd: undefined })
    const outcome = await noZstdReader.readSessionHeader(join(root, '--proj--', id), id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unsupported')
  })

  it('aborted 信号：中断读出（aborted），句柄关闭', async () => {
    const root = await tmpRoot()
    const id = 's-abort'
    await writeSession(root, id, { 'session.v4.jsonl': 'x'.repeat(20_000) })
    const signal = { aborted: false }
    const attempt = reader.readSessionHeader(join(root, '--proj--', id), id, {
      maxCompressedBytes: 1_000_000,
      signal,
    })
    signal.aborted = true
    const outcome = await attempt
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('aborted')
  })

  it('generation 文件是符号链接：关死（不跟出会话目录）', async () => {
    const root = await tmpRoot()
    const id = 's-symlink'
    const dir = await writeSession(root, id, {})
    const outside = join(root, 'outside.jsonl')
    await writeFile(outside, `${headerLine({ id, version: 4 })}\n`)
    await symlink(outside, join(dir, 'session.v4.jsonl'))
    const outcome = await reader.readSessionHeader(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
  })

  it('fs 层读失败（非 ENOENT）：unreadable（可重试的失败，不是损坏）', async () => {
    const root = await tmpRoot()
    const id = 's-eacces'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const failing = new SessionHeaderReader({
      ...defaultHeaderIoDeps(),
      readdir: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
    })
    const outcome = await failing.readSessionHeader(join(root, '--proj--', id), id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unreadable')
  })
})

/* ────────────────────────── I1 round2：pending IO 的真正到期唤醒 ────────────────────────── */

describe('SessionHeaderReader：挂起的 IO 由 timer/AbortSignal 及时打断（I1 r2）', () => {
  it('open 永久挂起：deadline 到点及时返回 limit（不等 IO）；迟到的句柄被关闭', async () => {
    const root = await tmpRoot()
    const id = 's-hang-open'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let lateHandle: { close(): Promise<void> } | undefined
    let handleClosed = false
    let releaseOpen: (() => void) | undefined
    const hangingReader = new SessionHeaderReader({
      ...base,
      open: () =>
        new Promise((resolve) => {
          releaseOpen = () => resolve({
            read: async () => ({ bytesRead: 0 }),
            close: async () => { handleClosed = true },
          })
        }) as never,
    })
    void lateHandle
    const t0 = Date.now()
    const outcome = await hangingReader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: t0 + 15,
      now: () => Date.now(),
    })
    expect(Date.now() - t0).toBeLessThan(900) // 真正及时，不是等 IO
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    releaseOpen!()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(handleClosed).toBe(true) // 迟到资源被清理
  })

  it('read 永久挂起：及时 limit（不等 read 自己返回）；迟到读落定后句柄被关闭一次', async () => {
    const root = await tmpRoot()
    const id = 's-hang-read'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let releaseRead: (() => void) | undefined
    let closeCalls = 0
    const hangingReader = new SessionHeaderReader({
      ...base,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: () => new Promise<{ bytesRead: number }>((resolve) => { releaseRead = () => resolve({ bytesRead: 0 }) }),
          close: async () => { closeCalls += 1; await handle.close() },
        }
      },
    })
    const t0 = Date.now()
    const outcome = await hangingReader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: t0 + 15,
      now: () => Date.now(),
    })
    expect(Date.now() - t0).toBeLessThan(900)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    // 夹具收尾：释放永不落定的读 → 迟到清理链关闭句柄（否则 fd 只能等 GC，
    // 会触发 Node 的 DEP0137 弃用告警）。
    releaseRead!()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(closeCalls).toBe(1)
    expect(hangingReader.ioInFlight()).toBe(0)
  })

  it('decoder 永不发事件：及时 limit 且流被销毁', async () => {
    const root = await tmpRoot()
    const id = 's-hang-codec'
    const frame = await zstdCompressAsync(Buffer.from(`${headerLine({ id, version: 4 })}\n`))
    await writeSession(root, id, { 'session.v4.jsonl.zstd': frame })
    const base = defaultHeaderIoDeps()
    let streamDestroyed = false
    const silentDecoder = {
      createStream: () => {
        const listeners: Record<string, ((arg?: unknown) => void)[]> = {}
        return {
          on: (event: string, listener: (arg?: unknown) => void) => { (listeners[event] ??= []).push(listener) },
          write: () => {},
          end: () => {},
          // 真实 zlib 的 destroy 会发 error —— 夹具必须同款，否则解码 promise
          // 永不落定、句柄只能等 GC 关闭（Node DEP0137 告警）。
          destroy: () => {
            streamDestroyed = true
            for (const listener of listeners['error'] ?? []) listener(new Error('stream destroyed'))
          },
        }
      },
    }
    const hangingReader = new SessionHeaderReader({ ...base, zstd: silentDecoder as never })
    const t0 = Date.now()
    const outcome = await hangingReader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: t0 + 15,
      now: () => Date.now(),
    })
    expect(Date.now() - t0).toBeLessThan(900)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    expect(streamDestroyed).toBe(true)
  })

  it('createStream 同步抛错：归 unreadable 而非 aborted（审查修复：aborted 会被索引当瞬态重排队首，损坏会话饿死队列）', async () => {
    const root = await tmpRoot()
    const id = 's-codec-throw'
    const frame = await zstdCompressAsync(Buffer.from(`${headerLine({ id, version: 4 })}\n`))
    await writeSession(root, id, { 'session.v4.jsonl.zstd': frame })
    const base = defaultHeaderIoDeps()
    const reader = new SessionHeaderReader({
      ...base,
      zstd: { createStream: () => { throw new Error('codec unavailable') } } as never,
    })
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: Date.now() + 5_000,
      now: () => Date.now(),
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unreadable')
    expect(outcome.message).toContain('codec unavailable')
  })

  it('AbortSignal 中止在途 open：及时 aborted（真实 addEventListener 通道）', async () => {
    const root = await tmpRoot()
    const id = 's-abort-open'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    const controller = new AbortController()
    const hangingReader = new SessionHeaderReader({
      ...base,
      open: () => new Promise<never>(() => {}) as never,
    })
    const t0 = Date.now()
    const pending = hangingReader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: t0 + 5_000,
      now: () => Date.now(),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 20)
    const outcome = await pending
    expect(Date.now() - t0).toBeLessThan(900)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('aborted')
  })

  it('迟到的 open rejection 不产生 unhandledRejection', async () => {
    const root = await tmpRoot()
    const id = 's-late-reject'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let releaseOpen: (() => void) | undefined
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const lateRejectReader = new SessionHeaderReader({
        ...base,
        open: () =>
          new Promise((_resolve, reject) => {
            releaseOpen = () => reject(new Error('late open failure'))
          }) as never,
      })
      const t0 = Date.now()
      const outcome = await lateRejectReader.readSessionHeader(join(root, '--proj--', id), id, {
        deadlineAt: t0 + 10,
        now: () => Date.now(),
      })
      expect(outcome.ok).toBe(false)
      releaseOpen!()
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

/* ────────────────────────── I1 r3：有限在途槽位（真实 outstanding 有界） ────────────────────────── */

describe('SessionHeaderReader：IO 槽位让连续超时的真实 outstanding 有界（I1 r3）', () => {
  it('容量 2 + 12 次连续挂起 open：outstanding ≤2、其余快速 limit、无排队增长；释放后槽位归还', async () => {
    const root = await tmpRoot()
    const id = 's-budget'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let openStarts = 0
    let openSettles = 0
    const releases: Array<() => void> = []
    const outstanding = (): number => openStarts - openSettles
    const reader = new SessionHeaderReader(
      {
        ...base,
        open: () => {
          openStarts += 1
          return new Promise((resolve) => {
            releases.push(() => {
              openSettles += 1
              resolve({ read: async () => ({ bytesRead: 0 }), close: async () => {} })
            })
          }) as never
        },
      },
      { ioCapacity: 2 },
    )
    const outcomes: Array<{ reason?: string; ok: boolean }> = []
    for (let i = 0; i < 12; i += 1) {
      const t0 = Date.now()
      const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id, {
        // 期限给到 60ms：2ms 在并行负载下会让 readdir/lstat 先到期（本用例要
        // 的是「open 挂起 → 额度占满 → 其余快速降级」，不是 readdir 超时）。
        deadlineAt: Date.now() + 60,
        now: () => Date.now(),
      })
      outcomes.push({ ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason })
      expect(Date.now() - t0).toBeLessThan(900) // 快速返回，不在内存排队等挂起 IO
    }
    // 只有前两次真正发起 open（占满 2 槽）；其余被快速降级，没有新 outstanding。
    expect(openStarts).toBe(2) // 只有占到槽的前两次真正发起 open
    expect(outstanding()).toBe(2)
    expect(outcomes.every((o) => o.reason === 'limit')).toBe(true) // 全部快速 limit（2 个到期 + 10 个满额）
    // 释放全部：迟到 open settle（含迟到 close 清理）→ 槽位归还。
    for (const release of releases.splice(0)) release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(outstanding()).toBe(0)
    expect(reader.ioInFlight()).toBe(0)
  })

  it('迟到的 close 清理也占槽：close 挂起时后续读取快速降级，不产生新 open', async () => {
    const root = await tmpRoot()
    const id = 's-late-close'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let openStarts = 0
    let releaseOpen: (() => void) | undefined
    let releaseClose: (() => void) | undefined
    const reader = new SessionHeaderReader(
      {
        ...base,
        open: () => {
          openStarts += 1
          return new Promise((resolve) => {
            releaseOpen = () =>
              resolve({
                read: async () => ({ bytesRead: 0 }),
                close: () => new Promise<void>((resolveClose) => { releaseClose = resolveClose }),
              })
          }) as never
        },
      },
      { ioCapacity: 1 },
    )
    const first = reader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: Date.now() + 10,
      now: () => Date.now(),
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    releaseOpen!()
    const outcome = await first
    expect(outcome.ok).toBe(false) // 超时 limit；open 迟到 settle → 迟到 close 启动
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(releaseClose).toBeDefined()
    expect(reader.ioInFlight()).toBe(1) // 迟到 close 占着唯一槽位
    const second = await reader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: Date.now() + 5,
      now: () => Date.now(),
    })
    expect(openStarts).toBe(1) // 没有新 open
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('limit')
    releaseClose!()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reader.ioInFlight()).toBe(0)
  })
})

/* ────────────────────────── I1 round4：额度先于 IO（lazy thunk） ────────────────────────── */

describe('SessionHeaderReader：额度先于 IO——满额时底层操作根本不启动（I1 r4）', () => {
  it('挂起的 readdir 占满额度后：后续读取不再启动新的 readdir（真实 outstanding ≤ 容量）', async () => {
    const root = await tmpRoot()
    const id = 's-cap-readdir'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let readdirStarts = 0
    const reader = new SessionHeaderReader(
      {
        ...base,
        readdir: () => {
          readdirStarts += 1
          return new Promise(() => {}) as never
        },
      },
      { ioCapacity: 2 },
    )
    for (let i = 0; i < 12; i += 1) {
      const t0 = Date.now()
      const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id, {
        deadlineAt: Date.now() + 2,
        now: () => Date.now(),
      })
      expect(outcome.ok).toBe(false)
      expect(Date.now() - t0).toBeLessThan(900)
    }
    // 真实在途 readdir 不超过容量：满额后**根本不启动**新的 readdir。
    expect(readdirStarts).toBe(2)
    expect(reader.ioInFlight()).toBe(2)
  })

  it('挂起的 open 占满额度后：后续读取不再启动新的 open（真实 outstanding ≤ 容量）', async () => {
    const root = await tmpRoot()
    const id = 's-cap-open'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let openStarts = 0
    const reader = new SessionHeaderReader(
      {
        ...base,
        open: () => {
          openStarts += 1
          return new Promise(() => {}) as never
        },
      },
      { ioCapacity: 2 },
    )
    for (let i = 0; i < 12; i += 1) {
      const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id, {
        deadlineAt: Date.now() + 5,
        now: () => Date.now(),
      })
      expect(outcome.ok).toBe(false)
    }
    expect(openStarts).toBe(2)
    expect(reader.ioInFlight()).toBe(2)
  })

  it('容量 1 也能完整读出头：句柄只关闭一次（不重复 close、不绕额度）', async () => {
    const root = await tmpRoot()
    const id = 's-cap-one'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let closeCalls = 0
    const reader = new SessionHeaderReader(
      {
        ...base,
        open: async (path) => {
          const handle = await base.open(path)
          return {
            read: handle.read.bind(handle),
            close: async () => {
              closeCalls += 1
              await handle.close()
            },
          }
        },
      },
      { ioCapacity: 1 },
    )
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id)
    expect(outcome.ok).toBe(true)
    expect(closeCalls).toBe(1)
    expect(reader.ioInFlight()).toBe(0)
  })

  it('容量 1 + 挂起的 read：迟到读落定后句柄只关闭一次（不重复 close、不与迟到读并发占同一槽位）', async () => {
    const root = await tmpRoot()
    const id = 's-cap-read'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    let closeCalls = 0
    let releaseRead: (() => void) | undefined
    const reader = new SessionHeaderReader(
      {
        ...base,
        open: async (path) => {
          const handle = await base.open(path)
          return {
            read: () =>
              new Promise<{ bytesRead: number }>((resolve) => {
                releaseRead = () => resolve({ bytesRead: 0 })
              }),
            close: async () => {
              closeCalls += 1
              await handle.close()
            },
          }
        },
      },
      { ioCapacity: 1 },
    )
    const outcome = await reader.readSessionHeader(join(root, '--proj--', id), id, {
      deadlineAt: Date.now() + 10,
      now: () => Date.now(),
    })
    expect(outcome.ok).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 迟到读仍在途：不与它并发占用同一个槽位（额度 1 不得被绕过）。
    expect(closeCalls).toBe(0)
    releaseRead!()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(closeCalls).toBe(1) // 只关一次
    expect(reader.ioInFlight()).toBe(0)
  })

  it('额度耗尽时不启动的 IO 不产生 unhandledRejection（被降级的那次 readdir 根本不该跑）', async () => {
    const root = await tmpRoot()
    const id = 's-cap-unhandled'
    await writeSession(root, id, { 'session.v4.jsonl': `${headerLine({ id, version: 4 })}\n` })
    const base = defaultHeaderIoDeps()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let readdirCalls = 0
      const reader = new SessionHeaderReader(
        {
          ...base,
          readdir: () => {
            readdirCalls += 1
            if (readdirCalls === 1) return new Promise(() => {}) as never
            // 第二次（额度已满时本不该启动）：迟到失败。
            return new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error('late readdir failure')), 20)
            }) as never
          },
        },
        { ioCapacity: 1 },
      )
      const dir = join(root, '--proj--', id)
      const first = await reader.readSessionHeader(dir, id, { deadlineAt: Date.now() + 5, now: () => Date.now() })
      expect(first.ok).toBe(false)
      const second = await reader.readSessionHeader(dir, id, { deadlineAt: Date.now() + 5, now: () => Date.now() })
      expect(second.ok).toBe(false)
      expect(readdirCalls).toBe(1) // 满额时根本不启动第二次 readdir
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
