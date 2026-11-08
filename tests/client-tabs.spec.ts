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
import { backButtonVisible, backTargetSessionId } from '../src/client/back-button.tsx'
import {
  hoverDarkenStyle,
  LIGHT_TOOLTIP_STYLE,
} from '../src/client/ui-kit.tsx'
import type { RouterState, TaskCard, WorkerTabInfo } from '../src/shared/view-contract.ts'

function workerTab(sessionId: string, title: string, overrides: Partial<WorkerTabInfo> = {}): WorkerTabInfo {
  return { sessionId, title, running: false, ...overrides }
}

function supervisorTask(sessionId: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    taskId: 'T-SUP',
    title: '主管任务',
    goal: '拆解并汇总',
    status: 'running',
    role: 'supervisor',
    templateId: 'tpl-supervisor',
    waitingQuestions: 0,
    docVersion: 0,
    sessionId,
    ...overrides,
  }
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

describe('backButtonVisible：返回按钮可见性三态（规格 §8）', () => {
  it('worker 会话（tabs 集合）+ 本项目有 Router → 显示', () => {
    expect(backButtonVisible('w-a', state())).toBe(true)
  })

  it('主管会话（tasks 里带 sessionId 的任务）→ 显示', () => {
    const supervisor = state({ tasks: [supervisorTask('sup-1')] })
    expect(backButtonVisible('sup-1', supervisor)).toBe(true)
  })

  it('当前是 Router 会话 → 隐藏（已在 Router，不显示返回）', () => {
    expect(backButtonVisible('router-1', state())).toBe(false)
  })

  it('普通会话（不在 worker/主管集合）或无当前会话 → 隐藏', () => {
    expect(backButtonVisible('some-other-session', state())).toBe(false)
    expect(backButtonVisible(undefined, state())).toBe(false)
  })

  it('本项目无 Router 会话 → worker 会话也隐藏（无处可返）', () => {
    expect(backButtonVisible('w-a', state({ routerSessions: [] }))).toBe(false)
  })

  it('状态还没轮询到（null/undefined）→ 隐藏', () => {
    expect(backButtonVisible('w-a', null)).toBe(false)
    expect(backButtonVisible('w-a', undefined)).toBe(false)
  })
})

describe('backTargetSessionId：返回目标（本项目 Router 会话）', () => {
  it('取 Router 会话列表第一个（服务端顺序）', () => {
    expect(backTargetSessionId(state({
      routerSessions: [
        { sessionId: 'router-2', title: '第二个' },
        { sessionId: 'router-1', title: 'Router' },
      ],
    }))).toBe('router-2')
  })

  it('无 Router 会话或无状态 → undefined（组件不渲染按钮）', () => {
    expect(backTargetSessionId(state({ routerSessions: [] }))).toBeUndefined()
    expect(backTargetSessionId(null)).toBeUndefined()
    expect(backTargetSessionId(undefined)).toBeUndefined()
  })
})

/** sRGB 十六进制 → 相对亮度（0 黑 → 1 白），样式基线的客观判据。 */
function luminanceOf(color: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim())
  expect(match, `颜色应为 #rrggbb 十六进制，收到：${color}`).not.toBeNull()
  const value = Number.parseInt(match![1]!, 16)
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  const linear = channels.map((channel) => {
    const s = channel / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

describe('ui-kit 样式基线（规格 §9：悬浮提示浅色浮层、hover 稍深）', () => {
  it('悬浮提示底色是固定浅色（禁黑底）：#rrggbb、亮度高，文字为深色', () => {
    const background = String(LIGHT_TOOLTIP_STYLE.background)
    expect(/^#[0-9a-f]{6}$/i.test(background), `悬浮提示底色应为固定浅色十六进制，收到：${background}`).toBe(true)
    expect(luminanceOf(background), `底色太深（疑似黑底）：${background}`).toBeGreaterThan(0.5)
    expect(luminanceOf(String(LIGHT_TOOLTIP_STYLE.color)), '提示文字应为深色以保证可读').toBeLessThan(0.2)
  })

  it('hover 反馈是「稍变深」的亮度滤镜（brightness < 1），不是反色、不是换底色', () => {
    // v1.4：浅色基线——hover 为底色稍深（不再用滤镜反色）。
    expect(hoverDarkenStyle(true)).toMatchObject({ background: '#f0f1f3' })
    expect(hoverDarkenStyle(false)).toEqual({})
  })
})
