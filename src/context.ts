/**
 * 预设树上下文行入口（`@goodjin2/dsh-router/context`，轻量协作版，计划 Task 2B）。
 *
 * inject ['systemPrompt', 'routerCollaboration']：经官方 systemPrompt.context 注册一段
 * 动态上下文「router-collaboration」，text 回调在组装期收当次 AssembleContext（dsh-agent
 * 注入当前 agent）。当前会话 ID 取自 `assembly.agent.id`（真实 Agent 公共上下文，不猜
 * ctx.agent/根 id、不扫历史、不建可变全局 currentSession）；与共享 dataDir 一起交给纯
 * 构建器 buildCollaborationContext 产出面向模型的文本。
 *
 * 缺少宿主 agent 面（assembly.agent 缺席）时不臆造会话身份：产出一段诊断说明（列出工具
 * 与协作目录、提示当前会话 ID 不可用），绝不抛（组装路径抛错会炸整轮对话）。
 *
 * 注意宿主 SystemPrompt.context 对非有限 order 直接 TypeError，order 必须给。
 */

import Schema from '@deepseek-ai/schemastery'

import { buildCollaborationContext } from './collaboration/context.ts'
import type { ActiveTaskCache, ActiveTaskView } from './collaboration/active-tasks.ts'

/** 本入口的插件名（诊断显示用）。 */
export const name = 'router-context'

export const inject = ['systemPrompt', 'routerCollaboration'] as const

/** 行配置：上下文段在 runtime context 里的排序 + 角色清单缓存刷新间隔。 */
export interface RouterContextConfig {
  order?: number
  rolesTtlMs?: number
}

export const Config = Schema.object({
  // order 是行加载时一次性给定的静态值，不做运行时更新，故不用 .volatile()
  // （volatile 会把值包成 { get(), [write]() } 引用对象，导致 typeof number 检查
  // 永远失败、order 被回退到默认 100）。
  order: Schema.number().default(100),
  // 角色清单缓存的刷新间隔（毫秒）：text() 是同步回调，不能 await 异步 list()——
  // 采用缓存 + 过期后台刷新；0 表示每次组装都 kick 一次刷新（测试用）。
  rolesTtlMs: Schema.number().default(30_000),
})

/** 官方 AssembleContext 的最小面：dsh-agent 注入当前 agent（含公开只读 id）。 */
interface AssembleContextLike {
  agent?: { id?: unknown }
}

interface ContextEntry {
  name: string
  order: number
  text(assembly?: unknown): string
  /**
   * 整段当字面文本、不参与宿主变量插值（宿主 `interpolate === false` 即不解析 `{{…}}`）。
   * 本段注入了会话 ID、任务描述、角色摘要等不可信动态文本，其中任一字段都可能混入
   * `{{…}}`（如接口配置输出 `{{InterfaceName: tun0 …}}`），被宿主当成非法变量引用来解析
   * 会抛致命错、炸掉整轮组装。本段没有任何 `{{…}}` 变量占位意图，故一律关插值兜住。
   */
  interpolate?: false
}

interface SystemPromptFace {
  context(entry: ContextEntry): unknown
}

interface RouterCollaborationFace {
  dataDir: string
  /** 角色模板存储（共享单实例）；缺席或不可调用时角色段降级为「暂不可用」。 */
  roles?: { list(): Promise<Array<{ name: string; description: string }>> }
  /** 活跃任务视图缓存（共享单实例）；缺席时任务段降级为「加载中」。 */
  activeTasks?: ActiveTaskCache
}

/** 从当次组装上下文取真实当前会话 ID（agent.id）；取不到返回 undefined。 */
function currentSessionId(assembly: unknown): string | undefined {
  if (typeof assembly !== 'object' || assembly === null) return undefined
  const agent = (assembly as AssembleContextLike).agent
  if (typeof agent !== 'object' || agent === undefined) return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 缺 agent 面时的诊断文本：不臆造会话身份，仍给出工具与协作目录。 */
function diagnosticText(dataDir: string): string {
  // 复用纯构建器的目录/工具段：以占位 sessionId 调用，再把「当前会话 ID」改写成不可用。
  const base = buildCollaborationContext({ sessionId: 'unknown', dataDir })
  return base.replace('当前会话 ID：unknown', '当前会话 ID：不可用（宿主未在本次组装中提供 agent 面；不要臆造 rootSessionId，向上级会话询问）')
}

/** 注册协作上下文；返回注销器交给宿主 effect 生命周期。 */
export function apply(ctx: ContextHost, config: RouterContextConfig): () => void {
  const order = typeof config.order === 'number' && Number.isFinite(config.order) ? config.order : 100
  const ttlMs = typeof config.rolesTtlMs === 'number' && Number.isFinite(config.rolesTtlMs) && config.rolesTtlMs >= 0
    ? config.rolesTtlMs
    : 30_000
  const dataDir = ctx.routerCollaboration.dataDir

  // 角色清单缓存：text() 是同步回调，不能 await list()——过期即后台刷新（fire-and-forget
  // 就地兜底，绝不留 unhandled rejection），本轮先用缓存值渲染。
  const cache: {
    value: ReadonlyArray<{ name: string; description: string }> | undefined
    at: number
    loading: boolean
  } = { value: undefined, at: -Infinity, loading: false }
  const refresh = async (): Promise<void> => {
    if (cache.loading) return
    cache.loading = true
    try {
      const list = ctx.routerCollaboration.roles?.list
      if (typeof list !== 'function') {
        // 角色存储缺席：保持 undefined（「暂不可用」），但仍记录时间避免每次组装空转。
        cache.at = Date.now()
        return
      }
      cache.value = await list.call(ctx.routerCollaboration.roles)
      cache.at = Date.now()
    } catch {
      // 读取失败：保留上一份缓存（没有则维持「暂不可用」），退避到当前时刻。
      cache.at = Date.now()
    } finally {
      cache.loading = false
    }
  }
  const kickIfStale = (): void => {
    if (cache.loading) return
    if (Date.now() - cache.at < ttlMs) return
    void refresh()
  }
  kickIfStale()

  const dispose = ctx.systemPrompt.context({
    name: 'router-collaboration',
    order,
    interpolate: false,
    text: (assembly: unknown) => {
      kickIfStale()
      const sessionId = currentSessionId(assembly)
      if (sessionId === undefined) return diagnosticText(dataDir)
      // 活跃任务视图：同步读缓存；写操作后由 tools/dispatch 行刷新过，通常已是最新。
      // 缓存没有（刚启动/首次装配）就后台刷一次（fire-and-forget 就地兜底），本轮渲染「加载中」。
      let tasks: readonly ActiveTaskView[] | undefined
      try {
        tasks = ctx.routerCollaboration.activeTasks?.get(sessionId)
        if (tasks === undefined && ctx.routerCollaboration.activeTasks !== undefined) {
          ctx.routerCollaboration.activeTasks.refresh(sessionId).catch(() => {})
        }
      } catch {
        tasks = undefined // 读缓存失败按「加载中」渲染，绝不穿透组装路径
      }
      return buildCollaborationContext({ sessionId, dataDir, roles: cache.value, tasks })
    },
  })
  return () => {
    (dispose as (() => void) | undefined)?.()
  }
}

interface ContextHost {
  systemPrompt: SystemPromptFace
  routerCollaboration: RouterCollaborationFace
}
