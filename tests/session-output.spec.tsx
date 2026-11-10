// @vitest-environment jsdom
/**
 * 浮窗里的会话输出（v1.5）。
 *
 * 关键行为：**不再把整条会话事件流留在浏览器**（旧实现 retain 整条流，一次
 * 几 MB，正是打开 Router 会话时卡顿的来源）。现在只有运行中的会话才去宿主
 * 取一段有界尾部；已结束的会话直接显示账本摘要，零请求。
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { SessionOutput } from '../src/client/session-output.tsx'
import type { RouterApi } from '../src/client/api.ts'
import type { SessionOutputValue } from '../src/shared/view-contract.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeApi(
  respond: (sessionId: string) => Promise<SessionOutputValue>,
): { api: RouterApi; calls: string[] } {
  const calls: string[] = []
  const api = {
    getSessionOutput: (sessionId: string) => {
      calls.push(sessionId)
      return respond(sessionId)
    },
  } as unknown as RouterApi
  return { api, calls }
}

describe('SessionOutput：浮窗会话输出', () => {
  it('非运行中：显示账本摘要，不发任何请求', async () => {
    const { api, calls } = fakeApi(async () => ({ text: '实时输出', source: 'live' }))
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => root.render(<SessionOutput api={api} sessionId="w-1" running={false} summary="已完成：写完文档" />))
    expect(div.textContent).toBe('已完成：写完文档')
    expect(calls).toEqual([])
    await act(async () => root.unmount())
  })

  it('非运行中且没有摘要：如实显示「暂无文字输出」', async () => {
    const { api, calls } = fakeApi(async () => ({ text: '', source: 'none' }))
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => root.render(<SessionOutput api={api} sessionId="w-1" running={false} />))
    expect(div.textContent).toBe('暂无文字输出')
    expect(calls).toEqual([])
    await act(async () => root.unmount())
  })

  it('运行中：向宿主取一段尾部并显示；refreshKey 变化时再取一次', async () => {
    let counter = 0
    const { api, calls } = fakeApi(async () => {
      counter += 1
      return { text: `第 ${counter} 次取到的尾部`, source: 'live' }
    })
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => root.render(<SessionOutput api={api} sessionId="w-1" running refreshKey="a" />))
    expect(div.textContent).toBe('第 1 次取到的尾部')
    expect(calls).toEqual(['w-1'])
    await act(async () => root.render(<SessionOutput api={api} sessionId="w-1" running refreshKey="b" />))
    expect(div.textContent).toBe('第 2 次取到的尾部')
    expect(calls).toEqual(['w-1', 'w-1'])
    await act(async () => root.unmount())
  })

  it('运行中取不到内容：如实显示，不显示空白', async () => {
    const { api } = fakeApi(async () => ({ text: '', source: 'none' }))
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => root.render(<SessionOutput api={api} sessionId="w-1" running refreshKey="a" />))
    expect(div.textContent).toBe('正在取最新输出…')
    await act(async () => root.unmount())
  })

  it('请求失败：不让界面崩，也不显示空白', async () => {
    const { api } = fakeApi(async () => { throw new Error('network down') })
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => root.render(<SessionOutput api={api} sessionId="w-1" running refreshKey="a" />))
    expect(div.textContent).toBe('正在取最新输出…')
    await act(async () => root.unmount())
  })

  it('卸载后晚到的响应不写回界面（无 setState-after-unmount）', async () => {
    let release: ((value: SessionOutputValue) => void) | undefined
    const { api } = fakeApi(() => new Promise<SessionOutputValue>((resolve) => { release = resolve }))
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => root.render(<SessionOutput api={api} sessionId="w-1" running refreshKey="a" />))
    await act(async () => root.unmount())
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { release?.({ text: '迟到', source: 'live' }); await Promise.resolve() })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
