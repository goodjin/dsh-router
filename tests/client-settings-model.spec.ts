/**
 * 设置管理表单纯逻辑测试（v1.1 计划 Task C3：校验/归一化/reducer，先红后绿）。
 *
 * 五个简报指定用例 + reducer 往返：
 * 1. 必填校验：name 与 systemPrompt 必填（与 C2 工具入参口径一致）；
 * 2. 模型去重排序：trim、去空、保序去重（首个为默认模型，顺序即优先级）；
 * 3. 角色默认 worker；
 * 4. builtin 保护：不可编辑/不可删除/不可禁用（reducer 层再拦一道）；
 * 5. 脏表单提示：有未保存更改时取消先出确认，二次才放弃。
 */

import { describe, expect, it } from 'vitest'

import {
  canDisableRecord,
  canEditRecord,
  dedupeOrdered,
  editingIsDirty,
  emptyTypeForm,
  initialTypeManageState,
  isFormDirty,
  modelCatalogOf,
  normalizeTypeForm,
  originLabel,
  skillCatalogOf,
  typeFormFromRecord,
  typeManageReducer,
  validateTypeForm,
  type TypeManageState,
  type TypeFormState,
} from '../src/client/settings-model.ts'
import type { WorkerTypeRecord } from '../src/shared/view-contract.ts'

let seq = 0
function record(overrides: Partial<WorkerTypeRecord> = {}): WorkerTypeRecord {
  seq += 1
  const at = 1000 + seq
  return {
    templateId: `t-${seq}`,
    name: `类型${seq}`,
    description: '',
    role: 'worker',
    models: [],
    systemPrompt: '提示词',
    skills: [],
    enabled: true,
    origin: 'user',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

describe('必填校验（validateTypeForm）', () => {
  it('空表单：name 与 systemPrompt 都报必填', () => {
    const problems = validateTypeForm(emptyTypeForm())
    expect(problems['name']).toBeTruthy()
    expect(problems['systemPrompt']).toBeTruthy()
  })

  it('纯空白的 name 视同缺；填齐后无问题', () => {
    const blank = validateTypeForm({ ...emptyTypeForm(), name: '   ', systemPrompt: '提示词' })
    expect(blank['name']).toBeTruthy()
    expect(blank['systemPrompt']).toBeNull()
    const ok = validateTypeForm({ ...emptyTypeForm(), name: '写手', systemPrompt: '提示词' })
    expect(ok['name']).toBeNull()
    expect(ok['systemPrompt']).toBeNull()
  })

  it('空 name 的 systemPrompt 缺失时只报各自字段', () => {
    const problems = validateTypeForm({ ...emptyTypeForm(), systemPrompt: '' })
    expect(problems['name']).toBeTruthy()
    expect(problems['systemPrompt']).toBeTruthy()
  })
})

describe('模型去重排序（dedupeOrdered / normalizeTypeForm）', () => {
  it('trim、去空串、保第一次出现的顺序去重', () => {
    expect(dedupeOrdered(['b/a', ' a/b ', '', 'b/a', 'c/d', 'a/b'])).toEqual(['b/a', 'a/b', 'c/d'])
    expect(dedupeOrdered([])).toEqual([])
  })

  it('normalizeTypeForm：models/skills 归一化，文本字段 trim，输出可作 create/update 请求体', () => {
    const form: TypeFormState = {
      templateId: null,
      name: '  写手  ',
      description: ' 描述 ',
      role: 'worker',
      models: ['p/b', 'p/a', '', 'p/b'],
      systemPrompt: ' 提示词 ',
      skills: ['skill-a', ' skill-b ', 'skill-a'],
      enabled: true,
    }
    const normalized = normalizeTypeForm(form)
    expect(normalized).toEqual({
      name: '写手',
      description: '描述',
      role: 'worker',
      models: ['p/b', 'p/a'],
      systemPrompt: '提示词',
      skills: ['skill-a', 'skill-b'],
      enabled: true,
    })
  })
})

describe('角色默认 worker（emptyTypeForm）', () => {
  it('新建表单角色默认 worker、启用默认 true、其余空', () => {
    const form = emptyTypeForm()
    expect(form.role).toBe('worker')
    expect(form.enabled).toBe(true)
    expect(form.templateId).toBeNull()
    expect(form.name).toBe('')
    expect(form.models).toEqual([])
    expect(form.skills).toEqual([])
  })

  it('record → 表单往返：字段一一对应', () => {
    const source = record({ name: '调研', role: 'supervisor', models: ['p/m'], skills: ['s1'], enabled: false, origin: 'router' })
    const form = typeFormFromRecord(source)
    expect(form).toEqual({
      templateId: source.templateId,
      name: '调研',
      description: '',
      role: 'supervisor',
      models: ['p/m'],
      systemPrompt: '提示词',
      skills: ['s1'],
      enabled: false,
    })
  })
})

describe('builtin 保护', () => {
  it('canEditRecord/canRemoveRecord/canDisableRecord：builtin 全 false，其余 true', () => {
    const builtin = record({ origin: 'builtin' })
    const user = record({ origin: 'user' })
    const router = record({ origin: 'router' })
    expect(canEditRecord(builtin)).toBe(false)
    expect(canDisableRecord(builtin)).toBe(false)
    expect(canEditRecord(user)).toBe(true)
    expect(canEditRecord(router)).toBe(true)
  })

  it('reducer：对 builtin 发 edit-form/remove-arm 被拒，只出提示，不开表单不待删', () => {
    const builtin = record({ origin: 'builtin', templateId: 'general' })
    const seeded: TypeManageState = { ...initialTypeManageState(), types: [builtin] }
    const edited = typeManageReducer(seeded, { type: 'edit-form', record: builtin })
    expect(edited.editing).toBeNull()
    expect(edited.notice).toContain('内置')
    const armed = typeManageReducer(edited, { type: 'notice-cleared' })
    const afterArm = typeManageReducer(armed, { type: 'remove-arm', templateId: 'general' })
    expect(afterArm.armedRemove).toBeNull()
    expect(afterArm.notice).toContain('内置')
  })
})

describe('脏表单提示（isFormDirty / reducer form-cancel）', () => {
  it('未改动 = 不脏；任何字段改动 = 脏（models 顺序也计入）', () => {
    const baseline = typeFormFromRecord(record({ name: '写手', models: ['p/a', 'p/b'] }))
    expect(isFormDirty(baseline, baseline)).toBe(false)
    expect(isFormDirty({ ...baseline, name: '改' }, baseline)).toBe(true)
    expect(isFormDirty({ ...baseline, models: ['p/b', 'p/a'] }, baseline)).toBe(true)
    expect(isFormDirty({ ...baseline, description: '补一句' }, baseline)).toBe(true)
  })

  it('干净的表单一次取消即关；脏表单第一次取消只出确认提示，第二次（确认后）才放弃', () => {
    const recordRow = record({ name: '写手' })
    const seeded: TypeManageState = { ...initialTypeManageState(), types: [recordRow] }
    const opened = typeManageReducer(seeded, { type: 'edit-form', record: recordRow })
    expect(opened.editing).not.toBeNull()

    const cleanCancel = typeManageReducer(opened, { type: 'form-cancel' })
    expect(cleanCancel.editing).toBeNull()

    const dirtied = typeManageReducer(opened, { type: 'form-change', patch: { name: '改名' } })
    expect(editingIsDirty(dirtied)).toBe(true)
    const armed = typeManageReducer(dirtied, { type: 'form-cancel' })
    expect(armed.editing).not.toBeNull()
    expect(armed.confirmDiscard).toBe(true)
    const discarded = typeManageReducer(armed, { type: 'form-discard' })
    expect(discarded.editing).toBeNull()
    expect(discarded.confirmDiscard).toBe(false)
  })

  it('继续编辑（form-change）清掉放弃确认', () => {
    const recordRow = record({ name: '写手' })
    const seeded: TypeManageState = { ...initialTypeManageState(), types: [recordRow] }
    const dirtied = typeManageReducer(
      typeManageReducer(seeded, { type: 'edit-form', record: recordRow }),
      { type: 'form-change', patch: { name: '改名' } },
    )
    const armed = typeManageReducer(dirtied, { type: 'form-cancel' })
    expect(armed.confirmDiscard).toBe(true)
    const resumed = typeManageReducer(armed, { type: 'form-change', patch: { name: '再改' } })
    expect(resumed.confirmDiscard).toBe(false)
    expect(resumed.editing).not.toBeNull()
  })
})

describe('候选清单（modelCatalogOf / skillCatalogOf）与来源标记', () => {
  it('跨类型取并集并去重保序', () => {
    const types = [
      record({ models: ['p/a', 'p/b'], skills: ['s1', 's2'] }),
      record({ models: ['p/b', 'p/c'], skills: ['s2', 's3'] }),
    ]
    expect(modelCatalogOf(types)).toEqual(['p/a', 'p/b', 'p/c'])
    expect(skillCatalogOf(types)).toEqual(['s1', 's2', 's3'])
  })

  it('originLabel：router=Router 创建、user=手动、builtin=内置', () => {
    expect(originLabel('router')).toBe('Router 创建')
    expect(originLabel('user')).toBe('手动')
    expect(originLabel('builtin')).toBe('内置')
  })
})

describe('reducer 往返（保存/启停/删除/加载/默认值）', () => {
  it('loaded 置数据与 loaded 标记；load-failed 记错误不炸', () => {
    const rows = [record()]
    const loaded = typeManageReducer(initialTypeManageState(), {
      type: 'loaded',
      types: rows,
      defaults: { routerSystemPrompt: 'd', routerModel: '' },
    })
    expect(loaded.loaded).toBe(true)
    expect(loaded.types).toEqual(rows)
    expect(loaded.defaults).toEqual({ routerSystemPrompt: 'd', routerModel: '' })
    const failed = typeManageReducer(initialTypeManageState(), { type: 'load-failed', message: '网络错' })
    expect(failed.loaded).toBe(true) // 加载动作已完成（失败也是完成态），错误看 loadError
    expect(failed.loadError).toBe('网络错')
  })

  it('save-done：新建进列表、编辑替换原行并关表单', () => {
    const row = record({ templateId: 't-1', name: '旧名' })
    const seeded: TypeManageState = { ...initialTypeManageState(), types: [row] }
    const opened = typeManageReducer(seeded, { type: 'new-form' })
    const typing = typeManageReducer(opened, { type: 'form-change', patch: { name: '新类型' } })
    const created = typeManageReducer(typing, {
      type: 'save-done',
      record: record({ templateId: 't-9', name: '新类型' }),
    })
    expect(created.types.some((entry) => entry.templateId === 't-9')).toBe(true)
    expect(created.editing).toBeNull()
    expect(created.error).toBeNull()

    const editOpened = typeManageReducer(created, { type: 'edit-form', record: created.types[0]! })
    const renamed = typeManageReducer(editOpened, { type: 'form-change', patch: { name: '新名' } })
    const saved = typeManageReducer(renamed, {
      type: 'save-done',
      record: { ...created.types[0]!, name: '新名' },
    })
    expect(saved.types.find((entry) => entry.templateId === created.types[0]!.templateId)?.name).toBe('新名')
    expect(saved.types).toHaveLength(2) // 改名替换 t-1，另一行 t-9 不受影响
  })

  it('toggle-done 替换行；remove-done 移除行并撤待删', () => {
    const row = record({ templateId: 't-1' })
    const seeded: TypeManageState = { ...initialTypeManageState(), types: [row] }
    const toggled = typeManageReducer(seeded, { type: 'toggle-done', record: { ...row, enabled: false } })
    expect(toggled.types[0]!.enabled).toBe(false)
    const armed = typeManageReducer(toggled, { type: 'remove-arm', templateId: 't-1' })
    expect(armed.armedRemove).toBe('t-1')
    const removed = typeManageReducer(armed, { type: 'remove-done', templateId: 't-1' })
    expect(removed.types).toEqual([])
    expect(removed.armedRemove).toBeNull()
  })

  it('op-failed 记错误且不关表单（保存失败留在表单里改）', () => {
    const row = record({ templateId: 't-1' })
    const seeded: TypeManageState = { ...initialTypeManageState(), types: [row] }
    const opened = typeManageReducer(seeded, { type: 'edit-form', record: row })
    const failed = typeManageReducer(opened, { type: 'op-failed', message: '同名类型已存在' })
    expect(failed.error).toBe('同名类型已存在')
    expect(failed.editing).not.toBeNull()
  })

  it('defaults 草稿：改草稿置脏；save-done 落库清脏；defaults-reset 回已存值', () => {
    const loaded = typeManageReducer(initialTypeManageState(), {
      type: 'loaded',
      types: [],
      defaults: { routerSystemPrompt: 'd', routerModel: '' },
    })
    const drafting = typeManageReducer(loaded, { type: 'defaults-draft', patch: { routerModel: 'p/m' } })
    expect(drafting.defaultsDraft).toEqual({ routerSystemPrompt: 'd', routerModel: 'p/m' })
    expect(drafting.defaultsDirty).toBe(true)
    const saved = typeManageReducer(drafting, {
      type: 'defaults-save-done',
      defaults: { routerSystemPrompt: 'd', routerModel: 'p/m' },
    })
    expect(saved.defaults).toEqual({ routerSystemPrompt: 'd', routerModel: 'p/m' })
    expect(saved.defaultsDirty).toBe(false)
    expect(saved.defaultsDraft).toEqual({ routerSystemPrompt: 'd', routerModel: 'p/m' })
    const reset = typeManageReducer(saved, { type: 'defaults-reset' })
    expect(reset.defaultsDraft).toEqual({ routerSystemPrompt: 'd', routerModel: 'p/m' })
  })
})
