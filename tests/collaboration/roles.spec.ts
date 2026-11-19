/**
 * 角色模板 RoleStore 测试（md 按名键版）。
 *
 * 角色库一个角色一个 md 文件：文件名 = 角色名、正文 = 职责说明。覆盖：
 * manual/model 同库共读；按名 upsert；名字合法性（文件名安全）；read 缺失
 * NOT_FOUND；list 按名排序；symlink/普通文件路径守卫；旧 JSON 残留不进 list
 * 且可一次性迁移为 md；预置角色按名幂等种入。真实临时目录 + 注入 fs。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createRoleStore, PRESET_ROLE_TEMPLATES, seedPresetRoles } from '../../src/collaboration/roles.ts'
import type { RoleStore } from '../../src/collaboration/types.ts'
import { makeCollabFs } from './collab-test-fs.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

interface RoleHandle {
  store: RoleStore
  dir: string
  rolesDir: string
  collab: ReturnType<typeof makeCollabFs>
}
async function makeStore(): Promise<RoleHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'router-roles-'))
  roots.push(dir)
  const collab = makeCollabFs()
  const store = createRoleStore(dir, { fs: collab.fs })
  return { store, dir, rolesDir: join(dir, 'collaboration', 'roles'), collab }
}

describe('roles_manual_model_same_store：两调用方保存后共同可读', () => {
  it('manual 与 model 两次 save 落在同一 store，list/read 都可见', async () => {
    const h = await makeStore()
    await h.store.save({ name: '前端开发', description: '做 UI' })
    await h.store.save({ name: '测试', description: '做测试' })
    const list = await h.store.list()
    expect(list.map((r) => r.name).sort()).toEqual(['前端开发', '测试'])
    expect((await h.store.read('前端开发')).description).toBe('做 UI')
  })
})

describe('md 存储：一个角色一个 md 文件，文件名 = 角色名', () => {
  it('save 落盘 <name>.md，正文 = 职责说明（多行中文原样往返）', async () => {
    const h = await makeStore()
    const duty = '第一行：拆解任务\n第二行：汇总结果'
    await h.store.save({ name: '主管', description: duty })
    const text = await readFile(join(h.rolesDir, '主管.md'), 'utf8')
    expect(text).toBe(duty)
    expect((await h.store.read('主管')).description).toBe(duty)
  })

  it('save 同名 = 更新（按名 upsert，文件仍是一个）', async () => {
    const h = await makeStore()
    await h.store.save({ name: '主管', description: '旧说明' })
    await h.store.save({ name: '主管', description: '新说明' })
    expect((await h.store.read('主管')).description).toBe('新说明')
    expect((await h.store.list())).toHaveLength(1)
  })

  it('手工直接改 md 文件，store 读得到（文件是唯一事实源）', async () => {
    const h = await makeStore()
    await h.store.save({ name: '评审员', description: '旧' })
    await writeFile(join(h.rolesDir, '评审员.md'), '手工改的职责', 'utf8')
    expect((await h.store.read('评审员')).description).toBe('手工改的职责')
  })

  it('空 description 合法（空文件）', async () => {
    const h = await makeStore()
    const saved = await h.store.save({ name: 'X', description: '' })
    expect(saved.description).toBe('')
  })

  it('list 无角色返回空数组，按名字典序', async () => {
    const h = await makeStore()
    expect(await h.store.list()).toEqual([])
    await h.store.save({ name: 'B', description: '' })
    await h.store.save({ name: 'A', description: '' })
    expect((await h.store.list()).map((r) => r.name)).toEqual(['A', 'B'])
  })

  it('read 缺失 → NOT_FOUND', async () => {
    const h = await makeStore()
    await expect(h.store.read('不存在')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('名字合法性（文件名安全，中文合法）', () => {
  for (const bad of ['', ' ', 'a/b', 'a\\b', '.', '..', '.hidden', 'a\0b', 'x'.repeat(65)]) {
    it(`非法名字 ${JSON.stringify(bad)} → INVALID_INPUT，不落盘`, async () => {
      const h = await makeStore()
      await expect(h.store.save({ name: bad, description: 'd' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(readdir(h.rolesDir)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }
  it('名字两端空白被去掉后保存（“ 主管 ” → “主管”）', async () => {
    const h = await makeStore()
    const saved = await h.store.save({ name: ' 主管 ', description: 'd' })
    expect(saved.name).toBe('主管')
  })
})

describe('路径边界守卫', () => {
  it('collaboration/roles 是符号链接时 save 拒绝，不写到链接外', async () => {
    const h = await makeStore()
    await h.store.save({ name: 'seed', description: 'd' })
    await rm(h.rolesDir, { recursive: true, force: true })
    const outside = join(h.dir, 'outside-roles')
    await mkdir(outside, { recursive: true })
    await symlink(outside, h.rolesDir)
    await expect(h.store.save({ name: 'A', description: 'd' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('roles 目录被换成 symlink 时 list 拒绝（不当空目录）', async () => {
    const h = await makeStore()
    await h.store.save({ name: 'seed', description: 'd' })
    await rm(h.rolesDir, { recursive: true, force: true })
    const outside = join(h.dir, 'outside-roles')
    await mkdir(outside, { recursive: true })
    await symlink(outside, h.rolesDir)
    await expect(h.store.list()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('collaboration 是普通文件时 save 抛 IO_ERROR（不泄露原生 ENOTDIR）', async () => {
    const h = await makeStore()
    await writeFile(join(h.dir, 'collaboration'), 'i am a file', 'utf8')
    await expect(h.store.save({ name: 'A', description: 'd' })).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('名字含路径分隔符无法构造越界路径（合法校验先拦）', async () => {
    const h = await makeStore()
    await expect(h.store.save({ name: '../../escaped', description: 'd' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(readFile(join(h.dir, 'escaped.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('旧 JSON 角色迁移（md 化）', () => {
  it('残留 <uuid>.json 不进 list；migrateLegacyJson 转成 md 后可见，原 json 保留', async () => {
    const h = await makeStore()
    await mkdir(h.rolesDir, { recursive: true })
    const legacy = { id: 'a1b2c3d4-0001-4000-8000-000000000001', name: '旧角色', description: '旧职责', createdAt: 1, updatedAt: 2 }
    await writeFile(join(h.rolesDir, 'a1b2c3d4-0001-4000-8000-000000000001.json'), JSON.stringify(legacy), 'utf8')
    // 迁移前：json 不进 list。
    expect(await h.store.list()).toEqual([])
    await h.store.migrateLegacyJson()
    expect((await h.store.list()).map((r) => r.name)).toEqual(['旧角色'])
    expect((await h.store.read('旧角色')).description).toBe('旧职责')
    // 原 json 文件保留（不删用户数据）。
    const names = await readdir(h.rolesDir)
    expect(names).toContain('a1b2c3d4-0001-4000-8000-000000000001.json')
    expect(names).toContain('旧角色.md')
    // 再迁移不重复（md 已存在则跳过）。
    await h.store.migrateLegacyJson()
    expect((await h.store.list())).toHaveLength(1)
  })

  it('坏 json 跳过不炸（其余照常迁移）', async () => {
    const h = await makeStore()
    await mkdir(h.rolesDir, { recursive: true })
    await writeFile(join(h.rolesDir, '11111111-1111-4111-8111-111111111111.json'), '{ bad', 'utf8')
    await writeFile(
      join(h.rolesDir, '22222222-2222-4222-8222-222222222222.json'),
      JSON.stringify({ id: '22222222-2222-4222-8222-222222222222', name: '好角色', description: 'ok', createdAt: 1, updatedAt: 1 }),
      'utf8',
    )
    await h.store.migrateLegacyJson()
    expect((await h.store.list()).map((r) => r.name)).toEqual(['好角色'])
  })
})

describe('seedPresetRoles：预置角色按名幂等种入', () => {
  it('空库种入全部预置角色（v2 共 16 个）；重复调用不增不改', async () => {
    const h = await makeStore()
    await seedPresetRoles(h.store)
    await seedPresetRoles(h.store)
    const list = await h.store.list()
    expect(list.map((r) => r.name)).toEqual(PRESET_ROLE_TEMPLATES.map((r) => r.name).sort())
    for (const role of list) expect(role.description.length).toBeGreaterThan(4)
  })

  it('用户改过的预置角色不被覆盖（按名判断）', async () => {
    const h = await makeStore()
    await seedPresetRoles(h.store)
    await h.store.save({ name: '主管', description: '用户改过的说明' })
    await seedPresetRoles(h.store)
    expect((await h.store.read('主管')).description).toBe('用户改过的说明')
  })

  it('预置角色落为可手工编辑的 md 文件', async () => {
    const h = await makeStore()
    await seedPresetRoles(h.store)
    const names = await readdir(h.rolesDir)
    expect(names).toContain('主管.md')
    expect(names).toContain('评审员.md')
  })
})

describe('preset_roster_v2 — 专业角色扩容', () => {
  const EXPECTED_NAMES = [
    'Python程序员', 'Java程序员', '前端程序员', '交互设计师',
    '主管', '执行者', '调研员', '评审员',
    '架构设计工程师', '测试工程师', '部署运维工程师', '文档资料归档工程师',
    '需求与PRD工程师', 'PRD审核员', 'MR审核员', '代码评审员',
  ].sort()

  it('预置名单覆盖 16 个角色（4 既有 + 12 新增），不多不少', () => {
    expect(PRESET_ROLE_TEMPLATES.map((r) => r.name).sort()).toEqual(EXPECTED_NAMES)
  })

  it('每个角色的职责都是「首行摘要 + 详细正文」两层结构：首行非空且 ≤ 80 字，正文 ≥ 4 行', () => {
    for (const role of PRESET_ROLE_TEMPLATES) {
      const lines = role.description.split('\n')
      expect(lines[0]!.trim().length, `${role.name} 首行摘要`).toBeGreaterThan(6)
      expect(lines[0]!.length, `${role.name} 首行摘要长度 ≤ 80`).toBeLessThanOrEqual(80)
      expect(lines.length, `${role.name} 详细正文行数`).toBeGreaterThanOrEqual(4)
    }
  })

  it('角色名都是合法文件名：无路径分隔符、长度 ≤ 64、不以点开头', () => {
    for (const role of PRESET_ROLE_TEMPLATES) {
      expect(role.name, `${role.name} 含路径分隔符`).not.toMatch(/[/\\]/)
      expect(role.name.length).toBeLessThanOrEqual(64)
      expect(role.name.startsWith('.')).toBe(false)
    }
  })

  it('主管职责包含八类任务的组织流程标记', () => {
    const supervisor = PRESET_ROLE_TEMPLATES.find((r) => r.name === '主管')
    expect(supervisor).toBeDefined()
    for (const marker of ['需求理解与PRD', '技术设计', '功能开发', 'bugfix', '测试', 'MR审核', '调研', '归档与发布']) {
      expect(supervisor!.description).toContain(marker)
    }
  })
})

describe('seed_upgrade — 历史预置文本的精确升级', () => {
  const OLD_SUPERVISOR = '把任务拆成可独立执行的分工，派给合适的成员，跟进进度并汇总结果向上报告；不亲自执行具体工作。'

  it('现有内容等于历史预置文本（用户未改过）时升级到最新', async () => {
    const h = await makeStore()
    await h.store.save({ name: '主管', description: OLD_SUPERVISOR })
    await seedPresetRoles(h.store)
    const latest = PRESET_ROLE_TEMPLATES.find((r) => r.name === '主管')!.description
    expect(await h.store.read('主管')).toMatchObject({ description: latest })
  })

  it('现有内容与任何历史文本都不一致（用户改过）时不动', async () => {
    const h = await makeStore()
    const custom = '我们组自己定义的主管规则，与预置文本不同。'
    await h.store.save({ name: '主管', description: custom })
    await seedPresetRoles(h.store)
    expect(await h.store.read('主管')).toMatchObject({ description: custom })
  })

  it('已是最新文本时幂等（重复种入内容不变）', async () => {
    const h = await makeStore()
    await seedPresetRoles(h.store)
    const once = await h.store.read('主管')
    await seedPresetRoles(h.store)
    expect(await h.store.read('主管')).toEqual(once)
  })

  it('历史文本角色升级的同时，缺失的新角色被种入', async () => {
    const h = await makeStore()
    await h.store.save({ name: '主管', description: OLD_SUPERVISOR })
    await seedPresetRoles(h.store)
    const names = (await h.store.list()).map((r) => r.name)
    expect(names).toEqual(PRESET_ROLE_TEMPLATES.map((r) => r.name).sort())
  })
})
