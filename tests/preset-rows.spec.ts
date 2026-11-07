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
 * - worker-tool-fs-search：宿主必填 `sampleOverCapGlobResults`（无默认），双版本
 *   standard/ptc 均传 `false` —— v1 缺它导致整树回滚（本 fixture 的锚点行）。
 * - supervisor/worker-tools：本包自己的行 Config 要求 `role`（缺了注册
 *   不出任何编排工具，行会静默空转）。
 * - supervisor-tool-subagent：宿主 schema 唯一必填键 `provider`（r6 §0.4 实测
 *   缺它 FAIL）；maxDepth: 2 允许二级派发（spawn 有 depthLimit 能力）。
 * - worker-tool-fs：`applyPatch: false` 与桌面 standard/ptc 同款；CLI 0.2.1-rc.2
 *   standard 不带 config（该键可选）——按双宿主要求的并集保留，非必填不进 fixture。
 * - 其余行（persona/ask-user/delegation 组及其 control 子行/compaction 组及其
 *   子行/bash）：双版本宿主 standard 预设均无必填 config（control 包两版本都不
 *   导出 Config；bash 只有 disabled 表达式，与宿主同款），以空登记纳入完整性守卫。
 * - v1.1 C1 起 Router 预设动态注册，静态 yml 行已移除（动态行的审计在
 *   presets-dynamic.spec.ts，同一套 validateRowSpec）。
 */
export const REQUIRED_ROW_CONFIG: Record<string, Record<string, unknown>> = {
  /* 宿主工具行：双宿主必填 */
  'worker-tool-fs-search': { sampleOverCapGlobResults: false },
  /* 本包自己的行 Config 必填 */
  'supervisor-tools': { role: 'supervisor' },
  'worker-tools': { role: 'worker' },
  /* 宿主 schema 必填（r6 实测） */
  'supervisor-tool-subagent': { provider: 'spawn' },
  /* 无必填 config 的行：空登记（完整性守卫） */
  'dsh-router-client': {},
  'dsh-router-supervisor-preset': {},
  'dsh-router-worker-preset': {},
  'compaction-basic': {},
  'command-compact': {},
  'tool-result-pruner': {},
  'supervisor-persona': {},
  'supervisor-delegation': {},
  'supervisor-tool-subagent-control': {},
  'supervisor-ask-user': {},
  'supervisor-compaction': {},
  'worker-persona': {},
  'worker-ask-user': {},
  'worker-tool-bash': {},
  'worker-tool-fs': {},
  'worker-compaction': {},
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
