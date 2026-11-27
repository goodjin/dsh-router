/** 协作界面：任务树/结果、独立任务图、角色编辑与根会话切换。 */
// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CollaborationView, type CollaborationViewProps } from '../../src/client/collaboration-view.tsx'
import { startCollaborationStore } from '../../src/client/collaboration-store.ts'
import type { CollaborationApi, CollaborationModelCatalog } from '../../src/client/collaboration-api.ts'
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
    listModelCatalog: async () => ({ unavailable: true, providers: [] }),
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

/* ---- 角色候选清单 fixture 与工具 ---- */

const catalogFixture = {
  unavailable: false,
  providers: [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }, { id: 'deepseek-reasoner', name: 'Reasoner' }] },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
  ],
}

function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function catalogOptionRow(container: HTMLElement, provider: string, model: string): HTMLElement {
  const row = container.querySelector(`[data-router-collab-catalog-group][data-router-collab-catalog-provider="${provider}"] [data-router-collab-catalog-option][data-router-collab-catalog-model="${model}"]`)
  if (row === null) throw new Error(`catalog option not found: ${provider} / ${model}`)
  return row as HTMLElement
}

function catalogCheckbox(row: HTMLElement): HTMLInputElement {
  const checkbox = row.querySelector<HTMLInputElement>('[data-router-collab-catalog-checkbox]')
  if (checkbox === null) throw new Error('catalog checkbox not found')
  return checkbox
}

/** 进入某块的编辑态：三块默认只读，点「编辑」才出现该块的输入与保存/取消。 */
function startEdit(container: HTMLElement, block: 'name' | 'desc' | 'models'): void {
  const button = container.querySelector(`[data-router-collab-role-${block}-edit]`)
  if (button === null) throw new Error(`edit button not found: ${block}`)
  click(button)
}

/** 点某块的「保存」（每块只有自己的保存按钮）。 */
function saveBlock(container: HTMLElement, block: 'name' | 'desc' | 'models'): void {
  const button = container.querySelector(`[data-router-collab-role-${block}-save]`)
  if (button === null) throw new Error(`save button not found: ${block}`)
  click(button)
}

/** 点「添加模型」展开清单面板（清单入口只在候选块编辑态出现）。 */
function openCatalog(container: HTMLElement): void {
  if (container.querySelector('[data-router-collab-catalog-open]') === null) startEdit(container, 'models')
  click(container.querySelector('[data-router-collab-catalog-open]')!)
}

async function mountRolesNew(api: CollaborationApi): Promise<{ root: Root; container: HTMLElement }> {
  const store = startCollaborationStore({ api })
  const props = baseProps(store)
  const { root, container } = render(props)
  await act(async () => { root.render(createElement(CollaborationView, props)) })
  await flush()
  click(container.querySelector('[data-router-collab-tab="roles"]')!)
  await flush()
  click(container.querySelector('[data-router-collab-role-new]')!)
  await flush()
  return { root, container }
}

function catalogApi(catalog: CollaborationModelCatalog, overrides?: Partial<CollaborationApi>): CollaborationApi {
  return {
    listRecords: async () => [],
    readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
    listRoles: async () => [],
    listModelCatalog: async () => catalog,
    saveRole: async (input) => ({
      id: input.id ?? `id-${input.name}`,
      name: input.name,
      description: input.description,
      ...(input.models !== undefined ? { models: input.models } : {}),
    }),
    ...overrides,
  }
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

describe('任务树与任务结果', () => {
  async function show(records: WorkRecord[]) {
    const store = startCollaborationStore({ api: scriptedApi({ records }).api })
    store.setCurrentSession('root-1')
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    return { root, container }
  }
  it('根任务与子任务按真实派发嵌套，可收起；详情只显示内容和结果', async () => {
    const { root, container: c } = await show([{...taskRecord, sessions:[{sessionId:'root-1',label:'Router'}]}, otherTaskRecord, {...assignmentRecord,taskId:'T2'}, reportRecord])
    const sub = () => c.querySelector('[data-router-collab-task-item="T2"]')
    expect(sub()?.closest('ul')?.parentElement?.getAttribute('data-task-branch')).toBe('T1')
    const toggle = c.querySelector('[aria-label="收起登录模块改造"]')!
    click(toggle); expect(sub()).toBeNull(); click(toggle); expect(sub()).toBeTruthy()
    click(c.querySelector('[data-router-collab-task-item="T1"]')!)
    const detail = c.querySelector('[data-router-collab-task-detail]')!
    expect(detail.textContent).toContain('完成了登录模块'); expect(detail.textContent).toContain('/tmp/report.md')
    expect(detail.querySelector('[data-router-collab-node], [data-router-collab-record]')).toBeNull()
    expect(refreshProjection).toHaveBeenCalledWith('w1')
    click(c.querySelector('[data-router-collab-tab="graph"]')!)
    expect(c.querySelector('[data-router-collab-task-title="T1"]')?.textContent).toBe(taskRecord.title)
    expect(c.querySelectorAll('svg path')).toHaveLength(1)
    expect(c.querySelector('[data-router-collab-task-detail]')).toBeNull()
    await act(async () => root.unmount())
  })
  it('报告提到其他会话并不代表派发', async () => {
    const {root,container:c}=await show([{...taskRecord,sessions:[{sessionId:'root-1',label:'Router'}]},otherTaskRecord,{...reportRecord,taskId:'T2',sessions:[{sessionId:'w1',label:'参考'}]}])
    click(c.querySelector('[data-router-collab-tab="graph"]')!)
    expect(c.querySelectorAll('svg path')).toHaveLength(0)
    await act(async () => root.unmount())
  })
  it('单一主任务可见，结果优先用最新汇总', async () => {
    const {root, container:c} = await show([taskRecord, reportRecord, {...reportRecord,id:'sum1',kind:'summary',body:'旧版'}, {...reportRecord,id:'sum2',kind:'summary',body:'最终结论',updatedAt:10}])
    const text=c.querySelector('[data-router-collab-task-detail]')?.textContent
    expect(text).toContain('最终结论'); expect(text).not.toContain('旧版'); expect(text).not.toContain(reportRecord.body)
    click(c.querySelector('[data-router-collab-tab="graph"]')!)
    expect(c.querySelector('[data-router-collab-task-title="T1"]')?.textContent).toBe(taskRecord.title)
    await act(async () => root.unmount())
  })
})

describe('composer_hidden_when_view_open — 协作视图打开时隐藏输入框', () => {
  it('视图挂载：body 打标记并注入隐藏规则；卸载：撤掉标记，输入框恢复', async () => {
    const { api } = scriptedApi({ records: [taskRecord] })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    expect(document.body.getAttribute('data-router-collab-active')).toBe('1')
    const style = document.getElementById('router-collab-hide-composer')
    expect(style).toBeTruthy()
    expect(style!.textContent).toContain('[data-composer-dock]')
    await act(async () => { root.unmount() })
    expect(document.body.getAttribute('data-router-collab-active')).toBeNull()
  })
})

describe('view_task_selection — 多任务切换', () => {
  it('任务图点节点：跳回任务标签并选中该任务显示详情', async () => {
    const { api } = scriptedApi({ records: [taskRecord, assignmentRecord, reportRecord, otherTaskRecord] })
    const store = startCollaborationStore({ api })
    store.setCurrentSession('root-1')
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    click(container.querySelector('[data-router-collab-tab="graph"]')!)
    await flush()
    click(container.querySelector('[data-router-collab-task-node="T2"]')!)
    await flush()
    // 跳回任务标签并显示 T2 详情。
    expect(container.querySelector('[data-router-collab-tab="tasks"]')!.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-router-collab-task-brief]')!.textContent).toContain('改造支付流程')
    expect(container.querySelector('[data-router-collab-task-node]')).toBeNull()
    // T2 无关联会话：整树保留（无剪枝），w-other 可见。
    expect(container.querySelector('[data-router-collab-task-detail]')?.textContent).toContain('暂无结果')
    await act(async () => { root.unmount() })
  })
})

describe('role edit shared manual/model — 角色编辑区分块独立编辑与保存', () => {
  interface RolePost {
    id?: string
    name: string
    description: string
    models?: Array<{ provider: string; model: string }>
  }

  /** 角色列表可变、保存请求留痕的 API（复刻服务端语义：带 id 按 ID 更新、models 缺省保留盘上候选）。 */
  function rolesApi(
    initial: Array<Omit<RoleTemplate, 'id'> & { id?: string }>,
    catalog: CollaborationModelCatalog = { unavailable: true, providers: [] },
  ): { api: CollaborationApi; posts: RolePost[]; roles: RoleTemplate[] } {
    const roles: RoleTemplate[] = initial.map((role) => ({
      id: role.id ?? `id-${role.name}`,
      name: role.name,
      description: role.description,
      ...(role.models !== undefined ? { models: role.models } : {}),
    }))
    const posts: RolePost[] = []
    const api: CollaborationApi = {
      listRecords: async () => [],
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => roles,
      listModelCatalog: async () => catalog,
      saveRole: async (input) => {
        posts.push({
          ...(input.id !== undefined ? { id: input.id } : {}),
          name: input.name,
          description: input.description,
          ...(input.models !== undefined ? { models: input.models } : {}),
        })
        const target = input.id !== undefined
          ? roles.find((role) => role.id === input.id)
          : roles.find((role) => role.name === input.name)
        const merged = input.models !== undefined ? input.models : target?.models
        const next: RoleTemplate = {
          id: target?.id ?? `id-${input.name}`,
          name: input.name,
          description: input.description,
          ...(merged !== undefined && merged.length > 0 ? { models: merged } : {}),
        }
        if (target !== undefined) roles[roles.indexOf(target)] = next
        else roles.push(next)
        return next
      },
    }
    return { api, posts, roles }
  }

  async function mountRoles(api: CollaborationApi, roleName?: string): Promise<{ root: Root; container: HTMLElement }> {
    const store = startCollaborationStore({ api })
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    click(container.querySelector('[data-router-collab-tab="roles"]')!)
    await flush()
    if (roleName !== undefined) {
      click(container.querySelector(`[data-router-collab-role-item="${roleName}"]`)!)
      await flush()
    }
    return { root, container }
  }

  it('三块默认只读：页面上没有可编辑输入，也没有统一保存按钮', async () => {
    const { api } = rolesApi([{ name: '测试工程师', description: '写测试用例并报告', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }])
    const { root, container } = await mountRoles(api, '测试工程师')
    expect(container.querySelector('[data-router-collab-role-name]')).toBeNull()
    expect(container.querySelector('[data-router-collab-role-desc]')).toBeNull()
    expect(container.querySelector('[data-router-collab-model-provider]')).toBeNull()
    expect(container.querySelector('[data-router-collab-model-up]')).toBeNull()
    expect(container.querySelector('[data-router-collab-catalog-open]')).toBeNull()
    expect(container.querySelector('[data-router-collab-role-save]')).toBeNull()
    // 编辑器里一个 input/textarea 都没有。
    expect(container.querySelectorAll('[data-router-collab-role-editor] input, [data-router-collab-role-editor] textarea')).toHaveLength(0)
    // 只读文本在。
    expect(container.querySelector('[data-router-collab-role-name-text]')?.textContent).toContain('测试工程师')
    expect(container.querySelector('[data-router-collab-role-desc-text]')?.textContent).toContain('写测试用例并报告')
    expect(container.querySelector('[data-router-collab-model-text]')?.textContent).toContain('deepseek-chat')
    await act(async () => { root.unmount() })
  })

  it('点各块的「编辑」才出现该块的输入与保存/取消，其它块仍只读', async () => {
    const { api } = rolesApi([{ name: '主管', description: '旧说明', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }])
    const { root, container } = await mountRoles(api, '主管')
    // 名称块。
    startEdit(container, 'name')
    expect(container.querySelector('[data-router-collab-role-name]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-name-save]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-name-cancel]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-desc]')).toBeNull()
    expect(container.querySelector('[data-router-collab-catalog-open]')).toBeNull()
    click(container.querySelector('[data-router-collab-role-name-cancel]')!)
    expect(container.querySelector('[data-router-collab-role-name]')).toBeNull()
    // 说明块。
    startEdit(container, 'desc')
    expect(container.querySelector('[data-router-collab-role-desc]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-desc-save]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-desc-cancel]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-name]')).toBeNull()
    click(container.querySelector('[data-router-collab-role-desc-cancel]')!)
    expect(container.querySelector('[data-router-collab-role-desc]')).toBeNull()
    // 候选块。
    startEdit(container, 'models')
    expect(container.querySelector('[data-router-collab-catalog-open]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-model-up]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-model-down]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-model-delete]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-model-edit]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-models-save]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-models-cancel]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-name]')).toBeNull()
    expect(container.querySelector('[data-router-collab-role-desc]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('名称块保存：请求体是新名 + 当前说明，不带 models', async () => {
    const { api, posts, roles } = rolesApi([{ name: '主管', description: '旧说明', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }])
    const { root, container } = await mountRoles(api, '主管')
    startEdit(container, 'name')
    await act(async () => { setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!, '新名字') })
    saveBlock(container, 'name')
    await flush()
    await flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.name).toBe('新名字')
    expect(posts[0]!.description).toBe('旧说明')
    expect('models' in posts[0]!).toBe(false)
    // 角色还是那个角色（ID 不变），候选没被动过（服务端保留既有候选）。
    expect(roles).toHaveLength(1)
    expect(roles[0]!.id).toBe('id-主管')
    expect(roles[0]!.name).toBe('新名字')
    expect(roles[0]!.models).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
    // 保存后该块回到只读，显示新名字。
    expect(container.querySelector('[data-router-collab-role-name]')).toBeNull()
    expect(container.querySelector('[data-router-collab-role-name-text]')?.textContent).toContain('新名字')
    await act(async () => { root.unmount() })
  })

  it('名称块保存带角色 id：改名只改名字，列表里不多出角色', async () => {
    const { api, posts, roles } = rolesApi([{ name: '主管', description: '旧说明', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }])
    const { root, container } = await mountRoles(api, '主管')
    startEdit(container, 'name')
    await act(async () => { setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!, '高级主管') })
    saveBlock(container, 'name')
    await flush()
    await flush()
    // 请求体带 id（按 ID 更新，服务端文件路径不动）。
    expect(posts[0]!.id).toBe('id-主管')
    expect(posts[0]!.name).toBe('高级主管')
    // 没有多出角色：还是一条，ID 不变。
    expect(roles).toHaveLength(1)
    expect(roles[0]!.id).toBe('id-主管')
    expect(roles[0]!.name).toBe('高级主管')
    expect(container.querySelectorAll('[data-router-collab-role-item]')).toHaveLength(1)
    // 列表项仍指向同一个 ID（改名不孤儿化）。
    expect(container.querySelector('[data-router-collab-role-id="id-主管"]')).toBeTruthy()
    await act(async () => { root.unmount() })
  })

  it('说明块与候选块的保存请求都带角色 id', async () => {
    const { api, posts } = rolesApi([{ name: '主管', description: '旧说明', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }])
    const { root, container } = await mountRoles(api, '主管')
    startEdit(container, 'desc')
    await act(async () => { setFieldValue(container.querySelector<HTMLTextAreaElement>('[data-router-collab-role-desc]')!, '新说明') })
    saveBlock(container, 'desc')
    await flush()
    await flush()
    expect(posts[0]!.id).toBe('id-主管')
    expect('models' in posts[0]!).toBe(false)
    startEdit(container, 'models')
    click(container.querySelectorAll('[data-router-collab-model-delete]')[0]!)
    await flush()
    saveBlock(container, 'models')
    await flush()
    await flush()
    expect(posts[1]!.id).toBe('id-主管')
    expect(posts[1]!.models).toEqual([])
    await act(async () => { root.unmount() })
  })

  it('说明块保存：请求体是当前名 + 新说明，不带 models', async () => {
    const { api, posts, roles } = rolesApi([{ name: '主管', description: '旧说明', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }])
    const { root, container } = await mountRoles(api, '主管')
    startEdit(container, 'desc')
    await act(async () => { setFieldValue(container.querySelector<HTMLTextAreaElement>('[data-router-collab-role-desc]')!, '新说明') })
    saveBlock(container, 'desc')
    await flush()
    await flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.name).toBe('主管')
    expect(posts[0]!.description).toBe('新说明')
    expect('models' in posts[0]!).toBe(false)
    // 既有候选没丢。
    expect(roles.find((r) => r.name === '主管')?.models).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
    expect(container.querySelector('[data-router-collab-role-desc]')).toBeNull()
    expect(container.querySelector('[data-router-collab-role-desc-text]')?.textContent).toContain('新说明')
    await act(async () => { root.unmount() })
  })

  it('候选块保存：请求体带当前名、当前说明与该块编辑后的完整候选', async () => {
    const { api, posts, roles } = rolesApi([{ name: '执行者', description: '职责', models: [{ provider: 'deepseek', model: 'deepseek-chat' }, { provider: 'openai', model: 'gpt-4o' }] }])
    const { root, container } = await mountRoles(api, '执行者')
    startEdit(container, 'models')
    click(container.querySelectorAll('[data-router-collab-model-delete]')[0]!)
    await flush()
    saveBlock(container, 'models')
    await flush()
    await flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.name).toBe('执行者')
    expect(posts[0]!.description).toBe('职责')
    expect(posts[0]!.models).toEqual([{ provider: 'openai', model: 'gpt-4o' }])
    expect(roles.find((r) => r.name === '执行者')?.models).toEqual([{ provider: 'openai', model: 'gpt-4o' }])
    expect(container.querySelector('[data-router-collab-model-delete]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('取消：丢弃该块改动、恢复只读显示值，不发请求也不动其它块', async () => {
    const { api, posts } = rolesApi([{ name: '主管', description: '旧说明', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }])
    const { root, container } = await mountRoles(api, '主管')
    startEdit(container, 'name')
    await act(async () => { setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!, '改坏了') })
    click(container.querySelector('[data-router-collab-role-name-cancel]')!)
    await flush()
    expect(posts).toHaveLength(0)
    expect(container.querySelector('[data-router-collab-role-name]')).toBeNull()
    expect(container.querySelector('[data-router-collab-role-name-text]')?.textContent).toContain('主管')
    expect(container.querySelector('[data-router-collab-role-desc-text]')?.textContent).toContain('旧说明')
    await act(async () => { root.unmount() })
  })

  it('页面上不存在统一保存按钮：只有三块各自的「保存」「取消」', async () => {
    const { api } = rolesApi([{ name: '主管', description: '旧说明', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }])
    const { root, container } = await mountRoles(api, '主管')
    // 三块都进编辑态。
    startEdit(container, 'name')
    startEdit(container, 'desc')
    startEdit(container, 'models')
    // 旧的统一保存选择器不复用。
    expect(container.querySelectorAll('[data-router-collab-role-save]')).toHaveLength(0)
    const saves = [...container.querySelectorAll('button')].filter((button) => button.textContent === '保存')
    expect(saves).toHaveLength(3)
    for (const button of saves) {
      const owned = button.hasAttribute('data-router-collab-role-name-save')
        || button.hasAttribute('data-router-collab-role-desc-save')
        || button.hasAttribute('data-router-collab-role-models-save')
      expect(owned).toBe(true)
    }
    const cancels = [...container.querySelectorAll('button')].filter((button) => button.textContent === '取消')
    expect(cancels).toHaveLength(3)
    await act(async () => { root.unmount() })
  })

  it('「添加模型」面板里没有「确定」：只有添加所选/清空选择/收起', async () => {
    const { api } = rolesApi([{ name: '主管', description: '旧说明' }], catalogFixture)
    const { root, container } = await mountRoles(api, '主管')
    openCatalog(container)
    await flush()
    const panel = container.querySelector('[data-router-collab-catalog-panel]')!
    expect(panel.textContent).not.toContain('确定')
    expect(panel.querySelectorAll('[data-router-collab-role-save]')).toHaveLength(0)
    const labels = [...panel.querySelectorAll('button')].map((button) => button.textContent!.trim())
    expect(labels).toEqual(['添加所选（0）', '清空选择', '收起'])
    await act(async () => { root.unmount() })
  })

  it('新建角色：名称块保存后进列表，说明块与候选块各自再保存', async () => {
    const { api, posts, roles } = rolesApi([], catalogFixture)
    const { root, container } = await mountRoles(api)
    click(container.querySelector('[data-router-collab-role-new]')!)
    await flush()
    // 新角色也是三块只读。
    expect(container.querySelector('[data-router-collab-role-name]')).toBeNull()
    expect(container.querySelector('[data-router-collab-role-name-text]')?.textContent).toContain('未命名')
    // 名称块保存 → 角色进列表。
    startEdit(container, 'name')
    await act(async () => { setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!, '执行者') })
    saveBlock(container, 'name')
    await flush()
    await flush()
    // 新建：第一次不带 id（服务端派生）；之后带 id。
    expect(posts[0]!.id).toBeUndefined()
    expect(roles.map((r) => r.name)).toContain('执行者')
    expect(container.querySelector('[data-router-collab-role-item="执行者"]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-role-name-text]')?.textContent).toContain('执行者')
    // 说明块保存。
    startEdit(container, 'desc')
    await act(async () => { setFieldValue(container.querySelector<HTMLTextAreaElement>('[data-router-collab-role-desc]')!, '做执行') })
    saveBlock(container, 'desc')
    await flush()
    await flush()
    expect(posts[1]).toMatchObject({ name: '执行者', description: '做执行' })
    expect(posts[1]!.id).toBe('id-执行者')
    expect('models' in posts[1]!).toBe(false)
    // 候选块保存。
    startEdit(container, 'models')
    openCatalog(container)
    await flush()
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    saveBlock(container, 'models')
    await flush()
    await flush()
    expect(posts[2]!.id).toBe('id-执行者')
    expect(posts[2]!.name).toBe('执行者')
    expect(posts[2]!.description).toBe('做执行')
    expect(posts[2]!.models).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
    await act(async () => { root.unmount() })
  })

  it('未保存提示按块给：只有动过的那块显示「未保存」', async () => {
    const { api } = rolesApi([{ name: '主管', description: '旧说明', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }])
    const { root, container } = await mountRoles(api, '主管')
    startEdit(container, 'desc')
    expect(container.querySelector('[data-router-collab-role-desc-dirty]')).toBeNull()
    await act(async () => { setFieldValue(container.querySelector<HTMLTextAreaElement>('[data-router-collab-role-desc]')!, '新说明') })
    expect(container.querySelector('[data-router-collab-role-desc-dirty]')?.textContent).toContain('未保存')
    expect(container.querySelector('[data-router-collab-role-name-dirty]')).toBeNull()
    expect(container.querySelector('[data-router-collab-role-models-dirty]')).toBeNull()
    // 没有全局未保存提示。
    expect(container.querySelector('[data-router-collab-role-dirty]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('保存失败：块内显示错误，草稿还在该块的编辑态里', async () => {
    const { api } = rolesApi([{ name: '主管', description: '旧说明' }])
    const failingApi: CollaborationApi = { ...api, saveRole: async () => { throw new Error('保存失败：网络') } }
    const { root, container } = await mountRoles(failingApi, '主管')
    startEdit(container, 'name')
    await act(async () => { setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!, '草稿角色') })
    saveBlock(container, 'name')
    await flush()
    expect(container.querySelector('[data-router-collab-role-error]')!.textContent).toContain('保存失败')
    expect((container.querySelector('[data-router-collab-role-name]') as HTMLInputElement).value).toBe('草稿角色')
    await act(async () => { root.unmount() })
  })

  it('左侧预览只用职责；候选只读显示名称，查不到显示 ID', async () => {
    const { api } = rolesApi([{ name: '测试工程师', description: '写测试用例并报告', models: [{ provider: 'deepseek', model: 'deepseek-chat' }, { provider: 'prov-secret', model: 'hidden-model' }] }], catalogFixture)
    const { root, container } = await mountRoles(api, '测试工程师')
    const item = container.querySelector('[data-router-collab-role-item="测试工程师"]')!
    expect(item.textContent).toContain('写测试用例并报告')
    expect(item.textContent).not.toContain('deepseek-chat')
    // 文本态：无输入框，一行一个模型。
    expect(container.querySelector('[data-router-collab-model-provider]')).toBeNull()
    expect(container.querySelectorAll('[data-router-collab-model-row]')).toHaveLength(2)
    const texts = [...container.querySelectorAll('[data-router-collab-model-text]')].map((el) => el.textContent)
    expect(texts[0]).toContain('DeepSeek'); expect(texts[0]).toContain('deepseek-chat')
    expect(texts[1]).toContain('prov-secret'); expect(texts[1]).toContain('hidden-model')
    await act(async () => { root.unmount() })
  })

  it('候选行点「编辑」切成两个输入框，改值收起后由候选块保存带 models', async () => {
    const { api, posts } = rolesApi([{ name: '测试工程师', description: '写测试用例并报告', models: [{ provider: 'prov-secret', model: 'hidden-model' }] }])
    const { root, container } = await mountRoles(api, '测试工程师')
    expect(container.querySelector('[data-router-collab-model-text]')?.textContent).toContain('prov-secret')
    startEdit(container, 'models')
    click(container.querySelector('[data-router-collab-model-edit]')!)
    await flush()
    const provider = container.querySelector<HTMLInputElement>('[data-router-collab-model-provider]')!
    const model = container.querySelector<HTMLInputElement>('[data-router-collab-model-model]')!
    await act(async () => {
      setFieldValue(provider, 'manual-provider')
      setFieldValue(model, 'manual-model')
    })
    click(container.querySelector('[data-router-collab-model-edit]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-model-provider]')).toBeNull()
    expect(container.querySelector('[data-router-collab-model-text]')?.textContent).toContain('manual-provider')
    saveBlock(container, 'models')
    await flush()
    await flush()
    expect(posts[0]!.models).toEqual([{ provider: 'manual-provider', model: 'manual-model' }])
    await act(async () => { root.unmount() })
  })

  it('只改说明块保存，候选未动则不带 models，保留既有候选', async () => {
    const { api, posts, roles } = rolesApi([{ name: '测试工程师', description: '旧说明', models: [{ provider: 'deepseek', model: 'deepseek-chat' }] }], catalogFixture)
    const { root, container } = await mountRoles(api, '测试工程师')
    startEdit(container, 'desc')
    await act(async () => { setFieldValue(container.querySelector<HTMLTextAreaElement>('[data-router-collab-role-desc]')!, '新说明') })
    saveBlock(container, 'desc')
    await flush()
    await flush()
    expect('models' in posts[0]!).toBe(false)
    expect(roles[0]!.models).toEqual([{ provider: 'deepseek', model: 'deepseek-chat' }])
    await act(async () => { root.unmount() })
  })

  it('候选行上移、下移、删除改变顺序（候选块编辑态内）', async () => {
    const { api } = rolesApi([{ name: '执行者', description: '职责', models: [{ provider: 'deepseek', model: 'deepseek-chat' }, { provider: 'openai', model: 'gpt-4o' }, { provider: 'deepseek', model: 'deepseek-reasoner' }] }], catalogFixture)
    const { root, container } = await mountRoles(api, '执行者')
    const texts = () => [...container.querySelectorAll('[data-router-collab-model-text]')].map((el) => el.textContent)
    expect(texts()[0]).toContain('deepseek-chat')
    startEdit(container, 'models')
    click(container.querySelectorAll('[data-router-collab-model-down]')[0]!)
    await flush()
    expect(texts()[1]).toContain('deepseek-chat')
    click(container.querySelectorAll('[data-router-collab-model-up]')[1]!)
    await flush()
    expect(texts()[0]).toContain('deepseek-chat')
    click(container.querySelectorAll('[data-router-collab-model-delete]')[0]!)
    await flush()
    expect(container.querySelectorAll('[data-router-collab-model-row]')).toHaveLength(2)
    expect(texts()[0]).toContain('gpt-4o')
    await act(async () => { root.unmount() })
  })

  it('添加面板默认收起，候选块编辑态里点「添加模型」展开，可收起', async () => {
    const { api } = rolesApi([{ name: '执行者', description: '职责' }], catalogFixture)
    const { root, container } = await mountRoles(api, '执行者')
    expect(container.querySelector('[data-router-collab-catalog-panel]')).toBeNull()
    expect(container.querySelector('[data-router-collab-catalog-query]')).toBeNull()
    // 只读态没有清单入口。
    expect(container.querySelector('[data-router-collab-catalog-open]')).toBeNull()
    startEdit(container, 'models')
    openCatalog(container)
    await flush()
    expect(container.querySelector('[data-router-collab-catalog-panel]')).toBeTruthy()
    expect(container.querySelector('[data-router-collab-catalog-query]')).toBeTruthy()
    click(container.querySelector('[data-router-collab-catalog-close]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-catalog-panel]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('候选模型区是独立的边框盒：有自己的边框、圆角与内边距', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    const box = container.querySelector<HTMLElement>('[data-router-collab-role-models]')!
    expect(box.style.border).toContain('1px solid')
    expect(box.style.borderRadius).not.toBe('')
    expect(box.style.padding).not.toBe('')
    await act(async () => { root.unmount() })
  })

  it('清单按提供方分组渲染，组标题带名称/ID/模型数，组内只列该提供方模型', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    openCatalog(container)
    await flush()
    const groups = container.querySelectorAll('[data-router-collab-catalog-group]')
    expect(groups).toHaveLength(2)
    expect(groups[0]!.getAttribute('data-router-collab-catalog-provider')).toBe('deepseek')
    expect(groups[0]!.textContent).toContain('DeepSeek')
    expect(groups[0]!.textContent).toContain('（deepseek）')
    expect(groups[0]!.textContent).toContain('2 个模型')
    expect(groups[0]!.querySelectorAll('[data-router-collab-catalog-option]')).toHaveLength(2)
    expect(groups[1]!.getAttribute('data-router-collab-catalog-provider')).toBe('openai')
    expect(groups[1]!.querySelectorAll('[data-router-collab-catalog-option]')).toHaveLength(1)
    const opt = groups[0]!.querySelector('[data-router-collab-catalog-option]')!
    expect(opt.textContent).toContain('Chat')
    expect(opt.textContent).toContain('（deepseek-chat）')
    await act(async () => { root.unmount() })
  })

  it('清单搜索框按名称/ID 过滤', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    openCatalog(container)
    await flush()
    const query = container.querySelector<HTMLInputElement>('[data-router-collab-catalog-query]')!
    expect(container.querySelectorAll('[data-router-collab-catalog-option]')).toHaveLength(3)
    await act(async () => { setFieldValue(query, 'deepseek') })
    await flush()
    expect(container.querySelectorAll('[data-router-collab-catalog-option]')).toHaveLength(2)
    await act(async () => { setFieldValue(query, 'gpt-4o') })
    await flush()
    expect(container.querySelectorAll('[data-router-collab-catalog-option]')).toHaveLength(1)
    expect(container.querySelector('[data-router-collab-catalog-option]')!.textContent).toContain('GPT-4o')
    await act(async () => { root.unmount() })
  })

  it('从清单多选添加；保存失败时 saveError 可见且草稿还在', async () => {
    let fail = false
    const { api } = rolesApi([{ name: '执行者', description: '职责' }], catalogFixture)
    const failingApi: CollaborationApi = {
      ...api,
      saveRole: async (input) => {
        if (fail) throw new Error('候选无效')
        return {
          id: input.id ?? `id-${input.name}`,
          name: input.name,
          description: input.description,
          ...(input.models !== undefined ? { models: input.models } : {}),
        }
      },
    }
    const { root, container } = await mountRoles(failingApi, '执行者')
    startEdit(container, 'models')
    openCatalog(container)
    await flush()
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-model-text]')?.textContent).toContain('deepseek-chat')
    fail = true
    saveBlock(container, 'models')
    await flush()
    expect(container.querySelector('[data-router-collab-role-error]')!.textContent).toContain('候选无效')
    expect(container.querySelector('[data-router-collab-model-text]')?.textContent).toContain('deepseek-chat')
    await act(async () => { root.unmount() })
  })

  it('多选按清单顺序一次追加；添加后面板保持展开并清空搜索与选择', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    openCatalog(container)
    await flush()
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-reasoner')))
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    const texts = [...container.querySelectorAll('[data-router-collab-model-text]')].map((el) => el.textContent)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('deepseek-chat')
    expect(texts[1]).toContain('deepseek-reasoner')
    expect(container.querySelector('[data-router-collab-catalog-panel]')).toBeTruthy()
    expect((container.querySelector('[data-router-collab-catalog-query]') as HTMLInputElement).value).toBe('')
    expect((container.querySelector('[data-router-collab-catalog-add]') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { root.unmount() })
  })

  it('已加入的模型标「已加入」且不可再勾选，未加入的仍可选', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    openCatalog(container)
    await flush()
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    expect(container.querySelectorAll('[data-router-collab-model-row]')).toHaveLength(1)
    expect(container.querySelector('[data-router-collab-catalog-panel]')).toBeTruthy()
    const added = catalogOptionRow(container, 'deepseek', 'deepseek-chat')
    expect(catalogCheckbox(added).disabled).toBe(true)
    expect(added.querySelector('[data-router-collab-catalog-added]')?.textContent).toContain('已加入')
    expect(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-reasoner')).disabled).toBe(false)
    await act(async () => { root.unmount() })
  })

  it('勾选后缩小搜索，隐藏的已勾选项与可见项一起按清单顺序追加', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    openCatalog(container)
    await flush()
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    const query = container.querySelector<HTMLInputElement>('[data-router-collab-catalog-query]')!
    await act(async () => { setFieldValue(query, 'openai') })
    await flush()
    click(catalogCheckbox(catalogOptionRow(container, 'openai', 'gpt-4o')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    const texts = [...container.querySelectorAll('[data-router-collab-model-text]')].map((el) => el.textContent)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('deepseek-chat')
    expect(texts[1]).toContain('gpt-4o')
    await act(async () => { root.unmount() })
  })

  it('候选值带首尾空格时，清单按 trim 判为已加入且不可勾选', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    openCatalog(container)
    await flush()
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    click(container.querySelector('[data-router-collab-model-edit]')!)
    await flush()
    await act(async () => {
      setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-model-provider]')!, ' deepseek ')
      setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-model-model]')!, ' deepseek-chat ')
    })
    click(container.querySelector('[data-router-collab-model-edit]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-catalog-panel]')).toBeTruthy()
    const row = catalogOptionRow(container, 'deepseek', 'deepseek-chat')
    expect(catalogCheckbox(row).disabled).toBe(true)
    expect(row.querySelector('[data-router-collab-catalog-added]')?.textContent).toContain('已加入')
    await act(async () => { root.unmount() })
  })

  it('清空选择：勾选后一键清空，不追加任何候选', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    openCatalog(container)
    await flush()
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    click(catalogCheckbox(catalogOptionRow(container, 'openai', 'gpt-4o')))
    await flush()
    const addBtn = container.querySelector<HTMLButtonElement>('[data-router-collab-catalog-add]')!
    expect(addBtn.disabled).toBe(false)
    click(container.querySelector('[data-router-collab-catalog-clear]')!)
    await flush()
    expect(addBtn.disabled).toBe(true)
    expect(container.querySelectorAll('[data-router-collab-model-row]')).toHaveLength(0)
    await act(async () => { root.unmount() })
  })

  it('切换角色重置面板展开状态、勾选与搜索词', async () => {
    const { api } = rolesApi([{ name: '执行者', description: '职责', models: [] }, { name: '评审员', description: '评审' }], catalogFixture)
    const { root, container } = await mountRoles(api, '执行者')
    openCatalog(container)
    await flush()
    await act(async () => { setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-catalog-query]')!, 'deepseek') })
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    expect(container.querySelector('[data-router-collab-catalog-panel]')).toBeTruthy()
    click(container.querySelector('[data-router-collab-role-item="评审员"]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-catalog-panel]')).toBeNull()
    expect(container.querySelector('[data-router-collab-catalog-open]')).toBeNull()
    openCatalog(container)
    await flush()
    expect((container.querySelector('[data-router-collab-catalog-query]') as HTMLInputElement).value).toBe('')
    expect((container.querySelector('[data-router-collab-catalog-add]') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { root.unmount() })
  })

  it('无匹配显示明确状态', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    openCatalog(container)
    await flush()
    const query = container.querySelector<HTMLInputElement>('[data-router-collab-catalog-query]')!
    await act(async () => { setFieldValue(query, '不存在的模型') })
    await flush()
    expect(container.querySelector('[data-router-collab-catalog-status]')?.textContent).toContain('无匹配')
    expect(container.querySelectorAll('[data-router-collab-catalog-option]')).toHaveLength(0)
    await act(async () => { root.unmount() })
  })

  it('空清单显示明确状态', async () => {
    const { root, container } = await mountRolesNew(catalogApi({ unavailable: false, providers: [] }))
    openCatalog(container)
    await flush()
    expect(container.querySelector('[data-router-collab-catalog-status]')?.textContent).toContain('清单为空')
    await act(async () => { root.unmount() })
  })

  it('清单不可用显示状态，既有手工候选行仍可编辑保存', async () => {
    const { api, posts } = rolesApi([{ name: '执行者', description: '职责', models: [{ provider: 'manual-provider', model: 'manual-model' }] }])
    const { root, container } = await mountRoles(api, '执行者')
    expect(container.querySelector('[data-router-collab-model-text]')?.textContent).toContain('manual-provider')
    openCatalog(container)
    await flush()
    expect(container.querySelector('[data-router-collab-catalog-status]')?.textContent).toContain('清单不可用')
    click(container.querySelector('[data-router-collab-catalog-close]')!)
    await flush()
    click(container.querySelector('[data-router-collab-model-edit]')!)
    await flush()
    await act(async () => {
      setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-model-provider]')!, 'manual-provider-2')
      setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-model-model]')!, 'manual-model-2')
    })
    click(container.querySelector('[data-router-collab-model-edit]')!)
    await flush()
    saveBlock(container, 'models')
    await flush()
    await flush()
    expect(posts[0]!.models).toEqual([{ provider: 'manual-provider-2', model: 'manual-model-2' }])
    await act(async () => { root.unmount() })
  })

  it('rolesError 时不保存，避免把加载失败当成空候选', async () => {
    let saves = 0
    const api: CollaborationApi = {
      listRecords: async () => [],
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => { throw new Error('角色列表坏了') },
      listModelCatalog: async () => ({ unavailable: true, providers: [] }),
      saveRole: async (input) => { saves += 1; return { id: input.id ?? `id-${input.name}`, name: input.name, description: input.description } },
    }
    const store = startCollaborationStore({ api })
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    click(container.querySelector('[data-router-collab-tab="roles"]')!)
    await flush()
    click(container.querySelector('[data-router-collab-role-new]')!)
    await flush()
    startEdit(container, 'name')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(container.querySelector('[data-router-collab-role-name]')!, '执行者')
      container.querySelector('[data-router-collab-role-name]')!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = container.querySelector<HTMLButtonElement>('[data-router-collab-role-name-save]')!
    expect(save.disabled).toBe(true)
    click(save)
    await flush()
    expect(saves).toBe(0)
    await act(async () => { root.unmount() })
  })
})

describe('staleasyncresultsignored — 切换根后旧响应不落地', () => {
  it('根 A 在途时切到根 B：显示 B 的空态，不出现 A 的记录', async () => {
    let resolveA: (r: WorkRecord[]) => void = () => {}
    const api: CollaborationApi = {
      listRecords: (id) => id === 'root-A' ? new Promise<WorkRecord[]>((resolve) => { resolveA = resolve }) : Promise.resolve([]),
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => [],
      saveRole: async (input) => ({ id: input.id ?? `id-${input.name}`, name: input.name, description: input.description }),
      listModelCatalog: async () => ({ unavailable: true, providers: [] }),
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
    expect(container.querySelectorAll('[data-router-collab-task-item]')).toHaveLength(0)
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
    expect(container.querySelector('[data-router-collab-task-detail]')?.textContent).toContain(reportRecord.body)
    act(() => { store.setCurrentSession('root-B') })
    await flush()
    expect(store.get().records).toEqual([])
    expect(store.get().selectedRecord).toBeUndefined()
    expect(container.querySelectorAll('[data-router-collab-task-item]')).toHaveLength(0)
    expect(container.querySelector('[data-router-collab-task-detail]')).toBeNull()
    await act(async () => { root.unmount() })
  })
})
