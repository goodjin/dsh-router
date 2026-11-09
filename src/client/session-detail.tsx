import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode, CSSProperties } from 'react'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

export const SESSION_DETAIL_SLOT = 'router.session-window.detail'
export interface RetainedSession {
  ready: Promise<unknown>
  release(): void
}
export interface DetailRuntime {
  retainSession?(id: string): RetainedSession
  SessionProvider?: ComponentType<{ session: RetainedSession; children?: ReactNode }>
  renderSlot?(name: string, props: object): ReactNode
}

/** 由宿主 session scope 绑定，工厂拥有自己的会话内容及输入草稿。 */
export function SessionDetailContent(props: PropsRenderFactories): ReactNode {
  return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, {
    fallback: <p role="alert">宿主会话组件尚未就绪</p>,
  })
}

export function detailBounds(rect: { left: number; top: number; width: number; height: number }, width: number, height: number): CSSProperties {
  const left = Math.max(8, rect.left + 8)
  const top = Math.max(8, rect.top + 8)
  return { position: 'fixed', left, top, width: Math.max(0, Math.min(rect.width - 16, width - left - 8)), height: Math.max(0, Math.min(760, rect.height - 16, height - top - 8)) }
}

/** 只 retain 选中会话；收起保留实例，切换/关闭释放引用。 */
export function SessionDetail(props: DetailRuntime & {
  sessionId: string; title: string; collapsed: boolean
  onClose(): void; onToggle(): void
  scrollPositions: Map<string, number>
  children?: ReactNode
}): ReactNode {
  const [binding, setBinding] = useState<{ id: string; reference?: RetainedSession; error?: string }>()
  const [bounds, setBounds] = useState<CSSProperties>()
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    let reference: RetainedSession | undefined
    try {
      reference = props.retainSession?.(props.sessionId)
      if (!reference) throw new Error('宿主会话引用服务不可用')
      const retained = reference
      void retained.ready.then(() => { if (live) setBinding({ id: props.sessionId, reference: retained }) }, (error: unknown) => {
        if (live) setBinding({ id: props.sessionId, error: String(error) })
      })
    } catch (error) { setBinding({ id: props.sessionId, error: String(error) }) }
    return () => { live = false; reference?.release() }
  }, [props.sessionId, props.retainSession])
  useLayoutEffect(() => {
    let main: HTMLElement | undefined
    const measure = () => {
      const candidate = [...document.querySelectorAll<HTMLElement>('[data-conversation-content]')].find((node) => !node.closest('[data-router-session-detail]'))
      if (candidate !== main) {
        if (main) resize?.unobserve(main)
        main = candidate
        if (main) resize?.observe(main)
      }
      if (main) setBounds(detailBounds(main.getBoundingClientRect(), window.innerWidth, window.innerHeight))
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    const mounts = new MutationObserver(measure)
    mounts.observe(document.body, { childList: true, subtree: true })
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { resize?.disconnect(); mounts.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [])
  useLayoutEffect(() => {
    const node = root.current
    if (!node || binding?.id !== props.sessionId || !binding.reference) return
    const restore = () => {
      const scroll = node.querySelector<HTMLElement>('[data-conversation-scroll]')
      if (!scroll) return false
      scroll.scrollTop = props.scrollPositions.get(props.sessionId) ?? 0
      return true
    }
    if (restore()) return
    const observer = new MutationObserver(() => { if (restore()) observer.disconnect() })
    observer.observe(node, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [binding, props.sessionId, props.scrollPositions])
  const Provider = props.SessionProvider
  const ready = binding?.id === props.sessionId ? binding : undefined
  return <div ref={root} data-router-session-detail={props.sessionId} role="dialog" aria-label={`会话详情：${props.title}`}
    style={{ ...bounds, ...(props.collapsed ? { height: 'auto' } : {}), zIndex: 50, background: '#fff', color: '#1f2328', border: '1px solid #d8dbe0', borderRadius: 10, boxShadow: '0 8px 24px #0002', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}
    onScrollCapture={(event) => {
      const target = event.target as HTMLElement
      if (target.hasAttribute('data-conversation-scroll')) props.scrollPositions.set(props.sessionId, target.scrollTop)
    }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 8, flexShrink: 0 }}>
      <strong style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{props.title}</strong>
      <button type="button" onClick={props.onToggle}>{props.collapsed ? '展开详情' : '收起详情'}</button>
      <button type="button" onClick={props.onClose}>关闭详情</button>
    </div>
    <div hidden={props.collapsed} style={{ display: props.collapsed ? 'none' : 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' }}>
      {!bounds ? <p role="alert">主会话区域尚未就绪</p> : ready?.error ? <p role="alert">{ready.error}</p> : !Provider || !props.renderSlot ? <p role="alert">宿主会话渲染接口不可用</p> : ready?.reference
        ? <Provider session={ready.reference}>{props.renderSlot(SESSION_DETAIL_SLOT, {})}</Provider>
        : <p>正在加载会话内容…</p>}
      {props.children}
    </div>
  </div>
}
