// @vitest-environment jsdom
/**
 * 设置段真实渲染回归（2026-11 提示词 UI 移除，先红后绿）。
 *
 * 用真 React（createRoot + act）渲染 RouterSettingsSection，驱动真实 DOM 事件，
 * 断言移除后的界面行为（不是源码正则）：
 * 1. 设置页没有任何提示词输入（Worker 类型表单无「系统提示词」多行框；
 *    Router 默认区无「默认系统提示词」多行框——整页零 textarea）；
 * 2. 新建类型（worker / supervisor）不需要提示词即可保存，create 请求体
 *    不带 systemPrompt 键（尤其不是空串——宿主 ?? 只挡 nullish）；
 * 3. 编辑类型保存时 patch 不带 systemPrompt 键（宿主逐字保留既有值）；
 * 4. Router 默认区只改默认模型保存时，请求体仍带上未动的既有
 *    routerSystemPrompt（宿主路由两字段都必填，丢值即清空）。
 *
 * 假体只替换边界：api（记录调用并回放固定数据）与 prefs（内存 store），
 * 真组件真 DOM 事件，不 mock React。
 */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { RouterSettingsSection } from '../src/client/settings.tsx'
import type { RouterApi } from '../src/client/api.ts'
import type { ClientPrefsStore } from '../src/client/client-prefs.ts'
import { defaultClientPrefs } from '../src/client/client-prefs.ts'
import type { RouterDefaults, WorkerTypeRecord } from '../src/shared/view-contract.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let seq = 0
function typeRecord(overrides: Partial<WorkerTypeRecord> = {}): WorkerTypeRecord {
  seq += 1
  const at = 1000 + seq
  return {
    templateId: `t-${seq}`,
    name: `类型${seq}`,
    description: '',
    role: 'worker',
    models: ['p/m', 'p/x'],
    systemPrompt: '  既有提示词，首尾有空白。  ',
    skills: [],
    enabled: true,
    origin: 'user',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

const DEFAULTS: RouterDefaults = { routerSystemPrompt: '既有默认提示词，保存默认模型时必须原样带回。', routerModel: '' }

/** 记录型假 api：加载面回放固定数据，写面记录请求体。 */
function makeApi(types: WorkerTypeRecord[]): RouterApi & {
  created: unknown[]
  updates: unknown[]
  defaultsSaved: RouterDefaults[]
} {
  const face = {
    created: [] as unknown[],
    updates: [] as unknown[],
    defaultsSaved: [] as RouterDefaults[],
    listWorkerTypes: () => Promise.resolve(types.map((record) => ({ ...record }))),
    getDefaults: () => Promise.resolve({ ...DEFAULTS }),
    getSpawnMode: () => Promise.resolve({ mode: 'cache-priority' as const }),
    saveSpawnMode: (mode: 'cache-priority' | 'minimal-face') => Promise.resolve({ mode }),
    createWorkerType: (input: unknown) => {
      face.created.push(input)
      return Promise.resolve(typeRecord({ ...(input as object) }))
    },
    updateWorkerType: (request: unknown) => {
      face.updates.push(request)
      return Promise.resolve(typeRecord())
    },
    setWorkerTypeEnabled: (request: { templateId: string; enabled: boolean }) => Promise.resolve(typeRecord({ enabled: request.enabled })),
    removeWorkerType: (_templateId: string) => Promise.resolve(),
    saveDefaults: (value: RouterDefaults) => {
      face.defaultsSaved.push({ ...value })
      return Promise.resolve({ ...value })
    },
  }
  return face as unknown as RouterApi & { created: unknown[]; updates: unknown[]; defaultsSaved: RouterDefaults[] }
}

/** 内存偏好 store（设置段只读展示）。 */
function makePrefs(): ClientPrefsStore {
  let current = defaultClientPrefs()
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    act(() => { root.unmount() })
    container.remove()
  }
})

async function renderSettings(api: RouterApi): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => { root.render(createElement(RouterSettingsSection, { prefs: makePrefs(), api })) })
  await flush()
  return container
}

/** 冲刷微任务链（加载 Promise 链里的 dispatch 要落在 act 内）。 */
async function flush(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) })
}

function button(container: HTMLElement, tag: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[data-router-settings-button="${tag}"]`)
  expect(found, `按钮 ${tag} 应存在`).toBeTruthy()
  return found!
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

describe('设置段真实渲染：提示词输入已移除', () => {
  it('整页没有任何提示词 textarea（类型表单与 Router 默认区都没有）', async () => {
    const container = await renderSettings(makeApi([typeRecord()]))
    // 默认区（加载即渲染）与类型列表都不带提示词输入。
    expect(container.querySelector('[data-router-defaults-prompt]')).toBeNull()
    await act(async () => { button(container, 'types-new').click() })
    await flush()
    expect(container.querySelector('[data-router-type-form="new"]')).not.toBeNull()
    expect(container.querySelector('[data-router-type-prompt]')).toBeNull()
    expect(container.querySelectorAll('textarea').length, '设置页不应残留任何多行输入').toBe(0)
  })

  it('新建 worker 类型：只填名称即可保存，create 请求体不带 systemPrompt 键', async () => {
    const api = makeApi([])
    const container = await renderSettings(api)
    await act(async () => { button(container, 'types-new').click() })
    await flush()
    setValue(container.querySelector<HTMLInputElement>('[data-router-type-name]')!, '无提示词工人')
    await act(async () => { button(container, 'form-save').click() })
    await flush()
    expect(api.created).toHaveLength(1)
    const payload = api.created[0] as Record<string, unknown>
    expect(payload['name']).toBe('无提示词工人')
    expect('systemPrompt' in payload, 'create 不得带 systemPrompt 键（空串会盖掉宿主按角色默认）').toBe(false)
  })

  it('新建 supervisor 类型：无需提示词仍可创建，role 上送、请求体不带 systemPrompt 键', async () => {
    const api = makeApi([])
    const container = await renderSettings(api)
    await act(async () => { button(container, 'types-new').click() })
    await flush()
    setValue(container.querySelector<HTMLInputElement>('[data-router-type-name]')!, '无提示词主管')
    setValue(container.querySelector<HTMLSelectElement>('[data-router-type-role]')!, 'supervisor')
    await act(async () => { button(container, 'form-save').click() })
    await flush()
    expect(api.created).toHaveLength(1)
    const payload = api.created[0] as Record<string, unknown>
    expect(payload['role']).toBe('supervisor')
    expect('systemPrompt' in payload).toBe(false)
  })

  it('编辑既有类型：改名保存，patch 不带 systemPrompt 键（宿主逐字保留旧值）', async () => {
    const existing = typeRecord({ templateId: 't-edit', name: '旧名' })
    const api = makeApi([existing])
    const container = await renderSettings(api)
    await act(async () => { button(container, 'edit-t-edit').click() })
    await flush()
    expect(container.querySelector('[data-router-type-prompt]')).toBeNull()
    setValue(container.querySelector<HTMLInputElement>('[data-router-type-name]')!, '新名')
    await act(async () => { button(container, 'form-save').click() })
    await flush()
    expect(api.updates).toHaveLength(1)
    const request = api.updates[0] as { templateId: string; patch: Record<string, unknown> }
    expect(request.templateId).toBe('t-edit')
    expect(request.patch['name']).toBe('新名')
    expect('systemPrompt' in request.patch, 'update patch 不得带 systemPrompt 键（带上即覆盖既有值）').toBe(false)
  })

  it('Router 默认区：只改默认模型保存，routerSystemPrompt 原样带回不丢值', async () => {
    const api = makeApi([typeRecord()])
    const container = await renderSettings(api)
    expect(container.querySelector('[data-router-defaults-prompt]')).toBeNull()
    setValue(container.querySelector<HTMLSelectElement>('[data-router-defaults-model]')!, 'p/m')
    await act(async () => { button(container, 'defaults-save').click() })
    await flush()
    expect(api.defaultsSaved).toHaveLength(1)
    expect(api.defaultsSaved[0]).toEqual({ routerSystemPrompt: DEFAULTS.routerSystemPrompt, routerModel: 'p/m' })
  })
})
