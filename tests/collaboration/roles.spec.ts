/**
 * 角色模板 RoleStore 测试（计划 Task 1）。
 *
 * 覆盖 brief 命名断言 roles_manual_model_same_store（两个调用方保存后共同可读），
 * 另加：save 无 id 生成 UUID、save 带 id 更新既有、read 缺失 NOT_FOUND、损坏
 * CORRUPT_RECORD、空 name 拒绝、list 排序。真实临时目录 + 注入 fs/时间/UUID。
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createRoleStore } from '../../src/collaboration/roles.ts'
import type { RoleStore } from '../../src/collaboration/types.ts'
import { makeCollabFs } from './collab-test-fs.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

let uuidSeq = 0
function seqUuid(): string {
  uuidSeq += 1
  return `00000000-0000-4000-8000-${uuidSeq.toString(16).padStart(12, '0')}`
}
let clock = 1000
function tick(): number {
  return (clock += 1000)
}

interface RoleHandle {
  store: RoleStore
  dir: string
  collab: ReturnType<typeof makeCollabFs>
}
async function makeStore(): Promise<RoleHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'router-roles-'))
  roots.push(dir)
  const collab = makeCollabFs()
  const store = createRoleStore(dir, { fs: collab.fs, now: tick, uuid: seqUuid })
  return { store, dir, collab }
}

describe('roles_manual_model_same_store：两调用方保存后共同可读', () => {
  it('manual 与 model 两次 save 落在同一 store，list/read 都可见', async () => {
    const h = await makeStore()
    const manual = await h.store.save({ name: '前端开发', description: '做 UI' })
    const model = await h.store.save({ name: '测试', description: '做测试' })
    const list = await h.store.list()
    expect(list.map((r) => r.name).sort()).toEqual(['前端开发', '测试'])
    expect((await h.store.read(manual.id)).name).toBe('前端开发')
    expect((await h.store.read(model.id)).name).toBe('测试')
  })
})

describe('边角与约束', () => {
  it('save 无 id 生成 UUID id，createdAt 落定', async () => {
    const h = await makeStore()
    const role = await h.store.save({ name: '调查', description: '查问题' })
    expect(role.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(typeof role.createdAt).toBe('number')
    expect(role.updatedAt).toBe(role.createdAt)
  })

  it('save 带 id 更新既有模板，createdAt 不变、updatedAt 前进', async () => {
    const h = await makeStore()
    const created = await h.store.save({ name: '前端', description: '旧说明' })
    const updated = await h.store.save({ id: created.id, name: '前端', description: '新说明' })
    expect(updated.id).toBe(created.id)
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt)
    expect(updated.description).toBe('新说明')
    expect((await h.store.list())).toHaveLength(1)
  })

  it('save 带不存在的 id → NOT_FOUND', async () => {
    const h = await makeStore()
    await expect(
      h.store.save({ id: '11111111-1114-4111-8111-111111111111', name: 'X', description: 'Y' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('空 name 拒绝，空 description 合法', async () => {
    const h = await makeStore()
    await expect(h.store.save({ name: '', description: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const ok = await h.store.save({ name: 'X', description: '' })
    expect(ok.description).toBe('')
  })

  it('read 缺失 → NOT_FOUND；损坏 → CORRUPT_RECORD', async () => {
    const h = await makeStore()
    await expect(h.store.read('11111111-1114-4111-8111-111111111111')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const role = await h.store.save({ name: 'X', description: 'Y' })
    await writeFile(join(h.dir, 'collaboration', 'roles', `${role.id}.json`), '{ bad', 'utf8')
    await expect(h.store.read(role.id)).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  })

  it('list 无角色返回空数组，按 createdAt/id 排序', async () => {
    const h = await makeStore()
    expect(await h.store.list()).toEqual([])
    const a = await h.store.save({ name: 'A', description: '' })
    const b = await h.store.save({ name: 'B', description: '' })
    const list = await h.store.list()
    expect(list.map((r) => r.id)).toEqual([a.id, b.id])
  })
})

describe('修复1 路径边界与磁盘角色身份', () => {
  it('角色文件内 id 被改成越界值时 save 仍按已校验请求 id 落盘', async () => {
    const h = await makeStore()
    const role = await h.store.save({ name: 'A', description: 'd' })
    const path = join(h.dir, 'collaboration', 'roles', `${role.id}.json`)
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    onDisk.id = '../../escaped'
    await writeFile(path, JSON.stringify(onDisk), 'utf8')
    const updated = await h.store.save({ id: role.id, name: 'B', description: 'd' })
    expect(updated.id).toBe(role.id)
    // 越界路径不应被创建
    await expect(readFile(join(h.dir, 'escaped.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('collaboration/roles 是符号链接时 save 拒绝，不写到链接外', async () => {
    const h = await makeStore()
    await h.store.save({ name: 'seed', description: 'd' }) // 先建出 collaboration/roles
    await rm(join(h.dir, 'collaboration', 'roles'), { recursive: true, force: true })
    const outside = join(h.dir, 'outside-roles')
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(h.dir, 'collaboration', 'roles'))
    await expect(h.store.save({ name: 'A', description: 'd' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('collaboration 是普通文件时 save 抛 IO_ERROR（不泄露原生 ENOTDIR）', async () => {
    const h = await makeStore()
    await writeFile(join(h.dir, 'collaboration'), 'i am a file', 'utf8')
    await expect(h.store.save({ name: 'A', description: 'd' })).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})

describe('修复2 提交快照与队列入口（角色）', () => {
  it('first 读被闸住时 second 仍按提交顺序最后落定（读在队列内）', async () => {
    const h = await makeStore()
    const role = await h.store.save({ name: '原始', description: 'd' })
    const gated = h.collab.armReadGate(role.id) // 一次性闸住此角色的首次 readFile
    const firstP = h.store.save({ id: role.id, name: 'first', description: 'd' })
    const secondP = h.store.save({ id: role.id, name: 'second', description: 'd' })
    await gated // 等 first 的读被实际闸住
    // 留出窗口：若"已有记录读"在队列外（bug），second 会独立读完并落盘；
    // 修复后 second 排在 first 之后，此窗口内不会落盘。
    await new Promise((r) => setTimeout(r, 100))
    h.collab.releaseReadGate() // 释放 first 的读
    await Promise.all([firstP, secondP])
    const final = await h.store.read(role.id)
    expect(final.name).toBe('second') // 最后提交者胜
  })
})
