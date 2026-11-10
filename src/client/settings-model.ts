/**
 * 设置管理表单纯逻辑：worker 类型**新建**表单的校验/归一化、「Router 管理」
 * 栏目状态机（reducer）。零 React、零 fetch——组件（settings.tsx）只消费这里，
 * 测试直接打纯函数（不启 DOM）。
 *
 * 口径裁定（2026-11-10 设置页收敛后）：
 * - 必填：仅 name；description/models 可空；角色默认 worker。
 * - 类型**不再有编辑**：列表行只有 禁用/启用 与 删除（builtin 除外）；表单只
 *   服务「新建」。要改就删了重建（Router 会话里也可随时 create_worker_type）。
 * - 类型**不再挂技能**（有提示词就够）：表单不收 skills，create 请求体也不带。
 * - 「Router 默认」区已整体移除（2026-11-10）：Router 身份由预设 persona 直定，
 *   不再需要默认模型设置；宿主侧既有数据与路由保留，仅无 UI。
 * - 表单不收系统提示词：create 请求体不带 systemPrompt 键（宿主按角色补默认，
 *   空串会盖掉默认值，所以连空串都不发）。
 * - models 归一化 = trim → 去空 → 保第一次出现顺序去重（模型列表有序，首个为
 *   该类型会话默认模型，顺序即优先级，不做字典序排序）。
 * - builtin 保护：不可删除/不可禁用（store 是权威，这里拦 UI 层）。
 * - 脏表单：与打开时的基线逐字段比较（含 models 顺序）；脏时第一次取消只出
 *   确认提示，二次 form-discard 才放弃。
 */

import type { WorkerSpawnMode, WorkerTypeRecord } from '../shared/view-contract.ts'

export type TypeRole = 'worker' | 'supervisor'

/* ────────────────────────── 派生模式文案 ────────────────────────── */

/** 模式选择器标签。 */
export function spawnModeLabel(mode: WorkerSpawnMode): string {
  return mode === 'cache-priority' ? '缓存优先（默认）' : '最小面'
}

/** 模式语义说明（2026-11-10 分叉范围裁定后的如实表述）。 */
export function spawnModeDescription(mode: WorkerSpawnMode): string {
  return mode === 'cache-priority'
    ? '三预设统一组合（同一段身份中立 persona + 同一套工具超集）。Router 派发 = 全新创建 worker（不背 Router 长会话的历史，按类型默认模型钉定）；主管派子 worker = 宿主分叉复用（继承主管会话的模型与历史，前缀缓存可命中）。授权范围由身份切换卡声明 + 执行层硬闸把关。'
    : '各预设保持最小工具白名单；worker 全新创建后按类型清单钉模型（主管派子 worker 走插件五步复刻，历史仍继承但无缓存复用）。授权范围同样由执行层硬闸把关。'
}

/** 模型语义提示（分叉继承不钉、全新创建钉类型默认）。 */
export const SPAWN_MODE_MODEL_HINT =
  '模型语义：分叉创建的 worker（主管子任务）继承来源会话的模型，手动切换即断前缀缓存；' +
  '全新创建的 worker（Router 派发，两模式都是）按类型 models 首个钉定默认模型。'

/** 类型新建表单（templateId=null；不含 systemPrompt 与 skills——均无 UI）。 */
export interface TypeFormState {
  templateId: string | null
  name: string
  description: string
  role: TypeRole
  models: string[]
  enabled: boolean
}

/** 逐字段校验结果（null = 该字段没问题）。 */
export interface TypeFormProblems {
  name: string | null
}

/** 新建表单：角色默认 worker、启用默认开、其余空。 */
export function emptyTypeForm(): TypeFormState {
  return {
    templateId: null,
    name: '',
    description: '',
    role: 'worker',
    models: [],
    enabled: true,
  }
}

/** 必填校验：仅 name trim 后非空。 */
export function validateTypeForm(form: TypeFormState): TypeFormProblems {
  return {
    name: form.name.trim() === '' ? '名称必填' : null,
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

/** 表单归一化后的形状（trim 完毕、列表去重保序；create 请求体直接可用，无 systemPrompt/skills 键）。 */
export interface NormalizedTypeForm {
  name: string
  description: string
  role: TypeRole
  models: string[]
  enabled: boolean
}

/** 表单 → 归一化形状：文本 trim、列表归一化。 */
export function normalizeTypeForm(form: TypeFormState): NormalizedTypeForm {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    role: form.role,
    models: dedupeOrdered(form.models),
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

/* ────────────────────────── 「Router 管理」栏目状态机 ────────────────────────── */

export interface TypeManageState {
  /** 首次加载完成（成功与否都算完成，失败看 loadError）。 */
  loaded: boolean
  loadError: string | null
  types: WorkerTypeRecord[]
  /**
   * 当前生效的 worker 派生模式（v1.3 C2；null = 未加载）。
   * volatile 语义：保存即生效、不落盘，重启回到启动配置值——UI 文案如实标注。
   */
  spawnMode: WorkerSpawnMode | null
  /** 派生模式保存进行中（选择器禁用）。 */
  spawnBusy: boolean
  /** 派生模式保存失败信息（保旧值显示，下次操作或重载清除）。 */
  spawnError: string | null
  /** 打开的新建表单（null = 关闭；类型无编辑入口，2026-11-10）。 */
  editing: TypeFormState | null
  /** 打开表单时的快照（脏判断基线；恒为 emptyTypeForm）。 */
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
    spawnMode: null,
    spawnBusy: false,
    spawnError: null,
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
  | { type: 'loaded'; types: WorkerTypeRecord[] }
  | { type: 'load-failed'; message: string }
  | { type: 'new-form' }
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
  | { type: 'spawn-loaded'; mode: WorkerSpawnMode }
  | { type: 'spawn-save-start' }
  | { type: 'spawn-save-done'; mode: WorkerSpawnMode }
  | { type: 'spawn-failed'; message: string }

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
      }
    case 'load-failed':
      return { ...state, loaded: true, loadError: action.message }
    case 'new-form':
      return { ...closeForm(state), editing: emptyTypeForm(), baseline: emptyTypeForm(), notice: null, armedRemove: null }
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
    /* ── 派生模式（volatile，保存即生效；失败保旧值不静默） ── */
    case 'spawn-loaded':
      return { ...state, spawnMode: action.mode, spawnError: null }
    case 'spawn-save-start':
      return { ...state, spawnBusy: true, spawnError: null }
    case 'spawn-save-done':
      return { ...state, spawnBusy: false, spawnMode: action.mode, spawnError: null }
    case 'spawn-failed':
      return { ...state, spawnBusy: false, spawnError: action.message }
    default:
      return state
  }
}

/** 当前表单是否相对基线有未保存更改（栏目的脏提示）。 */
export function editingIsDirty(state: TypeManageState): boolean {
  return state.editing !== null && isFormDirty(state.editing, state.baseline)
}
