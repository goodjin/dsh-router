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

import { createRoleStore, seedPresetRoles } from '../../src/collaboration/roles.ts'
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

  it('save 带不合法 id（非 UUID）→ INVALID_INPUT；read 缺失仍 NOT_FOUND', async () => {
    const h = await makeStore()
    await expect(
      h.store.save({ id: 'not-a-uuid', name: 'X', description: 'Y' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      h.store.read('11111111-1114-4111-8111-111111111111'),
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
  it('角色文件内 id 被改成越界值时 save 抛 CORRUPT_RECORD，不越界写', async () => {
    const h = await makeStore()
    const role = await h.store.save({ name: 'A', description: 'd' })
    const path = join(h.dir, 'collaboration', 'roles', `${role.id}.json`)
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    onDisk.id = '../../escaped'
    await writeFile(path, JSON.stringify(onDisk), 'utf8')
    // 盘内 id 与请求/文件名不符即坏盘数据：save 拒绝，不按盘 id 选写路径。
    await expect(
      h.store.save({ id: role.id, name: 'B', description: 'd' }),
    ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
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

describe('修复3 磁盘角色 id 与文件名不符被拒', () => {
  const cases: Array<{ name: string; badId: string }> = [
    { name: '另一个合法 UUID', badId: '99999999-9999-4999-8999-999999999999' },
    { name: '../../escaped', badId: '../../escaped' },
  ]
  for (const c of cases) {
    it(`盘内 id 为 ${c.name} 时 read/list/save 均 CORRUPT_RECORD 且无越界`, async () => {
      const h = await makeStore()
      const role = await h.store.save({ name: 'A', description: 'd' })
      const path = join(h.dir, 'collaboration', 'roles', `${role.id}.json`)
      const onDisk = JSON.parse(await readFile(path, 'utf8'))
      onDisk.id = c.badId
      await writeFile(path, JSON.stringify(onDisk), 'utf8')
      await expect(h.store.read(role.id)).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
      await expect(h.store.list()).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
      await expect(
        h.store.save({ id: role.id, name: 'B', description: 'd' }),
      ).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
      // 无越界：escaped.json 不应被创建
      await expect(readFile(join(h.dir, 'escaped.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }

  it('新实例读同一损坏文件也拒（CORRUPT_RECORD）', async () => {
    const h = await makeStore()
    const role = await h.store.save({ name: 'A', description: 'd' })
    const path = join(h.dir, 'collaboration', 'roles', `${role.id}.json`)
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    onDisk.id = '99999999-9999-4999-8999-999999999999'
    await writeFile(path, JSON.stringify(onDisk), 'utf8')
    const h2 = createRoleStore(h.dir, { fs: makeCollabFs().fs, now: tick, uuid: seqUuid })
    await expect(h2.read(role.id)).rejects.toMatchObject({ code: 'CORRUPT_RECORD' })
  })
})

describe('修复3 list 的 readdir 前目录链守卫（空 symlink 目录不再当 []）', () => {
  it('roles 目录被换成 symlink 时 list 抛 INVALID_INPUT', async () => {
    const h = await makeStore()
    await h.store.save({ name: 'seed', description: 'd' }) // 建出 collaboration/roles
    await rm(join(h.dir, 'collaboration', 'roles'), { recursive: true, force: true })
    const outside = join(h.dir, 'outside-roles')
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(h.dir, 'collaboration', 'roles'))
    await expect(h.store.list()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('全新目录（无 collaboration）list 返回 [] 且不创建目录', async () => {
    const h = await makeStore()
    expect(await h.store.list()).toEqual([])
    await expect(readFile(join(h.dir, 'collaboration'))).rejects.toMatchObject({ code: 'ENOENT' })
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

describe('seedPresetRoles：预置角色与幂等种入', () => {
  it('save 带不存在但合法的 id：以该 id 新建（upsert，为幂等种入服务）', async () => {
    const h = await makeStore()
    const saved = await h.store.save({ id: '11111111-2222-4311-8111-111111111111', name: '新角色', description: 'd' })
    expect(saved.id).toBe('11111111-2222-4311-8111-111111111111')
    expect((await h.store.list()).map((r) => r.name)).toEqual(['新角色'])
  })

  it('空库种入四个预置角色（主管/执行者/调研员/评审员）；重复调用不增不改', async () => {
    const h = await makeStore()
    await seedPresetRoles(h.store)
    await seedPresetRoles(h.store)
    const list = await h.store.list()
    expect(list.map((r) => r.name)).toEqual(['主管', '执行者', '调研员', '评审员'])
    for (const role of list) {
      expect(role.description.length).toBeGreaterThan(4)
      expect(role.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    }
  })

  it('用户改过的预置角色不被覆盖（按 id 判断；描述保留用户版本）', async () => {
    const h = await makeStore()
    await seedPresetRoles(h.store)
    const seeded = (await h.store.list()).find((r) => r.name === '主管')!
    await h.store.save({ id: seeded.id, name: '主管', description: '用户改过的说明' })
    await seedPresetRoles(h.store)
    const after = await h.store.read(seeded.id)
    expect(after.description).toBe('用户改过的说明')
    expect((await h.store.list()).map((r) => r.name)).toEqual(['主管', '执行者', '调研员', '评审员'])
  })
})
