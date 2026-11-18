/**
 * 协作视图页测试（会话标签行「协作」页，jsdom 真实 DOM 交互）。
 *
 * brief 命名断言：
 *  - view_renders_tasks_canvas_and_jump：任务卡（标题 + 四态进度）→ 任务详情（说明正文、
 *    会话画布真实父子树、分工/报告列表）；画布节点点击用精确 sessionId 跳转；
 *    目录经 refreshProjection 按需请求（根 + 出现的节点）。
 *  - view_canvas_orphans_and_prune：记录关联但不在树内的会话进孤儿行（不臆造父边）；
 *    树内未关联的兄弟被剪掉。
 *  - view_distinguishes_facts：模型工作标签「进行中」搭配宿主已结束仍显示「进行中」；
 *    宿主状态未知显示「运行状态未知，请打开会话查看」；报告标注「模型报告」。
 *  - view_task_selection：多任务切换，详情随选中任务换内容。
 *  - role edit shared manual/model：视图页保存与模型工具共享同一 RoleStore。
 *  - staleasyncresultsignored：切换根后在途旧响应不落地；切换时同步清掉旧记录与正文。
 *
 * DOM jsdom 交互真实按钮/表单 → store/api，不只断文本。useSessions/useSessionStatus
 * 以结构等价的 stub 传入（与会话标准属性同形：选择器钩子 + Map 状态）。
 */

// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CollaborationView, type CollaborationViewProps } from '../../src/client/collaboration-view.tsx'
import { startCollaborationStore } from '../../src/client/collaboration-store.ts'
import type { CollaborationApi } from '../../src/client/collaboration-api.ts'
import type { RoleTemplate, SavedRecord, WorkRecord } from '../../src/collaboration/types.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* ---- 固定记录 ---- */

const taskRecord: WorkRecord = {
  id: 'r-task',
  taskId: 'T1',
  rootSessionId: 'root-1',
  kind: 'task',
  title: '登录模块改造',
  body: '把登录模块改造为统一认证',
  createdAt: 1,
  updatedAt: 1,
}

const assignmentRecord: WorkRecord = {
  id: 'r-a1',
  taskId: 'T1',
  rootSessionId: 'root-1',
  kind: 'assignment',
  title: '前端分工',
  body: '负责登录页',
  workLabel: '进行中',
  sessions: [{ sessionId: 'w1', label: '前端成员' }],
  createdAt: 2,
  updatedAt: 2,
}

const reportRecord: WorkRecord = {
  id: 'r-rep1',
  taskId: 'T1',
  rootSessionId: 'root-1',
  kind: 'report',
  title: '成员报告',
  body: '完成了登录模块',
  workLabel: '进行中',
  sessions: [{ sessionId: 'child-sess-9', label: '成员' }],
  artifacts: [{ location: '/tmp/report.md', label: '报告文件' }],
  createdAt: 3,
  updatedAt: 3,
}

const otherTaskRecord: WorkRecord = {
  id: 'r-task2',
  taskId: 'T2',
  rootSessionId: 'root-1',
  kind: 'task',
  title: '支付模块改造',
  body: '改造支付流程',
  createdAt: 4,
  updatedAt: 90,
}

/* ---- API stub ---- */

function scriptedApi(overrides: {
  records?: WorkRecord[]
  record?: SavedRecord
  roles?: RoleTemplate[]
}): { api: CollaborationApi; setRecords: (r: WorkRecord[]) => void } {
  let records = overrides.records ?? []
  const api: CollaborationApi = {
    // 按根过滤（与真实 API 同语义：listRecords(rootSessionId, query)）。
    listRecords: async (rootSessionId: string) => records.filter((record) => record.rootSessionId === rootSessionId),
    readRecord: async () => overrides.record ?? { record: {} as WorkRecord, path: '' },
    listRoles: async () => overrides.roles ?? [],
    saveRole: async (input) => ({ id: '55555555-5555-4555-8555-555555555555', name: input.name, description: input.description, createdAt: 1, updatedAt: 1 }),
  }
  return { api, setRecords: (r) => { records = r } }
}

/* ---- 会话标准属性 stub（与真实 face 同形） ---- */

interface SessionsStateStub {
  projectionsBySession: Record<string, { values?: { subagentCatalog?: Array<{ id: string; label?: string }> } } | undefined>
  byId: Record<string, { title?: string; running?: boolean } | undefined>
}

function sessionsHooks(state: SessionsStateStub, statuses: Map<string, { running?: boolean }>): Pick<CollaborationViewProps, 'useSessions' | 'useSessionStatus'> {
  return {
    useSessions: (<T,>(selector: (value: SessionsStateStub) => T) => selector(state)) as CollaborationViewProps['useSessions'],
    useSessionStatus: (<T,>(selector: (value: Map<string, { running?: boolean }>) => T) => selector(statuses)) as CollaborationViewProps['useSessionStatus'],
  }
}

const DEFAULT_SESSIONS: SessionsStateStub = {
  projectionsBySession: {
    'root-1': { values: { subagentCatalog: [{ id: 'w1', label: '前端成员' }, { id: 'w-other', label: '别的任务成员' }] } },
    w1: { values: { subagentCatalog: [] } },
    'w-other': { values: { subagentCatalog: [] } },
  },
  byId: {},
}

/* ---- 渲染与交互工具 ---- */

function render(props: CollaborationViewProps): { root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  return { root, container }
}

function click(el: Element): void {
  act(() => { (el as HTMLElement).click() })
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

let openSession: ReturnType<typeof vi.fn>
let refreshProjection: ReturnType<typeof vi.fn>
beforeEach(() => {
  openSession = vi.fn()
  refreshProjection = vi.fn()
})
afterEach(() => { document.body.innerHTML = '' })

function baseProps(store: ReturnType<typeof startCollaborationStore>, extra?: Partial<CollaborationViewProps>): CollaborationViewProps {
  return {
    store,
    uiWorkspace: { openSession },
    refreshProjection,
    ...sessionsHooks(DEFAULT_SESSIONS, new Map([['w1', { running: true }], ['child-sess-9', { running: false }]])),
    ...extra,
  }
}

/* ---- 测试 ---- */

describe('view_renders_tasks_canvas_and_jump — 任务看板 + 会话画布 + 跳转', () => {
  it('任务卡显示标题与四态进度；详情含说明正文、画布父子树、分工/报告列表；点节点精确跳转', async () => {
    const { api } = scriptedApi({ records: [taskRecord, assignmentRecord, reportRecord, otherTaskRecord], record: { record: reportRecord, path: '/p' } })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const { root, container } = render(baseProps(store))
    await act(async () => { root.render(createElement(CollaborationView, baseProps(store))) })
    await flush()
    // 任务看板：两张任务卡；T2 最近活动更晚排在前面。
    const cards = container.querySelectorAll('[data-router-collab-task]')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.getAttribute('data-router-collab-task')).toBe('T2')
    // 选中 T1（默认取第一张前先点 T1）。
    click(container.querySelector('[data-router-collab-task="T1"]')!)
    await flush()
    // 进度文本（T1 卡内：进行中 1）。
    const progress = container.querySelector('[data-router-collab-task="T1"] [data-router-collab-task-progress]')
    expect(progress!.textContent).toContain('进行中 1')
    // 说明正文。
    expect(container.querySelector('[data-router-collab-task-brief]')!.textContent).toContain('把登录模块改造为统一认证')
    // 画布：根节点 + w1（真实父子树；未关联的 w-other 被剪掉）。
    expect(container.querySelector('[data-router-collab-node="root-1"]')).toBeTruthy()
    const w1 = container.querySelector('[data-router-collab-node="w1"]')!
    expect(w1).toBeTruthy()
    expect(container.querySelector('[data-router-collab-node="w-other"]')).toBeNull()
    expect(container.querySelector('[data-router-collab-node-label="w1"]')!.textContent).toContain('前端成员')
    expect(container.querySelector('[data-router-collab-node-status="w1"]')!.textContent).toContain('运行中')
    expect(container.querySelector('[data-router-collab-node-worklabel="w1"]')!.textContent).toContain('进行中')
    // 目录按需请求：根与树内节点都请求过。
    expect(refreshProjection).toHaveBeenCalledWith('root-1')
    expect(refreshProjection).toHaveBeenCalledWith('w1')
    // 点节点 → 精确 sessionId 跳转（渲染不自动跳）。
    expect(openSession).not.toHaveBeenCalled()
    click(w1)
    expect(openSession).toHaveBeenCalledWith('w1')
    // 分工与报告列表都在。
    expect(container.querySelector('[data-router-collab-record="T1:r-a1"]')!.textContent).toContain('前端分工')
    expect(container.querySelector('[data-router-collab-record="T1:r-rep1"]')!.textContent).toContain('成员报告')
    // 角色区在页底。
    expect(container.querySelector('[data-router-collab-roles-section]')).toBeTruthy()
    await act(async () => { root.unmount() })
  })
})

describe('view_canvas_orphans_and_prune — 孤儿行与剪枝', () => {
  it('记录关联但不在树内的会话进孤儿行，不臆造父边', async () => {
    const { api } = scriptedApi({ records: [taskRecord, assignmentRecord, reportRecord], record: { record: reportRecord, path: '/p' } })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const { root, container } = render(baseProps(store))
    await act(async () => { root.render(createElement(CollaborationView, baseProps(store))) })
    await flush()
    // 报告关联 child-sess-9，但目录树里没有它 → 孤儿行。
    const orphans = container.querySelector('[data-router-collab-orphans]')!
    expect(orphans).toBeTruthy()
    const orphanNode = orphans.querySelector('[data-router-collab-node="child-sess-9"]')!
    expect(orphanNode).toBeTruthy()
    expect(orphans.querySelector('[data-router-collab-node-status="child-sess-9"]')!.textContent).toContain('已结束')
    // 孤儿节点也能跳转。
    click(orphanNode)
    expect(openSession).toHaveBeenCalledWith('child-sess-9')
    await act(async () => { root.unmount() })
  })
})

describe('view_distinguishes_facts — 模型标签与宿主运行事实分开', () => {
  it('模型「进行中」搭配宿主已结束：事实显示已结束，标签仍「进行中」；报告标注「模型报告」', async () => {
    const { api } = scriptedApi({ records: [taskRecord, assignmentRecord, reportRecord], record: { record: reportRecord, path: '/p' } })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    click(container.querySelector('[data-router-collab-record="T1:r-rep1"]')!)
    await flush()
    const fact = container.querySelector('[data-router-collab-runtime-fact="child-sess-9"]')!
    expect(fact.textContent).toContain('已结束')
    const workLabel = container.querySelector('[data-router-collab-work-label]')!
    expect(workLabel.textContent).toContain('进行中')
    expect(container.querySelector('[data-router-collab-model-report]')).not.toBeNull()
    // 正文与成果引用、落盘路径。
    expect(container.querySelector('[data-router-collab-detail-body]')!.textContent).toContain('完成了登录模块')
    expect(container.querySelector('[data-router-collab-artifact]')!.textContent).toContain('/tmp/report.md')
    // 会话链接点击跳转。
    click(container.querySelector('[data-router-collab-session-link="child-sess-9"]')!)
    expect(openSession).toHaveBeenCalledWith('child-sess-9')
    await act(async () => { root.unmount() })
  })

  it('无会话状态数据：降级为「运行状态未知，请打开会话查看」，不抛', async () => {
    const { api } = scriptedApi({ records: [taskRecord, assignmentRecord, reportRecord], record: { record: reportRecord, path: '/p' } })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const props = baseProps(store, sessionsHooks(DEFAULT_SESSIONS, new Map()))
    delete (props as { useSessionStatus?: unknown }).useSessionStatus
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    click(container.querySelector('[data-router-collab-record="T1:r-rep1"]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-runtime-fact="child-sess-9"]')!.textContent).toContain('运行状态未知')
    expect(container.querySelector('[data-router-collab-session-link="child-sess-9"]')).toBeTruthy()
    await act(async () => { root.unmount() })
  })
})

describe('view_task_selection — 多任务切换', () => {
  it('点另一张任务卡：详情换为该任务的说明与画布', async () => {
    const { api } = scriptedApi({ records: [taskRecord, assignmentRecord, reportRecord, otherTaskRecord] })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    click(container.querySelector('[data-router-collab-task="T2"]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-task-brief]')!.textContent).toContain('改造支付流程')
    // T2 无关联会话：整树保留（无剪枝），w-other 可见。
    expect(container.querySelector('[data-router-collab-node="w-other"]')).toBeTruthy()
    await act(async () => { root.unmount() })
  })
})

describe('role edit shared manual/model — 视图页保存与模型工具共享同一 RoleStore', () => {
  it('填表保存角色后出现在模板列表', async () => {
    const saved: RoleTemplate = { id: '66666666-6666-4666-8666-666666666666', name: '测试工程师', description: '写测试', createdAt: 1, updatedAt: 1 }
    let roles: RoleTemplate[] = []
    const api: CollaborationApi = {
      listRecords: async () => [],
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => roles,
      saveRole: async (input) => { roles = [saved]; return saved },
    }
    const store = startCollaborationStore({ api })
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    expect(container.querySelectorAll('[data-router-collab-template]')).toHaveLength(0)
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
    await flush()
    await flush()
    const templates = container.querySelectorAll('[data-router-collab-template]')
    expect([...templates].some((t) => t.textContent!.includes('测试工程师'))).toBe(true)
    await act(async () => { root.unmount() })
  })

  it('保存失败显示错误并保留草稿', async () => {
    const { api } = scriptedApi({})
    const failingApi: CollaborationApi = {
      ...api,
      saveRole: async () => { throw new Error('保存失败：网络') },
    }
    const store = startCollaborationStore({ api: failingApi })
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    const nameInput = container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(nameInput, '草稿角色')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(container.querySelector('[data-router-collab-role-save]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-role-error]')!.textContent).toContain('保存失败')
    expect((container.querySelector('[data-router-collab-role-name]') as HTMLInputElement).value).toBe('草稿角色')
    await act(async () => { root.unmount() })
  })
})

describe('staleasyncresultsignored — 切换根后旧响应不落地', () => {
  it('根 A 在途时切到根 B：显示 B 的空态，不出现 A 的记录', async () => {
    let resolveA: (r: WorkRecord[]) => void = () => {}
    const api: CollaborationApi = {
      listRecords: () => new Promise<WorkRecord[]>((resolve) => { resolveA = resolve }),
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => [],
      saveRole: async (input) => ({ id: '77777777-7777-4777-8777-777777777777', name: input.name, description: input.description, createdAt: 1, updatedAt: 1 }),
    }
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-A')
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    const input = container.querySelector<HTMLInputElement>('[data-router-collab-root-input]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'root-B')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { resolveA([taskRecord]) })
    await flush()
    expect(container.querySelectorAll('[data-router-collab-record]')).toHaveLength(0)
    await act(async () => { root.unmount() })
  })

  it('切到根 B 后同步清掉 A 的记录与正文', async () => {
    const { api } = scriptedApi({ records: [taskRecord, assignmentRecord, reportRecord], record: { record: reportRecord, path: '/p' } })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    click(container.querySelector('[data-router-collab-record="T1:r-rep1"]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-detail]')).not.toBeNull()
    act(() => { store.setCurrentSession('root-B') })
    await flush()
    expect(store.get().records).toEqual([])
    expect(store.get().selectedRecord).toBeUndefined()
    expect(container.querySelectorAll('[data-router-collab-record]')).toHaveLength(0)
    expect(container.querySelector('[data-router-collab-detail]')).toBeNull()
    await act(async () => { root.unmount() })
  })
})
