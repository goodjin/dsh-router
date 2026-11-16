/**
 * 单静态预设 preset_one_entry 测试（计划 Task 2B，Layer 3）。
 *
 * brief 命名断言：preset_one_entry。cordis.patch.yml 只有一条用户可选预设
 * id/name=dsh-router/Router，complete=true，提示词来自 collaborationPrompt 单一来源；
 * 七条 record/template 工具 + DSH 原生执行/用户提问/项目指令/默认压缩/子代理控制；
 * 无旧 executor/supervisor/worker 别名或 perrole 插件；spawn provider spawn、
 * toolName subagent、maxDepth 2。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { collaborationPrompt } from '../../src/collaboration/prompt.ts'

const PATCH_PATH = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
const PATCH_TEXT = readFileSync(PATCH_PATH, 'utf8')

interface PatchRow {
  id?: string
  name?: string
  config?: unknown
}

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
  if (row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config)) {
    const plugins = (row.config as Record<string, unknown>).plugins
    if (Array.isArray(plugins)) collectRows(plugins, out)
  }
  return out
}

function patchRows(): PatchRow[] {
  const doc = parse(PATCH_TEXT, { logLevel: 'silent' }) as unknown
  return collectRows(doc) as PatchRow[]
}

/** 取 dsh-agent-preset 预设行的 config（id/name/description/order/plugins）。 */
function presetConfigs(): Array<{ id?: string; name?: string; plugins?: unknown[] }> {
  return patchRows()
    .filter((row) => row.name === '@deepseek-ai/dsh-agent-preset')
    .map((row) => row.config as { id?: string; name?: string; plugins?: unknown[] })
}

describe('preset_one_entry — exactly one user-selectable Router preset', () => {
  it('only one preset row, id/name = dsh-router/Router', () => {
    const presets = presetConfigs()
    expect(presets).toHaveLength(1)
    expect(presets[0]?.id).toBe('dsh-router')
    expect(presets[0]?.name).toBe('Router')
  })

  it('preset persona is complete:true with prompt from collaborationPrompt single source', () => {
    const plugins = presetConfigs()[0]?.plugins ?? []
    const persona = plugins
      .map((p) => p as { name?: string; config?: { prefix?: string; complete?: boolean } })
      .find((p) => p.name === '@deepseek-ai/dsh-persona')
    expect(persona, 'Router 预设必须有 persona 行').toBeTruthy()
    expect(persona?.config?.complete).toBe(true)
    // prefix 即 collaborationPrompt（单一来源；逐字一致，允许末尾换行的块标量归一）
    const prefix = persona?.config?.prefix ?? ''
    expect(prefix.trim()).toBe(collaborationPrompt.trim())
    // 不得残留第二份 persona/complete 来源（prompt-section 行已退役）
    expect(PATCH_TEXT).not.toMatch(/id:\s*router-prompt-section\b/)
  })

  it('no old executor/supervisor/worker alias or perrole plugin rows', () => {
    expect(PATCH_TEXT).not.toMatch(/id:\s*dsh-router-executor\b/)
    expect(PATCH_TEXT).not.toMatch(/id:\s*dsh-router-supervisor\b/)
    expect(PATCH_TEXT).not.toMatch(/id:\s*dsh-router-worker\b/)
    // 旧动态预设兼容别名整块退役
    expect(PATCH_TEXT).not.toMatch(/dsh-router-supervisor|dsh-router-worker/)
  })

  it('tools row registers the collaboration tools (no role config / role guard)', () => {
    const toolsRow = patchRows().find((row) => row.id === 'tools')
    expect(toolsRow, 'Router 预设必须有 tools 行').toBeTruthy()
    // 新 tools 行无 role 配置（不再 superset 角色闸）
    const config = toolsRow?.config
    if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
      expect(config, 'tools 行不得再带 role 配置').not.toHaveProperty('role')
    }
  })

  it('native subagent-control + subagent (provider spawn, toolName subagent, maxDepth 2)', () => {
    expect(PATCH_TEXT).toMatch(/- id:\s*tool-subagent-control\n\s*name:\s*'@deepseek-ai\/dsh-tool-subagent-control'\n/)
    expect(PATCH_TEXT).toMatch(/- id:\s*tool-subagent\n\s*name:\s*'@deepseek-ai\/dsh-tool-subagent'\n\s*config:\n\s*provider:\s*spawn\n\s*toolName:\s*subagent\n\s*maxDepth:\s*2\n/)
  })

  it('native execution + user question + project instructions + default compaction present', () => {
    const names = new Set(patchRows().map((row) => row.name))
    // 原生执行工具
    for (const tool of [
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
      '@deepseek-ai/dsh-tool-web',
      '@deepseek-ai/dsh-tool-todo',
      '@deepseek-ai/dsh-tool-jobs',
    ]) {
      expect(names, `缺少原生执行工具 ${tool}`).toContain(tool)
    }
    // 用户提问
    expect(names).toContain('@deepseek-ai/dsh-tool-ask-user')
    // 项目指令（agent-instructions）
    expect(names).toContain('@deepseek-ai/dsh-agent-instructions')
    // 默认压缩（原生 compaction 组，非旧 @goodjin2/dsh-router/compaction）
    expect(names).toContain('@deepseek-ai/dsh-compaction-basic')
    expect(names).toContain('@deepseek-ai/dsh-command-compact')
    expect(names).toContain('@deepseek-ai/dsh-compaction-tool-result-pruner')
    // 旧自定义压缩行退役
    expect(names).not.toContain('@goodjin2/dsh-router/compaction')
  })
})
