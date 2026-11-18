/**
 * 宿主入口接线测试（计划 Task 2B，Layer 3）。
 *
 * brief 命名断言：
 *  - seven_tool_registration：tools 行经 inject ['tools','routerCollaboration'] 注册恰好七条
 *    Layer2 工具定义，无 role 配置/角色闸，disposal 干净。
 *  - context_actual_session：context 行经官方 systemPrompt.context 注册，text 回调从当前
 *    Agent 公共上下文（assembly.agent.id）取实际会话 ID；缺失宿主服务时诊断不臆造。
 *  - clean_dispose：entry/tools/context apply 均返回注销器，调用即清理。
 *  - 宿主根服务行：裸包名、提供 routerCollaboration、不再 require 旧宿主服务、不注册旧路由。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { apply as entryApply, name as entryName, inject as entryInject } from '../../src/entry.ts'
import { apply as toolsApply, name as toolsName, inject as toolsInject, Config as toolsConfig } from '../../src/tools.ts'
import { apply as contextApply, name as contextName, inject as contextInject, Config as contextConfig } from '../../src/context.ts'
import { COLLABORATION_TOOL_NAMES } from '../../src/collaboration/tools.ts'
import { createCollaborationRuntime } from '../../src/collaboration/runtime.ts'
import type { ToolDefinition } from '../../src/collaboration/tools.ts'

/** 记录型假 tools 面：capture register 定义与其注销器。 */
function recordingTools() {
  const registered: ToolDefinition[] = []
  const disposers: Array<() => void> = []
  const tools = {
    register(definition: ToolDefinition): () => void {
      registered.push(definition)
      let disposed = false
      const dispose = () => { disposed = true }
      disposers.push(dispose)
      return dispose
    },
  }
  return { tools, registered, disposers }
}

/** 记录型假 systemPrompt 面：capture context 条目与其注销器。 */
function recordingSystemPrompt() {
  interface CapturedEntry { name: string; order: number; text: (assembly?: unknown) => string }
  const entries: CapturedEntry[] = []
  const disposers: Array<() => void> = []
  const systemPrompt = {
    context(entry: CapturedEntry): () => void {
      entries.push(entry)
      let disposed = false
      const dispose = () => { disposed = true }
      disposers.push(dispose)
      return dispose
    },
  }
  return { systemPrompt, entries, disposers }
}

describe('seven_tool_registration — tools row registers exactly the seven Layer2 tools', () => {
  it('name/inject/Config shapes; no role config', () => {
    expect(toolsName).toBe('router-tools')
    expect([...toolsInject]).toEqual(['tools', 'routerCollaboration'])
    expect(typeof toolsConfig).toBe('function')
    expect(() => toolsConfig({})).not.toThrow()
  })

  it('registers exactly seven tools in fixed order via routerCollaboration stores', () => {
    const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-tools-test' })
    const { tools, registered } = recordingTools()
    const dispose = toolsApply({ tools, routerCollaboration: runtime })
    expect(registered.map((r) => r.name)).toEqual([...COLLABORATION_TOOL_NAMES])
    expect(registered).toHaveLength(7)
    expect(typeof dispose).toBe('function')
  })

  it('clean disposal: disposer is a function; calling it does not throw', () => {
    const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-tools-test' })
    const { tools } = recordingTools()
    const dispose = toolsApply({ tools, routerCollaboration: runtime })
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })
})

describe('context_actual_session — context row reads the real current Agent session id', () => {
  it('name/inject/Config shapes; inject systemPrompt + routerCollaboration', () => {
    expect(contextName).toBe('router-context')
    expect([...contextInject]).toEqual(['systemPrompt', 'routerCollaboration'])
    expect(typeof contextConfig).toBe('function')
    expect(() => contextConfig({})).not.toThrow()
  })

  it('text callback uses assembly.agent.id (the real current session), not an inferred root', () => {
    const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-context-test' })
    const { systemPrompt, entries } = recordingSystemPrompt()
    const dispose = contextApply({ systemPrompt, routerCollaboration: runtime }, {})
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    // 官方 systemPrompt.context 的 text 回调收 AssembleContext（含 dsh-agent 注入的 agent）
    const text = entry.text({ agent: { id: 'session-real-123' } })
    expect(text).toContain('session-real-123')
    // 协作目录来自共享 dataDir
    expect(text).toContain('collaboration')
    expect(typeof dispose).toBe('function')
  })

  it('missing agent (unsupported host service) is diagnosed, not fabricated', () => {
    const runtime = createCollaborationRuntime({ dataDir: '/tmp/router-context-test' })
    const { systemPrompt, entries } = recordingSystemPrompt()
    contextApply({ systemPrompt, routerCollaboration: runtime }, {})
    const entry = entries[0]!
    // 无 agent：不得臆造一个会话 ID；文本应说明当前会话 ID 不可用
    const text = entry.text({})
    expect(text).not.toMatch(/当前会话 ID：session-/)
    expect(text).toMatch(/会话|session|不可用|unknown|未知/i)
  })
})

describe('host root service — bare package name, provides routerCollaboration, no old wiring', () => {
  it('name is the bare package name; inject is empty (root provides, does not require old hosts)', () => {
    expect(entryName).toBe('@goodjin2/dsh-router')
    expect([...entryInject]).toEqual([])
  })

  it('apply provides routerCollaboration with records/roles/dataDir and returns a disposer', () => {
    const provided: Array<[string, unknown]> = []
    const effects: string[] = []
    const ctx = {
      provide(name: string, value: unknown) { provided.push([name, value]); return () => {} },
      effect(factory: () => unknown, label?: string) { effects.push(label ?? ''); return () => {} },
    }
    const dispose = entryApply(ctx, { dataDir: '/tmp/router-entry-test' })
    const providedNames = provided.map(([n]) => n)
    expect(providedNames).toContain('routerCollaboration')
    const face = provided.find(([n]) => n === 'routerCollaboration')![1] as {
      records: { create: unknown }; roles: { save: unknown }; dataDir: string
    }
    expect(face.dataDir).toBe('/tmp/router-entry-test')
    expect(typeof face.records.create).toBe('function')
    expect(typeof face.roles.save).toBe('function')
    expect(typeof dispose).toBe('function')
    // 不注册任何旧业务 effect（无 scheduler/adjudicator/adoption/快照补刷）
    expect(effects).toEqual([])
  })

  it('apply with no config resolves default dataDir under DSH_HOME/router', () => {
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = '/tmp/dsh-home-entry'
    try {
      const provided: Array<[string, unknown]> = []
      const ctx = { provide(name: string, value: unknown) { provided.push([name, value]); return () => {} }, effect: () => () => {} }
      entryApply(ctx, undefined)
      const face = provided.find(([n]) => n === 'routerCollaboration')![1] as { dataDir: string }
      expect(face.dataDir).toBe('/tmp/dsh-home-entry/router')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
})

const seededRoots: string[] = []
afterAll(async () => {
  await Promise.all(seededRoots.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('entry 预置角色种入（seedPresetRoles 接线）', () => {
  it('apply 后台种入四个预置角色到 dataDir；重复 apply 不增不改', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'router-entry-seed-'))
    seededRoots.push(dir)
    const makeCtx = () => {
      const provided: Array<[string, unknown]> = []
      return {
        ctx: {
          provide(name: string, value: unknown) { provided.push([name, value]); return () => {} },
          effect: () => () => {},
        },
        face: () => provided.find(([n]) => n === 'routerCollaboration')![1] as {
          roles: { list(): Promise<Array<{ name: string }>> }
        },
      }
    }
    const first = makeCtx()
    entryApply(first.ctx, { dataDir: dir })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    const names = (await first.face().roles.list()).map((r) => r.name)
    expect(names).toEqual(['主管', '执行者', '调研员', '评审员'])
    const second = makeCtx()
    entryApply(second.ctx, { dataDir: dir })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    const again = (await second.face().roles.list()).map((r) => r.name)
    expect(again).toEqual(['主管', '执行者', '调研员', '评审员'])
  })
})
