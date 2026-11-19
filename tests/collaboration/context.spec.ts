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
  'router_dispatch',
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

describe('buildCollaborationContext — 角色清单注入', () => {
  it('提供角色：渲染名称与职责说明，并给出用法与工具指引', () => {
    const out = buildCollaborationContext({
      sessionId: 'sid', dataDir: '/data/plugin',
      roles: [
        { name: '主管', description: '拆解任务并派发汇总' },
        { name: '执行者', description: '' },
      ],
    })
    expect(out).toContain('主管')
    expect(out).toContain('拆解任务并派发汇总')
    expect(out).toContain('执行者')
    expect(out).toContain('router_role_list')
    expect(out).toContain('初始指令')
  })

  it('空角色库：显示暂无并指引用户/模型新建', () => {
    const out = buildCollaborationContext({ sessionId: 'sid', dataDir: '/data/plugin', roles: [] })
    expect(out).toContain('暂无角色模板')
    expect(out).toContain('router_role_save')
  })

  it('多行职责只注入首行摘要，正文不进清单（v2 两层结构）', () => {
    const out = buildCollaborationContext({
      sessionId: 'sid', dataDir: '/data/plugin',
      roles: [
        { name: '测试工程师', description: '一句话摘要，测试用。\n\n## 详细职责\n这一段正文不应进入上下文清单。' },
      ],
    })
    expect(out).toContain('测试工程师：一句话摘要，测试用。')
    expect(out).not.toContain('详细职责')
    expect(out).not.toContain('不应进入上下文清单')
  })

  it('首行为空行/空白的职责取第一个非空行做摘要', () => {
    const out = buildCollaborationContext({
      sessionId: 'sid', dataDir: '/data/plugin',
      roles: [{ name: '调研员', description: '\n  \n摘要行在前导空白之后。\n正文第二段。' }],
    })
    expect(out).toContain('调研员：摘要行在前导空白之后。')
    expect(out).not.toContain('正文第二段')
  })

  it('未提供（undefined，尚未加载）：显示暂不可用并指向查询工具', () => {
    const out = buildCollaborationContext({ sessionId: 'sid', dataDir: '/data/plugin' })
    expect(out).toContain('暂不可用')
    expect(out).toContain('router_role_list')
  })
})

describe('context row apply — 角色清单缓存与后台刷新', () => {
  interface CapturedEntry { name: string; order: number; text(assembly?: unknown): string }

  function registerRow(face: { dataDir: string; roles: { list(): Promise<Array<{ name: string; description: string }>> } }, config?: Record<string, unknown>): { entry: CapturedEntry; dispose: () => void } {
    let captured: CapturedEntry | undefined
    const dispose = contextApply(
      { systemPrompt: { context: (e: CapturedEntry) => { captured = e } }, routerCollaboration: face as never },
      { order: 100, ...config } as never,
    )
    return { get entry() { return captured! }, dispose }
  }

  async function flush(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  it('初始未加载显示暂不可用；后台加载完成后 text() 带上角色清单', async () => {
    let current = [{ name: '主管', description: '拆解' }]
    const row = registerRow({ dataDir: '/tmp/roles-row', roles: { list: async () => current } }, { rolesTtlMs: 0 })
    // 初始：后台加载已 kicked，但本轮 text() 仍用未加载缓存。
    expect(row.entry.text({ agent: { id: 'sid' } })).toContain('暂不可用')
    await flush()
    expect(row.entry.text({ agent: { id: 'sid' } })).toContain('主管')
    // TTL=0：每次 text() 都 kick 后台刷新。注意在途刷新会吸收旧数据并刷新时间戳——
    // 先让上一轮在途完成，再改数据、再触发新刷新（与生产 30s 窗口的自愈语义一致）。
    current = [{ name: '评审员', description: '把关' }]
    await flush()
    expect(row.entry.text({ agent: { id: 'sid' } })).toContain('主管') // 新刷新在途，本轮仍渲染旧缓存
    await flush()
    expect(row.entry.text({ agent: { id: 'sid' } })).toContain('评审员')
    row.dispose()
  })

  it('roles.list 抛错：text() 降级不抛，显示暂不可用', async () => {
    const row = registerRow({ dataDir: '/tmp/roles-row', roles: { list: async () => { throw new Error('boom') } } }, { rolesTtlMs: 0 })
    await flush()
    expect(() => row.entry.text({ agent: { id: 'sid' } })).not.toThrow()
    expect(row.entry.text({ agent: { id: 'sid' } })).toContain('暂不可用')
    row.dispose()
  })
})
