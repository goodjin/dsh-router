// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { latestOutput, SessionPreview, type PreviewSessions } from '../src/client/session-preview.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const live = (text: string, attemptId = 'a') => ({ event: { type: 'assistant/live-chunk', data: { attemptId, chunk: { type: 'text-delta', text } } } })
const message = (text: string) => ({ event: { type: 'assistant/message', data: { stream: [{ type: 'text-chunks', texts: [text] }] } } })

describe('会话输出预览', () => {
  it('增量尾部、结算与重连快照不重复，不显示用户或推理内容', () => {
    expect(latestOutput([message('旧输出'), live('新'), live('输出')])).toBe('新输出')
    expect(latestOutput([message('新输出')])).toBe('新输出')
    expect(latestOutput([live('旧尝试'), live('重试', 'b')])).toBe('重试')
    expect(latestOutput([{ event: { type: 'user/message', data: { text: '用户输入' } } }])).toBe('')
    expect(latestOutput([message('旧输出'), { event: { type: 'step/start', data: {} } }])).toBe('')
    expect(latestOutput([live('x'.repeat(1000))])).toHaveLength(800)
    expect(latestOutput([{ event: { type: 'assistant/live-chunk', data: { attemptId: 'a', chunk: { type: 'reasoning-delta', text: '推理' } } } }])).toBe('')
  })

  it('跟随事件刷新，切换释放订阅，晚到的旧会话不会覆盖新内容', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0))
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)
    const listeners = new Set<() => void>()
    let entries = [live('开始')]
    const release = vi.fn()
    const sessions: PreviewSessions = { retain: vi.fn(() => ({ release, ready: Promise.resolve({
      eventSource: { getSnapshot: () => ({ entries }), subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
      session: { getSnapshot: () => ({ openState: 'open' }) },
    }) })) }
    const div = document.createElement('div')
    const root = createRoot(div)
    try {
      await act(async () => root.render(<SessionPreview sessions={sessions} sessionId="s1" />))
      expect(div.textContent).toBe('开始')
      await act(async () => { entries = [live('开始'), live('继续')]; listeners.forEach((listener) => listener()); await new Promise((resolve) => setTimeout(resolve, 5)) })
      expect(div.textContent).toBe('开始继续')
      entries = [message('新会话')]
      await act(async () => root.render(<SessionPreview sessions={sessions} sessionId="s2" />))
      expect(release).toHaveBeenCalledTimes(1)
      expect(listeners.size).toBe(1)
      expect(div.textContent).toBe('新会话')
      expect(sessions.retain).toHaveBeenLastCalledWith('s2', { source: 'router-preview' })
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
    expect(release).toHaveBeenCalledTimes(2)
    expect(listeners.size).toBe(0)
  })

  it('卸载期间 ready 才到达时不订阅；失败不展示空白', async () => {
    let ready!: (value: Awaited<ReturnType<PreviewSessions['retain']>['ready']>) => void
    const subscribe = vi.fn(() => () => {})
    const release = vi.fn()
    const sessions: PreviewSessions = { retain: () => ({ release, ready: new Promise((resolve) => { ready = resolve }) }) }
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => root.render(<SessionPreview sessionId="s" sessions={sessions} />))
    await act(async () => root.render(<SessionPreview sessionId="other" />))
    expect(div.textContent).toBe('输出预览暂不可用')
    await act(async () => ready({ eventSource: { subscribe, getSnapshot: () => ({ entries: [] }) }, session: { getSnapshot: () => ({ openState: 'open' }) } }))
    expect(subscribe).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })
})
