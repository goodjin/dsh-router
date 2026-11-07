#!/usr/bin/env node
/**
 * 子行核查器（v1.1 计划 Task A2）：本包 cordis.patch.yml 的**每一条子行**（预设
 * 行 config.plugins、group 行 config 数组全部展开）拿到本机真实宿主里逐行
 * `import` + 过包 `Config`。config-less 行以 `undefined` 输入过 Config——这正是
 * v1 的漏洞（容器核查器只校验带 config 的行、且不进预设行的 config.plugins，
 * fs-search 缺必填 `sampleOverCapGlobResults` 因此漏检，所有 worker 会话创建失败）。
 *
 * 与容器核查器（/Users/good/github/dsh-plugins/scripts/check-host-rows.mjs）的分工：
 * 容器核查所有插件的顶层装载行；本脚本只查本包、但把子行全部展开、并堵上
 * config-less 的洞。校验语义与运行时注册（Part C）共用同一份实现：
 * `src/host/presets/validate-row.ts`（桌面 Electron 与 CLI 都是 Node 24，子进程
 * 直接 import 该源文件，无编译中间层、无双源漂移）。
 *
 * 用法：
 *   node scripts/check-subrows.mjs                # 双宿主全查（桌面 asar + CLI 安装目录）
 *   node scripts/check-subrows.mjs <patch.yml>    # 指定别的声明文件
 *   DSH_HOST_BASE=/path/to/@deepseek-ai/dsh/package.json node scripts/check-subrows.mjs
 *
 * 判据：退出码 0，且每个宿主下面都是「0 处问题」。桌面版宿主在 asar 里，只有
 * Electron 的 fs 补丁读得进去 → 桌面基准用 Electron 二进制当 node 跑（容器核查器
 * 同款做法）；CLI 基准用普通 node。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SELF), '..')
const DESKTOP_APP_BIN = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const DESKTOP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/* ─────────────────────────── 子进程：在一个宿主里校验 ─────────────────────────── */

/**
 * `--base <宿主 package.json> --patch <cordis.patch.yml>` 进入子进程模式。
 * 结果以 JSON 打到 stdout。校验语义全部来自 src/host/presets/validate-row.ts。
 */
async function childMode(base, patch) {
  const req = createRequire(base)
  const YAML = req('yaml')
  let version = '?'
  try {
    version = JSON.parse(readFileSync(base, 'utf8')).version ?? '?'
  } catch {
    /* 版本只是标签 */
  }

  // 共用校验函数（Node 24 原生类型剥离直接吃 .ts；两宿主运行时都 ≥24）。
  const { validateRowSpec, makeHostLoader } = await import(
    pathToFileURL(join(REPO_ROOT, 'src', 'host', 'presets', 'validate-row.ts')).href
  )
  const load = makeHostLoader({ base, pluginRoot: REPO_ROOT })

  const doc = YAML.parse(readFileSync(patch, 'utf8'), { logLevel: 'silent' })
  const rows = []
  collectRows(doc, rows)

  const problems = []
  let validated = 0
  for (const row of rows) {
    const name = row.name
    if (typeof name !== 'string') continue
    if (row.disabled === true) continue // 宿主会跳过 disabled 行，不解析它
    if (name === 'cordis:group') continue // 组行没有包；子行已按独立行展开
    const verdict = await validateRowSpec({ id: String(row.id ?? '?'), name, config: row.config }, { load })
    validated += 1
    if (!verdict.ok) problems.push(...verdict.problems)
  }

  process.stdout.write(JSON.stringify({ version, rows: rows.length, validated, problems }))
}

/**
 * 行收集器（递归）：顶层 insert 数组 → 预设行 config.plugins → group 行 config
 * 数组。行 = 同时有字符串 id 与 name 的对象。这与容器核查器的 collectRows 的
 * 差别只有一条：容器不进预设行的 config.plugins（正是 v1 漏检的盲区）。
 */
function collectRows(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectRows(item, out)
    return
  }
  if (!node || typeof node !== 'object') return
  if (typeof node.name === 'string' && typeof node.id === 'string') out.push(node)
  for (const key of ['insert', 'config', 'plugins']) {
    const value = node[key]
    if (Array.isArray(value)) collectRows(value, out)
  }
  // 预设行：config 是对象（非数组），子行清单挂在 config.plugins
  if (node.config && typeof node.config === 'object' && !Array.isArray(node.config)) {
    if (Array.isArray(node.config.plugins)) collectRows(node.config.plugins, out)
  }
}

/* ─────────────────────────── 父进程：发现宿主、汇总 ─────────────────────────── */

function discoverHosts() {
  const override = process.env.DSH_HOST_BASE
  if (override) {
    return [{ label: 'DSH_HOST_BASE', base: resolve(override), runtime: process.execPath, electron: false }]
  }
  const hosts = []
  if (existsSync(DESKTOP_ASAR)) {
    hosts.push({
      label: '桌面版 /Applications/DeepSeek Harness.app',
      base: join(DESKTOP_ASAR, 'dsh', 'package.json'),
      runtime: DESKTOP_APP_BIN,
      electron: true,
    })
  }
  for (const candidate of [
    join(homedir(), '.local/share/node-*/lib/node_modules/@deepseek-ai/dsh/package.json'),
    join(homedir(), '.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh/package.json'),
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  ]) {
    for (const hit of globSync(candidate)) {
      if (existsSync(hit)) hosts.push({ label: `CLI ${hit.replace(homedir(), '~')}`, base: hit, runtime: process.execPath, electron: false })
    }
  }
  return hosts
}

async function main() {
  const argv = process.argv.slice(2)
  const baseIdx = argv.indexOf('--base')
  if (baseIdx !== -1) {
    const patchIdx = argv.indexOf('--patch')
    await childMode(argv[baseIdx + 1], argv[patchIdx + 1])
    return
  }

  const patch = resolve(REPO_ROOT, argv.find((a) => !a.startsWith('--') && a.endsWith('.yml')) ?? 'cordis.patch.yml')
  if (!existsSync(patch)) {
    console.error(`声明文件不存在: ${patch}`)
    process.exit(2)
  }

  const hosts = discoverHosts()
  if (hosts.length === 0) {
    console.error('没找到任何 DSH 宿主：桌面版 app.asar 和 CLI 安装目录都没发现。')
    process.exit(2)
  }

  console.log(`\n子行核查（config-less 行以 undefined 过包 Config）— ${new Date().toLocaleString('zh-CN')}`)
  console.log(`声明文件 ${patch.replace(REPO_ROOT, '.')} · 宿主 ${hosts.length} 个\n`)

  let ok = true
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
      console.log(`宿主 ${host.label}（跑不起来）`)
      console.log(`  ✗  ${String(error?.message ?? error).split('\n')[0]}`)
      console.log(`     宿主 ${host.base} · 运行时 ${host.runtime}\n`)
      continue
    }

    console.log(`宿主 dsh ${result.version}（${host.label}）`)
    if (result.problems.length === 0) {
      console.log(`  ✓  ${String(result.validated).padStart(2)} 行全部通过（共收集 ${result.rows} 行）\n`)
      continue
    }
    ok = false
    console.log(`  ✗  ${String(result.validated).padStart(2)} 行，${result.problems.length} 处问题`)
    for (const problem of result.problems) console.log(`       ✗ ${problem}`)
    console.log('')
  }

  console.log(
    ok
      ? '全部通过：每个宿主下每条子行都能 import，config（含 config-less 行的 undefined 输入）也过得了包 Config。\n'
      : '有不通过项：宿主删掉的包/子路径 → 删行或改新名；必填 config 键 → 照宿主自带预设补齐。\n',
  )
  process.exit(ok ? 0 : 1)
}

await main()
