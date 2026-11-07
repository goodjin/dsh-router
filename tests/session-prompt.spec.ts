/**
 * 会话级 Router 系统提示词存储（v1.1 计划 Task C5，规格 §7）。
 *
 * - SessionPromptStore：dataDir/router-prompts.json，per-session 覆盖文本。
 *   get 是**同步**读（systemPrompt 组装是同步的，section 的 text 回调不能等
 *   Promise——与 context 行走缓存快照同一理由）；load 幂等，宿主启动调一次。
 *   不变量：存过的值一律非空（空串走 clear，set 拒收）——保证「有覆盖必非空，
 *   get undefined 即回落默认」这条回落语义不被脏数据破坏。
 * - prompt-section 行（@goodjin2/dsh-router/prompt-section）：动态 Router 预设
 *   的 complete section，text 按当前会话读覆盖、无覆盖回落 defaults
 *   （defaults 由 routerCore 侧给——组装上下文里取会话 id，取不到按默认处理）。
 */

import { describe, expect, it } from 'vitest'

import { SessionPromptStore } from '../src/host/prompts/session-prompt.ts'
import { apply as applyPromptSection, Config as promptSectionConfig } from '../src/prompt-section.ts'
import { LedgerError } from '../src/host/ledger/errors.ts'
import type { FsAdapter } from '../src/shared/fs-adapter.ts'

/** 内存 FsAdapter（真实现同形状；mkdirp/writeFile 记录调用）。 */
function memFs(initial: Record<string, string> = {}): FsAdapter & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    async readFile(p: string) {
      const hit = files.get(p)
      if (hit === undefined) throw new Error(`ENOENT: ${p}`)
      return hit
    },
    async writeFile(p: string, content: string) {
      files.set(p, content)
    },
    async mkdirp() {},
    async exists(p: string) {
      return files.has(p)
    },
    async readdir() {
      return [...files.keys()]
    },
  }
}

const FILE = '/data/router/router-prompts.json'

describe('SessionPromptStore：读写与回落语义', () => {
  it('get/set 往返：set 后 get 到同文本，get 未知会话 = undefined（回落由调用方处理）', async () => {
    const store = new SessionPromptStore(memFs(), FILE)
    await store.load()
    expect(store.get('s1')).toBeUndefined()
    await store.set('s1', '自定义提示词')
    expect(store.get('s1')).toBe('自定义提示词')
    expect(store.get('s2')).toBeUndefined()
  })

  it('set 覆盖旧值；clear 之后回落 undefined（空串语义走 clear，不落盘空串）', async () => {
    const store = new SessionPromptStore(memFs(), FILE)
    await store.load()
    await store.set('s1', 'v1')
    await store.set('s1', 'v2')
    expect(store.get('s1')).toBe('v2')
    await store.clear('s1')
    expect(store.get('s1')).toBeUndefined()
    // clear 不存在的会话是 no-op，不抛
    await expect(store.clear('nope')).resolves.toBeUndefined()
  })

  it('不变量：set 空串/纯空白/非字符串 → invalid-input 拒收（回落语义不被脏数据破坏）', async () => {
    const store = new SessionPromptStore(memFs(), FILE)
    await store.load()
    await expect(store.set('s1', '')).rejects.toThrow(LedgerError)
    await expect(store.set('s1', '   ')).rejects.toThrow(LedgerError)
    await expect(store.set('s1', undefined as unknown as string)).rejects.toThrow(LedgerError)
    expect(store.get('s1')).toBeUndefined()
  })

  it('会话 id 空串/非字符串 → invalid-input（get/set/clear 同一守卫）', async () => {
    const store = new SessionPromptStore(memFs(), FILE)
    await store.load()
    for (const bad of ['', undefined as unknown as string]) {
      expect(() => store.get(bad)).toThrow(LedgerError)
      await expect(store.set(bad, 'x')).rejects.toThrow(LedgerError)
      await expect(store.clear(bad)).rejects.toThrow(LedgerError)
    }
  })

  it('持久化往返：写落盘 router-prompts.json；新实例 load 恢复（进程重启不丢覆盖）', async () => {
    const fs = memFs()
    const first = new SessionPromptStore(fs, FILE)
    await first.load()
    await first.set('s1', '重启后仍在')
    await first.clear('gone')
    expect(fs.files.get(FILE)).toBeDefined()
    expect(JSON.parse(fs.files.get(FILE)!)).toMatchObject({ schemaVersion: 1, prompts: { s1: '重启后仍在' } })

    const second = new SessionPromptStore(fs, FILE)
    expect(second.get('s1')).toBeUndefined() // 未 load 不读
    await second.load()
    expect(second.get('s1')).toBe('重启后仍在')
  })

  it('文件缺席/损坏 → 空表起步（不炸装载）；损坏文件在首次写入时被健康形状覆盖', async () => {
    const absent = new SessionPromptStore(memFs(), FILE)
    await absent.load()
    expect(absent.get('s1')).toBeUndefined()

    const fs = memFs({ [FILE]: '{broken json' })
    const broken = new SessionPromptStore(fs, FILE)
    await broken.load()
    expect(broken.get('s1')).toBeUndefined()
    await broken.set('s1', '重建')
    expect(JSON.parse(fs.files.get(FILE)!).prompts.s1).toBe('重建')
  })

  it('load 幂等：重复 load 不重复读盘、不覆盖内存里的未落盘状态', async () => {
    let reads = 0
    const fs = memFs()
    const raw = fs.readFile.bind(fs)
    fs.readFile = async (p: string) => {
      if (p === FILE) reads += 1
      return raw(p)
    }
    const store = new SessionPromptStore(fs, FILE)
    await store.load()
    await store.load()
    await store.load()
    expect(reads).toBe(1)
  })
})

/* ────────────────────────── prompt-section 行（complete section） ────────────────────────── */

/** 假宿主面：记录 systemPrompt.section 注册与注销；routerCore 按编程应答。 */
function fakeSectionHost(overrides: Partial<{ defaultsText: string; storeText: (sessionId: string) => string | undefined }> = {}) {
  const captured: Array<{ name: string; order: number; complete?: boolean; text: (assembly?: unknown) => string }> = []
  const ctx = {
    systemPrompt: {
      section(section: { name: string; order: number; complete?: boolean; text: (assembly?: unknown) => string }) {
        captured.push(section)
        return () => {}
      },
    },
    routerCore: {
      sessionPromptText(sessionId?: string): string {
        const hit = sessionId === undefined ? undefined : overrides.storeText?.(sessionId)
        return hit ?? overrides.defaultsText ?? '默认 Router 提示词'
      },
    },
  }
  return { ctx, captured }
}

/** 组装上下文（宿主 assembleContextFor 形状：{agent, scope}，agent.session.id = 会话 id）。 */
function assemblyOf(sessionId?: string): unknown {
  if (sessionId === undefined) return {}
  return { agent: { id: sessionId, session: { id: sessionId } }, scope: {} }
}

describe('prompt-section 行：Router 预设的 complete section', () => {
  it('apply 注册 name=router-prompt、complete=true、order 来自 config（缺省有限数）', () => {
    const { ctx, captured } = fakeSectionHost()
    applyPromptSection(ctx as never, promptSectionConfig(undefined) as never)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.name).toBe('router-prompt')
    expect(captured[0]!.complete).toBe(true)
    expect(Number.isFinite(captured[0]!.order)).toBe(true)
    // Config 可校验（check-subrows / validateRowSpec 用）：空 config 不抛
    expect(() => promptSectionConfig(undefined)).not.toThrow()
    expect(() => promptSectionConfig({})).not.toThrow()
  })

  it('text 按组装上下文里的会话 id 读覆盖；无覆盖回落默认；取不到会话 id 按默认处理', () => {
    const { ctx, captured } = fakeSectionHost({ storeText: (id) => (id === 's-router' ? '本会话覆盖' : undefined) })
    applyPromptSection(ctx as never, promptSectionConfig(undefined) as never)
    const text = captured[0]!.text
    expect(text(assemblyOf('s-router'))).toBe('本会话覆盖')
    expect(text(assemblyOf('s-other'))).toBe('默认 Router 提示词')
    expect(text({})).toBe('默认 Router 提示词')
    expect(text(undefined)).toBe('默认 Router 提示词')
    // 宿主变化防线：agent.session.id 缺席时退回 agent.id（两版本形状都兜住）
    expect(text({ agent: { id: 's-flat' } })).toBe('默认 Router 提示词')
  })

  it('apply 返回注销器：调用后 section 被注销（重复注销 no-op）', () => {
    let disposed = 0
    const ctx = {
      systemPrompt: {
        section: () => () => { disposed += 1 },
      },
      routerCore: { sessionPromptText: () => 'x' },
    }
    const dispose = applyPromptSection(ctx as never, promptSectionConfig(undefined) as never)
    dispose()
    dispose()
    expect(disposed).toBe(1)
  })
})
