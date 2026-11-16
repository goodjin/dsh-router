/**
 * 轻量协作上下文构建 buildCollaborationContext 测试（计划 Task 2A，Layer 2）。
 *
 * brief 断言：纯函数确定性 / 报告当前 sessionId（非推断 root）/ 协作目录 /
 * 父级须显式提供 rootSessionId（缺则提示向上级询问）/ 七个工具名齐全 /
 * 不同子会话 sessionId 不会改写（臆造）已传入的 task root / 无旧扫描 /
 * 无 DB/文件系统/宿主/时间戳/动态账本/推断归属访问。
 */

import { describe, expect, it } from 'vitest'

import { buildCollaborationContext } from '../../src/collaboration/context.ts'
import { apply as contextApply, Config as contextConfig } from '../../src/context.ts'
import { createCollaborationRuntime } from '../../src/collaboration/runtime.ts'

const TOOL_NAMES = [
  'router_record_create',
  'router_record_read',
  'router_record_list',
  'router_record_update',
  'router_role_list',
  'router_role_read',
  'router_role_save',
]

describe('buildCollaborationContext — pure deterministic text', () => {
  it('returns a string for the same args deterministically', () => {
    const a = buildCollaborationContext({ sessionId: 'sid-1', dataDir: '/data/plugin' })
    const b = buildCollaborationContext({ sessionId: 'sid-1', dataDir: '/data/plugin' })
    expect(typeof a).toBe('string')
    expect(a).toBe(b)
  })

  it('reports the current sessionId (not an inferred root)', () => {
    const out = buildCollaborationContext({ sessionId: 'sid-current', dataDir: '/data/plugin' })
    expect(out).toContain('sid-current')
  })

  it('reports the collaboration directory under dataDir (joined once)', () => {
    const out = buildCollaborationContext({ sessionId: 'sid', dataDir: '/data/plugin' })
    expect(out).toContain('/data/plugin/collaboration')
  })

  it('lists all seven tool names', () => {
    const out = buildCollaborationContext({ sessionId: 'sid', dataDir: '/data/plugin' })
    for (const name of TOOL_NAMES) expect(out).toContain(name)
  })

  it('states rootSessionId must be supplied by the parent; asks parent when missing', () => {
    const out = buildCollaborationContext({ sessionId: 'sid', dataDir: '/data/plugin' })
    expect(out).toContain('rootSessionId')
    expect(out).toMatch(/上级/)
  })

  it('a child sessionId does not get rewritten into a fabricated root', () => {
    const child = buildCollaborationContext({ sessionId: 'child-sess-1', dataDir: '/data/plugin' })
    // current session reported faithfully
    expect(child).toContain('child-sess-1')
    // still asks parent for root; does NOT claim child-sess-1 IS the root
    expect(child).toMatch(/上级/)
    // must not bind the current session as the root
    expect(child).not.toMatch(/rootSessionId[^\n]*child-sess-1/)
  })

  it('different sessionId changes only the reported session, both still defer root to parent', () => {
    const a = buildCollaborationContext({ sessionId: 'child-A', dataDir: '/data/plugin' })
    const b = buildCollaborationContext({ sessionId: 'child-B', dataDir: '/data/plugin' })
    expect(a).not.toBe(b)
    expect(a).toContain('child-A')
    expect(b).toContain('child-B')
    // neither fabricates a root; both defer to parent
    expect(a).toMatch(/上级/)
    expect(b).toMatch(/上级/)
  })

  it('rejects invalid input (missing/non-string sessionId or dataDir)', () => {
    expect(() => buildCollaborationContext({ sessionId: '', dataDir: '/data' })).toThrow()
    expect(() => buildCollaborationContext({ sessionId: 'sid', dataDir: '' })).toThrow()
    // @ts-expect-error invalid shape on purpose
    expect(() => buildCollaborationContext({ sessionId: 42, dataDir: '/data' })).toThrow()
  })
})

describe('Config order registration — context row order is honored, not forced to 100', () => {
  /** 记录型假宿主面：capture 注册进 systemPrompt.context 的条目与其 order。 */
  function recordingHost() {
    interface CapturedEntry { name: string; order: number; text: (assembly?: unknown) => string }
    const entries: CapturedEntry[] = []
    const systemPrompt = {
      context(entry: CapturedEntry): () => void {
        entries.push(entry)
        return () => {}
      },
    }
    const routerCollaboration = createCollaborationRuntime({ dataDir: '/tmp/router-context-order-test' })
    return { systemPrompt, routerCollaboration, entries }
  }

  it('Config({order:17}) registers the context entry with order 17, not the default 100', () => {
    const { systemPrompt, routerCollaboration, entries } = recordingHost()
    const parsedConfig = contextConfig({ order: 17 })
    contextApply({ systemPrompt, routerCollaboration }, parsedConfig)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.order).toBe(17)
  })

  it('Config({}) falls back to the documented default order 100', () => {
    const { systemPrompt, routerCollaboration, entries } = recordingHost()
    contextApply({ systemPrompt, routerCollaboration }, contextConfig({}))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.order).toBe(100)
  })
})
