/**
 * 轻量协作上下文构建 buildCollaborationContext 测试（计划 Task 2A，Layer 2）。
 *
 * brief 断言：纯函数确定性 / 报告当前 sessionId（非推断 root）/ 协作目录 /
 * 父级须显式提供 rootSessionId（缺则提示向上级询问）/ 七个工具名齐全 /
 * 不同子会话 sessionId 不会改写（臆造）已传入的 task root / 无旧扫描 /
 * 无 DB/文件系统/宿主/时间戳/动态账本/推断归属访问。
 */

import { describe, expect, it, vi } from 'vitest'

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

  it('lists all collaboration tool names (incl. router_compact)', () => {
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
    expect(out).toContain('系统提示词')
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

  function registerRow(face: { dataDir: string; roles: { list(): Promise<Array<{ name: string; description: string }>> }; activeTasks?: { get(rootSessionId: string): unknown; refresh(rootSessionId: string): Promise<unknown> } }, config?: Record<string, unknown>): { entry: CapturedEntry; dispose: () => void } {
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

describe('buildCollaborationContext — 活跃任务注入（完整描述 + 子会话）', () => {
  it('undefined（尚未加载）：显示加载中并指向 router_record_list', () => {
    const text = buildCollaborationContext({ sessionId: 'sid', dataDir: '/tmp/x', tasks: undefined })
    expect(text).toContain('## 活跃任务')
    expect(text).toContain('加载中')
    expect(text).toContain('router_record_list')
  })

  it('空数组：明确说没有活跃任务', () => {
    const text = buildCollaborationContext({ sessionId: 'sid', dataDir: '/tmp/x', tasks: [] })
    expect(text).toContain('当前没有活跃任务')
  })

  it('有任务：标题 + 标签 + taskId + 完整描述正文（不是摘要）+ 子会话清单与 continue 指引', () => {
    const body = '目标：改造登录\n约束：不改动注册流程\n验收：三条用例全过\n（很长也很完整）'
    const text = buildCollaborationContext({
      sessionId: 'sid', dataDir: '/tmp/x',
      tasks: [
        { taskId: 't-1', title: '改造登录', body, workLabel: '进行中', sessions: [{ sessionId: 'c-1', label: '执行者' }, { sessionId: 'c-2', label: '测试工程师' }] },
        { taskId: 't-2', title: '尚无分工', body: '', workLabel: '待处理', sessions: [] },
      ],
    })
    expect(text).toContain('### [进行中] 改造登录（taskId：t-1）')
    expect(text).toContain(body) // 完整描述逐字注入
    expect(text).toContain('- 执行者：c-1')
    expect(text).toContain('- 测试工程师：c-2')
    expect(text).toContain('mode=continue, expectedChildId=')
    expect(text).toContain('### [待处理] 尚无分工（taskId：t-2）')
    expect(text).toContain('（无描述）')
    expect(text).toContain('尚未派发')
    // 任务段出现在角色段之前（先知道在做什么，再挑角色）
    expect(text.indexOf('## 活跃任务')).toBeLessThan(text.indexOf('角色模板（专业类型）'))
  })

  it('确定性：相同入参逐字相同', () => {
    const tasks = [{ taskId: 't-1', title: 'A', body: 'b', workLabel: '待处理' as const, sessions: [] }]
    const a = buildCollaborationContext({ sessionId: 'sid', dataDir: '/tmp/x', tasks })
    const b = buildCollaborationContext({ sessionId: 'sid', dataDir: '/tmp/x', tasks })
    expect(a).toBe(b)
  })
})

describe('context row apply — 整段关闭宿主变量插值（防 {{…}} 穿透炸整轮）', () => {
  interface CapturedEntry { name: string; order: number; text(assembly?: unknown): string; interpolate?: boolean }

  it('注册的上下文段带 interpolate: false（宿主当字面文本、不解析 {{…}}）', () => {
    let captured: CapturedEntry | undefined
    const dispose = contextApply(
      { systemPrompt: { context: (e: CapturedEntry) => { captured = e } }, routerCollaboration: { dataDir: '/tmp/x', roles: { list: async () => [] } } as never },
      { order: 100 } as never,
    )
    expect(captured!.interpolate).toBe(false)
    dispose()
  })

  it('任务描述里混入 {{…}} 也不抛：buildCollaborationContext 把花括号原样输出（交由宿主关插值兜底）', () => {
    const hostile = '接口配置 {{InterfaceName: tun0 LinkAddresses: [10.250.0.2/32] DnsAddresses: [223.5.5.5] MTU:1500}}'
    let text = ''
    expect(() => {
      text = buildCollaborationContext({
        sessionId: 'sid', dataDir: '/tmp/x',
        tasks: [{ taskId: 't-1', title: '配网', body: hostile, workLabel: '进行中', sessions: [] }],
      })
    }).not.toThrow()
    // 任务描述逐字保留（不被改写），且整段含那对花括号——正是宿主会去解析的串。
    expect(text).toContain(hostile)
  })
})

describe('context row apply — 活跃任务视图缓存接线', () => {
  interface CapturedEntry { name: string; order: number; text(assembly?: unknown): string }

  it('缓存有值时 text() 同步带上任务；缓存没有时后台 refresh 一次并渲染加载中；refresh 抛错不穿透', async () => {
    let cached: unknown = undefined
    const refresh = vi.fn(async (root: string) => { cached = [{ taskId: root, title: 'A', body: 'b', workLabel: '待处理', sessions: [] }]; return cached })
    let captured: CapturedEntry | undefined
    const dispose = contextApply(
      {
        systemPrompt: { context: (e: CapturedEntry) => { captured = e } },
        routerCollaboration: { dataDir: '/tmp/x', roles: { list: async () => [] }, activeTasks: { get: () => cached, refresh } } as never,
      },
      { order: 100 } as never,
    )
    const entry = captured!
    expect(entry.text({ agent: { id: 'sid' } })).toContain('加载中')
    expect(refresh).toHaveBeenCalledWith('sid')
    await Promise.resolve(); await Promise.resolve()
    expect(entry.text({ agent: { id: 'sid' } })).toContain('### [待处理] A（taskId：sid）')
    expect(entry.text({ agent: { id: 'sid' } })).toContain('b')
    dispose()
    // refresh 抛错：吞掉，不穿透
    let captured2: CapturedEntry | undefined
    const dispose2 = contextApply(
      {
        systemPrompt: { context: (e: CapturedEntry) => { captured2 = e } },
        routerCollaboration: { dataDir: '/tmp/x', roles: { list: async () => [] }, activeTasks: { get: () => undefined, refresh: async () => { throw new Error('io') } } } as never,
      },
      { order: 100 } as never,
    )
    expect(() => captured2!.text({ agent: { id: 'sid' } })).not.toThrow()
    expect(captured2!.text({ agent: { id: 'sid' } })).toContain('加载中')
    dispose2()
  })

  it('activeTasks 面缺席：任务段按加载中渲染，不抛', () => {
    let captured: CapturedEntry | undefined
    const dispose = contextApply(
      { systemPrompt: { context: (e: CapturedEntry) => { captured = e } }, routerCollaboration: { dataDir: '/tmp/x', roles: { list: async () => [] } } as never },
      { order: 100 } as never,
    )
    expect(() => captured!.text({ agent: { id: 'sid' } })).not.toThrow()
    expect(captured!.text({ agent: { id: 'sid' } })).toContain('加载中')
    dispose()
  })
})
