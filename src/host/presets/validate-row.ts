/**
 * 预设子行校验（v1.1 计划 Task A2）：声明行的包能不能在宿主安装目录里 import、
 * 行的 config 能不能过该包导出的 Config。
 *
 * v1 漏洞（离线核查器与运行时注册都要堵的同一个坑）：config-less 行被直接跳过，
 * 不过包 Config —— fs-search 行缺宿主必填的 `sampleOverCapGlobResults`（无默认
 * 值）没被发现，预设整树回滚，所有 worker 会话创建失败。所以这里对 config-less
 * 行以 `undefined` 输入调 Config（真宿主行为：`Config(undefined)` 对 required
 * 无默认键照抛，已在双宿主 0.2.1-rc.2 / 0.2.2-rc.1 实测）。
 *
 * 消费方两处，共用本文件（桌面 Electron 与 CLI 都是 Node 24，可原生 import 本
 * 源文件）：
 *  - `scripts/check-subrows.mjs`：离线门禁，静态 yml 的每条子行双宿主各跑一遍；
 *  - 运行时（Part C 动态注册）：注册前对每个动态行的 RowSpec 过同一套校验。
 *
 * 宿主包没有 .d.ts，import 产物按 any 收窄（只摸 `Config` 一个键）。
 * 本文件零依赖（只许 node 内建）：脚本子进程与运行时都直接装载它。
 */

import { existsSync, globSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

/** 一条声明行里校验所需的最小面。 */
export interface RowSpec {
  id: string
  name: string
  config?: unknown
}

/** 校验结论：ok 或逐条问题文本（自带行 id 上下文）。 */
export type RowVerdict = { ok: true } | { ok: false; problems: string[] }

/** 模块装载口（默认从宿主安装目录发现装载；测试注入假件）。 */
export type ValidateLoad = (name: string) => Promise<unknown>

/** makeHostLoader 的装配参数（都缺省时按本机探测）。 */
export interface HostLoaderOpts {
  /** 宿主安装目录里 @deepseek-ai/dsh 的 package.json 路径（DSH_HOST_BASE 同义）。 */
  base?: string
  /** 本插件仓库根（本包行的解析基准；缺省按本文件位置上溯三级）。 */
  pluginRoot?: string
}

/** 首行文本（报错只留指向性的一行；Error 取 message，不带 "Error: " 前缀）。 */
function firstLine(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return message.split('\n')[0] ?? message
}

/**
 * 宿主安装目录探测（顺序即优先级）：
 * DSH_HOST_BASE → 桌面 app.asar → ~/.local/share 与 nvm/homebrew 的 CLI 安装。
 * 探不到返回 undefined（调用方按「导入失败」报，不静默通过）。
 */
export function discoverHostBase(): string | undefined {
  const override = process.env.DSH_HOST_BASE
  if (override !== undefined && override !== '' && existsSync(override)) return override
  const candidates: string[] = []
  if (process.platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json')
  }
  const home = homedir()
  candidates.push(
    join(home, '.local/share/node-*/lib/node_modules/@deepseek-ai/dsh/package.json'),
    join(home, '.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh/package.json'),
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  )
  for (const candidate of candidates) {
    if (candidate.includes('*')) {
      for (const hit of globSync(candidate)) {
        if (existsSync(hit)) return hit
      }
    } else if (existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

/**
 * 宿主安装目录装载器（脚本与运行时共用同一份解析语义）：
 *  - `@deepseek-ai/*` 行从宿主基准解析；
 *  - 其他行（本包自己的子路径导出）先试插件根（Node 自引用），再退宿主基准；
 *  - 用 import() 而非 require()：宿主加载器走 import，插件 ESM 图有 top-level
 *    await，require 会在插件行上炸 ERR_REQUIRE_ASYNC_MODULE（容器核查器同规则）。
 * 全部候选失败时抛第一条错误（最贴近插件自己那份解析，报错才有指向性）。
 */
export function makeHostLoader(opts: HostLoaderOpts = {}): ValidateLoad {
  const pluginRoot =
    opts.pluginRoot ?? fileURLToPath(new URL('../../../', import.meta.url))
  const candidatesFor = (name: string): string[] => {
    const host = opts.base ?? discoverHostBase()
    // 本包的行先试插件根（Node 自引用，最贴近真实装载），再退宿主基准——
    // 与容器核查器同序：报错保留第一条（最贴近插件自己那份解析）。
    return name.startsWith('@deepseek-ai/')
      ? (host !== undefined ? [host] : [])
      : [join(pluginRoot, 'package.json'), ...(host !== undefined ? [host] : [])]
  }
  return async (name: string) => {
    const candidates = candidatesFor(name)
    let firstError: unknown = null
    for (const base of candidates) {
      try {
        const resolved = createRequire(base).resolve(name)
        return await import(pathToFileURL(resolved).href)
      } catch (error) {
        if (firstError === null) firstError = error
      }
    }
    if (firstError !== null) throw firstError
    throw Object.assign(
      new Error(`找不到宿主安装目录，无法装载 ${name}（可用 DSH_HOST_BASE 指定 @deepseek-ai/dsh/package.json）`),
      { code: 'HOST_BASE_NOT_FOUND' },
    )
  }
}

/** 单行校验（v1.1 计划 Task A2 接口）：见文件头。 */
export async function validateRowSpec(row: RowSpec, opts: { load?: ValidateLoad } = {}): Promise<RowVerdict> {
  // 组行是结构容器，没有包可校验；它的子行各自作为独立行过校验。
  if (row.name === 'cordis:group') return { ok: true }
  const load = opts.load ?? makeHostLoader()

  let mod: unknown
  try {
    mod = await load(row.name)
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return {
      ok: false,
      problems: [`${row.id}: 导入失败 ${typeof code === 'string' ? code : 'ERR'}: ${firstLine(error)}`],
    }
  }

  // 宿主包无 .d.ts：按 any 收窄，只摸 Config 一个键。
  const Config = (mod as { Config?: unknown } | null)?.Config
  if (typeof Config !== 'function') return { ok: true }

  if (Array.isArray(row.config)) {
    return { ok: false, problems: [`${row.id}: config 是数组（组行的子行应各自成行校验，包行不该带数组 config）`] }
  }

  // config-less 行以 undefined 过 Config —— v1 漏洞的堵点，不许跳过。
  try {
    ;(Config as (input: unknown) => unknown)(row.config)
    return { ok: true }
  } catch (error) {
    return { ok: false, problems: [`${row.id}: Config 校验失败: ${firstLine(error)}`] }
  }
}
