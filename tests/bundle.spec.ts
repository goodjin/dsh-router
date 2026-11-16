/**
 * 装载接线测试：这个包「装上了能不能真的跑起来」（轻量协作版，计划 Task 2B）。
 *
 * 这是**唯一**能提前发现致命错误的地方。DSH 浏览器半边有三条死规矩，少一条
 * 就是「装上也不生效、宿主日志一个字都没有」；另有形状规矩与入口规矩：
 *
 *  1. package.json 声明 `dsh.bundle.patch` 指向 cordis.patch.yml；
 *  2. package.json 声明 `dsh.client.platform = "web"`；
 *  3. patch 里装载行的 name 是**裸包名**；
 *  4. exports["./client"] 只能是字符串或 { default: 字符串 }；
 *  5. lib/client.js 必须是「单文件 CJS 工厂」，顶层不得有 import/export；
 *  6. exports["."] 指向宿主侧入口 dist/entry.js。
 *
 * Task 2B 起 patch 只有一条静态预设 dsh-router/Router（persona complete 提示词 =
 * collaborationPrompt 单一来源；七条协作工具 + DSH 原生执行/用户提问/项目指令/
 * 默认压缩/子代理控制）。旧 ./prompt-section 与 ./compaction 子路径导出已退役。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { collaborationPrompt } from '../src/collaboration/prompt.ts'

const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  name: string
  main: string
  exports: Record<string, unknown>
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
}

const PATCH_TEXT = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')

const BUNDLE_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const ENTRY_PATH = fileURLToPath(new URL('../dist/entry.js', import.meta.url))
const TOOLS_PATH = fileURLToPath(new URL('../dist/tools.js', import.meta.url))
const CONTEXT_PATH = fileURLToPath(new URL('../dist/context.js', import.meta.url))

type Factory = (require: (specifier: string) => unknown) => Record<string, unknown>
type Row = { id: string; factory: Factory }

/** 把产物当文本求值，取出它登记的工厂行（模拟 window.__ModuleLoader__.load）。 */
function loadBundleRow(): Row {
  const src = readFileSync(BUNDLE_PATH, 'utf8')
  const rows: Row[] = []
  const sandboxWindow = { __ModuleLoader__: { load: (row: Row) => { rows.push(row) } } }
  const evaluate = new Function('window', src)
  evaluate(sandboxWindow)
  expect(rows.length, '产物必须调用一次 window.__ModuleLoader__.load').toBe(1)
  return rows[0]!
}

describe('package.json 满足浏览器半边的接线条件', () => {
  it('dsh.bundle.patch 与 dsh.client.platform=web 都在', () => {
    expect(PKG.name).toBe('@goodjin2/dsh-router')
    expect(PKG.dsh?.bundle?.patch, '缺 dsh.bundle.patch：宿主会整层跳过这个 bundle').toBe('./cordis.patch.yml')
    expect(PKG.dsh?.client?.platform, '缺 dsh.client.platform=web：行不会被认成浏览器行').toBe('web')
  })

  it('exports["./client"] 是字符串或 { default: 字符串 }，指向 lib/client.js', () => {
    const clientExport = PKG.exports['./client']
    const valid = typeof clientExport === 'string'
      || (typeof clientExport === 'object' && clientExport !== null && typeof (clientExport as { default?: unknown }).default === 'string')
    expect(valid, '宿主 clientExportOf 只认字符串或带字符串 default 的对象').toBe(true)
    const target = typeof clientExport === 'string' ? clientExport : (clientExport as { default: string }).default
    expect(target).toBe('./lib/client.js')
  })

  it('exports["."] 与 main 指向宿主侧产物 dist/entry.js，不混浏览器代码', () => {
    const dotExport = PKG.exports['.'] as { types?: string; default?: string }
    expect(typeof dotExport?.default, 'exports["."] 必须有字符串 default').toBe('string')
    expect(dotExport.default).toBe('./dist/entry.js')
    expect(PKG.main).toBe('./dist/entry.js')
    expect(dotExport.default).not.toContain('client')
    expect(PKG.main).not.toContain('client')
    expect(existsSync(ENTRY_PATH), 'dist/entry.js 不存在——先 npm run build').toBe(true)
    const entryCode = readFileSync(ENTRY_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(entryCode).not.toMatch(/\b(window|document)\b/)
    expect(entryCode).not.toContain('lib/client')
  })

  it('子路径导出 ./tools、./context 存在且指向构建产物（./prompt-section、./compaction 已退役），产物可加载', async () => {
    for (const [key, file] of [
      ['./tools', TOOLS_PATH],
      ['./context', CONTEXT_PATH],
    ] as const) {
      const exportEntry = PKG.exports[key] as { types?: string; default?: string } | undefined
      expect(exportEntry, `${key} 导出缺失：预设树里的行会 never started → 整预设回滚`).toBeDefined()
      expect(exportEntry?.default).toBe(`./dist/${key.slice(2)}.js`)
      expect(existsSync(file), `${key} 的构建产物不存在——先 npm run build`).toBe(true)
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
      expect(typeof mod.name, `${key} 产物缺 name`).toBe('string')
      expect(Array.isArray(mod.inject), `${key} 产物缺 inject`).toBe(true)
      expect(typeof mod.Config, `${key} 产物缺 Config（check-host-rows 要校验）`).toBe('function')
      expect(typeof mod.apply, `${key} 产物缺 apply`).toBe('function')
    }
    // 已退役的子路径导出不得再存在
    expect(PKG.exports['./prompt-section'], './prompt-section 导出已退役').toBeUndefined()
    expect(PKG.exports['./compaction'], './compaction 导出已退役').toBeUndefined()
    const toolsMod = (await import(pathToFileURL(TOOLS_PATH).href)) as { Config: (config: unknown) => unknown; name: string }
    expect(() => toolsMod.Config({})).not.toThrow()
    const contextMod = (await import(pathToFileURL(CONTEXT_PATH).href)) as { Config: (config: unknown) => unknown }
    expect(() => contextMod.Config({})).not.toThrow()
  })
})

describe('宿主产物的官方包装载必须经宿主基座解析', () => {
  it('dist 产物不得再出现裸 @deepseek-ai/ 动态导入（宿主基座解析语义看守）', () => {
    const violations: string[] = []
    for (const rel of ['../dist/entry.js'] as const) {
      const file = fileURLToPath(new URL(rel, import.meta.url))
      if (!existsSync(file)) continue
      const code = readFileSync(file, 'utf8')
      for (const match of code.matchAll(/import\(\s*["']@deepseek-ai\/[^"']+["']\s*\)/g)) {
        violations.push(`${rel}: ${match[0]}`)
      }
    }
    expect(violations, '官方包装载必须经宿主基座解析，裸动态导入在桌面宿主上静默失败').toEqual([])
  })
})

describe('cordis.patch.yml 的装载行', () => {
  it('有一条 name 为裸包名的装载行；子路径行只许宿主侧 ./tools、./context', () => {
    expect(PATCH_TEXT).toMatch(/-\s+id:\s*dsh-router-client\b/)
    expect(PATCH_TEXT).toMatch(/name:\s*['"]@goodjin2\/dsh-router['"]\s*$/m)
    const subpathRows = [...PATCH_TEXT.matchAll(/name:\s*['"]@goodjin2\/dsh-router\/([^'"]+)['"]/g)].map((m) => m[1])
    expect(subpathRows.sort()).toEqual(['context', 'tools'])
  })

  it('静态预设行只有一条：dsh-router/Router（完整=true；无旧 executor/supervisor/worker 别名）', () => {
    const presetRows = [...PATCH_TEXT.matchAll(/- id:\s*(dsh-router-[\w-]*)\n\s*name:\s*'@deepseek-ai\/dsh-agent-preset'\n\s*config:\n\s*id:\s*([\w-]+)/g)]
    expect(presetRows.map((m) => m[2])).toEqual(['dsh-router'])
    expect(PATCH_TEXT).not.toMatch(/id:\s*dsh-router-executor\b/)
    expect(PATCH_TEXT).not.toMatch(/id:\s*dsh-router-supervisor\b/)
    expect(PATCH_TEXT).not.toMatch(/id:\s*dsh-router-worker\b/)
  })

  it('tools 行无 role 配置（角色闸已退役；注册七条协作工具）', () => {
    // tools 行存在且 name 为裸包名子路径；其后 200 字符内不得出现 role 键。
    const at = PATCH_TEXT.indexOf("name: '@goodjin2/dsh-router/tools'")
    expect(at, 'Router 预设必须有 tools 行').toBeGreaterThan(-1)
    const after = PATCH_TEXT.slice(at, at + 200)
    expect(after).not.toMatch(/role:/)
  })

  it('delegation 组挂子代理行：control 裸行 + list-agents + spawn 行；禁死键', () => {
    expect(PATCH_TEXT).toMatch(/- id:\s*tool-subagent-control\n\s*name:\s*'@deepseek-ai\/dsh-tool-subagent-control'\n/)
    expect(PATCH_TEXT).toMatch(/- id:\s*tool-subagent-list-agents\n\s*name:\s*'@deepseek-ai\/dsh-tool-subagent-control\/list-agents'\n/)
    expect(PATCH_TEXT).toMatch(/- id:\s*tool-subagent\n\s*name:\s*'@deepseek-ai\/dsh-tool-subagent'\n\s*config:\n\s*provider:\s*spawn\n\s*toolName:\s*subagent\n\s*maxDepth:\s*2\n/)
    for (const deadKey of ['modelSelectionSettings', 'modelSelection', 'modelDiscovery', 'backgroundMode']) {
      expect(PATCH_TEXT, `死键 ${deadKey} 不得出现`).not.toMatch(new RegExp(`^\\s+${deadKey}:`, 'm'))
    }
  })

  it('默认压缩用宿主原生 compaction 组（非旧 @goodjin2/dsh-router/compaction）', () => {
    const names = new Set([...PATCH_TEXT.matchAll(/name:\s*'(@deepseek-ai\/[^']+)'/g)].map((m) => m[1]))
    expect(names).toContain('@deepseek-ai/dsh-compaction-basic')
    expect(names).toContain('@deepseek-ai/dsh-command-compact')
    expect(names).toContain('@deepseek-ai/dsh-compaction-tool-result-pruner')
    expect(names).not.toContain('@goodjin2/dsh-router/compaction')
  })
})

/** 用包内 yaml 解析 patch 文本（logLevel 静默——!!js 表达式只读得下来即可）。 */
function parseYml(text: string): unknown {
  return parse(text, { logLevel: 'silent' }) as unknown
}

/** 取 dsh-router/Router 预设行（顶层是 [ { insert: [...] } ]）。 */
function routerPresetPlugins(doc: unknown): unknown[] {
  const documents = Array.isArray(doc) ? doc : [doc]
  for (const document of documents) {
    const inserts = (document as { insert?: unknown[] } | null)?.insert ?? []
    for (const row of inserts) {
      const entry = row as { config?: { id?: string; plugins?: unknown[] } }
      if (entry.config?.id === 'dsh-router') return entry.config.plugins ?? []
    }
  }
  throw new Error('yml 里找不到 Router 预设 dsh-router')
}

describe('persona 文本与 collaborationPrompt 单一来源逐字同步', () => {
  it('Router persona complete:true，prefix 即 collaborationPrompt（生成脚本实际导入）', () => {
    const doc = parseYml(PATCH_TEXT)
    const plugins = routerPresetPlugins(doc)
    const persona = plugins
      .map((p) => p as { name?: string; config?: { prefix?: string; complete?: boolean } })
      .find((p) => p.name === '@deepseek-ai/dsh-persona')
    expect(persona, 'Router 预设必须有 persona 行').toBeTruthy()
    expect(persona?.config?.complete).toBe(true)
    const prefix = persona?.config?.prefix ?? ''
    expect(prefix.trim()).toBe(collaborationPrompt.trim())
    // C5 看守：complete 段唯一——不残留 persona 行之外的 complete 来源
    expect(PATCH_TEXT).not.toMatch(/id:\s*router-prompt-section\b/)
  })

  it('生成脚本实际导出 collaborationPrompt（Node TS stripping）', () => {
    // 这一条在 vitest 里直接 import 即证；再断言非空、无宿主插值语法。
    expect(collaborationPrompt.length).toBeGreaterThan(100)
    expect(collaborationPrompt).not.toContain('{{')
    expect(collaborationPrompt).not.toContain('${')
  })
})

describe('lib/client.js 是页面能装的产物', () => {
  /** 页面模块表的假面：只放行外置模块清单里的 react 系；其余一律抛错。 */
  function pageRequire(): ((specifier: string) => unknown) & { required: string[] } {
    const allowed = new Set(['react', 'react-dom', 'react/jsx-runtime'])
    const required: string[] = []
    const require = (specifier: string): unknown => {
      required.push(specifier)
      if (!allowed.has(specifier)) {
        throw new Error(`产物请求了模块表外的模块：${specifier}`)
      }
      return specifier === 'react/jsx-runtime'
        ? { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
        : {
            useState: () => [undefined, () => {}],
            useEffect: () => {},
            useMemo: (factory: () => unknown) => factory(),
            useRef: () => ({ current: undefined }),
            useCallback: (fn: unknown) => fn,
            useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
              subscribe(() => {})
              return getSnapshot()
            },
          }
    }
    return Object.assign(require, { required })
  }

  /** 记录型假 ctx（与 entry.spec 同款，独立在此避免跨文件共享状态）。 */
  function recordingWindowCtx() {
    const captured = {
      injected: [] as string[],
      registered: [] as Array<{ name: string; id?: string }>,
      effects: 0,
      infos: [] as string[],
    }
    const ctx = {
      logger: () => ({
        info: (message: string) => { captured.infos.push(message) },
        warn: () => {},
      }),
      effect: (callback: () => unknown) => { captured.effects += 1; return undefined },
      slots: {
        inject: (key: string, prepare: () => unknown) => {
          captured.injected.push(key)
          return prepare()
        },
        register: (options: { name: string; id?: string }, _component: unknown) => {
          captured.registered.push({ name: options.name, id: options.id })
          return options
        },
      },
      uiSession: {
        adapter: {
          current: {
            subscribe: (_listener: () => void) => () => {},
            getSnapshot: () => ({ key: 's1' }),
          },
        },
      },
      uiWorkspace: { openSession: (_id: string) => {} },
      workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    }
    return { ctx, captured }
  }

  it('是 ModuleLoader 工厂：登记正确的 id，factory 执行后 name/inject/apply 齐全、apply 空跑不抛', () => {
    expect(existsSync(BUNDLE_PATH), 'lib/client.js 不存在——先 npm run build').toBe(true)
    const src = readFileSync(BUNDLE_PATH, 'utf8')

    expect(src).toMatch(/window\.__ModuleLoader__\.load\(/)
    expect(src, '产物顶层不得有 import 声明').not.toMatch(/(^|\n)\s*import\s+["'{\w]/)
    expect(src, '产物顶层不得有 export 声明').not.toMatch(/(^|\n)\s*export\s+[\w{*]/)

    const row = loadBundleRow()
    expect(row.id).toBe('@goodjin2/dsh-router')

    const require = pageRequire()
    const loaded = row.factory(require)
    expect(loaded.name, '产物必须导出与包名一致的 name').toBe('@goodjin2/dsh-router')
    expect(Array.isArray(loaded.inject), '产物必须导出 inject（页面真实服务名）').toBe(true)
    expect(loaded.inject).toEqual(['slots', 'uiSession', 'uiWorkspace'])
    expect(typeof loaded.apply, '产物必须导出 apply').toBe('function')
    for (const specifier of require.required) {
      expect(['react', 'react-dom', 'react/jsx-runtime']).toContain(specifier)
    }

    const { ctx, captured } = recordingWindowCtx()
    expect(() => (loaded.apply as (ctx: unknown) => void)(ctx)).not.toThrow()
    expect([...captured.injected].sort()).toEqual([
      'conversation.header.leading',
    ].sort())
    expect(captured.injected, '旧浮窗/设置段已退役，不得再注入').not.toContain('shell.overlay')
    expect(captured.injected).not.toContain('settings.section')
    const ids = captured.registered.map((entry) => entry.id)
    expect(ids).toEqual([
      'router-collaboration-workbench',
    ])
    expect(ids, '产物不得再登记旧表面').not.toContain('router-workbench-tabs')
    expect(ids).not.toContain('router-settings')
    expect(captured.infos.join(' ')).toMatch(/collaboration workbench/i)
    expect(captured.effects).toBeGreaterThanOrEqual(1)
  })

  it('服务缺失时降级：只警告不注册、不抛（页面给残缺 ctx 也不能炸）', () => {
    const row = loadBundleRow()
    const loaded = row.factory(pageRequire())
    const warns: string[] = []
    const ctx = {
      logger: () => ({ info: () => {}, warn: (message: string) => { warns.push(message) } }),
      effect: () => undefined,
    }
    expect(() => (loaded.apply as (ctx: unknown) => void)(ctx)).not.toThrow()
    expect(() => (loaded.apply as (ctx: unknown) => void)(undefined)).not.toThrow()
    expect(() => (loaded.apply as (ctx: unknown) => void)({})).not.toThrow()
    expect(warns.join(' ')).toContain('slots')
  })
})
