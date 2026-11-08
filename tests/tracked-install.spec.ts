/**
 * 仅凭 git 跟踪文件的「干净安装」可加载（router-header-index fix round 1，
 * I9 回归）。宿主入口四个产物必须是自包含 bundle：历史上 tsc 平铺产物带着
 * `./host/...` 相对导入，而 dist/host、dist/shared 都被 .gitignore 排除——
 * GitHub 安装直接加载失败。本文件双保险：
 *
 *  1. 静态：四个产物剥注释后不得再出现任何相对导入（静态或动态）。
 *  2. 动态：按 `git ls-files` 取跟踪文件清单，拷进干净目录（模拟 GitHub
 *     安装只有跟踪文件）、软链 node_modules（宿主/依赖由安装环境提供），
 *     逐一 import 四个入口并断言导出形状。
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ENTRIES = ['dist/entry.js', 'dist/tools.js', 'dist/context.js', 'dist/prompt-section.js'] as const

const stagingRoot = join(tmpdir(), `router-tracked-install-${process.pid}`)
afterAll(() => {
  rmSync(stagingRoot, { recursive: true, force: true })
})

describe('宿主产物自包含（I9）', () => {
  for (const entry of ENTRIES) {
    it(`${entry} 无相对导入（相对闭包全部内联）`, () => {
      const path = join(repoRoot, entry)
      expect(existsSync(path), `${entry} 不存在——先 npm run build`).toBe(true)
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/^[^'"\n]*\/\/.*$/gm, '')
      expect(code, `${entry} 不得有静态相对导入`).not.toMatch(/from\s*['"]\.\//)
      expect(code, `${entry} 不得有动态相对导入`).not.toMatch(/import\s*\(\s*['"]\.\//)
      expect(code, `${entry} 不得有相对 require`).not.toMatch(/require\s*\(\s*['"]\.\//)
    })
  }
})

describe('仅跟踪文件的干净安装可加载（I9）', () => {
  it('git 跟踪的 dist/lib/package.json 拷入干净目录后四个入口都能 import 且形状齐全', async () => {
    const tracked = execFileSync('git', ['ls-files', 'dist', 'lib', 'package.json'], { cwd: repoRoot, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
    expect(tracked).toContain('package.json')
    for (const entry of ENTRIES) {
      expect(tracked, `${entry} 必须是跟踪文件`).toContain(entry)
    }
    // 干净目录不含任何被 ignore 的中间产物（dist/host、dist/client 等）。
    expect(tracked.some((file) => file.startsWith('dist/host/') || file.startsWith('dist/client/') || file.startsWith('dist/shared/'))).toBe(false)

    const staging = join(stagingRoot, 'install')
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    for (const file of tracked) {
      const target = join(staging, file)
      mkdirSync(join(target, '..'), { recursive: true })
      cpSync(join(repoRoot, file), target)
    }
    // 依赖与宿主服务在真实安装里由环境提供；测试用本仓 node_modules 软链模拟。
    symlinkSync(join(repoRoot, 'node_modules'), join(staging, 'node_modules'))

    const entryMod = (await import(pathToFileURL(join(staging, 'dist/entry.js')).href)) as Record<string, unknown>
    expect(entryMod['name']).toBe('@goodjin2/dsh-router')
    expect(Array.isArray(entryMod['inject'])).toBe(true)
    expect(typeof entryMod['apply']).toBe('function')
    expect(typeof entryMod['Config']).toBe('function')

    for (const sub of ['tools', 'context', 'prompt-section']) {
      const mod = (await import(pathToFileURL(join(staging, `dist/${sub}.js`)).href)) as Record<string, unknown>
      expect(typeof mod['name'], `${sub} 缺 name`).toBe('string')
      expect(Array.isArray(mod['inject']), `${sub} 缺 inject`).toBe(true)
      expect(typeof mod['Config'], `${sub} 缺 Config`).toBe('function')
      expect(typeof mod['apply'], `${sub} 缺 apply`).toBe('function')
    }
  })
})
