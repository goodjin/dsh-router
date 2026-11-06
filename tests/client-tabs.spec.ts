/**
 * 标签条纯函数（计划 Task B7 Step 1：tabs 排序/激活映射）。
 *
 * 规则来自规格 §3.2 两层导航：Router 会话固定在标签条首位，worker 标签按
 * 服务端下发（GET /router/state 的 tabs，即持久标签序）排列；关闭一个 worker
 * 标签只移出标签条、不停止任务；激活态映射 = 当前会话 id → 标签下标。
 * 全部断言打在纯函数上，不启 React、不启宿主。
 */

import { describe, expect, it } from 'vitest'
import {
  activeTabIndex,
  buildTabList,
  removeWorkerTab,
} from '../src/client/tabs-model.ts'
import type { RouterState, WorkerTabInfo } from '../src/shared/view-contract.ts'

function workerTab(sessionId: string, title: string, overrides: Partial<WorkerTabInfo> = {}): WorkerTabInfo {
  return { sessionId, title, running: false, ...overrides }
}

function state(overrides: Partial<RouterState> = {}): RouterState {
  return {
    routerSessions: [{ sessionId: 'router-1', title: 'Router' }],
    tasks: [],
    questions: [],
    tabs: [workerTab('w-a', 'A'), workerTab('w-b', 'B')],
    templates: [],
    ...overrides,
  }
}

describe('buildTabList：Router 固定首位，worker 按服务端 tabs 序', () => {
  it('单个 Router 在下标 0，其后是服务端顺序的 worker 标签', () => {
    const tabs = buildTabList(state())
    expect(tabs.map((tab) => tab.sessionId)).toEqual(['router-1', 'w-a', 'w-b'])
    expect(tabs[0]?.kind).toBe('router')
    expect(tabs[1]?.kind).toBe('worker')
    expect(tabs[1]?.running).toBe(false)
  })

  it('多个 Router 会话都排在 worker 之前（各自保持服务端顺序）', () => {
    const tabs = buildTabList(state({
      routerSessions: [
        { sessionId: 'router-2', title: '第二个' },
        { sessionId: 'router-1', title: 'Router' },
      ],
    }))
    expect(tabs.map((tab) => tab.sessionId)).toEqual(['router-2', 'router-1', 'w-a', 'w-b'])
  })

  it('worker 标签携带任务元数据（taskId/taskStatus/running）', () => {
    const tabs = buildTabList(state({
      tabs: [workerTab('w-x', '写文档', { taskId: 'T-001', taskStatus: 'running', running: true })],
    }))
    expect(tabs[1]).toMatchObject({ kind: 'worker', taskId: 'T-001', taskStatus: 'running', running: true })
  })

  it('没有 Router 会话时不造出空 Router 标签', () => {
    const tabs = buildTabList(state({ routerSessions: [] }))
    expect(tabs.map((tab) => tab.kind)).toEqual(['worker', 'worker'])
  })
})

describe('removeWorkerTab：关闭后重算，不改入参', () => {
  it('移除指定 worker，其余保持原顺序', () => {
    const tabs = buildTabList(state({ tabs: [workerTab('w-a', 'A'), workerTab('w-b', 'B'), workerTab('w-c', 'C')] }))
    const next = removeWorkerTab(tabs, 'w-b')
    expect(next.map((tab) => tab.sessionId)).toEqual(['router-1', 'w-a', 'w-c'])
  })

  it('Router 标签不可被该函数移除（关闭只针对 worker 视图）', () => {
    const tabs = buildTabList(state())
    expect(removeWorkerTab(tabs, 'router-1').map((tab) => tab.sessionId)).toEqual(['router-1', 'w-a', 'w-b'])
  })

  it('是纯函数：入参数组不被改动', () => {
    const tabs = buildTabList(state())
    const snapshot = tabs.map((tab) => tab.sessionId)
    removeWorkerTab(tabs, 'w-a')
    expect(tabs.map((tab) => tab.sessionId)).toEqual(snapshot)
  })
})

describe('activeTabIndex：当前会话 id → 标签下标', () => {
  it('worker 会话激活映射到它自己的下标', () => {
    const tabs = buildTabList(state())
    expect(activeTabIndex(tabs, 'w-b')).toBe(2)
  })

  it('Router 会话激活映射到它的下标（首位）', () => {
    const tabs = buildTabList(state())
    expect(activeTabIndex(tabs, 'router-1')).toBe(0)
  })

  it('多个 Router 时映射到被点开的那个，而不是固定 0', () => {
    const tabs = buildTabList(state({
      routerSessions: [
        { sessionId: 'router-2', title: '第二个' },
        { sessionId: 'router-1', title: 'Router' },
      ],
    }))
    expect(activeTabIndex(tabs, 'router-1')).toBe(1)
  })

  it('当前会话不在标签条里（普通会话）→ -1，宿主 UI 自行处理无激活态', () => {
    const tabs = buildTabList(state())
    expect(activeTabIndex(tabs, 'some-other-session')).toBe(-1)
    expect(activeTabIndex(tabs, undefined)).toBe(-1)
  })
})
