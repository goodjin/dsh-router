/**
 * 会话导航标签条（规格 §3.2 第一层导航）。
 *
 * 挂点 `conversation.header.leading`（single、root、当前零占用、replaceRisk
 * none——R3 报告 §1.2/§8.1 的判定）：Router 会话固定首位，worker 标签按服务端
 * 持久标签序随后；激活态 = uiSession 当前会话映射（store 维护）；点击
 * uiWorkspace.openSession 切换；worker 标签 × → tabs/close，确认后本地移除。
 * 规格铁律：新派发不抢焦点——本组件只响应点击，绝不主动切换会话；
 * 不学 chat-power 的 MutationObserver 插 DOM，纯 slot 机制。
 */

import { useMemo, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { RouterState } from '../shared/view-contract.ts'
import { activeTabIndex, buildTabList, workbenchTabsVisible } from './tabs-model.ts'
import type { RouterTabEntry } from './tabs-model.ts'
import { WORKBENCH_TABS_ID, WORKBENCH_TABS_ORDER, WORKBENCH_TABS_SLOT } from './surface-ids.ts'
import type { WorkbenchStore } from './workbench-store.ts'
import { LightTooltip, useHoverDarken } from './ui-kit.tsx'

/** slots 服务的最小面（结构化；真实 face 由 index.ts 传入）。 */
export interface SlotsHost {
  inject(key: string, prepare: () => unknown): unknown
  register(options: {
    name: string
    id?: string
    order?: number
    label?: () => string
    locale?: string
    inject?: () => unknown
    children?: Record<string, { kind: 'single'; scope: 'session' }>
  }, component: unknown): unknown
}

/** 组件的业务输入（registration 的 inject 工厂给的 face；组件绝不收 ctx）。 */
export interface WorkbenchTabsFace {
  store: WorkbenchStore
  uiWorkspace: { openSession(target: string): void }
}

/** 组件 props = face（经 registration inject 注入）。 */
export type WorkbenchTabsProps = WorkbenchTabsFace

const EMPTY_STATE: RouterState = { routerSessions: [], tasks: [], questions: [], tabs: [], templates: [] }

/**
 * 把标签条注册进宿主头部。registration 的 `inject` 返回 face——渲染时
 * 框架把它并进组件 props（R3 报告 §7「组件输入的五个来源」）。
 */
export function registerWorkbenchTabs(slots: SlotsHost, face: WorkbenchTabsFace): void {
  slots.inject(WORKBENCH_TABS_SLOT, () => slots.register(
    { name: WORKBENCH_TABS_SLOT, id: WORKBENCH_TABS_ID, order: WORKBENCH_TABS_ORDER, inject: () => face },
    WorkbenchTabs,
  ))
}

/** 宿主没有独立的标题 slot：仅隐藏同一 header 内的面包屑，保留操作与视图入口。
 * 使用 CSS module 的语义后缀，不绑定构建哈希；标签卸载时规则随之移除。
 */
export const DUPLICATE_TITLE_SELECTOR = 'header:has([data-router-workbench-tabs]) nav[class$="_crumbs"]'
const HEADER_STYLE = `${DUPLICATE_TITLE_SELECTOR} { display: none; }`

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
  maxWidth: '25vw',
  // 与相邻 preset 操作留出间隔；间隔在滚动区域之外，不随标签滚走。
  marginInlineEnd: 8,
  paddingInlineEnd: 2,
  boxSizing: 'border-box',
  flexShrink: 1,
  overflowX: 'auto',
  scrollbarWidth: 'none',
}

function tabStyle(active: boolean, closing: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    // 标签整体滚动而非挤压，确保最右侧边框和关闭按钮保留完整宽度。
    flex: '0 0 auto',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: 6,
    border: '1px solid',
    borderColor: active ? 'var(--dsh-color-primary, #4f6bed)' : 'var(--dsh-color-border, #d8dbe0)',
    background: active ? 'color-mix(in srgb, var(--dsh-color-primary, #4f6bed) 12%, transparent)' : 'var(--dsh-color-surface, #f5f6f8)',
    color: 'inherit',
    fontSize: 12,
    lineHeight: '18px',
    cursor: closing ? 'default' : 'pointer',
    opacity: closing ? 0.55 : 1,
    whiteSpace: 'nowrap',
    userSelect: 'none',
  }
}

const CLOSE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 14,
  height: 14,
  margin: 0,
  padding: 0,
  border: 'none',
  borderRadius: 3,
  background: 'transparent',
  color: 'inherit',
  fontSize: 11,
  lineHeight: '14px',
  cursor: 'pointer',
  opacity: 0.6,
}

function statusDot(entry: RouterTabEntry): ReactNode {
  if (entry.kind !== 'worker' || !entry.running) return null
  return (
    <span
      data-router-tab-running
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: 'var(--dsh-color-success, #34a853)',
        display: 'inline-block',
        flex: 'none',
      }}
    />
  )
}

/** 标签条组件：Router 固定首位 + worker 标签；激活 = 当前会话；点击切换。 */
export function WorkbenchTabs(props: WorkbenchTabsProps): ReactNode {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)
  const tabs = useMemo(
    () => buildTabList(state.routerState ?? EMPTY_STATE),
    [state.routerState],
  )
  const activeIndex = activeTabIndex(tabs, state.currentSessionId)
  // root slot 跨会话存活：普通会话或无当前会话时整条隐藏，不占头部空间。
  if (!workbenchTabsVisible(state.routerState, state.currentSessionId) || tabs.length === 0) return null
  return (
    <nav data-router-workbench-tabs style={ROW_STYLE} aria-label="Router 会话标签">
      <style>{HEADER_STYLE}</style>
      {tabs.map((entry, index) => {
        const closing = state.closingSessionIds.includes(entry.sessionId)
        return (
          <TabEntry
            key={`${entry.kind}:${entry.sessionId}`}
            entry={entry}
            active={index === activeIndex}
            closing={closing}
            onOpen={() => {
              // 只响应点击；新派发/轮询绝不主动切换（规格 §3.2 不抢焦点）。
              if (!closing && entry.sessionId !== state.currentSessionId) {
                props.uiWorkspace.openSession(entry.sessionId)
              }
            }}
            onClose={() => { void props.store.closeWorkerTab(entry.sessionId) }}
          />
        )
      })}
    </nav>
  )
}

/** 一格标签（独立组件：hover 稍深要走 useHoverDarken 的 hook，不能进 map 回调）。 */
function TabEntry(props: {
  entry: RouterTabEntry
  active: boolean
  closing: boolean
  onOpen(): void
  onClose(): void
}): ReactNode {
  const { entry, active, closing } = props
  const [darken, bind] = useHoverDarken()
  const [closeDarken, closeBind] = useHoverDarken()
  return (
    <span
      data-router-tab={entry.kind}
      data-session-id={entry.sessionId}
      role="tab"
      aria-selected={active}
      style={{ ...tabStyle(active, closing), ...darken }}
      {...bind}
      onClick={() => { if (!closing) props.onOpen() }}
    >
      {statusDot(entry)}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>{entry.title}</span>
      {entry.kind === 'worker' ? (
        // 浅色悬浮提示替代原生 title（规格 §9 禁黑底原生浮层）。
        <LightTooltip label="关闭标签（不停止任务）">
          <button
            type="button"
            data-router-tab-close
            aria-label={`关闭标签 ${entry.title}`}
            disabled={closing}
            style={{ ...CLOSE_STYLE, ...closeDarken }}
            {...closeBind}
            onClick={(event) => {
              event.stopPropagation()
              props.onClose()
            }}
          >
            ×
          </button>
        </LightTooltip>
      ) : null}
    </span>
  )
}
