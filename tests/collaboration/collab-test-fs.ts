/**
 * collaboration 记录/角色测试用的真实文件系统夹具。
 *
 * 用真实 node:fs/promises 落临时目录（每测试 mkdtemp、afterAll 清理），
 * 生产实现走同一套接口；rename 可注入失败以验证「保存失败保旧文件」。
 */

import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { CollaborationFs } from '../../src/collaboration/types.ts'

export interface CollabFs {
  fs: CollaborationFs
  /** 让后续 rename 抛错（模拟落盘失败）。 */
  failRename: () => void
  /** 恢复 rename。 */
  healRename: () => void
}

/** 造一个 backed by node:fs/promises 的 CollaborationFs，rename 可切换失败。 */
export function makeCollabFs(): CollabFs {
  let failing = false
  const fs: CollaborationFs = {
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true })
    },
    readFile: (p) => readFile(p, 'utf8'),
    readdir: (p) => readdir(p),
    writeFile: (p, content) => writeFile(p, content, 'utf8'),
    rename: async (from, to) => {
      if (failing) throw new Error('injected rename failure')
      await rename(from, to)
    },
    remove: (p) => rm(p, { force: true }),
    lstat: (p) => lstat(p),
  }
  return {
    fs,
    failRename: () => {
      failing = true
    },
    healRename: () => {
      failing = false
    },
  }
}
