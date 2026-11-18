/**
 * 任务视图模型推导测试（协作视图页）。
 *
 * brief 命名断言：
 *  - tasks_grouped_with_progress：按 taskId 分组；标题取任务说明记录；进度四态计数
 *    来自分工记录的 workLabel；最近报告时间取 report/summary 的 updatedAt。
 *  - tasks_fallback_title_and_unlabeled：无任务说明记录时标题退化为 taskId；
 *    无 workLabel 的分工计入「未标注」。
 *  - tasks_ordered_by_recent_activity：任务按最近活动（max updatedAt）倒序。
 *  - tasks_session_ids_dedup：该任务全部记录关联的会话去重且保持首现顺序。
 *  - tasks_empty：空记录 → 空任务列表。
 */

import { describe, expect, it } from 'vitest'

import { deriveTasks } from '../../src/client/task-view-model.ts'
import type { WorkRecord } from '../../src/collaboration/types.ts'

function record(overrides: Partial<WorkRecord> & { id: string; taskId: string }): WorkRecord {
  return {
    rootSessionId: 'root-1',
    kind: 'assignment',
    title: '默认标题',
    body: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('tasks_grouped_with_progress — 分组、标题、进度、最近报告时间', () => {
  it('按 taskId 分组并推导进度与报告时间', () => {
    const records: WorkRecord[] = [
      record({ id: 'r-task', taskId: 'T1', kind: 'task', title: '登录模块改造', body: '做登录', createdAt: 1, updatedAt: 1 }),
      record({ id: 'r-a1', taskId: 'T1', kind: 'assignment', title: '前端分工', workLabel: '进行中', createdAt: 2, updatedAt: 2 }),
      record({ id: 'r-a2', taskId: 'T1', kind: 'assignment', title: '后端分工', workLabel: '受阻', createdAt: 3, updatedAt: 3 }),
      record({ id: 'r-a3', taskId: 'T1', kind: 'assignment', title: '测试分工', workLabel: '已报告', createdAt: 4, updatedAt: 4 }),
      record({ id: 'r-a4', taskId: 'T1', kind: 'assignment', title: '文档分工', workLabel: '待处理', createdAt: 5, updatedAt: 5 }),
      record({ id: 'r-rep1', taskId: 'T1', kind: 'report', title: '阶段报告', createdAt: 6, updatedAt: 60 }),
      record({ id: 'r-sum', taskId: 'T1', kind: 'summary', title: '汇总', createdAt: 7, updatedAt: 70 }),
      record({ id: 'r-a9', taskId: 'T2', kind: 'assignment', title: '另一个任务', createdAt: 8, updatedAt: 80 }),
    ]
    const tasks = deriveTasks(records)
    expect(tasks).toHaveLength(2)
    const t1 = tasks.find((t) => t.taskId === 'T1')!
    expect(t1.title).toBe('登录模块改造')
    expect(t1.progress).toEqual({ pending: 1, active: 1, blocked: 1, reported: 1, unlabeled: 0, total: 4 })
    expect(t1.lastReportAt).toBe(70)
    // T2 只有一条无标签分工 → 未标注。
    const t2 = tasks.find((t) => t.taskId === 'T2')!
    expect(t2.progress).toEqual({ pending: 0, active: 0, blocked: 0, reported: 0, unlabeled: 1, total: 1 })
    expect(t2.lastReportAt).toBeUndefined()
  })

  it('分工之外的记录不进进度计数（报告/汇总只影响 lastReportAt）', () => {
    const records: WorkRecord[] = [
      record({ id: 'r-task', taskId: 'T1', kind: 'task', title: 'T', createdAt: 1, updatedAt: 1 }),
      record({ id: 'r-rep', taskId: 'T1', kind: 'report', title: '报告带标签', workLabel: '进行中', createdAt: 2, updatedAt: 50 }),
    ]
    const tasks = deriveTasks(records)
    expect(tasks[0]!.progress.total).toBe(0)
    expect(tasks[0]!.progress.active).toBe(0)
    expect(tasks[0]!.lastReportAt).toBe(50)
  })
})

describe('tasks_fallback_title_and_unlabeled — 无说明记录与无标签分工', () => {
  it('无任务说明记录：标题退化为 taskId；无标签分工计入未标注', () => {
    const records: WorkRecord[] = [
      record({ id: 'r-a1', taskId: 'no-task-record', kind: 'assignment', title: '分工' }),
    ]
    const tasks = deriveTasks(records)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('no-task-record')
    expect(tasks[0]!.progress.unlabeled).toBe(1)
  })
})

describe('tasks_ordered_by_recent_activity — 任务按最近活动倒序', () => {
  it('updatedAt 更新的任务排在前面（稳定、确定）', () => {
    const records: WorkRecord[] = [
      record({ id: 'r-old', taskId: 'T-old', kind: 'assignment', title: '旧任务', createdAt: 1, updatedAt: 10 }),
      record({ id: 'r-new', taskId: 'T-new', kind: 'assignment', title: '新任务', createdAt: 2, updatedAt: 99 }),
      record({ id: 'r-mid', taskId: 'T-mid', kind: 'report', title: '中任务', createdAt: 3, updatedAt: 55 }),
    ]
    const tasks = deriveTasks(records)
    expect(tasks.map((t) => t.taskId)).toEqual(['T-new', 'T-mid', 'T-old'])
  })
})

describe('tasks_session_ids_dedup — 任务关联会话去重保序', () => {
  it('同任务多记录出现同会话只保留一次，顺序按首现', () => {
    const records: WorkRecord[] = [
      record({ id: 'r-a1', taskId: 'T1', kind: 'assignment', title: 'a', sessions: [{ sessionId: 'w1', label: '一' }, { sessionId: 'w2', label: '二' }] }),
      record({ id: 'r-rep', taskId: 'T1', kind: 'report', title: 'r', sessions: [{ sessionId: 'w2', label: '二' }, { sessionId: 'w3', label: '三' }] }),
      record({ id: 'r-a2', taskId: 'T2', kind: 'assignment', title: 'b', sessions: [{ sessionId: 'w9', label: '九' }] }),
    ]
    const tasks = deriveTasks(records)
    expect(tasks.find((t) => t.taskId === 'T1')!.sessionIds).toEqual(['w1', 'w2', 'w3'])
    expect(tasks.find((t) => t.taskId === 'T2')!.sessionIds).toEqual(['w9'])
  })
})

describe('tasks_empty — 空记录', () => {
  it('deriveTasks([]) 返回空数组', () => {
    expect(deriveTasks([])).toEqual([])
  })
})
