/**
 * 任务状态机测试（计划 Task 1）。
 *
 * 断言三个层面：
 *  1. 迁移表里全部合法对可通过（canTransition = true、assertTransition 不抛）；
 *  2. 表外全部非法对抛 LedgerError（code='illegal-transition'，消息带 from→to）；
 *  3. 终态（completed/cancelled/failed）无出边。
 *
 * 状态清单与迁移表在本文件内独立枚举，不依赖实现的导出——表写错这里必红。
 */

import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition, LedgerError } from '../src/host/ledger/machine.ts'

/** 全部 11 个状态（照计划 Task 1 的 TaskStatus 逐一列出）。 */
const ALL: string[] = [
  'draft',
  'queued',
  'dispatched',
  'running',
  'waiting-user',
  'blocked',
  'paused',
  'review-pending',
  'completed',
  'cancelled',
  'failed']

/** 终态：无出边。 */
const TERMINAL: string[] = ['completed', 'cancelled', 'failed']

/** 合法迁移表（照计划 Task 1 的闭包集合，from → 允许的 to 集合）。 */
const LEGAL: Record<string, string[]> = {
  // draft/queued → blocked：派发失败达上限的自动封顶（v1.1 规格 §2-4）。
  draft: ['queued', 'blocked', 'cancelled'],
  queued: ['dispatched', 'blocked', 'cancelled'],
  dispatched: ['running', 'blocked', 'failed', 'cancelled'],
  running: ['waiting-user', 'blocked', 'paused', 'review-pending', 'completed', 'failed', 'cancelled'],
  'waiting-user': ['running', 'blocked', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  'review-pending': ['completed', 'cancelled'],
}

/** 全部非法对（表外 = 非法），独立于实现推导。 */
const ILLEGAL: Array<[string, string]> = ALL.flatMap((from) =>
  ALL.filter((to) => !(LEGAL[from]?.includes(to))).map((to) => [from, to] as [string, string]))

describe('迁移表：合法对', () => {
  it('每个 from 的合法 to 集合逐对可过（canTransition 与 assertTransition 一致）', () => {
    for (const [from, tos] of Object.entries(LEGAL)) {
      for (const to of tos) {
        expect(canTransition(from as never, to as never), `${from}→${to} 应合法`).toBe(true)
        expect(() => assertTransition(from as never, to as never), `${from}→${to} 不应抛`).not.toThrow()
      }
    }
  })

  it('合法对总数符合计划表（3+3+4+7+4+3+2+2 = 28 条；v1.1 A4 增 draft/queued→blocked）', () => {
    const total = Object.values(LEGAL).reduce((sum, tos) => sum + tos.length, 0)
    expect(total).toBe(28)
  })
})

describe('迁移表：非法对抛 LedgerError', () => {
  it('非法对超过 20 组，且每一组都抛 code=illegal-transition', () => {
    expect(ILLEGAL.length).toBeGreaterThan(20)
    for (const [from, to] of ILLEGAL) {
      expect(canTransition(from as never, to as never), `${from}→${to} 应非法`).toBe(false)
      try {
        assertTransition(from as never, to as never)
        expect.fail(`${from}→${to} 应抛 LedgerError`)
      } catch (err) {
        expect(err).toBeInstanceOf(LedgerError)
        expect((err as LedgerError).code).toBe('illegal-transition')
      }
    }
  })

  it('代表性非法对 draft→running：消息带 from→to 信息', () => {
    try {
      assertTransition('draft' as never, 'running' as never)
      expect.fail('draft→running 应抛')
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError)
      expect((err as LedgerError).code).toBe('illegal-transition')
      expect((err as Error).message).toContain('draft')
      expect((err as Error).message).toContain('running')
    }
  })

  it('相同状态（from===to）也视为非法', () => {
    for (const s of ALL) {
      expect(canTransition(s as never, s as never)).toBe(false)
      expect(() => assertTransition(s as never, s as never)).toThrow(LedgerError)
    }
  })
})

describe('终态无出边', () => {
  it('completed / cancelled / failed 到任何状态都非法', () => {
    for (const from of TERMINAL) {
      for (const to of ALL) {
        expect(canTransition(from as never, to as never), `${from}→${to} 应非法`).toBe(false)
        expect(() => assertTransition(from as never, to as never)).toThrow(LedgerError)
      }
    }
  })
})

describe('LedgerError 形状', () => {
  it('是 Error 子类，携带 code，消息非空', () => {
    const err = new LedgerError('illegal-transition', '测试消息')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('illegal-transition')
    expect(err.message).toBe('测试消息')
    expect(err.name).toBe('LedgerError')
  })
})
