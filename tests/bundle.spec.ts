/**
 * 装载接线测试：这个包「装上了能不能真的跑起来」。
 *
 * 这是**唯一**能提前发现致命错误的地方。DSH 浏览器半边有三条死规矩，少一条
 * 就是「装上也不生效、宿主日志一个字都没有」（2026-11 在 dsh-rightbar-overlay
 * 上踩过整组坑）；另有两条形状规矩与一条入口规矩：
 *
 *  1. package.json 声明 `dsh.bundle.patch` 指向 cordis.patch.yml——没有这段，
 *     宿主读 profile 时整层跳过（启动日志里只有一句 "skipping profile bundle"）；
 *  2. package.json 声明 `dsh.client.platform = "web"`——客户端模块注册表
 *     （ClientModuleRegistry.resolveMeta）靠它把行认成浏览器行；
 *  3. patch 里装载行的 name 是**裸包名**——带子路径的行会退化成在 node 里
 *     import 浏览器产物，整块静默失效；
 *  4. exports["./client"] 只能是字符串或 { default: 字符串 }——宿主
 *     clientExportOf 只认这两种，只写 import/require 会被当场判错；
 *  5. lib/client.js 必须是「单文件 CJS 工厂」：window.__ModuleLoader__.load({ id, factory })
 *     包裹、factory 里挂 apply/name/inject、顶层不得有 import/export——
 *     顶层 ESM 语法在页面里是语法错误，包根本进不了启动图；
 *  6. exports["."] 指向宿主侧空入口 dist/entry.js——浏览器代码不许混进宿主进程。
 *
 * 这里逐条断言，并按页面的方式真跑一遍产物：把 lib/client.js 当文本读进来、
 * 在只给了 `window` 的沙箱里求值（不走 vitest 模块图，免得它去解析产物里对
 * 页面模块的 require），取出 factory → 调 apply → 看占位行不抛。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  name: string
  main: string
  exports: Record<string, unknown>
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
}

const PATCH_TEXT = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')

const BUNDLE_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const ENTRY_PATH = fileURLToPath(new URL('../dist/entry.js', import.meta.url))

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

  it('exports["."] 与 main 指向宿主侧产物 dist/entry.js，且不指向浏览器半边', () => {
    const dotExport = PKG.exports['.'] as { types?: string; default?: string }
    expect(typeof dotExport?.default, 'exports["."] 必须有字符串 default').toBe('string')
    expect(dotExport.default).toBe('./dist/entry.js')
    expect(PKG.main).toBe('./dist/entry.js')
    // 宿主进程加载的入口不得混入浏览器代码：路径不许指到 client 产物。
    expect(dotExport.default).not.toContain('client')
    expect(PKG.main).not.toContain('client')
    // 宿主入口产物已构建，且确实是空壳：剥掉注释后不得再引用 window / document
    // （注释里提到这些词没关系），也不得 import 任何东西——浏览器代码只住在
    // lib/client.js，绝不混进宿主进程。
    expect(existsSync(ENTRY_PATH), 'dist/entry.js 不存在——先 npm run build').toBe(true)
    const entryCode = readFileSync(ENTRY_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(entryCode).not.toMatch(/\b(window|document)\b/)
    expect(entryCode).not.toMatch(/^\s*import\s/m)
  })
})

describe('cordis.patch.yml 的装载行', () => {
  it('有一条 name 为裸包名的装载行，且没有子路径行', () => {
    expect(PATCH_TEXT).toMatch(/-\s+id:\s*dsh-router-client\b/)
    expect(PATCH_TEXT).toMatch(/name:\s*['"]@goodjin2\/dsh-router['"]\s*$/m)
    // 带子路径的行会被当成宿主行：在 node 里 import 浏览器产物，整块静默失效。
    expect(PATCH_TEXT).not.toMatch(/name:\s*['"]@goodjin2\/dsh-router\//)
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

    // 按页面物化的方式真跑一遍 apply：四个表面注册齐、自报一行、生命周期经 effect。
    const { ctx, captured } = recordingWindowCtx()
    expect(() => (loaded.apply as (ctx: unknown) => void)(ctx)).not.toThrow()
    expect([...captured.injected].sort()).toEqual([
      'conversation.header.leading',
      'settings.section',
      'shell.overlay',
      'sidebar.footer.action',
    ].sort())
    const ids = captured.registered.map((entry) => entry.id)
    expect(ids).toEqual([
      'router-workbench-tabs',
      'router-question-overlay',
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
