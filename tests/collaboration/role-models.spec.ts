/**
 * 角色 md 文末候选围栏：字节、往返、坏围栏、保存保留/清空，以及有围栏时不参与预置升级。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { buildCollaborationContext } from '../../src/collaboration/context.ts'
import { composeDispatchInstruction } from '../../src/collaboration/dispatch.ts'
import { HISTORICAL_PRESET_DESCRIPTIONS, PRESET_ROLE_TEMPLATES, RETIRED_PRESET_ROLES } from '../../src/collaboration/preset-roles.ts'
import { parseRoleDocument, pickRotationStart, resolveDispatchSequence, serializeRoleFile } from '../../src/collaboration/role-models.ts'
import { createRoleStore, seedPresetRoles } from '../../src/collaboration/roles.ts'
import type { RoleStore, RoleTemplate } from '../../src/collaboration/types.ts'
import { makeCollabFs } from './collab-test-fs.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeStore(): Promise<{ store: RoleStore; rolesDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'router-role-models-'))
  roots.push(dir)
  const store = createRoleStore(dir, { fs: makeCollabFs().fs })
  return { store, rolesDir: join(dir, 'collaboration', 'roles') }
}

const START = '<!-- dsh-router:models -->'
const END = '<!-- /dsh-router:models -->'

describe('role models fence', () => {
  it('无围栏：description 等于文件字节，models 缺省；无候选的 save 不写标记', async () => {
    const { store, rolesDir } = await makeStore()
    const duty = '第一行\n第二行'
    const saved = await store.save({ name: '执行者', description: duty })
    const text = await readFile(join(rolesDir, '执行者.md'), 'utf8')
    expect(text).toBe(duty)
    expect(saved.description).toBe(duty)
    expect(saved.models).toBeUndefined()
    const read = await store.read('执行者')
    expect(read.description).toBe(duty)
    expect(read.models).toBeUndefined()
    expect(text).not.toContain('dsh-router:models')
  })

  it('有围栏：职责切片不含标记和 JSON，往返稳定，存 trim 后的值', async () => {
    const { store, rolesDir } = await makeStore()
    await store.save({
      name: '执行者',
      description: '职责正文',
      models: [{ provider: ' deepseek ', model: ' deepseek-chat ' }],
    })
    const text = await readFile(join(rolesDir, '执行者.md'), 'utf8')
    const parsed = parseRoleDocument('执行者', text)
    expect(parsed.description).toBe('职责正文\n')
    expect(parsed.description).not.toContain('dsh-router:models')
    expect(parsed.description).not.toContain('deepseek')
    expect(parsed.models).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
    expect(serializeRoleFile(parsed.description, parsed.models)).toBe(text)
    const again = await store.save({ name: '执行者', description: parsed.description, models: parsed.models })
    expect(await readFile(join(rolesDir, '执行者.md'), 'utf8')).toBe(text)
    expect(again.models).toEqual(parsed.models)
  })

  it('坏围栏在 read 与 save 都是 INVALID_INPUT，失败的 save 不改原文件', async () => {
    const { store, rolesDir } = await makeStore()
    await store.save({ name: '执行者', description: '原职责', models: [{ provider: 'p', model: 'm' }] })
    const before = await readFile(join(rolesDir, '执行者.md'), 'utf8')
    const broken = [
      `${before}尾部`,
      '职责\n<!-- dsh-router:models -->\n{',
      '职责\n<!-- dsh-router:models -->\n{"provider":"p"}\n<!-- /dsh-router:models -->\n',
      '职责\n<!-- dsh-router:models -->\n{"provider":" ","model":"m"}\n<!-- /dsh-router:models -->\n',
      '职责\n<!-- dsh-router:models -->\n{"provider":"p","model":"m","extra":1}\n<!-- /dsh-router:models -->\n',
      '职责\n<!-- dsh-router:models -->\n[]\n<!-- /dsh-router:models -->\n',
      '职责\n<!-- dsh-router:models -->\n{"provider":"p","model":"m"}\n<!-- /dsh-router:models -->\n多余\n',
    ]
    for (const text of broken) {
      await writeFile(join(rolesDir, '执行者.md'), text, 'utf8')
      await expect(store.read('执行者')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(store.read('执行者')).rejects.toThrow(/执行者/)
    }
    await writeFile(join(rolesDir, '执行者.md'), before, 'utf8')
    for (const models of [null, 'x', [{ provider: 'p' }], [{ provider: ' ', model: 'm' }], [{ provider: 'p', model: 'm', extra: 1 }]]) {
      await expect(store.save({ name: '执行者', description: '改了', models })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(await readFile(join(rolesDir, '执行者.md'), 'utf8')).toBe(before)
    }
  })

  it('形状合法但不在清单里的 id 可以保存；存储不去重', async () => {
    const { store } = await makeStore()
    const models = [
      { provider: 'not-registered', model: 'no-such' },
      { provider: 'not-registered', model: 'no-such' },
    ]
    const saved = await store.save({ name: '执行者', description: '职责', models })
    expect(saved.models).toEqual(models)
    expect((await store.read('执行者')).models).toEqual(models)
  })

  it('models 缺省保留旧候选；models: [] 清空且文件不再含标记', async () => {
    const { store, rolesDir } = await makeStore()
    await store.save({ name: '执行者', description: '旧', models: [{ provider: 'p', model: 'm' }] })
    const kept = await store.save({ name: '执行者', description: '新职责' })
    expect(kept.models).toEqual([{ provider: 'p', model: 'm' }])
    expect(kept.description).not.toContain('dsh-router:models')
    const cleared = await store.save({ name: '执行者', description: '只剩职责', models: [] })
    expect(cleared.models).toBeUndefined()
    const text = await readFile(join(rolesDir, '执行者.md'), 'utf8')
    expect(text).toBe('只剩职责')
    expect(text).not.toContain(START)
    expect(text).not.toContain(END)
  })

  it('一个坏围栏会让 list 整份失败', async () => {
    const { store, rolesDir } = await makeStore()
    await store.save({ name: '完好', description: '职责' })
    await writeFile(join(rolesDir, '损坏.md'), `职责\n${START}\n{\n`, 'utf8')
    await expect(store.list()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('解析后的 description 进的是上下文与职责段，指令里只有任务；都不含标记与 provider', () => {
    const text = `职责首行\n\n详细正文\n${START}\n{"provider":"deepseek","model":"deepseek-chat"}\n${END}\n`
    const parsed = parseRoleDocument('执行者', text)
    const instruction = composeDispatchInstruction({
      task: '改造登录',
      taskId: 'task-1',
      rootSessionId: 'root-1',
    })
    const context = buildCollaborationContext({
      sessionId: 'session-1',
      dataDir: '/tmp/router-role-models',
      roles: [{ name: '执行者', description: parsed.description }],
      duty: { roleName: '执行者', description: parsed.description },
    })
    expect(instruction).not.toContain('职责首行')
    expect(instruction).not.toContain('dsh-router:models')
    expect(instruction).not.toContain('deepseek')
    expect(context).toContain('职责首行')
    expect(context).not.toContain('dsh-router:models')
    expect(context).not.toContain('deepseek')
    // 职责段标明是「你的角色与职责」，并带上角色名。
    expect(context).toContain('你的角色与职责')
    expect(context).toContain('执行者')
  })
})

describe('seedPresetRoles 与围栏', () => {
  it('description 精确等于历史文本且带候选时不升级、不删除', async () => {
    const historical = HISTORICAL_PRESET_DESCRIPTIONS['执行者']![0]!
    const retired = RETIRED_PRESET_ROLES['主管']![0]!
    const saved: Array<{ name: string; description: string; models?: unknown }> = []
    const removed: string[] = []
    const roles: RoleTemplate[] = [
      { name: '执行者', description: historical, models: [{ provider: 'p', model: 'm' }] },
      { name: '主管', description: retired, models: [] },
    ]
    const store: Pick<RoleStore, 'list' | 'save' | 'remove'> = {
      list: async () => roles,
      save: async (input) => {
        saved.push(input)
        return { name: input.name, description: input.description }
      },
      remove: async (name) => {
        removed.push(name)
        return true
      },
    }
    await seedPresetRoles(store)
    expect(saved.map((input) => input.name)).not.toContain('执行者')
    expect(removed).not.toContain('主管')
    expect(removed).toEqual([])
  })

  it('无围栏且等于历史文本仍升级，写出的文件没有围栏', async () => {
    const { store, rolesDir } = await makeStore()
    const historical = HISTORICAL_PRESET_DESCRIPTIONS['执行者']![0]!
    await store.save({ name: '执行者', description: historical })
    await seedPresetRoles(store)
    const latest = PRESET_ROLE_TEMPLATES.find((role) => role.name === '执行者')!.description
    const text = await readFile(join(rolesDir, '执行者.md'), 'utf8')
    expect(text).toBe(latest)
    expect(text).not.toContain('dsh-router:models')
    expect((await store.read('执行者')).models).toBeUndefined()
  })

  it('用户改过的职责仍不覆盖', async () => {
    const custom = '我们组自己的执行者，不是预置。'
    const saved: string[] = []
    const store: Pick<RoleStore, 'list' | 'save' | 'remove'> = {
      list: async () => [{ name: '执行者', description: custom }],
      save: async (input) => {
        saved.push(input.name)
        return { name: input.name, description: input.description }
      },
      remove: async () => false,
    }
    await seedPresetRoles(store)
    expect(saved).not.toContain('执行者')
  })
})

describe('派发候选序列：随机起点 + 环绕轮转', () => {
  const FIVE = [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' },
    { provider: 'p3', model: 'm3' },
    { provider: 'p4', model: 'm4' },
    { provider: 'p5', model: 'm5' },
  ]

  it('随机起点决定轮转顺序：起点 k → [k, k+1, …, 末尾, 1, …, k-1]', () => {
    // k = floor(0.4 * 5) = 2 → 第三项起步，到末尾后绕回第一、二项。
    expect(resolveDispatchSequence(FIVE, () => 0.4)).toEqual([
      { provider: 'p3', model: 'm3' },
      { provider: 'p4', model: 'm4' },
      { provider: 'p5', model: 'm5' },
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ])
    // k = 0 → 与原顺序相同。
    expect(resolveDispatchSequence(FIVE, () => 0)).toEqual(FIVE)
    // k = 4 → 最后一项起步，其余顺次绕到前面。
    expect(resolveDispatchSequence(FIVE, () => 0.99)).toEqual([
      { provider: 'p5', model: 'm5' },
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
      { provider: 'p3', model: 'm3' },
      { provider: 'p4', model: 'm4' },
    ])
  })

  it('每一种起点都得到同一集合的轮转：顺序各不相同，长度与成员不变', () => {
    const seen = new Set<string>()
    for (let k = 0; k < FIVE.length; k++) {
      // 固定随机源精确落在第 k 格：floor((k + 0.5) / 5 * 5) = k
      const rotated = resolveDispatchSequence(FIVE, () => (k + 0.5) / FIVE.length)
      expect(rotated).toHaveLength(FIVE.length)
      expect([...rotated].sort((a, b) => a.model.localeCompare(b.model))).toEqual([...FIVE].sort((a, b) => a.model.localeCompare(b.model)))
      expect(rotated[0]!.model).toBe(`m${k + 1}`)
      expect(rotated[rotated.length - 1]!.model).toBe(`m${k === 0 ? FIVE.length : k}`)
      seen.add(rotated.map((item) => item.model).join(','))
    }
    expect(seen.size).toBe(FIVE.length)
  })

  it('候选只有一个时序列不变；没有候选时是空序列', () => {
    const one = [{ provider: 'p', model: 'm' }]
    expect(resolveDispatchSequence(one, () => 0.7)).toEqual(one)
    expect(resolveDispatchSequence(undefined, () => 0.7)).toEqual([])
    expect(resolveDispatchSequence([], () => 0.7)).toEqual([])
  })

  it('去重语义不变（先出现者保留），去重后再轮转', () => {
    const models = [
      { provider: 'p', model: 'm1' },
      { provider: 'p', model: 'm2' },
      { provider: 'p', model: 'm1' },
      { provider: 'p', model: 'm3' },
    ]
    // 去重后是 [m1, m2, m3]；k = floor(0.5 * 3) = 1 → [m2, m3, m1]
    expect(resolveDispatchSequence(models, () => 0.5)).toEqual([
      { provider: 'p', model: 'm2' },
      { provider: 'p', model: 'm3' },
      { provider: 'p', model: 'm1' },
    ])
  })

  it('随机源坏值（NaN、越界、抛错）不让派发失败：退回起点 0 或夹到末尾', () => {
    expect(resolveDispatchSequence(FIVE, () => Number.NaN)).toEqual(FIVE)
    expect(resolveDispatchSequence(FIVE, () => 1)).toEqual([
      { provider: 'p5', model: 'm5' },
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
      { provider: 'p3', model: 'm3' },
      { provider: 'p4', model: 'm4' },
    ])
    expect(resolveDispatchSequence(FIVE, () => -1)).toEqual(FIVE)
    expect(resolveDispatchSequence(FIVE, () => { throw new Error('随机源坏了') })).toEqual(FIVE)
    expect(pickRotationStart(5, () => 0.4)).toBe(2)
    expect(pickRotationStart(1, () => 0.9)).toBe(0)
    expect(pickRotationStart(0, () => 0.9)).toBe(0)
  })
})
