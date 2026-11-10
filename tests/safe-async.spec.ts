/**
 * 「发射后不管」的异步调用出口（2026-11-10 桌面版崩溃回归）。
 *
 * 宿主（dsh-app-boot 的 installFailLoud）把任何未捕获的 promise rejection
 * 当成致命错误：打印 `fatal load failure` 后 exit(1)，桌面版随即记为崩溃。
 * 插件里凡是「发射后不管」的异步调用都必须就地吞掉异常。
 */

import { describe, expect, it } from 'vitest'

import { createFireAndForget, describeError } from '../src/host/safe-async.ts'

describe('createFireAndForget', () => {
  it('work 被拒绝时不产生未捕获 rejection，只记一行 warn', async () => {
    const warnings: string[] = []
    const fire = createFireAndForget({ warn: (message) => warnings.push(message) })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      fire('快照项目列表补刷', () => Promise.reject(new Error('cannot get required service "workspaceRegistry" in inactive context')))
      // 让微任务队列跑完（未捕获 rejection 在进程级是下一轮才派发）。
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('快照项目列表补刷')
    expect(warnings[0]).toContain('inactive context')
  })

  it('work 同步抛出时不打断调用方，记一行 warn', () => {
    const warnings: string[] = []
    const fire = createFireAndForget({ warn: (message) => warnings.push(message) })
    expect(() => {
      fire('预设注册表巡检', () => { throw new Error('boom') })
    }).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('预设注册表巡检')
  })

  it('work 成功时不记日志', async () => {
    const warnings: string[] = []
    const fire = createFireAndForget({ warn: (message) => warnings.push(message) })
    fire('快照项目列表补刷', () => Promise.resolve('ok'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(warnings).toEqual([])
  })
})

describe('describeError', () => {
  it('Error 取 message；非 Error 取字符串', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError('boom')).toBe('boom')
    expect(describeError(42)).toBe('42')
  })
})
