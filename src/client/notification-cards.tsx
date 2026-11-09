/**
 * Router 待处理浮窗：问题与完成/异常通知共用右侧队列，每页最多 3 个真实派发会话。
 * 按派发来源隔离 Router，仅 Router 主会话显示队列；派发及普通会话不显示。
 * 卡片状态在批次之外保留，收起/翻页不触发提交或确认。
 */

import { useSyncExternalStore } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { RouterApi } from './api.ts'
import {
  actionAvailable,
  breakerFrozen,
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
import { isRouterSessionView, type WorkbenchStore } from './workbench-store.ts'
import { NOTIFICATION_OVERLAY_ID, NOTIFICATION_OVERLAY_ORDER, NOTIFICATION_OVERLAY_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'
import type { ClientPrefsStore } from './client-prefs.ts'
import { overlayBatch, overlayRouterSession, taskRouterSession, OVERLAY_STACK_STYLE, OVERLAY_CARD_SIZE } from './overlay-queue.ts'
import { dispatchedSessionWindows, sessionWindowStatus, SESSION_WINDOW_ANIMATIONS } from './session-windows.ts'
import { LightTooltip, useHoverDarken } from './ui-kit.tsx'

/** 组件的业务输入（registration 的 inject 工厂给的 face；组件绝不收 ctx）。 */
export interface NotificationOverlayFace {
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
}

const ANOMALY_BORDER: CSSProperties = {
  borderColor: 'var(--dsh-color-warning, #b8860b)',
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
  const [showHidden, setShowHidden] = useState(false)
  const hideSession = (id: string): void => {
    setHiddenIds((current) => new Set([...current, id]))
  }
  const [pages, setPages] = useState<Record<string, number>>({})
  const [collapsedScopes, setCollapsedScopes] = useState<Record<string, boolean>>({})
  const [emergencyDarken, emergencyBind] = useHoverDarken()
  const [actionDarken, actionBind] = useHoverDarken()
  const [board, setBoard] = useState<NotificationBoard>(emptyNotifications)
  const [pauseResults, setPauseResults] = useState<Record<string, string>>({})
  const pauseResult = scope === undefined ? undefined : pauseResults[scope]
  const setPauseResult = (message: string): void => {
    if (scope !== undefined) setPauseResults((current) => ({ ...current, [scope]: message }))
  }
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
  // 按钮恒驻在通知列顶部（不再是「有卡才出现」）：用户被冻结锁死时恰恰最需要
  // 「解除冻结/紧急暂停」按钮，没卡也要渲染。故只按 state 门控，不按卡数门控。
  if (state === null) return null

  const { tasks: stateTasks, tabs: stateTabs } = state
  // v1.4：冻结态读宿主的真实熔断投影（不再从通知卡推断——那种推断恒为 false，
  // 于是「解除冻结」按钮永远不出现，用户被冻结锁死）。
  const frozen = breakerFrozen(state)
  // 作用域暂停的锚点 = 当前 Router 会话（浮窗只在 Router 会话视图展示，
  // 那里 currentSessionId 就是那个 Router 会话 id）。
  const routerSessionId = props.store.get().currentSessionId

  const ownQuestions = prefs.overlayEnabled ? workbench.board.cards.filter((entry) =>
    taskRouterSession(state, entry.card.taskId) === scope || entry.card.sessionId === scope) : []
  const ownNotifications = board.cards.filter((entry) => !entry.card.ack &&
    (entry.card.taskId === undefined || taskRouterSession(state, entry.card.taskId) === scope))
  const sessions = dispatchedSessionWindows(state, scope)
  const hidden = sessions.filter((row) => hiddenIds.has(row.sessionId))
  const visible = sessions.filter((row) => !hiddenIds.has(row.sessionId))
  const pageKey = `${scope}:${showHidden ? 'hidden' : 'visible'}`
  const listed = showHidden ? hidden : visible
  const batch = overlayBatch(listed, pages[pageKey] ?? 0)
  const collapsed = collapsedScopes[scope] ?? false
  return (
    <div data-router-overlay-queue style={OVERLAY_STACK_STYLE}>
      <style>{SESSION_WINDOW_ANIMATIONS}</style>
      <button type="button" aria-expanded={!collapsed} data-overlay-toggle
        style={ACTION_BUTTON_STYLE}
        onClick={() => setCollapsedScopes((current) => ({ ...current, [scope]: !collapsed }))}>
        {collapsed ? '展开' : '收起'}派发会话（{sessions.length}）
      </button>
      {!collapsed && <>
      <div data-overlay-pagination style={{ ...CARD_STYLE, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <span>第 {batch.page + 1}/{batch.pages} 页 · 共 {listed.length} 个{showHidden ? '已隐藏' : ''}会话</span>
        <button type="button" disabled={batch.page === 0} onClick={() => setPages((current) => ({ ...current, [pageKey]: batch.page - 1 }))}>上一页</button>
        <button type="button" disabled={batch.page + 1 >= batch.pages} onClick={() => setPages((current) => ({ ...current, [pageKey]: batch.page + 1 }))}>下一页</button>
      </div>
      {pauseResult !== undefined ? (
        <div style={{ ...CARD_STYLE, ...ANOMALY_BORDER }} data-notification-pause-result>{pauseResult}</div>
      ) : null}
      {isRouterSessionView(workbench) && <LightTooltip label="只暂停当前 Router 派出的任务及其下游子任务；不影响别的 Router，也不冻结派发">
        <button
          type="button"
          style={{ ...ACTION_BUTTON_STYLE, ...emergencyDarken, fontWeight: 600 }}
          {...emergencyBind}
          data-notification-emergency="pause"
          disabled={routerSessionId === undefined}
          onClick={() => {
            if (routerSessionId === undefined) {
              setPauseResult('暂停失败：当前不在 Router 会话视图，无法确定要暂停哪个 Router 的任务')
              return
            }
            void (async () => {
              try {
                const report = await props.api.emergencyPause(routerSessionId)
                setPauseResult(report.failedCount > 0
                  ? `已暂停 ${report.pausedCount} 个任务，${report.failedCount} 个未完全停下（见任务卡）`
                  : `已暂停 ${report.pausedCount} 个任务`)
              } catch (error) {
                setPauseResult(`暂停失败：${error instanceof Error ? error.message : String(error)}`)
              }
            })()
          }}
        >
          暂停本 Router 任务
        </button>
      </LightTooltip>}
      {frozen ? (
        <LightTooltip label="解除全局派发冻结（熔断；自动冻结时需手动解除）">
          <button
            type="button"
            style={{ ...ACTION_BUTTON_STYLE, ...emergencyDarken, fontWeight: 600 }}
            {...emergencyBind}
            data-notification-emergency="unfreeze"
            onClick={() => {
              void (async () => {
                try {
                  await props.api.unfreezeBreaker()
                  setPauseResult('已解除冻结')
                } catch (error) {
                  setPauseResult(`解除冻结失败：${error instanceof Error ? error.message : String(error)}`)
                }
              })()
            }}
          >
            解除冻结
          </button>
        </LightTooltip>
      ) : null}
      <button type="button" data-hidden-toggle onClick={() => setShowHidden((value) => !value)}>
        {showHidden ? '收起已隐藏会话' : '查看已隐藏会话'}（{hidden.length}）
      </button>
      {batch.items.length === 0 && <p>暂无可见派发会话</p>}
      {batch.items.map((row) => {
        if (showHidden) return <section key={row.sessionId} data-hidden-session={row.sessionId} style={SESSION_WINDOW_STYLE}>
          {row.title} <button type="button" data-restore-session={row.sessionId} onClick={() => {
            setHiddenIds((current) => { const next = new Set(current); next.delete(row.sessionId); return next })
            setShowHidden(false)
          }}>恢复</button>
        </section>
        const questions = ownQuestions.filter((entry) => entry.card.sessionId === row.sessionId)
        const notifications = ownNotifications.filter((entry) => row.tasks.some((task) => task.taskId === entry.card.taskId))
        const status = sessionWindowStatus(row, questions.length > 0)
        return <section key={row.sessionId} data-router-session-window={row.sessionId} style={SESSION_WINDOW_STYLE}>
          <button type="button" data-open-session={row.sessionId} onClick={() => props.uiWorkspace.openSession(row.sessionId)}
            style={{ ...ACTION_BUTTON_STYLE, width: '100%', textAlign: 'left', overflowWrap: 'anywhere' }}>
            <strong>{row.title}</strong><br />
            <span data-router-session-status={status.kind} aria-hidden>{status.icon}</span> {status.label}
            <span> · 切换到该会话</span>
          </button>
          {notifications.map((entry) => <div key={entry.card.cardId} data-notification-card={entry.card.cardId}>
            <p>[{kindLabel(entry.card.kind)}] {entry.card.summary}</p>
            {entry.error && <p role="alert">{entry.error}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
            </div>
          </div>)}
          {!notifications.some((entry) => entry.card.actions.some((action) => action.action === 'ack')) &&
            <button type="button" data-hide-session={row.sessionId} style={ACTION_BUTTON_STYLE} onClick={() => hideSession(row.sessionId)}>隐藏</button>}
        </section>
      })}
      </>}
    </div>
  )
}
