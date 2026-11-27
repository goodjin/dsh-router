/**
 * 角色模板 RoleStore 测试（md 按 ID 键版）。
 *
 * 角色库一个角色一个 md 文件：**文件名 = 角色 ID**（稳定，不随名称变），内容是
 * 角色围栏（id + name）+ 职责正文 + 可选候选围栏。覆盖：
 * manual/model 同库共读；带 id 原地更新（改名不动文件路径）；名称唯一；
 * 名字/ID 合法性；read 缺失 NOT_FOUND（按名或按 ID）；list 按名排序；
 * symlink/普通文件路径守卫；旧 JSON 残留不进 list 且可一次性迁移；
 * 旧格式（文件名=角色名）文件一次性迁成 ID 命名（正文逐字保留、幂等、残留清理、
 * 迁移前备份）；预置角色按名幂等种入。真实临时目录 + 注入 fs。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createRoleStore, PRESET_ROLE_TEMPLATES, seedPresetRoles } from '../../src/collaboration/roles.ts'
import { deriveRoleId, ROLE_FENCE_START } from '../../src/collaboration/role-models.ts'
import { RETIRED_PRESET_ROLES } from '../../src/collaboration/preset-roles.ts'
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
  // 固定时钟：备份目录名（roles.bak-<时间戳>）在测试里可预期。
  const store = createRoleStore(dir, { fs: collab.fs, now: () => 1764000000000 })
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

describe('md 存储：一个角色一个 md 文件，文件名 = 角色 ID', () => {
  it('save 落盘 <id>.md：角色围栏（id+name）+ 职责正文；ID 按名称确定性派生', async () => {
    const h = await makeStore()
    const duty = '第一行：拆解任务\n第二行：汇总结果'
    const saved = await h.store.save({ name: '主管', description: duty })
    expect(saved.id).toBe(deriveRoleId('主管'))
    const text = await readFile(join(h.rolesDir, `${saved.id}.md`), 'utf8')
    expect(text.startsWith(ROLE_FENCE_START)).toBe(true)
    expect(text).toContain(saved.id)
    expect(text).toContain('主管')
    expect(text.endsWith(duty)).toBe(true)
    expect((await h.store.read('主管')).description).toBe(duty)
    // 同名永远派生同一个 ID。
    expect(deriveRoleId('主管')).toBe(saved.id)
  })

  it('带 id 保存 = 原地更新（文件路径不变）；不带 id 且名字已占用 → INVALID_INPUT', async () => {
    const h = await makeStore()
    const first = await h.store.save({ name: '主管', description: '旧说明' })
    await expect(h.store.save({ name: '主管', description: '新说明' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const updated = await h.store.save({ id: first.id, name: '主管', description: '新说明' })
    expect(updated.id).toBe(first.id)
    expect((await h.store.read('主管')).description).toBe('新说明')
    expect(await h.store.list()).toHaveLength(1)
    expect((await readdir(h.rolesDir)).filter((n) => n.endsWith('.md'))).toEqual([`${first.id}.md`])
  })

  it('改名：ID 与文件路径不变，列表里不多出角色', async () => {
    const h = await makeStore()
    const first = await h.store.save({ name: '主管', description: '职责' })
    const renamed = await h.store.save({ id: first.id, name: '高级主管', description: '职责' })
    expect(renamed.id).toBe(first.id)
    expect(renamed.name).toBe('高级主管')
    const list = await h.store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(first.id)
    expect(list[0]!.name).toBe('高级主管')
    expect((await readdir(h.rolesDir)).filter((n) => n.endsWith('.md'))).toEqual([`${first.id}.md`])
  })

  it('手工直接改 md 文件（改正文），store 读得到（文件是唯一事实源）', async () => {
    const h = await makeStore()
    const saved = await h.store.save({ name: '评审员', description: '旧' })
    const path = join(h.rolesDir, `${saved.id}.md`)
    const original = await readFile(path, 'utf8')
    await writeFile(path, original.replace('旧', '手工改的职责'), 'utf8')
    expect((await h.store.read('评审员')).description).toBe('手工改的职责')
  })

  it('空 description 合法（职责为空，围栏仍在）', async () => {
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

  it('read 缺失 → NOT_FOUND；按 ID 也能读', async () => {
    const h = await makeStore()
    await expect(h.store.read('不存在')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const saved = await h.store.save({ name: '执行者', description: 'd' })
    expect((await h.store.read(saved.id)).name).toBe('执行者')
  })
})

describe('名称唯一（不静默产生两个同名角色）', () => {
  it('新建同名 → INVALID_INPUT，原角色不受影响', async () => {
    const h = await makeStore()
    await h.store.save({ name: '执行者', description: '第一个' })
    await expect(h.store.save({ name: '执行者', description: '第二个' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await h.store.read('执行者')).description).toBe('第一个')
    expect(await h.store.list()).toHaveLength(1)
  })

  it('改名撞上别的角色 → INVALID_INPUT，文件不动', async () => {
    const h = await makeStore()
    const a = await h.store.save({ name: '执行者', description: 'a' })
    await h.store.save({ name: '评审员', description: 'b' })
    await expect(h.store.save({ id: a.id, name: '评审员', description: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await h.store.read('执行者')).description).toBe('a')
    expect((await h.store.read('评审员')).description).toBe('b')
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
    // 原 json 文件保留（不删用户数据）；md 文件按 ID 命名。
    const names = await readdir(h.rolesDir)
    expect(names).toContain('a1b2c3d4-0001-4000-8000-000000000001.json')
    expect(names).toContain(`${deriveRoleId('旧角色')}.md`)
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
  it('空库种入全部预置角色（v3 共 15 个，主管已退役）；重复调用不增不改', async () => {
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
    const role = await h.store.read('执行者')
    await h.store.save({ id: role.id, name: '执行者', description: '用户改过的说明' })
    await seedPresetRoles(h.store)
    expect((await h.store.read('执行者')).description).toBe('用户改过的说明')
  })

  it('预置角色落为可手工编辑的 md 文件（文件名 = 角色 ID）', async () => {
    const h = await makeStore()
    await seedPresetRoles(h.store)
    const names = await readdir(h.rolesDir)
    expect(names).toContain(`${deriveRoleId('执行者')}.md`)
    expect(names).toContain(`${deriveRoleId('评审员')}.md`)
    expect(names).not.toContain('主管.md')
  })

  it('按名称找已有角色（不论 ID）：迁移过的预置角色不会被重复种入', async () => {
    const h = await makeStore()
    await h.store.save({ name: '执行者', description: '用户改过的说明' })
    const existing = await h.store.read('执行者')
    await seedPresetRoles(h.store)
    const after = await h.store.list()
    expect(after.filter((role) => role.name === '执行者')).toHaveLength(1)
    expect(after.find((role) => role.name === '执行者')!.id).toBe(existing.id)
    expect((await h.store.read('执行者')).description).toBe('用户改过的说明')
  })
})

describe('preset_roster_v2 — 专业角色扩容', () => {
  const EXPECTED_NAMES = [
    'Python程序员', 'Java程序员', '前端程序员', '交互设计师',
    '执行者', '调研员', '评审员',
    '架构设计工程师', '测试工程师', '部署运维工程师', '文档资料归档工程师',
    '需求与PRD工程师', 'PRD审核员', 'MR审核员', '代码评审员',
  ].sort()

  it('预置名单覆盖 15 个角色（v3：主管退役，Router 主会话直接担任主管），不多不少', () => {
    expect(PRESET_ROLE_TEMPLATES.map((r) => r.name).sort()).toEqual(EXPECTED_NAMES)
    expect(PRESET_ROLE_TEMPLATES.find((r) => r.name === '主管')).toBeUndefined()
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

  it('主管已退役并登记全部历史预置文本（v1 摘要 + v2/v3 全文），供种入时精确删除', () => {
    const texts = RETIRED_PRESET_ROLES['主管']
    expect(texts).toBeDefined()
    expect(texts!.length).toBeGreaterThanOrEqual(3)
    expect(texts!.some((t) => t.includes('把任务拆成可独立执行的分工'))).toBe(true)
    expect(texts!.some((t) => t.includes('按任务类型组织（八类）'))).toBe(true)
    expect(texts!.some((t) => t.includes('一律用 fork'))).toBe(true)
    // 八类任务的组织纪律没有丢：搬进了 Router 提示词（prompt.spec 断言）。
    expect(Object.keys(RETIRED_PRESET_ROLES)).toEqual(['主管'])
  })
})

describe('seed_upgrade — 历史预置文本的精确升级', () => {
  const OLD_EXECUTOR = '接受分工后独立完成具体工作（编码、修改、验证），自检通过后把结果与产物位置报告上级。'

  it('现有内容等于历史预置文本（用户未改过）时升级到最新', async () => {
    const h = await makeStore()
    await h.store.save({ name: '执行者', description: OLD_EXECUTOR })
    await seedPresetRoles(h.store)
    const latest = PRESET_ROLE_TEMPLATES.find((r) => r.name === '执行者')!.description
    expect(await h.store.read('执行者')).toMatchObject({ description: latest })
    expect(latest).not.toBe(OLD_EXECUTOR)
  })

  it('现有内容与任何历史文本都不一致（用户改过）时不动', async () => {
    const h = await makeStore()
    const custom = '我们组自己定义的执行者规则，与预置文本不同。'
    await h.store.save({ name: '执行者', description: custom })
    await seedPresetRoles(h.store)
    expect(await h.store.read('执行者')).toMatchObject({ description: custom })
  })

  it('已是最新文本时幂等（重复种入内容不变）', async () => {
    const h = await makeStore()
    await seedPresetRoles(h.store)
    const once = await h.store.read('执行者')
    await seedPresetRoles(h.store)
    expect(await h.store.read('执行者')).toEqual(once)
  })

  it('历史文本角色升级的同时，缺失的新角色被种入', async () => {
    const h = await makeStore()
    await h.store.save({ name: '执行者', description: OLD_EXECUTOR })
    await seedPresetRoles(h.store)
    const names = (await h.store.list()).map((r) => r.name)
    expect(names).toEqual(PRESET_ROLE_TEMPLATES.map((r) => r.name).sort())
  })
})

describe('seed_retire — 退役预置角色（主管）的精确删除', () => {
  it('磁盘内容等于任一版主管历史文本（用户没改过）→ 删除；三版都认', async () => {
    for (const text of RETIRED_PRESET_ROLES['主管']!) {
      const h = await makeStore()
      await h.store.save({ name: '主管', description: text })
      await seedPresetRoles(h.store)
      const names = (await h.store.list()).map((r) => r.name)
      expect(names).not.toContain('主管')
      expect(names).toEqual(PRESET_ROLE_TEMPLATES.map((r) => r.name).sort())
    }
  })

  it('主管被用户改过（与任何历史文本都不一致）→ 保留不删，其余预置照常种入', async () => {
    const h = await makeStore()
    const custom = '我们组自己定义的主管规则。'
    await h.store.save({ name: '主管', description: custom })
    await seedPresetRoles(h.store)
    expect((await h.store.read('主管')).description).toBe(custom)
    expect((await h.store.list()).map((r) => r.name).sort()).toEqual([...PRESET_ROLE_TEMPLATES.map((r) => r.name), '主管'].sort())
  })

  it('重复种入幂等：删过一次后再种不再报错', async () => {
    const h = await makeStore()
    await h.store.save({ name: '主管', description: RETIRED_PRESET_ROLES['主管']![0]! })
    await seedPresetRoles(h.store)
    await seedPresetRoles(h.store)
    expect((await h.store.list()).map((r) => r.name)).not.toContain('主管')
  })
})

describe('RoleStore.remove', () => {
  it('删除存在的角色返回 true；不存在返回 false；名字校验同 save', async () => {
    const h = await makeStore()
    await h.store.save({ name: '临时角色', description: 'x' })
    expect(await h.store.remove('临时角色')).toBe(true)
    expect(await h.store.remove('临时角色')).toBe(false)
    await expect(h.store.remove('../逃逸')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(h.store.remove('')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('一次性迁移：旧格式（文件名=角色名）→ ID 命名', () => {
  const LEGACY_TEXT = '职责正文\n<!-- dsh-router:models -->\n{"provider":"p","model":"m"}\n<!-- /dsh-router:models -->\n'

  async function seedLegacyFile(h: RoleHandle, name: string, text = LEGACY_TEXT): Promise<void> {
    await mkdir(h.rolesDir, { recursive: true })
    await writeFile(join(h.rolesDir, `${name}.md`), text, 'utf8')
  }

  it('旧文件迁成 <id>.md：正文与候选围栏逐字保留，旧文件删掉', async () => {
    const h = await makeStore()
    await seedLegacyFile(h, '旧角色')
    const report = await h.store.migrateToIds()
    expect(report.migrated).toBe(1)
    expect(report.removed).toBe(0)
    const id = deriveRoleId('旧角色')
    const names = await readdir(h.rolesDir)
    expect(names).toContain(`${id}.md`)
    expect(names).not.toContain('旧角色.md')
    // 文件内容 = 角色围栏 + 原文件字节（逐字保留）。
    const text = await readFile(join(h.rolesDir, `${id}.md`), 'utf8')
    expect(text.startsWith(ROLE_FENCE_START)).toBe(true)
    expect(text.endsWith(LEGACY_TEXT)).toBe(true)
    const role = await h.store.read('旧角色')
    expect(role.id).toBe(id)
    expect(role.name).toBe('旧角色')
    expect(role.description).toBe('职责正文\n')
    expect(role.models).toEqual([{ provider: 'p', model: 'm' }])
  })

  it('幂等：再跑一次没有改动，也没有重复角色', async () => {
    const h = await makeStore()
    await seedLegacyFile(h, '旧角色')
    await h.store.migrateToIds()
    const before = await readdir(h.rolesDir)
    const report = await h.store.migrateToIds()
    expect(report.migrated).toBe(0)
    expect(report.removed).toBe(0)
    expect(await readdir(h.rolesDir)).toEqual(before)
    expect(await h.store.list()).toHaveLength(1)
  })

  it('迁移残留（写新文件后崩溃）：旧文件被清掉，不产生重复角色', async () => {
    const h = await makeStore()
    // 新格式文件已经在（上次迁移写完没删旧文件就崩了），旧文件还在。
    await h.store.save({ name: '旧角色', description: '职责正文' })
    await seedLegacyFile(h, '旧角色', '职责正文\n')
    const report = await h.store.migrateToIds()
    expect(report.removed).toBe(1)
    expect(report.migrated).toBe(0)
    const names = await readdir(h.rolesDir)
    expect(names).not.toContain('旧角色.md')
    expect(names.filter((name) => name.endsWith('.md'))).toHaveLength(1)
    const list = await h.store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('旧角色')
  })

  it('迁移前把 roles 目录整体备份到 roles.bak-<时间戳>/（只备一次）', async () => {
    const h = await makeStore()
    await seedLegacyFile(h, '旧角色')
    const report = await h.store.migrateToIds()
    expect(report.backupPath).toBeDefined()
    const backupPath = report.backupPath!
    expect(backupPath).toContain('roles.bak-')
    // 备份里有迁移前的旧文件（原样）。
    expect(await readdir(backupPath)).toContain('旧角色.md')
    expect(await readFile(join(backupPath, '旧角色.md'), 'utf8')).toBe(LEGACY_TEXT)
    // 再跑一次不会新建备份目录。
    const second = await h.store.migrateToIds()
    expect(second.backupPath).toBeUndefined()
    const backups = (await readdir(join(h.dir, 'collaboration'))).filter((name) => name.startsWith('roles.bak-'))
    expect(backups).toHaveLength(1)
  })

  it('已经是新格式的文件不动（迁移只处理旧格式）', async () => {
    const h = await makeStore()
    const saved = await h.store.save({ name: '执行者', description: '职责' })
    const before = await readFile(join(h.rolesDir, `${saved.id}.md`), 'utf8')
    const report = await h.store.migrateToIds()
    expect(report.migrated).toBe(0)
    expect(await readFile(join(h.rolesDir, `${saved.id}.md`), 'utf8')).toBe(before)
  })

  it('迁移后预置角色不重复：按名称找到已有角色（含迁过来的）就不再种一个', async () => {
    const h = await makeStore()
    await seedLegacyFile(h, '执行者', '旧职责\n')
    await h.store.migrateToIds()
    await seedPresetRoles(h.store)
    const list = await h.store.list()
    expect(list.filter((role) => role.name === '执行者')).toHaveLength(1)
  })
})
