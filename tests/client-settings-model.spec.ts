/**
 * 设置管理表单纯逻辑测试（2026-11-10 设置页收敛后：新建-only 表单、无技能、
 * 无编辑、无 Router 默认区）。
 *
 * 用例 + reducer 往返：
 * 1. 必填校验：name 必填（提示词由宿主按角色默认，表单不收不发）；
 * 2. 模型去重排序：trim、去空、保序去重（首个为默认模型，顺序即优先级）；
 * 3. 角色默认 worker；
 * 4. builtin 保护：不可删除/不可禁用（reducer 层再拦一道）；
 * 5. 脏表单提示：有未保存更改时取消先出确认，二次才放弃。
 */

import { describe, expect, it } from 'vitest'

import {
  SPAWN_MODE_MODEL_HINT,
  canDisableRecord,
  canRemoveRecord,
  dedupeOrdered,
  editingIsDirty,
  emptyTypeForm,
  initialTypeManageState,
  isFormDirty,
  modelCatalogOf,
  normalizeTypeForm,
  originLabel,
  spawnModeDescription,
  spawnModeLabel,
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
  it('空表单：name 报必填（提示词 UI 移除后不再校验提示词）', () => {
    const problems = validateTypeForm(emptyTypeForm())
    expect(problems['name']).toBeTruthy()
    expect('systemPrompt' in problems).toBe(false)
  })

  it('纯空白的 name 视同缺；填了 name 即无问题', () => {
    const blank = validateTypeForm({ ...emptyTypeForm(), name: '   ' })
    expect(blank['name']).toBeTruthy()
    const ok = validateTypeForm({ ...emptyTypeForm(), name: '写手' })
    expect(ok['name']).toBeNull()
  })
})

describe('模型去重排序（dedupeOrdered / normalizeTypeForm）', () => {
  it('trim、去空串、保第一次出现的顺序去重', () => {
    expect(dedupeOrdered(['b/a', ' a/b ', '', 'b/a', 'c/d', 'a/b'])).toEqual(['b/a', 'a/b', 'c/d'])
    expect(dedupeOrdered([])).toEqual([])
  })

  it('normalizeTypeForm：models 归一化，文本字段 trim，输出可作 create 请求体（不带 systemPrompt/skills 键）', () => {
    const form: TypeFormState = {
      templateId: null,
      name: '  写手  ',
      description: ' 描述 ',
      role: 'worker',
      models: ['p/b', 'p/a', '', 'p/b'],
      enabled: true,
    }
    const normalized = normalizeTypeForm(form)
    expect(normalized).toEqual({
      name: '写手',
      description: '描述',
      role: 'worker',
      models: ['p/b', 'p/a'],
      enabled: true,
    })
    // 新建类型不需要提示词：归一化输出不得带 systemPrompt 键（尤其不能是空串——
    // 宿主 ?? 只挡 nullish，空串会盖掉按角色默认）；技能已整体移除，也不得带。
    expect('systemPrompt' in normalized).toBe(false)
    expect('skills' in normalized).toBe(false)
  })
})

describe('角色默认 worker（emptyTypeForm）', () => {
  it('新建表单角色默认 worker、启用默认 true、其余空；表单无 skills 字段', () => {
    const form = emptyTypeForm()
    expect(form.role).toBe('worker')
    expect(form.enabled).toBe(true)
    expect(form.templateId).toBeNull()
    expect(form.name).toBe('')
    expect(form.models).toEqual([])
    expect('skills' in form).toBe(false)
  })
})

describe('builtin 保护', () => {
  it('canRemoveRecord/canDisableRecord：builtin 全 false，其余 true', () => {
    const builtin = record({ origin: 'builtin' })
    const user = record({ origin: 'user' })
    const router = record({ origin: 'router' })
    expect(canRemoveRecord(builtin)).toBe(false)
    expect(canDisableRecord(builtin)).toBe(false)
    expect(canRemoveRecord(user)).toBe(true)
    expect(canRemoveRecord(router)).toBe(true)
  })

  it('reducer：对 builtin 发 remove-arm 被拒，只出提示，不待删', () => {
    const builtin = record({ origin: 'builtin', templateId: 'general' })
    const seeded: TypeManageState = { ...initialTypeManageState(), types: [builtin] }
    const afterArm = typeManageReducer(seeded, { type: 'remove-arm', templateId: 'general' })
    expect(afterArm.armedRemove).toBeNull()
    expect(afterArm.notice).toContain('内置')
  })
})

describe('脏表单提示（isFormDirty / reducer form-cancel）', () => {
  it('未改动 = 不脏；任何字段改动 = 脏（models 顺序也计入）', () => {
    const baseline = emptyTypeForm()
    expect(isFormDirty(baseline, baseline)).toBe(false)
    expect(isFormDirty({ ...baseline, name: '改' }, baseline)).toBe(true)
    expect(isFormDirty({ ...baseline, models: ['p/b', 'p/a'] }, baseline)).toBe(true)
    expect(isFormDirty({ ...baseline, description: '补一句' }, baseline)).toBe(true)
  })

  it('干净的新建表单一次取消即关；脏表单第一次取消只出确认提示，第二次（确认后）才放弃', () => {
    const seeded: TypeManageState = { ...initialTypeManageState(), types: [record()] }
    const opened = typeManageReducer(seeded, { type: 'new-form' })
    expect(opened.editing).not.toBeNull()

    const dirtied = typeManageReducer(opened, { type: 'form-change', patch: { name: '新类型' } })
    expect(editingIsDirty(dirtied)).toBe(true)
    const armed = typeManageReducer(dirtied, { type: 'form-cancel' })
    expect(armed.editing).not.toBeNull()
    expect(armed.confirmDiscard).toBe(true)
    const discarded = typeManageReducer(armed, { type: 'form-discard' })
    expect(discarded.editing).toBeNull()
    expect(discarded.confirmDiscard).toBe(false)

    const cleanCancel = typeManageReducer(typeManageReducer(seeded, { type: 'new-form' }), { type: 'form-cancel' })
    expect(cleanCancel.editing).toBeNull()
  })

  it('继续编辑（form-change）清掉放弃确认', () => {
    const seeded: TypeManageState = { ...initialTypeManageState(), types: [record()] }
    const dirtied = typeManageReducer(
      typeManageReducer(seeded, { type: 'new-form' }),
      { type: 'form-change', patch: { name: '改名' } },
    )
    const armed = typeManageReducer(dirtied, { type: 'form-cancel' })
    expect(armed.confirmDiscard).toBe(true)
    const resumed = typeManageReducer(armed, { type: 'form-change', patch: { name: '再改' } })
    expect(resumed.confirmDiscard).toBe(false)
    expect(resumed.editing).not.toBeNull()
  })
})

describe('候选清单（modelCatalogOf）与来源标记', () => {
  it('跨类型取并集并去重保序', () => {
    const types = [
      record({ models: ['p/a', 'p/b'] }),
      record({ models: ['p/b', 'p/c'] }),
    ]
    expect(modelCatalogOf(types)).toEqual(['p/a', 'p/b', 'p/c'])
  })

  it('originLabel：router=Router 创建、user=手动、builtin=内置', () => {
    expect(originLabel('router')).toBe('Router 创建')
    expect(originLabel('user')).toBe('手动')
    expect(originLabel('builtin')).toBe('内置')
  })
})

describe('reducer 往返（保存/启停/删除/加载）', () => {
  it('loaded 置数据与 loaded 标记（无默认值负载）；load-failed 记错误不炸', () => {
    const rows = [record()]
    const loaded = typeManageReducer(initialTypeManageState(), { type: 'loaded', types: rows })
    expect(loaded.loaded).toBe(true)
    expect(loaded.types).toEqual(rows)
    const failed = typeManageReducer(initialTypeManageState(), { type: 'load-failed', message: '网络错' })
    expect(failed.loaded).toBe(true) // 加载动作已完成（失败也是完成态），错误看 loadError
    expect(failed.loadError).toBe('网络错')
  })

  it('save-done：新建进列表并关表单', () => {
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
    const opened = typeManageReducer(seeded, { type: 'new-form' })
    const failed = typeManageReducer(opened, { type: 'op-failed', message: '同名类型已存在' })
    expect(failed.error).toBe('同名类型已存在')
    expect(failed.editing).not.toBeNull()
  })
})

/* ────────────────────────── 派生模式 ────────────────────────── */

describe('spawn-mode 文案（spawnModeLabel / spawnModeDescription / 提示）', () => {
  it('两模式各有标签；语义说明按 2026-11-10 分叉范围如实区分', () => {
    expect(spawnModeLabel('cache-priority')).toContain('缓存优先')
    expect(spawnModeLabel('minimal-face')).toContain('最小面')
    expect(spawnModeDescription('cache-priority')).toContain('全新创建')
    expect(spawnModeDescription('cache-priority')).toContain('主管')
    expect(spawnModeDescription('minimal-face')).toContain('最小工具')
    expect(spawnModeDescription('minimal-face')).toContain('钉')
    expect(spawnModeDescription('cache-priority')).not.toBe(spawnModeDescription('minimal-face'))
  })

  it('模型语义提示常在：分叉继承（切换断缓存）与全新创建钉默认', () => {
    expect(SPAWN_MODE_MODEL_HINT).toContain('切换')
    expect(SPAWN_MODE_MODEL_HINT).toContain('缓存')
    expect(SPAWN_MODE_MODEL_HINT).toContain('钉定')
  })
})

describe('reducer：spawn-mode 状态', () => {
  it('初始 spawnMode 为 null（未加载）；spawn-loaded 落当前生效值', () => {
    expect(initialTypeManageState().spawnMode).toBeNull()
    const loaded = typeManageReducer(initialTypeManageState(), { type: 'spawn-loaded', mode: 'cache-priority' })
    expect(loaded.spawnMode).toBe('cache-priority')
  })

  it('save-start 置 busy；save-done 落新值清 busy；失败保旧值并记 spawnError', () => {
    const loaded = typeManageReducer(initialTypeManageState(), { type: 'spawn-loaded', mode: 'cache-priority' })
    const starting = typeManageReducer(loaded, { type: 'spawn-save-start' })
    expect(starting.spawnBusy).toBe(true)
    const done = typeManageReducer(starting, { type: 'spawn-save-done', mode: 'minimal-face' })
    expect(done.spawnMode).toBe('minimal-face')
    expect(done.spawnBusy).toBe(false)

    const failing = typeManageReducer(done, { type: 'spawn-save-start' })
    const failed = typeManageReducer(failing, { type: 'spawn-failed', message: 'HTTP 400' })
    expect(failed.spawnMode).toBe('minimal-face')
    expect(failed.spawnBusy).toBe(false)
    expect(failed.spawnError).toBe('HTTP 400')
    const recovered = typeManageReducer(failed, { type: 'spawn-loaded', mode: 'minimal-face' })
    expect(recovered.spawnError).toBeNull()
  })
})
