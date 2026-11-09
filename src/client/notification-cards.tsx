/**
 * Router 待处理浮窗：问题与完成/异常通知共用右侧队列，初始最多 3 个真实派发会话，每次展开更多追加 3 个。
 * 按派发来源隔离 Router，仅 Router 主会话显示队列；派发及普通会话不显示。
 * 卡片状态在批次之外保留，收起/翻页不触发提交或确认。
 */

import { useSyncExternalStore } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { SessionPreview, type PreviewSessions } from './session-preview.tsx'
import type { RouterApi } from './api.ts'
import {
  actionAvailable,
  cardActionPlan,
  cardSessionTarget,
  emptyNotifications,
  notificationAckFailed,
  notificationAckStarted,
  notificationAckSucceeded,
  notificationActionFailed,
  notificationActionStarted,
  notificationActionSucceeded,
  syncedNotifications,
} from './notification-model.ts'
import type { NotificationBoard } from './notification-model.ts'
import type { NotificationActionKind } from '../shared/view-contract.ts'
import { type WorkbenchStore } from './workbench-store.ts'
import { NOTIFICATION_OVERLAY_ID, NOTIFICATION_OVERLAY_ORDER, NOTIFICATION_OVERLAY_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'
import type { ClientPrefsStore } from './client-prefs.ts'
import { OVERLAY_BATCH_SIZE, overlayRouterSession, taskRouterSession, OVERLAY_STACK_STYLE, OVERLAY_CARD_SIZE } from './overlay-queue.ts'
import { dispatchedSessionWindows, sessionWindowStatus, SESSION_WINDOW_ANIMATIONS } from './session-windows.ts'
import { LightTooltip, useHoverDarken } from './ui-kit.tsx'

/** 组件的业务输入（registration 的 inject 工厂给的 face；组件绝不收 ctx）。 */
export interface NotificationOverlayFace {
  sessions?: PreviewSessions
  store: WorkbenchStore
  api: RouterApi
  prefs: ClientPrefsStore
  uiWorkspace: { openSession(target: string): void }
}

export type NotificationOverlayProps = NotificationOverlayFace

/** 把通知浮窗注册进 shell.overlay。键名/id 见 surface-ids.ts（entry.spec 断言用）。 */
export function registerNotificationCards(slots: SlotsHost, face: NotificationOverlayFace): void {
  slots.inject(NOTIFICATION_OVERLAY_SLOT, () => slots.register(
    { name: NOTIFICATION_OVERLAY_SLOT, id: NOTIFICATION_OVERLAY_ID, order: NOTIFICATION_OVERLAY_ORDER, inject: () => face },
    NotificationOverlay,
  ))
}

const CARD_STYLE: CSSProperties = {
  ...OVERLAY_CARD_SIZE,
  pointerEvents: 'auto',
  background: '#ffffff',
  color: '#1f2328',
  border: '1px solid #d8dbe0',
  borderRadius: 10,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.14)',
  padding: 10,
  fontSize: 13,
  lineHeight: 1.5,
}

// 会话小窗统一占当前视口高度的 1/5；内容多少不改变外框大小。
const SESSION_WINDOW_STYLE: CSSProperties = {
  ...CARD_STYLE,
  width: '100%',
  height: '20dvh',
  maxHeight: '20dvh',
  display: 'flex', flexDirection: 'column', gap: 3,
  overflow: 'hidden',
}

const ACTION_BUTTON_STYLE: CSSProperties = {
  border: '1px solid #d8dbe0',
  borderRadius: 6,
  background: 'transparent',
  color: '#1f2328',
  padding: '3px 8px',
  fontSize: 12,
  cursor: 'pointer',
}

const MUTED_STYLE: CSSProperties = { opacity: 0.55 }

function kindLabel(kind: 'completion' | 'anomaly'): string {
  return kind === 'completion' ? '任务完成' : '异常'
}

export function NotificationOverlay(props: NotificationOverlayProps): ReactNode {
  const workbench = useSyncExternalStore(props.store.subscribe, props.store.get)
  const state = workbench.routerState
  const prefs = useSyncExternalStore(props.prefs.subscribe, props.prefs.get)
  const scope = overlayRouterSession(state, workbench.currentSessionId)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const hideSession = (id: string): void => {
    setHiddenIds((current) => new Set([...current, id]))
  }
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [collapsedScopes, setCollapsedScopes] = useState<Record<string, boolean>>({})
  const [actionDarken, actionBind] = useHoverDarken()
  const [board, setBoard] = useState<NotificationBoard>(emptyNotifications)
  // boardRef 与 board 同步：副作用（导航/POST）必须放在 setState 更新器之外——
  // StrictMode 会双调用更新器探纯，更新器里发 POST 会重复提交。所有写经 commitBoard
  // 同步推进 ref，runAction 读 ref 取最新板并做幂等门（已在提交中即返回）。
  const boardRef = useRef(board)
  const commitBoard = useCallback((next: NotificationBoard): void => {
    boardRef.current = next
    setBoard(next)
  }, [])

  // 轮询合流：服务端通知进板，本地 UI 状态（提交中/展开）跨轮询保持。
  useEffect(() => {
    if (state !== null) commitBoard(syncedNotifications(boardRef.current, state.notifications ?? []))
  }, [state, commitBoard])

  const runAction = useCallback((cardId: string, action: NotificationActionKind): void => {
    const current = boardRef.current
    const entry = current.cards.find((item) => item.card.cardId === cardId)
    if (entry === undefined) return
    const target = cardSessionTarget(entry.card.taskId, workbench.routerState?.tasks ?? [], workbench.routerState?.tabs ?? [])
    if (action === 'ack') { if (target) hideSession(target); return }
    const plan = cardActionPlan(entry.card, action, cardSessionTarget(entry.card.taskId, workbench.routerState?.tasks ?? [], workbench.routerState?.tabs ?? []))
    if (plan.type === 'open-session') {
      props.uiWorkspace.openSession(plan.sessionId)
      return
    }
    if (plan.type === 'disabled') return
    const started = notificationActionStarted(current, cardId)
    if (started === current) return // 已在提交中：幂等，不重发
    commitBoard(started)
    void (async () => {
      try {
        const request = plan.request
        if (request.channel === 'control') {
          await props.api.controlTask(request.taskId, request.action)
        } else if (request.channel === 'unfreeze') {
          await props.api.unfreezeBreaker()
        } else {
          await props.api.ackNotification(request.cardId)
          commitBoard(notificationAckSucceeded(boardRef.current, cardId))
          return
        }
        // 动作成功 → 补确认 → 消失。
        commitBoard(notificationAckStarted(notificationActionSucceeded(boardRef.current, cardId), cardId))
        try {
          await props.api.ackNotification(cardId)
          commitBoard(notificationAckSucceeded(boardRef.current, cardId))
        } catch {
          commitBoard(notificationAckFailed(boardRef.current, cardId, '确认发送失败，可重试补确认'))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        commitBoard(notificationActionFailed(boardRef.current, cardId, message))
      }
    })()
  }, [props, workbench.routerState, commitBoard, scope])

  // 门控必须放在所有 hooks 之后——早退若插在 hooks 之间，会话切换时 hook 数量
  // 变化会触发 "Rendered more hooks" 崩溃。仅 Router 主会话显示其归属队列。
  if (scope === undefined) return null
  if (state === null) return null

  const ownQuestions = prefs.overlayEnabled ? workbench.board.cards.filter((entry) =>
    taskRouterSession(state, entry.card.taskId) === scope || entry.card.sessionId === scope) : []
  const ownNotifications = board.cards.filter((entry) => !entry.card.ack &&
    (entry.card.taskId === undefined || taskRouterSession(state, entry.card.taskId) === scope))
  const sessions = dispatchedSessionWindows(state, scope)
  const visible = sessions.filter((row) => !hiddenIds.has(row.sessionId))
  const limit = limits[scope] ?? OVERLAY_BATCH_SIZE
  const items = visible.slice(0, limit)
  const collapsed = collapsedScopes[scope] ?? false
  return (
    <div data-router-overlay-queue style={OVERLAY_STACK_STYLE}>
      <style>{SESSION_WINDOW_ANIMATIONS}</style>
      <button type="button" aria-expanded={!collapsed} data-overlay-toggle
        aria-label={collapsed ? '展开派发会话' : '收起派发会话'}
        title={collapsed ? '展开派发会话' : '收起派发会话'}
        style={{ ...ACTION_BUTTON_STYLE, alignSelf: 'flex-end', display: 'flex', padding: 6 }}
        onClick={() => {
          setCollapsedScopes((current) => ({ ...current, [scope]: !collapsed }))
          setLimits((current) => ({ ...current, [scope]: OVERLAY_BATCH_SIZE }))
          if (collapsed) setHiddenIds((current) => {
            const next = new Set(current)
            sessions.forEach((row) => next.delete(row.sessionId))
            return next
          })
        }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d={collapsed ? 'm6 9 6 6 6-6' : 'm6 15 6-6 6 6'} />
        </svg>
      </button>
      {!collapsed && <>
      {items.length === 0 && <p>暂无可见派发会话</p>}
      {items.map((row) => {
        const questions = ownQuestions.filter((entry) => entry.card.sessionId === row.sessionId)
        const notifications = ownNotifications.filter((entry) => row.tasks.some((task) => task.taskId === entry.card.taskId))
        const status = sessionWindowStatus(row, questions.length > 0)
        return <section key={row.sessionId} data-router-session-window={row.sessionId} style={SESSION_WINDOW_STYLE}>
          <button type="button" data-open-session={row.sessionId} onClick={() => props.uiWorkspace.openSession(row.sessionId)}
            title={row.title} style={{ ...ACTION_BUTTON_STYLE, flexShrink: 0, padding: 0, border: 0, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <strong>{row.title}</strong>
          </button>
          <div data-session-status-line style={{ flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span data-router-session-status={status.kind} aria-hidden>{status.icon}</span> {status.label}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
            <SessionPreview sessionId={row.sessionId} sessions={props.sessions} />
            {notifications.filter((entry) => entry.error).map((entry) => <div key={entry.card.cardId} role="alert">{entry.error}</div>)}
          </div>
          <div data-session-button-row style={{ display: 'flex', flexShrink: 0, gap: 6, overflowX: 'auto', whiteSpace: 'nowrap' }}>
          {notifications.map((entry) => <div key={entry.card.cardId} data-notification-card={entry.card.cardId} title={`[${kindLabel(entry.card.kind)}] ${entry.card.summary}`} style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {entry.card.actions.map((action) => {
                const availability = actionAvailable(entry.card, action.action, row.sessionId, entry.actionApplied === true)
                return <LightTooltip key={action.action} label={action.action === 'ack' ? '只隐藏此会话，不确认、不取消任务' : availability.reason ?? action.label}>
                  <button type="button" style={{ ...ACTION_BUTTON_STYLE, ...(availability.available ? actionDarken : MUTED_STYLE) }}
                    {...(availability.available ? actionBind : {})}
                    disabled={!availability.available || entry.phase === 'submitting' || entry.phase === 'acking'}
                    data-notification-action={`${entry.card.cardId}:${action.action}`}
                    onClick={() => runAction(entry.card.cardId, action.action)}>{action.action === 'ack' ? '隐藏' : action.label}</button>
                </LightTooltip>
              })}
          </div>)}
          {!notifications.some((entry) => entry.card.actions.some((action) => action.action === 'ack')) &&
            <button type="button" data-hide-session={row.sessionId} style={ACTION_BUTTON_STYLE} onClick={() => hideSession(row.sessionId)}>隐藏</button>}
          </div>
        </section>
      })}
      {visible.length > items.length && <button type="button" data-overlay-more style={ACTION_BUTTON_STYLE}
        onClick={() => setLimits((current) => ({ ...current, [scope]: limit + OVERLAY_BATCH_SIZE }))}>
        展开更多
      </button>}
      </>}
    </div>
  )
}
