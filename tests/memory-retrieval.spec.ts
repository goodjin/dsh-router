/**
 * 记忆检索测试：关键词扫描（大小写不敏感、中文包含匹配、多词 AND）、
 * scope 过滤（project/global/all，all 覆盖会话文档）、memoryRef+snippet 形状、
 * 按条目写入时间倒序、最多 20 条截断、空查询与空库返回空数组。
 */

import { describe, expect, it } from 'vitest'
import { makeMemFs } from './helpers/mem-fs.ts'
import { MemoryDocStore } from '../src/host/memory/store.ts'
import { search } from '../src/host/memory/retrieval.ts'

const BASE = 1_700_000_000_000

async function seedStore(): Promise<{ store: MemoryDocStore }> {
  const { fs } = makeMemFs()
  let t = BASE
  const store = new MemoryDocStore('/mem-root', fs, { now: () => (t += 1000) })
  return { store }
}

describe('search 关键词扫描', () => {
  it('大小写不敏感、中文按包含匹配；返回 memory://<文档>#<锚> 与条目 snippet', async () => {
    const { store } = await seedStore()
    await store.appendSummary('project', 'build', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '项目构建统一走 tsdown 产物入库并提交。',
    })
    const upper = await search(store, 'TSDOWN', 'project')
    expect(upper).toHaveLength(1)
    expect(upper[0]?.memoryRef).toBe('memory://project.md#e1')
    expect(upper[0]?.snippet).toContain('tsdown')
    const zh = await search(store, '构建', 'project')
    expect(zh).toHaveLength(1)
    expect(zh[0]?.memoryRef).toBe('memory://project.md#e1')
  })

  it('空格分隔的多关键词按 AND 匹配；只命中其中一词的条目不返回', async () => {
    const { store } = await seedStore()
    await store.appendSummary('project', 'merge', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '合并主干前必须三门禁三条全绿才允许再合并。',
    })
    await store.appendSummary('project', 'worktree', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '改动在独立 worktree 分支里推进，不动主干。',
    })
    expect(await search(store, '合并 三门禁', 'project')).toHaveLength(1)
    expect((await search(store, '合并 三门禁', 'project'))[0]?.memoryRef).toBe('memory://project.md#e1')
    expect(await search(store, 'worktree', 'project')).toHaveLength(1)
  })

  it('主题 key 也参与匹配：query 命中 key 而不在正文时仍返回', async () => {
    const { store } = await seedStore()
    await store.appendSummary('project', 'package-manager', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '依赖安装统一走 pnpm（2026-11 核对）。',
    })
    const hits = await search(store, 'package-manager', 'project')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.snippet).toContain('pnpm')
  })

  it('scope 过滤：project/global 各查各的；all 合并两边', async () => {
    const { store } = await seedStore()
    await store.appendSummary('project', 'alpha', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '项目记忆里有 alpha 约定需要检索命中。',
    })
    await store.appendSummary('global', 'alpha', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '全局记忆里也有 alpha 约定用于跨项目检索。',
    })
    expect((await search(store, 'alpha', 'project')).map((h) => h.memoryRef)).toEqual([
      'memory://project.md#e1',
    ])
    expect((await search(store, 'alpha', 'global')).map((h) => h.memoryRef)).toEqual([
      'memory://global.md#e1',
    ])
    expect(await search(store, 'alpha', 'all')).toHaveLength(2)
  })

  it('scope=all 覆盖 sessions/<sessionId>.md；scope=project 不含会话文档', async () => {
    const { store } = await seedStore()
    await store.appendSummary('session', 'sess-9', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '未挂载 sqlite 索引时全文搜索缺席。',
    })
    expect(await search(store, 'sqlite', 'project')).toEqual([])
    const hits = await search(store, 'sqlite', 'all')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.memoryRef).toBe('memory://sessions/sess-9.md#e1')
  })
})

describe('search 排序与截断', () => {
  it('按条目写入时间倒序：新条目在前', async () => {
    const { store } = await seedStore()
    await store.appendSummary('project', 'order', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '排序基准第一条：包含检索词甲的完整记忆条目。',
    })
    await store.appendSummary('project', 'order', {
      sourceRefs: ['x#m1'],
      kind: 'user-decision',
      text: '排序基准第二条：包含检索词甲的新记忆条目。',
    })
    const hits = await search(store, '检索词甲', 'project')
    expect(hits.map((h) => h.memoryRef)).toEqual([
      'memory://project.md#e2',
      'memory://project.md#e1',
    ])
  })

  it('最多返回 20 条：多余的按时间倒序截断，保留最新', async () => {
    const { store } = await seedStore()
    for (let i = 1; i <= 25; i++) {
      await store.appendSummary('project', 'bulk', {
        sourceRefs: [],
        kind: 'verified-fact',
        text: `关键词命中测试第${i}条：内容需要足够长才能通过低信息门写入。`,
      })
    }
    const hits = await search(store, '关键词命中测试', 'project')
    expect(hits).toHaveLength(20)
    expect(hits[0]?.memoryRef).toBe('memory://project.md#e25')
    expect(hits[19]?.memoryRef).toBe('memory://project.md#e6')
  })

  it('空白查询返回空数组；没有任何文档时不抛错返回空数组', async () => {
    const empty = await seedStore()
    expect(await search(empty.store, '   ', 'all')).toEqual([])
    expect(await search(empty.store, '任意词', 'all')).toEqual([])
  })
})
