/**
 * 任务描述压缩引擎（2026-11-11 用户裁定流程）：
 * 派发时生成的任务描述即历史——Router 会话压缩时不再调 LLM 摘要聊天过程，
 * 而是按账本拼「当前活跃任务」清单替换自上一检查点以来的聊天段。
 *
 * 装配函数（纯函数）先行：输入 TaskRecord 数组，输出替换文本。
 */

import { describe, expect, it } from 'vitest'

import { assembleTaskSummary } from '../src/host/compaction/task-summary.ts'
import type { TaskRecord } from '../src/shared/types.ts'

/** 造一条任务记录（只填装配函数消费的字段）。 */
function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    title: `任务 ${overrides.id}`,
    goal: `目标 ${overrides.id}`,
    acceptance: [],
    constraints: [],
    projectId: 'proj',
    cwd: '/tmp',
    role: 'worker',
    dependsOn: [],
    status: 'dispatched',
    docVersion: 1,
    acceptancePolicy: 'auto',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('assembleTaskSummary：活跃任务清单装配', () => {
  it('活跃任务各占一行：id、标题、状态、目标', () => {
    const text = assembleTaskSummary([
      task({ id: 'T-001', title: '修登录超时', goal: '登录不再超时', status: 'dispatched' }),
      task({ id: 'T-002', title: '加导出按钮', goal: '能导出 CSV', status: 'running' }),
    ])
    expect(text).toContain('T-001')
    expect(text).toContain('修登录超时')
    expect(text).toContain('登录不再超时')
    expect(text).toContain('T-002')
    expect(text).toContain('加导出按钮')
    // 状态词出现（对模型可读，一眼知道哪些还在跑）
    expect(text).toContain('dispatched')
    expect(text).toContain('running')
  })

  it('终态任务剔除（completed/cancelled/failed 不再进历史）', () => {
    const text = assembleTaskSummary([
      task({ id: 'T-001', status: 'completed' }),
      task({ id: 'T-002', status: 'dispatched' }),
      task({ id: 'T-003', status: 'cancelled' }),
      task({ id: 'T-004', status: 'failed' }),
    ])
    expect(text).toContain('T-002')
    expect(text).not.toContain('T-001')
    expect(text).not.toContain('T-003')
    expect(text).not.toContain('T-004')
  })

  it('无活跃任务时给出兜底句（不能为空——引擎要求至少一块非空文本）', () => {
    const text = assembleTaskSummary([
      task({ id: 'T-001', status: 'completed' }),
    ])
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('空账本同样给出兜底句', () => {
    const text = assembleTaskSummary([])
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('确定性顺序：按 id 排序（多次装配字节相同）', () => {
    const records = [
      task({ id: 'T-002' }),
      task({ id: 'T-001' }),
      task({ id: 'T-010' }),
    ]
    const first = assembleTaskSummary(records)
    const second = assembleTaskSummary([...records].reverse())
    expect(first).toBe(second)
    expect(first.indexOf('T-001')).toBeLessThan(first.indexOf('T-002'))
    expect(first.indexOf('T-002')).toBeLessThan(first.indexOf('T-010'))
  })

  it('验收要点与约束以分号拼接进对应任务行', () => {
    const text = assembleTaskSummary([
      task({
        id: 'T-001',
        acceptance: ['测试全绿', '类型检查过'],
        constraints: ['不动宿主'],
      }),
    ])
    expect(text).toContain('验收要点：测试全绿；类型检查过')
    expect(text).toContain('约束：不动宿主')
  })
})
