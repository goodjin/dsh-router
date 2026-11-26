/**
 * 预设子行审计测试（v1.1 计划 Task A1）。
 *
 * 背景（v1 现场）：worker 预设的 `@deepseek-ai/dsh-tool-fs-search` 行缺必填
 * `sampleOverCapGlobResults`（宿主必填、无默认值，宿主自带 standard/ptc 预设
 * 都传 `false`），预设是整树事务 → 所有 worker 会话创建失败 → 主管链洪泛。
 *
 * 本文件把「宿主双版本（CLI 0.2.1-rc.2 与桌面 0.2.2-rc.1）standard/minimal/ptc
 * 预设逐行核对出的必填 config 键集」落成 fixture：本包 cordis.patch.yml 的每一条
 * 子行都必须在 fixture 里登记（完整性守卫），登记了必填键的行必须真的带上这些
 * 键与期望值。差异基准的核对方法与结论见 docs/superpowers/specs/…
 * router-v1.1-design.md §2-1 与本次 A1 的差异清单（fixture 注释逐行给出）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/* ────────────────────────── patch 解析与行收集 ────────────────────────── */

interface PatchRow {
  id?: unknown
  name?: unknown
  config?: unknown
}

/** 收集器覆盖三种嵌套：顶层 insert 数组、预设行 config.plugins、group 行 config 数组。 */
function collectRows(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRows(item, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const row = node as Record<string, unknown>
  if (typeof row.id === 'string' && typeof row.name === 'string') out.push(row)
  for (const key of ['insert', 'config', 'plugins'] as const) {
    const value = row[key]
    if (Array.isArray(value)) collectRows(value, out)
  }
  // 预设行：config 是对象（非数组），子行清单挂在 config.plugins
  if (row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config)) {
    const plugins = (row.config as Record<string, unknown>).plugins
    if (Array.isArray(plugins)) collectRows(plugins, out)
  }
  return out
}

function patchRows(): Record<string, unknown>[] {
  const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const doc = parse(readFileSync(patchPath, 'utf8'), { logLevel: 'silent' }) as unknown
  return collectRows(doc)
}

/* ────────────────────────── fixture：行id → 必填 config 键集 ────────────────────────── */

/**
 * 以宿主双版本 standard/minimal/ptc 预设为基准逐行核对（2026-11-07）：
 *
 * - tool-fs-search：宿主必填 `sampleOverCapGlobResults`（无默认），双版本
 *   standard/ptc 均传 `false` —— v1 缺它导致整树回滚（本 fixture 的锚点行）。
 * - tool-web / tool-todo / tool-fs / tool-result-pruner：执行支撑/压缩工具的必填
 *   config 键（与宿主 standard 预设同款）。
 * - tool-subagent：宿主 schema 唯一硬性必填键 `provider`（r6 §0.4 实测缺它 FAIL）；
 *   spawn + toolName subagent + maxDepth 2（maxDepth 允许二级派发）。
 * - tools：本包自己的行 Task 2B 起无 config（不再要求 role，角色闸退役）。
 * - 其余行（persona/agent-instructions/ask-user/tool-bash/delegation 组及其
 *   control 子行/compaction 组及其子行/dsh-router-client/dsh-router-preset）：
 *   双版本宿主 standard 预设均无必填 config（control 包两版本都不导出 Config；
 *   bash 只有 disabled 表达式，与宿主同款），以空登记纳入完整性守卫。
 * - Task 2B 起静态 yml 只有一条 dsh-router/Router 预设（无旧 executor 行、无
 *   perrole 插件、无动态预设引擎）；预设整体断言在 tests/collaboration/preset.spec.ts。
 */
export const REQUIRED_ROW_CONFIG: Record<string, Record<string, unknown>> = {
  /* 宿主工具行：双宿主必填 */
  'tool-fs-search': { sampleOverCapGlobResults: false },
  /* 执行支撑/压缩工具 */
  'tool-web': { fetch: true, searchTimeoutMs: 60000 },
  'tool-todo': { allowParallelInProgress: true },
  'tool-fs': { applyPatch: false },
  'tool-result-pruner': { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
  /* 宿主 schema 必填（r6 实测）；spawn + toolName subagent + maxDepth 2 */
  /* 本包自己的行：Task 2B 起 tools 行无 config（角色闸退役） */
  'tools': {},
  'router-context': { order: 100 },
  /* 独立工作台行（2026-11-26）：无 config（路由由代码注册，不读行 config） */
  'dsh-router-workbench': {},
  /* 无必填 config 的行：空登记（完整性守卫） */
  'dsh-router-client': {},
  'dsh-router-preset': {},
  'persona': {},
  'agent-instructions': {},
  'ask-user': {},
  'tool-bash': {},
  'tool-jobs': {},
  /* 定时任务四件套 + 报时上下文（2026-11-19 补挂，与宿主 standard 预设同款、无 config；
     Router 会话自建定时任务，new/new_once 投递会话继承本预设） */
  'time-context': {},
  'tool-schedule': {},
  'delegation': {},
  'tool-subagent-control': {},
  'compaction': {},
  'compaction-basic': {},
  'command-compact': {},
}

/* ────────────────────────── 断言 ────────────────────────── */

describe('preset-rows：cordis.patch.yml 子行 × 宿主必填 config', () => {
  it('每一条子行都登记在 REQUIRED_ROW_CONFIG（新行必须有意识地过审计）', () => {
    const rows = patchRows()
    expect(rows.length).toBeGreaterThan(0)
    const unregistered = rows
      .map((row) => String(row.id))
      .filter((id) => !(id in REQUIRED_ROW_CONFIG))
    expect(unregistered).toEqual([])
  })

  it('fixture 不含 patch 里不存在的行（防 fixture 腐化）', () => {
    const present = new Set(patchRows().map((row) => String(row.id)))
    const stale = Object.keys(REQUIRED_ROW_CONFIG).filter((id) => !present.has(id))
    expect(stale).toEqual([])
  })

  it('登记了必填键的行必须带齐这些键且值正确（fs-search 案例先红）', () => {
    const rows = patchRows()
    const failures: string[] = []
    for (const row of rows) {
      const required = REQUIRED_ROW_CONFIG[String(row.id)]
      if (required === undefined || Object.keys(required).length === 0) continue
      const config = row.config
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        failures.push(`${String(row.id)}：缺 config（必填键 ${Object.keys(required).join('、')}）`)
        continue
      }
      for (const [key, expected] of Object.entries(required)) {
        const actual = (config as Record<string, unknown>)[key]
        if (actual === undefined) failures.push(`${String(row.id)}：config.${key} 缺失（宿主必填）`)
        else if (actual !== expected) failures.push(`${String(row.id)}：config.${key} 期望 ${String(expected)}，实际 ${String(actual)}`)
      }
    }
    expect(failures).toEqual([])
  })
})
