#!/usr/bin/env node
/**
 * 候选浏览器半边激活预检（本地 wrapper，计划 Task 3）。
 *
 * 容器脚本 scripts/check-client-activation.mjs 只按插件名在容器目录（dsh-plugins/）
 * 下解析，不接受绝对候选路径——传名字会验到 main checkout 的产物，不是本候选工作区。
 * 本 wrapper 复用同一套故障注入激活逻辑，但把产物路径**硬绑到本候选工作区的
 * lib/client.js**，确保验的是候选而非 main（brief：candidate client not main；不改容器脚本）。
 *
 * 判据（与 cordis-client-runner / 容器脚本一致）：bundle 自报的 inject 就是服务门；
 * apply 执行期任何穿透 = FAIL（真实宿主里就是 fiber 标记 failed、web boot 报 entry did not activate）。
 *
 * 用法：node scripts/check-collaboration-client.mjs [候选工作区绝对路径]
 * 缺省候选 = 本仓库工作区根（scripts/ 的上一级）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const candidate = resolve(process.argv[2] ?? join(dirname(SELF), '..'))
const clientRel = './lib/client.js'
const clientPath = resolve(candidate, clientRel)

const reactStub = {
  createElement: () => null, Fragment: 'frag',
  useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f,
  useMemo: (f) => f(), useRef: (v) => ({ current: v }), isValidElement: () => false,
}
const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'frag' }
const reactDom = { createPortal: (c) => c }

function makeSandbox() {
  const mkEl = () => {
    const t = {
      style: {}, dataset: {}, children: [], textContent: '', innerHTML: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild: (c) => c, append() {}, prepend() {}, insertBefore: (c) => c,
      remove() {}, removeChild: () => {}, setAttribute() {}, getAttribute: () => null,
      hasAttribute: () => false, removeAttribute() {},
      addEventListener() {}, removeEventListener() {},
      contains: () => false, closest: () => mkEl(),
      querySelector: () => mkEl(), querySelectorAll: [],
      isConnected: true, parentElement: null, firstChild: null, nextSibling: null,
    }
    return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return undefined }, set(o, k, v) { o[k] = v; return true } })
  }
  const head = Object.assign(mkEl(), { appendChild: (c) => c })
  const body = Object.assign(mkEl(), { appendChild: (c) => c })
  const document = {
    createElement: mkEl, head, body,
    documentElement: mkEl(), addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: [], getElementById: () => null,
    createTextNode: (s) => ({ textContent: s }),
  }
  const sandboxProcess = { env: {}, platform: 'darwin', pid: 0 } // 故意不给 stderr/stdout
  const window = {
    __ModuleLoader__: undefined,
    document,
    addEventListener() {}, removeEventListener() {},
    location: { href: 'dsh-app://app/' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (f) => setTimeout(f, 16),
    setTimeout, clearTimeout, setInterval, clearInterval,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    navigator: { userAgent: 'preflight' },
  }
  return { window, document, sandboxProcess }
}

let captured
const sandbox = makeSandbox()
globalThis.window = sandbox.window
globalThis.document = sandbox.document
globalThis.__DSH_CLIENT_CAPTURE__ = undefined
sandbox.window.__ModuleLoader__ = { load: (def) => { globalThis.__DSH_CLIENT_CAPTURE__ = def } }

if (!existsSync(clientPath)) {
  console.error(`✗ FAIL — 候选产物不存在: ${clientPath}（先 npm run build）`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(resolve(candidate, 'package.json'), 'utf8'))
const externals = new Set(['react', 'react/jsx-runtime', 'react-dom', ...(pkg.dsh?.client?.external ?? [])])
const fakeRequire = (name) => {
  if (externals.has(name)) {
    if (name === 'react') return reactStub
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === 'react-dom') return reactDom
    return {}
  }
  if (name.startsWith('@deepseek-ai/') || name.startsWith('@@deepseek-ai/')) return {}
  throw new Error(`require 越界: ${name}（bundle 依赖了未声明的模块）`)
}

try {
  captured = undefined
  globalThis.__DSH_CLIENT_CAPTURE__ = undefined
  const { pathToFileURL } = await import('node:url')
  await import(pathToFileURL(clientPath).href)
  const row = globalThis.__DSH_CLIENT_CAPTURE__
  if (row === undefined) throw new Error('bundle 未调用 __ModuleLoader__.load（形态不对或缺 window）')
  let exportsLike = row.exports
  if (exportsLike === undefined && typeof row.factory === 'function') exportsLike = row.factory(fakeRequire)
  if (exportsLike === undefined) throw new Error('bundle 无 exports')
  const injectDeclared = Array.isArray(exportsLike.inject) ? exportsLike.inject : []
  if (typeof exportsLike.apply !== 'function') throw new Error('没有可调用的 apply')

  // 服务门 + 故障注入：声明内的服务，任何方法调用都抛；未声明的服务访问即抛。
  const services = new Proxy({}, {
    get(t, k) {
      if (typeof k !== 'string') return undefined
      if (!injectDeclared.includes(k)) throw new Error(`cannot get "${k}" without inject`)
      const degrade = () => { throw new Error(`[fault-injection] ${k} 已降级`) }
      return new Proxy({}, { get(_t2, prop) {
        if (typeof prop === 'symbol') return undefined
        return degrade
      } })
    },
  })
  exportsLike.apply(services)
  console.log(`✓ PASS 候选 ${candidate}`)
  console.log(`  inject ${injectDeclared.length} 项 [${injectDeclared.join(', ')}]；故障注入下激活面存活`)
  process.exit(0)
} catch (error) {
  console.error(`✗ FAIL 候选 ${candidate} — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
