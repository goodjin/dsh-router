/**
 * 冷会话小日志有界流式扫描（stable-EOF 扫描）。
 *
 * 对当前 v4 unseeded 小日志做「读到稳定 EOF」的有界流式扫描：跟踪
 * agent-preset/selected（**含 turn/start 之后**的——首 turn 不是安全封闭边界，
 * 已被宿主 select() 竞态证伪），EOF 时最后值即当前组合快照。封顶：输入
 * 256KiB / 解压 1MiB / 4096 行 / 单行 64KiB / 2s；超限、torn、坏信封、seq
 * 缺口、legacy/future、读中不稳定（前后 lstat + 打开句柄 fstat 身份一致 +
 * 读满 size）一律关死。全部真实 tmp plain/zstd 夹具。
 */

import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

import { IoBudget, SessionHeaderReader, defaultHeaderIoDeps, encodeSegment, type HeaderIoDeps } from '../src/host/session/header-io.ts'

const zstdCompressAsync = promisify(zstdCompress) as (input: Buffer, options?: { params?: Record<string, number> }) => Promise<Buffer>

/**
 * 真正开启 checksum 的 zstd 压缩（M2）：Node 的 zstd 用
 * `params[constants.ZSTD_c_checksumFlag]=1`；`{checksum:true}` **不生效**
 * （帧描述符的 checksum 位仍为 0）——旧夹具声称「checksum 开」其实没开。
 */
const zstdCompressChecksummed = (input: Buffer): Promise<Buffer> =>
  zstdCompressAsync(input, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })

/** zstd 帧描述符的 checksum 位（真实开启时非 0）。 */
function frameChecksumBit(frame: Buffer): number {
  return frame.readUInt8(4) & 4
}

/* ────────────────────────── 夹具 ────────────────────────── */

let roots: string[] = []
async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'router-cold-scan-'))
  roots.push(root)
  return root
}
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

/** v4 头行。 */
function headerLine(fields: { id: string; createdAt?: number; agentPreset?: string; isSeeded?: boolean }): string {
  return JSON.stringify({
    type: 'session',
    version: 4,
    id: fields.id,
    createdAt: fields.createdAt ?? 1_700_000_000_000,
    isSeeded: fields.isSeeded ?? false,
    delegationDepth: 0,
    ...(fields.agentPreset === undefined ? {} : { agentPreset: fields.agentPreset }),
  })
}

/** 一般事件行（信封合法；type/data 可定制）。 */
function eventLine(seq: number, fields: { type?: string; data?: Record<string, unknown>; raw?: string } = {}): string {
  if (fields.raw !== undefined) return fields.raw
  return JSON.stringify({ type: fields.type ?? 'e/x', seq, time: 1, data: fields.data ?? {} })
}

function selectedLine(seq: number, agentPreset: string): string {
  return eventLine(seq, { type: 'agent-preset/selected', data: { agentPreset } })
}

function turnStartLine(seq: number, turn = 1): string {
  return eventLine(seq, { type: 'turn/start', data: { turn } })
}

/** 写一个会话目录（v4 plain 或 zstd）。返回会话目录路径与日志全文。 */
async function writeSession(
  root: string,
  sessionId: string,
  lines: string[],
  options: { zstd?: boolean; name?: string; checksum?: boolean } = {},
): Promise<{ dir: string; file: string; content: Buffer }> {
  const name = options.name ?? `session.v4.jsonl${options.zstd === true ? '.zstd' : ''}`
  const dir = join(root, '--proj--', encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  let content: Buffer
  if (options.zstd === true) {
    // 宿主形状：header 独立首帧；事件按批一帧（这里每行一帧或多行一帧均可）
    const compress = options.checksum === false
      ? (buf: Buffer): Promise<Buffer> => zstdCompressAsync(buf)
      : zstdCompressChecksummed
    const frames: Buffer[] = [await compress(Buffer.from(`${lines[0]!}\n`))]
    for (const line of lines.slice(1)) frames.push(await compress(Buffer.from(`${line}\n`)))
    content = Buffer.concat(frames)
  } else {
    content = Buffer.from(lines.map((line) => `${line}\n`).join(''))
  }
  await writeFile(join(dir, name), content)
  return { dir, file: join(dir, name), content }
}

/** 事件帧串联的 zstd 日志（可多行一帧，模拟宿主 append batch）。 */
async function writeZstdBatched(
  root: string,
  sessionId: string,
  batches: string[][],
): Promise<{ dir: string; content: Buffer }> {
  const dir = join(root, '--proj--', encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  const frames: Buffer[] = []
  for (const batch of batches) {
    frames.push(await zstdCompressChecksummed(Buffer.from(batch.map((line) => `${line}\n`).join(''))))
  }
  const content = Buffer.concat(frames)
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), content)
  return { dir, content }
}

const reader = new SessionHeaderReader()

/* ────────────────────────── 分类语义（selected 跟踪到最后） ────────────────────────── */

describe('ColdLogScan：plain JSONL 稳定 EOF 扫描', () => {
  it('无预设头 + selected router + turn/start + 正文：finalPreset=router，读满整个文件', async () => {
    const root = await tmpRoot()
    const id = 's-plain-basic'
    const lines = [
      headerLine({ id }),
      selectedLine(0, 'dsh-router'),
      turnStartLine(1),
      eventLine(2, { type: 'user/message', data: { text: 'hi' } }),
    ]
    const { dir, content } = await writeSession(root, id, lines)
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.finalPreset).toBe('dsh-router')
    expect(outcome.header.agentPreset).toBeUndefined()
    expect(outcome.header.createdAt).toBe(1_700_000_000_000)
    expect(outcome.stats.lines).toBe(3)
    expect(outcome.stats.bytesCompressed).toBe(content.length)
    expect(outcome.identity.size).toBe(content.length)
    expect(outcome.file.name).toBe('session.v4.jsonl')
    expect(outcome.file.zstd).toBe(false)
  })

  it('头 router + selected other → other；多次 selected 最后胜；turn/start 之后的 selected 照样生效（撤销的旧边界回归）', async () => {
    const root = await tmpRoot()
    const id = 's-plain-override'
    const { dir } = await writeSession(root, id, [
      headerLine({ id, agentPreset: 'dsh-router' }),
      selectedLine(0, 'other-preset'),
      turnStartLine(1),
      eventLine(2, { type: 'assistant/message', data: {} }),
      selectedLine(3, 'third-preset'), // 首 turn 之后：不得被「首 turn 封闭」忽略
      eventLine(4, { type: 'user/message', data: {} }),
    ])
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.finalPreset).toBe('third-preset')
  })

  it('仅头行的小日志：finalPreset = 头值 ?? null（当前快照语义）', async () => {
    const root = await tmpRoot()
    const withPreset = await writeSession(root, 's-only-preset', [headerLine({ id: 's-only-preset', agentPreset: 'dsh-router' })])
    const noPreset = await writeSession(root, 's-only-null', [headerLine({ id: 's-only-null' })])
    const a = await reader.scanSessionLog(withPreset.dir, 's-only-preset')
    const b = await reader.scanSessionLog(noPreset.dir, 's-only-null')
    expect(a.ok && a.finalPreset).toBe('dsh-router')
    expect(b.ok && b.finalPreset).toBe(null)
    expect(a.ok && a.stats.lines).toBe(0)
  })

  it('无 selected 的正文事件不改变头值', async () => {
    const root = await tmpRoot()
    const id = 's-plain-noop'
    const { dir } = await writeSession(root, id, [
      headerLine({ id, agentPreset: 'keep-me' }),
      turnStartLine(0),
      eventLine(1, { type: 'step/start', data: { turn: 1, step: 1 } }),
    ])
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok && outcome.finalPreset).toBe('keep-me')
  })
})

describe('ColdLogScan：zstd 串联独立帧', () => {
  it('header 独立首帧 + 多行事件帧（含 turn 后 selected，checksum 开）：finalPreset 正确', async () => {
    const root = await tmpRoot()
    const id = 's-zstd-batched'
    const { dir } = await writeZstdBatched(root, id, [
      [headerLine({ id })],
      [selectedLine(0, 'other-preset'), turnStartLine(1)],
      [selectedLine(2, 'dsh-router')],
      [eventLine(3, { type: 'user/message', data: {} })],
    ])
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.finalPreset).toBe('dsh-router')
    expect(outcome.stats.lines).toBe(4)
    expect(outcome.stats.bytesCompressed).toBeGreaterThan(0)
    expect(outcome.stats.bytesDecompressed).toBeGreaterThan(0)
    expect(outcome.file.zstd).toBe(true)
  })

  it('逐行一帧的 zstd：正常（header-io 夹具同款布局）', async () => {
    const root = await tmpRoot()
    const id = 's-zstd-line-frames'
    const { dir } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router')], { zstd: true })
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok && outcome.finalPreset).toBe('dsh-router')
  })
})

/* ────────────────────────── 关死：torn / 损坏 / 缺口 / 信封 ────────────────────────── */

describe('ColdLogScan：torn 与损坏输入关死为最终失败', () => {
  it('plain 尾行无换行（torn）→ corrupt', async () => {
    const root = await tmpRoot()
    const id = 's-torn-plain'
    const { dir } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router')])
    await writeFile(join(dir, 'session.v4.jsonl'), Buffer.concat([
      Buffer.from(`${headerLine({ id })}\n`),
      Buffer.from(selectedLine(0, 'dsh-router')), // 无结尾换行
    ]))
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
    expect(outcome.message).toMatch(/torn|trailing|newline/i)
  })

  it('zstd 尾部截断帧（torn frame）→ corrupt', async () => {
    const root = await tmpRoot()
    const id = 's-torn-zstd'
    const { dir, content } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router')], { zstd: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), content.subarray(0, content.length - 5))
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
  })

  it('坏 JSON 行 → corrupt', async () => {
    const root = await tmpRoot()
    const id = 's-bad-json'
    const { dir } = await writeSession(root, id, [headerLine({ id }), eventLine(0, { raw: '{@@@ not json' })])
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
  })

  it('seq 缺口（0 → 2）→ corrupt：不能假装没漏事件', async () => {
    const root = await tmpRoot()
    const id = 's-seq-gap'
    const { dir } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router'), selectedLine(2, 'other')])
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
    expect(outcome.message).toMatch(/seq/)
  })

  it('信封违规（未知字段 / time 非整数 / data 缺席）→ corrupt', async () => {
    const root = await tmpRoot()
    const idExtra = 's-env-extra'
    await writeSession(root, idExtra, [headerLine({ id: idExtra }), eventLine(0, { raw: JSON.stringify({ type: 'e/x', seq: 0, time: 1, data: {}, extra: 1 }) })])
    const idTime = 's-env-time'
    await writeSession(root, idTime, [headerLine({ id: idTime }), eventLine(0, { raw: JSON.stringify({ type: 'e/x', seq: 0, time: 1.5 }) })])
    const idData = 's-env-data'
    await writeSession(root, idData, [headerLine({ id: idData }), eventLine(0, { raw: JSON.stringify({ type: 'e/x', seq: 0, time: 1 }) })])
    for (const [id, dir] of [[idExtra, idExtra], [idTime, idTime], [idData, idData]] as const) {
      const outcome = await reader.scanSessionLog(join(root, '--proj--', encodeSegment(id)), id)
      expect(outcome.ok, id).toBe(false)
      if (!outcome.ok) expect(outcome.reason, id).toBe('corrupt')
    }
  })

  it('selected 载荷非字符串 → corrupt（不得采用半坏的选择事件）', async () => {
    const root = await tmpRoot()
    const id = 's-bad-selected'
    const { dir } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router'), eventLine(1, { type: 'agent-preset/selected', data: { agentPreset: 42 } })])
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('corrupt')
  })

  it('头 id 与会话不符 → corrupt；头后跟的不是事件而是另一个头 → corrupt', async () => {
    const root = await tmpRoot()
    const id = 's-id-scope'
    const { dir } = await writeSession(root, id, [headerLine({ id: 'someone-else' })])
    const mismatch = await reader.scanSessionLog(dir, id)
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.reason).toBe('corrupt')
    const doubleHeader = await writeSession(root, 's-double-header', [headerLine({ id: 's-double-header' }), headerLine({ id: 's-double-header' })])
    const dup = await reader.scanSessionLog(doubleHeader.dir, 's-double-header')
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toBe('corrupt')
  })

  it('legacy（v0/v3）与 future（v5）与同版本双编码 → unsupported / future-format / ambiguous', async () => {
    const root = await tmpRoot()
    const v3dir = join(root, '--proj--', encodeSegment('s-v3'))
    await mkdir(v3dir, { recursive: true })
    await writeFile(join(v3dir, 'session.v3.jsonl'), `${headerLine({ id: 's-v3' }).replace('"version":4', '"version":3')}\n`)
    const legacy = await reader.scanSessionLog(v3dir, 's-v3')
    expect(legacy.ok).toBe(false)
    if (!legacy.ok) expect(legacy.reason).toBe('unsupported')

    const v5dir = join(root, '--proj--', encodeSegment('s-v5'))
    await mkdir(v5dir, { recursive: true })
    await writeFile(join(v5dir, 'session.v5.jsonl'), `${headerLine({ id: 's-v5' }).replace('"version":4', '"version":5')}\n`)
    const future = await reader.scanSessionLog(v5dir, 's-v5')
    expect(future.ok).toBe(false)
    if (!future.ok) expect(future.reason).toBe('future-format')

    const bothDir = join(root, '--proj--', encodeSegment('s-both'))
    await mkdir(bothDir, { recursive: true })
    await writeFile(join(bothDir, 'session.v4.jsonl'), `${headerLine({ id: 's-both' })}\n`)
    await writeFile(join(bothDir, 'session.v4.jsonl.zstd'), await zstdCompressChecksummed(Buffer.from(`${headerLine({ id: 's-both' })}\n`)))
    const ambiguous = await reader.scanSessionLog(bothDir, 's-both')
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) expect(ambiguous.reason).toBe('ambiguous')
  })
})

/* ────────────────────────── 封顶：真实读/分配有界 ────────────────────────── */

describe('ColdLogScan：封顶越界 → cap（有界读、有界分配、绝不整文件缓冲）', () => {
  it('plain 大正文超输入封顶 → cap，实际读取 ≤ cap+探测字节', async () => {
    const root = await tmpRoot()
    const id = 's-plain-big'
    const filler = Array.from({ length: 4_000 }, (_, i) => eventLine(i + 1, { type: 'user/message', data: { text: 'x'.repeat(120) } }))
    const { dir, content } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router'), ...filler])
    expect(content.length).toBeGreaterThan(300_000)
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('cap')
    expect(outcome.stats.bytesCompressed).toBeLessThanOrEqual(262_144 + 8_192)
    expect(outcome.stats.bytesCompressed).toBeLessThan(content.length / 2)
  })

  it('zstd 压缩炸弹：解压输出超 1MiB → cap，解压计数有界', async () => {
    const root = await tmpRoot()
    const id = 's-zstd-bomb'
    const bomb = Buffer.from('a'.repeat(2_000_000))
    const frame = await zstdCompressChecksummed(Buffer.concat([Buffer.from(`${headerLine({ id })}\n`)]))
    const body = await zstdCompressChecksummed(Buffer.concat([bomb, Buffer.from('\n')]))
    const dir = join(root, '--proj--', encodeSegment(id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame, body]))
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('cap')
    expect(outcome.stats.bytesDecompressed).toBeLessThanOrEqual(1_048_576 + 65_536)
  })

  it('单行超 64KiB → cap：在行封顶处即停，不缓冲整行', async () => {
    const root = await tmpRoot()
    const id = 's-huge-line'
    const huge = eventLine(0, { type: 'user/message', data: { text: 'x'.repeat(200_000) } })
    const { dir, content } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router'), huge])
    expect(huge.length).toBeGreaterThan(65_536)
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('cap')
    expect(outcome.stats.bytesCompressed).toBeLessThanOrEqual(65_536 + 3 * 8_192 + 1)
    expect(outcome.stats.bytesCompressed).toBeLessThan(content.length / 2)
  })

  it('事件行数超 4096 → cap', async () => {
    const root = await tmpRoot()
    const id = 's-many-lines'
    const lines = [headerLine({ id })]
    for (let i = 0; i < 5_000; i += 1) lines.push(eventLine(i))
    const { dir, content } = await writeSession(root, id, lines)
    expect(content.length).toBeLessThan(262_144) // 不许输入封顶先响
    const outcome = await reader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('cap')
    expect(outcome.message).toMatch(/line/i)
  })
})

/* ────────────────────────── 稳定性与中断 ────────────────────────── */

/** 仪器化 deps：读到指定字节数后执行一次外部变更（真实文件写入）。 */
function mutatingDeps(triggerBytes: number, mutate: () => Promise<void>): HeaderIoDeps {
  const base = defaultHeaderIoDeps()
  let readTotal = 0
  let fired = false
  return {
    ...base,
    open: async (path) => {
      const handle = await base.open(path)
      return {
        read: async (buffer, offset, length, position) => {
          const result = await handle.read(buffer, offset, length, position)
          if (!fired) {
            readTotal += result.bytesRead
            if (readTotal >= triggerBytes) {
              fired = true
              await mutate()
            }
          }
          return result
        },
        close: () => handle.close(),
        stat: () => handle.stat!(),
      }
    },
  }
}

describe('ColdLogScan：读中不稳定 / 中止 / 额度', () => {
  it('扫描在途外部 append（mtime/size 变）→ unstable', async () => {
    const root = await tmpRoot()
    const id = 's-unstable-append'
    const { dir, file } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router'), turnStartLine(1), eventLine(2, { type: 'user/message', data: { text: 'y'.repeat(4_000) } })])
    const deps = mutatingDeps(40, async () => {
      await appendFile(file, `${selectedLine(3, 'late-choice')}\n`)
    })
    const outcome = await new SessionHeaderReader(deps).scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unstable')
  })

  it('扫描在途整文件被替换（新 inode）→ unstable', async () => {
    const root = await tmpRoot()
    const id = 's-unstable-replace'
    const { dir, file } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router'), ...Array.from({ length: 20 }, (_, i) => eventLine(i + 1))])
    const deps = mutatingDeps(30, async () => {
      const tmp = `${file}.replacement`
      await writeFile(tmp, `${headerLine({ id })}\n${selectedLine(0, 'other')}\n`)
      await rm(file)
      await writeFile(file, `${headerLine({ id })}\n${selectedLine(0, 'other')}\n`)
      await rm(tmp)
    })
    const outcome = await new SessionHeaderReader(deps).scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unstable')
  })

  it('读在途中止（AbortSignal）→ aborted', async () => {
    const root = await tmpRoot()
    const id = 's-abort'
    const { dir } = await writeSession(root, id, [headerLine({ id }), ...Array.from({ length: 10 }, (_, i) => eventLine(i))])
    const controller = new AbortController()
    const deps = mutatingDeps(30, async () => { controller.abort() })
    const outcome = await new SessionHeaderReader(deps).scanSessionLog(dir, id, { signal: controller.signal })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('aborted')
  })

  it('共享额度容量 0 → limit（不启动任何 IO）', async () => {
    const root = await tmpRoot()
    const id = 's-busy'
    const { dir } = await writeSession(root, id, [headerLine({ id })])
    const zeroBudgetReader = new SessionHeaderReader(defaultHeaderIoDeps(), { budget: new IoBudget(0) })
    const outcome = await zeroBudgetReader.scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    expect(outcome.message).toMatch(/budget/i)
  })

  it('慢读超时（deadline）→ limit', async () => {
    const root = await tmpRoot()
    const id = 's-slow'
    const base = defaultHeaderIoDeps()
    const slowDeps: HeaderIoDeps = {
      ...base,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: async (buffer, offset, length, position) => {
            await new Promise((resolve) => setTimeout(resolve, 40))
            return handle.read(buffer, offset, length, position)
          },
          close: () => handle.close(),
          stat: () => handle.stat!(),
        }
      },
    }
    const { dir } = await writeSession(root, id, [headerLine({ id }), ...Array.from({ length: 4_000 }, (_, i) => eventLine(i))])
    const start = Date.now()
    const outcome = await new SessionHeaderReader(slowDeps).scanSessionLog(dir, id, { deadlineAt: start + 120 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
  })

  it('路径与打开句柄身份不一致（lstat 旧 → open 拿到替换文件）→ unstable', async () => {
    const root = await tmpRoot()
    const id = 's-path-handle-mismatch'
    const { dir, file } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router')])
    // 序列：lstat 看到原文件（A=original）→ lstat 返回后、open 前换成 replacement
    // → open 拿到 replacement（句柄身份 B ≠ A）——路径前后可以再换回去，但
    // 句柄/路径身份互等检查必须抓住。
    const replacement = Buffer.from(`${headerLine({ id })}\n${selectedLine(0, 'attacker')}\n`)
    const base = defaultHeaderIoDeps()
    let lstatCalls = 0
    const trickyDeps: HeaderIoDeps = {
      ...base,
      lstat: async (path) => {
        lstatCalls += 1
        const st = await base.lstat(path)
        if (lstatCalls === 1) await writeFile(file, replacement)
        return st
      },
      open: base.open,
    }
    const outcome = await new SessionHeaderReader(trickyDeps).scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unstable')
  })
})

/* ────────────────────────── I1 r1：挂起的底层操作不得冻结扫描 ────────────────────────── */

/** 手动计时面：到期不自动触发（用来把「过期竞速」与「真实时钟」分开）。 */
function manualTimerFace(): { set(delayMs: number, fn: () => void): () => void; fire(): void } {
  const pending: Array<() => void> = []
  return {
    set(_delayMs, fn) {
      pending.push(fn)
      return () => {
        const index = pending.indexOf(fn)
        if (index >= 0) pending.splice(index, 1)
      }
    },
    fire() {
      for (const fn of pending.splice(0)) fn()
    },
  }
}

describe('ColdLogScan：永不落定的底层操作（I1 r1）', () => {
  it('永不落定的 read：扫描按时返回 limit；迟到读落定后后台关闭句柄一次（同一租约）', async () => {
    const root = await tmpRoot()
    const id = 's-never-read'
    const { dir } = await writeSession(root, id, [headerLine({ id })])
    const base = defaultHeaderIoDeps()
    let releaseRead: (() => void) | undefined
    let closeCalls = 0
    const deps: HeaderIoDeps = {
      ...base,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: () => new Promise<{ bytesRead: number }>((resolve) => { releaseRead = () => resolve({ bytesRead: 0 }) }),
          close: async () => { closeCalls += 1; await handle.close() },
          stat: () => handle.stat!(),
        }
      },
    }
    const reader = new SessionHeaderReader(deps, { ioCapacity: 1 })
    const start = Date.now()
    const outcome = await reader.scanSessionLog(dir, id, { deadlineAt: start + 30, now: () => Date.now() })
    const elapsed = Date.now() - start
    // 及时返回：不被永不落定的读拖住（否则占住 index 串行链、dedup resolve 与 dispose）
    expect(elapsed).toBeLessThan(900)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    // 迟到读仍在途：不与它并发占用同一槽位（此刻还没关）
    expect(closeCalls).toBe(0)
    releaseRead!()
    await new Promise((resolve) => setTimeout(resolve, 40))
    // 迟到读落定后：后台关闭一次，租约归还
    expect(closeCalls).toBe(1)
    expect(reader.ioInFlight()).toBe(0)
  }, 2_000)

  it('永不落定的 fstat：扫描按时返回（不被句柄 stat 拖住）', async () => {
    const root = await tmpRoot()
    const id = 's-never-fstat'
    const { dir } = await writeSession(root, id, [headerLine({ id })])
    const base = defaultHeaderIoDeps()
    let releaseStat: (() => void) | undefined
    let closeCalls = 0
    const deps: HeaderIoDeps = {
      ...base,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: handle.read.bind(handle),
          close: async () => { closeCalls += 1; await handle.close() },
          stat: () => new Promise<{ size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number }>((resolve) => {
            releaseStat = () => resolve({ size: 0, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0 })
          }),
        }
      },
    }
    const reader = new SessionHeaderReader(deps, { ioCapacity: 1 })
    const start = Date.now()
    const outcome = await reader.scanSessionLog(dir, id, { deadlineAt: start + 30, now: () => Date.now() })
    expect(Date.now() - start).toBeLessThan(900)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
    releaseStat!()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(closeCalls).toBe(1)
    expect(reader.ioInFlight()).toBe(0)
  }, 2_000)

  it('永不落定的 read + abort：扫描按时返回 aborted（不被拖住）', async () => {
    const root = await tmpRoot()
    const id = 's-never-read-abort'
    const { dir } = await writeSession(root, id, [headerLine({ id })])
    const base = defaultHeaderIoDeps()
    const controller = new AbortController()
    let releaseRead: (() => void) | undefined
    const deps: HeaderIoDeps = {
      ...base,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: () => new Promise<{ bytesRead: number }>((resolve) => { releaseRead = () => resolve({ bytesRead: 0 }) }),
          close: async () => { await handle.close() },
          stat: () => handle.stat!(),
        }
      },
    }
    const reader = new SessionHeaderReader(deps, { ioCapacity: 1 })
    setTimeout(() => controller.abort(), 20)
    const start = Date.now()
    const outcome = await reader.scanSessionLog(dir, id, {
      deadlineAt: start + 5_000,
      now: () => Date.now(),
      signal: controller.signal,
    })
    expect(Date.now() - start).toBeLessThan(900)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('aborted')
    releaseRead!()
    await new Promise((resolve) => setTimeout(resolve, 40))
  }, 2_000)

  it('close 失败（reject）必须传播：扫描不得报成功', async () => {
    const root = await tmpRoot()
    const id = 's-close-error'
    const { dir } = await writeSession(root, id, [headerLine({ id })])
    const base = defaultHeaderIoDeps()
    const deps: HeaderIoDeps = {
      ...base,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: handle.read.bind(handle),
          close: async () => { await handle.close(); throw new Error('close boom') },
          stat: () => handle.stat!(),
        }
      },
    }
    const reader = new SessionHeaderReader(deps, { ioCapacity: 2 })
    const start = Date.now()
    const outcome = await reader.scanSessionLog(dir, id, { deadlineAt: start + 2_000, now: () => Date.now() })
    expect(Date.now() - start).toBeLessThan(900)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unreadable')
  }, 2_000)

  it('最终接受点复核时限：关闭后时钟越过 deadline → 不得报成功', async () => {
    const root = await tmpRoot()
    const id = 's-final-gate'
    const { dir } = await writeSession(root, id, [headerLine({ id })])
    const base = defaultHeaderIoDeps()
    const deadline = 1_000
    const clock = { value: 0 }
    const deps: HeaderIoDeps = {
      ...base,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: handle.read.bind(handle),
          close: async () => { clock.value = deadline + 1; await handle.close() },
          stat: () => handle.stat!(),
        }
      },
    }
    const reader = new SessionHeaderReader(deps, { ioCapacity: 2 })
    const outcome = await reader.scanSessionLog(dir, id, {
      deadlineAt: deadline,
      now: () => clock.value,
      // 手动计时面：到期不自动触发——「后置 stat 赢过已过期计时器」才可复现
      timer: { set: () => () => undefined },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('limit')
  }, 2_000)

  it('永不落定的 close：扫描不得报成功且及时返回，夹具释放后关闭一次并归还租约', async () => {
    const root = await tmpRoot()
    const id = 's-never-close'
    const { dir } = await writeSession(root, id, [headerLine({ id })])
    const base = defaultHeaderIoDeps()
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    let closeDone: Promise<void> | undefined
    let closeCalls = 0
    const deps: HeaderIoDeps = {
      ...base,
      open: async (path) => {
        const handle = await base.open(path)
        return {
          read: handle.read.bind(handle),
          close: () => {
            closeCalls += 1
            closeDone = closeGate.then(() => handle.close())
            return closeDone
          },
          stat: () => handle.stat!(),
        }
      },
    }
    const reader = new SessionHeaderReader(deps, { ioCapacity: 2 })
    const start = Date.now()
    try {
      const outcome = await reader.scanSessionLog(dir, id, { deadlineAt: start + 100, now: () => Date.now() })
      expect(Date.now() - start).toBeLessThan(900)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe('limit')
      expect(closeCalls).toBe(1)
      expect(reader.ioInFlight()).toBe(1)
    } finally {
      // 超时期间保持真实 close 挂起；断言失败时也必须释放真实文件句柄。
      releaseClose()
      await closeDone
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(closeCalls).toBe(1)
    expect(reader.ioInFlight()).toBe(0)
  }, 2_000)
})

/* ────────────────────────── M1：输出封顶与失败字节计量 ────────────────────────── */

describe('ColdLogScan：输出封顶与失败字节计量（M1）', () => {
  it('plain 输出封顶生效：maxDecompressedBytes 小于日志大小 → cap（不得 ok）', async () => {
    const root = await tmpRoot()
    const id = 's-plain-out-cap'
    const { dir } = await writeSession(root, id, [headerLine({ id })])
    const outcome = await reader.scanSessionLog(dir, id, { maxDecompressedBytes: 8 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('cap')
    expect(outcome.stats.bytesDecompressed).toBeLessThanOrEqual(9) // cap+1 探测
  })

  it('zstd 解码失败的消耗必须计入统计（失败不得吞掉已产出字节）', async () => {
    const root = await tmpRoot()
    const id = 's-zstd-fail-bytes'
    const { dir } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router')], { zstd: true })
    const base = defaultHeaderIoDeps()
    const deps: HeaderIoDeps = {
      ...base,
      zstd: {
        createStream: () => {
          const listeners: Record<string, ((chunk?: unknown) => void)[]> = {}
          return {
            on: (event: string, listener: (chunk?: unknown) => void) => { (listeners[event] ??= []).push(listener) },
            write: () => {},
            end: () => {
              for (const listener of listeners['data'] ?? []) listener(Buffer.alloc(2048, 0x61))
              for (const listener of listeners['error'] ?? []) listener(new Error('decode boom'))
            },
            destroy: () => {},
          } as never
        },
      },
    }
    const outcome = await new SessionHeaderReader(deps).scanSessionLog(dir, id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.stats.bytesDecompressed).toBeGreaterThan(0)
  })
})


/* ────────────────────────── M2：zstd checksum 必须真的开启 ────────────────────────── */

describe('ColdLogScan：zstd checksum 夹具与坏末帧（M2）', () => {
  it('夹具真的开启了 checksum（帧描述符 checksum 位非 0）；破坏末帧校验和 → corrupt', async () => {
    const root = await tmpRoot()
    const id = 's-checksum'
    const { dir, content } = await writeSession(root, id, [headerLine({ id }), selectedLine(0, 'dsh-router')], { zstd: true })
    // 夹具自证：checksum 位必须真的开着（旧夹具用 {checksum:true}，实际没开）
    expect(frameChecksumBit(content)).toBe(4)
    const ok = await reader.scanSessionLog(dir, id)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.finalPreset).toBe('dsh-router')
    // 破坏末帧的校验和字节 → 解码必须报错（不得当作完整 EOF 接受）
    const broken = Buffer.from(content)
    broken[broken.length - 1] = broken[broken.length - 1]! ^ 0xff
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), broken)
    const bad = await reader.scanSessionLog(dir, id)
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.reason).toBe('corrupt')
  })
})
