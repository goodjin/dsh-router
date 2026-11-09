import { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface EventEntry { event: { type: string; data: unknown } }
interface EventSource {
  getSnapshot(): { entries: readonly EventEntry[] }
  subscribe(listener: () => void): () => void
}
interface PreviewBinding {
  eventSource: EventSource
  session: { getSnapshot(): { openState: string } }
}
export interface PreviewSessions {
  retain(id: string, options: { source: string }): { ready: Promise<PreviewBinding>; release(): void }
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const textChunk = (value: unknown): string => {
  const chunk = record(value)
  return chunk.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : ''
}

/** 只取最新 Assistant 输出的尾部；不展示用户输入、推理或工具参数。 */
export function latestOutput(entries: readonly EventEntry[]): string {
  let tail = ''
  let attempt: unknown
  let live = false
  for (let i = entries.length - 1; i >= 0; i--) {
    const event = entries[i]!.event
    const data = record(event.data)
    if (event.type === 'assistant/live-chunk') {
      if (live && attempt !== data.attemptId) break
      live = true
      attempt = data.attemptId
      tail = (textChunk(data.chunk) + tail).slice(-800)
      if (tail.length >= 800) break
    } else if (live) break
    else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const stream = Array.isArray(data.stream) ? data.stream : []
      for (let j = stream.length - 1; j >= 0 && tail.length < 800; j--) {
        const chunk = record(stream[j])
        const text = chunk.type === 'text-chunks' && Array.isArray(chunk.texts)
          ? chunk.texts.filter((part): part is string => typeof part === 'string').join('')
          : chunk.type === 'chunk' ? textChunk(chunk.chunk) : ''
        tail = (text + tail).slice(-800)
      }
      if (!tail && event.type === 'assistant/message') {
        const content = record(data.message).content
        if (Array.isArray(content)) tail = content.filter((part) => record(part).type === 'text').map((part) => record(part).text).filter((part): part is string => typeof part === 'string').join('').slice(-800)
      }
      break
    } else if (event.type === 'turn/start' || event.type === 'step/start') break
  }
  return tail.trim()
}

/** 仅当前页可见卡片持有历史流；卸载取消订阅并释放引用，不改变主会话。 */
export function SessionPreview({ sessions, sessionId }: { sessions?: PreviewSessions; sessionId: string }) {
  const [preview, setPreview] = useState({ id: sessionId, text: '正在加载输出…' })
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    let reference: ReturnType<PreviewSessions['retain']> | undefined
    let frame: number | undefined
    const publish = (text: string) => { if (active) setPreview({ id: sessionId, text }) }
    publish('正在加载输出…')
    try {
      if (!sessions) throw new Error('会话服务不可用')
      reference = sessions.retain(sessionId, { source: 'router-preview' })
      void reference.ready.then((binding) => {
        if (!active) return
        if (binding.session.getSnapshot().openState === 'error') { publish('输出加载失败'); return }
        const read = () => publish(latestOutput(binding.eventSource.getSnapshot().entries) || '暂无文字输出')
        unsubscribe = binding.eventSource.subscribe(() => {
          if (frame !== undefined) return
          frame = requestAnimationFrame(() => { frame = undefined; if (active) read() })
        })
        read()
      }).catch(() => publish('输出加载失败'))
    } catch { publish('输出预览暂不可用') }
    return () => {
      active = false
      if (frame !== undefined) cancelAnimationFrame(frame)
      unsubscribe?.()
      reference?.release()
    }
  }, [sessions, sessionId])
  const text = preview.id === sessionId ? preview.text : '正在加载输出…'
  useLayoutEffect(() => { if (element.current) element.current.scrollTop = element.current.scrollHeight }, [text])
  return <div ref={element} data-session-output={sessionId} style={{ maxHeight: '4.5em', minHeight: 0, overflow: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>{text}</div>
}
