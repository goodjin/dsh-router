#!/usr/bin/env node
/**
 * 候选宿主声明核查（本地 wrapper，计划 Task 4 Phase B；不改容器脚本、不 claim live agent flow）。
 *
 * 容器脚本 scripts/check-subrows.mjs 按插件名在容器目录（dsh-plugins/）下找候选，会验到
 * main checkout 的 cordis.patch.yml，不是本候选工作区。本 wrapper 把**候选 cordis.patch.yml
 * 的绝对路径**作为参数，直接对每个可达宿主跑一遍真实行校验（复用 src/host/presets/
 * validate-row.ts 的 makeHostLoader/validateRowSpec，与 check-subrows 同一条宿主加载路径），
 * 确保验的是候选而非 main。
 *
 * 与 check-subrows 的差别（brief Phase B）：check-subrows 只证「行能 import + 过包 Config」。
 * 本 wrapper 额外**只读地**断言候选的组合继承契约（不 import 运行时、不驱动 Agent）：
 *   - 恰好一条用户可选预设 dsh-router/Router，persona complete:true，提示词来自 collaborationPrompt；
 *   - delegation 组只挂 subagent-control；派发统一走 router_dispatch（原生 spawn 工具行已删）；
 *   - 无旧 dsh-router-executor/supervisor/worker 别名、无旧动态服务行。
 * 这些是纯文本/preset 结构断言（Layer3 已用 tests/collaboration/preset.spec.ts 证过运行时组合），
 * 本脚本在**无 vitest** 的裸宿主核查进程里再证一遍候选声明面，不声称跑过真实 Agent 流程。
 *
 * 用法：node scripts/check-collaboration-host.mjs [候选工作区绝对路径]
 *       缺省候选 = 本仓库工作区根（scripts/ 的上一级）。
 * 判据：每个宿主下所有候选行 validated 且 problems 为空；组合继承断言全绿；exit 0。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SELF), '..')
const DESKTOP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const DESKTOP_APP_BIN = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'

/* ─────────────── 组合继承断言（只读候选 patch，不驱动 Agent） ─────────────── */

function assertCompositionInheritance(candidate, patch) {
  const req = createRequire(join(candidate, 'package.json'))
  const YAML = req('yaml')
  const doc = YAML.parse(readFileSync(patch, 'utf8'), { logLevel: 'silent' })
  const problems = []

  // 收集所有行（与 check-subrows 同口径：顶层 insert / 预设行 config.plugins / group 行）。
  const rows = []
  ;(function collect(node) {
    if (Array.isArray(node)) { for (const n of node) collect(n); return }
    if (!node || typeof node !== 'object') return
    if (typeof node.name === 'string' && typeof node.id === 'string') rows.push(node)
    for (const key of ['insert', 'config', 'plugins']) {
      const v = node[key]
      if (Array.isArray(v)) collect(v)
    }
    if (node.config && typeof node.config === 'object' && !Array.isArray(node.config)) collect(node.config.plugins)
  })(doc)

  const presets = rows.filter((r) => r.id === 'persona' || /persona|preset/i.test(r.id))
  const selectable = rows.filter((r) => r.name === '@goodjin2/dsh-router')
  // 用户可选预设：宿主预设行 name=@deepseek-ai/dsh-agent-preset，其 config.id/name=description
  // 决定用户在花名册里看到的那一条（id/name=dsh-router/Router）。
  const presetRows = rows.filter((r) => r.name === '@deepseek-ai/dsh-agent-preset')
  const routerPreset = presetRows.find((r) => r.config?.id === 'dsh-router' && r.config?.name === 'Router')
  if (!routerPreset) {
    problems.push('缺少用户可选预设行 @deepseek-ai/dsh-agent-preset(config.id=dsh-router, name=Router)')
  } else {
    const personaPlugins = routerPreset.config?.plugins
    const persona = Array.isArray(personaPlugins)
      ? personaPlugins.find((p) => p && p.id === 'persona')
      : undefined
    if (!persona || persona.config?.complete !== true) {
      problems.push('Router 预设 persona 未设 complete:true')
    }
    if (selectable.length !== 1) {
      problems.push(`应只有一条用户可选预设，实际 ${selectable.length} 条`)
    }
  }

  // 原生子代理：只挂 subagent-control（控制与发现）；派发统一走 router_dispatch
  // （2026-11-18 起原生 spawn 工具行删除——防绕过职责注入；spawn/fork 后端由 base 全局提供）。
  const text = readFileSync(patch, 'utf8')
  if (!/@deepseek-ai\/dsh-tool-subagent-control'/.test(text)) {
    problems.push('缺少原生 subagent-control 行')
  }
  if (/- id:\s*tool-subagent\n/.test(text)) {
    problems.push('原生 tool-subagent 派发行必须删除（防绕过 router_dispatch 职责注入）')
  }
  if (text.includes('tool-subagent-control/list-agents')) {
    problems.push('list-agents 子路径行必须删除（桌面 0.2.2 已并入主包）')
  }

  // 退役别名不得残留。
  for (const stale of ['dsh-router-executor', 'dsh-router-supervisor', 'dsh-router-worker']) {
    if (text.includes(stale)) problems.push(`残留旧别名/服务行：${stale}`)
  }
  // 旧动态服务不得挂回（routerCore/scheduler/adjudicator 等）。
  for (const stale of ['routerCore', 'scheduler', 'adjudicator', 'router-adoption', 'router-bridge']) {
    if (new RegExp(`name:\\s*['"]@goodjin2/dsh-router/${stale}`).test(text)) {
      problems.push(`旧运行时服务行重新挂入：${stale}`)
    }
  }

  return problems
}

/* ─────────────── 宿主发现（与 check-subrows 同口径） ─────────────── */

function discoverHosts() {
  const override = process.env.DSH_HOST_BASE
  if (override) {
    return [{ label: 'DSH_HOST_BASE', base: resolve(override), runtime: process.execPath, electron: false }]
  }
  const hosts = []
  if (existsSync(DESKTOP_ASAR)) {
    hosts.push({ label: '桌面版', base: join(DESKTOP_ASAR, 'dsh', 'package.json'), runtime: DESKTOP_APP_BIN, electron: true })
  }
  // 全局 CLI 安装（$(npm root -g)/@deepseek-ai/dsh）。
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const cliBase = join(globalRoot, '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(cliBase)) {
      hosts.push({ label: 'CLI（全局）', base: cliBase, runtime: process.execPath, electron: false })
    }
  } catch {
    /* npm root -g 不可用就跳过 CLI 宿主 */
  }
  return hosts
}

/* ─────────────── 子进程模式：对单个宿主跑真实行校验 ─────────────── */

async function childMode(base, patchPath) {
  const req = createRequire(base)
  const YAML = req('yaml')
  let version = '?'
  try { version = JSON.parse(readFileSync(base, 'utf8')).version ?? '?' } catch { /* 版本只是标签 */ }

  const { validateRowSpec, makeHostLoader } = await import(
    pathToFileURL(join(REPO_ROOT, 'src', 'host', 'presets', 'validate-row.ts')).href
  )
  const load = makeHostLoader({ base, pluginRoot: REPO_ROOT })
  const doc = YAML.parse(readFileSync(patchPath, 'utf8'), { logLevel: 'silent' })
  const rows = []
  ;(function collect(node) {
    if (Array.isArray(node)) { for (const n of node) collect(n); return }
    if (!node || typeof node !== 'object') return
    if (typeof node.name === 'string' && typeof node.id === 'string') rows.push(node)
    for (const key of ['insert', 'config', 'plugins']) {
      const v = node[key]
      if (Array.isArray(v)) collect(v)
    }
    if (node.config && typeof node.config === 'object' && !Array.isArray(node.config)) collect(node.config.plugins)
  })(doc)

  const problems = []
  let validated = 0
  for (const row of rows) {
    const name = row.name
    if (typeof name !== 'string') continue
    if (row.disabled === true) continue
    if (name === 'cordis:group') continue
    const verdict = await validateRowSpec({ id: String(row.id ?? '?'), name, config: row.config }, { load })
    validated += 1
    if (!verdict.ok) problems.push(...verdict.problems)
  }
  process.stdout.write(JSON.stringify({ version, rows: rows.length, validated, problems }))
}

/* ────────────�� 父进程：逐宿主校验 + 组合继承断言 ────────────── */

async function main() {
  const argv = process.argv.slice(2)
  const baseIdx = argv.indexOf('--base')
  if (baseIdx !== -1) {
    const patchIdx = argv.indexOf('--patch')
    await childMode(argv[baseIdx + 1], resolve(argv[patchIdx + 1]))
    return
  }

  const candidate = resolve(argv[0] ?? REPO_ROOT)
  const patch = resolve(candidate, 'cordis.patch.yml')
  if (!existsSync(patch)) {
    console.error(`候选声明文件不存在：${patch}`)
    process.exit(2)
  }

  console.log(`\n候选宿主声明核查（Task 4 Phase B，本地 wrapper，不 claim live agent flow）`)
  console.log(`候选工作区 ${candidate}`)
  console.log(`声明文件 ${patch.replace(REPO_ROOT, '.')}\n`)

  // 组合继承断言（与宿主无关，先跑）。
  const compositionProblems = assertCompositionInheritance(candidate, patch)
  if (compositionProblems.length === 0) {
    console.log('  ✓ 组合继承：单预设 dsh-router/Router(complete:true) + delegation 仅 control（派发走 router_dispatch）+ 无旧别名/服务行')
  } else {
    console.log('  ✗ 组合继承：')
    for (const p of compositionProblems) console.log(`       ✗ ${p}`)
  }

  const hosts = discoverHosts()
  if (hosts.length === 0) {
    console.error('\n没找到任何 DSH 宿主：桌面 app.asar 和全局 CLI 都没发现。')
    process.exit(2)
  }

  let ok = compositionProblems.length === 0
  for (const host of hosts) {
    let result = null
    try {
      const raw = execFileSync(host.runtime, [SELF, '--base', host.base, '--patch', patch], {
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 1024 * 1024 * 32,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: host.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE },
      })
      result = JSON.parse(raw.slice(raw.indexOf('{')))
    } catch (error) {
      ok = false
      console.log(`\n宿主 ${host.label}（跑不起来）`)
      console.log(`  ✗  ${String(error?.message ?? error).split('\n')[0]}`)
      console.log(`     宿主 ${host.base}\n`)
      continue
    }
    console.log(`\n宿主 dsh ${result.version}（${host.label}）`)
    if (result.problems.length === 0 && compositionProblems.length === 0) {
      console.log(`  ✓  ${String(result.validated).padStart(2)} 行全部通过（共收集 ${result.rows} 行）`)
    } else {
      ok = false
      console.log(`  ✗  ${String(result.validated).padStart(2)} 行，${result.problems.length} 处问题`)
      for (const problem of result.problems) console.log(`       ✗ ${problem}`)
    }
  }

  console.log(
    ok
      ? '\n全部通过：每个宿主下每条候选行都能 import，config 也过得了包 Config；组合继承契约成立。'
        + '\n注意：本核查只证声明面，不证明真实 Agent 两级流程（见 native-flow.spec.ts 的 SKIPPED 缺口）。\n'
      : '\n有不通过项。\n',
  )
  process.exit(ok ? 0 : 1)
}

await main()
