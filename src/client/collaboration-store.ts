/**
 * 协作工作台 store（计划 Task 3，Layer 4）。
 *
 * 纯状态 + 异步加载，零 React 依赖（组件用 useSyncExternalStore 订阅）。职责：
 *  - 根会话选择：默认当前会话；输入框显式 rootID 覆盖并被记住（直到用户重置）；
 *    空白根有意义地不可用（effectiveRootId 为 undefined），不臆造、不扫历史。
 *  - 用户刷新/打开触发加载（refreshRecords/selectRecord/refreshRoles），无轮询定时器。
 *  - 竞态防线：仅一个 UI 请求生成计数器——改变根/当前会话选择即在途请求作废，
 *    迟到的旧根响应不得替换新根（不是执行 token/DB 版本）。
 *  - 读取错误可见（recordsError/rolesError）且可重试；保存失败可见（saveError）且
 *    返回 false 让调用方保留草稿。
 *
 * 不推断权限、不扫会话历史、不自动判定业务完成；记录修改由模型工具负责。
 */

import type { CollaborationApi, CollaborationModelCatalog } from './collaboration-api.ts'
import type { RoleModelCandidate, RoleTemplate, SavedRecord, WorkRecord } from '../collaboration/types.ts'

/** store 对外状态（React useSyncExternalStore 直接读）。 */
export interface CollaborationState {
  /** 当前会话 id（来自 uiSession；根会话默认值）。 */
  currentSessionId?: string
  /** 用户显式输入的 root 覆盖（记住，直到 resetRootInput）。 */
  rootInput: string
  /** 实际生效的根会话 id：rootInput 非空则用它，否则回落当前会话；都无则 undefined。 */
  effectiveRootId?: string
  /** 当前根会话下的记录列表。 */
  records: WorkRecord[]
  /** 选中的记录详情（点选某条记录时加载）。 */
  selectedRecord?: SavedRecord
  /** 角色模板列表（与用户/模型共享同一 RoleStore）。 */
  templates: RoleTemplate[]
  /** 已注册模型清单。读不到时 unavailable，不占用 rolesError。 */
  modelCatalog: CollaborationModelCatalog
  /** 记录列表加载中。 */
  loadingRecords: boolean
  /** 角色模板加载中。 */
  loadingRoles: boolean
  /** 记录读取错误（列表/详情）；下次成功即清。 */
  recordsError: string | null
  /** 角色模板读取错误；下次成功即清。 */
  rolesError: string | null
  /** 保存角色失败信息（保留草稿，由用户重试）。 */
  saveError: string | null
}

/** startCollaborationStore 的依赖。 */
export interface CollaborationStoreDeps {
  api: CollaborationApi
  /** 诊断出口（apply 里接 logger.warn）；缺省静默。 */
  report?: (message: string) => void
}

/** 工作台 store 公开面（组件经它读状态、发加载/保存；组件不发自己的请求）。 */
export interface CollaborationStore {
  get(): CollaborationState
  subscribe(listener: () => void): () => void
  setCurrentSession(sessionId: string | undefined): void
  setRootInput(value: string): void
  resetRootInput(): void
  effectiveRootId(): string | undefined
  refreshRecords(): Promise<void>
  selectRecord(taskId: string, recordId: string): Promise<void>
  clearSelectedRecord(): void
  refreshRoles(): Promise<void>
  refreshModelCatalog(): Promise<void>
  saveRole(input: { name: string; description: string; models?: RoleModelCandidate[] }): Promise<boolean>
  clearSaveError(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 实际生效的根：rootInput 去空白后非空用它，否则当前会话；都无则 undefined。 */
function resolveEffectiveRoot(rootInput: string, currentSessionId: string | undefined): string | undefined {
  const trimmed = rootInput.trim()
  if (trimmed !== '') return trimmed
  return currentSessionId
}

export function startCollaborationStore(deps: CollaborationStoreDeps): CollaborationStore {
  const { api } = deps
  const report = deps.report ?? (() => {})

  let currentSessionId: string | undefined
  let rootInput = ''
  let records: WorkRecord[] = []
  let selectedRecord: SavedRecord | undefined
  let templates: RoleTemplate[] = []
  let modelCatalog: CollaborationModelCatalog = { unavailable: true, providers: [] }
  let loadingRecords = false
  let loadingRoles = false
  let recordsError: string | null = null
  let rolesError: string | null = null
  let saveError: string | null = null

  // 缓存的状态对象：useSyncExternalStore 要求 getSnapshot 在状态未变时返回同一引用，
  // 否则每次 render 都「像变了」→ 无限重渲染。每次变更在 apply 里重建。
  let cached: CollaborationState = {
    currentSessionId: undefined,
    rootInput: '',
    effectiveRootId: undefined,
    records: [],
    templates: [],
    modelCatalog: { unavailable: true, providers: [] },
    loadingRecords: false,
    loadingRoles: false,
    recordsError: null,
    rolesError: null,
    saveError: null,
  }

  // 竞态防线：仅 UI 请求生成计数器。根/当前会话切换即在途请求作废；每次新加载推进序号。
  let recordsSeq = 0
  let rolesSeq = 0

  /** 重载角色模板（成功/失败保存后都调用；与用户/模型共享同一 RoleStore）。 */
  async function reloadRoles(): Promise<void> {
    const seq = ++rolesSeq
    apply(() => { loadingRoles = true; rolesError = null })
    try {
      const list = await api.listRoles()
      if (seq !== rolesSeq) return
      apply(() => { templates = list; loadingRoles = false })
    } catch (error) {
      if (seq !== rolesSeq) return
      report(`collaboration roles load failed: ${errorMessage(error)}`)
      apply(() => { rolesError = errorMessage(error); loadingRoles = false })
    }
  }

  const listeners = new Set<() => void>()
  function emit(): void {
    for (const listener of [...listeners]) listener()
  }
  function apply(mutate: () => void): void {
    mutate()
    cached = {
      currentSessionId,
      rootInput,
      effectiveRootId: resolveEffectiveRoot(rootInput, currentSessionId),
      records,
      selectedRecord,
      templates,
      modelCatalog,
      loadingRecords,
      loadingRoles,
      recordsError,
      rolesError,
      saveError,
    }
    emit()
  }

  return {
    get: () => cached,

    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    effectiveRootId: () => resolveEffectiveRoot(rootInput, currentSessionId),

    setCurrentSession(sessionId: string | undefined): void {
      if (currentSessionId === sessionId) return
      // 显式 root 覆盖存在时，currentSession 切换而有效根未变则不清资料。
      if (resolveEffectiveRoot(rootInput, sessionId) === resolveEffectiveRoot(rootInput, currentSessionId)) {
        apply(() => { currentSessionId = sessionId })
        return
      }
      // 有效根改变：root 字段与清掉旧列表/正文/错误在**同一次** state 发布里完成，
      // 避免先 emit 新 root、旧正文仍在的短暂显示；同时作废在途请求。
      recordsSeq += 1
      apply(() => {
        currentSessionId = sessionId
        records = []
        selectedRecord = undefined
        recordsError = null
        loadingRecords = false
      })
    },

    setRootInput(value: string): void {
      if (rootInput === value) return
      if (resolveEffectiveRoot(value, currentSessionId) === resolveEffectiveRoot(rootInput, currentSessionId)) {
        apply(() => { rootInput = value })
        return
      }
      recordsSeq += 1
      apply(() => {
        rootInput = value
        records = []
        selectedRecord = undefined
        recordsError = null
        loadingRecords = false
      })
    },

    resetRootInput(): void {
      if (rootInput === '') return
      if (resolveEffectiveRoot('', currentSessionId) === resolveEffectiveRoot(rootInput, currentSessionId)) {
        apply(() => { rootInput = '' })
        return
      }
      recordsSeq += 1
      apply(() => {
        rootInput = ''
        records = []
        selectedRecord = undefined
        recordsError = null
        loadingRecords = false
      })
    },

    async refreshRecords(): Promise<void> {
      const root = resolveEffectiveRoot(rootInput, currentSessionId)
      if (root === undefined) {
        // 空白根有意义地不可用：不发请求、不报错、清空。
        recordsSeq += 1
        apply(() => { records = []; recordsError = null; loadingRecords = false; selectedRecord = undefined })
        return
      }
      const seq = ++recordsSeq
      apply(() => { loadingRecords = true; recordsError = null })
      try {
        const list = await api.listRecords(root)
        if (seq !== recordsSeq) return // 迟到/作废响应：丢弃
        // 刷新后选中记录若已不在新列表（含空列表）则详情不残留；仍在则保留。
        const kept = selectedRecord !== undefined
          && list.some((r) => r.id === selectedRecord!.record.id && r.taskId === selectedRecord!.record.taskId)
          ? selectedRecord
          : undefined
        apply(() => { records = list; selectedRecord = kept; loadingRecords = false })
      } catch (error) {
        if (seq !== recordsSeq) return
        report(`collaboration records load failed: ${errorMessage(error)}`)
        apply(() => { records = []; recordsError = errorMessage(error); loadingRecords = false })
      }
    },

    async selectRecord(taskId: string, recordId: string): Promise<void> {
      const root = resolveEffectiveRoot(rootInput, currentSessionId)
      if (root === undefined) {
        recordsSeq += 1
        apply(() => { selectedRecord = undefined; recordsError = null; loadingRecords = false })
        return
      }
      const seq = ++recordsSeq
      apply(() => { loadingRecords = true; recordsError = null })
      try {
        const saved = await api.readRecord(root, taskId, recordId)
        if (seq !== recordsSeq) return
        apply(() => { selectedRecord = saved; loadingRecords = false })
      } catch (error) {
        if (seq !== recordsSeq) return
        report(`collaboration record read failed: ${errorMessage(error)}`)
        apply(() => { recordsError = errorMessage(error); loadingRecords = false })
      }
    },

    clearSelectedRecord(): void {
      if (selectedRecord === undefined) return
      apply(() => { selectedRecord = undefined })
    },

    async refreshRoles(): Promise<void> {
      await reloadRoles()
    },

    async refreshModelCatalog(): Promise<void> {
      try {
        const catalog = await api.listModelCatalog()
        apply(() => { modelCatalog = catalog })
      } catch (error) {
        report(`collaboration model catalog load failed: ${errorMessage(error)}`)
        apply(() => { modelCatalog = { unavailable: true, providers: [] } })
      }
    },

    async saveRole(input: { name: string; description: string; models?: RoleModelCandidate[] }): Promise<boolean> {
      try {
        await api.saveRole(input)
        saveError = null
        emit()
        // 成功后重载模板列表（与用户/模型共享同一 RoleStore）。
        await reloadRoles()
        return true
      } catch (error) {
        report(`collaboration role save failed: ${errorMessage(error)}`)
        apply(() => { saveError = errorMessage(error) })
        return false
      }
    },

    clearSaveError(): void {
      if (saveError === null) return
      apply(() => { saveError = null })
    },
  }
}
