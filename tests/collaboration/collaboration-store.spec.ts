/**
 * 协作工作台 store 测试（计划 Task 3，Layer 4）。
 *
 * brief 命名断言：
 *  - 根会话默认当前会话；输入框显式 rootID 覆盖并被记住（直到用户重置）；空白根有意义地不可用，不臆造。
 *  - 改变根/当前会话选择作废在途请求（迟到的旧根响应不得替换新根）；只有 UI 请求生成计数器。
 *  - 用户刷新/打开触发加载，无轮询定时器。
 *  - 读取错误可见（recordsError/rolesError）+ 重试；保存失败显示并保留草稿（saveRole 返回 false）。
 */

import { describe, expect, it, vi } from 'vitest'

import {
  startCollaborationStore,
  type CollaborationStore,
} from '../../src/client/collaboration-store.ts'
import type { CollaborationApi } from '../../src/client/collaboration-api.ts'
import type { RoleTemplate, SavedRecord, WorkRecord } from '../../src/collaboration/types.ts'

/** 可控 promise：测试手动 resolve/reject，用于精确控制在途时序。 */
function controllable<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 可编排的假 api：每个方法返回可替换的实现，记录调用次数。 */
function scriptedApi(): {
  api: CollaborationApi
  setListRecords: (impl: (root: string) => Promise<WorkRecord[]>) => void
  setReadRecord: (impl: (root: string, taskId: string, recordId: string) => Promise<SavedRecord>) => void
  setListRoles: (impl: () => Promise<RoleTemplate[]>) => void
  setSaveRole: (impl: (input: { id?: string; name: string; description: string; models?: Array<{ provider: string; model: string }> }) => Promise<RoleTemplate>) => void
  calls: { listRecords: number; readRecord: number; listRoles: number; saveRole: number }
  lastListRoot: () => string | undefined
} {
  const calls = { listRecords: 0, readRecord: 0, listRoles: 0, saveRole: 0 }
  let listRecordsImpl: (root: string) => Promise<WorkRecord[]> = async () => []
  let readRecordImpl: (root: string, taskId: string, recordId: string) => Promise<SavedRecord> = async () => ({ record: {} as WorkRecord, path: '' })
  let listRolesImpl: () => Promise<RoleTemplate[]> = async () => []
  let saveRoleImpl: (input: { id?: string; name: string; description: string; models?: Array<{ provider: string; model: string }> }) => Promise<RoleTemplate> = async (input) => ({ name: input.name, description: input.description })
  let lastRoot: string | undefined
  const api: CollaborationApi = {
    listRecords: async (root) => { calls.listRecords += 1; lastRoot = root; return listRecordsImpl(root) },
    readRecord: async (root, taskId, recordId) => { calls.readRecord += 1; return readRecordImpl(root, taskId, recordId) },
    listRoles: async () => { calls.listRoles += 1; return listRolesImpl() },
    saveRole: async (input) => { calls.saveRole += 1; return saveRoleImpl(input) },
    listModelCatalog: async () => ({ unavailable: true, providers: [] }),
  }
  return {
    api,
    setListRecords: (impl) => { listRecordsImpl = impl },
    setReadRecord: (impl) => { readRecordImpl = impl },
    setListRoles: (impl) => { listRolesImpl = impl },
    setSaveRole: (impl) => { saveRoleImpl = impl },
    calls,
    lastListRoot: () => lastRoot,
  }
}

const record = (id: string, taskId: string, kind: WorkRecord['kind'], title: string): WorkRecord => ({
  id, taskId, rootSessionId: 'r', kind, title, body: 'b', createdAt: 1, updatedAt: 1,
})

describe('root selection — 默认当前会话 + 显式覆盖记住 + 空白不臆造', () => {
  it('根会话默认取当前会话；空白输入回落到当前会话', () => {
    const { api } = scriptedApi()
    const store = startCollaborationStore({ api })
    store.setCurrentSession('sess-current')
    expect(store.get().effectiveRootId).toBe('sess-current')
    store.setRootInput('   ')
    expect(store.get().effectiveRootId).toBe('sess-current')
  })

  it('输入框显式 rootID 覆盖并被记住；resetRootInput 回到当前会话', () => {
    const { api } = scriptedApi()
    const store = startCollaborationStore({ api })
    store.setCurrentSession('sess-current')
    store.setRootInput('custom-root-123')
    expect(store.get().effectiveRootId).toBe('custom-root-123')
    expect(store.get().rootInput).toBe('custom-root-123')
    store.resetRootInput()
    expect(store.get().rootInput).toBe('')
    expect(store.get().effectiveRootId).toBe('sess-current')
  })

  it('无当前会话且空白输入 → effectiveRootId 为 undefined（有意义地不可用，不臆造）', () => {
    const { api } = scriptedApi()
    const store = startCollaborationStore({ api })
    expect(store.get().effectiveRootId).toBeUndefined()
  })
})

describe('stale async results ignored — 改变根/当前会话作废旧在途请求', () => {
  it('根 A 的在途响应迟到时根已切到 B：A 的响应被丢弃，不替换 B 的数据', async () => {
    const { api, setListRecords } = scriptedApi()
    const gate = controllable<WorkRecord[]>()
    setListRecords(() => gate.promise)
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    const pending = store.refreshRecords() // 发起根 A 的加载（挂起）
    expect(store.get().loadingRecords).toBe(true)
    // 在途期间切到根 B：作废旧请求。
    store.setRootInput('root-B')
    // 迟到的根 A 响应到达——必须被丢弃。
    gate.resolve([record('a', 't', 'task', 'A的任务')])
    await pending
    // 根 B 的视图：records 仍为空（A 的响应没有落地），且 effectiveRootId 是 B。
    expect(store.get().effectiveRootId).toBe('root-B')
    expect(store.get().records).toEqual([])
    expect(store.get().loadingRecords).toBe(false)
  })

  it('新根加载完成后显示新根数据；旧根迟到响应不覆盖', async () => {
    const { api, setListRecords } = scriptedApi()
    const gateA = controllable<WorkRecord[]>()
    let mode: 'A' | 'B' = 'A'
    setListRecords(() => (mode === 'A' ? gateA.promise : Promise.resolve([record('b', 't', 'task', 'B的任务')])))
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    const pendingA = store.refreshRecords()
    store.setRootInput('root-B') // 作废 A
    mode = 'B'
    const pendingB = store.refreshRecords()
    await pendingB
    expect(store.get().records.map((r) => r.title)).toEqual(['B的任务'])
    // 现在才让 A 的迟到响应落地——不得覆盖 B。
    gateA.resolve([record('a', 't', 'task', 'A的任务')])
    await pendingA
    expect(store.get().records.map((r) => r.title)).toEqual(['B的任务'])
  })

  it('selectRecord 同理：切换根后旧详情响应被丢弃', async () => {
    const { api, setReadRecord } = scriptedApi()
    const gate = controllable<SavedRecord>()
    setReadRecord(() => gate.promise)
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    const pending = store.selectRecord('t', 'rec-1')
    store.setRootInput('root-B')
    gate.resolve({ record: record('old', 't', 'report', '旧报告'), path: '/old' })
    await pending
    expect(store.get().selectedRecord).toBeUndefined()
  })
})

describe('root switch clears stale content — 切根同步清空旧列表/详情，无中间态', () => {
  it('setCurrentSession 切到根 B：A 的列表/详情/错误在同一 state 里清空', async () => {
    const { api, setListRecords, setReadRecord } = scriptedApi()
    setListRecords(async () => [record('a', 't', 'task', 'A的任务')])
    setReadRecord(async () => ({ record: record('a', 't', 'report', 'A报告'), path: '/a' }))
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    await store.refreshRecords()
    await store.selectRecord('t', 'a')
    expect(store.get().records.map((r) => r.title)).toEqual(['A的任务'])
    expect(store.get().selectedRecord?.record.title).toBe('A报告')
    // 宿主切到根 B（有效根改变）：一次发布里清掉旧列表/正文/错误，关掉在途 loading。
    store.setCurrentSession('root-B')
    const state = store.get()
    expect(state.effectiveRootId).toBe('root-B')
    expect(state.records).toEqual([])
    expect(state.selectedRecord).toBeUndefined()
    expect(state.recordsError).toBeNull()
    expect(state.loadingRecords).toBe(false)
  })

  it('setRootInput 显式切到另一个根：旧列表/正文同步清空', async () => {
    const { api, setListRecords, setReadRecord } = scriptedApi()
    setListRecords(async () => [record('a', 't', 'task', 'A的任务')])
    setReadRecord(async () => ({ record: record('a', 't', 'report', 'A报告'), path: '/a' }))
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    await store.refreshRecords()
    await store.selectRecord('t', 'a')
    // 输入框显式改成另一个根。
    store.setRootInput('root-B')
    const state = store.get()
    expect(state.effectiveRootId).toBe('root-B')
    expect(state.records).toEqual([])
    expect(state.selectedRecord).toBeUndefined()
    expect(state.recordsError).toBeNull()
    expect(state.loadingRecords).toBe(false)
  })

  it('resetRootInput 回到不同当前会话：旧列表/正文同步清空', async () => {
    const { api, setListRecords, setReadRecord } = scriptedApi()
    setListRecords(async () => [record('a', 't', 'task', 'A的任务')])
    setReadRecord(async () => ({ record: record('a', 't', 'report', 'A报告'), path: '/a' }))
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    store.setRootInput('root-A-override')
    await store.refreshRecords()
    await store.selectRecord('t', 'a')
    // 重置回当前会话 root-A（有效根从 override 变回 root-A）：清空。
    store.resetRootInput()
    const state = store.get()
    expect(state.effectiveRootId).toBe('root-A')
    expect(state.records).toEqual([])
    expect(state.selectedRecord).toBeUndefined()
  })

  it('显式 root 覆盖存在时切 currentSession（有效根未变）：不清资料', async () => {
    const { api, setListRecords } = scriptedApi()
    setListRecords(async () => [record('a', 't', 'task', 'A的任务')])
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    store.setRootInput('root-A') // 显式覆盖 = 当前会话
    await store.refreshRecords()
    expect(store.get().records.map((r) => r.title)).toEqual(['A的任务'])
    // 切 currentSession 到 root-B，但有效根仍是覆盖值 root-A：资料不得被清。
    store.setCurrentSession('root-B')
    expect(store.get().effectiveRootId).toBe('root-A')
    expect(store.get().records.map((r) => r.title)).toEqual(['A的任务'])
  })

  it('刷新成功且选中记录已不在新列表中（含空列表）：详情不残留；仍在则保留', async () => {
    const { api, setListRecords, setReadRecord } = scriptedApi()
    let mode: 'with' | 'empty' = 'with'
    setListRecords(async () => (mode === 'with' ? [record('a', 't', 'task', 'A的任务')] : []))
    setReadRecord(async () => ({ record: record('a', 't', 'report', 'A报告'), path: '/a' }))
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    await store.refreshRecords()
    await store.selectRecord('t', 'a')
    expect(store.get().selectedRecord?.record.id).toBe('a')
    // 刷新后列表里已无该记录（空列表）：详情清掉，不残留 A 正文。
    mode = 'empty'
    await store.refreshRecords()
    expect(store.get().records).toEqual([])
    expect(store.get().selectedRecord).toBeUndefined()
  })

  it('刷新后选中记录仍在列表中：详情保留', async () => {
    const { api, setListRecords, setReadRecord } = scriptedApi()
    setListRecords(async () => [record('a', 't', 'task', 'A的任务')])
    setReadRecord(async () => ({ record: record('a', 't', 'report', 'A报告'), path: '/a' }))
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    await store.refreshRecords()
    await store.selectRecord('t', 'a')
    await store.refreshRecords() // 列表仍含 a
    expect(store.get().selectedRecord?.record.id).toBe('a')
    expect(store.get().records.map((r) => r.title)).toEqual(['A的任务'])
  })
})

describe('user-triggered load — 刷新/打开触发加载，无轮询定时器', () => {
  it('refreshRecords 调 api.listRecords 一次（针对 effective root）', async () => {
    const { api, setListRecords, calls, lastListRoot } = scriptedApi()
    setListRecords(async () => [record('r1', 't1', 'task', '任务')])
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    await store.refreshRecords()
    expect(calls.listRecords).toBe(1)
    expect(lastListRoot()).toBe('root-1')
    expect(store.get().records.map((r) => r.title)).toEqual(['任务'])
    expect(store.get().recordsError).toBeNull()
  })

  it('effective root 为 undefined 时不发请求（空白根有意义地不可用）', async () => {
    const { api, calls } = scriptedApi()
    const store = startCollaborationStore({ api })
    await store.refreshRecords()
    expect(calls.listRecords).toBe(0)
    expect(store.get().records).toEqual([])
    expect(store.get().recordsError).toBeNull()
  })

  it('selectRecord 加载详情；clearSelectedRecord 清空', async () => {
    const { api, setReadRecord } = scriptedApi()
    setReadRecord(async () => ({ record: record('rec-9', 't', 'report', '报告'), path: '/p' }))
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    await store.selectRecord('t', 'rec-9')
    expect(store.get().selectedRecord?.record.id).toBe('rec-9')
    store.clearSelectedRecord()
    expect(store.get().selectedRecord).toBeUndefined()
  })

  it('不设任何定时器（无 interval loop）', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const { api } = scriptedApi()
    startCollaborationStore({ api })
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })
})

describe('errors visible + retry — 读取错误可见，重试可恢复', () => {
  it('listRecords 失败：recordsError 可见、records 清空；再次刷新成功清除错误', async () => {
    const { api, setListRecords } = scriptedApi()
    let fail = true
    setListRecords(async () => {
      if (fail) throw new Error('boom')
      return [record('ok', 't', 'task', '好的')]
    })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    await store.refreshRecords()
    expect(store.get().recordsError).toBe('boom')
    expect(store.get().records).toEqual([])
    expect(store.get().loadingRecords).toBe(false)
    fail = false
    await store.refreshRecords()
    expect(store.get().recordsError).toBeNull()
    expect(store.get().records.map((r) => r.title)).toEqual(['好的'])
  })

  it('selectRecord 失败：recordsError 可见，不留下半截详情', async () => {
    const { api, setReadRecord } = scriptedApi()
    setReadRecord(async () => { throw new Error('读取失败') })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    await store.selectRecord('t', 'rec-1')
    expect(store.get().recordsError).toBe('读取失败')
    expect(store.get().selectedRecord).toBeUndefined()
  })

  it('listRoles 失败：rolesError 可见；重试成功清除', async () => {
    const { api, setListRoles } = scriptedApi()
    let fail = true
    setListRoles(async () => {
      if (fail) throw new Error('角色读取失败')
      return [{ id: '33333333-3333-4333-8333-333333333333', name: '前端', description: '', createdAt: 1, updatedAt: 1 }]
    })
    const store = startCollaborationStore({ api })
    await store.refreshRoles()
    expect(store.get().rolesError).toBe('角色读取失败')
    fail = false
    await store.refreshRoles()
    expect(store.get().rolesError).toBeNull()
    expect(store.get().templates).toHaveLength(1)
  })
})

describe('saveRole — 共享同一 RoleStore 路径；失败显示并保留草稿', () => {
  it('saveRole 成功：saveError 清空、templates 重载、返回 true', async () => {
    const { api, setSaveRole, setListRoles, calls } = scriptedApi()
    setSaveRole(async (input) => ({ id: '44444444-4444-4444-8444-444444444444', name: input.name, description: input.description, createdAt: 1, updatedAt: 1 }))
    setListRoles(async () => [{ id: '44444444-4444-4444-8444-444444444444', name: '测试', description: '', createdAt: 1, updatedAt: 1 }])
    const store = startCollaborationStore({ api })
    const ok = await store.saveRole({ name: '测试', description: '' })
    expect(ok).toBe(true)
    expect(store.get().saveError).toBeNull()
    expect(calls.saveRole).toBe(1)
    expect(calls.listRoles).toBe(1) // 成功后重载模板
    expect(store.get().templates).toHaveLength(1)
  })

  it('saveRole 失败：saveError 可见、返回 false（调用方保留草稿）', async () => {
    const { api, setSaveRole } = scriptedApi()
    setSaveRole(async () => { throw new Error('保存失败：网络') })
    const store = startCollaborationStore({ api })
    const ok = await store.saveRole({ name: '草稿', description: '保留' })
    expect(ok).toBe(false)
    expect(store.get().saveError).toBe('保存失败：网络')
    store.clearSaveError()
    expect(store.get().saveError).toBeNull()
  })

  it('saveRole 把 models 原样交给 api；清单失败不写 rolesError', async () => {
    const { api, setSaveRole } = scriptedApi()
    let seen: { models?: unknown } | undefined
    setSaveRole(async (input) => {
      seen = input
      return { name: input.name, description: input.description }
    })
    const store = startCollaborationStore({ api })
    const models = [{ provider: 'p', model: 'm' }]
    expect(await store.saveRole({ name: '执行者', description: '职责', models })).toBe(true)
    expect(seen?.models).toEqual(models)
    const failing = {
      ...api,
      listModelCatalog: async () => { throw new Error('llm down') },
    }
    const catalogStore = startCollaborationStore({ api: failing })
    await catalogStore.refreshModelCatalog()
    expect(catalogStore.get().rolesError).toBeNull()
    expect(catalogStore.get().modelCatalog).toEqual({ unavailable: true, providers: [] })
  })
})
