/**
 * 客户端↔宿主共享视图类型（计划「客户端↔宿主 API 契约」逐字实现）。
 *
 * 本文件是两侧的共同契约：宿主路由（B4）与浏览器半边（B7）都从这里 import。
 * 铁律：
 * - client 不许 import src/host/**；本文件也不 import 任何宿主专有包——
 *   纯 TypeScript 类型，保证两侧可移植。
 * - TaskStatus 按 src/shared/types.ts 的语义复制为字符串联合（浏览器半边
 *   不引宿主领域文件，靠这一份拷贝对齐；改状态机时两侧同步改）。
 * - AskUserQuestion* 按官方 user-questions 词汇（docs/official/reference/
 *   subsystems/user-questions.md:5-96）自定义最小类型：只保留渲染需要
 *   的字段，不 import 宿主包；intent 等本 UI 不消费的字段不声明（线上
 *   JSON 多出的键自然忽略）。
 */

/** 任务状态全集（语义拷贝自 src/shared/types.ts 的 TaskStatus；勿单侧改动）。 */
export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'waiting-user'
  | 'blocked'
  | 'paused'
  | 'review-pending'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** 任务短卡（GET /router/state 的 tasks；活动账本的客户端视图）。 */
export interface TaskCard {
  taskId: string
  title: string
  goal: string
  status: TaskStatus
  role: 'supervisor' | 'worker'
  templateId: string
  progress?: string
  sessionId?: string
  waitingQuestions: number
  parentId?: string
  docVersion: number
}

/** 官方 user-questions 词汇：一个可选项（label 即选中值）。 */
export interface AskUserQuestionOption {
  label: string
  description?: string
}

/** 官方 user-questions 词汇：请求中的一个问题（最小渲染集）。 */
export interface AskUserQuestionItem {
  /** 调用方给的稳定问题 id，随答案原样返回。 */
  id: string
  /** 要展示的问题文本。 */
  question: string
  /** 随问题渲染的辅助说明（不进选项标签）。 */
  detail?: string
  /** 可选短标题/分组名。 */
  header?: string
  /** 可选选项菜单。 */
  options?: AskUserQuestionOption[]
  /** 是否多选；缺省单选。 */
  multiSelect?: boolean
}

/** 官方 user-questions 词汇：一个问题的回答。 */
export interface AskUserQuestionAnswerItem {
  /** 被回答的问题 id。 */
  id: string
  /** 选中的选项 label（多选可伴随 custom）。 */
  selected: string[]
  /** 自由文本「其他」回答。 */
  custom?: string
}

/** 一次提问请求（worker/主管会话经宿主桥汇聚而来的整批问题）。 */
export interface QuestionCard {
  questionId: string
  taskId?: string
  taskTitle?: string
  sessionId: string
  sessionTitle?: string
  questions: AskUserQuestionItem[]
  receivedAt: number
}

/** Router 会话信息（标签条固定首位的条目）。 */
export interface RouterSessionInfo {
  sessionId: string
  title: string
}

/** worker 标签（服务端持久标签序的一格）。 */
export interface WorkerTabInfo {
  sessionId: string
  title: string
  taskId?: string
  taskStatus?: TaskStatus
  running: boolean
}

/** worker 模板（新建 Router/任务时的下拉项）。 */
export interface WorkerTemplate {
  templateId: string
  name: string
  description: string
  role: 'supervisor' | 'worker'
}

/** GET /router/state 的返回体。 */
export interface RouterState {
  routerSessions: RouterSessionInfo[]
  tasks: TaskCard[]
  questions: QuestionCard[]
  tabs: WorkerTabInfo[]
  templates: WorkerTemplate[]
}
