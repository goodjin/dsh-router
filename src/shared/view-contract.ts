/**
 * 客户端 ↔ 宿主 API 契约类型（计划「客户端↔宿主 API 契约」节的逐字形状）。
 *
 * 本文件是两侧共享面：宿主路由（src/host/routes.ts）与浏览器客户端（src/client/**，
 * 独立 worktree）都从这里 import——client 不 import src/host/**，宿主不 import
 * src/client/**，唯一汇合点就是这份类型。零宿主依赖。
 *
 * 问答条目（AskUserQuestionItem / AskUserQuestionAnswerItem / AskUserQuestionOption）
 * 是宿主 user-questions 子系统的形状镜像（依据 docs/research/r2-sessions.md §4，
 * 宿主 dsh-user-questions/lib/typert.host.js:271-292 的导出声明），镜像进共享层
 * 让浏览器侧不依赖宿主包。
 */

import type { TaskStatus } from './types.ts'

/** 任务短卡（列表/标签条/模型快照共用的视图单元）。 */
export interface TaskCard {
  taskId: string
  title: string
  goal: string
  status: TaskStatus
  role: 'supervisor' | 'worker'
  templateId: string
  progress?: string
  sessionId?: string
  /** 该任务当前待回答的问题数（open 状态）。 */
  waitingQuestions: number
  parentId?: string
  docVersion: number
}

/** 一道提问的可选项。 */
export interface AskUserQuestionOption {
  label: string
  description?: string
}

/** 一道提问（宿主 user-questions 的 AskUserQuestionItem 镜像）。 */
export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

/** 一道提问的答案（宿主 user-questions 的 AskUserQuestionAnswerItem 镜像）。 */
export interface AskUserQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** 汇聚到 Router 界面浮窗的一批问题。 */
export interface QuestionCard {
  questionId: string
  taskId?: string
  taskTitle?: string
  sessionId: string
  sessionTitle?: string
  questions: AskUserQuestionItem[]
  receivedAt: number
}

/** 一个 Router 会话（标签条固定首位）。 */
export interface RouterSessionInfo {
  sessionId: string
  title: string
}

/** 一个 worker 会话标签。 */
export interface WorkerTabInfo {
  sessionId: string
  title: string
  taskId?: string
  taskStatus?: TaskStatus
  running: boolean
}

/** worker 模板（派发时选专业类型）。 */
export interface WorkerTemplate {
  templateId: string
  name: string
  description: string
  role: 'supervisor' | 'worker'
}

/** 入口去重跳转指令（v1.1 Task C4）：宿主 dedup 写、客户端消费后 ack 清除。 */
export interface RouterRedirect {
  /** 消费方应跳转到的会话（正主）。 */
  sessionId: string
  /** 被归档的重复会话（指令的 key，ack 凭它清除）。 */
  supersededSessionId: string
}

/** GET /router/state 的完整返回。 */
export interface RouterState {
  routerSessions: RouterSessionInfo[]
  tasks: TaskCard[]
  questions: QuestionCard[]
  tabs: WorkerTabInfo[]
  templates: WorkerTemplate[]
  /**
   * 入口去重跳转指令（v1.1 Task C4）：本 workspace 出现了重复的 Router 预设
   * 会话且已归档，消费方应跳到正主并 POST /router/redirect/ack 清除。未消费
   * 前每次 state 都带同一条（轮询幂等）；无指令时该键不出现。
   */
  redirect?: RouterRedirect
}
