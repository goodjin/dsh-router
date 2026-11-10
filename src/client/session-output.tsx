/**
 * 浮窗里的「最新输出」：只显示一段尾部文字。
 *
 * v1.5 之前的做法是把**整条**会话事件流 retain 进浏览器（一次几 MB），只为
 * 在浮窗里显示几百字——打开 Router 会话那一刻的卡顿就来自这里。现在改成：
 * - 已结束的会话：直接显示账本里的结果摘要（零请求、零读盘）；
 * - 正在跑的会话：按需向宿主要一段有界的尾部文字（跟着状态轮询的节奏刷新）。
 *
 * 组件不再持有会话订阅：卸载即释放，没有残留的监听器。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { RouterApi } from './api.ts'

/** 组件的业务输入（registration 的 inject 工厂给的 face；组件绝不收 ctx）。 */
export interface SessionOutputProps {
  api: RouterApi
  /** 会话 id（宿主侧按它取尾部）。 */
  sessionId: string
  /** 该会话是否在跑：只有运行中的才去取实时尾部。 */
  running: boolean
  /** 已结束任务的账本摘要（非运行中时直接显示，不发请求）。 */
  summary?: string
  /** 刷新触发：宿主状态每轮轮询换新对象 → 到点重新取一次尾部。 */
  refreshKey?: unknown
}

/** 容器样式：固定高度、只显示尾部、滚动贴底。 */
const CONTAINER_STYLE = {
  maxHeight: '4.5em',
  minHeight: 0,
  overflow: 'hidden',
  whiteSpace: 'pre-wrap' as const,
  overflowWrap: 'anywhere' as const,
  lineHeight: 1.5,
}

/** 会话输出预览（运行中取尾部，已结束用摘要）。 */
export function SessionOutput(props: SessionOutputProps): ReactNode {
  const { api, sessionId, running, summary, refreshKey } = props
  const [text, setText] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!running) {
      setText(undefined)
      return
    }
    let active = true
    void api.getSessionOutput(sessionId).then(
      (value) => { if (active) setText(value.text === '' ? undefined : value.text) },
      () => { if (active) setText(undefined) },
    )
    return () => { active = false }
  }, [api, sessionId, running, refreshKey])
  const shown = running
    ? (text ?? '正在取最新输出…')
    : (summary ?? '暂无文字输出')
  return <div data-session-output={sessionId} style={CONTAINER_STYLE}>{shown}</div>
}
