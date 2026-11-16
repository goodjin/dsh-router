/**
 * 轻量工作记录 RecordStore 测试（计划 Task 1）。
 *
 * 覆盖 brief 命名断言：record_roundtrip / report_own_file / explicit_label /
 * failed_save_preserves_original / serialized_updates / bad_id_rejected /
 * missing_and_corrupt；另加边角：空标题拒绝、坏种类/标签拒绝、非任务记录须引用
 * 已存在任务、父记录须同任务存在、list 按 createdAt/id 排序、符号链接拒绝。
 * 全部用真实临时目录 + 注入 fs/时间/UUID 驱动。
 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createRecordStore } from '../../src/collaboration/records.ts'
import type { RecordStore } from '../../src/collaboration/types.ts'
import { makeCollabFs } from './collab-test-fs.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

/** 确定性 UUID：版本位 4、变体位 8，走 UUID_RE。 */
let uuidSeq = 0
function seqUuid(): string {
  uuidSeq += 1
  return `00000000-0000-4000-8000-${uuidSeq.toString(16).padStart(12, '0')}`
}

/** 固定时钟：每次调用 +1000，保证 createdAt/updatedAt 可观察单调。 */
let clock = 1000
function tick(): number {
  return (clock += 1000)
}

interface StoreHandle {
  store: RecordStore
  dir: string
  collab: ReturnType<typeof makeCollabFs>
}

async function makeStore(): Promise<StoreHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'router-records-'))
  roots.push(dir)
  const collab = makeCollabFs()
  const store = createRecordStore(dir, { fs: collab.fs, now: tick, uuid: seqUuid })
  return { store, dir, collab }
}

describe('record_roundtrip：新 task id=taskId、read 得到完整正文与实际 path', () => {
  it('新任务记录 id 等于 taskId，read 返回完整正文与真实路径', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: '目标', body: '正文 A' })
    expect(created.record.id).toBe(created.record.taskId)
    expect(created.record.body).toBe('正文 A')
    expect(created.record.rootSessionId).toBe('root-1')
    const read = await h.store.read('root-1', created.record.taskId, created.record.id)
    expect(read.record.body).toBe('正文 A')
    expect(read.path).toBe(created.path)
    expect(read.path.endsWith('.json')).toBe(true)
  })
})

describe('report_own_file：两个 report 路径不同', () => {
  it('同任务下两条报告各占独立文件', async () => {
    const h = await makeStore()
    const task = await h.store.create('root-1', { kind: 'task', title: 'T', body: '' })
    const a = await h.store.create('root-1', { kind: 'report', taskId: task.record.taskId, title: '成员A', body: 'A' })
    const b = await h.store.create('root-1', { kind: 'report', taskId: task.record.taskId, title: '成员B', body: 'B' })
    expect(a.path).not.toBe(b.path)
    expect(a.record.id).not.toBe(b.record.id)
    const list = await h.store.list('root-1', { taskId: task.record.taskId })
    expect(list.map((r) => r.id).sort()).toEqual([a.record.id, b.record.id, task.record.id].sort())
  })
})

describe('explicit_label：更新仅按 patch 发生', () => {
  it('只改 workLabel 时 title/body 不变', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'orig', workLabel: '待处理' })
    const updated = await h.store.update('root-1', created.record.taskId, created.record.id, { workLabel: '进行中' })
    expect(updated.record.workLabel).toBe('进行中')
    expect(updated.record.title).toBe('T')
    expect(updated.record.body).toBe('orig')
    expect(updated.record.createdAt).toBe(created.record.createdAt)
  })
})

describe('failed_save_preserves_original：注入 rename 失败后 read 仍为旧正文', () => {
  it('update 落盘失败抛 IO_ERROR，原文件保持旧正文', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'orig' })
    h.collab.failRename()
    await expect(
      h.store.update('root-1', created.record.taskId, created.record.id, { body: 'new' }),
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
    h.collab.healRename()
    const read = await h.store.read('root-1', created.record.taskId, created.record.id)
    expect(read.record.body).toBe('orig')
  })
})

describe('serialized_updates：并发两次更新排队后文件可解析、最后提交生效', () => {
  it('两个不重叠 patch 并发提交后都生效，文件可解析', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'orig' })
    const id = created.record.taskId
    await Promise.all([
      h.store.update('root-1', id, id, { body: 'A' }),
      h.store.update('root-1', id, id, { title: 'B' }),
    ])
    const read = await h.store.read('root-1', id, id)
    expect(read.record.body).toBe('A')
    expect(read.record.title).toBe('B')
  })
})

describe('bad_id_rejected：../x 被拒', () => {
  it('read/create 收到越界 id 抛 INVALID_INPUT', async () => {
    const h = await makeStore()
    await expect(h.store.read('root-1', '../x', '../x')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      h.store.create('root-1', { kind: 'report', taskId: '../x', title: 'T', body: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('missing_and_corrupt：分别 NOT_FOUND / CORRUPT_RECORD', () => {
  it('缺失记录 → NOT_FOUND', async () => {
    const h = await makeStore()
    await expect(
      h.store.read('root-1', '11111111-1114-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('JSON 损坏 → CORRUPT_RECORD', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'ok' })
    await writeFile(created.path, '{ not json', 'utf8')
    await expect(
      h.store.read('root-1', created.record.taskId, created.record.id),
    ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  })
})

describe('边角与约束', () => {
  it('空标题拒绝（空 body 合法）', async () => {
    const h = await makeStore()
    await expect(h.store.create('root-1', { kind: 'task', title: '', body: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const ok = await h.store.create('root-1', { kind: 'task', title: 'T', body: '' })
    expect(ok.record.body).toBe('')
  })

  it('坏种类 / 坏工作标签拒绝', async () => {
    const h = await makeStore()
    await expect(h.store.create('root-1', { kind: 'bogus' as never, title: 'T', body: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      h.store.create('root-1', { kind: 'task', title: 'T', body: '', workLabel: '已验收' as never }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('非任务记录必须引用已存在任务', async () => {
    const h = await makeStore()
    await expect(
      h.store.create('root-1', { kind: 'report', taskId: '11111111-1114-4111-8111-111111111111', title: 'T', body: '' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('非任务记录缺 taskId 拒绝', async () => {
    const h = await makeStore()
    await expect(h.store.create('root-1', { kind: 'report', title: 'T', body: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('parentRecordId 须指向同任务已存在记录', async () => {
    const h = await makeStore()
    const task = await h.store.create('root-1', { kind: 'task', title: 'T', body: '' })
    await expect(
      h.store.create('root-1', {
        kind: 'report',
        taskId: task.record.taskId,
        parentRecordId: '44444444-4444-4444-8444-444444444444',
        title: 'T',
        body: '',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const child = await h.store.create('root-1', {
      kind: 'report',
      taskId: task.record.taskId,
      parentRecordId: task.record.id,
      title: 'child',
      body: '',
    })
    expect(child.record.parentRecordId).toBe(task.record.id)
  })

  it('list 无记录返回空数组，按 createdAt/id 排序', async () => {
    const h = await makeStore()
    expect(await h.store.list('root-1')).toEqual([])
    const a = await h.store.create('root-1', { kind: 'task', title: 'A', body: '' })
    const b = await h.store.create('root-1', { kind: 'report', taskId: a.record.taskId, title: 'B', body: '' })
    const c = await h.store.create('root-1', { kind: 'report', taskId: a.record.taskId, title: 'C', body: '' })
    const all = await h.store.list('root-1')
    expect(all.map((r) => r.id)).toEqual([a.record.id, b.record.id, c.record.id])
    const reports = await h.store.list('root-1', { kind: 'report' })
    expect(reports.map((r) => r.id)).toEqual([b.record.id, c.record.id])
  })

  it('符号链接记录被拒绝（不支持链接）', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'ok' })
    await rm(created.path)
    const elsewhere = join(h.dir, 'elsewhere.json')
    await writeFile(elsewhere, '{}', 'utf8')
    await symlink(elsewhere, created.path)
    await expect(
      h.store.read('root-1', created.record.taskId, created.record.id),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
