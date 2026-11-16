/**
 * 轻量团队协作共享类型与结构化错误（计划 Task 1）。
 *
 * 新代码全部集中于 src/collaboration/；本模块只定义数据类型、存储接口与
 * CollaborationError，零 node 依赖、零宿主（DSH）依赖、零旧 TaskLedger/RouterCore 依赖。
 * 数据布局：collaboration/roots/<sha256(rootSessionId)>/tasks/<taskId>/<recordId>.json，
 * 角色位于 collaboration/roles/<roleId>.json。rootSessionId 哈希只用于文件名，不产生权限。
 */

/** 记录种类：任务说明 / 分工记录 / 工作报告 / 汇总报告。 */
export type RecordKind = 'task' | 'assignment' | 'report' | 'summary'

/** 工作标签：仅四态，不从会话结束或测试退出码推断业务完成。 */
export type WorkLabel = '待处理' | '进行中' | '受阻' | '已报告'

/** 会话关联：仅用于展示与跳转，不自动读取或执行。 */
export interface SessionLink {
  sessionId: string
  label: string
}

/** 成果引用：展示引用，不自动读取、执行或覆盖目标。 */
export interface ArtifactRef {
  location: string
  label: string
}

/** 新建记录入参。空 body 合法，空 title 不合法。 */
export interface RecordDraft {
  kind: RecordKind
  taskId?: string
  parentRecordId?: string
  title: string
  body: string
  workLabel?: WorkLabel
  sessions?: SessionLink[]
  artifacts?: ArtifactRef[]
}

/** 落库后的完整工作记录。种类、归属（taskId/rootSessionId）与创建时间不可更新。 */
export interface WorkRecord extends RecordDraft {
  id: string
  taskId: string
  rootSessionId: string
  createdAt: number
  updatedAt: number
}

/** 更新补丁：只允许改标题、正文、工作标签、会话关联与成果引用。 */
export type RecordPatch = Partial<Pick<RecordDraft, 'title' | 'body' | 'workLabel' | 'sessions' | 'artifacts'>>

/** 列表查询：可选按任务与种类过滤。 */
export interface RecordQuery {
  taskId?: string
  kind?: RecordKind
}

/** 保存结果：记录与其实际落盘路径（模型无需猜测路径）。 */
export interface SavedRecord {
  record: WorkRecord
  path: string
}

/** 角色模板：仅为数据（编号、名称、职责说明），不注册 preset、不含运行时插件树。 */
export interface RoleTemplate {
  id: string
  name: string
  description: string
  createdAt: number
  updatedAt: number
}

/** 工作记录存储：模型主导读写，文件是唯一事实源，无全局索引/Markdown 副本。 */
export interface RecordStore {
  create(rootSessionId: string, input: RecordDraft): Promise<SavedRecord>
  read(rootSessionId: string, taskId: string, recordId: string): Promise<SavedRecord>
  list(rootSessionId: string, query?: RecordQuery): Promise<WorkRecord[]>
  update(rootSessionId: string, taskId: string, recordId: string, patch: RecordPatch): Promise<SavedRecord>
}

/** 角色模板存储：用户与模型通过同一保存能力创建/修改。 */
export interface RoleStore {
  list(): Promise<RoleTemplate[]>
  read(id: string): Promise<RoleTemplate>
  save(input: { id?: string; name: string; description: string }): Promise<RoleTemplate>
}

/**
 * 协作域结构化错误码。所有记录/模板操作只返回这四类，调用方按 code 分流，
 * 不解析消息文本。
 */
export type CollaborationErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CORRUPT_RECORD'
  | 'IO_ERROR'

/** 协作域统一错误。 */
export class CollaborationError extends Error {
  /** 错误码，调用方以此分流。 */
  readonly code: CollaborationErrorCode

  constructor(code: CollaborationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CollaborationError'
    this.code = code
  }
}

/** 文件 stat 的最小形状（lstat 返回满足此接口）。 */
export interface FileStat {
  isSymbolicLink(): boolean
  isFile(): boolean
}

/**
 * 协作存储依赖的最小文件系统能力。生产用 node:fs/promises 实现；
 * 测试注入内存/真实临时目录实现并可让 rename 失败以验证保旧文件。
 */
export interface CollaborationFs {
  mkdirp(dir: string): Promise<void>
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
  writeFile(path: string, content: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  lstat(path: string): Promise<FileStat>
}

/** RecordStore 可注入依赖：时间、UUID 与文件系统，供单测固定。 */
export interface RecordStoreDeps {
  now?: () => number
  uuid?: () => string
  fs?: CollaborationFs
}

/** RoleStore 可注入依赖：时间、UUID 与文件系统，供单测固定。 */
export interface RoleStoreDeps {
  now?: () => number
  uuid?: () => string
  fs?: CollaborationFs
}
