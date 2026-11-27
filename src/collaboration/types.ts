/**
 * 轻量团队协作共享类型与结构化错误（计划 Task 1）。
 *
 * 新代码全部集中于 src/collaboration/；本模块只定义数据类型、存储接口与
 * CollaborationError，零 node 依赖、零宿主（DSH）依赖、零旧 TaskLedger/RouterCore 依赖。
 * 数据布局：collaboration/roots/<sha256(rootSessionId)>/tasks/<taskId>/<recordId>.json，
 * 角色位于 collaboration/roles/<角色名>.md（正文是职责；可选文末候选围栏）。
 * rootSessionId 哈希只用于文件名，不产生权限。
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

/** 角色的一个有序候选模型。保存值是 trim 后的非空字符串。 */
export interface RoleModelCandidate {
  provider: string
  model: string
}

/**
 * 角色模板：一个角色一个 md 文件。文件名 = 角色 ID（稳定，不随名称变）。
 * name 是角色名（可变，改名只改文件内容、路径不动）；description 是职责正文切片；
 * models 缺省表示文件里没有合法围栏。不持久化空数组。
 */
export interface RoleTemplate {
  /** 角色 ID（=md 文件名主干）。一经分配不再变化，改名也不变。 */
  id: string
  /** 角色名（可改；全局唯一）。 */
  name: string
  description: string
  models?: RoleModelCandidate[]
}

/** 工作记录存储：模型主导读写，文件是唯一事实源，无全局索引/Markdown 副本。 */
export interface RecordStore {
  create(rootSessionId: string, input: RecordDraft): Promise<SavedRecord>
  read(rootSessionId: string, taskId: string, recordId: string): Promise<SavedRecord>
  list(rootSessionId: string, query?: RecordQuery): Promise<WorkRecord[]>
  update(rootSessionId: string, taskId: string, recordId: string, patch: RecordPatch): Promise<SavedRecord>
}

/** 角色模板存储：用户与模型通过同一保存能力创建/修改（带 ID 按 ID 更新、不带 ID 新建；名称唯一）。 */
export interface RoleStore {
  list(): Promise<RoleTemplate[]>
  /** 按角色名读一个角色模板；名读不到时按 ID 读（派发可容忍传 ID）。 */
  read(key: string): Promise<RoleTemplate>
  /**
   * 保存角色。带 id = 按该 ID 更新（改名只改文件内容、文件路径不动）；
   * 不带 id = 新建（按名称派生确定性 ID）。
   * 名称全局唯一：与别的角色重名整次拒绝（INVALID_INPUT），不静默产生两个同名角色。
   * models 缺省保留盘上已有候选；models 为数组则整次校验后写入
   * （空数组清空围栏）。形状不合法整次拒绝且不写文件。
   */
  save(input: { id?: string; name: string; description: string; models?: unknown }): Promise<RoleTemplate>
  /**
   * 按角色名或 ID 删除角色模板文件；不存在时静默返回 false。只给「退役预置角色」用：
   * 职责正文仍等于某版预置文本（= 用户没改过）才删，用户改过的永不动。
   */
  remove(key: string): Promise<boolean>
  /** 一次性把旧版 <uuid>.json 角色迁成 md；原 json 保留不删，坏文件跳过。 */
  migrateLegacyJson(): Promise<void>
  /**
   * 一次性把旧格式（文件名=角色名、无角色围栏）的 md 迁成 <id>.md 新格式：
   * 先写新文件、确认可读且正文逐字保留，再删旧文件；迁移残留（旧文件与新文件同名同角色）
   * 直接删旧文件。迁移前把整个 roles 目录备份到 collaboration/roles.bak-<时间戳>/（只备一次）。
   */
  migrateToIds(): Promise<RoleMigrationReport>
}

/** 一次性 ID 迁移的结果（供启动日志与报告引用）。 */
export interface RoleMigrationReport {
  /** 迁移成功（写成新格式文件并删掉旧文件）的角色数。 */
  migrated: number
  /** 清掉的迁移残留（旧格式重复文件）数。 */
  removed: number
  /** 备份目录路径；没有需要迁移的旧文件时缺省。 */
  backupPath?: string
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

/** RoleStore 可注入依赖：文件系统（md 无时间戳/编号，供单测注入）与时钟（备份目录时间戳）。 */
export interface RoleStoreDeps {
  fs?: CollaborationFs
  /** 当前时间（毫秒）；只用于备份目录名的时间戳，供单测固定。 */
  now?: () => number
}
