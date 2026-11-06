/**
 * 记忆服务宿主适配层测试（计划 B8：B6 产物 ↔ 宿主服务的接线面）。
 *
 * 全部假件不启宿主：sessionQuery 用假 observeSession（租约可跟踪释放）、
 * llm 用假 stream（可注错）、磁盘用 mem-fs。覆盖 brief 指定的四条：
 * 租约释放、空增量跳过、完成触发写入 project 层、失败不抛。
 */

import { describe, expect, it, vi } from 'vitest'

import {
  BackgroundSummarizer,
  COMPLETED_TASK_KIND,
  createCompletedTaskRecorder,
  createSummaryLlm,
  eventsToSummaryEvents,
  maxSurfaceSeq,
  summarizeSessionViaQuery,
} from '../src/host/memory/adapter.ts'
import { MemoryDocStore } from '../src/host/memory/store.ts'
import type { SummaryEvent } from '../src/host/memory/summarizer.ts'
import { makeMemFs } from './helpers/mem-fs.ts'

/* ────────────────────────── 假件 ────────────────────────── */

interface FakeLease {
  events: unknown[]
  disposed: number
  [Symbol.dispose]?: () => void
}

function fakeQuery(events: unknown[] | Error) {
  const leases: FakeLease[] = []
  return {
    leases,
    observeSession(_sessionId: string): Promise<{ events: unknown[]; [Symbol.dispose]?: () => void }> {
      if (events instanceof Error) return Promise.reject(events)
      const lease: FakeLease = { events, disposed: 0 }
      lease[Symbol.dispose] = () => {
        lease.disposed += 1
      }
      leases.push(lease)
      return Promise.resolve(lease)
    },
  }
}

/** 假 llm：记录调用，可配置返回文本或抛错。 */
function fakeLlm(reply: string | Error) {
  const calls: { messages: unknown[]; signal: AbortSignal | undefined }[] = []
  return {
    calls,
    stream: vi.fn(async (messages: unknown[], signal: AbortSignal | undefined) => {
      calls.push({ messages, signal })
      if (reply instanceof Error) throw reply
      return reply
    }),
  }
}

/** 事件构造器：形状照宿主 surface 事件（deriveEventMessage 的读取面）。 */
function userMessage(seq: number, text: string): unknown {
  return { seq, type: 'user/message', data: { id: `m${seq}`, content: [{ type: 'text', text }] } }
}
function assistantMessage(seq: number, text: string): unknown {
  return { seq, type: 'assistant/message', data: { message: { id: `m${seq}`, role: 'assistant', content: [{ type: 'text', text }] } } }
}
function toolResult(seq: number, text: string): unknown {
  return { seq, type: 'tool/result', data: { message: { id: `m${seq}`, role: 'tool', content: [{ type: 'text', text }] } } }
}
function turnEnd(seq: number): unknown {
  return { seq, type: 'turn/end', data: { reason: { kind: 'completed' } } }
}

function memStore(): MemoryDocStore {
  const { fs } = makeMemFs()
  return new MemoryDocStore('/data/memory', fs, { now: () => 1 })
}

/* ────────────────────────── llm 适配 ────────────────────────── */

describe('createSummaryLlm', () => {
  it('接到 ctx.llm.stream：带 provider/model/messages/purpose=compaction/signal，聚合 text-delta 文本', async () => {
    const routed: { provider: string; model: string } = { provider: 'deepseek', model: 'glm-5' }
    const streamed: { options: Record<string, unknown> }[] = []
    const controller = new AbortController()
    const host = {
      async *stream(options: Record<string, unknown>) {
        streamed.push({ options })
        yield { type: 'text-delta', index: 0, text: '第一段。' }
        yield { type: 'reasoning-delta', index: 1, text: '（思考，不算正文）' }
        yield { type: 'text-delta', index: 1, text: '第二段。' }
        yield { type: 'usage', usage: {} }
      },
    }
    const llm = createSummaryLlm(host, () => routed)
    const text = await llm.stream([{ role: 'user', content: '摘要这些' }], controller.signal)
    expect(text).toBe('第一段。第二段。')
    expect(streamed[0]!.options).toMatchObject({
      provider: 'deepseek',
      model: 'glm-5',
      messages: [{ role: 'user', content: '摘要这些' }],
      purpose: 'compaction',
      signal: controller.signal,
    })
  })

  it('解析不到路由对：抛错且不发起流式调用（fail loud，触发方负责容错）', async () => {
    let streamed = 0
    const host = {
      async *stream() {
        streamed += 1
        yield { type: 'text-delta', index: 0, text: 'x' }
      },
    }
    const llm = createSummaryLlm(host, () => undefined)
    await expect(llm.stream([], new AbortController().signal)).rejects.toThrow(/路由/)
    expect(streamed).toBe(0)
  })

  it('resolveTarget 允许异步（entry 的兜底链要异步读账本）', async () => {
    const streamed: Record<string, unknown>[] = []
    const host = {
      async *stream(options: Record<string, unknown>) {
        streamed.push(options)
        yield { type: 'text-delta', index: 0, text: 'ok' }
      },
    }
    const llm = createSummaryLlm(host, async () => ({ provider: 'async-p', model: 'async-m' }))
    await expect(llm.stream([], new AbortController().signal)).resolves.toBe('ok')
    expect(streamed[0]).toMatchObject({ provider: 'async-p', model: 'async-m' })
  })

  it('宿主流失败：错误原样上抛（摘要失败不推进增量位）', async () => {
    const host = {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '半' }
        throw new Error('provider down')
      },
    }
    const llm = createSummaryLlm(host, () => ({ provider: 'p', model: 'm' }))
    await expect(llm.stream([], new AbortController().signal)).rejects.toThrow('provider down')
  })
})

/* ────────────────────────── 事件提取 ────────────────────────── */

describe('eventsToSummaryEvents', () => {
  it('从 user/assistant/tool 事件提取文本；结构事件与无文本事件跳过；超长截断', () => {
    const events = [
      userMessage(1, '请修复登录'),
      turnEnd(2),
      assistantMessage(3, '已定位到会话失效'),
      toolResult(4, '测试全绿'),
      // 字符串 content 也是合法提取形状（防御分支）
      { seq: 5, type: 'user/message', data: { id: 'm5', content: '字符串形式的正文' } },
      // 只有非文本块（图片）→ 无语义文本，跳过
      { seq: 6, type: 'user/message', data: { id: 'm6', content: [{ type: 'image', data: 'xx' }] } },
      { seq: 7, type: 'user/message', data: { content: [] } },
    ]
    const result = eventsToSummaryEvents(events)
    expect(result.map((e) => [e.seq, e.type])).toEqual([
      [1, 'user/message'],
      [3, 'assistant/message'],
      [4, 'tool/result'],
      [5, 'user/message'],
    ])
    expect(result[0]!.textExcerpt).toBe('请修复登录')
  })

  it('seq 缺失或非法的事件跳过', () => {
    const result = eventsToSummaryEvents([{ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }] } }, { seq: 'bad', type: 'user/message' }])
    expect(result).toEqual([])
  })

  it('textExcerpt 截到 240 字符', () => {
    const result = eventsToSummaryEvents([userMessage(1, '长'.repeat(400))])
    expect(result[0]!.textExcerpt).toHaveLength(240)
  })
})

/* ────────────────────────── 租约摘要 ────────────────────────── */

describe('summarizeSessionViaQuery', () => {
  it('observeSession 租约→事件→摘要，成功后租约必须释放', async () => {
    const store = memStore()
    const query = fakeQuery([userMessage(1, '用户要求加导出功能'), assistantMessage(2, '已实现并测试通过')])
    const llm = fakeLlm('[事实] 会话讨论了导出功能并实现完成 (seqs: 1,2)')
    const result = await summarizeSessionViaQuery(query, store, 's-1', llm as never)
    expect(result).toMatchObject({ summarized: true, fromSeq: 1, toSeq: 2 })
    expect(query.leases[0]!.disposed).toBe(1)
    const doc = await store.readDoc('session', 's-1')
    expect(doc?.summary).toContain('导出功能')
    expect(doc?.lastSummarizedSeq).toBe(2)
  })

  it('空增量跳过：事件全部 ≤ 增量位时不开 llm，租约照样释放', async () => {
    const store = memStore()
    await store.setLastSummarizedSeq('s-1', 5)
    const query = fakeQuery([userMessage(4, '旧消息'), userMessage(5, '旧消息二')])
    const llm = fakeLlm('[事实] 不该被调用')
    const result = await summarizeSessionViaQuery(query, store, 's-1', llm as never)
    expect(result).toEqual({ skipped: 'no-new-events' })
    expect(llm.stream).not.toHaveBeenCalled()
    expect(query.leases[0]!.disposed).toBe(1)
  })

  it('只把增量位之后的事件喂给 llm', async () => {
    const store = memStore()
    await store.setLastSummarizedSeq('s-1', 3)
    const query = fakeQuery([userMessage(2, '早期'), userMessage(4, '新增需求 A'), assistantMessage(5, '已确认方案')])
    const llm = fakeLlm('[决定] 用户确认了方案 A (seqs: 4,5)')
    await summarizeSessionViaQuery(query, store, 's-1', llm as never)
    const fed = llm.calls[0]!.messages.at(-1) as { content: string }
    expect(fed.content).toContain('#4')
    expect(fed.content).toContain('#5')
    expect(fed.content).not.toContain('#2')
  })

  it('llm 失败：错误上抛但租约仍释放（finally 保证）', async () => {
    const store = memStore()
    const query = fakeQuery([userMessage(1, '内容')])
    const llm = fakeLlm(new Error('llm down'))
    await expect(summarizeSessionViaQuery(query, store, 's-1', llm as never)).rejects.toThrow('llm down')
    expect(query.leases[0]!.disposed).toBe(1)
    const doc = await store.readDoc('session', 's-1')
    expect(doc?.lastSummarizedSeq ?? 0).toBe(0)
  })

  it('observeSession 本身失败：错误上抛（无租约可释放）', async () => {
    const store = memStore()
    const query = fakeQuery(new Error('session gone'))
    const llm = fakeLlm('[事实] x')
    await expect(summarizeSessionViaQuery(query, store, 's-1', llm as never)).rejects.toThrow('session gone')
    expect(query.leases).toHaveLength(0)
  })
})

describe('maxSurfaceSeq', () => {
  it('取全部事件（含结构事件）的最大 seq；空会话返回 null；租约释放', async () => {
    const query = fakeQuery([userMessage(2, 'x'), turnEnd(7)])
    expect(await maxSurfaceSeq(query, 's-1')).toBe(7)
    expect(query.leases[0]!.disposed).toBe(1)
    const empty = fakeQuery([])
    expect(await maxSurfaceSeq(empty, 's-1')).toBeNull()
    expect(empty.leases[0]!.disposed).toBe(1)
  })
})

/* ────────────────────────── 后台队列 ────────────────────────── */

describe('BackgroundSummarizer', () => {
  function queueDeps() {
    const runs: string[] = []
    const errors: { sessionId: string; error: unknown }[] = []
    let currentMax: number | null = 10
    let runError: Error | null = null
    return {
      runs,
      errors,
      deps: {
        async maxSeq() {
          return currentMax
        },
        async run(sessionId: string) {
          runs.push(sessionId)
          if (runError !== null) throw runError
        },
        onError(sessionId: string, error: unknown) {
          errors.push({ sessionId, error })
        },
      },
      setMax(v: number | null) {
        currentMax = v
      },
      failRun(error: Error) {
        runError = error
      },
    }
  }

  it('同会话同增量位只跑一次；增量位变化后才重跑', async () => {
    const { deps, runs, setMax } = queueDeps()
    const queue = new BackgroundSummarizer(deps)
    queue.onIdle('s-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    queue.onIdle('s-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(runs).toEqual(['s-1'])
    expect(queue.scheduledThrough('s-1')).toBe(10)
    setMax(12)
    queue.onIdle('s-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(runs).toEqual(['s-1', 's-1'])
  })

  it('run 失败不抛：onError 记录，同增量位不自动重试', async () => {
    const { deps, runs, errors, failRun } = queueDeps()
    failRun(new Error('llm down'))
    const queue = new BackgroundSummarizer(deps)
    queue.onIdle('s-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    queue.onIdle('s-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(runs).toEqual(['s-1'])
    expect(errors).toEqual([{ sessionId: 's-1', error: expect.any(Error) }])
  })

  it('maxSeq 读取失败：不跑 run，onError 记录，下次 idle 可重试读取', async () => {
    let fail = true
    const runs: string[] = []
    const errors: unknown[] = []
    const queue = new BackgroundSummarizer({
      async maxSeq() {
        if (fail) throw new Error('lease failed')
        return 3
      },
      async run(sessionId) {
        runs.push(sessionId)
      },
      onError(_s, error) {
        errors.push(error)
      },
    })
    queue.onIdle('s-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(runs).toEqual([])
    expect(errors).toHaveLength(1)
    fail = false
    queue.onIdle('s-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(runs).toEqual(['s-1'])
  })

  it('空会话（maxSeq null）：直接跳过不跑', async () => {
    const { deps, runs, setMax } = queueDeps()
    setMax(null)
    const queue = new BackgroundSummarizer(deps)
    queue.onIdle('s-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(runs).toEqual([])
  })
})

/* ────────────────────────── 完成触发 ────────────────────────── */

describe('createCompletedTaskRecorder（任务完成 → 记忆）', () => {
  it('写入 project 层：key=任务标题、kind=verified-fact、sourceRefs=[taskId, result.md 相对路径]，并对任务会话跑增量摘要', async () => {
    const store = memStore()
    const query = fakeQuery([userMessage(1, '修复登录 500'), assistantMessage(2, '改了会话续期并回归通过')])
    const llm = fakeLlm('[事实] 登录 500 已修复 (seqs: 1,2)')
    const recorder = createCompletedTaskRecorder({ store, query, llm: llm as never })
    recorder({ taskId: 'T-001', title: '修复登录 500', summary: '登录接口 500 已修复：会话续期逻辑补上后回归测试全绿，遗留问题无', resultRelPath: '.router/tasks/T-001/result.md', sessionId: 's-9' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const project = await store.readDoc('project')
    expect(project?.entries).toHaveLength(1)
    expect(project?.entries[0]).toMatchObject({
      kind: COMPLETED_TASK_KIND,
      key: '修复登录 500',
      sourceRefs: ['T-001', '.router/tasks/T-001/result.md'],
    })
    expect(project?.entries[0]!.text).toContain('登录接口 500')
    expect(llm.stream).toHaveBeenCalledTimes(1)
    const session = await store.readDoc('session', 's-9')
    expect(session?.lastSummarizedSeq).toBe(2)
  })

  it('失败不抛：摘要器挂了只走 onError，appendSummary 已写成的条目保留', async () => {
    const store = memStore()
    const query = fakeQuery([userMessage(1, '内容')])
    const llm = fakeLlm(new Error('llm down'))
    const errors: { stage: string; error: unknown }[] = []
    const recorder = createCompletedTaskRecorder({ store, query, llm: llm as never, onError: (stage, error) => errors.push({ stage, error }) })
    recorder({ taskId: 'T-002', title: '低信息标题', summary: '这条结果摘要足够长所以一定会写入项目记忆层不受低信息门拦截', resultRelPath: '.router/tasks/T-002/result.md', sessionId: 's-1' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(errors).toEqual([{ stage: 'completed-task', error: expect.any(Error) }])
    const project = await store.readDoc('project')
    expect(project?.entries).toHaveLength(1)
  })

  it('无会话（sessionId 缺省）：只写 project 层，不跑摘要', async () => {
    const store = memStore()
    const query = fakeQuery([])
    const llm = fakeLlm('[事实] x')
    const recorder = createCompletedTaskRecorder({ store, query, llm: llm as never })
    recorder({ taskId: 'T-003', title: '纯汇总任务', summary: '没有绑定会话的任务完成摘要也要能落记忆层', resultRelPath: '.router/tasks/T-003/result.md' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(llm.stream).not.toHaveBeenCalled()
    expect((await store.readDoc('project'))?.entries).toHaveLength(1)
  })

  it('低信息 summary：appendSummary 拒绝写入但不抛（返回 low-info 跳过）', async () => {
    const store = memStore()
    const query = fakeQuery([])
    const llm = fakeLlm('[事实] x')
    const recorder = createCompletedTaskRecorder({ store, query, llm: llm as never })
    recorder({ taskId: 'T-004', title: '小修', summary: '太短', resultRelPath: '.router/tasks/T-004/result.md' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await store.readDoc('project'))?.entries ?? []).toHaveLength(0)
  })
})

/* ────────────────────────── 类型对齐（编译期即测） ────────────────────────── */

import type { SummaryLlm } from '../src/host/memory/summarizer.ts'

describe('adapter 与 B6 注入面的形状', () => {
  it('createSummaryLlm 的产物可赋给 SummaryLlm', () => {
    const llm: SummaryLlm = createSummaryLlm({ stream: async function* () { yield { type: 'text-delta', index: 0, text: '' } } }, () => ({ provider: 'p', model: 'm' }))
    void llm
    const events: SummaryEvent[] = eventsToSummaryEvents([])
    expect(events).toEqual([])
  })
})
