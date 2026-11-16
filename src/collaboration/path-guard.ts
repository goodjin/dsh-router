/**
 * 受控命名空间路径守卫（计划 Task 1 修复 1）。
 *
 * 只守协作命名空间 collaboration 及其下的目录组件：从命名空间根到目标文件父目录的
 * 每个「已存在」组件都不得是符号链接；最终文件须为普通文件（非符号链接）。
 * 不守 dataDir 祖先、不研究敌对同进程 TOCTOU、不做多宿主联合判断——仅本地 JSON 存储的正确性。
 * 这是 collaboration 内部的私有小工具，不是通用存储框架，不经 entry/UI/旧协议导出。
 */

import { dirname, sep } from 'node:path'

import { CollaborationError, type CollaborationFs } from './types.ts'

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

export class PathGuard {
  /**
   * @param fs   协作存储注入的文件系统（与 store 同一个实例）。
   * @param base 受控命名空间根（join(dataDir, 'collaboration')）。
   */
  constructor(
    private readonly fs: CollaborationFs,
    private readonly base: string,
  ) {}

  /**
   * 从 start 起（含 start）、沿已存在组件到 base（含 base）逐个校验不得为符号链接。
   * 尚不存在的组件跳过；其他 stat 错误归 IO_ERROR。assertDirChain/assertDirectory 共用。
   */
  private async assertChainFrom(start: string): Promise<void> {
    const chain: string[] = []
    let cur = start
    for (;;) {
      if (cur === this.base || cur.startsWith(this.base + sep)) {
        chain.push(cur)
        if (cur === this.base) break
        cur = dirname(cur)
      } else {
        break
      }
    }
    for (const dir of chain) {
      let stat
      try {
        stat = await this.fs.lstat(dir)
      } catch (error) {
        if (isEnoent(error)) continue
        throw new CollaborationError('IO_ERROR', `命名空间目录检查失败: ${dir}`, { cause: error })
      }
      if (stat.isSymbolicLink()) {
        throw new CollaborationError('INVALID_INPUT', `命名空间不接受符号链接目录: ${dir}`)
      }
    }
  }

  /**
   * 校验 target 父目录链上、从 base 起（含 base）每个已存在组件都不得是符号链接。
   * 尚不存在的目录（写入前由 mkdirp 创建）跳过；其他 stat 错误归 IO_ERROR。
   */
  async assertDirChain(target: string): Promise<void> {
    await this.assertChainFrom(dirname(target))
  }

  /**
   * 校验目录自身及其到 base 的已存在组件不得为符号链接（含目录本身）。
   * list 在 readdir 某目录前调用，避免符号链接目录被当普通空目录返回 []。
   * 目录尚不存在时跳过（交由 readdir 的 ENOENT 处理），不创建目录。
   */
  async assertDirectory(dir: string): Promise<void> {
    await this.assertChainFrom(dir)
  }

  /**
   * 校验最终文件为普通文件（非符号链接、非目录等）。缺失抛 NOT_FOUND；其他错误抛 IO_ERROR。
   * 读路径专用；写入路径的目标文件此时可能尚不存在，改用 assertDirChain。
   */
  async assertRegularFile(path: string, what: string): Promise<void> {
    let stat
    try {
      stat = await this.fs.lstat(path)
    } catch (error) {
      if (isEnoent(error)) throw new CollaborationError('NOT_FOUND', `${what}不存在`)
      throw new CollaborationError('IO_ERROR', `${what}读取失败`, { cause: error })
    }
    if (stat.isSymbolicLink()) {
      throw new CollaborationError('INVALID_INPUT', `${what}不接受符号链接: ${path}`)
    }
    if (!stat.isFile()) {
      throw new CollaborationError('INVALID_INPUT', `${what}不是普通文件: ${path}`)
    }
  }
}
