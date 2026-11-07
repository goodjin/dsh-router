/**
 * HTTP 路由（计划「客户端↔宿主 API 契约」四条 exact 路由的薄壳）。
 *
 * 形状照计划逐字：
 *   GET  /router/state?workspaceId=        → RouterState（C4 起可带 redirect 指令）
 *   POST /router/router-session            → { sessionId }
 *   POST /router/answer                    → { ok: true }（已答 409）
 *   POST /router/tabs/close                → { ok: true }
 *   POST /router/redirect/ack              → { ok: true }（C4：消费去重指令）
 * 错误统一 { error: string } + 4xx/5xx。注册走 webServer.register({kind:'exact'})
 * + connection.admit 同一登录准入（r3 §3a，chat-power mermaid-asset 样例）；
 * 逻辑全部在注入的 deps（根服务组装的面），本文件只做 HTTP 折叠。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { LedgerError, type LedgerErrorCode } from './ledger/errors.ts'
import type { AskUserQuestionAnswerItem, RouterState } from '../shared/view-contract.ts'

export const ROUTER_STATE_PATH = '/router/state'
export const ROUTER_SESSION_PATH = '/router/router-session'
export const ROUTER_ANSWER_PATH = '/router/answer'
export const ROUTER_TABS_CLOSE_PATH = '/router/tabs/close'
/** 入口去重指令的消费回执（v1.1 Task C4）。 */
export const ROUTER_REDIRECT_ACK_PATH = '/router/redirect/ack'

/** 路由需要的最小宿主面（webServer/connection 可缺席：缺席即不挂路由）。 */
export interface RouterRoutesContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer?: {
    register(route: {
      kind: 'exact'
      path: string
      handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
    }): unknown
  }
  connection?: {
    admit(request: IncomingMessage): { rejection: number } | { peer: unknown }
  }
}

/** 五条路由背后的逻辑面（根服务实现；测试用假件）。 */
export interface RouterRoutesDeps {
  getState(workspaceId?: string): Promise<RouterState>
  createRouterSession(workspaceId: string | undefined, name?: string): Promise<{ sessionId: string }>
  answerQuestion(questionId: string, answers: AskUserQuestionAnswerItem[]): Promise<void>
  closeTab(workspaceId: string, sessionId: string): Promise<boolean>
  /** 消费回执：清掉该 workspace 上指向被归档会话的 redirect 指令（幂等）。 */
  ackRedirect(workspaceId: string, supersededSessionId: string): Promise<void>
}

/** 域错误码 → HTTP 状态。 */
function errorStatus(error: unknown): number {
  if (error instanceof SyntaxError) return 400 // 坏 JSON
  const code = error instanceof LedgerError ? (error.code as LedgerErrorCode) : undefined
  switch (code) {
    case 'task-not-found':
    case 'question-not-found':
    case 'doc-not-found':
      return 404
    case 'already-answered':
    case 'stale-version':
    case 'illegal-transition':
    case 'dependency-cycle':
    case 'doc-exists':
      return 409
    case 'role-forbidden':
    case 'not-task-owner':
    case 'caller-unresolved':
      return 403
    case 'unknown-tool':
    case 'bad-request':
      return 400
    default:
      return 500
  }
}

/** JSON 应答：no-store + 显式长度（照 auto-resume / chat-power 路由的写法）。 */
function respondJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** 读请求体（上限 1 MB，超出 413）。 */
const BODY_LIMIT = 1_000_000

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(chunks.map((chunk) => chunk.toString('utf8')).join('')))
    request.on('error', reject)
  })
}

/**
 * 挂四条 exact 路由。webServer/connection 缺席时不挂（观测面不挡装载）；
 * 每条路由先过 connection.admit 同一登录准入，再校验方法，再进逻辑。
 */
export function registerRouterRoutes(ctx: RouterRoutesContext, deps: RouterRoutesDeps): void {
  if (ctx.webServer === undefined || ctx.connection === undefined) return

  const handle = (
    path: string,
    method: 'GET' | 'POST',
    logic: (request: IncomingMessage) => Promise<{ status: number; body: string }>,
  ): void => {
    ctx.effect(
      () =>
        ctx.webServer?.register({
          kind: 'exact',
          path,
          async handler(request, response) {
            const admission = ctx.connection?.admit(request)
            if (admission !== undefined && 'rejection' in admission) {
              response.writeHead(admission.rejection)
              response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
              return
            }
            if (request.method !== method) {
              response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: method })
              response.end('method not allowed')
              return
            }
            try {
              const { status, body } = await logic(request)
              respondJson(response, status, body)
            } catch (error) {
              respondJson(response, errorStatus(error), JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
            }
          },
        }),
      `dsh-router: ${method} ${path}`,
    )
  }

  handle(ROUTER_STATE_PATH, 'GET', async (request) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined
    const state = await deps.getState(workspaceId)
    return { status: 200, body: JSON.stringify(state) }
  })

  handle(ROUTER_SESSION_PATH, 'POST', async (request) => {
    const body = JSON.parse(await readBody(request)) as { workspaceId?: unknown; name?: unknown }
    if (typeof body.workspaceId !== 'string' || body.workspaceId === '') {
      throw new LedgerError('bad-request', 'workspaceId 必填')
    }
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : undefined
    const created = await deps.createRouterSession(body.workspaceId, name)
    return { status: 200, body: JSON.stringify({ sessionId: created.sessionId }) }
  })

  handle(ROUTER_ANSWER_PATH, 'POST', async (request) => {
    const body = JSON.parse(await readBody(request)) as { questionId?: unknown; answers?: unknown }
    if (typeof body.questionId !== 'string' || !Array.isArray(body.answers)) {
      throw new LedgerError('bad-request', 'questionId 与 answers 必填')
    }
    await deps.answerQuestion(body.questionId, body.answers as AskUserQuestionAnswerItem[])
    return { status: 200, body: JSON.stringify({ ok: true }) }
  })

  handle(ROUTER_TABS_CLOSE_PATH, 'POST', async (request) => {
    const body = JSON.parse(await readBody(request)) as { workspaceId?: unknown; sessionId?: unknown }
    if (typeof body.workspaceId !== 'string' || typeof body.sessionId !== 'string') {
      throw new LedgerError('bad-request', 'workspaceId 与 sessionId 必填')
    }
    await deps.closeTab(body.workspaceId, body.sessionId)
    return { status: 200, body: JSON.stringify({ ok: true }) }
  })

  handle(ROUTER_REDIRECT_ACK_PATH, 'POST', async (request) => {
    const body = JSON.parse(await readBody(request)) as { workspaceId?: unknown; supersededSessionId?: unknown }
    if (typeof body.workspaceId !== 'string' || typeof body.supersededSessionId !== 'string') {
      throw new LedgerError('bad-request', 'workspaceId 与 supersededSessionId 必填')
    }
    await deps.ackRedirect(body.workspaceId, body.supersededSessionId)
    return { status: 200, body: JSON.stringify({ ok: true }) }
  })
}
