/**
 * 会话输出尾部提取（宿主侧）。
 *
 * v1.5：浮窗预览不再把整条会话事件流留在浏览器（一次几 MB），改成宿主按需取
 * 一段有界尾部。这里锁定取数口径：只取助手输出、只取最后一段、超长保留尾部。
 */

import { describe, expect, it } from 'vitest'

import { extractLatestOutput, SESSION_TAIL_MAX_CHARS } from '../src/host/session/tail.ts'

const message = (text: string) => ({
  seq: 1,
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
})

describe('extractLatestOutput：会话输出尾部', () => {
  it('取最后一条带文字的助手消息', () => {
    expect(extractLatestOutput([message('旧输出'), message('新输出')])).toBe('新输出')
  })

  it('assistant/attempt 的 stream 文本块也算助手输出', () => {
    const attempt = {
      seq: 2,
      type: 'assistant/attempt',
      data: { stream: [{ type: 'text-chunks', texts: ['第一段', '第二段'] }] },
    }
    expect(extractLatestOutput([attempt])).toBe('第一段第二段')
  })

  it('用户输入、工具事件与空助手消息都不作预览内容', () => {
    const events = [
      { seq: 1, type: 'user/message', data: { text: '用户输入' } },
      { seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'text', text: '工具输出' }] } } },
      { seq: 3, type: 'assistant/message', data: { message: { content: [] } } },
    ]
    expect(extractLatestOutput(events)).toBe('')
  })

  it('超长时保留尾部（最新的一段）', () => {
    const long = 'x'.repeat(SESSION_TAIL_MAX_CHARS + 100)
    const tail = extractLatestOutput([message(long)])
    expect(tail).toHaveLength(SESSION_TAIL_MAX_CHARS)
    expect(tail.endsWith('x'.repeat(10))).toBe(true)
  })

  it('空事件列表回空串', () => {
    expect(extractLatestOutput([])).toBe('')
  })
})
