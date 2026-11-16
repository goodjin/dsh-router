/**
 * 轻量工作记录 RecordStore 测试（计划 Task 1）。
 *
 * 覆盖 brief 命名断言：record_roundtrip / report_own_file / explicit_label /
 * failed_save_preserves_original / serialized_updates / bad_id_rejected /
 * missing_and_corrupt；另加边角：空标题拒绝、坏种类/标签拒绝、非任务记录须引用
 * 已存在任务、父记录须同任务存在、list 按 createdAt/id 排序、符号链接拒绝。
 * 全部用真实临时目录 + 注入 fs/时间/UUID 驱动。
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createRecordStore } from '../../src/collaboration/records.ts'
import type { RecordDraft, RecordStore } from '../../src/collaboration/types.ts'
import { makeCollabFs } from './collab-test-fs.ts'

/** root-1 的任务目录根：collaboration/roots/<sha256(rootSessionId)>/tasks。 */
function tasksRoot(dir: string, rootSessionId: string): string {
  return join(dir, 'collaboration', 'roots', createHash('sha256').update(rootSessionId).digest('hex'), 'tasks')
}

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

describe('修复1 路径边界与磁盘记录身份', () => {
  it('tasks/<taskId> 被换成符号链接时 create(report) 拒绝，不写到链接外', async () => {
    const h = await makeStore()
    const task = await h.store.create('root-1', { kind: 'task', title: 'T', body: '' })
    const taskDir = join(tasksRoot(h.dir, 'root-1'), task.record.taskId)
    const movedDir = join(h.dir, 'moved-task', task.record.taskId)
    await mkdir(dirname(movedDir), { recursive: true })
    await rename(taskDir, movedDir) // 把任务目录移出
    await symlink(movedDir, taskDir) // 原位置放 symlink
    await expect(
      h.store.create('root-1', { kind: 'report', taskId: task.record.taskId, title: 'R', body: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('磁盘记录 id 与文件名不符时 read 抛 CORRUPT_RECORD', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'ok' })
    const onDisk = JSON.parse(await readFile(created.path, 'utf8'))
    onDisk.id = '99999999-9999-4999-8999-999999999999'
    await writeFile(created.path, JSON.stringify(onDisk), 'utf8')
    await expect(
      h.store.read('root-1', created.record.taskId, created.record.id),
    ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  })

  it('磁盘记录 taskId 与所在目录不符时 read 抛 CORRUPT_RECORD', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'ok' })
    const onDisk = JSON.parse(await readFile(created.path, 'utf8'))
    onDisk.taskId = '88888888-8888-4888-8888-888888888888'
    await writeFile(created.path, JSON.stringify(onDisk), 'utf8')
    await expect(
      h.store.read('root-1', created.record.taskId, created.record.id),
    ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  })

  it('磁盘记录 rootSessionId 与路径不符时 read 抛 CORRUPT_RECORD', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'ok' })
    const onDisk = JSON.parse(await readFile(created.path, 'utf8'))
    onDisk.rootSessionId = 'other-root'
    await writeFile(created.path, JSON.stringify(onDisk), 'utf8')
    await expect(
      h.store.read('root-1', created.record.taskId, created.record.id),
    ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  })

  it('非任务记录引用了 id 与路径不符的"任务"时 create 抛 CORRUPT_RECORD', async () => {
    const h = await makeStore()
    const fakeTaskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const taskPath = join(tasksRoot(h.dir, 'root-1'), fakeTaskId, `${fakeTaskId}.json`)
    await mkdir(dirname(taskPath), { recursive: true })
    await writeFile(
      taskPath,
      JSON.stringify({
        kind: 'task',
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        taskId: fakeTaskId,
        rootSessionId: 'root-1',
        title: 'T',
        body: '',
        createdAt: 1,
        updatedAt: 1,
      }),
      'utf8',
    )
    await expect(
      h.store.create('root-1', { kind: 'report', taskId: fakeTaskId, title: 'R', body: '' }),
    ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  })

  it('collaboration 是普通文件时 create 抛 IO_ERROR（不泄露原生 ENOTDIR）', async () => {
    const h = await makeStore()
    await writeFile(join(h.dir, 'collaboration'), 'i am a file', 'utf8')
    await expect(
      h.store.create('root-1', { kind: 'task', title: 'T', body: '' }),
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})

describe('修复2 提交快照与队列入口', () => {
  it('update 提交后调用方改 patch.body 不影响落盘（入口快照）', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'orig' })
    const patch = { body: 'new' }
    const p = h.store.update('root-1', created.record.taskId, created.record.id, patch)
    patch.body = 42 as unknown as string // 调用方提交后立刻改
    await p
    const read = await h.store.read('root-1', created.record.taskId, created.record.id)
    expect(read.record.body).toBe('new')
  })

  it('create 提交后调用方改 sessions 嵌套不影响落盘（深拷贝快照）', async () => {
    const h = await makeStore()
    const task = await h.store.create('root-1', { kind: 'task', title: 'T', body: '' })
    const draft: RecordDraft = {
      kind: 'report',
      taskId: task.record.taskId,
      title: 'R',
      body: '',
      sessions: [{ sessionId: 's1', label: 'L' }],
    }
    const p = h.store.create('root-1', draft)
    draft.sessions![0]!.sessionId = '' // 调用方提交后立刻改嵌套
    const saved = await p
    const read = await h.store.read('root-1', task.record.taskId, saved.record.id)
    expect(read.record.sessions?.[0]!.sessionId).toBe('s1')
  })
})

describe('修复3 磁盘可选字段损坏被拒（read/list/update 同一 reader）', () => {
  // 表驱动：只改一个字段，read/list/update 全 CORRUPT_RECORD，update 不改坏文件字节。
  const cases: Array<{ name: string; mutate: (rec: Record<string, unknown>) => void }> = [
    { name: 'workLabel 非法枚举', mutate: (r) => { r.workLabel = '系统验收成功' } },
    { name: 'sessions 元素 sessionId 为数字', mutate: (r) => { r.sessions = [{ sessionId: 42, label: 'L' }] } },
    { name: 'artifacts 为字符串', mutate: (r) => { r.artifacts = 'bad' } },
    { name: 'parentRecordId 非 UUID', mutate: (r) => { r.parentRecordId = '../bad' } },
    { name: 'title 空白', mutate: (r) => { r.title = '' } },
    { name: 'createdAt 为 null（NaN 序列化）', mutate: (r) => { r.createdAt = null } },
  ]

  for (const c of cases) {
    it(`${c.name} → read/list/update 全 CORRUPT_RECORD 且 update 不改文件字节`, async () => {
      const h = await makeStore()
      const created = await h.store.create('root-1', { kind: 'task', title: 'T', body: 'ok' })
      const onDisk = JSON.parse(await readFile(created.path, 'utf8'))
      c.mutate(onDisk)
      await writeFile(created.path, JSON.stringify(onDisk), 'utf8')
      const before = await readFile(created.path, 'utf8')
      await expect(
        h.store.read('root-1', created.record.taskId, created.record.id),
      ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
      await expect(h.store.list('root-1')).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
      await expect(
        h.store.update('root-1', created.record.taskId, created.record.id, { body: 'edited' }),
      ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
      expect(await readFile(created.path, 'utf8')).toBe(before) // update 失败不改坏文件
    })
  }

  it('合法空 body / 空 sessions / 空 artifacts 仍读回成功', async () => {
    const h = await makeStore()
    const created = await h.store.create('root-1', {
      kind: 'task', title: 'T', body: '', sessions: [], artifacts: [],
    })
    const read = await h.store.read('root-1', created.record.taskId, created.record.id)
    expect(read.record.body).toBe('')
    expect(read.record.sessions).toEqual([])
    expect(read.record.artifacts).toEqual([])
  })
})

describe('修复3 requireTask/requireParent 复用同 reader 拒损坏（单 case）', () => {
  it('任务记录 workLabel 损坏时为其创建子报告（requireTask）抛 CORRUPT_RECORD', async () => {
    const h = await makeStore()
    const task = await h.store.create('root-1', { kind: 'task', title: 'T', body: '' })
    const onDisk = JSON.parse(await readFile(task.path, 'utf8'))
    onDisk.workLabel = '系统验收成功'
    await writeFile(task.path, JSON.stringify(onDisk), 'utf8')
    await expect(
      h.store.create('root-1', { kind: 'report', taskId: task.record.taskId, title: 'R', body: '' }),
    ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  })

  it('父报告 artifacts 损坏时创建引用它的子报告（requireParent）抛 CORRUPT_RECORD', async () => {
    const h = await makeStore()
    const task = await h.store.create('root-1', { kind: 'task', title: 'T', body: '' })
    const parent = await h.store.create('root-1', { kind: 'report', taskId: task.record.taskId, title: 'P', body: '' })
    const onDisk = JSON.parse(await readFile(parent.path, 'utf8'))
    onDisk.artifacts = 'bad'
    await writeFile(parent.path, JSON.stringify(onDisk), 'utf8')
    await expect(
      h.store.create('root-1', {
        kind: 'report', taskId: task.record.taskId,
        parentRecordId: parent.record.id, title: 'C', body: '',
      }),
    ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  })
})

describe('修复3 list 的 readdir 前目录链守卫（空 symlink 目录不再当 []）', () => {
  it('tasks 根被换成指向空目录的 symlink 时 list 抛 INVALID_INPUT（不再返回 []）', async () => {
    const h = await makeStore()
    await h.store.create('root-1', { kind: 'task', title: 'T', body: '' })
    const root = tasksRoot(h.dir, 'root-1')
    const outside = join(h.dir, 'empty-tasks-root')
    await rm(root, { recursive: true, force: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, root)
    await expect(h.store.list('root-1')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('某任务目录被换成指向空目录的 symlink 时 list 抛 INVALID_INPUT', async () => {
    const h = await makeStore()
    const task = await h.store.create('root-1', { kind: 'task', title: 'T', body: '' })
    const taskDir = join(tasksRoot(h.dir, 'root-1'), task.record.taskId)
    const outside = join(h.dir, 'empty-task-dir')
    await rm(taskDir, { recursive: true, force: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, taskDir)
    await expect(h.store.list('root-1')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('全新目录（无 collaboration）list 返回 [] 且不创建目录', async () => {
    const h = await makeStore()
    expect(await h.store.list('root-1')).toEqual([])
    await expect(readFile(join(h.dir, 'collaboration'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
