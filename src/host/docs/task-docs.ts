/**
 * 任务文档存储 TaskDocStore（计划 Task 3）。
 *
 * 目录协议（规格 §5）：tasks/<ID>/ 下 task.v1.md 原始任务书不可变，supplement
 * 只追加新版本文件，progress.md 当前进展，result.md 最终交付报告。一切 IO 经
 * 注入的 FsAdapter，领域代码零宿主依赖。
 */

import type { FsAdapter } from '../../shared/fs-adapter.ts'
import type { TaskRecord, TaskResult } from '../../shared/types.ts'
import { LedgerError } from '../ledger/errors.ts'

/** result.md 的 Markdown 渲染：五字段齐全。 */
function renderResult(taskId: string, result: TaskResult): string {
  const deliverables = result.deliverables ?? []
  const openIssues = result.openIssues ?? []
  const lines = [
    `# 任务结果 ${taskId}`,
    '',
    '## 结果摘要',
    result.summary,
    '',
    '## 交付物',
    deliverables.length > 0 ? deliverables.map((d) => `- ${d}`).join('\n') : '无',
    '',
    '## 验收依据',
    result.acceptanceEvidence ?? '无',
    '',
    '## 遗留问题',
    openIssues.length > 0 ? openIssues.map((d) => `- ${d}`).join('\n') : '无',
    '',
    '## 完成时间',
    result.completedAt !== undefined ? new Date(result.completedAt).toISOString() : '未知',
    '',
  ]
  return lines.join('\n')
}

/** 任务文档存储：tasks/<ID>/ 下的版本化文档读写。 */
export class TaskDocStore {
  private rootDir: string
  private fs: FsAdapter

  constructor(rootDir: string, fs: FsAdapter) {
    this.rootDir = rootDir
    this.fs = fs
  }

  /** 拼路径（不用 node:path，保持零宿主依赖）。 */
  private join(...parts: string[]): string {
    return parts.filter((p) => p !== '').join('/')
  }

  private taskDir(taskId: string): string {
    return this.join(this.rootDir, 'tasks', taskId)
  }

  /** 文档路径；带版本时为 <name>.v<N>.md（如 task.v2.md），否则 <name>.md。 */
  docPath(taskId: string, name: string, version?: number): string {
    const file = version !== undefined ? `${name}.v${version}.md` : `${name}.md`
    return this.join(this.rootDir, 'tasks', taskId, file)
  }

  /** 初始化任务书：写 task.v1.md；已存在抛 doc-exists（原始任务书不可变）。 */
  async initTask(task: TaskRecord, book: string): Promise<string> {
    const path = this.docPath(task.id, 'task', 1)
    await this.fs.mkdirp(this.taskDir(task.id))
    if (await this.fs.exists(path)) {
      throw new LedgerError('doc-exists', `任务书已存在，拒绝覆盖: ${path}`)
    }
    await this.fs.writeFile(path, book)
    return path
  }

  /**
   * 补充要求：以 fromVersion 文件为底，生成 v{fromVersion+1}——「v N 补充」节 +
   * 原文，旧文件字节不动。底版不存在抛 doc-not-found；目标版已存在抛 doc-exists。
   */
  async supplement(taskId: string, fromVersion: number, additions: string[]): Promise<number> {
    const fromPath = this.docPath(taskId, 'task', fromVersion)
    if (!(await this.fs.exists(fromPath))) {
      throw new LedgerError('doc-not-found', `任务书版本不存在: ${fromPath}`)
    }
    const next = fromVersion + 1
    const nextPath = this.docPath(taskId, 'task', next)
    if (await this.fs.exists(nextPath)) {
      throw new LedgerError('doc-exists', `任务书版本已存在，疑似并发补充: ${nextPath}`)
    }
    const original = await this.fs.readFile(fromPath)
    const body = additions.length > 0 ? additions.map((a) => `- ${a}`).join('\n') : '（无新增内容）'
    await this.fs.writeFile(nextPath, `${original}\n\n## v${next} 补充\n\n${body}\n`)
    return next
  }

  /** 写当前进展（覆写语义）。 */
  async writeProgress(taskId: string, text: string): Promise<string> {
    const path = this.docPath(taskId, 'progress')
    await this.fs.mkdirp(this.taskDir(taskId))
    await this.fs.writeFile(path, text)
    return path
  }

  /** 写最终交付报告 result.md，返回路径。 */
  async writeResult(taskId: string, result: TaskResult): Promise<string> {
    const path = this.docPath(taskId, 'result')
    await this.fs.mkdirp(this.taskDir(taskId))
    await this.fs.writeFile(path, renderResult(taskId, result))
    return path
  }

  /** 读文档；不存在抛 doc-not-found。 */
  async readDoc(taskId: string, name: string, version?: number): Promise<string> {
    const path = this.docPath(taskId, name, version)
    if (!(await this.fs.exists(path))) {
      throw new LedgerError('doc-not-found', `文档不存在: ${path}`)
    }
    return this.fs.readFile(path)
  }
}
