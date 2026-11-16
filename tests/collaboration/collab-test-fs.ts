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
  /**
   * 一次性读闸：下一次路径含 match 的 readFile 挂起，直到 releaseReadGate 释放。
   * 返回的 Promise 在闸被实际触发（readFile 发起）时 resolve，便于精确控制释放时机。
   * 用于验证写队列按提交顺序而非 IO 完成时刻排序。
   */
  armReadGate: (match: string) => Promise<void>
  /** 释放由 armReadGate 挂起的 readFile。 */
  releaseReadGate: () => void
}

/** 造一个 backed by node:fs/promises 的 CollaborationFs，rename 可切换失败、readFile 可一次性闸住。 */
export function makeCollabFs(): CollabFs {
  let failing = false
  let gateMatch: string | null = null
  let gateArmed = false
  let gateResolve: (() => void) | null = null
  let gateConsumed: (() => void) | null = null
  const fs: CollaborationFs = {
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true })
    },
    readFile: (p) => {
      if (gateArmed && gateMatch !== null && p.includes(gateMatch)) {
        gateArmed = false // 一次性：只闸住第一次匹配
        return new Promise<string>((resolve) => {
          gateResolve = () => resolve(readFile(p, 'utf8'))
          if (gateConsumed) gateConsumed() // 通知：闸已被触发，readFile 正在挂起
        })
      }
      return readFile(p, 'utf8')
    },
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
    armReadGate: (match: string) => {
      gateMatch = match
      gateArmed = true
      gateResolve = null
      return new Promise<void>((resolve) => {
        gateConsumed = resolve
      })
    },
    releaseReadGate: () => {
      const resolve = gateResolve
      gateResolve = null
      if (resolve) resolve()
    },
  }
}
