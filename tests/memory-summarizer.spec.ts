/**
 * 增量会话摘要测试：buildSummaryPrompt 纯函数 + summarizeIncremental 注入式 llm。
 *
 * 覆盖（Task B6 清单）：空增量跳过、标记词渲染（[决定]/[建议]/[事实]、来源 seq、
 * ≤200 字/条、不写代码块）、只喂增量位之后的事件、成功后写摘要并推进增量位、
 * llm 失败/空白不推进增量位、此前摘要与会话标题取自文档。
 */

import { describe, expect, it } from 'vitest'
import { makeMemFs } from './helpers/mem-fs.ts'
import { MemoryDocStore } from '../src/host/memory/store.ts'
import { buildSummaryPrompt, summarizeIncremental } from '../src/host/memory/summarizer.ts'
import type { SummaryLlm } from '../src/host/memory/summarizer.ts'

interface StreamCall {
  messages: unknown[]
  signal: AbortSignal
}

function fakeLlm(reply: string, calls: StreamCall[] = []): SummaryLlm {
  return {
    async stream(messages, signal) {
      calls.push({ messages, signal })
      return reply
    },
  }
}

function userTextOf(call: StreamCall | undefined): string {
  const message = call?.messages[1] as { role: string; content: string } | undefined
  return message?.content ?? ''
}

describe('buildSummaryPrompt', () => {
  it('提示词要求中文条目化摘要：三类标记、来源 seq、每条 ≤200 字、不写代码块', () => {
    const { messages } = buildSummaryPrompt({
      sessionTitle: '修复登录',
      events: [
        { seq: 3, type: 'user', textExcerpt: '用户要求支持手机号登录' },
        { seq: 4, type: 'tool', textExcerpt: '工具返回 200' },
      ],
      previousSummary: '此前：讨论过登录方式。',
    })
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    const system = messages[0]?.content ?? ''
    for (const word of ['中文', '[决定]', '[建议]', '[事实]', '(seqs:', '200', '代码块']) {
      expect(system).toContain(word)
    }
    expect(messages[1]?.role).toBe('user')
    const user = messages[1]?.content ?? ''
    expect(user).toContain('修复登录')
    expect(user).toContain('讨论过登录方式。')
    expect(user).toContain('#3 [user] 用户要求支持手机号登录')
    expect(user).toContain('#4 [tool] 工具返回 200')
  })
})

describe('summarizeIncremental', () => {
  it('空增量：增量位之后没有事件 → skipped=no-new-events，不调用 llm、不推进增量位', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    await store.setLastSummarizedSeq('s1', 5)
    const calls: StreamCall[] = []
    const result = await summarizeIncremental(
      store,
      's1',
      [
        { seq: 3, type: 'user', textExcerpt: '已经总结过的旧事件一' },
        { seq: 5, type: 'user', textExcerpt: '增量位边界上的事件' },
      ],
      fakeLlm('[事实] 不该被调用。', calls),
    )
    expect(result).toEqual({ skipped: 'no-new-events' })
    expect(calls).toHaveLength(0)
    expect((await store.readDoc('session', 's1'))?.lastSummarizedSeq).toBe(5)
  })

  it('增量总结：只喂增量位之后的事件（seq 升序），成功后写摘要节并推进增量位', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    await store.setLastSummarizedSeq('s1', 2)
    const calls: StreamCall[] = []
    const reply = '[决定] 登录改用手机号。(seqs: 3)\n[事实] 接口返回 200。(seqs: 4)'
    const controller = new AbortController()
    const result = await summarizeIncremental(
      store,
      's1',
      [
        { seq: 1, type: 'user', textExcerpt: '已总结过的旧事件甲' },
        { seq: 2, type: 'tool', textExcerpt: '已总结过的旧事件乙' },
        { seq: 4, type: 'tool', textExcerpt: '接口返回 200' },
        { seq: 3, type: 'user', textExcerpt: '用户要求手机号登录' },
      ],
      fakeLlm(reply, calls),
      { signal: controller.signal },
    )
    expect(result).toEqual({ summarized: true, fromSeq: 3, toSeq: 4 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.signal).toBe(controller.signal)
    const user = userTextOf(calls[0])
    expect(user).not.toContain('已总结过的旧事件甲')
    expect(user).not.toContain('已总结过的旧事件乙')
    expect(user.indexOf('#3 [user] 用户要求手机号登录')).toBeGreaterThanOrEqual(0)
    expect(user.indexOf('#3')).toBeLessThan(user.indexOf('#4'))
    const doc = await store.readDoc('session', 's1')
    expect(doc?.summary).toBe(reply)
    expect(doc?.lastSummarizedSeq).toBe(4)
  })

  it('llm 抛错：异常向上传播，增量位与摘要保持原样（下次重试不丢事件）', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    await store.setLastSummarizedSeq('s1', 2)
    const llm: SummaryLlm = {
      async stream() {
        throw new Error('llm down')
      },
    }
    await expect(
      summarizeIncremental(store, 's1', [{ seq: 3, type: 'user', textExcerpt: '新事件内容足够长' }], llm),
    ).rejects.toThrow('llm down')
    const doc = await store.readDoc('session', 's1')
    expect(doc?.lastSummarizedSeq).toBe(2)
    expect(doc?.summary).toBeUndefined()
  })

  it('llm 返回空白：视为失败抛错，不推进增量位', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    await store.setLastSummarizedSeq('s1', 2)
    await expect(
      summarizeIncremental(store, 's1', [{ seq: 3, type: 'user', textExcerpt: '新事件内容足够长' }], fakeLlm('  \n ')),
    ).rejects.toThrow('空白')
    expect((await store.readDoc('session', 's1'))?.lastSummarizedSeq).toBe(2)
  })

  it('此前摘要与会话标题取自文档（摘要节 / 头部 title），一起喂进提示词', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    await store.setSessionTitle('s1', '修复登录')
    await store.setSessionSummary('s1', '此前：讨论过登录方式。')
    await store.setLastSummarizedSeq('s1', 2)
    const calls: StreamCall[] = []
    await summarizeIncremental(
      store,
      's1',
      [{ seq: 3, type: 'user', textExcerpt: '用户拍板用短信验证码' }],
      fakeLlm('[决定] 验证码用短信。(seqs: 3)', calls),
    )
    const user = userTextOf(calls[0])
    expect(user).toContain('修复登录')
    expect(user).toContain('讨论过登录方式。')
    expect(user).toContain('用户拍板用短信验证码')
  })

  it('会话文档不存在：按增量位 0 起步，全部事件都喂入并落盘', async () => {
    const { fs } = makeMemFs()
    const store = new MemoryDocStore('/mem-root', fs)
    const calls: StreamCall[] = []
    const result = await summarizeIncremental(
      store,
      'fresh',
      [
        { seq: 1, type: 'user', textExcerpt: '第一条用户需求' },
        { seq: 2, type: 'tool', textExcerpt: '工具确认完成' },
      ],
      fakeLlm('[事实] 需求已完成。(seqs: 1,2)', calls),
    )
    expect(result).toEqual({ summarized: true, fromSeq: 1, toSeq: 2 })
    expect(calls).toHaveLength(1)
    const user = userTextOf(calls[0])
    expect(user).toContain('第一条用户需求')
    expect(user).toContain('工具确认完成')
    const doc = await store.readDoc('session', 'fresh')
    expect(doc?.lastSummarizedSeq).toBe(2)
    expect(doc?.summary).toBe('[事实] 需求已完成。(seqs: 1,2)')
  })
})
