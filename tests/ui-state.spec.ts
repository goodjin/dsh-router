/**
 * UI 状态存储测试（计划 B4 路由契约的持久标签序 + B2 Router 会话登记）。
 */

import { describe, expect, it } from 'vitest'

import { LedgerError } from '../src/host/ledger/errors.ts'
import { UiStateStore, type UiStateFile, type UiStatePersistence } from '../src/host/bridge/tabs.ts'

class MemoryUiPersistence implements UiStatePersistence {
  file: UiStateFile | null = null
  failNextSave = false
  async load() {
    return this.file
  }
  async save(f: UiStateFile) {
    if (this.failNextSave) {
      this.failNextSave = false
      throw new Error('disk gone')
    }
    this.file = JSON.parse(JSON.stringify(f)) as UiStateFile
  }
}

function store(file: UiStateFile | null = null) {
  const persistence = new MemoryUiPersistence()
  persistence.file = file
  const ui = new UiStateStore(persistence, () => 1000)
  return { ui, persistence }
}

describe('UiStateStore', () => {
  it('空启动：load 后无标签、无 Router 会话', async () => {
    const { ui } = store()
    await ui.load()
    expect(ui.tabs('ws-1')).toEqual([])
    expect(ui.routerSessions()).toEqual([])
  })

  it('标签按加入顺序持久，closeTab 只移除指定会话', async () => {
    const { ui } = store()
    await ui.load()
    await ui.addTab('ws-1', 'session-1', 'T-001')
    await ui.addTab('ws-1', 'session-2', 'T-002')
    await ui.addTab('ws-2', 'session-3')
    expect(ui.tabs('ws-1').map((t) => t.sessionId)).toEqual(['session-1', 'session-2'])
    expect(ui.tabs('ws-2').map((t) => t.sessionId)).toEqual(['session-3'])
    expect(await ui.removeTab('ws-1', 'session-1')).toBe(true)
    expect(ui.tabs('ws-1').map((t) => t.sessionId)).toEqual(['session-2'])
    expect(await ui.removeTab('ws-1', 'session-ghost')).toBe(false)
  })

  it('重复加同一标签不产生第二条', async () => {
    const { ui } = store()
    await ui.load()
    await ui.addTab('ws-1', 'session-1')
    await ui.addTab('ws-1', 'session-1', 'T-001')
    expect(ui.tabs('ws-1')).toHaveLength(1)
    expect(ui.tabs('ws-1')[0]!.taskId).toBe('T-001')
  })

  it('Router 会话登记：按名字列表，重复登记按 id 去重', async () => {
    const { ui } = store()
    await ui.load()
    await ui.addRouterSession('router-s-1', 'ws-1', '我的 Router')
    await ui.addRouterSession('router-s-2', 'ws-1', 'Router')
    await ui.addRouterSession('router-s-1', 'ws-1', '我的 Router')
    expect(ui.routerSessions()).toEqual([
      { sessionId: 'router-s-1', title: '我的 Router' },
      { sessionId: 'router-s-2', title: 'Router' },
    ])
  })

  it('持久化失败：内存回滚并抛 persistence-failed', async () => {
    const { ui, persistence } = store()
    await ui.load()
    persistence.failNextSave = true
    await expect(ui.addTab('ws-1', 'session-1')).rejects.toThrowError(LedgerError)
    expect(ui.tabs('ws-1')).toEqual([])
  })

  it('重启恢复：从持久化文件载入标签与 Router 会话', async () => {
    const file: UiStateFile = {
      schemaVersion: 1,
      routerSessions: [{ sessionId: 'router-s-1', workspaceId: 'ws-1', name: 'Router', createdAt: 1 }],
      tabs: [{ workspaceId: 'ws-1', sessionId: 'session-9', taskId: 'T-001', addedAt: 2 }],
    }
    const { ui } = store(file)
    await ui.load()
    expect(ui.routerSessions()).toEqual([{ sessionId: 'router-s-1', title: 'Router' }])
    expect(ui.tabs('ws-1').map((t) => ({ sessionId: t.sessionId, taskId: t.taskId }))).toEqual([
      { sessionId: 'session-9', taskId: 'T-001' },
    ])
  })

  it('allTabs：不带 workspace 过滤的全量标签（state 路由缺省参数用）', async () => {
    const { ui } = store()
    await ui.load()
    await ui.addTab('ws-1', 'session-1')
    await ui.addTab('ws-2', 'session-2')
    expect(ui.allTabs().map((t) => t.sessionId)).toEqual(['session-1', 'session-2'])
  })
})
