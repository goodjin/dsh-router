/**
 * MemoryDocStore 测试：全内存 FsAdapter，不碰真实磁盘。
 *
 * 覆盖（Task B6 清单）：头部读写、增量位推进、低信息拒绝、冲突标记、
 * 三类标记写入与回读、换行扁平化、readDoc 缺文档返回 null。
 */

import { describe, expect, it } from 'vitest'
import { makeMemFs } from './helpers/mem-fs.ts'
import { MemoryDocStore } from '../src/host/memory/store.ts'

const BASE = 1_700_000_000_000

describe('MemoryDocStore 头部读写', () => {
  it('首次 append 创建 sessions/<sessionId>.md，YAML 头与条目都能回读', async () => {
    const { fs, files } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs, { now: () => BASE })
    const result = await store.appendSummary('session', 'sess-1', {
      sourceRefs: ['sess-1#m12', 'sess-1#m13'],
      kind: 'user-decision',
      text: '决定用 tsdown 打包，保持单文件 CJS 工厂产物不变。',
    })
    expect(result).toEqual({ written: true, anchor: 'e1' })
    expect(files.has('/mem-root/sessions/sess-1.md')).toBe(true)
    const doc = await store.readDoc('session', 'sess-1')
    expect(doc?.scope).toBe('session')
    expect(doc?.sessionId).toBe('sess-1')
    expect(doc?.updatedAt).toBe(BASE)
    expect(doc?.lastSummarizedSeq).toBe(0)
    expect(doc?.entries).toHaveLength(1)
    expect(doc?.entries[0]).toMatchObject({
      anchor: 'e1',
      kind: 'user-decision',
      sourceRefs: ['sess-1#m12', 'sess-1#m13'],
      at: BASE,
    })
    expect(doc?.entries[0]?.text).toContain('tsdown')
  })

  it('setLastSummarizedSeq 推进增量位并持久化；setSessionTitle 写标题且不动其余头部', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    await store.appendSummary('session', 's1', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '验收依据是 vitest 全部用例同轮跑通。',
    })
    await store.setLastSummarizedSeq('s1', 5)
    expect((await store.readDoc('session', 's1'))?.lastSummarizedSeq).toBe(5)
    await store.setLastSummarizedSeq('s1', 9)
    expect((await store.readDoc('session', 's1'))?.lastSummarizedSeq).toBe(9)
    await store.setSessionTitle('s1', '修复登录')
    const doc = await store.readDoc('session', 's1')
    expect(doc?.title).toBe('修复登录')
    expect(doc?.lastSummarizedSeq).toBe(9)
    expect(doc?.entries).toHaveLength(1)
  })

  it('setLastSummarizedSeq 可为尚不存在的会话创建只有头部的文档', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    await store.setLastSummarizedSeq('s9', 3)
    const doc = await store.readDoc('session', 's9')
    expect(doc?.lastSummarizedSeq).toBe(3)
    expect(doc?.entries).toHaveLength(0)
  })

  it('readDoc 对不存在的文档返回 null', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    expect(await store.readDoc('global')).toBeNull()
    expect(await store.readDoc('session', 'nope')).toBeNull()
  })

  it('session 作用域 key=sessionId 只是文档选择器，重复追加不算主题冲突；特殊字符编码进文件名', async () => {
    const { fs, files } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    const r1 = await store.appendSummary('session', 'a/b', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '第一条事实：任务验收策略采用宿主 auto 验收策略。',
    })
    const r2 = await store.appendSummary('session', 'a/b', {
      sourceRefs: [],
      kind: 'worker-suggestion',
      text: '第二条：建议合并主干前重跑三门禁，全绿再合并。',
    })
    expect(r1).toEqual({ written: true, anchor: 'e1' })
    expect(r2).toEqual({ written: true, anchor: 'e2' })
    expect(files.has('/mem-root/sessions/a%2Fb.md')).toBe(true)
    const doc = await store.readDoc('session', 'a/b')
    expect(doc?.entries).toHaveLength(2)
    expect(doc?.entries[1]?.conflictsWith).toBeUndefined()
  })
})

describe('MemoryDocStore 会话清点', () => {
  it('listSessionIds 列出已有会话文档的 sessionId（解码回原值）；目录不存在返回空数组', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    expect(await store.listSessionIds()).toEqual([])
    await store.appendSummary('session', 'a/b', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '第一条事实：任务验收策略采用宿主 auto 验收策略。',
    })
    await store.appendSummary('session', 'plain', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '第二条事实：合并主干前重跑三门禁全绿再合并。',
    })
    expect((await store.listSessionIds()).sort()).toEqual(['a/b', 'plain'])
  })
})

describe('MemoryDocStore 写入规则', () => {
  it('低信息门：text 少于 20 字符的条目拒绝写入并返回 skipped=low-info；满 20 字符可写入', async () => {
    const { fs, files } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    const tooShort = await store.appendSummary('project', 'build', {
      sourceRefs: ['x#m1'],
      kind: 'verified-fact',
      text: '太短',
    })
    expect(tooShort).toEqual({ skipped: 'low-info' })
    expect(files.has('/mem-root/project.md')).toBe(false)
    const atLimit = await store.appendSummary('project', 'build', {
      sourceRefs: ['x#m1'],
      kind: 'verified-fact',
      text: '12345678901234567890',
    })
    expect(atLimit).toEqual({ written: true, anchor: 'e1' })
    const padded = await store.appendSummary('project', 'build', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '空白填充不算长度。    ',
    })
    expect(padded).toEqual({ skipped: 'low-info' })
    const doc = await store.readDoc('project')
    expect(doc?.entries).toHaveLength(1)
  })

  it('冲突保留不合成：同主题 key 重复照写并带 conflicts-with 指向旧条目锚；不同主题不受影响', async () => {
    const { fs } = makeMemFs()
    let t = BASE
    const store = new MemoryDocStore('/mem-root', fs, { now: () => (t += 1000) })
    const r1 = await store.appendSummary('project', 'package-manager', {
      sourceRefs: ['router#m1'],
      kind: 'verified-fact',
      text: '项目依赖安装统一走 pnpm（2026-11 核对）。',
    })
    const r2 = await store.appendSummary('project', 'package-manager', {
      sourceRefs: ['router#m7'],
      kind: 'user-decision',
      text: '包管理器换成 npm 安装依赖，pnpm 不再使用。',
    })
    const r3 = await store.appendSummary('project', 'build-output', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '构建产物固定为 dist/entry.js 与 lib/client.js 入库。',
    })
    expect(r1).toEqual({ written: true, anchor: 'e1' })
    expect(r2).toEqual({ written: true, anchor: 'e2', conflictsWith: 'e1' })
    expect(r3).toEqual({ written: true, anchor: 'e3' })
    const doc = await store.readDoc('project')
    expect(doc?.entries).toHaveLength(3)
    expect(doc?.entries[1]?.conflictsWith).toBe('e1')
    expect(doc?.entries[1]?.key).toBe('package-manager')
    expect(doc?.entries[2]?.conflictsWith).toBeUndefined()
    // 头部 updatedAt 跟随最后一次写入；每条条目保留各自的写入时间
    expect(doc?.updatedAt).toBe(BASE + 3000)
    expect(doc?.entries[0]?.at).toBe(BASE + 1000)
    expect(doc?.entries[1]?.at).toBe(BASE + 2000)
  })

  it('三类标记写成 [决定]/[建议]/[事实]，回读还原原 kind；sourceRefs 分号分隔可还原数组', async () => {
    const { fs, files } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    await store.appendSummary('global', 'language', {
      sourceRefs: ['a#m1'],
      kind: 'user-decision',
      text: '面向用户的输出默认改用日常语言书写，少用行话。',
    })
    await store.appendSummary('global', 'review', {
      sourceRefs: ['b#m2', 'b#m3'],
      kind: 'worker-suggestion',
      text: 'worker 建议跨仓改动用 worktree 流程推进。',
    })
    await store.appendSummary('global', 'gates', {
      sourceRefs: [],
      kind: 'verified-fact',
      text: '已验证事实：三门禁全绿才是合并的唯一判据。',
    })
    const raw = files.get('/mem-root/global.md') ?? ''
    expect(raw).toContain('- [决定] ')
    expect(raw).toContain('- [建议] ')
    expect(raw).toContain('- [事实] ')
    expect(raw).toContain('sources: b#m2; b#m3')
    const doc = await store.readDoc('global')
    expect(doc?.entries.map((e) => e.kind)).toEqual([
      'user-decision',
      'worker-suggestion',
      'verified-fact',
    ])
    expect(doc?.entries[1]?.sourceRefs).toEqual(['b#m2', 'b#m3'])
  })

  it('text 含换行时先扁平化为单行再写入，回读逐字一致', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    await store.appendSummary('project', 'deploy', {
      sourceRefs: [],
      kind: 'user-decision',
      text: '第一行记录决定内容。\r\n第二行补充决定的理由。',
    })
    const doc = await store.readDoc('project')
    expect(doc?.entries[0]?.text).toBe('第一行记录决定内容。 第二行补充决定的理由。')
  })
})
