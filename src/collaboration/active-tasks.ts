/**
 * 活跃任务视图缓存（两级模型 2026-11-24 起，用户诉求 ③：任务描述驱动上下文）。
 *
 * 协作上下文段的 text() 回调是**同步**的，不能在里面 await 记录读取；而活跃任务每次写
 * （建任务、派发、报告）都可能变，靠 TTL 会有一拍滞后。做法：共享服务里放一份按
 * rootSessionId 键的视图缓存，tools/dispatch 行每次成功写记录后 **await 刷新**（几份小 JSON，
 * 代价可忽略），context 行同步读——写完立刻新鲜，零滞后。读不到（刚启动、首次装配）就后台
 * 刷新一次并渲染「加载中」，下一拍就有了。
 *
 * 视图只收活跃任务（待处理/进行中/受阻；没有标签的视为未报告=活跃），每条带**完整描述**
 * （用户选择：注入完整描述而非摘要）和它下面登记的子会话（assignment.sessions），让模型
 * 追加需求时一眼看到该发给谁。上限 maxTasks（默认 5）防止膨胀，超出部分只报数量并指向
 * router_record_list。
 */

import type { RecordStore, WorkLabel } from './types.ts'

/** 一个活跃任务在上下文里的样子。 */
export interface ActiveTaskView {
  taskId: string
  title: string
  body: string
  workLabel: WorkLabel | '未标注'
  /** 该任务下登记的子会话（来自分工记录），label 是角色名。 */
  sessions: ReadonlyArray<{ sessionId: string; label: string }>
}

/** 视图缓存的最小面：context 行同步 get，tools/dispatch 行异步 refresh。 */
export interface ActiveTaskCache {
  get(rootSessionId: string): readonly ActiveTaskView[] | undefined
  refresh(rootSessionId: string): Promise<readonly ActiveTaskView[]>
}

/** 「已报告」之外都算活跃。 */
const REPORTED: WorkLabel = '已报告'
export const DEFAULT_MAX_ACTIVE_TASKS = 5

export function createActiveTaskCache(
  records: Pick<RecordStore, 'list'>,
  options: { maxTasks?: number } = {},
): ActiveTaskCache {
  const maxTasks = Number.isSafeInteger(options.maxTasks) && (options.maxTasks as number) > 0
    ? (options.maxTasks as number)
    : DEFAULT_MAX_ACTIVE_TASKS
  const cache = new Map<string, readonly ActiveTaskView[]>()

  async function refresh(rootSessionId: string): Promise<readonly ActiveTaskView[]> {
    const tasks = (await records.list(rootSessionId, { kind: 'task' }))
      .filter((task) => task.workLabel !== REPORTED)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, maxTasks)
    const views: ActiveTaskView[] = []
    for (const task of tasks) {
      const assignments = await records.list(rootSessionId, { taskId: task.taskId, kind: 'assignment' })
      const sessions: Array<{ sessionId: string; label: string }> = []
      for (const row of assignments) {
        for (const link of row.sessions ?? []) sessions.push({ sessionId: link.sessionId, label: link.label })
      }
      views.push({
        taskId: task.taskId,
        title: task.title,
        body: task.body,
        workLabel: task.workLabel ?? '未标注',
        sessions,
      })
    }
    cache.set(rootSessionId, views)
    return views
  }

  return {
    get(rootSessionId) {
      return cache.get(rootSessionId)
    },
    refresh,
  }
}
