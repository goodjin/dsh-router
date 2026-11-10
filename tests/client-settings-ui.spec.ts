// @vitest-environment jsdom
/**
 * 设置段真实渲染回归（2026-11 提示词 UI 移除，先红后绿）。
 *
 * 用真 React（createRoot + act）渲染 RouterSettingsSection，驱动真实 DOM 事件，
 * 断言收敛后的界面行为（不是源码正则；2026-11-10：类型无编辑、无技能、
 * Router 默认区整体移除）：
 * 1. 设置页没有任何提示词输入（类型表单无「系统提示词」——整页零 textarea）；
 *    类型行无编辑按钮、表单无技能勾选、页面无 Router 默认区；
 * 2. 新建类型（worker / supervisor）不需要提示词即可保存，create 请求体
 *    不带 systemPrompt/skills 键（尤其不是空串——宿主 ?? 只挡 nullish）。
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
import type { WorkerTypeRecord } from '../src/shared/view-contract.ts'

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

/** 记录型假 api：加载面回放固定数据，写面记录请求体。 */
function makeApi(types: WorkerTypeRecord[]): RouterApi & { created: unknown[] } {
  const face = {
    created: [] as unknown[],
    listWorkerTypes: () => Promise.resolve(types.map((record) => ({ ...record }))),
    getSpawnMode: () => Promise.resolve({ mode: 'cache-priority' as const }),
    saveSpawnMode: (mode: 'cache-priority' | 'minimal-face') => Promise.resolve({ mode }),
    createWorkerType: (input: unknown) => {
      face.created.push(input)
      return Promise.resolve(typeRecord({ ...(input as object) }))
    },
    setWorkerTypeEnabled: (request: { templateId: string; enabled: boolean }) => Promise.resolve(typeRecord({ templateId: request.templateId, enabled: request.enabled })),
    removeWorkerType: (_templateId: string) => Promise.resolve(),
  }
  return face as unknown as RouterApi & { created: unknown[] }
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

/** 渲染并等到「加载完成」的 UI 证据（当前模式标记出现 = loaded 已 dispatch）。 */
async function renderSettings(api: RouterApi): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => { root.render(createElement(RouterSettingsSection, { prefs: makePrefs(), api })) })
  await waitUntil(container, () => container.querySelector('[data-router-spawn-current]') !== null, '设置段加载完成（派生模式标记渲染）')
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
  it('整页没有提示词 textarea；类型行无编辑按钮、表单无技能勾选、无 Router 默认区', async () => {
    const container = await renderSettings(makeApi([typeRecord()]))
    expect(container.querySelector('[data-router-defaults-section]')).toBeNull()
    expect(container.querySelector('[data-router-skills-editor]')).toBeNull()
    expect(container.querySelector('[data-router-settings-button^="edit-"]')).toBeNull()
    await click(container, 'types-new')
    await waitUntil(container, () => container.querySelector('[data-router-type-form="new"]') !== null, '新建表单打开')
    expect(container.querySelector('[data-router-type-prompt]')).toBeNull()
    expect(container.querySelector('[data-router-skills-editor]')).toBeNull()
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
    expect('skills' in payload, 'create 不得带 skills 键（类型不再挂技能）').toBe(false)
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

  it('禁用/启用与删除照常可用（收敛只动编辑与默认区）', async () => {
    const api = makeApi([typeRecord({ templateId: 't-1' })])
    const container = await renderSettings(api)
    await click(container, 'disable-t-1')
    await waitUntil(container, () => container.querySelector('[data-router-type-enabled="false"]') !== null, '禁用生效')
  })
})
