/**
 * 会话输出尾部提取（宿主侧）。
 *
 * 为什么搬到宿主：浏览器侧原先把**整条**会话事件流 retain 进内存（一次几 MB），
 * 只为了在浮窗里显示几百字的预览——打开 Router 会话那一刻的卡顿就来自这里。
 * 改成宿主按需读尾部、只回一段有界文字，浏览器不再留驻会话流。
 *
 * 取数只用 surface 事件（宿主会话观察租约给的就是它）：从尾部往前找最后一条
 * 带文字的助手事件（assistant/message 或 assistant/attempt），取其文字并保留
 * **尾部**（最新的一段）；用户输入、推理、工具参数一律不取。
 */

/** 回给客户端的尾部上限（字符）。超长时保留尾部（最新的一段）。 */
export const SESSION_TAIL_MAX_CHARS = 1200

type RecordLike = Record<string, unknown>

function asRecord(value: unknown): RecordLike {
  return typeof value === 'object' && value !== null ? (value as RecordLike) : {}
}

/** 事件类型名（非字符串按空处理）。 */
function eventTypeOf(event: unknown): string {
  const type = asRecord(event).type
  return typeof type === 'string' ? type : ''
}

/**
 * 一条助手事件里的文字。
 *
 * - assistant/message：data.message.content 是字符串或文本块数组；
 * - assistant/attempt：data.stream 里的 text-chunks / text-delta。
 */
function assistantTextOf(event: unknown): string {
  const data = asRecord(asRecord(event).data)
  const message = asRecord(data.message)
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const record = asRecord(block)
        return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
      })
      .filter((text) => text !== '')
      .join(' ')
  }
  const stream = data.stream
  if (Array.isArray(stream)) {
    const parts: string[] = []
    for (const entry of stream) {
      const record = asRecord(entry)
      if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
        for (const text of record.texts) if (typeof text === 'string') parts.push(text)
      } else if (record.type === 'chunk') {
        const chunk = asRecord(record.chunk)
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
      }
    }
    return parts.join('')
  }
  return ''
}

/**
 * 最后一段助手输出（尾部有界）；没有助手文字时返回空串。
 *
 * 只认助手事件：用户输入、工具调用、推理都不作为预览内容。
 */
export function extractLatestOutput(events: readonly unknown[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = eventTypeOf(events[index])
    if (type !== 'assistant/message' && type !== 'assistant/attempt') continue
    const text = assistantTextOf(events[index]).trim()
    if (text === '') continue
    return text.length > SESSION_TAIL_MAX_CHARS ? text.slice(-SESSION_TAIL_MAX_CHARS) : text
  }
  return ''
}
