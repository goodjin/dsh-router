/**
 * 内存版 FsAdapter：记忆相关测试共用，不碰真实磁盘。
 *
 * 行为对齐真实适配器的两条硬约束，防止实现方漏调 mkdirp 之类的 bug 在内存里被掩盖：
 * - writeFile 要求父目录已经 mkdirp 过，否则抛错；
 * - readdir 要求目录存在（exists=false 时会抛），检索方需先用 exists 把门。
 */

import type { FsAdapter } from '../../src/shared/fs-adapter.ts'

export interface MemFs {
  fs: FsAdapter
  /** 已写入文件的内容，键为规范化后的绝对路径（测试直接断言落盘形状用）。 */
  files: Map<string, string>
  /** 已 mkdirp 过的目录集合。 */
  dirs: Set<string>
}

function normalize(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function makeMemFs(): MemFs {
  const files = new Map<string, string>()
  const dirs = new Set<string>()

  const fs: FsAdapter = {
    async readFile(p) {
      const content = files.get(normalize(p))
      if (content === undefined) throw new Error(`memfs: ENOENT ${p}`)
      return content
    },
    async writeFile(p, content) {
      const np = normalize(p)
      if (!dirs.has(parentOf(np))) {
        throw new Error(`memfs: parent dir missing for ${p} (mkdirp first)`)
      }
      files.set(np, content)
    },
    async mkdirp(p) {
      let current = ''
      for (const seg of normalize(p).split('/').filter(Boolean)) {
        current += `/${seg}`
        dirs.add(current)
      }
    },
    async exists(p) {
      const np = normalize(p)
      return files.has(np) || dirs.has(np)
    },
    async readdir(p) {
      const np = normalize(p)
      if (!dirs.has(np)) throw new Error(`memfs: ENOENT readdir ${p}`)
      const names: string[] = []
      for (const key of files.keys()) {
        if (parentOf(key) === np) {
          names.push(key.slice(np === '/' ? 1 : np.length + 1))
        }
      }
      return names.sort()
    },
  }

  return { fs, files, dirs }
}
