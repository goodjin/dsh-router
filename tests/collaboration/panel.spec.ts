/**
 * 协作工作台面板测试（计划 Task 3，Layer 4，jsdom 真实 DOM 交互）。
 *
 * brief 命名断言：
 *  - panel_distinguishes_facts：模型标签「进行中」搭配宿主本轮已结束仍显示「进行中」；
 *    宿主状态未知显示「运行状态未知，请打开会话查看」，不写记录；报告标注「模型报告」。
 *  - panel_links_and_scope：根会话默认当前会话；输入框显式覆盖；子会话按记录内 sessionId
 *    调 uiWorkspace.openSession 跳转；成果引用只展示/复制不自动打开；不扫历史、不猜项目。
 *  - role edit shared manual/model：面板保存与用户/模型工具共享同一 RoleStore（保存后出现在列表）。
 *  - missingservicesdegrade：无 factProvider（宿主运行事实不可用）时降级为未知标签，不抛。
 *  - staleasyncresultsignored：切换根后在途旧响应不落地到面板。
 *
 * DOM jsdom 交互真实按钮/表单 → store/api，不只断文本。
 */

// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CollaborationWorkbench, type CollaborationPanelFace } from '../../src/client/collaboration-panel.tsx'
import { startCollaborationStore } from '../../src/client/collaboration-store.ts'
import type { CollaborationApi } from '../../src/client/collaboration-api.ts'
import type { RoleTemplate, SavedRecord, WorkRecord } from '../../src/collaboration/types.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Call { url: string; init?: RequestInit }

function scriptedApi(overrides: {
  records?: WorkRecord[]
  record?: SavedRecord
  roles?: RoleTemplate[]
  savedRole?: RoleTemplate
}): { api: CollaborationApi; setRecords: (r: WorkRecord[]) => void; setRecord: (r: SavedRecord) => void; setRoles: (r: RoleTemplate[]) => void; setSavedRole: (r: RoleTemplate) => void } {
  let records = overrides.records ?? []
  let record = overrides.record
  let roles = overrides.roles ?? []
  let savedRole = overrides.savedRole
  const api: CollaborationApi = {
    listRecords: async () => records,
    readRecord: async () => record ?? ({ record: {} as WorkRecord, path: '' }),
    listRoles: async () => roles,
    saveRole: async (input) => savedRole ?? ({ id: '55555555-5555-4555-8555-555555555555', name: input.name, description: input.description, createdAt: 1, updatedAt: 1 }),
  }
  return {
    api,
    setRecords: (r) => { records = r },
    setRecord: (r) => { record = r },
    setRoles: (r) => { roles = r },
    setSavedRole: (r) => { savedRole = r },
  };
}

const reportRecord: WorkRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  taskId: '11111111-1111-4111-8111-111111111111',
  rootSessionId: 'root-1',
  kind: 'report',
  title: '成员报告',
  body: '完成了登录模块',
  workLabel: '进行中',
  sessions: [{ sessionId: 'child-sess-9', label: '成员' }],
  artifacts: [{ location: '/tmp/report.md', label: '报告文件' }],
  createdAt: 1,
  updatedAt: 1,
}

function render(face: CollaborationPanelFace): { root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  return { root, container }
}

/** 点击一个元素（React onClick）。 */
function click(el: Element): void {
  act(() => { (el as HTMLElement).click() })
}

/** 等待在途异步（store 加载）落地：多冲几次微任务。 */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

let openSession: ReturnType<typeof vi.fn>
beforeEach(() => { openSession = vi.fn() })
afterEach(() => { document.body.innerHTML = '' })

describe('panel_links_and_scope — 根会话默认当前会话 + 输入框覆盖 + 会话跳转', () => {
  it('点按钮打开面板；根会话默认当前会话；刷新加载记录', async () => {
    const { api } = scriptedApi({ records: [reportRecord] })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const { root, container } = render({ store, uiWorkspace: { openSession } })
    await act(async () => { root.render(createElement(CollaborationWorkbench, { store, uiWorkspace: { openSession } })) })
    // 初始收起：面板不渲染，只渲染头部按钮。
    expect(container.querySelector('[data-router-collab-panel]')).toBeNull()
    click(container.querySelector('[data-router-collab-open]')!)
    await flush()
    // 面板出现，根会话默认当前会话。
    expect(container.querySelector('[data-router-collab-panel]')).not.toBeNull()
    expect(container.querySelector('[data-router-collab-root-input]')).toBeTruthy()
    // 记录列表加载出成员报告。
    await flush()
    const items = container.querySelectorAll('[data-router-collab-record]')
    expect(items).toHaveLength(1)
    expect(items[0]!.textContent).toContain('成员报告')
    // brief：提示用户在宿主正常 UI 选择 Router 预设（不自动创建会话）。
    const hint = container.querySelector('[data-router-collab-preset-hint]')
    expect(hint).not.toBeNull()
    expect(hint!.textContent).toContain('Router')
    await act(async () => { root.unmount() })
  })

  it('输入框显式覆盖根会话 ID（记住），不自动扫历史', async () => {
    const { api } = scriptedApi({ records: [] })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-current')
    const { root, container } = render({ store, uiWorkspace: { openSession } })
    await act(async () => { root.render(createElement(CollaborationWorkbench, { store, uiWorkspace: { openSession } })) })
    click(container.querySelector('[data-router-collab-open]')!)
    await flush()
    const input = container.querySelector<HTMLInputElement>('[data-router-collab-root-input]')!
    // 显式输入另一个根会话 ID。
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'root-override-xyz')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(store.get().rootInput).toBe('root-override-xyz')
    expect(store.get().effectiveRootId).toBe('root-override-xyz')
    await act(async () => { root.unmount() })
  })

  it('点会话链接调 uiWorkspace.openSession 用记录内精确 sessionId；成果引用只展示不自动打开', async () => {
    const { api } = scriptedApi({ records: [reportRecord], record: { record: reportRecord, path: '/p' } })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const { root, container } = render({ store, uiWorkspace: { openSession } })
    await act(async () => { root.render(createElement(CollaborationWorkbench, { store, uiWorkspace: { openSession } })) })
    click(container.querySelector('[data-router-collab-open]')!)
    await flush()
    // 选中报告记录。
    const item = container.querySelector('[data-router-collab-record]')!
    click(item!)
    await flush()
    // 会话链接：点击用精确 sessionId 调 openSession（不自动切换焦点）。
    const link = container.querySelector('[data-router-collab-session-link="child-sess-9"]')!
    expect(link).toBeTruthy()
    expect(openSession).not.toHaveBeenCalled() // 渲染不自动跳转
    click(link)
    expect(openSession).toHaveBeenCalledWith('child-sess-9')
    // 成果引用：只展示文本，不自动打开/执行（没有触发 openSession）。
    const artifact = container.querySelector('[data-router-collab-artifact]')!
    expect(artifact.textContent).toContain('/tmp/report.md')
    expect(openSession).toHaveBeenCalledTimes(1) // 仅会话链接那一次
    await act(async () => { root.unmount() })
  })
})

describe('panel_distinguishes_facts — 模型标签与宿主运行事实分开', () => {
  it('模型「进行中」搭配宿主已结束：运行事实显示已结束，模型标签仍「进行中」', async () => {
    const { api } = scriptedApi({ records: [reportRecord], record: { record: reportRecord, path: '/p' } })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    // factProvider：该会话宿主已结束。
    const factProvider = (sessionId: string): 'running' | 'ended' | 'unknown' =>
      sessionId === 'child-sess-9' ? 'ended' : 'unknown'
    const { root, container } = render({ store, uiWorkspace: { openSession }, factProvider })
    await act(async () => { root.render(createElement(CollaborationWorkbench, { store, uiWorkspace: { openSession }, factProvider })) })
    click(container.querySelector('[data-router-collab-open]')!)
    await flush()
    click(container.querySelector('[data-router-collab-record]')!)
    await flush()
    // 运行事实：已结束。
    const fact = container.querySelector('[data-router-collab-runtime-fact="child-sess-9"]')!
    expect(fact.textContent).toContain('已结束')
    // 模型标签：仍「进行中」（不因宿主结束改写）。
    const workLabel = container.querySelector('[data-router-collab-work-label]')!
    expect(workLabel.textContent).toContain('进行中')
    // 报告标注「模型报告」。
    expect(container.querySelector('[data-router-collab-model-report]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('无 factProvider（宿主运行事实不可用）：降级为「运行状态未知，请打开会话查看」，不抛', async () => {
    const { api } = scriptedApi({ records: [reportRecord], record: { record: reportRecord, path: '/p' } })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const { root, container } = render({ store, uiWorkspace: { openSession } }) // 不传 factProvider
    await act(async () => { root.render(createElement(CollaborationWorkbench, { store, uiWorkspace: { openSession } })) })
    click(container.querySelector('[data-router-collab-open]')!)
    await flush()
    click(container.querySelector('[data-router-collab-record]')!)
    await flush()
    const fact = container.querySelector('[data-router-collab-runtime-fact="child-sess-9"]')!
    expect(fact.textContent).toContain('运行状态未知')
    expect(fact.textContent).toContain('请打开会话查看')
    // 仍有跳转入口。
    const link = container.querySelector('[data-router-collab-session-link="child-sess-9"]')!
    expect(link).toBeTruthy()
    await act(async () => { root.unmount() })
  })
})

describe('role edit shared manual/model — 面板保存与模型工具共享同一 RoleStore', () => {
  it('填表保存角色后出现在模板列表（同一 store 路径）', async () => {
    // 保存成功后 listRoles 返回该角色（模拟与用户/模型共享同一 RoleStore 的落盘结果）。
    const saved: RoleTemplate = { id: '66666666-6666-4666-8666-666666666666', name: '测试工程师', description: '写测试', createdAt: 1, updatedAt: 1 }
    let roles: RoleTemplate[] = []
    const api: CollaborationApi = {
      listRecords: async () => [],
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => roles,
      saveRole: async (input) => { roles = [saved]; return saved },
    }
    const store = startCollaborationStore({ api })
    const { root, container } = render({ store, uiWorkspace: { openSession } })
    await act(async () => { root.render(createElement(CollaborationWorkbench, { store, uiWorkspace: { openSession } })) })
    click(container.querySelector('[data-router-collab-open]')!)
    await flush()
    // 列表初始为空。
    expect(container.querySelectorAll('[data-router-collab-template]')).toHaveLength(0)
    // 填表：名称 + 描述（明文，空描述合法）。
    const nameInput = container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!
    const descInput = container.querySelector<HTMLInputElement>('[data-router-collab-role-desc]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(nameInput, '测试工程师')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(descInput, '写测试')
      descInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(container.querySelector('[data-router-collab-role-save]')!)
    // 保存成功后 store 重载模板列表：保存结果进入 listRoles（共享同一 RoleStore）。
    await flush()
    await flush()
    const templates = container.querySelectorAll('[data-router-collab-template]')
    expect([...templates].some((t) => t.textContent!.includes('测试工程师'))).toBe(true)
    await act(async () => { root.unmount() })
  })

  it('保存失败显示错误并保留草稿（不自动创建/不静默）', async () => {
    const { api } = scriptedApi({ roles: [] })
    // 让 saveRole 失败。
    const failingApi: CollaborationApi = {
      ...api,
      saveRole: async () => { throw new Error('保存失败：网络') },
    }
    const store = startCollaborationStore({ api: failingApi })
    const { root, container } = render({ store, uiWorkspace: { openSession } })
    await act(async () => { root.render(createElement(CollaborationWorkbench, { store, uiWorkspace: { openSession } })) })
    click(container.querySelector('[data-router-collab-open]')!)
    await flush()
    const nameInput = container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(nameInput, '草稿角色')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(container.querySelector('[data-router-collab-role-save]')!)
    await flush()
    // 错误可见。
    const err = container.querySelector('[data-router-collab-role-error]')!
    expect(err.textContent).toContain('保存失败')
    // 草稿保留（名称仍在）。
    expect((container.querySelector('[data-router-collab-role-name]') as HTMLInputElement).value).toBe('草稿角色')
    await act(async () => { root.unmount() })
  })
})

describe('staleasyncresultsignored — 切换根后旧响应不落地到面板', () => {
  it('根 A 在途时切到根 B：面板显示 B 的空态，不出现 A 的记录', async () => {
    let resolveA: (r: WorkRecord[]) => void = () => {}
    const api: CollaborationApi = {
      listRecords: () => new Promise<WorkRecord[]>((resolve) => { resolveA = resolve }),
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => [],
      saveRole: async (input) => ({ id: '77777777-7777-4777-8777-777777777777', name: input.name, description: input.description, createdAt: 1, updatedAt: 1 }),
    }
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    const { root, container } = render({ store, uiWorkspace: { openSession } })
    await act(async () => { root.render(createElement(CollaborationWorkbench, { store, uiWorkspace: { openSession } })) })
    click(container.querySelector('[data-router-collab-open]')!)
    await flush()
    // 根 A 的加载挂起（未 resolve）。
    // 切到根 B。
    const input = container.querySelector<HTMLInputElement>('[data-router-collab-root-input]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'root-B')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 现在让根 A 的迟到响应落地——必须被丢弃。
    await act(async () => { resolveA([reportRecord]) })
    await flush()
    // 面板不出现 A 的记录。
    expect(container.querySelectorAll('[data-router-collab-record]')).toHaveLength(0)
    await act(async () => { root.unmount() })
  })

  it('切到根 B 后面板同步清掉 A 的记录与正文（不只忽略迟到响应）', async () => {
    const { api } = scriptedApi({ records: [reportRecord], record: { record: reportRecord, path: '/p' } })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    const { root, container } = render({ store, uiWorkspace: { openSession } })
    await act(async () => { root.render(createElement(CollaborationWorkbench, { store, uiWorkspace: { openSession } })) })
    click(container.querySelector('[data-router-collab-open]')!)
    await flush()
    // 选中 A 的报告记录，正文加载出来。
    click(container.querySelector('[data-router-collab-record]')!)
    await flush()
    // 根 A 的记录列表与正文都在。
    expect(container.querySelectorAll('[data-router-collab-record]')).toHaveLength(1)
    expect(container.querySelector('[data-router-collab-detail]')).not.toBeNull()
    expect(container.querySelector('[data-router-collab-detail-body]')!.textContent).toContain('完成了登录模块')
    // 宿主切到根 B：一次同步发布里清掉 A 的记录与正文（不残留、不等待迟到响应）。
    act(() => { store.setCurrentSession('root-B') })
    expect(store.get().effectiveRootId).toBe('root-B')
    expect(store.get().records).toEqual([])
    expect(store.get().selectedRecord).toBeUndefined()
    expect(container.querySelectorAll('[data-router-collab-record]')).toHaveLength(0)
    expect(container.querySelector('[data-router-collab-detail]')).toBeNull()
    await act(async () => { root.unmount() })
  })
})
