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
  const row = container.querySelector(`[data-router-collab-catalog-provider="${provider}"][data-router-collab-catalog-model="${model}"]`)
  if (row === null) throw new Error(`catalog option not found: ${provider} / ${model}`)
  return row as HTMLElement
}

function catalogCheckbox(row: HTMLElement): HTMLInputElement {
  const checkbox = row.querySelector<HTMLInputElement>('[data-router-collab-catalog-checkbox]')
  if (checkbox === null) throw new Error('catalog checkbox not found')
  return checkbox
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
    saveRole: async (input) => ({ name: input.name, description: input.description, models: input.models }),
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

describe('role edit shared manual/model — 视图页保存与模型工具共享同一 RoleStore', () => {
  it('切到角色标签：左侧列表；新建 → 右侧编辑 → 保存后进入列表并保持选中', async () => {
    const saved: RoleTemplate = { name: '测试工程师', description: '写测试' }
    let roles: RoleTemplate[] = []
    const api: CollaborationApi = {
      listRecords: async () => [],
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => roles,
      saveRole: async (input) => { roles = [saved]; return saved },
      listModelCatalog: async () => ({ unavailable: true, providers: [] }),
    }
    const store = startCollaborationStore({ api })
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    // 默认任务标签：角色编辑器不可见。
    expect(container.querySelector('[data-router-collab-role-name]')).toBeNull()
    click(container.querySelector('[data-router-collab-tab="roles"]')!)
    await flush()
    expect(container.querySelectorAll('[data-router-collab-role-item]')).toHaveLength(0)
    // 默认收起编辑器：未选角色前只有占位引导。
    expect(container.querySelector('[data-router-collab-role-name]')).toBeNull()
    expect(container.querySelector('[data-router-collab-role-editor]')).toBeTruthy()
    click(container.querySelector('[data-router-collab-role-new]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-role-item="__draft__"]')).toBeTruthy()
    const nameInput = container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!
    const descInput = container.querySelector<HTMLTextAreaElement>('[data-router-collab-role-desc]')!
    await act(async () => {
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      inputSetter.call(nameInput, '测试工程师')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      const areaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      areaSetter.call(descInput, '写测试')
      descInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[data-router-collab-role-dirty]')).toBeTruthy()
    click(container.querySelector('[data-router-collab-role-save]')!)
    await flush()
    await flush()
    const items = container.querySelectorAll('[data-router-collab-role-item]')
    expect([...items].some((t) => t.textContent!.includes('测试工程师'))).toBe(true)
    expect((container.querySelector('[data-router-collab-role-name]') as HTMLInputElement).value).toBe('测试工程师')
    expect(container.querySelector('[data-router-collab-role-dirty]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('编辑既有角色：职责为多行编辑框，保存即更新且未保存标记消失', async () => {
    let roles: RoleTemplate[] = [{ name: '主管', description: '旧说明' }]
    const api: CollaborationApi = {
      listRecords: async () => [],
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => roles,
      saveRole: async (input) => { roles = [{ name: input.name, description: input.description }]; return { name: input.name, description: input.description } },
      listModelCatalog: async () => ({ unavailable: true, providers: [] }),
    }
    const store = startCollaborationStore({ api })
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    click(container.querySelector('[data-router-collab-tab="roles"]')!)
    await flush()
    click(container.querySelector('[data-router-collab-role-item="主管"]')!)
    await flush()
    const descInput = container.querySelector<HTMLTextAreaElement>('[data-router-collab-role-desc]')!
    expect(descInput.value).toBe('旧说明')
    // 编辑框高度翻倍（440px）。
    expect(descInput.style.minHeight).toBe('440px')
    await act(async () => {
      const areaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      areaSetter.call(descInput, '第一行：拆解任务\n第二行：汇总结果')
      descInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[data-router-collab-role-dirty]')).toBeTruthy()
    click(container.querySelector('[data-router-collab-role-save]')!)
    await flush()
    await flush()
    expect((container.querySelector('[data-router-collab-role-desc]') as HTMLTextAreaElement).value).toContain('第二行：汇总结果')
    expect(container.querySelector('[data-router-collab-role-dirty]')).toBeNull()
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
    click(container.querySelector('[data-router-collab-tab="roles"]')!)
    await flush()
    click(container.querySelector('[data-router-collab-role-new]')!)
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

  it('左侧预览只用职责；候选可手工填写，保存请求体带 models', async () => {
    let roles: RoleTemplate[] = [{ name: '测试工程师', description: '写测试用例并报告', models: [{ provider: 'prov-secret', model: 'hidden-model' }] }]
    let posted: { name: string; description: string; models?: Array<{ provider: string; model: string }> } | undefined
    const api: CollaborationApi = {
      listRecords: async () => [],
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => roles,
      listModelCatalog: async () => ({ unavailable: true, providers: [] }),
      saveRole: async (input) => {
        posted = input
        roles = [{ name: input.name, description: input.description, models: input.models }]
        return roles[0]!
      },
    }
    const store = startCollaborationStore({ api })
    const props = baseProps(store)
    const { root, container } = render(props)
    await act(async () => { root.render(createElement(CollaborationView, props)) })
    await flush()
    click(container.querySelector('[data-router-collab-tab="roles"]')!)
    await flush()
    const item = container.querySelector('[data-router-collab-role-item="测试工程师"]')!
    expect(item.textContent).toContain('写测试用例并报告')
    expect(item.textContent).not.toContain('prov-secret')
    click(item)
    await flush()
    expect((container.querySelector('[data-router-collab-model-provider]') as HTMLInputElement).value).toBe('prov-secret')
    const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    click(container.querySelector('[data-router-collab-model-add]')!)
    await flush()
    const providers = container.querySelectorAll<HTMLInputElement>('[data-router-collab-model-provider]')
    const modelInputs = container.querySelectorAll<HTMLInputElement>('[data-router-collab-model-model]')
    await act(async () => {
      setValue(providers[1]!, 'manual-provider')
      setValue(modelInputs[1]!, 'manual-model')
    })
    click(container.querySelector('[data-router-collab-role-save]')!)
    await flush()
    await flush()
    expect(posted?.models).toEqual([
      { provider: 'prov-secret', model: 'hidden-model' },
      { provider: 'manual-provider', model: 'manual-model' },
    ])
    await act(async () => { root.unmount() })
  })

  it('从清单多选添加；400 时 saveError 可见且草稿还在', async () => {
    let fail = false
    const api = catalogApi(catalogFixture, {
      saveRole: async (input) => {
        if (fail) throw new Error('候选无效')
        return { name: input.name, description: input.description, models: input.models }
      },
    })
    const { root, container } = await mountRolesNew(api)
    const nameInput = container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!
    await act(async () => { setFieldValue(nameInput, '执行者') })
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    expect((container.querySelector('[data-router-collab-model-provider]') as HTMLInputElement).value).toBe('deepseek')
    expect((container.querySelector('[data-router-collab-model-model]') as HTMLInputElement).value).toBe('deepseek-chat')
    fail = true
    click(container.querySelector('[data-router-collab-role-save]')!)
    await flush()
    expect(container.querySelector('[data-router-collab-role-error]')!.textContent).toContain('候选无效')
    expect((container.querySelector('[data-router-collab-role-name]') as HTMLInputElement).value).toBe('执行者')
    expect((container.querySelector('[data-router-collab-model-model]') as HTMLInputElement).value).toBe('deepseek-chat')
    await act(async () => { root.unmount() })
  })

  it('清单搜索框按名称/ID 过滤，每条完整显示 provider 与 model', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    const query = container.querySelector<HTMLInputElement>('[data-router-collab-catalog-query]')!
    // 无关键词：显示全部 3 条。
    expect(container.querySelectorAll('[data-router-collab-catalog-option]')).toHaveLength(3)
    await act(async () => { setFieldValue(query, 'deepseek') })
    await flush()
    const rows = container.querySelectorAll('[data-router-collab-catalog-option]')
    expect(rows).toHaveLength(2)
    // 每条结果同时展示 provider 名称/ID 与 model 名称/ID。
    const first = rows[0]!.textContent!
    expect(first).toContain('DeepSeek'); expect(first).toContain('deepseek'); expect(first).toContain('Chat'); expect(first).toContain('deepseek-chat')
    // 按 model ID 过滤。
    await act(async () => { setFieldValue(query, 'gpt-4o') })
    await flush()
    const one = container.querySelectorAll('[data-router-collab-catalog-option]')
    expect(one).toHaveLength(1)
    expect(one[0]!.textContent).toContain('OpenAI')
    await act(async () => { root.unmount() })
  })

  it('多选按清单顺序一次追加，添加后清空搜索与选择', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    // 反向点击：证明追加顺序来自清单而非点击顺序。
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-reasoner')))
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    const providers = [...container.querySelectorAll('[data-router-collab-model-provider]')].map((el) => (el as HTMLInputElement).value)
    const models = [...container.querySelectorAll('[data-router-collab-model-model]')].map((el) => (el as HTMLInputElement).value)
    expect(providers).toEqual(['deepseek', 'deepseek'])
    expect(models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    // 添加后搜索与内部选择一并清空。
    expect((container.querySelector('[data-router-collab-catalog-query]') as HTMLInputElement).value).toBe('')
    expect((container.querySelector('[data-router-collab-catalog-add]') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { root.unmount() })
  })

  it('添加时跳过已有相同 provider+model（去重）', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    expect(container.querySelectorAll('[data-router-collab-model-row]')).toHaveLength(1)
    // 再次勾选同一项并添加：应被跳过。
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    expect(container.querySelectorAll('[data-router-collab-model-row]')).toHaveLength(1)
    await act(async () => { root.unmount() })
  })

  it('勾选后缩小搜索，隐藏的已勾选项与可见项一起按清单顺序追加', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    // 先勾选 deepseek-chat。
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    // 再搜索 openai 并勾选 gpt-4o；此刻可见列表只剩 openai。
    const query = container.querySelector<HTMLInputElement>('[data-router-collab-catalog-query]')!
    await act(async () => { setFieldValue(query, 'openai') })
    await flush()
    click(catalogCheckbox(catalogOptionRow(container, 'openai', 'gpt-4o')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    const providers = [...container.querySelectorAll('[data-router-collab-model-provider]')].map((el) => (el as HTMLInputElement).value)
    const models = [...container.querySelectorAll('[data-router-collab-model-model]')].map((el) => (el as HTMLInputElement).value)
    expect(providers).toEqual(['deepseek', 'openai'])
    expect(models).toEqual(['deepseek-chat', 'gpt-4o'])
    await act(async () => { root.unmount() })
  })

  it('手工候选带首尾空格时，清单添加按 trim 去重且不改保存值', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    // 手工添加一行并填入带空格的 provider/model。
    click(container.querySelector('[data-router-collab-model-add]')!)
    await flush()
    const provider = container.querySelectorAll<HTMLInputElement>('[data-router-collab-model-provider]')[0]!
    const model = container.querySelectorAll<HTMLInputElement>('[data-router-collab-model-model]')[0]!
    await act(async () => {
      setFieldValue(provider, ' deepseek ')
      setFieldValue(model, ' deepseek-chat ')
    })
    // 从清单勾选同项并添加：trim 后判为已有，应被跳过。
    click(catalogCheckbox(catalogOptionRow(container, 'deepseek', 'deepseek-chat')))
    await flush()
    click(container.querySelector('[data-router-collab-catalog-add]')!)
    await flush()
    expect(container.querySelectorAll('[data-router-collab-model-row]')).toHaveLength(1)
    // 保存值仍是带空格的原文，不被去重逻辑改动。
    expect((container.querySelector('[data-router-collab-model-provider]') as HTMLInputElement).value).toBe(' deepseek ')
    await act(async () => { root.unmount() })
  })

  it('清空选择：勾选后一键清空，不追加任何候选', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
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

  it('无匹配显示明确状态', async () => {
    const { root, container } = await mountRolesNew(catalogApi(catalogFixture))
    const query = container.querySelector<HTMLInputElement>('[data-router-collab-catalog-query]')!
    await act(async () => { setFieldValue(query, '不存在的模型') })
    await flush()
    expect(container.querySelector('[data-router-collab-catalog-status]')?.textContent).toContain('无匹配')
    expect(container.querySelectorAll('[data-router-collab-catalog-option]')).toHaveLength(0)
    await act(async () => { root.unmount() })
  })

  it('空清单显示明确状态', async () => {
    const { root, container } = await mountRolesNew(catalogApi({ unavailable: false, providers: [] }))
    expect(container.querySelector('[data-router-collab-catalog-status]')?.textContent).toContain('清单为空')
    await act(async () => { root.unmount() })
  })

  it('清单不可用显示状态，手工候选行仍可编辑保存', async () => {
    let posted: { name: string; description: string; models?: Array<{ provider: string; model: string }> } | undefined
    const api = catalogApi({ unavailable: true, providers: [] }, {
      saveRole: async (input) => {
        posted = input
        return { name: input.name, description: input.description, models: input.models }
      },
    })
    const { root, container } = await mountRolesNew(api)
    expect(container.querySelector('[data-router-collab-catalog-status]')?.textContent).toContain('清单不可用')
    // 手工候选行在清单不可用时仍可编辑保存。
    click(container.querySelector('[data-router-collab-model-add]')!)
    await flush()
    const provider = container.querySelectorAll<HTMLInputElement>('[data-router-collab-model-provider]')[0]!
    const model = container.querySelectorAll<HTMLInputElement>('[data-router-collab-model-model]')[0]!
    await act(async () => {
      setFieldValue(container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!, '执行者')
      setFieldValue(provider, 'manual-provider')
      setFieldValue(model, 'manual-model')
    })
    click(container.querySelector('[data-router-collab-role-save]')!)
    await flush()
    await flush()
    expect(posted?.models).toEqual([{ provider: 'manual-provider', model: 'manual-model' }])
    await act(async () => { root.unmount() })
  })

  it('rolesError 时不保存，避免把加载失败当成空候选', async () => {
    let saves = 0
    const api: CollaborationApi = {
      listRecords: async () => [],
      readRecord: async () => ({ record: {} as WorkRecord, path: '' }),
      listRoles: async () => { throw new Error('角色列表坏了') },
      listModelCatalog: async () => ({ unavailable: true, providers: [] }),
      saveRole: async (input) => { saves += 1; return { name: input.name, description: input.description } },
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
    const nameInput = container.querySelector<HTMLInputElement>('[data-router-collab-role-name]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, '执行者')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = container.querySelector<HTMLButtonElement>('[data-router-collab-role-save]')!
    expect(save.disabled).toBe(true)
    click(save)
    await flush()
    expect(saves).toBe(0)
    expect(nameInput.value).toBe('执行者')
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
      saveRole: async (input) => ({ name: input.name, description: input.description }),
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
