/**
 * 持久化增量会话候选索引。
 *
 * 首次 bootstrap 有界分批扫历史候选（全局预算含失败读取、无逐 workspace 重置）；
 * 判定/进度/失败按 root+preset+version 落盘，重启对未变指纹直接复用（零头读取）；
 * 低频目录对账抓漏（成员跟踪 + 指纹，不是 mtime 水位线）；live 会话经
 * session/created / agent-preset/selected 事件直达判定（零盘读）；单飞 + 有界
 * 背景推进 + 安全 dispose。全部真实 tmp FS 夹具。
 */

import { mkdtemp, mkdir, rm, utimes, writeFile, appendFile, readdir as fsReaddir, stat as fsStat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

import { SessionHeaderIndex, type IndexPersistence, type IndexFileState } from '../src/host/session/session-index.ts'
import type { HeaderReadOutcome } from '../src/host/session/header-io.ts'
import { SessionHeaderReader, encodeSegment } from '../src/host/session/header-io.ts'

/** live Session 假件：header + 可选投影解析面（C1 后的权威事实源）。 */
function liveSession(header: { id: string; version?: number; createdAt?: number; isSeeded?: boolean; agentPreset?: string }) {
  return {
    id: header.id,
    header: {
      version: header.version ?? 4,
      id: header.id,
      createdAt: header.createdAt ?? 1_700_000_000_000,
      isSeeded: header.isSeeded ?? false,
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    },
  }
}

const zstdCompressAsync = promisify(zstdCompress) as (input: Buffer, options?: { checksum?: boolean }) => Promise<Buffer>

/* ────────────────────────── 夹具 ────────────────────────── */

let roots: string[] = []
async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'router-session-index-'))
  roots.push(root)
  return root
}
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

/** 头行（v4/v3 形状开关）。 */
function header(id: string, fields: { version?: number; createdAt?: number; isSeeded?: boolean; agentPreset?: string } = {}): string {
  return JSON.stringify({
    type: 'session',
    version: fields.version ?? 4,
    id,
    createdAt: fields.createdAt ?? 1_700_000_000_000,
    isSeeded: fields.isSeeded ?? false,
    delegationDepth: 0,
    ...(fields.agentPreset === undefined ? {} : { agentPreset: fields.agentPreset }),
  })
}

/** 写一个会话目录（默认 v4 plain 头 + 一条事件行）。返回会话目录路径。 */
async function writeSession(
  root: string,
  sessionId: string,
  fields: { version?: number; createdAt?: number; isSeeded?: boolean; agentPreset?: string; name?: string; zstd?: boolean; mtime?: Date; corrupt?: boolean } = {},
  projectDirName = '--proj--',
): Promise<string> {
  const version = fields.version ?? 4
  const name = fields.name ?? (version === 0 ? 'session.jsonl' : `session.v${version}.jsonl${fields.zstd === true ? '.zstd' : ''}`)
  const dir = join(root, projectDirName, encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  const line = header(sessionId, fields)
  let content: Buffer
  if (fields.zstd === true) {
    content = await zstdCompressAsync(Buffer.from(`${line}\n`))
  } else {
    content = Buffer.from(fields.corrupt === true ? `@@@ not json\n` : `${line}\n${JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: {} })}\n`)
  }
  await writeFile(join(dir, name), content)
  if (fields.mtime !== undefined) await utimes(join(dir, name), fields.mtime, fields.mtime)
  return dir
}

/** 记录型内存持久化（可注入延迟/拒绝）。 */
function memoryPersistence(initial?: IndexFileState) {
  const state = {
    saved: [] as IndexFileState[],
    loadDelay: undefined as (() => Promise<void>) | undefined,
    rejectNextSaves: 0,
    loadCalls: 0,
    activeSaves: [] as Array<{ start: number; end: number }>,
    saveOrder: [] as number[],
  }
  const persistence: IndexPersistence = {
    async load() {
      state.loadCalls += 1
      if (state.loadDelay !== undefined) await state.loadDelay()
      const source = initial ?? state.saved[state.saved.length - 1]
      return source === undefined ? null : (structuredClone(source) as unknown)
    },
    async save(value) {
      if (state.rejectNextSaves > 0) {
        state.rejectNextSaves -= 1
        throw new Error('save rejected')
      }
      const record = { start: Date.now(), end: 0 }
      state.activeSaves.push(record)
      state.saveOrder.push(state.saved.length)
      await new Promise((resolve) => setTimeout(resolve, 2))
      record.end = Date.now()
      state.saved.push(value)
    },
  }
  return { persistence, state }
}

/** 手动时钟 + 立即执行队列（可控去抖/定时）。 */
function manualClock(start = 1_000_000) {
  let now = start
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= now) {
          timer.cancelled = true
          timer.fn()
        }
      }
    },
    schedule(delayMs: number, fn: () => void) {
      const timer = { at: now + delayMs, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
    scheduledDelays: () => timers.map((timer) => timer.at - now),
  }
}

/** 造索引（默认真实 reader；可注入失败 reader/自定义 deps）。 */
function makeIndex(root: string, options: {
  preset?: string
  persistence?: IndexPersistence
  clock?: ReturnType<typeof manualClock>
  batchAttempts?: number
  failureRetryMs?: number
  backgroundIntervalMs?: number
  reconcileIntervalMs?: number
  reader?: { readSessionHeader(dir: string, sessionId: string, options?: unknown): Promise<HeaderReadOutcome> }
  /** C1：live Session 的权威最终预设解析面（sessionProjections.stateOf 投影）。 */
  resolveLivePreset?: (session: unknown) => string | null | undefined
  /** M1：可注入的 fs 元数据面（模拟读失败）。 */
  fs?: ConstructorParameters<typeof SessionHeaderIndex>[0]['fs']
  logger?: { warn(message: string): void }
} = {}) {
  const warns: string[] = []
  const clock = options.clock ?? manualClock()
  const index = new SessionHeaderIndex({
    root,
    routerPreset: options.preset ?? 'dsh-router',
    persistence: options.persistence,
    now: clock.now,
    schedule: clock.schedule,
    batchAttempts: options.batchAttempts ?? 10,
    failureRetryMs: options.failureRetryMs ?? 600_000,
    backgroundIntervalMs: options.backgroundIntervalMs ?? 250,
    reconcileIntervalMs: options.reconcileIntervalMs ?? 60_000,
    reader: options.reader,
    resolveLivePreset: options.resolveLivePreset,
    fs: options.fs,
    logger: options.logger ?? { warn: (message) => { warns.push(message) } },
  })
  return { index, clock, warns }
}

/** 断言一批会话的判定（快捷）。 */
function expectVerdict(index: SessionHeaderIndex, sessionId: string, verdict: string): void {
  const lookup = index.verdictOf(sessionId)
  expect(lookup.status, `session ${sessionId} should be classified`).toBe('classified')
  if (lookup.status !== 'classified') return
  expect(lookup.verdict).toBe(verdict)
}

/** 轮询等待异步条件成立（真实 fs 读取完成时间不定，固定 sleep 会闪断）。 */
async function waitFor(probe: () => boolean, timeoutMs = 2_000, describe?: () => unknown): Promise<void> {
  const start = Date.now()
  while (!probe()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${Date.now() - start}ms${describe !== undefined ? `; state: ${JSON.stringify(describe())}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/* ────────────────────────── 分类规则（C1 修订版） ────────────────────────── */

describe('SessionHeaderIndex：冷盘头不是权威（C1）——cold v2 小日志 stable-EOF 扫描', () => {
  it('冷盘 v4 带路由预设 / 无预设：小日志扫描给出当前组合快照（evidence=stable-eof）；v3 legacy 保持 unknown', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-v4-preset', { agentPreset: 'dsh-router' })
    await writeSession(root, 's-v4-plain', {})
    await writeSession(root, 's-v3', { version: 3 })
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    const preset = index.verdictOf('s-v4-preset')
    expect(preset.status).toBe('classified')
    if (preset.status === 'classified') {
      expect(preset.verdict).toBe('router') // 头值即当前快照（无 selected 事件）
      expect(preset.evidence).toBe('stable-eof')
      expect(preset.origin).toBe('disk')
    }
    const plain = index.verdictOf('s-v4-plain')
    expect(plain.status).toBe('classified')
    if (plain.status === 'classified') {
      expect(plain.verdict).toBe('nonrouter') // 无预设组合
      expect(plain.evidence).toBe('stable-eof')
    }
    const legacy = index.verdictOf('s-v3')
    expect(legacy.status).toBe('classified')
    if (legacy.status === 'classified') {
      expect(legacy.verdict).toBe('unknown') // legacy 不扫：当前写入守卫证明不了历史语义
      expect(legacy.reason ?? '').toContain('legacy')
    }
    const scan = index.diagnostics().scan
    expect(scan.attempts).toBe(2) // 只有 unseeded v4 走扫描
    expect(scan.finals).toBe(2)
  })

  it('seeded 排除仍然安全：v4 seeded（带 router 预设）→ nonrouter；v0 seedLength → nonrouter', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-seeded', { agentPreset: 'dsh-router', isSeeded: true })
    const dir = join(root, '--proj--', encodeSegment('s-v0-seeded'))
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'session.jsonl'),
      `${JSON.stringify({ type: 'session', version: 0, id: 's-v0-seeded', createdAt: 1, delegationDepth: 0, seedLength: 2, agentPreset: 'dsh-router' })}\n`,
    )
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 's-seeded', 'nonrouter')
    expectVerdict(index, 's-v0-seeded', 'nonrouter')
  })

  it('坏头（corrupt）与 future generation → 最终 unknown（fail closed，不进重试队列）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-corrupt', { corrupt: true })
    const dir = join(root, '--proj--', encodeSegment('s-future'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v5.jsonl'), `${JSON.stringify({ type: 'session', version: 5, id: 's-future', createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`)
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 's-corrupt', 'unknown')
    expectVerdict(index, 's-future', 'unknown')
  })

  it('zstd 能力缺席（unsupported）→ unknown + 全局降级标记（diagnostics 可见）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-zstd', { zstd: true })
    const { index } = makeIndex(root, {
      reader: {
        readSessionHeader: async () => ({
          ok: false,
          reason: 'unsupported' as const,
          message: 'zstd unavailable',
          stats: { bytesCompressed: 0, bytesDecompressed: 0 },
        }),
      },
    })
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 's-zstd', 'unknown')
    expect(index.diagnostics().degraded.unsupportedCodec).toBe(true)
  })
})

/* ────────────────────────── 有界分批与失败冷却 ────────────────────────── */

describe('SessionHeaderIndex：首次 bootstrap 有界分批', () => {
  it('25 个候选：每轮 advance 全局 10 次尝试，三轮收完（进度跨轮保持）', async () => {
    const root = await tmpRoot()
    for (let i = 0; i < 25; i += 1) await writeSession(root, `s-${String(i).padStart(2, '0')}`, { agentPreset: 'dsh-router' })
    const { index } = makeIndex(root)
    await index.reconcile()
    expect(index.diagnostics().queueLength).toBe(25)
    await index.advance()
    expect(index.diagnostics().header.attempts).toBe(10)
    expect(index.diagnostics().queueLength).toBe(15)
    await index.advance()
    await index.advance()
    expect(index.diagnostics().queueLength).toBe(0)
    expect(index.diagnostics().header.attempts).toBe(25)
    expectVerdict(index, 's-00', 'router') // 小日志扫描：头值 + 无 selected → 当前快照
    expectVerdict(index, 's-24', 'router') // 分批推进本身仍被验证
  })

  it('全局预算含失败读取：坏读（unreadable）占尝试名额并进冷却，好会话照常判定', async () => {
    const root = await tmpRoot()
    for (let i = 0; i < 10; i += 1) await writeSession(root, `s-${i}`, { agentPreset: 'dsh-router' })
    const flakyIds = new Set(['s-0', 's-1', 's-2'])
    let reads = 0
    const flaky = {
      readSessionHeader: async (dir: string, sessionId: string): Promise<HeaderReadOutcome> => {
        reads += 1
        if (flakyIds.has(sessionId)) {
          return { ok: false, reason: 'unreadable' as const, message: 'boom', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
        }
        const real = new (await import('../src/host/session/header-io.ts')).SessionHeaderReader()
        return real.readSessionHeader(dir, sessionId)
      },
    }
    const { index } = makeIndex(root, { reader: flaky as never })
    await index.reconcile()
    await index.advance()
    // 10 次尝试：3 次失败 + 7 次成功（预算含失败）。
    expect(index.diagnostics().header.attempts).toBe(10)
    expect(index.diagnostics().header.errors).toBe(3)
    expect(index.diagnostics().failures).toBe(3)
    for (const id of flakyIds) expect(index.verdictOf(id).status).toBe('failed')
    expectVerdict(index, 's-3', 'unknown')
    expectVerdict(index, 's-9', 'unknown')
    expect(index.verdictOf('s-9').status === 'classified').toBe(true)
    // s-3..s-9 共 7 个成功；队列清空。
    expect(index.diagnostics().queueLength).toBe(0)
  })

  it('失败冷却到期后重试成功：failed → classified', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-one', { agentPreset: 'dsh-router' })
    let failOnce = true
    const flaky = {
      readSessionHeader: async (dir: string, sessionId: string): Promise<HeaderReadOutcome> => {
        if (failOnce) {
          failOnce = false
          return { ok: false, reason: 'unreadable' as const, message: 'boom', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
        }
        const real = new (await import('../src/host/session/header-io.ts')).SessionHeaderReader()
        return real.readSessionHeader(dir, sessionId)
      },
    }
    const { index, clock } = makeIndex(root, { reader: flaky as never, failureRetryMs: 1_000 })
    await index.reconcile()
    await index.advance()
    expect(index.verdictOf('s-one').status).toBe('failed')
    clock.advance(1_500)
    await index.advance()
    expectVerdict(index, 's-one', 'unknown')
  })

  it('全局预算跨项目目录（不按目录/workspace 重置）：两个项目目录共 25 个，一轮仍只 10 次', async () => {
    const root = await tmpRoot()
    for (let i = 0; i < 13; i += 1) await writeSession(root, `a-${i}`, { agentPreset: 'dsh-router' }, '--proj-a--')
    for (let i = 0; i < 12; i += 1) await writeSession(root, `b-${i}`, { agentPreset: 'dsh-router' }, '--proj-b--')
    const { index } = makeIndex(root)
    await index.reconcile()
    expect(index.diagnostics().queueLength).toBe(25)
    await index.advance()
    expect(index.diagnostics().header.attempts).toBe(10)
    expect(index.diagnostics().queueLength).toBe(15)
    // 收完队列，然后稳态：继续 advance/resolve 轮询 → 零读取、零目录走。
    await index.advance()
    await index.advance()
    expect(index.diagnostics().queueLength).toBe(0)
    const attemptsBefore = index.diagnostics().header.attempts
    for (let i = 0; i < 5; i += 1) await index.advance()
    expect(index.diagnostics().header.attempts).toBe(attemptsBefore)
  })
})

/* ────────────────────────── 重启复用与指纹 ────────────────────────── */

describe('SessionHeaderIndex：持久化与重启复用', () => {
  it('重启后未变指纹直接复用：零头读取（cacheReused 计数）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-a', { agentPreset: 'dsh-router' })
    await writeSession(root, 's-b', {})
    const { persistence, state } = memoryPersistence()
    const first = makeIndex(root, { persistence: persistence as never })
    await first.index.hydrate()
    await first.index.reconcile()
    await first.index.advance()
    expectVerdict(first.index, 's-a', 'router') // stable-EOF 扫描
    await first.index.dispose()

    const second = makeIndex(root, { persistence: persistence as never })
    await second.index.hydrate()
    await second.index.reconcile()
    expect(second.index.diagnostics().header.attempts).toBe(0)
    expect(second.index.diagnostics().header.cacheReused).toBe(2)
    expectVerdict(second.index, 's-a', 'router') // 重启：证据 + 指纹复用，零重扫
    expectVerdict(second.index, 's-b', 'nonrouter')
    expect(state.saved.length).toBeGreaterThanOrEqual(1)
  })

  it('指纹变化（文件重写）→ 重新分类（unseeded unknown → seeded nonrouter）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-change', {})
    const { persistence } = memoryPersistence()
    const first = makeIndex(root, { persistence: persistence as never })
    await first.index.hydrate()
    await first.index.reconcile()
    await first.index.advance()
    expectVerdict(first.index, 's-change', 'nonrouter') // 小日志扫描：无预设组合
    await first.index.dispose()

    await writeSession(root, 's-change', { isSeeded: true, agentPreset: 'dsh-router' })
    const second = makeIndex(root, { persistence: persistence as never })
    await second.index.hydrate()
    await second.index.reconcile()
    expect(second.index.diagnostics().queueLength).toBe(1)
    await second.index.advance()
    expectVerdict(second.index, 's-change', 'nonrouter') // seeded 排除可从盘头安全证明
  })

  it('作用域不符（root/preset 变化）或坏 JSON：丢弃重来', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-a', { agentPreset: 'dsh-router' })
    const { persistence: p1, state } = memoryPersistence()
    const first = makeIndex(root, { persistence: p1 as never })
    await first.index.hydrate()
    await first.index.reconcile()
    await first.index.advance()
    await first.index.dispose()
    expect(state.saved.length).toBeGreaterThan(0)

    // preset 不同：判定语义变了，不能复用。
    const otherPreset = makeIndex(root, { persistence: p1 as never, preset: 'dsh-other' })
    await otherPreset.index.hydrate()
    await otherPreset.index.reconcile()
    expect(otherPreset.index.diagnostics().queueLength).toBe(1)
    await otherPreset.index.advance()
    expectVerdict(otherPreset.index, 's-a', 'nonrouter') // 按另一预设口径：dsh-router 不是它

    // root 不同：整份丢弃。
    const root2 = await tmpRoot()
    await writeSession(root2, 's-a', { agentPreset: 'dsh-router' })
    const otherRoot = makeIndex(root2, { persistence: p1 as never })
    await otherRoot.index.hydrate()
    await otherRoot.index.reconcile()
    expect(otherRoot.index.diagnostics().queueLength).toBe(1)
  })

  it('live 条目不落盘复用：重启后由磁盘/事件重建', async () => {
    const root = await tmpRoot()
    const { persistence } = memoryPersistence()
    const first = makeIndex(root, { persistence: persistence as never, resolveLivePreset: () => 'dsh-router' })
    await first.index.hydrate()
    first.index.onLiveSession(liveSession({ id: 's-live', agentPreset: 'dsh-router' }))
    expectVerdict(first.index, 's-live', 'router')
    await first.index.dispose()

    const second = makeIndex(root, { persistence: persistence as never })
    await second.index.hydrate()
    expect(second.index.verdictOf('s-live').status).toBe('pending')
  })
})

/* ────────────────────────── 成员对账 ────────────────────────── */

describe('SessionHeaderIndex：低频目录对账（成员跟踪 + 指纹，无 mtime 水位线）', () => {
  it('会话目录消失 → 条目移除；外部导入旧 mtime 的新会话照样发现', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-gone', { agentPreset: 'dsh-router' })
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 's-gone', 'router')
    expect(index.diagnostics().entries.total).toBe(1)

    await rm(join(root, '--proj--', encodeSegment('s-gone')), { recursive: true, force: true })
    // 外部导入：新目录 + 很旧的 mtime（水位线方案会漏，成员跟踪不会）。
    await writeSession(root, 's-imported', { agentPreset: 'dsh-router', mtime: new Date('2020-01-01') })
    await index.reconcile()
    expect(index.diagnostics().entries.total).toBe(0)
    expect(index.verdictOf('s-gone').status).toBe('pending')
    expect(index.diagnostics().queueLength).toBe(1)
    await index.advance()
    expectVerdict(index, 's-imported', 'router')
  })

  it('会话确认消失后辅助记账被回收：authorityToken 归零、router 授予代数清空（审查修复：无界 Map 慢泄漏）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-gone', { agentPreset: 'dsh-router' })
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 's-gone', 'router')
    expect(index.authorityToken('s-gone')).toBeGreaterThan(0)
    expect(index.routerGrantGeneration('s-gone')).toBeDefined()

    await rm(join(root, '--proj--', encodeSegment('s-gone')), { recursive: true, force: true })
    await index.reconcile()
    expect(index.verdictOf('s-gone').status).toBe('pending')
    expect(index.authorityToken('s-gone')).toBe(0)
    expect(index.routerGrantGeneration('s-gone')).toBeUndefined()
  })

  it('live 未落盘会话在对账中保留（宿主 created-but-unmaterialized）', async () => {
    const root = await tmpRoot()
    const { index } = makeIndex(root, { resolveLivePreset: () => null })
    await index.reconcile()
    index.onLiveSession(liveSession({ id: 's-blank' }))
    await index.reconcile()
    expectVerdict(index, 's-blank', 'nonrouter')
  })
})

/* ────────────────────────── live 事件直达（C1 修订版） ────────────────────────── */

describe('SessionHeaderIndex：live 会话权威判定（投影/事件；零盘读）', () => {
  it('session/created 经权威投影判定：router 预设 → router；他预设 → nonrouter；无预设 → nonrouter', async () => {
    const root = await tmpRoot()
    const projections = new Map<string, string | null>([
      ['s-live-router', 'dsh-router'],
      ['s-live-other', 'some-other'],
      ['s-live-free', null],
    ])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    index.onLiveSession(liveSession({ id: 's-live-router', agentPreset: 'dsh-router' }))
    // 头写着 router、投影说别的：最终组合以投影为准（selected 可覆盖）。
    index.onLiveSession(liveSession({ id: 's-live-other', agentPreset: 'dsh-router' }))
    index.onLiveSession(liveSession({ id: 's-live-free' }))
    expectVerdict(index, 's-live-router', 'router')
    expectVerdict(index, 's-live-other', 'nonrouter')
    expectVerdict(index, 's-live-free', 'nonrouter')
    expect(index.diagnostics().header.attempts).toBe(0)
  })

  it('投影缺席（读不到权威值）→ unknown；seeded 恒排除（nonrouter）', async () => {
    const root = await tmpRoot()
    const { index } = makeIndex(root) // 无 resolveLivePreset
    index.onLiveSession(liveSession({ id: 's-no-proj', agentPreset: 'dsh-router' }))
    expectVerdict(index, 's-no-proj', 'unknown')
    index.onLiveSession(liveSession({ id: 's-seeded', agentPreset: 'dsh-router', isSeeded: true }))
    expectVerdict(index, 's-seeded', 'nonrouter')
  })

  it('agent-preset/selected 事件本身即权威提交信号：事件值直接判定（不需要投影）', async () => {
    const root = await tmpRoot()
    const { index } = makeIndex(root)
    index.onLiveSession(liveSession({ id: 's-flip', agentPreset: undefined }))
    expectVerdict(index, 's-flip', 'unknown') // 无投影：created 时还读不到权威值
    index.onLiveSessionEvent(liveSession({ id: 's-flip' }), { type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } })
    expectVerdict(index, 's-flip', 'router')
    index.onLiveSessionEvent(liveSession({ id: 's-flip' }), { type: 'agent-preset/selected', data: { agentPreset: 'other' } })
    expectVerdict(index, 's-flip', 'nonrouter')

    index.onLiveSession(liveSession({ id: 's-seed', isSeeded: true }))
    index.onLiveSessionEvent(liveSession({ id: 's-seed', isSeeded: true }), { type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } })
    expectVerdict(index, 's-seed', 'nonrouter')
  })

  it('live 判定优先于盘头：对账发现文件后不覆盖 live/事件结论，但记录位置指纹', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-live', { agentPreset: 'other-preset' })
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => ((session as { id?: string }).id === 's-live' ? 'dsh-router' : undefined),
    })
    index.onLiveSession(liveSession({ id: 's-live', agentPreset: 'other-preset' }))
    await index.reconcile()
    expectVerdict(index, 's-live', 'router')
    expect(index.diagnostics().header.attempts).toBe(0)
    expect(index.diagnostics().queueLength).toBe(0)
  })
})

/* ────────────────────────── live/IO 竞态（I2 回归） ────────────────────────── */

describe('SessionHeaderIndex：live 更新与 hydrate/在途 IO 的竞态（I2）', () => {
  it('hydrate 载入期间到达的 live 事实排队：载入的旧盘判定不得覆盖新 live 事实', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-race', { agentPreset: 'dsh-router' })
    const { persistence } = memoryPersistence({
      version: 1,
      root,
      preset: 'dsh-router',
      savedAt: 1,
      entries: [{
        sessionId: 's-race', projectDir: '--proj--', file: 'session.v4.jsonl', fingerprint: 'stale',
        verdict: 'nonrouter', createdAt: 1, isSeeded: false, agentPreset: undefined, origin: 'disk', reason: 'stale',
      }],
      failures: [],
    })
    let releaseLoad: (() => void) | undefined
    const gated: IndexPersistence = {
      load: () => new Promise((resolve) => { releaseLoad = () => resolve(null) }),
      save: () => undefined,
    }
    const { index } = makeIndex(root, { persistence: gated, resolveLivePreset: () => 'dsh-router' })
    let hydrated = false
    void index.hydrate().then(() => { hydrated = true })
    // load 未落定时 live 权威事实到达（投影 router）→ 排队。
    index.onLiveSession(liveSession({ id: 's-race', agentPreset: 'dsh-router' }))
    expect(hydrated).toBe(false)
    releaseLoad?.()
    await index.hydrate()
    expectVerdict(index, 's-race', 'router') // 载入的 nonrouter 被排队事实压过
  })

  it('在途盘读期间 live 事实到达：读完成后不得回写旧盘判定（revision 护栏）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-mid-read', { agentPreset: 'other' }) // 盘头会判 unknown（cold）
    let releaseRead: (() => void) | undefined
    const slowReader = {
      readSessionHeader: (dir: string, sessionId: string): Promise<HeaderReadOutcome> =>
        new Promise((resolve) => {
          releaseRead = () => {
            const real = new SessionHeaderReader()
            void real.readSessionHeader(dir, sessionId).then(resolve)
          }
        }),
    }
    const { index } = makeIndex(root, { reader: slowReader as never })
    await index.reconcile()
    const advancing = index.advance()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(releaseRead).toBeDefined()
    // 读在途：权威 selected 事件到达（router）。
    index.onLiveSessionEvent(liveSession({ id: 's-mid-read' }), { type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } })
    releaseRead!()
    await advancing
    expectVerdict(index, 's-mid-read', 'router') // 盘读结果不覆盖 live 事实
  })

  it('dispose 后 live 回调被拒绝（不再改状态）', async () => {
    const root = await tmpRoot()
    const { index } = makeIndex(root)
    await index.dispose()
    index.onLiveSession(liveSession({ id: 's-after', agentPreset: 'dsh-router' }))
    expect(index.verdictOf('s-after').status).toBe('pending')
  })
})

/* ────────────────────────── 并发与安全 ────────────────────────── */

describe('SessionHeaderIndex：单飞、hydrate 竞态、保存拒绝', () => {
  it('hydrate 未完成时不开工：advance/reconcile 等待 load 落定', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-a', { agentPreset: 'dsh-router' })
    let releaseLoad: (() => void) | undefined
    const { persistence } = memoryPersistence()
    const gate = {
      load: () =>
        new Promise<unknown>((resolve) => {
          releaseLoad = () => resolve(null)
        }),
      save: () => undefined,
    } as unknown as IndexPersistence
    void persistence
    const { index } = makeIndex(root, { persistence: gate })
    let hydrated = false
    void index.hydrate().then(() => {
      hydrated = true
    })
    // 对账先入串行链、advance 后入（与真实接线一致：启动先对账发现，轮询再推进）。
    const reconciling = index.reconcile()
    const advancing = index.advance({ prioritize: ['s-a'] })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(hydrated).toBe(false)
    expect(index.diagnostics().header.attempts).toBe(0)
    releaseLoad?.()
    await Promise.all([reconciling, advancing])
    expect(hydrated).toBe(true)
    expectVerdict(index, 's-a', 'router') // 小日志扫描判定；关键断言是等待 hydrate 后才开工
  })

  it('并发 reconcile 单飞：目录枚举只发生一轮；并发 advance 合并', async () => {
    const root = await tmpRoot()
    for (let i = 0; i < 10; i += 1) await writeSession(root, `s-${i}`, { agentPreset: 'dsh-router' })
    let enumerations = 0
    const countingReader = {
      readSessionHeader: async (dir: string, sessionId: string): Promise<HeaderReadOutcome> => {
        const real = new (await import('../src/host/session/header-io.ts')).SessionHeaderReader()
        return real.readSessionHeader(dir, sessionId)
      },
    }
    void enumerations
    const { index } = makeIndex(root, { reader: countingReader as never })
    await Promise.all([index.reconcile(), index.reconcile(), index.reconcile()])
    await Promise.all([index.advance(), index.advance()])
    expect(index.diagnostics().header.attempts).toBe(10)
    expect(index.diagnostics().concurrency.reconcileRuns).toBe(1)
    expect(index.diagnostics().concurrency.advanceRuns).toBeLessThanOrEqual(2)
  })

  it('保存拒绝被捕获并告警（异步 rejection 不炸进程）；保存串行不交错', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-a', { agentPreset: 'dsh-router' })
    await writeSession(root, 's-b', {})
    const { persistence, state } = memoryPersistence()
    state.rejectNextSaves = 2
    const { index, clock, warns } = makeIndex(root, { persistence: persistence as never })
    await index.hydrate()
    // 第一轮：reconcile 变更 → 去抖到点 → 保存 #1（被拒）。
    await index.reconcile()
    clock.advance(3_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // 第二轮：advance 变更 → 保存 #2（被拒）。
    await index.advance()
    clock.advance(3_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // 第三轮：live 事件再变更 → dispose 冲刷 → 保存 #3（成功，携带完整状态）。
    index.onLiveSession(liveSession({ id: 's-live', agentPreset: 'dsh-router' }))
    await index.dispose()
    expect(state.saved.length).toBe(1)
    expect(state.saved[0]!.entries.length).toBe(3)
    expect(warns.join(' ')).toContain('保存')
    // 串行：任一保存的 end 不早于之前保存的 start（无交错写）。
    for (let i = 1; i < state.activeSaves.length; i += 1) {
      expect(state.activeSaves[i]!.start).toBeGreaterThanOrEqual(state.activeSaves[i - 1]!.end)
    }
  })

  it('变更合并落盘：一轮多变更只存最终状态（去抖）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-a', { agentPreset: 'dsh-router' })
    const { persistence, state } = memoryPersistence()
    const { index, clock } = makeIndex(root, { persistence: persistence as never })
    await index.hydrate()
    await index.reconcile()
    await index.advance()
    clock.advance(3_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state.saved.length).toBe(1)
    expect(state.saved[0]!.entries.length).toBe(1)
  })
})

/* ────────────────────────── 背景推进与 dispose ────────────────────────── */

describe('SessionHeaderIndex：背景推进（不依赖 UI 轮询）与安全 dispose', () => {
  it('start() 后背景 tick 自主推进队列；reconcile 低频定时；dispose 停止并 flush', async () => {
    const root = await tmpRoot()
    for (let i = 0; i < 15; i += 1) await writeSession(root, `s-${i}`, { agentPreset: 'dsh-router' })
    const { persistence } = memoryPersistence()
    const { index, clock } = makeIndex(root, { persistence: persistence as never, backgroundIntervalMs: 100, reconcileIntervalMs: 5_000 })
    await index.hydrate()
    const stop = index.start()
    // 初始对账跑完 → 队列 15。
    await waitFor(() => index.diagnostics().bootstrap.initialDone)
    clock.advance(0)
    expect(index.diagnostics().queueLength).toBe(15)
    // 背景推进：每 100ms 一批 10；高负载下后一个 tick 会并入仍在跑的上一批
    //（单飞合并），所以持续走到清空而不是只拨两格。
    clock.advance(100)
    await waitFor(() => index.diagnostics().header.attempts >= 10, 5_000, () => index.diagnostics())
    expect(index.diagnostics().header.attempts).toBe(10)
    const drainStart = Date.now()
    while (index.diagnostics().queueLength > 0) {
      clock.advance(100)
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (Date.now() - drainStart > 5_000) throw new Error(`background drain timeout; state: ${JSON.stringify(index.diagnostics())}`)
    }
    expect(index.diagnostics().queueLength).toBe(0)
    expect(index.diagnostics().header.attempts).toBe(15)
    expect(index.diagnostics().bootstrap.initialDone).toBe(true)
    expect(index.diagnostics().bootstrap.lastReconcileAt).toBeDefined()
    stop()
    // 停止后：剩余定时器（保存去抖）到期可触发，但绝不重新排程新定时器。
    clock.advance(60_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(clock.pending()).toBe(0)
    clock.advance(60_000)
    expect(clock.pending()).toBe(0)
    await index.dispose()
    expect(index.diagnostics().entries.total).toBe(15)
  })

  it('dispose 中断进行中的读取（aborted 信号传导）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-slow', { agentPreset: 'dsh-router' })
    let observedSignal: { aborted: boolean } | undefined
    const slowReader = {
      readSessionHeader: async (_dir: string, _id: string, options?: { signal?: { aborted: boolean } }) => {
        observedSignal = options?.signal
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { ok: false, reason: 'aborted' as const, message: 'aborted', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
      },
    }
    const { index } = makeIndex(root, { reader: slowReader as never })
    await index.reconcile()
    const advancing = index.advance()
    await new Promise((resolve) => setTimeout(resolve, 5))
    void advancing.catch(() => undefined)
    await index.dispose()
    expect(observedSignal?.aborted).toBe(true)
  })
})

/* ────────────────────────── 诊断 ────────────────────────── */

describe('SessionHeaderIndex：诊断口径', () => {
  it('diagnostics：bootstrap/队列/判定分布/头 IO/字节/缓存复用/单飞（无私有内容）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-router', { agentPreset: 'dsh-router' })
    await writeSession(root, 's-plain', {})
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    const d = index.diagnostics()
    expect(d.bootstrap.initialDone).toBe(true)
    expect(d.queueLength).toBe(0)
    expect(d.entries).toEqual({
      total: 2,
      router: 1,
      nonrouter: 1,
      unknown: 0,
      live: 0,
      byEvidence: { 'stable-eof': 2, 'header-seeded': 0, live: 0, none: 0 },
    })
    expect(d.header.attempts).toBe(2)
    expect(d.header.bytesCompressed).toBeGreaterThan(0)
    expect(d.header.cacheReused).toBe(0)
    expect(d.concurrency.inflightAdvance).toBe(false)
    expect(d.concurrency.inflightReconcile).toBe(false)
    const serialized = JSON.stringify(d)
    expect(serialized).not.toContain('s-router')
    expect(serialized).not.toContain('--proj--')
  })
})

/* ────────────────────────── 指纹身份（I3 回归） ────────────────────────── */

describe('SessionHeaderIndex：指纹含身份与 generation 集合（I3）', () => {
  it('同 size 同 mtime 的原地重写（inode 不变、ctime 变）也会触发重分类', async () => {
    const root = await tmpRoot()
    const dir = join(root, '--proj--', encodeSegment('s-swap'))
    await mkdir(dir, { recursive: true })
    const eventOf = (pad: number): string => `${JSON.stringify({ type: 'e/x', seq: 0, time: 1, data: { pad: ' '.repeat(pad) } })}\n`
    const headerA = `${JSON.stringify({ type: 'session', version: 4, id: 's-swap', createdAt: 1, isSeeded: false, delegationDepth: 0, agentPreset: 'dsh-router' })}\n`
    const headerB = `${JSON.stringify({ type: 'session', version: 4, id: 's-swap', createdAt: 2, isSeeded: false, delegationDepth: 0 })}\n`
    const totalLen = Math.max(headerA.length, headerB.length) + 2 * eventOf(0).length
    const lineA = headerA + eventOf(totalLen - headerA.length - eventOf(0).length)
    const lineB = headerB + eventOf(totalLen - headerB.length - eventOf(0).length)
    expect(lineA.length).toBe(lineB.length)
    await writeFile(join(dir, 'session.v4.jsonl'), lineA)
    const stamped = new Date(1_600_000_000_000)
    await utimes(join(dir, 'session.v4.jsonl'), stamped, stamped)
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 's-swap', 'router')

    // 原地重写：内容不同但字节数相同、mtime 拍回同一时刻（ctime 无法拍回）。
    // 新内容是另一条合法小日志（头 createdAt 2 无预设 + 凑长事件行）。
    await writeFile(join(dir, 'session.v4.jsonl'), lineB)
    await utimes(join(dir, 'session.v4.jsonl'), stamped, stamped)
    await index.reconcile()
    expect(index.diagnostics().queueLength).toBe(1) // 指纹变了 → 重读
    await index.advance()
    const lookup = index.verdictOf('s-swap')
    expect(lookup.status).toBe('classified')
    if (lookup.status !== 'classified') return
    expect(lookup.verdict).toBe('nonrouter') // 新内容无预设 → 快照语义变化
    expect(lookup.createdAt).toBe(2) // 确实读到了新内容
  })

  it('同 id 跨项目目录迁移：projectDir 不匹配不复用（重读新位置）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-move', {}, '--proj-a--')
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 's-move', 'nonrouter')
    const firstAttempts = index.diagnostics().header.attempts

    await rm(join(root, '--proj-a--'), { recursive: true, force: true })
    await writeSession(root, 's-move', {}, '--proj-b--')
    await index.reconcile()
    expect(index.diagnostics().queueLength).toBe(1)
    await index.advance()
    expect(index.diagnostics().header.attempts).toBe(firstAttempts + 1)
    expectVerdict(index, 's-move', 'nonrouter')
  })

  it('已缓存 zstd 旁新增同版本 plain：generation 集合变化触发重读 → ambiguous 关死', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-dual', { zstd: true })
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 's-dual', 'nonrouter')

    const dir = join(root, '--proj--', encodeSegment('s-dual'))
    await writeFile(join(dir, 'session.v4.jsonl'), `${header('s-dual', {})}\n`)
    await index.reconcile()
    expect(index.diagnostics().queueLength).toBe(1)
    await index.advance()
    const lookup = index.verdictOf('s-dual')
    expect(lookup.status).toBe('classified')
    if (lookup.status !== 'classified') return
    expect(lookup.verdict).toBe('unknown')
    expect(lookup.reason ?? '').toContain('ambiguous')
  })

  it('读取在途时文件被重写：读后指纹复核不符 → 结果作废、重新排队', async () => {
    const root = await tmpRoot()
    const dir = join(root, '--proj--', encodeSegment('s-toc tou'))
    await mkdir(join(root, '--proj--', encodeSegment('s-toc tou')), { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl'), `${header('s-toc tou', { createdAt: 1 })}\n`)
    let releaseRead: (() => void) | undefined
    let gated = true
    const slowReader = {
      readSessionHeader: (readDir: string, sessionId: string): Promise<HeaderReadOutcome> => {
        if (!gated) return new SessionHeaderReader().readSessionHeader(readDir, sessionId)
        return new Promise((resolve) => {
          releaseRead = () => {
            gated = false
            void new SessionHeaderReader().readSessionHeader(readDir, sessionId).then(resolve)
          }
        })
      },
    }
    const { index } = makeIndex(root, { reader: slowReader as never })
    await index.reconcile()
    const advancing = index.advance()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(releaseRead).toBeDefined()
    // 读在途：文件换内容（createdAt 变）。
    await writeFile(join(dir, 'session.v4.jsonl'), `${header('s-toc tou', { createdAt: 2 })}\n`)
    releaseRead!()
    await advancing
    // 读出的快照已过期：不作数，等待下一轮对账重排。
    expect(index.diagnostics().queueLength).toBe(0)
    await index.reconcile()
    expect(index.diagnostics().queueLength).toBe(1)
    await index.advance()
    const lookup = index.verdictOf('s-toc tou')
    expect(lookup.status).toBe('classified')
    if (lookup.status !== 'classified') return
    expect(lookup.createdAt).toBe(2)
  })
})

/* ────────────────────────── 保存纪律（I6 回归） ────────────────────────── */

describe('SessionHeaderIndex：保存不被轮询无限推迟、失败可重试（I6）', () => {
  it('持续 advance + 时钟推进不重置保存期限：首个变更后固定窗口内落盘', async () => {
    const root = await tmpRoot()
    for (let i = 0; i < 12; i += 1) await writeSession(root, `s-${i}`, {})
    const { persistence, state } = memoryPersistence()
    const { index, clock } = makeIndex(root, { persistence: persistence as never })
    await index.hydrate()
    await index.reconcile()
    await index.advance() // 产生真实变更（entries/queue）
    // 模拟 1s 轮询 + 250ms 背景 tick 持续 20 秒：不得推迟保存。
    for (let i = 0; i < 20; i += 1) {
      await index.advance()
      clock.advance(250)
      await index.advance()
      clock.advance(750)
    }
    await new Promise((resolve) => setTimeout(resolve, 20)) // flush 是异步的
    expect(state.saved.length).toBeGreaterThanOrEqual(1)
  })

  it('保存失败保留待写状态：无新变更也在下一窗口重试成功', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-a', {})
    const { persistence, state } = memoryPersistence()
    state.rejectNextSaves = 1
    const { index, clock } = makeIndex(root, { persistence: persistence as never })
    await index.hydrate()
    await index.reconcile()
    await index.advance()
    clock.advance(3_000) // 到点 → 保存 #1 被拒
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state.saved.length).toBe(0)
    clock.advance(3_000) // 无新变更也要重试
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state.saved.length).toBe(1)
  })
})

/* ────────────────────────── 持久化校验（I10 回归） ────────────────────────── */

describe('SessionHeaderIndex：持久化状态路径/事实校验（I10）', () => {
  function entryOf(overrides: Partial<IndexFileState['entries'][number]>): IndexFileState['entries'][number] {
    return {
      sessionId: 's-x', projectDir: '--ok--', file: 'session.v4.jsonl', fingerprint: 'fp',
      verdict: 'unknown', createdAt: 1, isSeeded: false, agentPreset: undefined, origin: 'disk', reason: 'cold',
      ...overrides,
    }
  }

  it('projectDir 路径逃逸（../、分隔符、空段）的缓存条目/失败记录一律拒绝', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-real', {})
    const { persistence } = memoryPersistence({
      version: 1,
      root,
      preset: 'dsh-router',
      savedAt: 1,
      entries: [
        entryOf({ sessionId: 's-escape', projectDir: '../../outside' }),
        entryOf({ sessionId: 's-sep', projectDir: 'a/b' }),
        entryOf({ sessionId: 's-empty', projectDir: '' }),
        entryOf({ sessionId: 's-dot', projectDir: '..' }),
      ],
      failures: [{ sessionId: 's-fail-escape', projectDir: '../..', file: 'session.v4.jsonl', fingerprint: 'x', retryAt: 1, message: 'x' }],
    })
    const { index } = makeIndex(root, { persistence: persistence as never })
    await index.hydrate()
    for (const id of ['s-escape', 's-sep', 's-empty', 's-dot']) {
      expect(index.verdictOf(id).status, id).toBe('pending')
    }
    expect(index.verdictOf('s-fail-escape').status).toBe('pending')
  })

  it('disk 来源的事实矛盾缓存拒绝：router+seeded、无 seeded 的 nonrouter、非规范文件名', async () => {
    const root = await tmpRoot()
    const { persistence } = memoryPersistence({
      version: 1,
      root,
      preset: 'dsh-router',
      savedAt: 1,
      entries: [
        entryOf({ sessionId: 's-lie', verdict: 'router', isSeeded: true }),
        entryOf({ sessionId: 's-fake', verdict: 'nonrouter', isSeeded: false }),
        entryOf({ sessionId: 's-badname', file: 'session.lock' }),
        entryOf({ sessionId: 's-badtime', createdAt: 1.5 }),
      ],
      failures: [],
    })
    const { index } = makeIndex(root, { persistence: persistence as never })
    await index.hydrate()
    for (const id of ['s-lie', 's-fake', 's-badname', 's-badtime']) {
      expect(index.verdictOf(id).status, id).toBe('pending')
    }
  })
})

/* ────────────────────────── 对账错误如实上报（M1 回归） ────────────────────────── */

describe('SessionHeaderIndex：对账错误区分与保留（M1）', () => {
  function failingRootFace(root: string, flag: { failRoot: boolean; failProject?: string }) {
    return {
      readdir: async (dir: string) => {
        if (flag.failRoot && dir === root) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        if (flag.failProject !== undefined && dir === join(root, flag.failProject)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return fsReaddir(dir, { withFileTypes: true })
      },
      stat: (path: string) => fsStat(path),
    }
  }

  it('root 读失败（非 ENOENT）：不清既有条目、diagnostics 暴露对账错误', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-keep', {})
    const flag = { failRoot: false }
    const { index } = makeIndex(root, { fs: failingRootFace(root, flag) as never })
    await index.reconcile()
    await index.advance()
    expect(index.diagnostics().entries.total).toBe(1)
    flag.failRoot = true
    await index.reconcile()
    expect(index.diagnostics().entries.total).toBe(1) // 不因读不到而当空库清掉
    expect(index.diagnostics().bootstrap.lastReconcileError ?? '').not.toBe('')
  })

  it('root ENOENT（新装空库）：无错误标记', async () => {
    const root = await tmpRoot()
    const { index } = makeIndex(root)
    await index.reconcile()
    expect(index.diagnostics().bootstrap.lastReconcileError).toBeUndefined()
    expect(index.diagnostics().entries.total).toBe(0)
  })

  it('单个项目目录读失败：partial 对账（其余子树照常，不清 membership）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-a', {}, '--proj-a--')
    await writeSession(root, 's-b', {}, '--proj-b--')
    const flag = { failRoot: false, failProject: '--proj-a--' }
    const { index } = makeIndex(root, { fs: failingRootFace(root, flag) as never })
    await index.reconcile()
    expect(index.diagnostics().bootstrap.lastReconcileError ?? '').not.toBe('')
    expect(index.diagnostics().queueLength).toBe(1) // proj-b 的候选照常入队
    await index.advance()
    expectVerdict(index, 's-b', 'nonrouter') // 小日志扫描（无预设组合）
    expect(index.verdictOf('s-a').status).toBe('pending') // proj-a 子树未枚举：保持未知而非删除
  })
})

/* ────────────────────────── I2 r2：指纹复核后的提交前复查 ────────────────────────── */

describe('SessionHeaderIndex：指纹复核在途的 live 覆盖窗口（I2 r2）', () => {
  it('复核 stat 挂起期间 live 权威事实到达：盘读结果不得在复核后回写覆盖', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-recheck', { agentPreset: 'other' }) // 盘头（cold → unknown）
    let armed = false
    let releaseStat: (() => void) | undefined
    const gatedFs = {
      readdir: (dir: string) => fsReaddir(dir, { withFileTypes: true }),
      stat: (path: string) => {
        if (!armed) {
          armed = true // enumerate 的 stat 直接过；advance 的读后复核 stat 挂起。
          return fsStat(path)
        }
        return new Promise((resolve) => {
          releaseStat = () => resolve(fsStat(path))
        }) as never
      },
    }
    const { index } = makeIndex(root, { fs: gatedFs as never, resolveLivePreset: () => 'dsh-router' })
    await index.reconcile()
    const advancing = index.advance()
    // 等到指纹复核的 stat **真正挂起**再断言（不用固定睡眠：机器负载下固定
    // 5ms 可能不够，会让本用例偶发失败——测试同步问题，不涉及生产语义）。
    for (let attempt = 0; attempt < 400 && releaseStat === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(releaseStat).toBeDefined()
    // 指纹复核 stat 挂起中：权威 selected 事件到达（router）。
    index.onLiveSessionEvent(liveSession({ id: 's-recheck' }), { type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } })
    releaseStat!()
    await advancing
    expectVerdict(index, 's-recheck', 'router') // 复核后提交前被 revision 护栏拦下
  })
})

/* ────────────────────────── I10 r2：载入缓存核指纹前不授权副作用 ────────────────────────── */

describe('SessionHeaderIndex：hydrate 缓存保持未验证（I10 r2）', () => {
  it('载入的 seeded nonrouter 缓存：未经成功对账核指纹前 verdictOf=pending；核过才 classified', async () => {
    const root = await tmpRoot()
    await writeSession(root, 'b', { isSeeded: true, agentPreset: 'dsh-router' })
    const stamp = await fsStat(join(root, '--proj--', encodeSegment('b'), 'session.v4.jsonl'))
    const names = await fsReaddir(join(root, '--proj--', encodeSegment('b')))
    const namesKey = [...names].sort().join('|')
    const { persistence } = memoryPersistence({
      version: 1,
      root,
      preset: 'dsh-router',
      savedAt: 1,
      entries: [{
        sessionId: 'b', projectDir: '--proj--', file: 'session.v4.jsonl',
        fingerprint: `${stamp.dev}:${stamp.ino}:${stamp.mtimeMs}:${stamp.ctimeMs}:${stamp.size}:${namesKey}`,
        verdict: 'nonrouter', createdAt: 1, isSeeded: true, agentPreset: undefined, origin: 'disk', reason: 'seeded session excluded',
      }],
      failures: [],
    })
    let failRoot = false
    const failingFs = {
      readdir: async (dir: string) => {
        if (failRoot && dir === root) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return fsReaddir(dir, { withFileTypes: true })
      },
      stat: (path: string) => fsStat(path),
    }
    const { index } = makeIndex(root, { persistence: persistence as never, fs: failingFs as never })
    await index.hydrate()
    expect(index.verdictOf('b').status).toBe('pending') // 载入即待验证，不授权
    failRoot = true
    await index.reconcile()
    expect(index.verdictOf('b').status).toBe('pending') // 对账失败不得提升 trusted
    expect(index.diagnostics().bootstrap.lastReconcileError ?? '').not.toBe('')
    failRoot = false
    await index.reconcile()
    expect(index.verdictOf('b').status).toBe('classified') // 指纹核过 → 可用
    const lookup = index.verdictOf('b')
    expect(lookup.status === 'classified' && lookup.verdict).toBe('nonrouter')
    expect(index.diagnostics().header.attempts).toBe(0) // 核验靠 stat，不靠重读
  })
})

/* ────────────────────────── M1 r2：session 层错误也 partial + 降级可恢复 ────────────────────────── */

describe('SessionHeaderIndex：session 层对账错误与可恢复降级（M1 r2）', () => {
  it('session 目录 readdir 失败：报 partial、保留该会话既有条目（不清成 pending/删除）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 'b', { isSeeded: true })
    let breakDir = ''
    const failingFs = {
      readdir: async (dir: string) => {
        if (breakDir !== '' && dir === join(root, '--proj--', encodeSegment('b'))) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return fsReaddir(dir, { withFileTypes: true })
      },
      stat: (path: string) => fsStat(path),
    }
    const { index } = makeIndex(root, { fs: failingFs as never })
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 'b', 'nonrouter')
    breakDir = join(root, '--proj--', encodeSegment('b'))
    await index.reconcile()
    expect(index.diagnostics().bootstrap.lastReconcileError ?? '').not.toBe('')
    expectVerdict(index, 'b', 'nonrouter') // 子树读不到 ≠ 会话消失
  })

  it('generation stat 失败：同样 partial 且保留', async () => {
    const root = await tmpRoot()
    await writeSession(root, 'c', { isSeeded: true })
    let breakStat = false
    const failingFs = {
      readdir: async (dir: string) => fsReaddir(dir, { withFileTypes: true }),
      stat: (path: string) => {
        if (breakStat && path.includes(encodeSegment('c'))) return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        return fsStat(path)
      },
    }
    const { index } = makeIndex(root, { fs: failingFs as never })
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 'c', 'nonrouter')
    breakStat = true
    await index.reconcile()
    expect(index.diagnostics().bootstrap.lastReconcileError ?? '').not.toBe('')
    expectVerdict(index, 'c', 'nonrouter')
  })

  it('unsupportedCodec 降级可恢复：条目重判后不再粘性为 true', async () => {
    const root = await tmpRoot()
    await writeSession(root, 'u', { zstd: true })
    let unsupportedOnce = true
    let reads = 0
    const flaky = {
      readSessionHeader: async (dir: string, sessionId: string): Promise<HeaderReadOutcome> => {
        reads += 1
        if (unsupportedOnce) {
          return { ok: false, reason: 'unsupported' as const, message: 'zstd unavailable', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
        }
        return new SessionHeaderReader().readSessionHeader(dir, sessionId)
      },
    }
    const { index } = makeIndex(root, { reader: flaky as never })
    await index.reconcile()
    await index.advance()
    expect(index.diagnostics().degraded.unsupportedCodec).toBe(true)
    // 环境恢复 + 文件指纹变化 → 重判 → 降级标记清除。
    unsupportedOnce = false
    await writeSession(root, 'u', { zstd: true, agentPreset: 'x' })
    await index.reconcile()
    await index.advance()
    expect(index.diagnostics().degraded.unsupportedCodec).toBe(false)
  })
})

/* ────────────────────────── I6 r2：保存 worker（在途至多一次合并后续） ────────────────────────── */

describe('SessionHeaderIndex：慢保存在途不堆快照（I6 r2）', () => {
  it('save 挂起期间反复到期/轮询：至多一笔在途 + 一笔合并后续（不是每拍一个快照）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-a', {})
    const clock = manualClock()
    const savedSnapshots: number[] = []
    let releaseSave: (() => void) | undefined
    let saveCalls = 0
    let hanging = false
    const persistence: IndexPersistence = {
      load: async () => null,
      save: async (state: IndexFileState) => {
        saveCalls += 1
        savedSnapshots.push(state.entries.length)
        if (hanging && saveCalls === 1) {
          await new Promise<void>((resolve) => { releaseSave = resolve })
        }
      },
    }
    const { index } = makeIndex(root, { persistence: persistence as never, clock })
    await index.hydrate()
    await index.reconcile()
    await index.advance()
    hanging = true
    clock.advance(3_000) // 到点 → save #1 启动并挂起
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(saveCalls).toBe(1)
    // 在途期间：反复「到期」与轮询（旧实现会每拍排一个完整快照闭包）。
    for (let i = 0; i < 6; i += 1) {
      await index.advance()
      clock.advance(3_000)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    // 在途期间再来一笔真实变更（合并进唯一后续保存）。
    index.onLiveSession(liveSession({ id: 's-live' }))
    releaseSave!()
    await index.dispose()
    expect(saveCalls).toBeLessThanOrEqual(2)
    expect(savedSnapshots[savedSnapshots.length - 1]).toBeGreaterThanOrEqual(1)
  })
})

/* ────────────────────────── I7 r2：dispose 等待独立 hydrate ────────────────────────── */

describe('SessionHeaderIndex：dispose 等待在途 hydrate（I7 r2）', () => {
  it('hydrate 的 load 挂起时 dispose 不返回；释放后实例不再被改动', async () => {
    const root = await tmpRoot()
    let releaseLoad: (() => void) | undefined
    const gated: IndexPersistence = {
      load: () => new Promise((resolve) => { releaseLoad = () => resolve(null) }),
      save: () => undefined,
    }
    const { index } = makeIndex(root, { persistence: gated })
    let hydrated = false
    void index.hydrate().then(() => { hydrated = true })
    const disposing = index.dispose()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(disposing).toEqual(expect.anything()) // 仍挂起（用 then 探测）
    let disposed = false
    void disposing.then(() => { disposed = true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(disposed).toBe(false) // 没等 hydrate 收尾不得返回
    releaseLoad!()
    await disposing
    expect(disposed).toBe(true)
    // dispose 完成后 live 回调不再生效
    index.onLiveSession(liveSession({ id: 's-late' }))
    expect(index.verdictOf('s-late').status).toBe('pending')
    void hydrated
  })
})

/* ────────────────────────── I8 r2：队列游标与到期调度 ────────────────────────── */

describe('SessionHeaderIndex：队列游标/到期重试调度（I8 r2）', () => {
  it('失败重试按到期调度：未到期的背景 tick 不重试，到期后第一个 tick 重试成功', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-one', {})
    let failFirst = true
    const flaky = {
      readSessionHeader: async (dir: string, sessionId: string): Promise<HeaderReadOutcome> => {
        if (failFirst) {
          failFirst = false
          return { ok: false, reason: 'unreadable' as const, message: 'boom', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
        }
        return new SessionHeaderReader().readSessionHeader(dir, sessionId)
      },
    }
    const { index, clock } = makeIndex(root, { reader: flaky as never, failureRetryMs: 1_000, backgroundIntervalMs: 100 })
    const stop = index.start()
    await waitFor(() => index.diagnostics().bootstrap.initialDone) // 初始对账先落定
    clock.advance(100) // 首个背景 tick 驱动首读（失败）
    await waitFor(() => index.diagnostics().failures === 1)
    const attemptsAtFail = index.diagnostics().header.attempts
    for (let i = 0; i < 5; i += 1) {
      clock.advance(100)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(index.diagnostics().header.attempts).toBe(attemptsAtFail) // 未到期零重试
    clock.advance(1_200)
    await waitFor(() => index.diagnostics().failures === 0)
    expect(index.diagnostics().header.attempts).toBe(attemptsAtFail + 1)
    stop()
    await index.dispose()
  })

  it('大队列 FIFO 分批不乱序；游标不清掉后到的新候选', async () => {
    const root = await tmpRoot()
    for (let i = 0; i < 25; i += 1) await writeSession(root, `s-${String(i).padStart(2, '0')}`, {})
    const order: string[] = []
    const countingReader = {
      readSessionHeader: async (dir: string, sessionId: string): Promise<HeaderReadOutcome> => {
        order.push(sessionId)
        return new SessionHeaderReader().readSessionHeader(dir, sessionId)
      },
    }
    const { index } = makeIndex(root, { reader: countingReader as never })
    await index.reconcile()
    await index.advance()
    await index.advance()
    await index.advance()
    expect(index.diagnostics().queueLength).toBe(0)
    // FIFO：三批正好按发现序（s-00..s-24）取完。
    expect(order).toEqual(Array.from({ length: 25 }, (_, i) => `s-${String(i).padStart(2, '0')}`))
    // 游标推进后新候选照常处理。
    await writeSession(root, 's-late', {})
    await index.reconcile()
    expect(index.diagnostics().queueLength).toBe(1)
    await index.advance()
    expect(index.verdictOf('s-late').status).toBe('classified')
    expect(order[order.length - 1]).toBe('s-late')
  })
})

/* ────────────────────────── R2-B：nextRetryAt 全路径维护 ────────────────────────── */

describe('SessionHeaderIndex：失败重试期限的全路径一致（R2-B）', () => {
  it('hydrate 载入的到期失败：hasBacklog=true 且背景 tick 重试（不是永久 Infinity）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-back', {}) // 失败要挂在真实在盘会话上（否则成员清理会正确删除它）
    const clock = manualClock(1_000_000)
    const { persistence } = memoryPersistence({
      version: 1,
      root,
      preset: 'dsh-router',
      savedAt: 1,
      entries: [],
      failures: [{ sessionId: 's-back', projectDir: '--proj--', file: 'session.v4.jsonl', fingerprint: 'x', retryAt: 900_000, message: 'old failure' }],
    })
    const calls: string[] = []
    const reader = {
      readSessionHeader: async (_dir: string, id: string): Promise<HeaderReadOutcome> => {
        calls.push(id)
        return { ok: false, reason: 'unreadable' as const, message: 'still bad', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
      },
    }
    const { index } = makeIndex(root, { persistence: persistence as never, reader: reader as never, clock, failureRetryMs: 5_000, backgroundIntervalMs: 100 })
    await index.hydrate()
    expect(index.verdictOf('s-back').status).toBe('failed')
    expect(index.hasBacklog()).toBe(true) // 载入的到期失败就是积压（当前实现漏初始化 → 红）
    const stop = index.start()
    clock.advance(100) // 手动时钟驱动首个背景 tick
    await waitFor(() => index.diagnostics().header.attempts >= 1)
    expect(calls).toContain('s-back')
    stop()
    await index.dispose()
  })

  it('连续失败改期：未到新期限时 hasBacklog=false（不留已过期的旧最小值）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-again', {})
    let failures = 0
    const reader = {
      readSessionHeader: async (dir: string, id: string): Promise<HeaderReadOutcome> => {
        failures += 1
        return { ok: false, reason: 'unreadable' as const, message: 'bad', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
      },
    }
    const { index, clock } = makeIndex(root, { reader: reader as never, failureRetryMs: 1_000 })
    await index.reconcile()
    await index.advance() // 第一次失败：retryAt = now + 1000
    expect(index.hasBacklog()).toBe(false)
    clock.advance(1_500)
    expect(index.hasBacklog()).toBe(true)
    await index.advance() // 重试再失败：新 retryAt = now + 1000
    expect(failures).toBe(2)
    expect(index.hasBacklog()).toBe(false) // 旧最小值不得残留（当前实现 → 红）
  })

  it('live 权威事实清掉失败记录：hasBacklog 立即回落（重算最小期限）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-rescued', {})
    const reader = {
      readSessionHeader: async (): Promise<HeaderReadOutcome> => ({ ok: false, reason: 'unreadable' as const, message: 'bad', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }),
    }
    const { index } = makeIndex(root, { reader: reader as never, failureRetryMs: 0 })
    await index.reconcile()
    await index.advance()
    expect(index.hasBacklog()).toBe(true) // 冷却 0：立即可重试（最小期限已过期）
    // live 权威事实清失败 → 最小期限重算，不再有积压。
    index.onLiveSessionEvent(liveSession({ id: 's-rescued' }), { type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } })
    expect(index.verdictOf('s-rescued').status).toBe('classified')
    expect(index.hasBacklog()).toBe(false) // 当前实现不重算 → 红
    expect(index.diagnostics().failures).toBe(0)
  })
})

/* ────────────────────────── I1 r3：index 的枚举/复核受同设施保护 ────────────────────────── */

describe('SessionHeaderIndex：dispose 用真实 AbortSignal 即刻唤醒在途 IO（I1 r3）', () => {
  it('指纹复核 stat 挂起时 dispose 即刻返回（abort 唤醒，不等 deadline）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-stuck', {})
    let armed = false
    let releaseStat: (() => void) | undefined
    const gatedFs = {
      readdir: (dir: string) => fsReaddir(dir, { withFileTypes: true }),
      stat: (path: string) => {
        if (!armed) {
          armed = true
          return fsStat(path)
        }
        return new Promise((resolve) => { releaseStat = () => resolve(fsStat(path)) }) as never
      },
    }
    const { index } = makeIndex(root, { fs: gatedFs as never })
    await index.reconcile()
    const advancing = index.advance()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(releaseStat).toBeDefined()
    const t0 = Date.now()
    const disposing = index.dispose()
    await disposing
    expect(Date.now() - t0).toBeLessThan(900) // abort 即刻唤醒，不是等 2s deadline
    releaseStat!()
    await advancing.catch(() => undefined)
  })

  it('枚举 readdir 挂起时 dispose 即刻返回', async () => {
    const root = await tmpRoot()
    let releaseReaddir: (() => void) | undefined
    const gatedFs = {
      readdir: (dir: string) => {
        if (dir === root) {
          return new Promise((resolve) => { releaseReaddir = () => resolve([]) }) as never
        }
        return fsReaddir(dir, { withFileTypes: true })
      },
      stat: (path: string) => fsStat(path),
    }
    const { index } = makeIndex(root, { fs: gatedFs as never })
    const reconciling = index.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(releaseReaddir).toBeDefined()
    const t0 = Date.now()
    await index.dispose()
    expect(Date.now() - t0).toBeLessThan(900)
    releaseReaddir!()
    await reconciling.catch(() => undefined)
  })
})

/* ────────────────────────── R2-B r4：提前退出的 typed 状态机 + 非平方成本 ────────────────────────── */

describe('SessionHeaderIndex：读后复核的提前退出有明确去处（R2-B r4）', () => {
  /** 一条已到期失败的持久化夹具（失败原因由 fs/reader 假件决定）。 */
  function failedState(root: string, sessionId: string, fingerprint: string): IndexFileState {
    return {
      version: 1,
      root,
      preset: 'dsh-router',
      savedAt: 1,
      entries: [],
      failures: [{ sessionId, projectDir: '--proj--', file: 'session.v4.jsonl', fingerprint, retryAt: 1, message: '旧失败' }],
    }
  }

  it('指纹复核的 IO 失败不当成「变了」：失败改期进冷却（不再每轮当积压重试）', async () => {
    const root = await tmpRoot()
    const clock = manualClock(100)
    const fingerprint = '1:2:3:4:5:session.v4.jsonl'
    const persistence = memoryPersistence(failedState(root, 's-eacces', fingerprint))
    const { index } = makeIndex(root, {
      persistence: persistence.persistence,
      clock,
      failureRetryMs: 600_000,
      fs: {
        readdir: async () => [{ name: 'session.v4.jsonl', isDirectory: () => false }],
        stat: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) },
      },
      reader: {
        readSessionHeader: async () => ({
          ok: false,
          reason: 'unreadable' as const,
          message: 'unreadable',
          stats: { bytesCompressed: 0, bytesDecompressed: 0 },
        }),
      },
    })
    await index.hydrate()
    expect(index.hasBacklog()).toBe(true) // 载入的失败已到期
    await index.advance()
    const lookup = index.verdictOf('s-eacces')
    expect(lookup.status).toBe('failed')
    if (lookup.status === 'failed') expect(lookup.retryAt).toBeGreaterThan(100) // 已改期进冷却
    expect(index.hasBacklog()).toBe(false) // 新期限未到 → 不再每轮当积压
  })

  it('会话消失（missing）清掉旧失败：不再卡在冷却里', async () => {
    const root = await tmpRoot()
    const clock = manualClock(100)
    const fingerprint = '1:2:3:4:5:session.v4.jsonl'
    const persistence = memoryPersistence(failedState(root, 's-gone', fingerprint))
    const { index } = makeIndex(root, {
      persistence: persistence.persistence,
      clock,
      failureRetryMs: 600_000,
      fs: {
        readdir: async () => [{ name: 'session.v4.jsonl', isDirectory: () => false }],
        stat: async () => ({ mtimeMs: 3, size: 5, dev: 1, ino: 2, ctimeMs: 4 }),
      },
      reader: {
        readSessionHeader: async () => ({
          ok: false,
          reason: 'missing' as const,
          message: 'session directory not found',
          stats: { bytesCompressed: 0, bytesDecompressed: 0 },
        }),
      },
    })
    await index.hydrate()
    await index.advance()
    expect(index.verdictOf('s-gone').status).not.toBe('failed')
    expect(index.hasBacklog()).toBe(false)
  })

  it('批量删除失败记录：最早期限重算不得退化成平方（不得逐条全 F 扫描）', async () => {
    const root = await tmpRoot()
    const total = 400
    const failures = Array.from({ length: total }, (_, i) => ({
      sessionId: `s-${i}`,
      projectDir: '--proj--',
      file: 'session.v4.jsonl',
      fingerprint: `fp-${i}`,
      retryAt: 1 + i,
      message: 'boom',
    }))
    const persistence = memoryPersistence({ version: 1, root, preset: 'dsh-router', savedAt: 1, entries: [], failures })
    const { index } = makeIndex(root, {
      persistence: persistence.persistence,
      fs: {
        readdir: async () => [],
        stat: async () => ({ mtimeMs: 0, size: 0, dev: 0, ino: 0, ctimeMs: 0 }),
      },
    })
    await index.hydrate()
    // 对账：磁盘上什么都没有 → 全部失败记录被逐条移除
    await index.reconcile()
    expect(index.diagnostics().failures).toBe(0)
    const scans = (index as unknown as { failureDeadlineScanCount: number }).failureDeadlineScanCount
    expect(scans).toBeLessThanOrEqual(8 * total + 128)
  })
})

/* ────────────────────────── 基础 round5：typed 分支提交屏障（R4-B） ────────────────────────── */

describe('基础 round5：指纹复核后、任何 typed 分支写入前必须过 revision/disposed 屏障（R4-B）', () => {
  /** 到期失败夹具（与 R2-B r4 相同形状）。 */
  function failedState(root: string, sessionId: string): IndexFileState {
    return {
      version: 1,
      root,
      preset: 'dsh-router',
      savedAt: 1,
      entries: [],
      failures: [{ sessionId, projectDir: '--proj--', file: 'session.v4.jsonl', fingerprint: '1:2:3:4:5:session.v4.jsonl', retryAt: 1, message: '旧失败' }],
    }
  }

  it('gone 分支：复核 stat 在途先到达 live router 事件再 ENOENT → live 判定不得被删除', async () => {
    const root = await tmpRoot()
    const clock = manualClock(100)
    const persistence = memoryPersistence(failedState(root, 's-live-gone'))
    const { index } = makeIndex(root, {
      persistence: persistence.persistence,
      clock,
      failureRetryMs: 600_000,
      fs: {
        readdir: async () => [{ name: 'session.v4.jsonl', isDirectory: () => false }],
        stat: async () => {
          // 指纹 stat 在途：s 的 live 权威选择事件先到达（revision 前进），随后 stat 报 ENOENT
          index.onLiveSessionEvent(
            { id: 's-live-gone', header: { id: 's-live-gone', version: 4, createdAt: 5, isSeeded: false } },
            { type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } },
          )
          throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
        },
      },
      reader: {
        readSessionHeader: async () => ({
          ok: false,
          reason: 'unreadable' as const,
          message: 'unreadable',
          stats: { bytesCompressed: 0, bytesDecompressed: 0 },
        }),
      },
    })
    await index.hydrate()
    await index.advance()
    // live 权威事实已取得：不得被 gone 分支删成 pending
    const lookup = index.verdictOf('s-live-gone')
    expect(lookup.status).toBe('classified')
    if (lookup.status === 'classified') expect(lookup.verdict).toBe('router')
    expect(index.hasBacklog()).toBe(false)
  })

  it('unavailable 分支：同一场景 EACCES → 不得在 live 清掉失败后重新制造旧 IO 失败', async () => {
    const root = await tmpRoot()
    const clock = manualClock(100)
    const persistence = memoryPersistence(failedState(root, 's-live-eacces'))
    const { index } = makeIndex(root, {
      persistence: persistence.persistence,
      clock,
      failureRetryMs: 600_000,
      fs: {
        readdir: async () => [{ name: 'session.v4.jsonl', isDirectory: () => false }],
        stat: async () => {
          index.onLiveSessionEvent(
            { id: 's-live-eacces', header: { id: 's-live-eacces', version: 4, createdAt: 5, isSeeded: false } },
            { type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } },
          )
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        },
      },
      reader: {
        readSessionHeader: async () => ({
          ok: false,
          reason: 'unreadable' as const,
          message: 'unreadable',
          stats: { bytesCompressed: 0, bytesDecompressed: 0 },
        }),
      },
    })
    await index.hydrate()
    await index.advance()
    const lookup = index.verdictOf('s-live-eacces')
    expect(lookup.status).toBe('classified')
    if (lookup.status === 'classified') expect(lookup.verdict).toBe('router')
    // live 判定已清失败：unavailable 分支不得复活它
    expect(index.diagnostics().failures).toBe(0)
    expect(index.hasBacklog()).toBe(false)
  })
})

/* ────────────────────────── 基础 round5：到期失败组批真消费堆（R2-B 残留） ────────────────────────── */

describe('基础 round5：到期失败候选从到期堆真消费（不逐批从头扫 Map 前缀）', () => {
  it('F 条同时到期失败、每批 1 条、逐条改期：failureDue 判定调用必须线性以下（旧实现 F(F+1)/2）', async () => {
    const root = await tmpRoot()
    const total = 30
    const failures = Array.from({ length: total }, (_, i) => ({
      sessionId: `s-${String(i).padStart(2, '0')}`,
      projectDir: '--proj--',
      file: 'session.v4.jsonl',
      fingerprint: `fp-${i}`,
      retryAt: 1,
      message: 'boom',
    }))
    const persistence = memoryPersistence({ version: 1, root, preset: 'dsh-router', savedAt: 1, entries: [], failures })
    let readerCalls = 0
    const { index } = makeIndex(root, {
      persistence: persistence.persistence,
      clock: manualClock(100),
      batchAttempts: 1,
      failureRetryMs: 600_000,
      fs: {
        readdir: async () => [{ name: 'session.v4.jsonl', isDirectory: () => false }],
        stat: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
      },
      reader: {
        readSessionHeader: async () => {
          readerCalls += 1
          return { ok: false, reason: 'unreadable' as const, message: 'unreadable', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
        },
      },
    })
    await index.hydrate()
    // 统计 failureDue 调用（实例属性遮蔽原型方法）
    const indexAny = index as unknown as Record<string, unknown>
    const originalFailureDue = indexAny['failureDue'] as (this: SessionHeaderIndex, id: string) => boolean
    let failureDueCalls = 0
    indexAny['failureDue'] = function dueSpy(this: SessionHeaderIndex, id: string): boolean {
      failureDueCalls += 1
      return originalFailureDue.call(this, id)
    }
    for (let i = 0; i < total; i += 1) await index.advance()
    // 全部 F 条各被真正尝试并改期一次
    expect(readerCalls).toBe(total)
    // 旧实现每批从 Map 头扫描已改期前缀：累计 F(F+1)/2 = 465；修复后必须 ≤ F
    expect(failureDueCalls).toBeLessThanOrEqual(total)
  })

  it('认领未消费（批中断）：未改期的到期期限被还原压回，下一轮仍可取到（不丢重试）', async () => {
    const root = await tmpRoot()
    const failures = ['s-a', 's-b'].map((sessionId) => ({
      sessionId,
      projectDir: '--proj--',
      file: 'session.v4.jsonl',
      fingerprint: '1:2:3:4:5:session.v4.jsonl',
      retryAt: 1,
      message: 'boom',
    }))
    const persistence = memoryPersistence({ version: 1, root, preset: 'dsh-router', savedAt: 1, entries: [], failures })
    const clock = manualClock(100)
    let readerCalls = 0
    let abortFirst = true
    const { index } = makeIndex(root, {
      persistence: persistence.persistence,
      clock,
      batchAttempts: 2,
      failureRetryMs: 600_000,
      fs: {
        readdir: async () => [{ name: 'session.v4.jsonl', isDirectory: () => false }],
        stat: async () => ({ mtimeMs: 3, size: 5, dev: 1, ino: 2, ctimeMs: 4 }),
      },
      reader: {
        readSessionHeader: async () => {
          readerCalls += 1
          if (abortFirst) {
            abortFirst = false
            return { ok: false, reason: 'aborted' as const, message: 'aborted', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
          }
          return { ok: false, reason: 'unreadable' as const, message: 'unreadable', stats: { bytesCompressed: 0, bytesDecompressed: 0 } }
        },
      },
    })
    await index.hydrate()
    // 第一批：认领两条，首条 aborted 中断批处理 → 第二条未被消费，期限必须被还原
    await index.advance()
    expect(readerCalls).toBe(1)
    expect(index.hasBacklog()).toBe(true) // 未消费的到期失败仍在
    // 第二批：两条都到期，全部尝试并改期
    await index.advance()
    expect(readerCalls).toBe(3)
    expect(index.hasBacklog()).toBe(false)
    expect(index.diagnostics().failures).toBe(2)
  })
})

/* ────────────────────────── cold verdict v2：stable-EOF 扫描集成 ────────────────────────── */

describe('SessionHeaderIndex：cold v2（stable-EOF 扫描、证据落盘、定点核验）', () => {
  /** 写一条完整小日志（自定行清单）。 */
  async function writeCold(root: string, sessionId: string, lines: string[], name = 'session.v4.jsonl'): Promise<string> {
    const dir = join(root, '--proj--', encodeSegment(sessionId))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), lines.map((line) => `${line}\n`).join(''))
    return dir
  }
  const selected = (seq: number, preset: string): string => JSON.stringify({ type: 'agent-preset/selected', seq, time: 1, data: { agentPreset: preset } })
  const turnStart = (seq: number): string => JSON.stringify({ type: 'turn/start', seq, time: 1, data: { turn: 1 } })

  it('selected 覆盖头值（含首 turn 之后）：头无预设+选 router→router；头 router+选 other→nonrouter；多次最后胜', async () => {
    const root = await tmpRoot()
    await writeCold(root, 'c-a', [header('c-a'), selected(0, 'dsh-router'), turnStart(1)])
    await writeCold(root, 'c-b', [header('c-b', { agentPreset: 'dsh-router' }), selected(0, 'other')])
    await writeCold(root, 'c-c', [header('c-c'), selected(0, 'x'), turnStart(1), selected(2, 'dsh-router'), selected(3, 'final-other')])
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 'c-a', 'router')
    expectVerdict(index, 'c-b', 'nonrouter')
    expectVerdict(index, 'c-c', 'nonrouter') // 最后 selected 胜（turn 后的也算）
    const lookup = index.verdictOf('c-c')
    if (lookup.status === 'classified') expect(lookup.agentPreset).toBe('final-other')
    expect(index.diagnostics().scan.finals).toBe(3)
    expect(index.diagnostics().entries.byEvidence['stable-eof']).toBe(3)
  })

  it('扫描在途 live selected 到达：盘扫描结果作废，live 权威判定不被覆盖（revision 屏障）', async () => {
    const root = await tmpRoot()
    await writeCold(root, 'c-live', [header('c-live', { agentPreset: 'dsh-router' })])
    const real = new SessionHeaderReader()
    let release: (() => void) | undefined
    const gated = {
      readSessionHeader: (dir: string, id: string, opts?: unknown) => real.readSessionHeader(dir, id, opts as never),
      scanSessionLog: (dir: string, id: string, opts?: unknown): Promise<unknown> =>
        new Promise((resolve) => {
          release = () => { void real.scanSessionLog(dir, id, opts as never).then(resolve) }
        }),
    }
    const { index } = makeIndex(root, { reader: gated as never })
    await index.reconcile()
    const advancing = index.advance()
    await waitFor(() => release !== undefined)
    // 扫描在途：live 权威选择事件到达（覆盖头值 → nonrouter）
    index.onLiveSessionEvent(
      { id: 'c-live', header: { id: 'c-live', version: 4, createdAt: 1_700_000_000_000, isSeeded: false } },
      { type: 'agent-preset/selected', data: { agentPreset: 'other' } },
    )
    release!()
    await advancing
    expectVerdict(index, 'c-live', 'nonrouter') // live 事实保留
    const lookup = index.verdictOf('c-live')
    if (lookup.status === 'classified') expect(lookup.origin).toBe('live')
  })

  it('重启复用零重扫；文件追加 selected 改变指纹 → 作废重扫 → 判定翻转（快照语义，非永久不变）', async () => {
    const root = await tmpRoot()
    const dir = await writeCold(root, 'c-flip', [header('c-flip', { agentPreset: 'dsh-router' })])
    const { persistence } = memoryPersistence()
    const first = makeIndex(root, { persistence: persistence as never })
    await first.index.hydrate()
    await first.index.reconcile()
    await first.index.advance()
    expectVerdict(first.index, 'c-flip', 'router')
    expect(first.index.diagnostics().scan.attempts).toBe(1)
    await first.index.dispose()

    const second = makeIndex(root, { persistence: persistence as never })
    await second.index.hydrate()
    await second.index.reconcile()
    expect(second.index.diagnostics().scan.attempts).toBe(0) // 指纹未变：证据复用，零重扫
    expectVerdict(second.index, 'c-flip', 'router')

    await appendFile(join(dir, 'session.v4.jsonl'), `${selected(0, 'other')}\n`)
    await second.index.reconcile()
    expect(second.index.diagnostics().queueLength).toBe(1) // 指纹变了 → 作废重排
    await second.index.advance()
    expect(second.index.diagnostics().scan.attempts).toBe(1)
    expectVerdict(second.index, 'c-flip', 'nonrouter') // 重扫后按新内容翻转
  })

  it('v1 旧缓存载入：只保留 seeded 排除（不可变头事实），其余按 cold v2 重扫', async () => {
    const root = await tmpRoot()
    await writeCold(root, 'c-keep', [header('c-keep', { isSeeded: true, agentPreset: 'dsh-router' })])
    const stat = await fsStat(join(root, '--proj--', encodeSegment('c-keep'), 'session.v4.jsonl'))
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:session.v4.jsonl`
    const { persistence } = memoryPersistence({
      version: 1,
      root,
      preset: 'dsh-router',
      savedAt: 1,
      entries: [
        { sessionId: 'c-keep', projectDir: '--proj--', file: 'session.v4.jsonl', fingerprint, verdict: 'nonrouter', createdAt: 1, isSeeded: true, agentPreset: 'dsh-router', origin: 'disk', reason: 'seeded session excluded' },
        { sessionId: 'c-stale', projectDir: '--proj--', file: 'session.v4.jsonl', fingerprint: 'stale', verdict: 'unknown', createdAt: undefined, isSeeded: false, agentPreset: undefined, origin: 'disk', reason: 'cold session: creation header is not authoritative' },
      ],
      failures: [],
    })
    const { index } = makeIndex(root, { persistence: persistence as never })
    await index.hydrate()
    await index.reconcile()
    // seeded 排除直接复用（unverified 核指纹后转正）；c-stale 不在盘上：被对账清掉。
    expectVerdict(index, 'c-keep', 'nonrouter')
    expect(index.verdictOf('c-stale').status).toBe('pending')
    await index.advance()
    expect(index.diagnostics().scan.attempts).toBe(0) // seeded 不扫；c-stale 已不存在
  })

  it('扫描瞬态失败进冷却后重试成功；终态 cap 显式 unknown 不重试', async () => {
    const root = await tmpRoot()
    await writeCold(root, 'c-transient', [header('c-transient', { agentPreset: 'dsh-router' })])
    await writeCold(root, 'c-cap', [header('c-cap', { agentPreset: 'dsh-router' })])
    const real = new SessionHeaderReader()
    const unstableOnce = new Set<string>(['c-transient'])
    const reader = {
      readSessionHeader: (dir: string, id: string, opts?: unknown) => real.readSessionHeader(dir, id, opts as never),
      scanSessionLog: async (dir: string, id: string, opts?: unknown): Promise<unknown> => {
        if (unstableOnce.delete(id)) {
          return { ok: false, reason: 'unstable' as const, message: 'file changed during scan', stats: { bytesCompressed: 0, bytesDecompressed: 0, lines: 0 } }
        }
        if (id === 'c-cap') {
          return { ok: false, reason: 'cap' as const, message: 'log input exceeds 262144 bytes', stats: { bytesCompressed: 262_144, bytesDecompressed: 0, lines: 0 } }
        }
        return real.scanSessionLog(dir, id, opts as never)
      },
    }
    const { index, clock } = makeIndex(root, { reader: reader as never, failureRetryMs: 1_000 })
    await index.reconcile()
    await index.advance()
    expect(index.verdictOf('c-transient').status).toBe('failed') // 瞬态：冷却
    expectVerdict(index, 'c-cap', 'unknown') // 终态：显式 unknown
    const capLookup = index.verdictOf('c-cap')
    if (capLookup.status === 'classified') expect(capLookup.reason ?? '').toContain('cap')
    clock.advance(1_500)
    await index.advance()
    expectVerdict(index, 'c-transient', 'router') // 冷却到期重试成功
    expect(index.diagnostics().failures).toBe(0)
  })

  it('verifyDiskFacts：fresh / changed（作废+重扫入队）/ missing（移除）/ untrusted（IO 错：保留条目不授权）', async () => {
    const root = await tmpRoot()
    const dirA = await writeCold(root, 'v-a', [header('v-a', { agentPreset: 'dsh-router' })])
    const dirB = await writeCold(root, 'v-b', [header('v-b', { agentPreset: 'dsh-router' })])
    const dirC = await writeCold(root, 'v-c', [header('v-c', { agentPreset: 'dsh-router' })])
    const { index } = makeIndex(root)
    await index.reconcile()
    await index.advance()
    expectVerdict(index, 'v-a', 'router')
    expectVerdict(index, 'v-b', 'router')
    expectVerdict(index, 'v-c', 'router')

    // fresh：指纹一致
    const fresh = await index.verifyDiskFacts(['v-a'])
    expect(fresh.get('v-a')).toEqual({ ok: true })

    // changed：追加 selected → 作废旧判定 + 重新入队
    await appendFile(join(dirA, 'session.v4.jsonl'), `${selected(0, 'other')}\n`)
    const changed = await index.verifyDiskFacts(['v-a'])
    expect(changed.get('v-a')).toEqual({ ok: false, kind: 'changed' })
    expect(index.verdictOf('v-a').status).toBe('pending')
    expect(index.diagnostics().queueLength).toBe(1)

    // missing：文件消失 → 移除条目
    await rm(dirB, { recursive: true, force: true })
    const missing = await index.verifyDiskFacts(['v-b'])
    expect(missing.get('v-b')).toEqual({ ok: false, kind: 'missing' })
    expect(index.verdictOf('v-b').status).toBe('pending')

    // untrusted：核验 IO 失败 → 旧条目保留、不得授权（先正常分类，核验时再让 IO 失败）
    let failC = false
    const gatedFs = {
      readdir: async (dir: string) => {
        if (failC && dir === dirC) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return fsReaddir(dir, { withFileTypes: true })
      },
      stat: async (path: string) => {
        if (failC && path.startsWith(dirC)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return fsStat(path)
      },
    }
    const failing = makeIndex(root, { fs: gatedFs as never })
    await failing.index.reconcile()
    await failing.index.advance()
    expectVerdict(failing.index, 'v-c', 'router')
    failC = true
    const untrusted = await failing.index.verifyDiskFacts(['v-c'])
    expect(untrusted.get('v-c')).toEqual({ ok: false, kind: 'untrusted' })
    expectVerdict(failing.index, 'v-c', 'router') // 旧条目保留（只是不得授权）
  })
})

/* ────────────────────────── cold fix r1：证据绑定与判别式校验 ────────────────────────── */

describe('SessionHeaderIndex：扫描证据必须与索引位置同一实体（I2）与判别式证据校验（I4）', () => {
  async function writeCold(root: string, sessionId: string, lines: string[], name = 'session.v4.jsonl'): Promise<string> {
    const dir = join(root, '--proj--', encodeSegment(sessionId))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), lines.map((line) => `${line}\n`).join(''))
    return dir
  }
  const selected = (seq: number, preset: string): string =>
    JSON.stringify({ type: 'agent-preset/selected', seq, time: 1, data: { agentPreset: preset } })

  it('扫描证据的 inode 与索引 stat 不一致 → 不得接受（禁止跨实体拼接）', async () => {
    const root = await tmpRoot()
    await writeCold(root, 'c-mismatch', [header('c-mismatch'), selected(0, 'dsh-router')])
    const real = new SessionHeaderReader()
    const reader = {
      readSessionHeader: (dir: string, id: string, opts?: unknown) => real.readSessionHeader(dir, id, opts as never),
      scanSessionLog: async (dir: string, id: string, opts?: unknown) => {
        const outcome = await real.scanSessionLog(dir, id, opts as never)
        if (!outcome.ok) return outcome
        // 扫描读到的是**另一个实体**（inode 不同，其余字段相同）
        return { ...outcome, identity: { ...outcome.identity, ino: outcome.identity.ino + 1000 } }
      },
    }
    const { index } = makeIndex(root, { reader: reader as never })
    await index.reconcile()
    await index.advance()
    const lookup = index.verdictOf('c-mismatch')
    expect(lookup.status).not.toBe('classified') // 不得把别的实体的证据当成本会话的判定
  })

  it('扫描证据的文件名与索引追踪的文件不一致 → 不得接受', async () => {
    const root = await tmpRoot()
    await writeCold(root, 'c-file', [header('c-file'), selected(0, 'dsh-router')])
    const real = new SessionHeaderReader()
    const reader = {
      readSessionHeader: (dir: string, id: string, opts?: unknown) => real.readSessionHeader(dir, id, opts as never),
      scanSessionLog: async (dir: string, id: string, opts?: unknown) => {
        const outcome = await real.scanSessionLog(dir, id, opts as never)
        if (!outcome.ok) return outcome
        return { ...outcome, file: { name: 'session.v3.jsonl', version: 3, zstd: false } }
      },
    }
    const { index } = makeIndex(root, { reader: reader as never })
    await index.reconcile()
    await index.advance()
    expect(index.verdictOf('c-file').status).not.toBe('classified')
  })

  it('非法 stable-eof 证据的缓存必须弃用（不提升为权威 router）；合法 v1 seeded 仍可迁移', async () => {
    const root = await tmpRoot()
    await writeCold(root, 'c-v3', [header('c-v3')])
    await writeCold(root, 'c-seeded', [header('c-seeded')])
    await writeCold(root, 'c-nopreset', [header('c-nopreset')])
    await writeCold(root, 'c-keep', [header('c-keep', { isSeeded: true })])
    const fingerprintOf = async (sessionId: string): Promise<string> => {
      const stat = await fsStat(join(root, '--proj--', encodeSegment(sessionId), 'session.v4.jsonl'))
      return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:session.v4.jsonl`
    }
    const fingerprint = await fingerprintOf('c-v3')
    const fingerprintSeeded = await fingerprintOf('c-seeded')
    const fingerprintNoPreset = await fingerprintOf('c-nopreset')
    const fingerprintKeep = await fingerprintOf('c-keep')
    const { persistence } = memoryPersistence({
      version: 2,
      root,
      preset: 'dsh-router',
      savedAt: 1,
      entries: [
        // 非当前代（v3）+ 与 routerPreset 不一致 → 非法
        { sessionId: 'c-v3', projectDir: '--proj--', file: 'session.v3.jsonl', fingerprint, verdict: 'router' as const, createdAt: 1, isSeeded: false, agentPreset: 'other', origin: 'disk' as const, reason: 'bad', evidence: 'stable-eof' as const },
        // seeded 却带 stable-eof 证据 → 非法
        { sessionId: 'c-seeded', projectDir: '--proj--', file: 'session.v4.jsonl', fingerprint: fingerprintSeeded, verdict: 'router' as const, createdAt: 1, isSeeded: true, agentPreset: 'other', origin: 'disk' as const, reason: 'bad', evidence: 'stable-eof' as const },
        // 缺排序事实（createdAt）→ 非法
        { sessionId: 'c-nopreset', projectDir: '--proj--', file: 'session.v4.jsonl', fingerprint: fingerprintNoPreset, verdict: 'router' as const, createdAt: undefined, isSeeded: false, agentPreset: 'dsh-router', origin: 'disk' as const, reason: 'bad', evidence: 'stable-eof' as const },
        // 合法 v1 seeded 排除迁移 → 必须保留
        { sessionId: 'c-keep', projectDir: '--proj--', file: 'session.v4.jsonl', fingerprint: fingerprintKeep, verdict: 'nonrouter' as const, createdAt: 1, isSeeded: true, agentPreset: 'dsh-router', origin: 'disk' as const, reason: 'seeded session excluded' },
      ],
      failures: [],
    })
    const { index } = makeIndex(root, { persistence: persistence as never })
    await index.hydrate()
    await index.reconcile()
    expect(index.verdictOf('c-v3').status).not.toBe('classified')
    expect(index.verdictOf('c-seeded').status).not.toBe('classified')
    expect(index.verdictOf('c-nopreset').status).not.toBe('classified')
    expectVerdict(index, 'c-keep', 'nonrouter') // 合法 v1 seeded 迁移不受影响
  })

  it('扫描失败也必须累计消耗字节（失败不得从字节统计里消失）', async () => {
    const root = await tmpRoot()
    await writeCold(root, 'c-bytes', [header('c-bytes')])
    const reader = {
      readSessionHeader: async () => ({
        ok: true as const,
        header: { version: 4 as const, id: 'c-bytes', createdAt: 1, isSeeded: false, agentPreset: undefined },
        stats: { bytesCompressed: 0, bytesDecompressed: 0 },
      }),
      scanSessionLog: async () => ({
        ok: false as const,
        reason: 'corrupt' as const,
        message: 'bad json',
        stats: { bytesCompressed: 1234, bytesDecompressed: 5678, lines: 3 },
      }),
    }
    const { index } = makeIndex(root, { reader: reader as never })
    await index.reconcile()
    await index.advance()
    expect(index.diagnostics().header.bytesCompressed).toBe(1234)
    expect(index.diagnostics().header.bytesDecompressed).toBe(5678)
  })
})

describe('SessionHeaderIndex：资格授予面（收编消费面，review I1）', () => {
  it('盘扫描与 live 判定的 router 都发一次授予；未 ack 不消失', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-router', { agentPreset: 'dsh-router' })
    await writeSession(root, 's-other', {})
    const projections = new Map<string, string | null>([['s-live', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    await index.reconcile()
    await index.advance()
    // 盘扫描路径分类出的 router 必须出现在待消费面（不能被吞掉）。
    expect(index.unclaimedRouterGrants(10).map((grant) => grant.sessionId)).toEqual(['s-router'])
    // 未 ack → 授予仍在（可靠记账：消费方可以安全跳过/延期）。
    expect(index.unclaimedRouterGrants(10).map((grant) => grant.sessionId)).toEqual(['s-router'])
    // live 事件直达判定同样发一次授予。
    index.onLiveSession(liveSession({ id: 's-live', agentPreset: 'dsh-router' }))
    expect(index.unclaimedRouterGrants(10).map((grant) => grant.sessionId)).toEqual(['s-router', 's-live'])
  })

  it('ack 后授予移出待消费面；代数不符的 ack 不消费新一代', async () => {
    const root = await tmpRoot()
    const projections = new Map<string, string | null>([['s-live', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    index.onLiveSession(liveSession({ id: 's-live', agentPreset: 'dsh-router' }))
    const [grant] = index.unclaimedRouterGrants(10)
    expect(grant?.sessionId).toBe('s-live')
    index.ackRouterGrant('s-live', (grant?.generation ?? 0) + 1)
    expect(index.unclaimedRouterGrants(10), '代数不符的 ack 不能消费授予').toHaveLength(1)
    index.ackRouterGrant('s-live', grant!.generation)
    expect(index.unclaimedRouterGrants(10)).toHaveLength(0)
  })

  it('领取面与未领取面分开（review I7 round 2）：领取后不再出现在未领取面，ack 后清空', async () => {
    const root = await tmpRoot()
    const projections = new Map<string, string | null>([['s-live', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    index.onLiveSession(liveSession({ id: 's-live', agentPreset: 'dsh-router' }))
    expect(index.unclaimedRouterGrants(10)).toHaveLength(1)
    const claimed = index.claimRouterGrants(10)
    expect(claimed.map((grant) => grant.sessionId)).toEqual(['s-live'])
    expect(index.unclaimedRouterGrants(10), '已领取的授予不再出现在未领取面').toHaveLength(0)
    expect(index.routerGrantGeneration('s-live'), '已领取的授予仍可查到代数').toBe(claimed[0]!.generation)
    // 再领取一次拿不到（不重复领取）。
    expect(index.claimRouterGrants(10)).toHaveLength(0)
    index.ackRouterGrant('s-live', claimed[0]!.generation)
    expect(index.routerGrantGeneration('s-live'), 'ack 后授予被消费').toBeUndefined()
    expect(index.diagnostics().grant.claimed).toBe(0)
  })

  it('资格撤销时两侧的授予都撤下（已领取的也不残留）', async () => {
    const root = await tmpRoot()
    const projections = new Map<string, string | null>([['s-live', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    const session = liveSession({ id: 's-live', agentPreset: 'dsh-router' })
    index.onLiveSession(session)
    index.claimRouterGrants(10)
    expect(index.diagnostics().grant.claimed).toBe(1)
    // 组合翻到别的预设 → 资格撤销 → 已领取的授予也撤下。
    index.onLiveSessionEvent(session, { type: 'agent-preset/selected', data: { agentPreset: 'other' } })
    expect(index.diagnostics().grant.claimed).toBe(0)
    expect(index.routerGrantGeneration('s-live')).toBeUndefined()
  })

  it('变为 nonrouter 撤下授予；再变回 router 发新一代（判定翻转才是新事实）', async () => {
    const root = await tmpRoot()
    const projections = new Map<string, string | null>([['s-flip', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    index.onLiveSession(liveSession({ id: 's-flip', agentPreset: 'dsh-router' }))
    const first = index.unclaimedRouterGrants(10)
    expect(first.map((grant) => grant.sessionId)).toEqual(['s-flip'])
    index.onLiveSessionEvent(liveSession({ id: 's-flip' }), { type: 'agent-preset/selected', data: { agentPreset: 'other' } })
    expect(index.unclaimedRouterGrants(10), 'nonrouter 不是新增 router').toEqual([])
    index.onLiveSessionEvent(liveSession({ id: 's-flip' }), { type: 'agent-preset/selected', data: { agentPreset: 'dsh-router' } })
    const flipped = index.unclaimedRouterGrants(10)
    expect(flipped.map((grant) => grant.sessionId)).toEqual(['s-flip'])
    expect(flipped[0]!.generation, '翻回来的 router 是新一代资格').toBeGreaterThan(first[0]!.generation)
  })

  it('载入缓存未核指纹（unverified）时不发授予；同指纹对账后才发', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-cold', { agentPreset: 'dsh-router' })
    const { persistence } = memoryPersistence()
    const first = makeIndex(root, { persistence: persistence })
    await first.index.reconcile()
    await first.index.advance()
    expect(first.index.unclaimedRouterGrants(10).map((grant) => grant.sessionId)).toEqual(['s-cold'])
    await first.index.dispose()

    // 第二个实例：hydrate 后是未核验缓存 → 不发授予。
    const second = makeIndex(root, { persistence: persistence })
    await second.index.hydrate()
    expect(second.index.verdictOf('s-cold').status).toBe('pending')
    expect(second.index.unclaimedRouterGrants(10), '未核验的候选不该被提前消费').toEqual([])
    // 同指纹对账 → 资格成立 → 发授予。
    await second.index.reconcile()
    expect(second.index.verdictOf('s-cold')).toMatchObject({ status: 'classified', verdict: 'router' })
    expect(second.index.unclaimedRouterGrants(10).map((grant) => grant.sessionId)).toEqual(['s-cold'])
  })

  it('授予面不改变 verdictOf/revision 语义', async () => {
    const root = await tmpRoot()
    const projections = new Map<string, string | null>([['s-live', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    index.onLiveSession(liveSession({ id: 's-live', agentPreset: 'dsh-router' }))
    const before = index.revision()
    expect(index.unclaimedRouterGrants(10).map((grant) => grant.sessionId)).toEqual(['s-live'])
    expect(index.revision(), '发授予本身不算状态变化').toBe(before)
    expectVerdict(index, 's-live', 'router')
  })
})

describe('SessionHeaderIndex：live 生命周期（session/disposed，review I6）', () => {
  it('会话离开 live store：撤销 live 权威 → 不再授权（受控冷重判）', async () => {
    const root = await tmpRoot()
    await writeSession(root, 's-gone', { agentPreset: 'dsh-router' })
    const projections = new Map<string, string | null>([['s-gone', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    const session = liveSession({ id: 's-gone', agentPreset: 'dsh-router' })
    index.onLiveSession(session)
    expectVerdict(index, 's-gone', 'router')
    expect(index.unclaimedRouterGrants(10).map((grant) => grant.sessionId)).toEqual(['s-gone'])

    // 会话离开 live store：live 权威撤销 → 判定不再是 router（不再授权）。
    index.onLiveSessionDisposed(session)
    expect(index.verdictOf('s-gone').status, '离开 live 后不得继续按 live 权威授权').not.toBe('classified')
    expect(index.unclaimedRouterGrants(10), '资格撤销后待消费面清空').toEqual([])
  })

  it('旧实例的 disposed 不清新实例的权威', async () => {
    const root = await tmpRoot()
    const projections = new Map<string, string | null>([['s-rep', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    const oldInstance = liveSession({ id: 's-rep', agentPreset: 'dsh-router' })
    index.onLiveSession(oldInstance)
    // 新实例接管同一 id。
    const newInstance = liveSession({ id: 's-rep', agentPreset: 'dsh-router' })
    index.onLiveSession(newInstance)
    // 旧实例卸载：不得清掉新实例的权威。
    index.onLiveSessionDisposed(oldInstance)
    expectVerdict(index, 's-rep', 'router')
    expect(index.unclaimedRouterGrants(10).map((grant) => grant.sessionId)).toEqual(['s-rep'])
    // 新实例卸载：权威才被撤销。
    index.onLiveSessionDisposed(newInstance)
    expect(index.verdictOf('s-rep').status).not.toBe('classified')
  })

  it('旧实例的迟到事件不改新实例的事实', async () => {
    const root = await tmpRoot()
    const projections = new Map<string, string | null>([['s-rep', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    const oldInstance = liveSession({ id: 's-rep', agentPreset: 'dsh-router' })
    index.onLiveSession(oldInstance)
    const newInstance = liveSession({ id: 's-rep', agentPreset: 'dsh-router' })
    index.onLiveSession(newInstance)
    // 旧实例的迟到事件：忽略（不能把新实例的组合改成别的预设）。
    index.onLiveSessionEvent(oldInstance, { type: 'agent-preset/selected', data: { agentPreset: 'other' } })
    expectVerdict(index, 's-rep', 'router')
  })

  it('生命周期代际随权威变化推进（消费方的 await 屏障）', async () => {
    const root = await tmpRoot()
    const projections = new Map<string, string | null>([['s-life', 'dsh-router']])
    const { index } = makeIndex(root, {
      resolveLivePreset: (session) => projections.get((session as { id?: string }).id ?? ''),
    })
    const session = liveSession({ id: 's-life', agentPreset: 'dsh-router' })
    const before = index.authorityToken('s-life')
    index.onLiveSession(session)
    expect(index.authorityToken('s-life')).toBeGreaterThan(before)
    const afterCreate = index.authorityToken('s-life')
    index.onLiveSessionDisposed(session)
    expect(index.authorityToken('s-life')).toBeGreaterThan(afterCreate)
  })
})
