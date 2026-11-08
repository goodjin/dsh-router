/**
 * 统一通知卡浮窗（v1.2 规格 §5，计划 Task C1/C2）。
 *
 * 挂点 `shell.overlay`（与问题卡同槽位的独立登记项）：每张完成/异常卡一枚
 * 收起 chip，点击展开动作按钮排（打开会话/查看结果(置灰)/退回重做/重派/
 * 取消/解除冻结/知道了）；提交 → 对应控制路由，成功即补 ack 后消失，失败
 * 保留可重试；动作已生效只补确认不重发。列顶部是「紧急暂停」按钮（裁定：
 * 常驻右列全局可见——worker 视图里也能一键刹车，优于仅 Router 顶部）；
 * 已冻结（出现带 unfreeze 动作的异常卡）时并列「解除冻结」。样式走 ui-kit
 * 基线（浅色提示、hover 稍深）。纯逻辑全部在 notification-model.ts。
 */

import { useSyncExternalStore } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { RouterApi } from './api.ts'
import {
  actionAvailable,
  cardActionPlan,
  cardSessionTarget,
  emergencyButtonState,
  emptyNotifications,
  notificationAckFailed,
  notificationAckStarted,
  notificationAckSucceeded,
  notificationActionFailed,
  notificationActionStarted,
  notificationActionSucceeded,
  notificationCollapsed,
  notificationChipSummary,
  syncedNotifications,
  toggleNotificationCollapsed,
} from './notification-model.ts'
import type { NotificationBoard } from './notification-model.ts'
import type { NotificationActionKind } from '../shared/view-contract.ts'
import { isRouterSessionView, type WorkbenchStore } from './workbench-store.ts'
import { NOTIFICATION_OVERLAY_ID, NOTIFICATION_OVERLAY_ORDER, NOTIFICATION_OVERLAY_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'
import { LightTooltip, useHoverDarken } from './ui-kit.tsx'

/** 组件的业务输入（registration 的 inject 工厂给的 face；组件绝不收 ctx）。 */
export interface NotificationOverlayFace {
  store: WorkbenchStore
  api: RouterApi
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

const STACK_STYLE: CSSProperties = {
  position: 'fixed',
  // 问题卡列（right:16）左侧的第二列：right 352（320 宽 + 16 间距），互不覆盖。
  top: 88,
  right: 352,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  alignItems: 'stretch',
  maxWidth: 320,
  maxHeight: 'calc(100vh - 72px)',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  pointerEvents: 'auto',
  zIndex: 40,
}

const CARD_STYLE: CSSProperties = {
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

const CHIP_STYLE: CSSProperties = {
  ...CARD_STYLE,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
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

function NotificationOverlay(props: NotificationOverlayProps): ReactNode {
  const workbench = useSyncExternalStore(props.store.subscribe, props.store.get)
  // v1.4：浮窗只在 Router 会话视图展示（用户 2026-11-08 指示）。
  if (!isRouterSessionView(props.store.get())) return null
  const state = workbench.routerState
  const [emergencyDarken, emergencyBind] = useHoverDarken()
  const [actionDarken, actionBind] = useHoverDarken()
  const [chipDarken, chipBind] = useHoverDarken()
  const [board, setBoard] = useState<NotificationBoard>(emptyNotifications)
  const [pauseResult, setPauseResult] = useState<string | undefined>(undefined)

  // 轮询合流：服务端通知进板，本地 UI 状态（提交中/展开）跨轮询保持。
  useEffect(() => {
    if (state !== null) setBoard((current) => syncedNotifications(current, state.notifications ?? []))
  }, [state])

  const runAction = useCallback((cardId: string, action: NotificationActionKind) => {
    setBoard((current) => {
      const entry = current.cards.find((item) => item.card.cardId === cardId)
      if (entry === undefined) return current
      const plan = cardActionPlan(entry.card, action, cardSessionTarget(entry.card.taskId, workbench.routerState?.tasks ?? [], workbench.routerState?.tabs ?? []))
      if (plan.type === 'open-session') {
        props.uiWorkspace.openSession(plan.sessionId)
        return notificationCollapsed(current, cardId)
      }
      if (plan.type === 'disabled') return current
      const started = notificationActionStarted(current, cardId)
      if (started === current) return current
      void (async () => {
        try {
          const request = plan.request
          if (request.channel === 'control') {
            await props.api.controlTask(request.taskId, request.action)
          } else if (request.channel === 'unfreeze') {
            await props.api.unfreezeBreaker()
          } else {
            await props.api.ackNotification(request.cardId)
            setBoard((now) => notificationAckSucceeded(now, cardId))
            return
          }
          // 动作成功 → 补确认 → 消失。
          setBoard((now) => {
            const afterAckStart = notificationAckStarted(notificationActionSucceeded(now, cardId), cardId)
            void props.api.ackNotification(cardId)
              .then(() => setBoard((inner) => notificationAckSucceeded(inner, cardId)))
              .catch(() => setBoard((inner) => notificationAckFailed(inner, cardId, '确认发送失败，可重试补确认')))
            return afterAckStart
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setBoard((now) => notificationActionFailed(now, cardId, message))
        }
      })()
      return started
    })
  }, [props, workbench.routerState])

  if (state === null || (board.cards.length === 0 && pauseResult === undefined)) return null

  const { tasks: stateTasks, tabs: stateTabs, notifications: stateNotifications } = state
  const emergency = emergencyButtonState(stateNotifications ?? [])

  return (
    <div style={STACK_STYLE}>
      {pauseResult !== undefined ? (
        <div style={{ ...CARD_STYLE, ...ANOMALY_BORDER }} data-notification-pause-result>{pauseResult}</div>
      ) : null}
      <LightTooltip label={emergency.frozen ? '解除派发冻结（熔断）' : '冻结一切派发并中断全部运行中任务会话'}>
        <button
          type="button"
          style={{ ...ACTION_BUTTON_STYLE, ...emergencyDarken, fontWeight: 600 }}
          {...emergencyBind}
          data-notification-emergency={emergency.frozen ? 'unfreeze' : 'pause'}
          onClick={() => {
            void (async () => {
              try {
                if (emergency.frozen) {
                  await props.api.unfreezeBreaker()
                  setPauseResult('已解除冻结')
                } else {
                  const report = await props.api.emergencyPause()
                  setPauseResult(report.failedCount > 0
                    ? `紧急暂停已执行：中断 ${report.interrupted.length} 个会话，${report.failedCount} 个失败（见明细）`
                    : `紧急暂停已执行：中断 ${report.interrupted.length} 个会话`)
                }
              } catch (error) {
                setPauseResult(`紧急暂停失败：${error instanceof Error ? error.message : String(error)}`)
              }
            })()
          }}
        >
          {emergency.frozen ? '解除冻结' : '紧急暂停'}
        </button>
      </LightTooltip>
      {board.cards.map((entry) => {
        const sessionTarget = cardSessionTarget(entry.card.taskId, stateTasks, stateTabs)
        return (
          <div
            key={entry.card.cardId}
            style={entry.card.kind === 'anomaly' ? { ...CARD_STYLE, ...ANOMALY_BORDER } : CARD_STYLE}
            data-notification-card={entry.card.cardId}
          >
            {entry.collapsed ? (
              <button
                type="button"
                style={{ ...CHIP_STYLE, ...chipDarken, background: 'transparent', border: 'none', textAlign: 'left' }}
                {...chipBind}
                data-notification-chip={entry.card.cardId}
                onClick={() => { setBoard((now) => toggleNotificationCollapsed(now, entry.card.cardId)) }}
              >
                <span style={{ fontWeight: 600 }}>[{kindLabel(entry.card.kind)}]</span>
                <span>{notificationChipSummary(entry.card)}</span>
              </button>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>[{kindLabel(entry.card.kind)}){entry.card.deliveryOrigin === 'system-judged' ? '·系统判定' : ''}]</span>
                  <span style={{ fontWeight: 600 }}>{entry.card.title}</span>
                </div>
                <div style={{ marginTop: 4 }}>{entry.card.summary}</div>
                {entry.phase === 'failed' && entry.error !== undefined ? (
                  <div style={{ marginTop: 4, color: 'var(--dsh-color-danger, #c0392b)' }} data-notification-error>{entry.error}</div>
                ) : null}
                {entry.phase === 'submitting' || entry.phase === 'acking' ? (
                  <div style={{ ...MUTED_STYLE, marginTop: 4 }}>正在送达…</div>
                ) : null}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {entry.card.actions.map((action) => {
                    const availability = actionAvailable(entry.card, action.action, sessionTarget, entry.actionApplied === true)
                    return (
                      <LightTooltip key={action.action} label={availability.reason ?? action.label}>
                        <button
                          type="button"
                          style={{ ...ACTION_BUTTON_STYLE, ...(availability.available ? actionDarken : MUTED_STYLE) }}
                          {...(availability.available ? actionBind : {})}
                          disabled={!availability.available || entry.phase === 'submitting' || entry.phase === 'acking'}
                          data-notification-action={`${entry.card.cardId}:${action.action}`}
                          onClick={() => { runAction(entry.card.cardId, action.action) }}
                        >
                          {action.label}
                        </button>
                      </LightTooltip>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
