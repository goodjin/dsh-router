// @vitest-environment jsdom
/**
 * 「提示词」视图真实渲染回归（先红后绿）。
 *
 * SystemPromptView 在 loading/error/empty 的 early return 之后才调
 * useHoverDarken（内部 useState）——同一组件两次渲染的 hook 数量随 phase
 * 变化（非 editor 6 个 → editor 9 个），React 规则「hooks 不得条件调用」被
 * 破坏：加载成功 / 会话切换 / 重试成功的重渲染都会以 invariant 崩溃，
 * 表现即「Router 提示词看不到内容」。
 *
 * 这里用真 React（createRoot + act）驱动真实状态机切换断言 DOM 行为，
 * 不用字符串断言冒充。假体只替换边界：store（get/subscribe/setCurrentSession）
 * 与 api（getPrompt 可脚本化），与 workbench-store.spec 的假 api 同款做法。
 */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { SystemPromptView } from '../src/client/system-prompt-view.tsx'
import type { SystemPromptViewFace, SystemPromptViewProps } from '../src/client/system-prompt-view.tsx'
import type { RouterApi } from '../src/client/api.ts'
import type { WorkbenchState, WorkbenchStore } from '../src/client/workbench-store.ts'
import { emptyBoard } from '../src/client/question-state.ts'
import type { RouterDefaults, RouterState, SessionPromptResponse } from '../src/shared/view-contract.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 可手动驱动的最小 store 面（组件只消费 get/subscribe；测试经 setCurrentSession 切会话）。 */
function makeViewStore(initial: { currentSessionId?: string; routerState: RouterState | null }): {
  store: WorkbenchStore
  setCurrentSession(sessionId: string | undefined): void
} {
  let state: WorkbenchState = {
    ready: true,
    routerState: initial.routerState,
    lastError: null,
    board: emptyBoard(),
    closingSessionIds: [],
    currentSessionId: initial.currentSessionId,
  }
  const listeners = new Set<() => void>()
  const store = {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setCurrentSession: (sessionId: string | undefined) => {
      if (state.currentSessionId === sessionId) return
      state = { ...state, currentSessionId: sessionId }
      for (const listener of [...listeners]) listener()
    },
  }
  return { store: store as unknown as WorkbenchStore, setCurrentSession: store.setCurrentSession }
}

/** getPrompt 可脚本化（按次序消费；走完后重复最后一个）；其余 face 记录调用即可。 */
function makePromptApi(script: Array<Promise<SessionPromptResponse>>): RouterApi & {
  getPromptCalls: string[]
  saveCalls: [string, string][]
  defaultsSaved: string[]
} {
  const face: SystemPromptViewFace['api'] & Record<string, unknown> = {
    getPromptCalls: [] as string[],
    saveCalls: [] as [string, string][],
    defaultsSaved: [] as string[],
    getPrompt: (sessionId: string) => {
      ;(face.getPromptCalls as string[]).push(sessionId)
      const next = script.shift()
      return next ?? Promise.reject(new Error('脚本用尽'))
    },
    saveSessionPrompt: (sessionId: string, prompt: string) => {
      ;(face.saveCalls as [string, string][]).push([sessionId, prompt])
      return Promise.resolve()
    },
    getDefaults: () => Promise.resolve({ routerSystemPrompt: '默认提示词', routerModel: '' }),
    saveDefaults: (value: RouterDefaults) => {
      ;(face.defaultsSaved as string[]).push(value.routerSystemPrompt)
      return Promise.resolve(value)
    },
  }
  return face as unknown as RouterApi & { getPromptCalls: string[]; saveCalls: [string, string][]; defaultsSaved: string[] }
}

function routerStateOf(sessionIds: string[]): RouterState {
  return {
    routerSessions: sessionIds.map((sessionId) => ({ sessionId, title: `会话 ${sessionId}` })),
    tasks: [],
    questions: [],
    tabs: [],
    templates: [],
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    act(() => { root.unmount() })
    container.remove()
  }
})

async function renderView(props: SystemPromptViewProps): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => { root.render(createElement(SystemPromptView, props)) })
  return container
}

/** 冲刷微任务链（getPrompt .then 里的 setState 要落在 act 内）。 */
async function flush(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) })
}

function viewKind(container: HTMLElement): string | null {
  return container.querySelector<HTMLElement>('[data-router-prompt-view]')?.getAttribute('data-router-prompt-view') ?? null
}

function textareaValue(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLTextAreaElement>('[data-router-prompt-textarea]')?.value
}

describe('「提示词」视图渲染（真实 React 状态切换）', () => {
  it('Router 会话：加载中 → 加载完成显示编辑器与文本（hook 数量不随 phase 变化）', async () => {
    let release!: (value: SessionPromptResponse) => void
    const pending = new Promise<SessionPromptResponse>((resolve) => { release = resolve })
    const { store } = makeViewStore({ currentSessionId: 'router-1', routerState: routerStateOf(['router-1']) })
    const api = makePromptApi([pending])
    const container = await renderView({ store, api })

    expect(viewKind(container)).toBe('loading')

    await act(async () => { release({ prompt: '主管提示词甲', isDefault: false }) })
    await flush()

    expect(viewKind(container)).toBe('editor')
    expect(textareaValue(container)).toBe('主管提示词甲')
    expect(container.querySelector<HTMLElement>('[data-router-prompt-source]')?.getAttribute('data-router-prompt-source')).toBe('override')
    expect(api.getPromptCalls).toEqual(['router-1'])
  })

  it('非 Router → Router → 非 Router 切换：空态与编辑器随会话正确互换，不崩溃', async () => {
    const { store, setCurrentSession } = makeViewStore({ currentSessionId: 'plain-1', routerState: routerStateOf(['router-1']) })
    const api = makePromptApi([Promise.resolve({ prompt: '主管提示词乙', isDefault: true })])
    const container = await renderView({ store, api })

    expect(viewKind(container)).toBe('empty')
    expect(api.getPromptCalls).toEqual([])

    act(() => { setCurrentSession('router-1') })
    await flush()

    expect(viewKind(container)).toBe('editor')
    expect(textareaValue(container)).toBe('主管提示词乙')
    expect(container.querySelector<HTMLElement>('[data-router-prompt-source]')?.getAttribute('data-router-prompt-source')).toBe('default')

    act(() => { setCurrentSession('plain-9') })

    expect(viewKind(container)).toBe('empty')
  })

  it('加载失败 → 错误态与重试 → 重试成功显示编辑器（重试真的重新拉取）', async () => {
    const { store } = makeViewStore({ currentSessionId: 'router-1', routerState: routerStateOf(['router-1']) })
    const api = makePromptApi([
      Promise.reject(new Error('后端炸了')),
      Promise.resolve<SessionPromptResponse>({ prompt: '重试后的提示词', isDefault: false }),
    ])
    const container = await renderView({ store, api })

    await flush()

    expect(viewKind(container)).toBe('error')
    expect(container.textContent).toContain('后端炸了')
    const retry = container.querySelector<HTMLButtonElement>('button')
    expect(retry?.textContent).toContain('重试')

    act(() => { retry?.click() })
    await flush()

    expect(viewKind(container)).toBe('editor')
    expect(textareaValue(container)).toBe('重试后的提示词')
    expect(api.getPromptCalls).toEqual(['router-1', 'router-1'])
  })
})
