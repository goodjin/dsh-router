import type { RouterState, TaskCard } from '../shared/view-contract.ts'
import { taskRouterSession } from './overlay-queue.ts'

export interface SessionWindow {
  sessionId: string
  title: string
  tasks: TaskCard[]
}

/** 只枚举真实派发会话；重复投影只更新同一会话，不生成额外窗口。 */
export function dispatchedSessionWindows(state: RouterState, routerId: string): SessionWindow[] {
  const rows = new Map<string, SessionWindow>()
  for (const task of state.tasks) {
    if (!task.sessionId || taskRouterSession(state, task.taskId) !== routerId) continue
    const row = rows.get(task.sessionId) ?? { sessionId: task.sessionId, title: task.title, tasks: [] }
    const index = row.tasks.findIndex((entry) => entry.taskId === task.taskId)
    if (index < 0) row.tasks.push(task)
    else row.tasks[index] = task
    rows.set(task.sessionId, row)
  }
  return [...rows.values()]
}

export function sessionWindowStatus(row: SessionWindow, pendingQuestion: boolean): { kind: string; label: string; icon: string } {
  const tasks = row.tasks
  if (pendingQuestion || tasks.some((task) => task.waitingQuestions > 0 || task.status === 'waiting-user' || task.status === 'review-pending')) {
    return { kind: 'waiting', label: '等待确认或选择', icon: '?' }
  }
  if (tasks.some((task) => task.status === 'blocked' || task.status === 'failed')) return { kind: 'error', label: '受阻 / 失败', icon: '⚠' }
  if (tasks.some((task) => task.status === 'running' && task.sessionRunning === true)) return { kind: 'running', label: '正在运行', icon: '◌' }
  const status = tasks[0]?.status
  const labels = { draft: '草稿', queued: '排队中', dispatched: '已派发', running: '任务进行中 · 会话空闲', paused: '已暂停', completed: '已完成', cancelled: '已取消' }
  return { kind: 'idle', label: status && status in labels ? labels[status as keyof typeof labels] : '等待状态', icon: '•' }
}

export const SESSION_WINDOW_ANIMATIONS = `
@keyframes router-session-spin { to { transform: rotate(360deg); } }
@keyframes router-session-warning { 50% { opacity: .6; } }
@keyframes router-session-waiting { 50% { transform: scale(1.12); } }
[data-router-session-status] { display: inline-block; width: 18px; text-align: center; }
[data-router-session-status="running"] { animation: router-session-spin 1.6s linear infinite; }
[data-router-session-status="error"] { animation: router-session-warning 3s ease-in-out infinite; }
[data-router-session-status="waiting"] { animation: router-session-waiting 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { [data-router-session-status] { animation: none !important; } }
`
