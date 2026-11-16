#!/usr/bin/env node
/**
 * 候选浏览器半边激活预检（本地 wrapper，计划 Task 3；I3 增强）。
 *
 * 容器脚本 scripts/check-client-activation.mjs 只按插件名在容器目录（dsh-plugins/）
 * 下解析，不接受绝对候选路径——传名字会验到 main checkout 的产物，不是本候选工作区。
 * 本 wrapper 复用同一套故障注入激活逻辑，但把产物路径**硬绑到本候选工作区的
 * lib/client.js`，确保验的是候选而非 main（brief：candidate client not main；不改容器脚本）。
 *
 * 判据（与 cordis-client-runner / 容器脚本一致），且**正常路径与故障路径分开下结论**：
 *  - 正常路径（服务齐全）：apply 不得穿透，且必须注册预期 slotID
 *    `router-collaboration-workbench`——零表面在正常路径是 FAIL（不是 PASS）。
 *  - 故障路径（三服务各自 getter 抛错 / 缺失 / 方法抛错，外加 logger/effect 抛错）：
 *    apply 一律不得穿透（真实宿主里 = fiber failed / entry did notactivate）。
 *    slots 故障下零表面可接受（明确，不混结论）；uiSession/uiWorkspace 故障下表面仍须注册。
 *  - 执行环境是 **vm 上下文**，`process` 实际安装到上下文（带/不带 stderr 都跑一遍），
 *    不再构造未安装的 sandboxProcess；诊断 console 也装进上下文，验证降级日志不穿透。
 *
 * 用法：node scripts/check-collaboration-client.mjs [候选工作区绝对路径]
 * 缺省候选 = 本仓库工作区根（scripts/ 的上一级）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SELF = fileURLToPath(import.meta.url)
const candidate = resolve(process.argv[2] ?? join(dirname(SELF), '..'))
const clientRel = './lib/client.js'
const clientPath = resolve(candidate, clientRel)

/** 正常路径必须注册的表面 id（与 src/client/collaboration-panel.tsx 一致）。 */
const EXPECTED_SLOT_ID = 'router-collaboration-workbench'

const reactStub = {
  createElement: () => null, Fragment: 'frag',
  useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f,
  useMemo: (f) => f(), useRef: (v) => ({ current: v }), isValidElement: () => false,
}
const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'frag' }
const reactDom = { createPortal: (c) => c }

function makeElement() {
  const t = {
    style: {}, dataset: {}, children: [], textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild: (c) => c, append() {}, prepend() {}, insertBefore: (c) => c,
    remove() {}, removeChild: () => {}, setAttribute() {}, getAttribute: () => null,
    hasAttribute: () => false, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    contains: () => false, closest: () => makeElement(),
    querySelector: () => makeElement(), querySelectorAll: [],
    isConnected: true, parentElement: null, firstChild: null, nextSibling: null,
  }
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return undefined }, set(o, k, v) { o[k] = v; return true } })
}

function makeDocument() {
  const head = Object.assign(makeElement(), { appendChild: (c) => c })
  const body = Object.assign(makeElement(), { appendChild: (c) => c })
  return {
    createElement: makeElement, head, body,
    documentElement: makeElement(), addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: [], getElementById: () => null,
    createTextNode: (s) => ({ textContent: s }),
  }
}

const fakeRequire = (name) => {
  if (['react', 'react/jsx-runtime', 'react-dom'].includes(name)) {
    if (name === 'react') return reactStub
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === 'react-dom') return reactDom
    return {}
  }
  if (name.startsWith('@deepseek-ai/') || name.startsWith('@@deepseek-ai/')) return {}
  throw new Error(`require 越界: ${name}（bundle 依赖了未声明的模块）`)
}

/**
 * 在 vm 上下文里加载候选 bundle（顶层调 window.__ModuleLoader__.load），
 * 用 fakeRequire 物化 factory，对 ctx 跑一次 apply。process/console 实际装进上下文。
 * 返回 rec：{ registered, infos, warns, effects }（由 ctx 里的服务闭包填充）。
 * apply 抛错则本函数抛出（由调用方判为穿透 FAIL）。
 */
function activate(ctx, rec, { withStderr = true } = {}) {
  const document = makeDocument()
  const captured = { row: undefined }
  const processObj = {
    env: {}, platform: 'linux', pid: 0,
    stdout: { write: (s) => { rec.stdout = (rec.stdout ?? '') + String(s); return true } },
    ...(withStderr
      ? { stderr: { write: (s) => { rec.stderr = (rec.stderr ?? '') + String(s); return true } } }
      : {}),
  }
  const sandboxWindow = {
    __ModuleLoader__: { load: (row) => { captured.row = row } },
    document, addEventListener() {}, removeEventListener() {},
    location: { href: 'dsh-app://app/' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (f) => setTimeout(f, 16),
    setTimeout, clearTimeout, setInterval, clearInterval,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    navigator: { userAgent: 'preflight' },
  }
  const context = vm.createContext({
    window: sandboxWindow,
    document,
    console: {
      info: (m) => { rec.infos.push(String(m)) },
      warn: (m) => { rec.warns.push(String(m)) },
      error: (m) => { rec.warns.push(String(m)) },
      log: (m) => { rec.infos.push(String(m)) },
    },
    process: processObj,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, Buffer,
  })
  const src = readFileSync(clientPath, 'utf8')
  vm.runInContext(src, context, { filename: clientPath })
  const row = captured.row
  if (row === undefined) throw new Error('bundle 未调用 __ModuleLoader__.load（形态不对或缺 window）')
  let exportsLike = row.exports
  if (exportsLike === undefined && typeof row.factory === 'function') exportsLike = row.factory(fakeRequire)
  if (exportsLike === undefined) throw new Error('bundle 无 exports')
  if (typeof exportsLike.apply !== 'function') throw new Error('没有可调用的 apply')
  exportsLike.apply(ctx)
  return rec
}

/** 全套正常服务（注册表面 + 订阅 + effect 都工作）；rec 记录注册/订阅副作用。 */
function baseServices(rec) {
  return {
    logger: () => ({ info: () => {}, warn: () => {} }),
    // 真实宿主语义：effect 执行 setup 并保存其返回的 disposer（供卸载调用）。
    effect: (cb) => { rec.effects += 1; rec.effectCleanup = cb(); return rec.effectCleanup },
    slots: {
      inject: (key, prepare) => { rec.injected.push(key); return prepare() },
      register: (options) => { rec.registered.push(options.id); return options },
    },
    uiSession: { adapter: { current: {
      subscribe: () => { rec.subLive += 1; return () => { rec.subLive -= 1; rec.subDisposed += 1 } },
      getSnapshot: () => ({ key: 's1' }),
    } } },
    uiWorkspace: { openSession: () => {} },
  }
}

/** 在 base 上注入故障：getter（访问即抛）/ missing（删键）/ method（方法抛错）/ logger / effect。 */
function withFault(base, fault) {
  const ctx = { ...base }
  switch (fault.kind) {
    case 'getter':
      Object.defineProperty(ctx, fault.key, { configurable: true, get() { throw new Error(`${fault.key} getter threw`) } })
      break
    case 'missing':
      delete ctx[fault.key]
      break
    case 'method':
      ctx[fault.key] = fault.value
      break
    case 'logger':
      ctx.logger = fault.value
      break
    case 'effect':
      ctx.effect = fault.value
      break
  }
  return ctx
}

function newRec() {
  return { registered: [], infos: [], warns: [], effects: 0, injected: [], subLive: 0, subDisposed: 0, effectCleanup: undefined }
}

const failures = []
function check(label, ok, detail) {
  const mark = ok ? '✓' : '✗'
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ''}`)
}

if (!existsSync(clientPath)) {
  console.error(`✗ FAIL — 候选产物不存在: ${clientPath}（先 npm run build）`)
  process.exit(1)
}

console.log(`候选（硬绑工作区）: ${candidate}`)
console.log(`产物: ${clientPath}`)

// 1) 正常路径：服务齐全 → 必须注册预期 slotID（零表面 = FAIL，不打印 PASS）。
{
  const rec = newRec()
  let threw = null
  try { activate(baseServices(rec), rec) } catch (e) { threw = e }
  const registered = rec.registered.includes(EXPECTED_SLOT_ID)
  check('正常路径 apply 不穿透', threw === null, threw ? threw.message : '')
  check(`正常路径注册预期表面 ${EXPECTED_SLOT_ID}`, registered, `实际 ${JSON.stringify(rec.registered)}`)
  // 订阅存活回归：effect setup 必须**返回** disposer（激活后订阅存活），而非 setup 里立即 dispose。
  check('正常路径激活后订阅存活（live=1/disposed=0）', rec.subLive === 1 && rec.subDisposed === 0, `live=${rec.subLive} disposed=${rec.subDisposed}`)
  check('正常路径 effect 返回 disposer（非 undefined）', typeof rec.effectCleanup === 'function', `effectCleanup=${typeof rec.effectCleanup}`)
  if (typeof rec.effectCleanup === 'function') {
    rec.effectCleanup()
    check('正常路径卸载执行 disposer 后订阅释放（live=0/disposed=1）', rec.subLive === 0 && rec.subDisposed === 1, `live=${rec.subLive} disposed=${rec.subDisposed}`)
  }
  if (threw !== null || !registered) {
    console.error(`✗ FAIL 正常路径（穿透=${threw !== null}，表面=${JSON.stringify(rec.registered)}）`)
    process.exit(1)
  }
  console.log('✓ PASS 正常路径：apply 存活、注册预期表面、订阅存活且卸载释放')
}

// 2) 故障路径：三服务各 getter 抛 / 缺失 / 方法抛，外加 logger / effect 抛——一律不得穿透。
const faultCases = [
  { label: 'slots getter 抛错', fault: { kind: 'getter', key: 'slots' }, allowZeroSurface: true },
  { label: 'slots 缺失', fault: { kind: 'missing', key: 'slots' }, allowZeroSurface: true },
  {
    label: 'slots 方法抛错',
    fault: { kind: 'method', key: 'slots', value: { inject() { throw new Error('inject') }, register() { throw new Error('register') } } },
    allowZeroSurface: true,
  },
  { label: 'uiSession getter 抛错', fault: { kind: 'getter', key: 'uiSession' }, allowZeroSurface: false },
  { label: 'uiSession 缺失', fault: { kind: 'missing', key: 'uiSession' }, allowZeroSurface: false },
  {
    label: 'uiSession 方法抛错（subscribe）',
    fault: { kind: 'method', key: 'uiSession', value: { adapter: { current: { subscribe() { throw new Error('subscribe') }, getSnapshot: () => ({ key: 's1' }) } } } },
    allowZeroSurface: false,
  },
  { label: 'uiWorkspace getter 抛错', fault: { kind: 'getter', key: 'uiWorkspace' }, allowZeroSurface: false },
  { label: 'uiWorkspace 缺失', fault: { kind: 'missing', key: 'uiWorkspace' }, allowZeroSurface: false },
  {
    label: 'uiWorkspace 方法抛错（openSession）',
    fault: { kind: 'method', key: 'uiWorkspace', value: { openSession() { throw new Error('openSession') } } },
    allowZeroSurface: false,
  },
  {
    label: 'logger 方法抛错',
    fault: { kind: 'logger', value: () => ({ info() { throw new Error('info') }, warn() { throw new Error('warn') } }) },
    allowZeroSurface: false,
  },
  { label: 'ctx.effect 抛错', fault: { kind: 'effect', value: () => { throw new Error('effect') } }, allowZeroSurface: false },
]

console.log('故障路径（apply 一律不得穿透；slots 故障零表面可接受，其余表面仍须注册）：')
for (const { label, fault, allowZeroSurface } of faultCases) {
  const rec = newRec()
  let threw = null
  try { activate(withFault(baseServices(rec), fault), rec) } catch (e) { threw = e }
  const noThrow = threw === null
  const surfaceOk = allowZeroSurface || rec.registered.includes(EXPECTED_SLOT_ID)
  check(label, noThrow && surfaceOk, threw ? threw.message : (surfaceOk ? '' : `表面=${JSON.stringify(rec.registered)}`))
}

// 3) 无 process.stderr 环境：apply 仍不得穿透（降级日志不依赖 stderr 存在）。
{
  const rec = newRec()
  let threw = null
  try { activate(baseServices(rec), rec, { withStderr: false }) } catch (e) { threw = e }
  check('无 process.stderr 环境 apply 不穿透', threw === null, threw ? threw.message : '')
}

if (failures.length > 0) {
  console.error(`\n✗ FAIL 故障路径 ${failures.length} 项：${failures.join('；')}`)
  process.exit(1)
}
console.log(`\n✓ PASS 候选 ${candidate}（正常路径注册 ${EXPECTED_SLOT_ID}；${faultCases.length + 1} 项故障/降级均不穿透）`)
process.exit(0)
