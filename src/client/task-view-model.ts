/**
 * 任务视图模型推导（协作视图页，纯函数）。
 *
 * 把根会话下的平铺工作记录（WorkRecord[]）组织成「任务」视角：
 *  - 按 taskId 分组；标题取任务说明（kind=task）记录的标题，缺省退化为 taskId；
 *  - 进度只看分工记录（kind=assignment）的工作标签四态，报告/汇总不计入进度；
 *  - 最近报告时间取 report/summary 的 updatedAt 最大值；
 *  - 关联会话取该任务全部记录的 sessions 去重保序；
 *  - 任务按最近活动（全部记录的 updatedAt 最大值）倒序，同值保持首现顺序。
 *
 * 纯推导、零 IO：组件层每渲染调用即可，测试直接喂记录数组。
 */

import type { WorkLabel, WorkRecord } from '../collaboration/types.ts'

/** 分工进度：四态计数 + 未标注 + 总数。 */
export interface TaskProgress {
  pending: number
  active: number
  blocked: number
  reported: number
  unlabeled: number
  total: number
}

/** 任务卡片视图模型。 */
export interface TaskView {
  taskId: string
  /** 任务说明记录的标题；无说明记录时退化为 taskId。 */
  title: string
  /** 任务说明记录的正文（有则展示）。 */
  summaryBody: string | undefined
  /** 分工进度（仅 kind=assignment 计入）。 */
  progress: TaskProgress
  /** 最近一次 report/summary 的 updatedAt；无则 undefined。 */
  lastReportAt: number | undefined
  /** 该任务全部记录的关联会话（去重、首现顺序）。 */
  sessionIds: string[]
  /** 该任务全部记录 id（输入顺序）。 */
  recordIds: string[]
}

/** 工作标签 → 进度计数键。 */
function progressKeyOf(label: WorkLabel | undefined): keyof Pick<TaskProgress, 'pending' | 'active' | 'blocked' | 'reported' | 'unlabeled'> {
  switch (label) {
    case '待处理':
      return 'pending'
    case '进行中':
      return 'active'
    case '受阻':
      return 'blocked'
    case '已报告':
      return 'reported'
    default:
      return 'unlabeled'
  }
}

interface TaskBucket {
  taskId: string
  firstSeen: number
  titleRecord: WorkRecord | undefined
  progress: TaskProgress
  lastReportAt: number | undefined
  lastActivityAt: number
  sessionIds: string[]
  seenSessions: Set<string>
  recordIds: string[]
}

/** 把平铺记录推导成任务列表（最近活动优先）。 */
export function deriveTasks(records: WorkRecord[]): TaskView[] {
  const buckets = new Map<string, TaskBucket>()
  let firstSeen = 0
  for (const record of records) {
    let bucket = buckets.get(record.taskId)
    if (bucket === undefined) {
      bucket = {
        taskId: record.taskId,
        firstSeen: firstSeen++,
        titleRecord: undefined,
        progress: { pending: 0, active: 0, blocked: 0, reported: 0, unlabeled: 0, total: 0 },
        lastReportAt: undefined,
        lastActivityAt: record.updatedAt,
        sessionIds: [],
        seenSessions: new Set<string>(),
        recordIds: [],
      }
      buckets.set(record.taskId, bucket)
    }
    bucket.lastActivityAt = Math.max(bucket.lastActivityAt, record.updatedAt)
    bucket.recordIds.push(record.id)
    if (record.kind === 'task' && bucket.titleRecord === undefined) bucket.titleRecord = record
    if (record.kind === 'assignment') {
      bucket.progress[progressKeyOf(record.workLabel)] += 1
      bucket.progress.total += 1
    }
    if (record.kind === 'report' || record.kind === 'summary') {
      bucket.lastReportAt = bucket.lastReportAt === undefined ? record.updatedAt : Math.max(bucket.lastReportAt, record.updatedAt)
    }
    for (const session of record.sessions ?? []) {
      if (!bucket.seenSessions.has(session.sessionId)) {
        bucket.seenSessions.add(session.sessionId)
        bucket.sessionIds.push(session.sessionId)
      }
    }
  }
  return [...buckets.values()]
    .sort((a, b) => (b.lastActivityAt !== a.lastActivityAt ? b.lastActivityAt - a.lastActivityAt : a.firstSeen - b.firstSeen))
    .map((bucket) => ({
      taskId: bucket.taskId,
      title: bucket.titleRecord?.title ?? bucket.taskId,
      summaryBody: bucket.titleRecord?.body,
      progress: bucket.progress,
      lastReportAt: bucket.lastReportAt,
      sessionIds: bucket.sessionIds,
      recordIds: bucket.recordIds,
    }))
}
