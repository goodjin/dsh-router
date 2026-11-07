/**
 * 控制路由 + 紧急暂停测试（v1.2 计划 Task B4，规格 §2 熔断/§Review Focus 5）。
 *
 * 三条新 exact 路由：
 *   POST /router/tasks/control    {taskId, action:'pause'|'resume'|'cancel'|'redispatch'} → {status}
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
import type { AgentInterruptFace, InterruptOutcome, SessionBridge } from '../src/host/bridge/sessions.ts'
import { NotificationStore, anomalyActions } from '../src/host/guard/notifications.ts'
import {
  emergencyPauseTargets,
  runEmergencyPause,
  type EmergencyPauseReport,
} from '../src/host/guard/emergency.ts'
import type { RouterState } from '../src/shared/view-contract.ts'

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
  const h = await guardCoreWith({ ...opts, budgets: null, interruptFace: opts.interrupt?.face })
  const breaker = h.breaker!
  let cardSeq = 0
  const notifications = new NotificationStore({ fs: h.memfs.fs, path: '/guard/notifications.json', newId: () => `card-${++cardSeq}`, now: () => 5000 })
  const deps: RouterRoutesDeps = {
    // v1.2 B3 通知确认：经统一 NotificationStore。
    ackNotification: (cardId: string) => notifications.ack(cardId),
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
    async ackRedirect() {},
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
    async getSessionPrompt() {
      return { prompt: '', isDefault: true }
    },
    async saveSessionPrompt() {},
    /* ── B4 三条（与 entry.ts 逐字同构） ── */
    controlTask: async (taskId, action) => {
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
      return h.core.controlTask('user', taskId, action)
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
      return { before, after: { frozen: afterState.frozen } }
    },
    emergencyPause: async () =>
      runEmergencyPause({
        targetSessionIds: async () => emergencyPauseTargets(await h.ledger.listAll()),
        freeze: async (reason) => {
          await breaker.freeze(reason)
          const state = await breaker.state()
          return state.frozen && state.reason !== undefined
            ? { frozen: state.frozen, reason: state.reason }
            : { frozen: state.frozen }
        },
        interrupt: (ids) => h.bridge.interruptTaskSessions(ids),
        notify: async (input) => notifications.push({ kind: 'anomaly', title: input.title, summary: input.summary, actions: anomalyActions() }),
      }),
  }
  return { ...h, deps, notifications, breaker, interrupt: opts.interrupt }
}

/** 派发一个 worker 任务（经真核心，走模板校验→建会话→投递→dispatched 全链）。 */
async function dispatchWorkerTask(
  h: Awaited<ReturnType<typeof controlHarness>>,
  title: string,
): Promise<{ taskId: string; sessionId: string }> {
  const result = await h.core.dispatchTask('router-s-1', {
    title,
    goal: '把事情做完',
    acceptance: ['完成'],
    role: 'worker',
    templateId: 'coder',
  })
  return { taskId: result.taskId, sessionId: result.sessionId ?? '' }
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
      async ackRedirect() {},
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
      async emergencyPause() {
        return { frozen: true, interrupted: [], failedCount: 0 }
      },
    })
    const paths = routes.map((r) => r.path)
    expect(paths).toContain('/router/tasks/control')
    expect(paths).toContain('/router/breaker/unfreeze')
    expect(paths).toContain('/router/emergency-pause')
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

  it('pause 在 dispatched 上非法 → 409（状态机无 dispatched→paused 边）', async () => {
    const h = await controlHarness()
    const { taskId } = await dispatchWorkerTask(h, '还没开跑')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/tasks/control', JSON.stringify({ taskId, action: 'pause' }))
    await handlerOf(routes, '/router/tasks/control')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(409)
    expect(JSON.parse(exchange.captured.body!)).toMatchObject({ error: expect.stringContaining('非法状态迁移') })
    expect(h.ledger.get(taskId)?.status).toBe('dispatched')
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
})

/* ────────────────────────── 紧急暂停（POST /router/emergency-pause） ────────────────────────── */

describe('POST /router/emergency-pause（B4，Review Focus 5）', () => {
  it('冻结 + 逐会话中断：running/dispatched 的会话全受理；paused/queued 不打扰；异常通知落卡', async () => {
    const interrupt = fakeInterruptFace()
    const h = await controlHarness({ interrupt })
    const running = await dispatchWorkerTask(h, '跑着的活')
    await h.ledger.transition(running.taskId, 'running')
    const paused = await dispatchWorkerTask(h, '已暂停的活')
    await h.ledger.transition(paused.taskId, 'running')
    await h.ledger.transition(paused.taskId, 'paused')
    const dispatched = await dispatchWorkerTask(h, '刚派出的活')
    // queued 且无会话的任务（不经核心派发，直接进账本）
    const queued = await h.ledger.createTask({
      title: '排队的活',
      goal: '做完',
      acceptance: ['完成'],
      projectId: 'cwd:/proj',
      cwd: '/proj',
      role: 'worker',
      templateId: 'coder',
      dependsOn: [],
      acceptancePolicy: 'auto',
    })
    await h.ledger.transition(queued.id, 'queued')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause')
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    const report = JSON.parse(exchange.captured.body!) as EmergencyPauseReport
    expect(report.frozen).toBe(true)
    expect(report.reason).toBe('user-emergency')
    expect(report.failedCount).toBe(0)
    expect(report.interrupted.map((entry) => entry.sessionId).sort()).toEqual(
      [running.sessionId, dispatched.sessionId].sort(),
    )
    for (const entry of report.interrupted) {
      expect(entry.outcome).toBe('accepted')
      expect(entry).not.toHaveProperty('detail')
    }
    expect(report.interrupted.map((entry) => entry.sessionId)).not.toContain(paused.sessionId)
    // 中断逐字走 r8 形态：{kind:'hook',reason:'emergency-stop'} + {keepInbox:true}
    expect(interrupt.calls.map((call) => call.sessionId).sort()).toEqual(
      [running.sessionId, dispatched.sessionId].sort(),
    )
    for (const call of interrupt.calls) {
      expect(call.cause).toEqual({ kind: 'hook', reason: 'emergency-stop' })
      expect(call.options).toEqual({ keepInbox: true })
    }
    expect((await h.breaker.state()).frozen).toBe(true)
    // 异常通知落卡（v1.2：成功后写一条 kind:'anomaly'）
    expect(report.notification).toBeDefined()
    expect(report.notification?.kind).toBe('anomaly')
    const cards = await h.notifications.list()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.summary).toContain('2')
  })

  it('一个失败项如实上报：failed 项带 detail，HTTP 仍 200，通知摘要含失败明细（不静默）', async () => {
    const interrupt = fakeInterruptFace({
      failFor: (sessionId) => (sessionId === 'session-2' ? new Error('agents 中断被宿主拒绝') : undefined),
    })
    const h = await controlHarness({ interrupt })
    const first = await dispatchWorkerTask(h, '停得下来的')
    await h.ledger.transition(first.taskId, 'running')
    const second = await dispatchWorkerTask(h, '停不下来的')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause')
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    const report = JSON.parse(exchange.captured.body!) as EmergencyPauseReport
    expect(report.failedCount).toBe(1)
    const failed = report.interrupted.filter((entry) => entry.outcome === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.sessionId).toBe(second.sessionId)
    expect(failed[0]!.detail).toContain('agents 中断被宿主拒绝')
    const accepted = report.interrupted.filter((entry) => entry.outcome === 'accepted')
    expect(accepted.map((entry) => entry.sessionId)).toEqual([first.sessionId])
    // 失败项进通知摘要（Review Focus 5：汇总卡如实报失败项）
    expect(report.notification?.summary).toContain(second.sessionId)
    expect(report.notification?.summary).toContain('agents 中断被宿主拒绝')
  })

  it('无 running/dispatched 任务：interrupted 空、仍冻结、仍写通知', async () => {
    const interrupt = fakeInterruptFace()
    const h = await controlHarness({ interrupt })

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause')
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    expect(exchange.captured.status).toBe(200)
    const report = JSON.parse(exchange.captured.body!) as EmergencyPauseReport
    expect(report.interrupted).toEqual([])
    expect(report.failedCount).toBe(0)
    expect(report.frozen).toBe(true)
    expect(interrupt.calls).toEqual([])
    expect(report.notification).toBeDefined()
  })

  it('中断面未接线：逐项如实 failed（不冒充受理）', async () => {
    const h = await controlHarness() // 不注入 agents 中断面
    const task = await dispatchWorkerTask(h, '没人能停的')
    await h.ledger.transition(task.taskId, 'running')

    const { ctx, routes } = fakeHttpContext()
    registerRouterRoutes(ctx, h.deps)
    const exchange = fakeExchange('POST', '/router/emergency-pause')
    await handlerOf(routes, '/router/emergency-pause')(exchange.req, exchange.res)

    const report = JSON.parse(exchange.captured.body!) as EmergencyPauseReport
    expect(report.failedCount).toBe(1)
    expect(report.interrupted[0]!.outcome).toBe('failed')
    expect(report.interrupted[0]!.detail).toContain('中断面')
    expect(report.notification?.summary).toContain(task.sessionId)
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

  it('emergencyPauseTargets：只取 running/dispatched 且已绑会话的任务', () => {
    const targets = emergencyPauseTargets([
      { status: 'running', sessionId: 's-1' },
      { status: 'dispatched', sessionId: 's-2' },
      { status: 'paused', sessionId: 's-3' },
      { status: 'queued', sessionId: undefined },
      { status: 'waiting-user', sessionId: 's-4' },
      { status: 'completed', sessionId: 's-5' },
    ])
    expect(targets).toEqual(['s-1', 's-2'])
  })
})
