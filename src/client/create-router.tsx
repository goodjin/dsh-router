/**
 * 「新建 Router」入口（规格 §3.1 创建入口的挂点落地）。
 *
 * 挂点 `sidebar.footer.action`（list、root、增量、replaceRisk none——R3
 * 报告 §1.1/§8.3：左侧项目/会话列表本体没有注入点，底部 Settings 旁的
 * 动作位是最轻最稳的替代，简报指定）。点击展开小表单：名称 + 模板下拉
 * （模板来自 GET /router/state 的 templates，开表单时一次性拉取），提交 →
 * POST /router/router-session → uiWorkspace.openSession 打开新会话。
 * 纯 slot + fetch + 导航服务，不做任何 DOM 手术。
 */

import { useSyncExternalStore, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { RouterApi } from './api.ts'
import type { WorkspacesListLike, WorkbenchStore } from './workbench-store.ts'
import { CREATE_ENTRY_ID, CREATE_ENTRY_ORDER, CREATE_ENTRY_SLOT } from './surface-ids.ts'
import type { SlotsHost } from './workbench-tabs.tsx'
import { LightTooltip } from './ui-kit.tsx'
import type { WorkerTemplate } from '../shared/view-contract.ts'

/** 组件的业务输入。 */
export interface CreateRouterFace {
  store: WorkbenchStore
  api: RouterApi
  uiWorkspace: { openSession(target: string): void }
  workspacesList?: WorkspacesListLike
}

export type CreateRouterProps = CreateRouterFace

/** 把入口注册进侧栏底部动作位（entry.spec 断言键名/id）。 */
export function registerCreateRouter(slots: SlotsHost, face: CreateRouterFace): void {
  slots.inject(CREATE_ENTRY_SLOT, () => slots.register(
    { name: CREATE_ENTRY_SLOT, id: CREATE_ENTRY_ID, order: CREATE_ENTRY_ORDER, inject: () => face },
    CreateRouterButton,
  ))
}

const BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 8px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const FORM_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  position: 'fixed',
  left: 12,
  bottom: 48,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  width: 240,
  padding: 10,
  borderRadius: 10,
  border: '1px solid var(--dsh-color-border, #3a3d45)',
  background: 'var(--dsh-color-bg-elevated, #1f2126)',
  color: 'inherit',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
  fontSize: 12,
  zIndex: 50,
}

const INPUT_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsh-color-border, #3a3d45)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
}

const ACTION_ROW_STYLE: CSSProperties = { display: 'flex', gap: 6, marginTop: 2 }

const PRIMARY_STYLE: CSSProperties = {
  flex: 1,
  padding: '5px 0',
  borderRadius: 7,
  border: 'none',
  background: 'var(--dsh-color-primary, #4f6bed)',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
}

const CANCEL_STYLE: CSSProperties = {
  padding: '5px 10px',
  borderRadius: 7,
  border: '1px solid var(--dsh-color-border, #3a3d45)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

/** 解析本次创建绑定的 workspace：当前会话所属，退而取列表第一个。 */
function resolveWorkspaceId(props: CreateRouterProps): string | undefined {
  const fromSession = props.store.currentWorkspaceId()
  if (fromSession !== undefined) return fromSession
  return (props.workspacesList?.getSnapshot().items ?? [])[0]?.workspaceId
}

/** 侧栏底部按钮 + 展开的小表单。 */
export function CreateRouterButton(props: CreateRouterProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [templates, setTemplates] = useState<readonly WorkerTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // 模板选择随表单联动：读 store 里最近一次轮询的 templates（若有）。
  const state = useSyncExternalStore(props.store.subscribe, props.store.get)

  async function openForm(): Promise<void> {
    setOpen(true)
    setError(null)
    const seeded = state.routerState?.templates ?? []
    setTemplates(seeded)
    setLoading(seeded.length === 0)
    try {
      const workspaceId = resolveWorkspaceId(props)
      const next = await props.api.getState(workspaceId)
      setTemplates(next.templates)
    } catch (caught) {
      // 模板拉不到不挡创建：下拉显示「默认」，错误只在展开面板里提示。
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  async function submit(): Promise<void> {
    const workspaceId = resolveWorkspaceId(props)
    if (workspaceId === undefined) {
      setError('无法确定目标工作区（先打开一个会话或工作区）')
      return
    }
    setCreating(true)
    setError(null)
    try {
      // 路由契约体是 { workspaceId, name? }；模板偏好作为可选扩展键带上，
      // 宿主不识别时自然忽略（见最终报告的取舍说明）。
      const template = templateId.length > 0 ? templateId : undefined
      const trimmed = name.trim()
      const result = await props.api.createRouterSession(
        workspaceId,
        trimmed.length > 0 ? trimmed : undefined,
        template,
      )
      setOpen(false)
      setName('')
      setTemplateId('')
      // 本工作区刚长出第一个 Router（审查 F2）：门控重开 + 立即拉真，
      // 否则「空工作区不再轮询」会把新 Router 的标签/问题藏到下一次换区。
      props.store.invalidateGate()
      void props.store.pollOnce()
      // 创建成功即打开新 Router 会话（这是唯一一次程序化切换，来自用户点击）。
      props.uiWorkspace.openSession(result.sessionId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCreating(false)
    }
  }

  if (!open) {
    return (
      // 浅色悬浮提示替代原生 title（规格 §9 禁黑底原生浮层）。
      <LightTooltip label="新建 Router 会话">
        <button
          type="button"
          data-router-create-entry
          style={BUTTON_STYLE}
          onClick={() => { void openForm() }}
        >
          <span aria-hidden>＋</span>
          <span>Router</span>
        </button>
      </LightTooltip>
    )
  }
  return (
    <div data-router-create-form style={FORM_STYLE}>
      <strong>新建 Router</strong>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ opacity: 0.75 }}>名称（可空）</span>
        <input
          data-router-create-name
          value={name}
          autoFocus
          onChange={(event) => { setName(event.target.value) }}
          placeholder="默认：Router"
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ opacity: 0.75 }}>Router 模板</span>
        <select
          data-router-create-template
          value={templateId}
          onChange={(event) => { setTemplateId(event.target.value) }}
          style={INPUT_STYLE}
        >
          <option value="">默认</option>
          {templates.map((template) => (
            <option key={template.templateId} value={template.templateId}>
              {template.name}
            </option>
          ))}
        </select>
        {loading ? <span style={{ opacity: 0.7 }}>模板加载中…</span> : null}
      </label>
      {error !== null ? (
        <div data-router-create-error style={{ color: 'var(--dsh-color-danger, #d93025)' }}>{error}</div>
      ) : null}
      <div style={ACTION_ROW_STYLE}>
        <button
          type="button"
          data-router-create-submit
          disabled={creating}
          style={{ ...PRIMARY_STYLE, opacity: creating ? 0.6 : 1 }}
          onClick={() => { void submit() }}
        >
          {creating ? '创建中…' : '创建'}
        </button>
        <button
          type="button"
          data-router-create-cancel
          style={CANCEL_STYLE}
          onClick={() => { setOpen(false) }}
        >
          取消
        </button>
      </div>
    </div>
  )
}
