/**
 * 活跃任务视图缓存测试（两级模型 2026-11-24：任务描述驱动上下文）。
 *
 * brief 命名断言：
 *  - cache_reads_are_sync_and_fresh_after_write：get 同步；refresh 后立刻可见（写后由 tools/dispatch 行调用）。
 *  - cache_filters_and_shapes：只收活跃任务（排除「已报告」；无标签视为活跃），带完整 body 与子会话，按创建序。
 *  - cache_caps：超过 maxTasks 截断（防膨胀）。
 *  - cache_isolated_per_root：按 rootSessionId 隔离。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createActiveTaskCache, DEFAULT_MAX_ACTIVE_TASKS } from '../../src/collaboration/active-tasks.ts'
import { createRecordStore } from '../../src/collaboration/records.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

async function make() {
  const dir = await mkdtemp(join(tmpdir(), 'router-active-tasks-'))
  roots.push(dir)
  const records = createRecordStore(dir)
  return { records, cache: createActiveTaskCache(records) }
}

describe('cache_reads_are_sync_and_fresh_after_write', () => {
  it('refresh 之前 get 是 undefined；refresh 之后同步可读', async () => {
    const { records, cache } = await make()
    expect(cache.get('root-1')).toBeUndefined()
    await records.create('root-1', { kind: 'task', title: 'T', body: 'b' })
    await cache.refresh('root-1')
    const view = cache.get('root-1')
    expect(view).toBeDefined()
    expect(view!.map((t) => t.title)).toEqual(['T'])
    // 再写一条并 refresh：立刻可见，无需等待
    await records.create('root-1', { kind: 'task', title: 'T2', body: 'b2' })
    await cache.refresh('root-1')
    expect(cache.get('root-1')!.map((t) => t.title)).toEqual(['T', 'T2'])
  })
})

describe('cache_filters_and_shapes', () => {
  it('排除已报告；无标签/进行中/受阻都算活跃；带完整 body 与 assignment.sessions；按创建序', async () => {
    const { records, cache } = await make()
    const t1 = await records.create('root-1', { kind: 'task', title: '未标注', body: '正文一\n第二行' })
    const t2 = await records.create('root-1', { kind: 'task', title: '进行中', body: '正文二', workLabel: '进行中' })
    const t3 = await records.create('root-1', { kind: 'task', title: '受阻', body: '正文三', workLabel: '受阻' })
    await records.create('root-1', { kind: 'task', title: '已报告', body: '正文四', workLabel: '已报告' })
    await records.create('root-1', { kind: 'assignment', taskId: t2.record.taskId, title: 'a', body: '', sessions: [{ sessionId: 'c-1', label: '执行者' }] })
    await records.create('root-1', { kind: 'assignment', taskId: t2.record.taskId, title: 'b', body: '', sessions: [{ sessionId: 'c-2', label: '测试工程师' }, { sessionId: 'c-3', label: '评审员' }] })
    const view = await cache.refresh('root-1')
    expect(view.map((t) => t.taskId)).toEqual([t1.record.taskId, t2.record.taskId, t3.record.taskId])
    expect(view[0]).toMatchObject({ title: '未标注', body: '正文一\n第二行', workLabel: '未标注', sessions: [] })
    expect(view[1]!.workLabel).toBe('进行中')
    expect(view[1]!.sessions).toEqual([
      { sessionId: 'c-1', label: '执行者' },
      { sessionId: 'c-2', label: '测试工程师' },
      { sessionId: 'c-3', label: '评审员' },
    ])
    expect(view[2]!.workLabel).toBe('受阻')
  })
})

describe('cache_caps', () => {
  it(`超过 maxTasks（默认 ${DEFAULT_MAX_ACTIVE_TASKS}）截断`, async () => {
    const { records, cache } = await make()
    for (let i = 0; i < DEFAULT_MAX_ACTIVE_TASKS + 3; i++) {
      await records.create('root-1', { kind: 'task', title: `T${i}`, body: 'b' })
    }
    const view = await cache.refresh('root-1')
    expect(view).toHaveLength(DEFAULT_MAX_ACTIVE_TASKS)
    // 自定义上限
    const small = createActiveTaskCache(records, { maxTasks: 2 })
    expect(await small.refresh('root-1')).toHaveLength(2)
  })
})

describe('cache_isolated_per_root', () => {
  it('不同 rootSessionId 互不可见；没有记录的 root 刷新为空数组', async () => {
    const { records, cache } = await make()
    await records.create('root-1', { kind: 'task', title: 'A', body: 'b' })
    await cache.refresh('root-1')
    expect(cache.get('root-2')).toBeUndefined()
    expect(await cache.refresh('root-2')).toEqual([])
    expect(cache.get('root-1')!.map((t) => t.title)).toEqual(['A'])
  })
})
