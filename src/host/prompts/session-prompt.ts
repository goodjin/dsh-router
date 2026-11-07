/**
 * 会话级 Router 系统提示词覆盖存储（v1.1 计划 Task C5，规格 §7）。
 *
 * - 持久化 dataDir/router-prompts.json，经 FsAdapter 注入（领域零 node 依赖）；
 * - get 是同步读：systemPrompt 组装是同步的，prompt-section 行的 text 回调
 *   不能等 Promise——所以装载一次进内存（load 幂等，宿主启动调一次），之后
 *   get 直读缓存；写路径照账本纪律：先改内存、一次落盘、失败回滚并抛
 *   persistence-failed；
 * - 回落语义：get undefined = 无覆盖，调用方回落 defaults.routerSystemPrompt
 *   （defaults 的读取与缓存在根服务，见 entry.ts 的 sessionPromptText）；
 * - 不变量：存过的值一律非空——set 空串/纯空白拒收（invalid-input），清空
 *   只走 clear。这样「get 返回值必为非空字符串」成立，回落判断不用防脏数据。
 * - 写后生效时机：system prompt 每轮组装时现读（section text 回调），覆盖
 *   保存后下一轮对话即生效（system-prompt/change 语义），无需重注册预设。
 */

import { LedgerError } from '../ledger/errors.ts'
import type { FsAdapter } from '../../shared/fs-adapter.ts'

/** 落盘形状。 */
export interface SessionPromptFile {
  schemaVersion: 1
  prompts: Record<string, string>
}

export class SessionPromptStore {
  private fs: FsAdapter
  private file: string
  private prompts = new Map<string, string>()
  private loaded = false

  constructor(fs: FsAdapter, file: string) {
    this.fs = fs
    this.file = file
  }

  /** 装载（幂等）：文件缺席或损坏 → 空表起步（覆盖全丢等价于全部回落默认，不炸装载）。 */
  async load(): Promise<void> {
    if (this.loaded) return
    let file: SessionPromptFile | null = null
    try {
      file = JSON.parse(await this.fs.readFile(this.file)) as SessionPromptFile
    } catch {
      file = null
    }
    if (file !== null && file.prompts !== null && typeof file.prompts === 'object') {
      for (const [sessionId, text] of Object.entries(file.prompts)) {
        if (sessionId !== '' && typeof text === 'string' && text.trim() !== '') {
          this.prompts.set(sessionId, text)
        }
      }
    }
    this.loaded = true
  }

  /** 同步读覆盖文本（未 load 或无覆盖 → undefined；返回值必非空）。 */
  get(sessionId: string): string | undefined {
    assertSessionId(sessionId)
    return this.prompts.get(sessionId)
  }

  /** 写覆盖（空串/纯空白拒收——清空走 clear）；一次落盘，失败回滚内存。 */
  async set(sessionId: string, text: string): Promise<void> {
    assertSessionId(sessionId)
    if (typeof text !== 'string' || text.trim() === '') {
      throw new LedgerError('invalid-input', '系统提示词覆盖不能为空（清空请走 clear）')
    }
    await this.commit(() => {
      this.prompts.set(sessionId, text)
    })
  }

  /** 清覆盖（回落默认；不存在的会话是 no-op）。 */
  async clear(sessionId: string): Promise<void> {
    assertSessionId(sessionId)
    if (!this.prompts.has(sessionId)) return
    await this.commit(() => {
      this.prompts.delete(sessionId)
    })
  }

  private async commit(mutate: () => void): Promise<void> {
    await this.load()
    mutate()
    const file: SessionPromptFile = { schemaVersion: 1, prompts: Object.fromEntries(this.prompts) }
    try {
      const parent = this.file.slice(0, this.file.lastIndexOf('/')) || '/'
      await this.fs.mkdirp(parent)
      await this.fs.writeFile(this.file, JSON.stringify(file, null, 2))
    } catch (cause) {
      // 重建内存（把本次变更退掉）：按 load 语义重读最健康的已知状态。
      this.loaded = false
      this.prompts.clear()
      await this.load()
      throw new LedgerError('persistence-failed', `会话提示词保存失败，内存已回滚: ${String(cause)}`, { cause })
    }
  }
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new LedgerError('invalid-input', 'sessionId 必填')
  }
}
