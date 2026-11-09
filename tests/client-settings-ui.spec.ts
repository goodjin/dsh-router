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
 * act 边界纪律：所有会触发 React 状态更新的动作（输入事件、点击、异步
 * dispatch 的 settle）都包在 act 里——setValue 内部包 act；异步保存/加载以
 * 「完成的 UI 状态」为准轮询等待（表单关掉回到列表 / 脏标记清除），每拍
 * 一个宏任务 tick 且同样包在 act 内，等到才断言。不 mock console、不用
 * 固定 sleep。假体只替换边界：api（记录调用并回放固定数据）与 prefs
 * （内存 store），真组件真 DOM 事件，不 mock React。
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
    await act(async () => { root.unmount() })
    container.remove()
  }
})

/** 渲染并等到「加载完成」的 UI 证据（默认区出现 = loaded 已 dispatch）。 */
async function renderSettings(api: RouterApi): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => { root.render(createElement(RouterSettingsSection, { prefs: makePrefs(), api })) })
  await waitUntil(container, () => container.querySelector('[data-router-defaults-section]') !== null, '设置段加载完成（默认区渲染）')
  return container
}

/**
 * 轮询等待断言条件成立：每拍一个宏任务 tick 且整拍包在 act 里——期间任何
 * 异步 dispatch 的 settle 都落在 act 内；条件成立立即返回。不固定 sleep
 * （按条件轮询），到上限仍不成立则如实抛错（不吞、不静默）。
 */
async function waitUntil(container: HTMLElement, ready: () => boolean, what: string, maxTicks = 50): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (ready()) return
    await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) })
  }
  if (ready()) return
  throw new Error(`等待超时：${what}`)
}

/** 点击（同步 dispatch 在 act 内）。 */
async function click(container: HTMLElement, tag: string): Promise<void> {
  const found = container.querySelector<HTMLButtonElement>(`[data-router-settings-button="${tag}"]`)
  expect(found, `按钮 ${tag} 应存在`).toBeTruthy()
  await act(async () => { found!.click() })
}

/** 受控输入赋值：原生 value setter + input/change 事件，整段包 act。 */
async function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

function mustQuery<E extends Element>(container: HTMLElement, selector: string): E {
  const found = container.querySelector<E>(selector)
  expect(found, `${selector} 应存在`).toBeTruthy()
  return found!
}

/** 类型表单是否已关（保存成功 = save-done 关表单回到列表）。 */
function formClosed(container: HTMLElement): boolean {
  return container.querySelector('[data-router-type-form]') === null
}

describe('设置段真实渲染：提示词输入已移除', () => {
  it('整页没有任何提示词 textarea（类型表单与 Router 默认区都没有）', async () => {
    const container = await renderSettings(makeApi([typeRecord()]))
    // 默认区（加载即渲染）与类型列表都不带提示词输入。
    expect(container.querySelector('[data-router-defaults-prompt]')).toBeNull()
    await click(container, 'types-new')
    await waitUntil(container, () => container.querySelector('[data-router-type-form="new"]') !== null, '新建表单打开')
    expect(container.querySelector('[data-router-type-prompt]')).toBeNull()
    expect(container.querySelectorAll('textarea').length, '设置页不应残留任何多行输入').toBe(0)
  })

  it('新建 worker 类型：只填名称即可保存，create 请求体不带 systemPrompt 键', async () => {
    const api = makeApi([])
    const container = await renderSettings(api)
    await click(container, 'types-new')
    await waitUntil(container, () => container.querySelector('[data-router-type-form="new"]') !== null, '新建表单打开')
    await setValue(mustQuery<HTMLInputElement>(container, '[data-router-type-name]'), '无提示词工人')
    await click(container, 'form-save')
    // 等保存链路全部 settle：save-done 关表单回到列表。
    await waitUntil(container, () => formClosed(container), '保存完成（表单关闭返回列表）')
    expect(api.created).toHaveLength(1)
    const payload = api.created[0] as Record<string, unknown>
    expect(payload['name']).toBe('无提示词工人')
    expect('systemPrompt' in payload, 'create 不得带 systemPrompt 键（空串会盖掉宿主按角色默认）').toBe(false)
  })

  it('新建 supervisor 类型：无需提示词仍可创建，role 上送、请求体不带 systemPrompt 键', async () => {
    const api = makeApi([])
    const container = await renderSettings(api)
    await click(container, 'types-new')
    await waitUntil(container, () => container.querySelector('[data-router-type-form="new"]') !== null, '新建表单打开')
    await setValue(mustQuery<HTMLInputElement>(container, '[data-router-type-name]'), '无提示词主管')
    await setValue(mustQuery<HTMLSelectElement>(container, '[data-router-type-role]'), 'supervisor')
    await click(container, 'form-save')
    await waitUntil(container, () => formClosed(container), '保存完成（表单关闭返回列表）')
    expect(api.created).toHaveLength(1)
    const payload = api.created[0] as Record<string, unknown>
    expect(payload['role']).toBe('supervisor')
    expect('systemPrompt' in payload).toBe(false)
  })

  it('编辑既有类型：改名保存，patch 不带 systemPrompt 键（宿主逐字保留旧值）', async () => {
    const existing = typeRecord({ templateId: 't-edit', name: '旧名' })
    const api = makeApi([existing])
    const container = await renderSettings(api)
    await click(container, 'edit-t-edit')
    await waitUntil(container, () => container.querySelector('[data-router-type-form="t-edit"]') !== null, '编辑表单打开')
    expect(container.querySelector('[data-router-type-prompt]')).toBeNull()
    await setValue(mustQuery<HTMLInputElement>(container, '[data-router-type-name]'), '新名')
    await click(container, 'form-save')
    await waitUntil(container, () => formClosed(container), '保存完成（表单关闭返回列表）')
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
    await setValue(mustQuery<HTMLSelectElement>(container, '[data-router-defaults-model]'), 'p/m')
    // 改动即脏（脏标记出现 = defaults-draft 已生效）。
    await waitUntil(container, () => container.querySelector('[data-router-defaults-dirty]') !== null, '改动置脏标记')
    await click(container, 'defaults-save')
    // 等保存链路全部 settle：defaults-save-done 清脏标记。
    await waitUntil(container, () => container.querySelector('[data-router-defaults-dirty]') === null, '保存完成（脏标记清除）')
    expect(api.defaultsSaved).toHaveLength(1)
    expect(api.defaultsSaved[0]).toEqual({ routerSystemPrompt: DEFAULTS.routerSystemPrompt, routerModel: 'p/m' })
  })
})
