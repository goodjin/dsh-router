/**
 * 设置管理表单纯逻辑（v1.1 计划 Task C3）：worker 类型表单的校验/归一化、
 * 「Router 管理」栏目状态机（reducer）、Router 默认值草稿。零 React、零
 * fetch——组件（settings.tsx）只消费这里，测试直接打纯函数（不启 DOM）。
 *
 * 口径裁定（见 ledger）：
 * - 必填：name 与 systemPrompt（与 C2 工具 create_worker_type 入参的必填口径
 *   对齐）；description/models/skills 可空；角色默认 worker。
 * - models/skills 归一化 = trim → 去空 → 保第一次出现顺序去重（模型列表有序，
 *   首个为该类型会话默认模型，顺序即优先级，不做字典序排序）。
 * - builtin 保护：不可编辑/不可删除/不可禁用（store 是权威，这里拦 UI 层）。
 * - 脏表单：与打开时的基线逐字段比较（含 models 顺序）；脏时第一次取消只出
 *   确认提示，二次 form-discard 才放弃。
 */

import type { RouterDefaults, WorkerTypeRecord } from '../shared/view-contract.ts'

export type TypeRole = 'worker' | 'supervisor'

/** 类型编辑表单（templateId=null 表示新建）。 */
export interface TypeFormState {
  templateId: string | null
  name: string
  description: string
  role: TypeRole
  models: string[]
  systemPrompt: string
  skills: string[]
  enabled: boolean
}

/** 逐字段校验结果（null = 该字段没问题）。 */
export interface TypeFormProblems {
  name: string | null
  systemPrompt: string | null
}

/** 新建表单：角色默认 worker、启用默认开、其余空。 */
export function emptyTypeForm(): TypeFormState {
  return {
    templateId: null,
    name: '',
    description: '',
    role: 'worker',
    models: [],
    systemPrompt: '',
    skills: [],
    enabled: true,
  }
}

/** 记录 → 编辑表单（编辑基线也用它取快照）。 */
export function typeFormFromRecord(record: WorkerTypeRecord): TypeFormState {
  return {
    templateId: record.templateId,
    name: record.name,
    description: record.description,
    role: record.role,
    models: [...record.models],
    systemPrompt: record.systemPrompt,
    skills: [...record.skills],
    enabled: record.enabled,
  }
}

/** 必填校验：name 与 systemPrompt trim 后非空。 */
export function validateTypeForm(form: TypeFormState): TypeFormProblems {
  return {
    name: form.name.trim() === '' ? '名称必填' : null,
    systemPrompt: form.systemPrompt.trim() === '' ? '系统提示词必填' : null,
  }
}

/** 保序去重：trim → 丢空串 → 保留第一次出现的顺序（不排序，顺序就是优先级）。 */
export function dedupeOrdered(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of list) {
    const value = entry.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** 表单归一化后的形状（trim 完毕、列表去重保序；create 请求体直接可用）。 */
export interface NormalizedTypeForm {
  name: string
  description: string
  role: TypeRole
  models: string[]
  systemPrompt: string
  skills: string[]
  enabled: boolean
}

/** 表单 → 归一化形状：文本 trim、列表归一化（update 时取其去 enabled/role 的子集当 patch）。 */
export function normalizeTypeForm(form: TypeFormState): NormalizedTypeForm {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    role: form.role,
    models: dedupeOrdered(form.models),
    systemPrompt: form.systemPrompt.trim(),
    skills: dedupeOrdered(form.skills),
    enabled: form.enabled,
  }
}

function formShape(form: TypeFormState): string {
  return JSON.stringify(normalizeTypeForm(form)) + `|${form.templateId ?? ''}`
}

/** 两表单是否等价（按归一化后比较）。 */
export function formEquals(a: TypeFormState, b: TypeFormState): boolean {
  return formShape(a) === formShape(b)
}

/** 脏表单：相对基线有任何有效差异（models 顺序变化也算）。 */
export function isFormDirty(form: TypeFormState, baseline: TypeFormState | null): boolean {
  if (baseline === null) return true
  return !formEquals(form, baseline)
}

/** builtin 不可编辑（store 同口径：update 对 builtin 抛 builtin-protected）。 */
export function canEditRecord(record: WorkerTypeRecord): boolean {
  return record.origin !== 'builtin'
}

/** builtin 不可删除。 */
export function canRemoveRecord(record: WorkerTypeRecord): boolean {
  return record.origin !== 'builtin'
}

/** builtin 不可禁用（保证任何情况下可派发）；启用回 true 永远允许。 */
export function canDisableRecord(record: WorkerTypeRecord): boolean {
  return record.origin !== 'builtin'
}

/** 来源标记（列表行展示）：Router 创建 ｜ 手动 ｜ 内置。 */
export function originLabel(origin: WorkerTypeRecord['origin']): string {
  return origin === 'router' ? 'Router 创建' : origin === 'user' ? '手动' : '内置'
}

/** 角色标记。 */
export function roleLabel(role: TypeRole): string {
  return role === 'supervisor' ? '主管' : 'worker'
}

/** 候选模型清单：全量类型记录里 models 的并集（保序去重）。 */
export function modelCatalogOf(types: readonly WorkerTypeRecord[]): string[] {
  return dedupeOrdered(types.flatMap((record) => record.models))
}

/** 候选技能清单：全量类型记录里 skills 的并集（保序去重）。 */
export function skillCatalogOf(types: readonly WorkerTypeRecord[]): string[] {
  return dedupeOrdered(types.flatMap((record) => record.skills))
}

/* ────────────────────────── 「Router 管理」栏目状态机 ────────────────────────── */

export interface TypeManageState {
  /** 首次加载完成（成功与否都算完成，失败看 loadError）。 */
  loaded: boolean
  loadError: string | null
  types: WorkerTypeRecord[]
  /** 已保存的 Router 默认值。 */
  defaults: RouterDefaults | null
  /** 默认值编辑草稿（load 后镜像 defaults；dirty 时 UI 出「未保存」提示）。 */
  defaultsDraft: RouterDefaults | null
  defaultsDirty: boolean
  /** 正在保存默认值。 */
  defaultsBusy: boolean
  /** 打开的类型表单（null = 关闭）。 */
  editing: TypeFormState | null
  /** 打开表单时的快照（脏判断基线；新建时 = emptyTypeForm）。 */
  baseline: TypeFormState | null
  /** 脏表单的放弃确认提示。 */
  confirmDiscard: boolean
  /** 任一写操作进行中（保存/启停/删除）。 */
  busy: boolean
  /** 最近一次操作的失败信息（表单内显示，不自动消失）。 */
  error: string | null
  /** 短提示（builtin 被拒等）；form-change/notice-cleared 清掉。 */
  notice: string | null
  /** 待确认删除的 templateId（二次点击确认）。 */
  armedRemove: string | null
}

export function initialTypeManageState(): TypeManageState {
  return {
    loaded: false,
    loadError: null,
    types: [],
    defaults: null,
    defaultsDraft: null,
    defaultsDirty: false,
    defaultsBusy: false,
    editing: null,
    baseline: null,
    confirmDiscard: false,
    busy: false,
    error: null,
    notice: null,
    armedRemove: null,
  }
}

export type TypeManageAction =
  | { type: 'load-start' }
  | { type: 'loaded'; types: WorkerTypeRecord[]; defaults: RouterDefaults }
  | { type: 'load-failed'; message: string }
  | { type: 'new-form' }
  | { type: 'edit-form'; record: WorkerTypeRecord }
  | { type: 'form-change'; patch: Partial<TypeFormState> }
  | { type: 'form-cancel' }
  | { type: 'form-discard' }
  | { type: 'save-start' }
  | { type: 'save-done'; record: WorkerTypeRecord }
  | { type: 'toggle-start' }
  | { type: 'toggle-done'; record: WorkerTypeRecord }
  | { type: 'remove-arm'; templateId: string }
  | { type: 'remove-start' }
  | { type: 'remove-done'; templateId: string }
  | { type: 'op-failed'; message: string }
  | { type: 'notice-cleared' }
  | { type: 'defaults-draft'; patch: Partial<RouterDefaults> }
  | { type: 'defaults-save-start' }
  | { type: 'defaults-save-done'; defaults: RouterDefaults }
  | { type: 'defaults-reset' }

/** 关表单（清编辑/基线/确认/错误）。 */
function closeForm(state: TypeManageState): TypeManageState {
  return { ...state, editing: null, baseline: null, confirmDiscard: false, error: null }
}

export function typeManageReducer(state: TypeManageState, action: TypeManageAction): TypeManageState {
  switch (action.type) {
    case 'load-start':
      return { ...state, loadError: null }
    case 'loaded':
      return {
        ...state,
        loaded: true,
        loadError: null,
        types: action.types,
        defaults: action.defaults,
        defaultsDraft: { ...action.defaults },
        defaultsDirty: false,
      }
    case 'load-failed':
      return { ...state, loaded: true, loadError: action.message }
    case 'new-form':
      return { ...closeForm(state), editing: emptyTypeForm(), baseline: emptyTypeForm(), notice: null, armedRemove: null }
    case 'edit-form': {
      if (!canEditRecord(action.record)) {
        return { ...state, notice: '内置类型固定不可编辑（它是任何情况下可派发的兜底）', armedRemove: state.armedRemove }
      }
      const form = typeFormFromRecord(action.record)
      return { ...closeForm(state), editing: form, baseline: form, notice: null, armedRemove: null }
    }
    case 'form-change':
      if (state.editing === null) return state
      return { ...state, editing: { ...state.editing, ...action.patch }, confirmDiscard: false, notice: null }
    case 'form-cancel': {
      if (state.editing === null) return state
      if (isFormDirty(state.editing, state.baseline)) {
        // 脏表单提示：第一次取消只确认，不丢内容
        return { ...state, confirmDiscard: true }
      }
      return closeForm(state)
    }
    case 'form-discard':
      return closeForm(state)
    case 'save-start':
      return { ...state, busy: true, error: null }
    case 'save-done': {
      const exists = state.types.some((record) => record.templateId === action.record.templateId)
      const types = exists
        ? state.types.map((record) => (record.templateId === action.record.templateId ? action.record : record))
        : [...state.types, action.record]
      return { ...closeForm({ ...state, busy: false, types }), notice: null }
    }
    case 'toggle-start':
      return { ...state, busy: true, error: null }
    case 'toggle-done': {
      const types = state.types.map((record) => (record.templateId === action.record.templateId ? action.record : record))
      return { ...state, busy: false, types }
    }
    case 'remove-arm': {
      const target = state.types.find((record) => record.templateId === action.templateId)
      if (target !== undefined && !canRemoveRecord(target)) {
        return { ...state, notice: '内置类型不可删除（已关闭的该类型会话靠它兜底可派发）' }
      }
      // 再点同一个 = 确认；换目标 = 换待删对象
      return { ...state, armedRemove: state.armedRemove === action.templateId ? state.armedRemove : action.templateId, notice: null }
    }
    case 'remove-start':
      return { ...state, busy: true, error: null }
    case 'remove-done': {
      const types = state.types.filter((record) => record.templateId !== action.templateId)
      return { ...state, busy: false, types, armedRemove: null, notice: null }
    }
    case 'op-failed':
      return { ...state, busy: false, error: action.message }
    case 'notice-cleared':
      return { ...state, notice: null }
    case 'defaults-draft':
      if (state.defaultsDraft === null) return state
      return { ...state, defaultsDraft: { ...state.defaultsDraft, ...action.patch }, defaultsDirty: true }
    case 'defaults-save-start':
      return { ...state, defaultsBusy: true, error: null }
    case 'defaults-save-done':
      return { ...state, defaultsBusy: false, defaults: action.defaults, defaultsDraft: { ...action.defaults }, defaultsDirty: false }
    case 'defaults-reset':
      return { ...state, defaultsDraft: state.defaults !== null ? { ...state.defaults } : state.defaultsDraft, defaultsDirty: false }
    default:
      return state
  }
}

/** 当前表单是否相对基线有未保存更改（栏目的脏提示）。 */
export function editingIsDirty(state: TypeManageState): boolean {
  return state.editing !== null && isFormDirty(state.editing, state.baseline)
}
