/**
 * 控制路由 + 紧急暂停测试（v1.2 计划 Task B4，规格 §2 熔断/§Review Focus 5）。
 *
 * 三条新 exact 路由：
 *   POST /router/tasks/control    {taskId, action:'pause'|'resume'|'cancel'|'redispatch'|'accept'|'reject'|'rework', note?} → {status}
 *   POST /router/breaker/unfreeze → {before, after}（冻结前/后可见投影）
 *   POST /router/emergency-pause  → {frozen, reason?, interrupted[], failedCount, notification?}
 *
 * 领域件全真（guard-core 同款收敛）：真账本状态机、真熔断器（memfs）、真会话桥、
 * 通知段真落盘（memfs）；只有宿主 agents 中断面是假件（记录 cause/options 或抛错）。
 * HTTP 层断言状态码折叠；语义层断言状态机走向与逐项结果（Review Focus 5：失败项
 * 如实列出，不静默）。
 */

import { describe, expect, it } from 'vitest'

import { LedgerError } from '../src/host/ledger/errors.ts'
import {
  registerRouterRoutes,
  type RouterRoutesContext,
  type RouterRoutesDeps,
} from '../src/host/routes.ts'
import { guardCoreWith, type GuardCoreOptions } from './helpers/guard-core.ts'
import { task } from './helpers/task-builder.ts'
import type { AgentInterruptFace, InterruptOutcome, SessionBridge } from '../src/host/bridge/sessions.ts'
import { NotificationStore, anomalyActions, type NotificationSink } from '../src/host/guard/notifications.ts'
import {
  scopedPauseTargets,
} from '../src/host/guard/emergency.ts'
import type { RouterState, ScopedPauseReport, WorkerSpawnMode } from '../src/shared/view-contract.ts'

/* ────────────────────────── 假 HTTP 上下文（照 routes-worker-types 同款） ────────────────────────── */

interface CapturedResponse { status: number; headers: Record<string, unknown>; body: string }

function fakeHttpContext() {
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }> = []
  const ctx = {
    effect(factory: () => unknown) {
      ;(factory as () => unknown)()
      return () => {}
    },
    webServer: {
      register(route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) {
        routes.push({ path: route.path, handler: route.handler })
      },
    },
    connection: {
      admit() {
        return { peer: {} }
      },
    },
  }
  return { ctx: ctx as unknown as RouterRoutesContext, routes: routes as Array<{ path: string; handler: (req: IncomingMessageLike, res: unknown) => Promise<void> | void }> }
}

interface IncomingMessageLike {
  method?: string
  url?: string
  on(event: string, listener: (...args: unknown[]) => void): void
}

function fakeExchange(method: string, url: string, body?: string) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const req: IncomingMessageLike = {
    method,
    url,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'data') chunks.forEach((chunk) => listener(chunk))
      if (event === 'end') listener()
    },
  }
  const captured = {} as CapturedResponse
  const res = {
    writeHead(status: number, hdrs?: Record<string, unknown>) {
      captured.status = status
      captured.headers = hdrs ?? {}
    },
    end(payload?: string) {
      captured.body = payload ?? ''
    },
  }
  return { req, res, captured }
}

function handlerOf(routes: Array<{ path: string; handler: unknown }>, path: string): (req: unknown, res: unknown) => Promise<void> {
  const found = routes.find((route) => route.path === path)
  expect(found, `路由 ${path} 应已挂上`).toBeDefined()
  return found!.handler as (req: unknown, res: unknown) => Promise<void>
}

/* ────────────────────────── 控制面装配（entry.ts 组装的测试侧同构） ────────────────────────── */

/** agents 中断面假件：记录每会话 cancel 的 cause/options；指定会话可抛错。 */
function fakeInterruptFace(opts: { failFor?: (sessionId: string) => Error | undefined } = {}) {
  const calls: Array<{ sessionId: string; cause: unknown; options: unknown }> = []
  const face: AgentInterruptFace = {
    get(sessionId) {
      return {
        cancel(cause, options) {
          const failure = opts.failFor?.(sessionId)
          if (failure !== undefined) throw failure
          calls.push({ sessionId, cause, options })
          return { accepted: true }
        },
      }
    },
  }
  return { face, calls }
}

/**
 * 与 entry.ts 同构的控制路由 deps：core.controlTask / 冻结检查+supplement 的
 * redispatch / breaker 往返 / runEmergencyPause + 通知段。
 */
async function controlHarness(opts: GuardCoreOptions & { interrupt?: ReturnType<typeof fakeInterruptFace> } = {}) {
  // budgets 关闭：用户发起的控制动作本就绕过模型侧预算（B4 简报），且测试需要
  // 同会话连派多个任务构造 running/dispatched 并存的目标清单。
  // 通知存储要用核心那份 memfs（装配后才拿得到），故先给核心一个转发口，
  // 装配完再把真存储接上——v1.4 的暂停任务卡走的就是这个口。
  let sink: NotificationSink | undefined
  const forwarding: NotificationSink = {
    push: (input) => {
      if (sink === undefined) throw new Error('通知存储未接上')
      return sink.push(input)
    },
    pending: () => (sink === undefined ? Promise.resolve([]) : sink.pending()),
    list: () => (sink === undefined ? Promise.resolve([]) : sink.list()),
    ack: (cardId) => (sink === undefined ? Promise.resolve(false) : sink.ack(cardId)),
  }
  const h = await guardCoreWith({
    ...opts,
    budgets: null,
    interruptFace: opts.interrupt?.face,
    notifications: forwarding,
  })
  const breaker = h.breaker!
  let cardSeq = 0
  const notifications = new NotificationStore({ fs: h.memfs.fs, path: '/guard/notifications.json', newId: () => `card-${++cardSeq}`, now: () => 5000 })
  sink = notifications
  // v1.4：作用域暂停只认已登记的 Router 会话——把测试里的派发者登记进去。
  await h.ui.addRouterSession('router-s-1', 'ws-1', 'Router')
  await h.ui.addRouterSession('router-s-2', 'ws-1', 'Router 2')
  const spawnModeHolder: { mode: WorkerSpawnMode } = { mode: 'cache-priority' }
  const deps: RouterRoutesDeps = {
    // v1.2 B3 通知确认：经统一 NotificationStore。
    ackNotification: (cardId: string) => notifications.ack(cardId),
    // v1.4 诊断路由桩：本文件用例不触达。
    async getHealth() {
      return {}
    },
    async getState() {
      return { routerSessions: [], tasks: [], questions: [], tabs: [], templates: [] }
    },
    async createRouterSession() {
      return { sessionId: 'r' }
    },
    async answerQuestion() {},
    async closeTab() {
      return true
    },
    async listWorkerTypes() {
      return { types: [] }
    },
    async createWorkerType() {
      throw new LedgerError('invalid-input', '本 spec 不消费')
    },
    async updateWorkerType() {
      throw new LedgerError('invalid-input', '本 spec 不消费')
    },
    async setWorkerTypeEnabled() {
      throw new LedgerError('invalid-input', '本 spec 不消费')
    },
    async removeWorkerType() {},
    async getDefaults() {
      return { routerSystemPrompt: '', routerModel: '' }
    },
    async saveDefaults(value) {
      return value
    },
    /* ── v1.3 C2 spawn-mode：与 entry.ts 同构的内存易变 holder ── */
    getSpawnMode: async () => ({ mode: spawnModeHolder.mode }),
    saveSpawnMode: async (mode) => {
      spawnModeHolder.mode = mode
      return { mode: spawnModeHolder.mode }
    },
    async getSessionPrompt() {
      return { prompt: '', isDefault: true }
    },
    async saveSessionPrompt() {},
    /* ── B4 三条（与 entry.ts 逐字同构） ── */
    controlTask: async (taskId, action, note) => {
      if (action === 'redispatch') {
        const state = await breaker.state()
        if (state.frozen) {
          throw new LedgerError(
            'dispatch-frozen',
            `派发已冻结（${state.reason ?? '原因未记录'}）：重派被拒——请先解除冻结（POST /router/breaker/unfreeze）再重派任务 ${taskId}`,
          )
        }
        await h.core.supplementTask('user', taskId, ['用户重派：请按任务书当前版本推进'])
        return { status: h.core.getTask(taskId)?.status ?? 'failed' }
      }
      return h.core.controlTask('user', taskId, action, note)
    },
    unfreezeBreaker: async () => {
      const beforeState = await breaker.state()
      const before: { frozen: boolean; reason?: string; frozenAt?: number } = { frozen: beforeState.frozen }
      if (beforeState.frozen) {
        if (beforeState.reason !== undefined) before.reason = beforeState.reason
        if (beforeState.frozenAt !== undefined) before.frozenAt = beforeState.frozenAt
      }
      await breaker.unfreeze()
      const afterState = await breaker.state()
      // 与 entry.ts 同构：解冻后补派冻结期间解锁的 queued 任务（M1）。
      await h.core.dispatchReady()
      return { before, after: { frozen: afterState.frozen } }
    },
    scopedPause: async (routerSessionId: string) => h.core.scopedPause(routerSessionId),
  }
  return { ...h, deps, notifications, breaker, interrupt: opts.interrupt, spawnModeHolder }
}

/** 派发一个 worker 任务（经真核心，走模板校验→建会话→投递→dispatched 全链）。 */
async function dispatchWorkerTask(
  h: Awaited<ReturnType<typeof controlHarness>>,
  title: string,
  acceptancePolicy: 'auto' | 'supervisor' | 'user' = 'auto',
): Promise<{ taskId: string; sessionId: string }> {
  const result = await h.core.dispatchTask('router-s-1', {
    title,
    goal: '把事情做完',
    acceptance: ['完成'],
    role: 'worker',
    templateId: 'coder',
    acceptancePolicy,
  })
  return { taskId: result.taskId, sessionId: result.sessionId ?? '' }
}

/**
 * 派发一个任务并指定派发者会话（v1.4：宿主记 dispatchedBySessionId，作用域
 * 暂停据此圈范围）。这里直接改账本记录来模拟不同派发者——真实链路里这个字段
 * 由 core.dispatchTask 落库（见 core.ts 的 dispatchTask）。
 */
async function dispatchBy(
  h: Awaited<ReturnType<typeof controlHarness>>,
  title: string,
  dispatcher = 'router-s-1',
): Promise<{ taskId: string; sessionId: string }> {
  const result = await dispatchWorkerTask(h, title)
  const record = h.ledger.get(result.taskId)!
  record.dispatchedBySessionId = dispatcher
  return result
}

/* ────────────────────────── 控制路由（POST /router/tasks/control） ────────────────────────── */

describe('POST /router/tasks/control（B4）', () => {
  it('三条新 exact 路由挂上（control / breaker-unfreeze / emergency-pause）', () => {
    void controlHarness // 装配面被下方用例消费；此用例只看挂载
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, {
      // v1.2 B3 通知确认桩：本用例只看挂载。
      async ackNotification() {
        return false
      },
      // v1.4 诊断路由桩：本用例只看挂载。
      async getHealth() {
        return {}
      },
      async getState() {
        return { routerSessions: [], tasks: [], questions: [], tabs: [], templates: [] }
      },
      async createRouterSession() {
        return { sessionId: 'r' }
      },
      async answerQuestion() {},
      async closeTab() {
        return true
      },
      async listWorkerTypes() {
        return { types: [] }
      },
      async createWorkerType() {
        throw new LedgerError('invalid-input', '-')
      },
      async updateWorkerType() {
        throw new LedgerError('invalid-input', '-')
      },
      async setWorkerTypeEnabled() {
        throw new LedgerError('invalid-input', '-')
      },
      async removeWorkerType() {},
      async getDefaults() {
        return { routerSystemPrompt: '', routerModel: '' }
      },
      async saveDefaults(value) {
        return value
      },
      async getSpawnMode() {
        return { mode: 'cache-priority' as const }
      },
      async saveSpawnMode(mode: WorkerSpawnMode) {
        return { mode }
      },
      async getSessionPrompt() {
        return { prompt: '', isDefault: true }
      },
      async saveSessionPrompt() {},
      async controlTask() {
        return { status: 'paused' as const }
      },
      async unfreezeBreaker() {
        return { before: { frozen: true }, after: { frozen: false } }
      },
      async scopedPause() {
        return { tasks: [], pausedCount: 0, failedCount: 0, notified: true }
      },
    })
    const paths = routes.map((r) => r.path)
    expect(paths).toContain('/router/tasks/control')
    expect(paths).toContain('/router/breaker/unfreeze')
    expect(paths).toContain('/router/emergency-pause')
    expect(paths).toContain('/router/spawn-mode')
  })

  it('pause：running→paused，执行会话收到暂停通知（steer）', async () => {
    const h = await controlHarness()
    const { taskId } = await dispatchWorkerTask(h, '要暂停的活')
    await h.ledger.transition(taskId, 'running')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'pause' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(JSON.parse(exchange.captured.body!)).toEqual({ status: 'paused' })
    expect(h.ledger.get(taskId)?.status).toBe('paused')
    const notice = h.events.prompts.find((p) => p.requestId === `pause-${taskId}`)
    expect(notice, '暂停通知应送达执行会话').toBeDefined()
    expect(notice?.mode).toBe('steer')
    expect(notice?.text).toContain('暂停')
  })

  it('pause 在 dispatched 上合法（v1.4：作用域暂停要能停刚派出、还没开跑的任务）', async () => {
    const h = await controlHarness()
    const { taskId } = await dispatchWorkerTask(h, '还没开跑')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'pause' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(JSON.parse(exchange.captured.body!)).toEqual({ status: 'paused' })
    expect(h.ledger.get(taskId)?.status).toBe('paused')
  })

  it('resume：paused→running，会话收到恢复通知', async () => {
    const h = await controlHarness()
    const { taskId } = await dispatchWorkerTask(h, '暂停后恢复')
    await h.ledger.transition(taskId, 'running')
    await h.ledger.transition(taskId, 'paused')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'resume' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(JSON.parse(exchange.captured.body!)).toEqual({ status: 'running' })
    expect(h.ledger.get(taskId)?.status).toBe('running')
    expect(h.events.prompts.find((p) => p.requestId === `resume-${taskId}`)).toBeDefined()
  })

  it('cancel：dispatched→cancelled，notifyCancel 送达执行会话', async () => {
    const h = await controlHarness()
    const { taskId } = await dispatchWorkerTask(h, '要取消的活')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'cancel' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(JSON.parse(exchange.captured.body!)).toEqual({ status: 'cancelled' })
    expect(h.ledger.get(taskId)?.status).toBe('cancelled')
    expect(h.events.prompts.find((p) => p.requestId === `cancel-${taskId}`)).toBeDefined()
  })

  it('cancel 在终态（completed）上 → 409', async () => {
    const h = await controlHarness()
    const { taskId } = await dispatchWorkerTask(h, '已完成的活')
    await h.ledger.transition(taskId, 'running')
    await h.ledger.complete(taskId, { docVersion: 1, summary: 'done' })

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'cancel' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(409)
    expect(h.ledger.get(taskId)?.status).toBe('completed')
  })

  it('未知 taskId → 404；缺字段/未知 action → 400', async () => {
    const h = await controlHarness()
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const handler = handlerOf(routes, '/router/tasks/control')

    const ghost = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId: 'T-999', action: 'pause' }))
    await handler(ghost.req, ghost.res)
    expect(ghost.captured.status).toBe(404)

    const noTask = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ action: 'pause' }))
    await handler(noTask.req, noTask.res)
    expect(noTask.captured.status).toBe(400)

    const badAction = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId: 'T-000', action: 'reboot' }))
    await handler(badAction.req, badAction.res)
    expect(badAction.captured.status).toBe(400)

    const noAction = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId: 'T-000' }))
    await handler(noAction.req, noAction.res)
    expect(noAction.captured.status).toBe(400)
  })

  it('redispatch：带会话的任务补充「用户重派」并重投原会话（docVersion+1，requestId 升版）', async () => {
    const h = await controlHarness()
    const { taskId, sessionId } = await dispatchWorkerTask(h, '要重派的活')
    const promptsBefore = h.events.prompts.length

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'redispatch' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(h.ledger.get(taskId)?.docVersion).toBe(2)
    expect(h.ledger.get(taskId)?.sessionId).toBe(sessionId) // 重投原会话，不新建
    expect(h.events.prompts.length).toBe(promptsBefore + 1)
    const redelivered = h.events.prompts[h.events.prompts.length - 1]!
    expect(redelivered.requestId).toBe(`dispatch-${taskId}-v2`)
    expect(redelivered.sessionId).toBe(sessionId)
    expect(redelivered.text).toContain('用户重派')
  })

  it('redispatch 无会话的 queued 任务：锁内重派到新会话 → dispatched', async () => {
    const h = await controlHarness()
    const created = await h.ledger.createTask({
      title: '排队里的活',
      goal: '做完',
      acceptance: ['完成'],
      projectId: 'cwd:/proj',
      cwd: '/proj',
      role: 'worker',
      templateId: 'coder',
      dependsOn: [],
      acceptancePolicy: 'auto',
    })
    await h.ledger.transition(created.id, 'queued')
    // 任务书文档（真实链路里 dispatchTask 先 initTask；这里补齐到同一状态）
    await h.docs.initTask(created, '# 任务书\n排队里的活')
    const sessionsBefore = h.events.created.length

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId: created.id, action: 'redispatch' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(JSON.parse(exchange.captured.body!)).toEqual({ status: 'dispatched' })
    expect(h.events.created.length).toBe(sessionsBefore + 1)
    expect(h.ledger.get(created.id)?.status).toBe('dispatched')
  })

  it('redispatch 冻结时被拒 → 409 + 明确提示先解除冻结；不产生新投递', async () => {
    const h = await controlHarness()
    const { taskId } = await dispatchWorkerTask(h, '冻结期重派')
    await h.breaker!.freeze('infra 失败 3 次（测试注入）')
    const promptsBefore = h.events.prompts.length

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'redispatch' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(409)
    const body = JSON.parse(exchange.captured.body!) as { error: string }
    expect(body.error).toContain('解除冻结')
    expect(h.events.prompts.length).toBe(promptsBefore) // 冻结期零投递
    expect(h.ledger.get(taskId)?.docVersion).toBe(1) // 任务书不升版
  })

  it('redispatch 在终态上 → 409（补充即非法迁移）', async () => {
    const h = await controlHarness()
    const { taskId } = await dispatchWorkerTask(h, '完成后再重派')
    await h.ledger.transition(taskId, 'running')
    await h.ledger.complete(taskId, { docVersion: 1, summary: 'done' })

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'redispatch' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(409)
    expect(JSON.parse(exchange.captured.body!)).toMatchObject({ error: expect.stringContaining('终态') })
  })

  /* ── 验收动作（需求 §7，H2）：accept/reject/rework 经用户控制路由 ── */

  it('accept：user 策略待验收任务 → completed，完成卡入统一通知存储', async () => {
    const h = await controlHarness()
    const { taskId, sessionId } = await dispatchWorkerTask(h, '要验收的活', 'user')
    await h.ledger.transition(taskId, 'running')
    await h.core.completeTask(sessionId, taskId, { docVersion: 1, summary: '做完了' })
    expect(h.ledger.get(taskId)?.status).toBe('review-pending')
    const acceptanceCards = (await h.notifications.pending()).filter((c) => c.title.startsWith('待验收'))
    expect(acceptanceCards).toHaveLength(1)
    expect(acceptanceCards[0]!.actions.map((a) => a.action)).toContain('accept')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'accept' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(JSON.parse(exchange.captured.body!)).toEqual({ status: 'completed' })
    expect(h.ledger.get(taskId)?.status).toBe('completed')
    const completionCards = (await h.notifications.pending()).filter((c) => c.title === '要验收的活')
    expect(completionCards).toHaveLength(1)
  })

  it('reject：带 note 驳回 → running + note 落 progress + 返工约束重投原会话', async () => {
    const h = await controlHarness()
    const { taskId, sessionId } = await dispatchWorkerTask(h, '要驳回的活', 'user')
    await h.ledger.transition(taskId, 'running')
    await h.core.completeTask(sessionId, taskId, { docVersion: 1, summary: '做完了' })

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'reject', note: '缺变更日志' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(JSON.parse(exchange.captured.body!)).toEqual({ status: 'running' })
    expect(h.ledger.get(taskId)?.status).toBe('running')
    expect(h.ledger.get(taskId)?.progress).toBe('缺变更日志')
    const redelivery = h.events.prompts.find((p) => p.requestId === `dispatch-${taskId}-v2`)
    expect(redelivery?.sessionId).toBe(sessionId)
    expect(redelivery?.text).toContain('验收驳回返工')
    expect(redelivery?.text).toContain('缺变更日志')
  })

  it('rework：completed 任务退回重做 → running + 返工意见重投', async () => {
    const h = await controlHarness()
    const { taskId, sessionId } = await dispatchWorkerTask(h, '完成后返工的活')
    await h.ledger.transition(taskId, 'running')
    await h.ledger.complete(taskId, { docVersion: 1, summary: 'done' })

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'rework', note: '验收条件没达成' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(JSON.parse(exchange.captured.body!)).toEqual({ status: 'running' })
    expect(h.ledger.get(taskId)?.status).toBe('running')
    const redelivery = h.events.prompts.find((p) => p.requestId === `dispatch-${taskId}-v2`)
    expect(redelivery?.sessionId).toBe(sessionId)
    expect(redelivery?.text).toContain('退回重做')
  })

  it('验收守卫：非待验收 accept → 409；user 路由验 supervisor 策略 → 400；note 非字符串 → 400', async () => {
    const h = await controlHarness()
    const running = await dispatchWorkerTask(h, '还在跑的活', 'user')
    await h.ledger.transition(running.taskId, 'running')
    const supTask = await dispatchWorkerTask(h, '主管验收的活', 'supervisor')
    await h.ledger.transition(supTask.taskId, 'running')
    await h.core.completeTask(supTask.sessionId, supTask.taskId, { docVersion: 1, summary: '做完了' })

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const handler = handlerOf(routes, '/router/tasks/control')

    const notPending = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId: running.taskId, action: 'accept' }))
    await handler(notPending.req, notPending.res)
    expect(notPending.captured.status).toBe(409)

    const wrongPolicy = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId: supTask.taskId, action: 'accept' }))
    await handler(wrongPolicy.req, wrongPolicy.res)
    expect(wrongPolicy.captured.status).toBe(400)
    expect(h.ledger.get(supTask.taskId)?.status).toBe('review-pending')

    const badNote = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId: running.taskId, action: 'reject', note: 42 }))
    await handler(badNote.req, badNote.res)
    expect(badNote.captured.status).toBe(400)
  })
})

/* ────────────────────────── 解除冻结（POST /router/breaker/unfreeze） ────────────────────────── */

describe('POST /router/breaker/unfreeze（B4）', () => {
  it('冻结→解除：before 带冻结原因与时刻，after 未冻结；状态真解除', async () => {
    const h = await controlHarness()
    await h.breaker.freeze('infra 失败 3 次（测试注入）')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/breaker/unfreeze')
    await handlerOf(routes, '/router/breaker/unfreeze')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    const report = JSON.parse(exchange.captured.body!) as {
      before: { frozen: boolean; reason?: string; frozenAt?: number }
      after: { frozen: boolean }
    }
    expect(report.before.frozen).toBe(true)
    expect(report.before.reason).toBe('infra 失败 3 次（测试注入）')
    expect(typeof report.before.frozenAt).toBe('number')
    expect(report.after.frozen).toBe(false)
    expect((await h.breaker.state()).frozen).toBe(false)
  })

  it('未冻结时解除：before/after 都如实未冻结（幂等往返）', async () => {
    const h = await controlHarness()
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/breaker/unfreeze')
    await handlerOf(routes, '/router/breaker/unfreeze')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    const report = JSON.parse(exchange.captured.body!) as { before: { frozen: boolean }; after: { frozen: boolean } }
    expect(report.before.frozen).toBe(false)
    expect(report.after.frozen).toBe(false)
    expect(report.before).not.toHaveProperty('reason')
  })

  it('仅 POST：GET → 405', async () => {
    const h = await controlHarness()
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('GET', '/router/breaker/unfreeze')
    await handlerOf(routes, '/router/breaker/unfreeze')(exchange.req, exchange.res)
    expect(exchange.captured.status).toBe(405)
  })

  it('解冻即补派（M1）：冻结期间解锁的 queued 任务在 unfreeze 后自动出发', async () => {
    const h = await controlHarness()
    const dep = await dispatchWorkerTask(h, '依赖任务')
    await h.ledger.transition(dep.taskId, 'running')
    const created = await h.ledger.createTask({
      title: '解锁后待派的活',
      goal: '做完',
      acceptance: ['完成'],
      projectId: 'cwd:/proj',
      cwd: '/proj',
      role: 'worker',
      templateId: 'coder',
      dependsOn: [dep.taskId],
      acceptancePolicy: 'auto',
    })
    // 带未结依赖的任务创建即 queued，无需再迁移
    expect(h.ledger.get(created.id)?.status).toBe('queued')
    await h.docs.initTask(h.ledger.get(created.id)!, '# 任务书\n解锁后待派的活')
    await h.breaker.freeze('测试冻结')
    // 冻结期间完成依赖：解锁任务保持 queued（不绕闸）
    await h.core.completeTask(dep.sessionId, dep.taskId, { docVersion: 1, summary: '依赖完' })
    expect(h.ledger.get(created.id)?.status).toBe('queued')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/breaker/unfreeze')
    await handlerOf(routes, '/router/breaker/unfreeze')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(h.ledger.get(created.id)?.status).toBe('dispatched')
    expect(h.ledger.get(created.id)?.sessionId).toBeDefined()
  })
})

/* ────────────────────────── 作用域紧急暂停（POST /router/emergency-pause，v1.4） ────────────────────────── */

describe('POST /router/emergency-pause（v1.4：只停当前 Router 派出去的活）', () => {
  it('只停当前 Router 派出的任务及其下游子任务；别的 Router 会话的任务不碰', async () => {
    const interrupt = fakeInterruptFace()
    const h = await controlHarness({ interrupt })
    const mine = await dispatchBy(h, '我派出的活')
    const other = await dispatchBy(h, '别的 Router 派出的活', 'router-s-2')
    // 下游子任务：主管在自己的会话里派出去的
    const downstream = await dispatchBy(h, '下游子任务', mine.sessionId)

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause', JSON.stringify({ routerSessionId: 'router-s-1' }))
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    const report = JSON.parse(exchange.captured.body!) as ScopedPauseReport
    const stopped = report.tasks.map((t) => t.taskId).sort()
    expect(stopped).toEqual([mine.taskId, downstream.taskId].sort())
    expect(stopped).not.toContain(other.taskId)
    // 别的 Router 的任务原封不动
    expect(h.ledger.get(other.taskId)?.status).toBe('dispatched')
    // 中断只打作用域内的会话
    expect(interrupt.calls.map((c) => c.sessionId).sort()).toEqual(
      [mine.sessionId, downstream.sessionId].sort(),
    )
  })

  it('落账本 paused 后才断会话：迟到的 complete_task 被状态机拒掉', async () => {
    const interrupt = fakeInterruptFace()
    const h = await controlHarness({ interrupt })
    const task = await dispatchBy(h, '跑着的活')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause', JSON.stringify({ routerSessionId: 'router-s-1' }))
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    expect(h.ledger.get(task.taskId)?.status).toBe('paused')
    // paused 的出边没有 completed → 迟到提交被拒
    await expect(
      h.core.completeTask(task.sessionId, task.taskId, { docVersion: 1, summary: '抢交完成' }),
    ).rejects.toMatchObject({ code: 'illegal-transition' })
  })

  it('不碰全局熔断、不留全局标记：之后的新派发照常（用户指示：不影响后面新派活）', async () => {
    const interrupt = fakeInterruptFace()
    const h = await controlHarness({ interrupt })
    const task = await dispatchBy(h, '跑着的活')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause', JSON.stringify({ routerSessionId: 'router-s-1' }))
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    // 全局熔断没被冻结，也没写任何手动冻结标记
    expect((await h.breaker.state()).frozen).toBe(false)
    expect((await h.breaker.state()).reason).toBeUndefined()
    // 持久化文件里也没有任何冻结标记（文件不存在 = 从没写过冻结）
    const guardFile = await h.memfs.fs.readFile('/guard/guard-state.json').catch(() => undefined)
    if (guardFile !== undefined) {
      const parsed = JSON.parse(guardFile) as { frozen: boolean; reason?: string }
      expect(parsed.frozen).toBe(false)
      expect(parsed.reason).toBeUndefined()
    }
    // 之后的新派发不受影响
    const later = await h.core.dispatchTask('router-s-1', {
      title: '暂停之后新派的', goal: '继续做', acceptance: ['完成'], role: 'worker', templateId: 'coder',
    })
    expect(h.ledger.get(later.taskId)?.status).toBe('dispatched')
    expect(h.ledger.get(task.taskId)?.status).toBe('paused')
  })

  it('逐张落任务卡（用户面：能跳会话、能取消），失败项如实带明细', async () => {
    const interrupt = fakeInterruptFace({
      failFor: (sessionId) => (sessionId === 'session-2' ? new Error('agents 中断被宿主拒绝') : undefined),
    })
    const h = await controlHarness({ interrupt })
    const first = await dispatchBy(h, '停得下来的')
    const second = await dispatchBy(h, '停不下来的')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause', JSON.stringify({ routerSessionId: 'router-s-1' }))
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    const report = JSON.parse(exchange.captured.body!) as ScopedPauseReport
    expect(report.failedCount).toBe(1)
    expect(report.pausedCount).toBe(1)
    const failed = report.tasks.find((t) => t.taskId === second.taskId)!
    expect(failed.paused).toBe(true)
    expect(failed.interrupted).toBe(false)
    expect(failed.detail).toContain('agents 中断被宿主拒绝')
    const ok = report.tasks.find((t) => t.taskId === first.taskId)!
    expect(ok.paused).toBe(true)
    expect(ok.interrupted).toBe(true)
    // 逐任务卡落统一通知存储，失败项的卡如实带失败原因
    const cards = await h.notifications.list()
    expect(cards).toHaveLength(2)
    expect(cards.map((c) => c.taskId).sort()).toEqual([first.taskId, second.taskId].sort())
    const failedCard = cards.find((c) => c.taskId === second.taskId)!
    expect(failedCard.summary).toContain('agents 中断被宿主拒绝')
    // 暂停卡不给「重派」：那会把用户刚叫停的活立刻再开起来
    for (const card of cards) {
      expect(card.actions.map((a) => a.action)).toEqual(['open-session', 'cancel', 'ack'])
    }
  })

  it('告知 Router 会话「已暂停，等用户指示」（只是告知，不拦派发）', async () => {
    const interrupt = fakeInterruptFace()
    const h = await controlHarness({ interrupt })
    await dispatchBy(h, '跑着的活')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause', JSON.stringify({ routerSessionId: 'router-s-1' }))
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    const report = JSON.parse(exchange.captured.body!) as ScopedPauseReport
    expect(report.notified).toBe(true)
    const notice = h.events.prompts.find((p) => p.sessionId === 'router-s-1')
    expect(notice?.text).toContain('已暂停，等用户指示')
  })

  it('没有在跑的任务：空报告、不冻结、HTTP 200', async () => {
    const interrupt = fakeInterruptFace()
    const h = await controlHarness({ interrupt })

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause', JSON.stringify({ routerSessionId: 'router-s-1' }))
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    const report = JSON.parse(exchange.captured.body!) as ScopedPauseReport
    expect(report.tasks).toEqual([])
    expect(report.failedCount).toBe(0)
    expect(interrupt.calls).toEqual([])
    expect((await h.breaker.state()).frozen).toBe(false)
  })

  it('中断面未接线：逐项如实 failed（不冒充受理）', async () => {
    const h = await controlHarness() // 不注入 agents 中断面
    const task = await dispatchBy(h, '没人能停的')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause', JSON.stringify({ routerSessionId: 'router-s-1' }))
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    const report = JSON.parse(exchange.captured.body!) as ScopedPauseReport
    expect(report.failedCount).toBe(1)
    expect(report.tasks[0]!.interrupted).toBe(false)
    expect(report.tasks[0]!.detail).toContain('中断面')
  })

  it('缺 routerSessionId → 400（范围圈不出来就不猜）', async () => {
    const h = await controlHarness()
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause', JSON.stringify({}))
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)
    expect(exchange.captured.status).toBe(400)
  })

  it('坏 JSON / 非对象请求体 → 400（M4：统一 readJsonBody，不落 500）', async () => {
    const h = await controlHarness()
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const handler = handlerOf(routes, '/router/emergency-pause')
    for (const body of ['{broken', 'null', '42', '"str"', '[]']) {
      const exchange = fakeExchange('POST', '/router/emergency-pause', body)
      await handler(exchange.req, exchange.res)
      expect(exchange.captured.status, `body=${body}`).toBe(400)
    }
  })

  it('未登记的会话 id → 400（不拿任意会话 id 圈范围）', async () => {
    const h = await controlHarness()
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause', JSON.stringify({ routerSessionId: 'not-a-router' }))
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)
    expect(exchange.captured.status).toBe(400)
  })
})

/* ────────────────────────── 中断面与通知段的单元（B4 新领域件） ────────────────────────── */

describe('SessionBridge.interruptTaskSessions（B4 中断面，r8 形态）', () => {
  it('逐会话 cancel：cause {kind:hook,reason:emergency-stop} + {keepInbox:true}', async () => {
    const h = await guardCoreWith({ interruptFace: fakeInterruptFace().face })
    const interrupt = fakeInterruptFace()
    const bridge = h.bridge as SessionBridge & { interruptTaskSessions(ids: string[]): Promise<InterruptOutcome[]> }
    void interrupt
    const outcomes = await bridge.interruptTaskSessions(['s-1', 's-2'])
    expect(outcomes).toEqual([
      { sessionId: 's-1', outcome: 'accepted' },
      { sessionId: 's-2', outcome: 'accepted' },
    ])
  })

  it('冷会话（无 live agent）→ accepted no-op，detail 注明', async () => {
    const h = await guardCoreWith({ interruptFace: { get: () => undefined } })
    const bridge = h.bridge as SessionBridge & { interruptTaskSessions(ids: string[]): Promise<InterruptOutcome[]> }
    const outcomes = await bridge.interruptTaskSessions(['cold-1'])
    expect(outcomes).toEqual([{ sessionId: 'cold-1', outcome: 'accepted', detail: expect.stringContaining('冷会话') }])
  })

  it('cancel 抛错 → failed + detail（单会话失败不拖垮批量）', async () => {
    const face: AgentInterruptFace = {
      get: (sessionId) => ({
        cancel() {
          if (sessionId === 'bad') throw new Error('boom')
          return undefined
        },
      }),
    }
    const h = await guardCoreWith({ interruptFace: face })
    const bridge = h.bridge as SessionBridge & { interruptTaskSessions(ids: string[]): Promise<InterruptOutcome[]> }
    const outcomes = await bridge.interruptTaskSessions(['bad', 'good'])
    expect(outcomes[0]).toEqual({ sessionId: 'bad', outcome: 'failed', detail: 'boom' })
    expect(outcomes[1]).toEqual({ sessionId: 'good', outcome: 'accepted' })
  })

  it('未接线中断面 → 全部如实 failed（detail 指明未接线）', async () => {
    const h = await guardCoreWith({})
    const bridge = h.bridge as SessionBridge & { interruptTaskSessions(ids: string[]): Promise<InterruptOutcome[]> }
    const outcomes = await bridge.interruptTaskSessions(['s-1'])
    expect(outcomes).toEqual([{ sessionId: 's-1', outcome: 'failed', detail: expect.stringContaining('中断面') }])
  })
})

describe('guard 通知段（B4→B3 合并后：紧急暂停落统一 NotificationStore）', () => {
  it('紧急暂停通知卡入统一存储：push/pending/ack 与 B3 面一致', async () => {
    const h = await guardCoreWith({})
    let seq = 0
    const store = new NotificationStore({ fs: h.memfs.fs, path: '/guard/notifications.json', newId: () => `c-${++seq}`, now: () => 5000 })
    const card = await store.push({ kind: 'anomaly', title: '紧急暂停已执行', summary: '中断 1 个会话', actions: anomalyActions() })
    expect(card.kind).toBe('anomaly')
    expect((await store.pending())).toHaveLength(1)
    expect(await store.ack(card.cardId)).toBe(true)
    expect((await store.pending())).toHaveLength(0)
  })

  it('scopedPauseTargets：只取当前 Router 派发树里在跑且已绑会话的任务（含下游子任务）', () => {
    const records = [
      // Router 会话直接派的：进范围
      task({ id: 'T-1', title: '我派的', status: 'running', sessionId: 's-1', dispatchedBySessionId: 'router-1' }),
      // 主管在 s-1 里派的下游子任务：闭包进来
      task({ id: 'T-2', title: '下游', status: 'dispatched', sessionId: 's-2', dispatchedBySessionId: 's-1' }),
      // 别的 Router 派的：不进范围
      task({ id: 'T-3', title: '别人的', status: 'running', sessionId: 's-3', dispatchedBySessionId: 'router-2' }),
      // 同派发者但已结束 / 无会话：不打扰
      task({ id: 'T-4', title: '已结束', status: 'completed', sessionId: 's-4', dispatchedBySessionId: 'router-1' }),
      task({ id: 'T-5', title: '没会话', status: 'dispatched', sessionId: undefined, dispatchedBySessionId: 'router-1' }),
      // 旧任务（无派发溯源）：无法归属，不进范围
      task({ id: 'T-6', title: '旧的', status: 'running', sessionId: 's-6', dispatchedBySessionId: undefined }),
    ]
    const targets = scopedPauseTargets(records, 'router-1')
    expect(targets.map((t) => t.id).sort()).toEqual(['T-1', 'T-2'])
  })
})

/* ────────────────────────── spawn-mode 读写（v1.3 Task C2） ────────────────────────── */

describe('GET/POST /router/spawn-mode（v1.3 C2，规格 §1 volatile）', () => {
  it('路由挂上：GET 读初始值 cache-priority；POST minimal-face 写入后 GET 反映新值', async () => {
    const h = await controlHarness()
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)

    const read1 = fakeExchange('GET', '/router/spawn-mode')
    await handlerOf(routes, '/router/spawn-mode')(read1.req, read1.res)
    expect(read1.captured.status).toBe(200)
    expect(JSON.parse(read1.captured.body!)).toEqual({ mode: 'cache-priority' })

    const write = fakeExchange('POST', '/router/spawn-mode', JSON.stringify({ mode: 'minimal-face' }))
    await handlerOf(routes, '/router/spawn-mode')(write.req, write.res)
    expect(write.captured.status).toBe(200)
    expect(JSON.parse(write.captured.body!)).toEqual({ mode: 'minimal-face' })

    const read2 = fakeExchange('GET', '/router/spawn-mode')
    await handlerOf(routes, '/router/spawn-mode')(read2.req, read2.res)
    expect(JSON.parse(read2.captured.body!)).toEqual({ mode: 'minimal-face' })
    expect(h.spawnModeHolder.mode).toBe('minimal-face')
  })

  it('POST 写回 cache-priority 往返；非法值/缺字段 → 400', async () => {
    const h = await controlHarness()
    await h.deps.saveSpawnMode('minimal-face')
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const handler = handlerOf(routes, '/router/spawn-mode')

    const back = fakeExchange('POST', '/router/spawn-mode', JSON.stringify({ mode: 'cache-priority' }))
    await handler(back.req, back.res)
    expect(back.captured.status).toBe(200)
    expect(h.spawnModeHolder.mode).toBe('cache-priority')

    const bogus = fakeExchange('POST', '/router/spawn-mode', JSON.stringify({ mode: 'bogus' }))
    await handler(bogus.req, bogus.res)
    expect(bogus.captured.status).toBe(400)
    expect(JSON.parse(bogus.captured.body!)).toMatchObject({ error: expect.stringContaining('mode') })

    const missing = fakeExchange('POST', '/router/spawn-mode', JSON.stringify({}))
    await handler(missing.req, missing.res)
    expect(missing.captured.status).toBe(400)
    // 非法写入不动当前值
    expect(h.spawnModeHolder.mode).toBe('cache-priority')
  })

  it('仅 GET/POST：PUT → 405', async () => {
    const h = await controlHarness()
    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('PUT', '/router/spawn-mode')
    await handlerOf(routes, '/router/spawn-mode')(exchange.req, exchange.res)
    expect(exchange.captured.status).toBe(405)
  })
})
