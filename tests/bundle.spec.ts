/**
 * 装载接线测试：这个包「装上了能不能真的跑起来」。
 *
 * 这是**唯一**能提前发现致命错误的地方。DSH 浏览器半边有三条死规矩，少一条
 * 就是「装上也不生效、宿主日志一个字都没有」（2026-11 在 dsh-rightbar-overlay
 * 上踩过整组坑）；另有两条形状规矩与入口规矩：
 *
 *  1. package.json 声明 `dsh.bundle.patch` 指向 cordis.patch.yml——没有这段，
 *     宿主读 profile 时整层跳过（启动日志里只有一句 "skipping profile bundle"）；
 *  2. package.json 声明 `dsh.client.platform = "web"`——客户端模块注册表
 *     （ClientModuleRegistry.resolveMeta）靠它把行认成浏览器行；
 *  3. patch 里装载行的 name 是**裸包名**——浏览器行只在 name 恰好等于包名时被认；
 *  4. exports["./client"] 只能是字符串或 { default: 字符串 }——宿主
 *     clientExportOf 只认这两种；
 *  5. lib/client.js 必须是「单文件 CJS 工厂」，顶层不得有 import/export；
 *  6. exports["."] 指向宿主侧入口 dist/entry.js——浏览器代码不许混进宿主进程。
 *
 * Part B 起 patch 还有三条预设行（工具/上下文子路径导出、persona 文本与 TS 模板
 * 逐字同步），一并在这里断言。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { routerPrompt } from '../src/host/prompts/router.ts'
import { supervisorPrompt } from '../src/host/prompts/supervisor.ts'
import { workerPrompt } from '../src/host/prompts/worker.ts'
import { buildRouterPresetDefinition, staticRouterDefinition } from '../src/host/presets/dynamic.ts'

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
const PROMPT_SECTION_PATH = fileURLToPath(new URL('../dist/prompt-section.js', import.meta.url))

type Factory = (require: (specifier: string) => unknown) => Record<string, unknown>
type Row = { id: string; factory: Factory }

/** 把产物当文本求值，取出它登记的工厂行（模拟 window.__ModuleLoader__.load）。 */
function loadBundleRow(): Row {
  const src = readFileSync(BUNDLE_PATH, 'utf8')
  const rows: Row[] = []
  const sandboxWindow = { __ModuleLoader__: { load: (row: Row) => { rows.push(row) } } }
  // 产物顶层只引用 window。Function 体是脚本模式：顶层 import/export 会在这里
  // 直接 SyntaxError——所以「求值成功」本身就是「没有顶层 ESM」的证明。
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
    // 宿主入口已构建，且确实没有浏览器半边：剥掉注释后不得引用 window / document /
    // lib/client（Part B 起入口有宿主侧 import，属于正常；这三样才是浏览器线）。
    expect(existsSync(ENTRY_PATH), 'dist/entry.js 不存在——先 npm run build').toBe(true)
    const entryCode = readFileSync(ENTRY_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(entryCode).not.toMatch(/\b(window|document)\b/)
    expect(entryCode).not.toContain('lib/client')
  })

  it('子路径导出 ./tools、./context、./prompt-section 存在且指向构建产物，产物可加载', async () => {
    for (const [key, file] of [
      ['./tools', TOOLS_PATH],
      ['./context', CONTEXT_PATH],
      ['./prompt-section', PROMPT_SECTION_PATH],
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
    // Config 真能校验：role 必填；context/prompt-section 缺省可过
    const toolsMod = (await import(pathToFileURL(TOOLS_PATH).href)) as { Config: (config: unknown) => unknown; name: string }
    expect(() => toolsMod.Config({ role: 'router' })).not.toThrow()
    expect(() => toolsMod.Config({})).toThrow()
    const contextMod = (await import(pathToFileURL(CONTEXT_PATH).href)) as { Config: (config: unknown) => unknown }
    expect(() => contextMod.Config({})).not.toThrow()
    const promptSectionMod = (await import(pathToFileURL(PROMPT_SECTION_PATH).href)) as { Config: (config: unknown) => unknown }
    expect(() => promptSectionMod.Config(undefined)).not.toThrow()
    expect(() => promptSectionMod.Config({})).not.toThrow()
  })
})

describe('cordis.patch.yml 的装载行', () => {
  it('有一条 name 为裸包名的装载行；子路径行只许宿主侧 ./tools', () => {
    expect(PATCH_TEXT).toMatch(/-\s+id:\s*dsh-router-client\b/)
    expect(PATCH_TEXT).toMatch(/name:\s*['"]@goodjin2\/dsh-router['"]\s*$/m)
    // 子路径行是宿主行（node 里 import 构建产物）；浏览器半边只有裸包名一条。
    // v1.1 C1 起 Router 预设动态注册：静态 yml 只剩 supervisor/worker 两条预设，
    // tools 行各一条（×2）；context 行只在动态 Router 定义里（presets-dynamic
    // 看守）。其它任何子路径（尤其指向浏览器产物的）都会静默失效，直接禁止。
    const subpathRows = [...PATCH_TEXT.matchAll(/name:\s*['"]@goodjin2\/dsh-router\/([^'"]+)['"]/g)].map((m) => m[1])
    expect(subpathRows.sort()).toEqual(['tools', 'tools'])
  })

  it('有两条静态预设行，config.id 互异且即两个静态预设 id', () => {
    const presetRows = [...PATCH_TEXT.matchAll(/- id:\s*(dsh-router-[\w-]*)\n\s*name:\s*'@deepseek-ai\/dsh-agent-preset'\n\s*config:\n\s*id:\s*([\w-]+)/g)]
    expect(presetRows.map((m) => m[2])).toEqual(['dsh-router-supervisor', 'dsh-router-worker'])
    expect(new Set(presetRows.map((m) => m[2])).size).toBe(2)
  })

  it('预设树内的工具行按角色分流（role: supervisor/worker 各一次；router 行在动态 Router 定义）', () => {
    for (const role of ['supervisor', 'worker']) {
      expect(PATCH_TEXT, `role: ${role} 行缺失`).toMatch(new RegExp(`name:\\s*'@goodjin2/dsh-router/tools'\\n\\s+config:\\n\\s+role: ${role}`))
    }
  })

  it('context 行只在动态 Router 定义（静态 yml 里没有）', () => {
    expect(PATCH_TEXT.match(/name:\s*'@goodjin2\/dsh-router\/context'/g)?.length ?? 0).toBe(0)
  })

  it('两条静态预设都挂压缩组（isolate 的 cordis:group；动态 Router 定义同款由 presets-dynamic 看守）', () => {
    // 压缩引擎在会话自身作用域缺席时，驱动的 compactRegion 永远抛错空转
    //（B2 裁定 5 的缺口在此看守）。
    for (const id of ['supervisor-compaction', 'worker-compaction']) {
      expect(PATCH_TEXT, `压缩组 ${id} 缺失`).toMatch(new RegExp(`-\\s+id:\\s*${id}\\n\\s+name:\\s*cordis:group\\n\\s+group:\\s*true\\n\\s+isolate:\\n\\s+compaction:\\s*true\\n\\s+toolResultPruner:\\s*true`))
    }
  })

  it('supervisor 预设挂 r6 双绿子代理行：control 裸行 + spawn 行；禁 ./list-agents、禁死键', () => {
    expect(PATCH_TEXT).toMatch(/- id:\s*supervisor-tool-subagent-control\n\s+name:\s*'@deepseek-ai\/dsh-tool-subagent-control'\n/)
    expect(PATCH_TEXT).toMatch(/- id:\s*supervisor-tool-subagent\n\s+name:\s*'@deepseek-ai\/dsh-tool-subagent'\n\s+config:\n\s+provider:\s*spawn\n\s+toolName:\s*subagent\n\s+maxDepth:\s*2\n/)
    // 禁的是行（子路径导出 0.2.2 已删）；注释里的事故说明不算
    expect(PATCH_TEXT).not.toMatch(/name:\s*'@deepseek-ai\/dsh-tool-subagent-control\/list-agents'/)
    for (const deadKey of ['modelSelectionSettings', 'modelSelection', 'modelDiscovery', 'backgroundMode']) {
      expect(PATCH_TEXT, `死键 ${deadKey} 不得出现`).not.toMatch(new RegExp(`^\\s+${deadKey}:`, 'm'))
    }
  })
})

/** 从 yml 抽 persona 前缀块（prefix: |- 下的 16 空格缩进文本），还原成原文。 */
function personaPrefix(yml: string, personaRowId: string): string {
  const anchor = `- id: ${personaRowId}`
  const at = yml.indexOf(anchor)
  expect(at, `yml 里找不到 persona 行 ${personaRowId}`).toBeGreaterThan(-1)
  const prefixAt = yml.indexOf('prefix: |-', at)
  const lines = yml.slice(prefixAt).split('\n').slice(1)
  const body: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (!line.startsWith(' '.repeat(16))) break
    body.push(line.slice(16))
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  return `${body.join('\n')}\n`
}

describe('persona 文本与 TS 模板逐字同步', () => {
  it('router-persona：yml 无行（v1.1 动态注册）；动态定义无 persona 行（complete 唯一）；兜底定义有 persona 行', () => {
    expect(PATCH_TEXT).not.toMatch(/id:\s*router-persona\b/)
    expect(routerPrompt.length).toBeGreaterThan(0)
    // C5 看守：complete 段唯一——动态定义走 prompt-section 行（运行时 complete），
    // 决不残留 persona 行（宿主组装期 multiple complete 会炸整轮对话）；
    // 静态兜底定义保留 persona 行 + routerPrompt 逐字（回退源）。
    expect(buildRouterPresetDefinition().plugins.some((row) => row.name === '@deepseek-ai/dsh-persona')).toBe(false)
    const fallbackPersona = staticRouterDefinition().plugins.find((row) => row.name === '@deepseek-ai/dsh-persona')
    expect(fallbackPersona?.config).toMatchObject({ prefix: routerPrompt, complete: true })
  })
  it('supervisor-persona === supervisorPrompt', () => {
    expect(personaPrefix(PATCH_TEXT, 'supervisor-persona')).toBe(supervisorPrompt)
  })
  it('worker-persona === workerPrompt', () => {
    expect(personaPrefix(PATCH_TEXT, 'worker-persona')).toBe(workerPrompt)
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
      // 组件只在渲染时才调 hooks；工厂期只要对象存在即可。
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
      logger: (_name: string) => ({
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

    // 双保险：除了脚本模式求值会挡住顶层 ESM，再对「声明形状」做一次行级扫描。
    expect(src).toMatch(/window\.__ModuleLoader__\.load\(/)
    expect(src, '产物顶层不得有 import 声明').not.toMatch(/(^|\n)\s*import\s+["'{\w]/)
    expect(src, '产物顶层不得有 export 声明').not.toMatch(/(^|\n)\s*export\s+[\w{*]/)

    const row = loadBundleRow()
    expect(row.id).toBe('@goodjin2/dsh-router')

    // 页面模块表里拿得到 react 系（package.json 的 dsh.client.external 清单）；
    // 其余模块必须是打进产物，工厂期请求即视为断链。
    const require = pageRequire()
    const loaded = row.factory(require)
    expect(loaded.name, '产物必须导出与包名一致的 name').toBe('@goodjin2/dsh-router')
    expect(Array.isArray(loaded.inject), '产物必须导出 inject（页面真实服务名）').toBe(true)
    expect(loaded.inject).toEqual(['slots', 'uiSession', 'uiWorkspace', 'workspaces'])
    expect(typeof loaded.apply, '产物必须导出 apply').toBe('function')
    // 工厂期只允许 require 外置清单（react 系）；出现别的说明打包把页面模块打了进来。
    for (const specifier of require.required) {
      expect(['react', 'react-dom', 'react/jsx-runtime']).toContain(specifier)
    }

    // 按页面物化的方式真跑一遍 apply：表面注册齐（shell.overlay 三个注册项：
    // 问题浮窗 + 返回按钮 + 提示词编辑浮层；header.actions 提示词按钮）、
    // 自报一行、生命周期经 effect。
    const { ctx, captured } = recordingWindowCtx()
    expect(() => (loaded.apply as (ctx: unknown) => void)(ctx)).not.toThrow()
    expect([...captured.injected].sort()).toEqual([
      'conversation.header.leading',
      'conversation.session.header.actions',
      'settings.section',
      'shell.overlay',
      'shell.overlay',
      'shell.overlay',
      'sidebar.footer.action',
    ].sort())
    const ids = captured.registered.map((entry) => entry.id)
    expect(ids).toEqual([
      'router-workbench-tabs',
      'router-question-overlay',
      'router-back-button',
      'router-prompt-editor',
      'router-prompt-action',
      'router-create-entry',
      'router-settings',
    ])
    expect(captured.infos.join(' ')).toMatch(/client loaded/i)
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
