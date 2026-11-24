/**
 * 压缩工具 router_compact 测试（2026-11-24：模型主动压，取代自动触发）。
 *
 * brief 命名断言：
 *  - range_incremental：范围 = 上一份检查点之后 → 当前回合之前（只含已闭合回合）；没有检查点则跳过系统头；
 *    终点按配对回退；没有可压内容返回 null。
 *  - render_task_list：检查点正文是任务列表（根任务按创建序、子任务缩进挂父任务、子会话、最近报告、notes），
 *    外层 <compacted-summary>，确定性。
 *  - tool_lands_checkpoint：写 compaction/start → user/message(replace, sourceEventSeqs=全部被遮蔽节点,
 *    source 为 compact-checkpoint) → compaction/end；返回范围与正文。
 *  - tool_noop_and_failures：没有可压内容 → compacted:false 且不写任何事件；追加失败 → 写 end(error) 并抛 IO_ERROR。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  buildCompactTool,
  findCompactRange,
  renderTaskListCheckpoint,
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  type SessionEventLike,
  type SessionFace,
} from '../../src/collaboration/compact.ts'
import { createRecordStore } from '../../src/collaboration/records.ts'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

/** 产生 surface 节点的事件类型。 */
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/call', 'tool/result'])

/**
 * 造假会话：layout 里每项一个事件；seq 从 1 递增。`checkpoint: true` 的 user/message 带检查点 source。
 * surface.nodes = 所有 surface 类型事件的 seq。
 */
function makeSession(layout: Array<{ type: string; checkpoint?: boolean }>): SessionFace & { appended: Array<{ type: string; data: unknown; opts: unknown }> } {
  const events: SessionEventLike[] = layout.map((item, index) => ({
    seq: index + 1,
    type: item.type,
    data: item.type === 'user/message' && item.checkpoint === true
      ? { content: [{ type: 'text', text: 'cp' }], source: { kind: 'compact-checkpoint', compactionId: 'c' } }
      : item.type === 'user/message'
        ? { content: [{ type: 'text', text: 'm' }], source: { kind: 'user' } }
        : {},
  }))
  const nodes = events.filter((e) => SURFACE_TYPES.has(e.type)).map((e) => e.seq)
  const appended: Array<{ type: string; data: unknown; opts: unknown }> = []
  let nextSeq = events.length + 1
  return {
    events,
    surface: { nodes },
    appended,
    append(type, data, opts) {
      appended.push({ type, data, opts })
      return { seq: nextSeq++ }
    },
  }
}

const EXEC = (session: unknown) => ({ agent: { session } })
const alwaysBalanced = () => true

describe('range_incremental — 只压上次检查点以来的已闭合回合', () => {
  it('空 surface → null', () => {
    expect(findCompactRange(makeSession([]), alwaysBalanced)).toBeNull()
  })

  it('只有当前这一轮（没有已闭合回合）→ null', () => {
    const s = makeSession([{ type: 'system/message' }, { type: 'turn/start' }, { type: 'user/message' }, { type: 'assistant/message' }])
    expect(findCompactRange(s, alwaysBalanced)).toBeNull()
  })

  it('没有检查点：起点跳过 system/message 头，终点 = 当前回合前最后一个节点；sinceCheckpointSeq = null', () => {
    const s = makeSession([
      { type: 'system/message' },      // 1 (surface)
      { type: 'turn/start' },          // 2
      { type: 'user/message' },        // 3 (surface)
      { type: 'assistant/message' },   // 4
      { type: 'tool/call' },           // 5
      { type: 'tool/result' },         // 6
      { type: 'turn/end' },            // 7
      { type: 'turn/start' },          // 8 ← 当前回合
      { type: 'user/message' },        // 9
      { type: 'tool/call' },           // 10（router_compact 自己）
    ])
    const range = findCompactRange(s, alwaysBalanced)!
    expect(range).toEqual({ startSeq: 3, endSeq: 6, shadowedSeqs: [3, 4, 5, 6], sinceCheckpointSeq: null })
  })

  it('有检查点：起点 = 检查点之后第一个节点，检查点本身不被压；sinceCheckpointSeq = 检查点 seq', () => {
    const s = makeSession([
      { type: 'system/message' },          // 1
      { type: 'user/message' },            // 2
      { type: 'assistant/message' },       // 3
      { type: 'turn/end' },                // 4
      { type: 'user/message', checkpoint: true }, // 5 ← 上一份检查点
      { type: 'turn/start' },              // 6
      { type: 'user/message' },            // 7
      { type: 'assistant/message' },       // 8
      { type: 'turn/end' },                // 9
      { type: 'turn/start' },              // 10 ← 当前回合
      { type: 'user/message' },            // 11
    ])
    const range = findCompactRange(s, alwaysBalanced)!
    expect(range.startSeq).toBe(7)
    expect(range.endSeq).toBe(8)
    expect(range.shadowedSeqs).toEqual([7, 8])
    expect(range.sinceCheckpointSeq).toBe(5)
  })

  it('检查点之后还没有已闭合回合（刚压过）→ null', () => {
    const s = makeSession([
      { type: 'user/message' },
      { type: 'assistant/message' },
      { type: 'user/message', checkpoint: true }, // 3
      { type: 'turn/start' },                     // 4 当前
      { type: 'user/message' },                   // 5
    ])
    expect(findCompactRange(s, alwaysBalanced)).toBeNull()
  })

  it('终点按配对回退：第一个保留节点之前不平衡就往前挪，不切开工具调用/结果', () => {
    const s = makeSession([
      { type: 'user/message' },        // 1
      { type: 'assistant/message' },   // 2
      { type: 'tool/call' },           // 3
      { type: 'tool/result' },         // 4
      { type: 'assistant/message' },   // 5
      { type: 'turn/start' },          // 6 当前
      { type: 'user/message' },        // 7
    ])
    // 模拟：在 7 之前不平衡（如 5 后有悬空），在 5 之前平衡 → 终点回退到 4
    const balancedBefore = (session: SessionFace, seq: number) => seq !== 7
    const range = findCompactRange(s, balancedBefore)!
    expect(range.startSeq).toBe(1)
    expect(range.endSeq).toBe(4)
    expect(range.shadowedSeqs).toEqual([1, 2, 3, 4])
  })

  it('回退到起点之前 → null（宁可不压也不切开配对）', () => {
    const s = makeSession([
      { type: 'user/message' },        // 1
      { type: 'assistant/message' },   // 2
      { type: 'turn/start' },          // 3
      { type: 'user/message' },        // 4
    ])
    expect(findCompactRange(s, () => false)).toBeNull()
  })

  it('没有 turn/start（不是在回合里）→ null，不臆造边界', () => {
    const s = makeSession([{ type: 'user/message' }, { type: 'assistant/message' }])
    expect(findCompactRange(s, alwaysBalanced)).toBeNull()
  })
})

describe('render_task_list — 检查点正文是任务列表', () => {
  const base = (over: Partial<Parameters<typeof renderTaskListCheckpoint>[0]['tasks'][number]> = {}) => ({
    taskId: 't1', title: '改造登录', body: '目标：改造登录\n约束：不动注册', workLabel: '进行中', createdAt: 2,
    sessions: [{ label: '执行者', sessionId: 'c-1' }], latestReportTitle: '阶段报告', ...over,
  })

  it('外层标签、首压/增量两种说明、任务行含状态/标题/taskId/一句目标/子会话/最近报告、notes', () => {
    const text = renderTaskListCheckpoint({
      tasks: [base()],
      notes: ['用户改主意：不做手机端', '  ', '决策：先做只读版本'],
      sinceCheckpointSeq: null,
    })
    expect(text.startsWith(SUMMARY_OPEN_TAG)).toBe(true)
    expect(text.endsWith(SUMMARY_CLOSE_TAG)).toBe(true)
    expect(text).toContain('这是本会话第一次压缩')
    expect(text).toContain('## 任务（共 1 条）')
    expect(text).toContain('- [进行中] 改造登录（taskId：t1）—— 目标：改造登录')
    expect(text).toContain('- 子会话：执行者=c-1')
    expect(text).toContain('- 最近报告：阶段报告')
    expect(text).toContain('- 用户改主意：不做手机端')
    expect(text).toContain('- 决策：先做只读版本')
    expect(text).not.toContain('-   ') // 空白 note 被丢掉
    const inc = renderTaskListCheckpoint({ tasks: [base()], notes: [], sinceCheckpointSeq: 42 })
    expect(inc).toContain('取代了上一份检查点（seq 42）之后的对话')
    expect(inc).toContain('（模型未附注）')
  })

  it('根任务按创建序；子任务缩进挂在父任务下；没有任务/没有描述有占位', () => {
    const text = renderTaskListCheckpoint({
      tasks: [
        base({ taskId: 'b', title: 'B', createdAt: 20, sessions: [], latestReportTitle: undefined }),
        base({ taskId: 'a', title: 'A', createdAt: 10, body: '', sessions: [] }),
        base({ taskId: 'a1', title: 'A1', parentTaskId: 'a', createdAt: 15, sessions: [], latestReportTitle: undefined }),
        base({ taskId: 'a1x', title: 'A1X', parentTaskId: 'a1', createdAt: 16, sessions: [], latestReportTitle: undefined }),
      ],
      notes: [],
      sinceCheckpointSeq: 1,
    })
    const lines = text.split('\n')
    const a = lines.findIndex((l) => l.startsWith('- [') && l.includes('（taskId：a）'))
    const b = lines.findIndex((l) => l.startsWith('- [') && l.includes('（taskId：b）'))
    const a1 = lines.findIndex((l) => l.startsWith('  - [') && l.includes('（taskId：a1）'))
    const a1x = lines.findIndex((l) => l.startsWith('    - [') && l.includes('（taskId：a1x）'))
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a) // A(10) 在 B(20) 前
    expect(a1).toBeGreaterThan(a)
    expect(a1).toBeLessThan(b) // 子任务紧跟父任务
    expect(a1x).toBeGreaterThan(a1)
    expect(lines[a]!).toContain('（无描述）')
    expect(renderTaskListCheckpoint({ tasks: [], notes: [], sinceCheckpointSeq: null })).toContain('（没有任务记录）')
  })

  it('一句目标过长截断；确定性', () => {
    const long = 'x'.repeat(300)
    const t1 = renderTaskListCheckpoint({ tasks: [base({ body: long })], notes: [], sinceCheckpointSeq: null })
    expect(t1).toContain('…')
    expect(t1).not.toContain(long)
    const t2 = renderTaskListCheckpoint({ tasks: [base({ body: long })], notes: [], sinceCheckpointSeq: null })
    expect(t1).toBe(t2)
  })
})

describe('tool_lands_checkpoint — 按压缩事务协议落地', () => {
  async function makeDeps() {
    const dir = await mkdtemp(join(tmpdir(), 'router-compact-'))
    roots.push(dir)
    const records = createRecordStore(dir)
    const main = await records.create('root-1', { kind: 'task', title: '主任务', body: '目标：做完', workLabel: '进行中' })
    await records.create('root-1', { kind: 'task', parentRecordId: main.record.taskId, title: '子任务', body: '目标：一部分' })
    await records.create('root-1', { kind: 'assignment', taskId: main.record.taskId, title: 'a', body: '', sessions: [{ label: '执行者', sessionId: 'c-1' }] })
    await records.create('root-1', { kind: 'report', taskId: main.record.taskId, title: '早期报告', body: '' })
    await new Promise((r) => setTimeout(r, 2))
    await records.create('root-1', { kind: 'report', taskId: main.record.taskId, title: '最近报告', body: '' })
    return { records }
  }

  it('写 start → 检查点（replace + sourceEventSeqs + compact-checkpoint source）→ end；返回范围、计数与正文', async () => {
    const { records } = await makeDeps()
    const s = makeSession([
      { type: 'system/message' }, { type: 'turn/start' }, { type: 'user/message' }, { type: 'assistant/message' }, { type: 'turn/end' },
      { type: 'turn/start' }, { type: 'user/message' }, { type: 'tool/call' },
    ])
    const uuid = vi.fn(() => '11111111-1111-4111-8111-111111111111')
    const tool = buildCompactTool({ records, uuid, balancedBefore: alwaysBalanced })
    const result = (await tool.execute({ rootSessionId: 'root-1', notes: ['决策：先只读'] }, EXEC(s))) as Record<string, unknown>
    expect(uuid).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ compacted: true, compactionId: '11111111-1111-4111-8111-111111111111', startSeq: 3, endSeq: 4, shadowedCount: 2, taskCount: 2 })
    expect(result.sinceCheckpointSeq).toBeUndefined()
    // 三条事件按协议顺序
    expect(s.appended.map((a) => a.type)).toEqual(['compaction/start', 'user/message', 'compaction/end'])
    expect(s.appended[0]!.opts).toEqual({ surfaceOp: 'append' })
    const cp = s.appended[1]!
    expect(cp.opts).toEqual({ surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] })
    const data = cp.data as { content: Array<{ text: string }>; source: unknown }
    expect(isCompactCheckpointSource(data.source as Parameters<typeof isCompactCheckpointSource>[0])).toBe(true)
    expect(data.content[0]!.text).toBe(result.checkpoint)
    // 正文：任务列表来自记录（含子任务、子会话、最近报告、notes）
    const text = result.checkpoint as string
    expect(text).toContain('## 任务（共 2 条）')
    expect(text).toContain('- [进行中] 主任务（taskId：')
    // 子任务建时没给 workLabel → 视为未标注；缩进两格挂在主任务下
    expect(text).toContain('  - [未标注] 子任务（taskId：')
    expect(text).toContain('- 子会话：执行者=c-1')
    expect(text).toContain('- 最近报告：最近报告')
    expect(text).not.toContain('早期报告')
    expect(text).toContain('- 决策：先只读')
    // render 把正文给模型看
    const rendered = tool.output!.render!({} as never, result) as Array<{ text: string }>
    expect(rendered[0]!.text).toContain('已压缩 2 个节点（任务 2 条）')
    expect(rendered[0]!.text).toContain('## 任务（共 2 条）')
  })

  it('第二次压缩：范围从上一份检查点之后开始，sinceCheckpointSeq 带回', async () => {
    const { records } = await makeDeps()
    const s = makeSession([
      { type: 'user/message' }, { type: 'assistant/message' }, { type: 'user/message', checkpoint: true }, // 3
      { type: 'turn/start' }, { type: 'user/message' }, { type: 'assistant/message' }, { type: 'turn/end' },
      { type: 'turn/start' }, { type: 'user/message' },
    ])
    const tool = buildCompactTool({ records, uuid: () => 'u', balancedBefore: alwaysBalanced })
    const result = (await tool.execute({ rootSessionId: 'root-1' }, EXEC(s))) as Record<string, unknown>
    expect(result).toMatchObject({ compacted: true, startSeq: 5, endSeq: 6, sinceCheckpointSeq: 3 })
  })

  it('参数校验：缺 rootSessionId / notes 不是字符串数组 / 没有 exec.agent.session → INVALID_INPUT，不写事件', async () => {
    const { records } = await makeDeps()
    const tool = buildCompactTool({ records, uuid: () => 'u', balancedBefore: alwaysBalanced })
    const s = makeSession([{ type: 'user/message' }, { type: 'turn/start' }, { type: 'user/message' }])
    await expect(tool.execute({ notes: [] }, EXEC(s))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(tool.execute({ rootSessionId: 'r', notes: 'x' }, EXEC(s))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(tool.execute({ rootSessionId: 'r', notes: [1] }, EXEC(s))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(tool.execute({ rootSessionId: 'r' }, { agent: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(tool.execute({ rootSessionId: 'r' }, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(s.appended).toHaveLength(0)
  })
})

describe('tool_noop_and_failures — 没有可压内容与落地失败', () => {
  async function makeFailDeps() {
    const dir = await mkdtemp(join(tmpdir(), 'router-compact-fail-'))
    roots.push(dir)
    const records = createRecordStore(dir)
    await records.create('root-1', { kind: 'task', title: 'T', body: 'b' })
    return { records }
  }

  it('没有可压内容（当前是第一轮）→ compacted:false + reason，不写任何事件', async () => {
    const { records } = await makeFailDeps()
    const tool = buildCompactTool({ records, uuid: () => 'u', balancedBefore: alwaysBalanced })
    // 真实会话：第一条用户消息在回合内记录（turn/start 之后），所以第一轮里没有已闭合回合可压。
    const s = makeSession([{ type: 'system/message' }, { type: 'turn/start' }, { type: 'user/message' }, { type: 'tool/call' }])
    const result = (await tool.execute({ rootSessionId: 'root-1' }, EXEC(s))) as { compacted: boolean; reason: string }
    expect(result.compacted).toBe(false)
    expect(result.reason).toMatch(/没有可压/)
    expect(s.appended).toHaveLength(0)
    const rendered = tool.output!.render!({} as never, result) as Array<{ text: string }>
    expect(rendered[0]!.text).toContain('未压缩')
  })

  it('检查点追加失败 → 写 compaction/end(error) 闭合锁，抛 IO_ERROR', async () => {
    const { records } = await makeFailDeps()
    const tool = buildCompactTool({ records, uuid: () => 'u', balancedBefore: alwaysBalanced })
    // 一个已闭合回合 + 当前回合：范围 [3..4]，检查点追加时抛错。
    const s = makeSession([
      { type: 'system/message' }, { type: 'turn/start' }, { type: 'user/message' }, { type: 'assistant/message' }, { type: 'turn/end' },
      { type: 'turn/start' }, { type: 'user/message' }, { type: 'tool/call' },
    ])
    const origAppend = s.append.bind(s)
    let count = 0
    s.append = ((type: string, data: unknown, opts: unknown) => {
      count += 1
      if (type === 'user/message') throw new Error('surface changed')
      return origAppend(type, data, opts as Parameters<typeof origAppend>[2])
    }) as typeof s.append
    await expect(tool.execute({ rootSessionId: 'root-1' }, EXEC(s))).rejects.toMatchObject({ code: 'IO_ERROR' })
    expect(s.appended.map((a) => a.type)).toEqual(['compaction/start', 'compaction/end'])
    expect(s.appended[1]!.data).toMatchObject({ turn: null, error: 'surface changed' })
    expect(count).toBe(3)
  })
})
