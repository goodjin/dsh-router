/**
 * 工具角色层测试（计划 Task B3）。
 *
 * 三个纯逻辑面，全部不启宿主：
 *  1. assertCallerRole：角色×工具全矩阵 + 任务归属（执行类工具按 sessionId 匹配）；
 *  2. callerSessionId(exec)：exec.agent → sessionId 的映射（agent.id 优先、
 *     agent.session.id 兜底，取不到抛配置错误）；
 *  3. buildToolDefinitions：每个工具的薄壳行为——参数转交 RouterCore、render 出
 *     中文内容块、错误原样抛出。
 */

import { describe, expect, it } from 'vitest'

import type { TaskRecord } from '../src/shared/types.ts'
import { LedgerError } from '../src/host/ledger/errors.ts'
import {
  assertCallerRole,
  buildToolDefinitions,
  callerSessionId,
  toolsForRole,
  type CallerLedger,
  type RouterCore,
} from '../src/host/tools/index.ts'

/* ────────────────────────── 测试假件 ────────────────────────── */

let seq = 0
function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  seq += 1
  const now = seq
  return {
    id: patch.id ?? `T-${String(seq).padStart(3, '0')}`,
    title: patch.title ?? '示例任务',
    goal: patch.goal ?? '把事情做完',
    acceptance: patch.acceptance ?? ['有测试'],
    constraints: patch.constraints ?? [],
    projectId: patch.projectId ?? 'ws-1',
    cwd: patch.cwd ?? '/tmp/proj',
    role: patch.role ?? 'worker',
    templateId: patch.templateId ?? 'coder',
    parentId: patch.parentId,
    dependsOn: patch.dependsOn ?? [],
    sessionId: patch.sessionId,
    status: patch.status ?? 'running',
    progress: patch.progress,
    docVersion: patch.docVersion ?? 1,
    acceptancePolicy: patch.acceptancePolicy ?? 'auto',
    createdAt: patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
    result: patch.result,
  }
}

function ledgerOf(records: TaskRecord[]): CallerLedger {
  return { get: (id: string) => records.find((t) => t.id === id) }
}

function coreOf(calls: string[] = []): RouterCore {
  return {
    /** dispatch_task 描述内嵌的启用类型清单（v1.1 A4；测试断言它出现在描述里）。 */
    enabledTemplates: () => [
      { templateId: 'coder', name: '编码', description: '写代码', role: 'worker' as const },
      { templateId: 'lead', name: '主管', description: '再拆分', role: 'supervisor' as const },
    ],
    async dispatchTask(caller, input) {
      calls.push(`dispatch:${caller}:${input.title}:${input.role}`)
      return { taskId: 'T-001', docPath: '/tasks/T-001/task.v1.md', sessionId: 'worker-s-1' }
    },
    async supplementTask(caller, taskId) {
      calls.push(`supplement:${caller}:${taskId}`)
      return { docVersion: 2 }
    },
    async queryTasks(filter) {
      calls.push(`query:${JSON.stringify(filter ?? null)}`)
      return {
        tasks: [
          {
            taskId: 'T-001',
            title: '示例任务',
            goal: '把事情做完',
            status: 'running',
            role: 'worker',
            templateId: 'coder',
            waitingQuestions: 0,
            docVersion: 1,
          },
        ],
      }
    },
    async controlTask(caller, taskId, action) {
      calls.push(`control:${caller}:${taskId}:${action}`)
      return { status: action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'running' }
    },
    async searchHistory(_caller, query, scope) {
      calls.push(`search:${query}:${scope}`)
      // 真实现（B8）的形状：命中直传；失败/未配置才带注记。
      return { hits: [{ memoryRef: 'memory://project.md#e1', snippet: `命中 ${query}（${scope}）` }] }
    },
    async reportProgress(caller, taskId, progress) {
      calls.push(`progress:${caller}:${taskId}:${progress}`)
      return { ok: true }
    },
    async completeTask(caller, taskId, input) {
      calls.push(`complete:${caller}:${taskId}:v${input.docVersion}`)
      return { accepted: true, status: 'completed' }
    },
    async reportBlocker(caller, taskId) {
      calls.push(`blocker:${caller}:${taskId}`)
      return { status: 'blocked' }
    },
    listWorkerTypes() {
      return [
        { templateId: 'general', name: '通用 worker', description: '内置', role: 'worker' as const, enabled: true, origin: 'builtin' as const },
        { templateId: 'coder', name: '编码', description: '写代码', role: 'worker' as const, enabled: false, origin: 'user' as const },
      ]
    },
    async createWorkerType(caller, input) {
      calls.push(`createType:${caller}:${input.name}:${input.role ?? 'worker'}`)
      return { templateId: 'docs-writer', presetRegistered: true }
    },
    getTask: (id: string) => (id === 'T-001' ? task({ id: 'T-001', sessionId: 'worker-s-1' }) : undefined),
    async scopedPause(routerSessionId: string) {
      calls.push(`scoped-pause:${routerSessionId}`)
      return { tasks: [], pausedCount: 0, failedCount: 0, notified: true }
    },
  }
}

/** 执行一个工具并吞掉返回值，只留断言口。 */
async function run(def: { execute: (args: unknown, exec: unknown) => Promise<unknown> }, args: unknown, exec: unknown) {
  return def.execute(args, exec)
}

const execOf = (sessionId: string) => ({ agent: { id: sessionId } })

/* ────────────────────────── 角色矩阵 ────────────────────────── */

describe('toolsForRole：三份白名单', () => {
  it('router = 编排五件 + 类型两件（v1.1 C2：list/create_worker_types router 专属）', () => {
    expect(toolsForRole('router')).toEqual([
      'dispatch_task',
      'supplement_task',
      'query_tasks',
      'control_task',
      'search_history',
      'list_worker_types',
      'create_worker_type',
    ])
  })
  it('supervisor = router 集 + report_progress + complete_task（无 report_blocker）', () => {
    expect(toolsForRole('supervisor')).toEqual([
      'dispatch_task',
      'supplement_task',
      'query_tasks',
      'control_task',
      'search_history',
      'report_progress',
      'complete_task',
    ])
  })
  it('worker 只有执行三件', () => {
    expect(toolsForRole('worker')).toEqual(['report_progress', 'complete_task', 'report_blocker'])
  })
})

describe('assertCallerRole：角色×工具矩阵', () => {
  const empty = ledgerOf([])

  it('worker 调 dispatch_task 抛 role-forbidden', () => {
    expect(() => assertCallerRole('worker', 'dispatch_task', 'w-1', empty)).toThrowError(LedgerError)
    try {
      assertCallerRole('worker', 'dispatch_task', 'w-1', empty)
      expect.unreachable()
    } catch (error) {
      expect((error as LedgerError).code).toBe('role-forbidden')
    }
  })

  it('类型工具 router 专属（v1.1 C2）：supervisor/worker 调用抛 role-forbidden，router 放行', () => {
    for (const toolName of ['list_worker_types', 'create_worker_type'] as const) {
      expect(() => assertCallerRole('supervisor', toolName, 's-1', empty), `supervisor×${toolName}`).toThrowError(LedgerError)
      expect(() => assertCallerRole('worker', toolName, 'w-1', empty), `worker×${toolName}`).toThrowError(LedgerError)
      expect(() => assertCallerRole('router', toolName, 'r-1', empty), `router×${toolName}`).not.toThrow()
    }
  })

  it('执行层纵深防御（v1.1 C6）：主管会话再派 supervisor 角色被薄壳拒绝（不等核心闸门）', async () => {
    const def = buildToolDefinitions(coreOf(), 'supervisor').find((d) => d.name === 'dispatch_task')!
    try {
      await run(def, {
        title: '再套一层',
        goal: '主管之下派主管',
        acceptance: ['不该发生'],
        role: 'supervisor',
        templateId: 'lead',
      }, execOf('sup-s-1'))
      expect.unreachable()
    } catch (error) {
      expect((error as LedgerError).code).toBe('role-forbidden')
      expect((error as LedgerError).message).toContain('主管')
    }
    // 同一工具、worker 目标照常通过薄壳（转交核心）
    const value = (await run(def, {
      title: '正常子任务',
      goal: '派 worker',
      acceptance: ['可以'],
      role: 'worker',
      templateId: 'coder',
    }, execOf('sup-s-1'))) as { taskId: string }
    expect(value.taskId).toBe('T-001')
  })

  it('router/supervisor 都能派发', () => {
    expect(() => assertCallerRole('router', 'dispatch_task', 'r-1', empty)).not.toThrow()
    expect(() => assertCallerRole('supervisor', 'dispatch_task', 's-1', empty)).not.toThrow()
  })

  it('router 调 report_progress / complete_task / report_blocker 抛 role-forbidden', () => {
    expect(() => assertCallerRole('router', 'report_progress', 'r-1', empty)).toThrowError(LedgerError)
    expect(() => assertCallerRole('router', 'complete_task', 'r-1', empty)).toThrowError(LedgerError)
    expect(() => assertCallerRole('router', 'report_blocker', 'r-1', empty)).toThrowError(LedgerError)
  })

  it('worker 调 supplement_task / control_task / query_tasks / search_history 抛 role-forbidden', () => {
    for (const toolName of ['supplement_task', 'control_task', 'query_tasks', 'search_history'] as const) {
      expect(() => assertCallerRole('worker', toolName, 'w-1', empty), toolName).toThrowError(LedgerError)
    }
  })

  it('未知工具抛 unknown-tool', () => {
    expect(() => assertCallerRole('router', 'not_a_tool' as never, 'r-1', empty)).toThrowError(LedgerError)
    try {
      assertCallerRole('router', 'not_a_tool' as never, 'r-1', empty)
      expect.unreachable()
    } catch (error) {
      expect((error as LedgerError).code).toBe('unknown-tool')
    }
  })
})

describe('assertCallerRole：任务归属（执行类按 sessionId 匹配）', () => {
  const mine = task({ id: 'T-001', sessionId: 'worker-s-1' })
  const others = task({ id: 'T-002', sessionId: 'worker-s-2' })
  const ledger = ledgerOf([mine, others])

  it('worker 操作自己的任务放行', () => {
    expect(() => assertCallerRole('worker', 'report_progress', 'worker-s-1', ledger, 'T-001')).not.toThrow()
    expect(() => assertCallerRole('worker', 'complete_task', 'worker-s-1', ledger, 'T-001')).not.toThrow()
    expect(() => assertCallerRole('worker', 'report_blocker', 'worker-s-1', ledger, 'T-001')).not.toThrow()
  })

  it('worker 操作别人的任务抛 not-task-owner', () => {
    for (const toolName of ['report_progress', 'complete_task', 'report_blocker'] as const) {
      try {
        assertCallerRole('worker', toolName, 'worker-s-1', ledger, 'T-002')
        expect.unreachable(toolName)
      } catch (error) {
        expect((error as LedgerError).code).toBe('not-task-owner')
      }
    }
  })

  it('执行者对自己名下任务的 supplement/control 也被拒（编排工具只归非 worker）', () => {
    expect(() => assertCallerRole('worker', 'control_task', 'worker-s-1', ledger, 'T-001')).toThrowError(LedgerError)
  })

  it('router/supervisor 的编排工具不要求 sessionId 匹配（可管任何任务）', () => {
    expect(() => assertCallerRole('supervisor', 'supplement_task', 'sup-s-9', ledger, 'T-001')).not.toThrow()
    expect(() => assertCallerRole('router', 'control_task', 'router-s-9', ledger, 'T-001')).not.toThrow()
  })

  it('任务不存在抛 task-not-found', () => {
    try {
      assertCallerRole('worker', 'complete_task', 'worker-s-1', ledger, 'T-999')
      expect.unreachable()
    } catch (error) {
      expect((error as LedgerError).code).toBe('task-not-found')
    }
  })

  it('只查矩阵不查归属：不带 taskId 时执行类工具也放行（归属由核心兜底）', () => {
    expect(() => assertCallerRole('worker', 'complete_task', 'worker-s-1', ledger)).not.toThrow()
  })
})

/* ────────────────────────── exec.agent → sessionId ────────────────────────── */

describe('callerSessionId：exec.agent 映射', () => {
  it('优先取 agent.id（宿主 Agent.id 即 sessionId）', () => {
    expect(callerSessionId({ agent: { id: 's-1', session: { id: 'other' } } })).toBe('s-1')
  })
  it('agent.id 缺失时兜底 agent.session.id（r2 瀑布样例的字段）', () => {
    expect(callerSessionId({ agent: { session: { id: 's-2' } } })).toBe('s-2')
  })
  it('没有 agent（宿主外直调）抛 caller-unresolved 配置错误', () => {
    expect(() => callerSessionId({})).toThrowError(LedgerError)
    try {
      callerSessionId({})
      expect.unreachable()
    } catch (error) {
      expect((error as LedgerError).code).toBe('caller-unresolved')
    }
  })
  it('agent 身份字段类型不对也抛 caller-unresolved', () => {
    expect(() => callerSessionId({ agent: { id: 42 } })).toThrowError(LedgerError)
    expect(() => callerSessionId(undefined)).toThrowError(LedgerError)
  })
})

/* ────────────────────────── 工具薄壳 ────────────────────────── */

describe('buildToolDefinitions：薄壳行为', () => {
  it('按角色只产出白名单内的定义，name/description/schema 齐全', () => {
    const defs = buildToolDefinitions(coreOf(), 'router')
    expect(defs.map((d) => d.name)).toEqual(toolsForRole('router'))
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.parameters.type).toBe('object')
      expect(def.output.render).toBeTypeOf('function')
      expect(def.execute).toBeTypeOf('function')
    }
  })

  it('dispatch_task 描述内嵌当前启用类型清单（v1.1 A4：杜绝 general 式幻觉）', () => {
    const def = buildToolDefinitions(coreOf(), 'router').find((d) => d.name === 'dispatch_task')!
    expect(def.description).toContain('coder=编码')
    expect(def.description).toContain('lead=主管')
    expect(def.description).toContain('不要虚构')
    // 其他工具的描述不夹带清单
    const query = buildToolDefinitions(coreOf(), 'router').find((d) => d.name === 'query_tasks')!
    expect(query.description).not.toContain('coder=编码')
  })

  it('core 没提供 enabledTemplates 时描述退化为不带清单（不抛）', () => {
    const bare = { ...coreOf(), enabledTemplates: undefined } as unknown as RouterCore
    const def = buildToolDefinitions(bare, 'router').find((d) => d.name === 'dispatch_task')!
    expect(def.description).not.toContain('coder=编码')
    expect(def.description.length).toBeGreaterThan(0)
  })

  it('dispatch_task 描述是活的（v1.1 C2 类型变更刷新）：enabledTemplates 变化后重读即新清单', () => {
    let templates: { templateId: string; name: string; description: string; role: 'supervisor' | 'worker' }[] = [
      { templateId: 'coder', name: '编码', description: '写代码', role: 'worker' },
    ]
    const core = { ...coreOf(), enabledTemplates: () => templates } as unknown as RouterCore
    const def = buildToolDefinitions(core, 'router').find((d) => d.name === 'dispatch_task')!
    expect(def.description).toContain('coder=编码')
    expect(def.description).not.toContain('reviewer')
    templates = [...templates, { templateId: 'reviewer', name: '审查', description: '审交付', role: 'worker' }]
    expect(def.description).toContain('coder=编码')
    expect(def.description).toContain('reviewer=审查')
  })

  it('list_worker_types：转交 core.listWorkerTypes，render 标注启用态与来源（v1.1 C2）', async () => {
    const def = buildToolDefinitions(coreOf(), 'router').find((d) => d.name === 'list_worker_types')!
    const value = (await run(def, {}, execOf('router-s-1'))) as { types: unknown[] }
    expect(value.types).toHaveLength(2)
    const rendered = def.output.render({}, value) as { type: string; text: string }[]
    expect(rendered[0]!.text).toContain('general=通用 worker')
    expect(rendered[0]!.text).toContain('启用')
    expect(rendered[0]!.text).toContain('builtin')
    expect(rendered[0]!.text).toContain('停用')
  })

  it('create_worker_type：入参映射转交 core.createWorkerType，render 给出可派发结论（v1.1 C2）', async () => {
    const calls: string[] = []
    const def = buildToolDefinitions(coreOf(calls), 'router').find((d) => d.name === 'create_worker_type')!
    const value = (await run(def, {
      name: '文档写手',
      description: '写说明文档',
      role: 'worker',
      systemPrompt: '你是文档写手',
      skills: ['writing'],
    }, execOf('router-s-1'))) as { templateId: string; presetRegistered: boolean }
    expect(value).toEqual({ templateId: 'docs-writer', presetRegistered: true })
    expect(calls[0]).toBe('createType:router-s-1:文档写手:worker')
    const blocks = def.output.render({ name: '文档写手' }, value) as { type: string; text: string }[]
    expect(blocks[0]!.text).toContain('docs-writer')
    expect(blocks[0]!.text).toContain('可立即')
  })

  it('create_worker_type 预设注册失败时 render 明示派发会被拒（自报状态，不静默）', () => {
    const def = buildToolDefinitions(coreOf(), 'router').find((d) => d.name === 'create_worker_type')!
    const blocks = def.output.render({ name: '坏类型' }, { templateId: 'bad', presetRegistered: false }) as { text: string }[]
    expect(blocks[0]!.text).toContain('注册失败')
    expect(blocks[0]!.text).toContain('template-unavailable')
  })

  it('dispatch_task：参数转交 core.dispatchTask，返回 taskId/docPath/sessionId，render 中文', async () => {
    const calls: string[] = []
    const def = buildToolDefinitions(coreOf(calls), 'router').find((d) => d.name === 'dispatch_task')!
    const value = (await run(def, {
      title: '修复登录',
      goal: '登录不再 500',
      acceptance: ['回归测试通过'],
      role: 'worker',
      templateId: 'coder',
      dependsOn: [],
    }, execOf('router-s-1'))) as { taskId: string; docPath: string; sessionId?: string }
    expect(value).toEqual({ taskId: 'T-001', docPath: '/tasks/T-001/task.v1.md', sessionId: 'worker-s-1' })
    expect(calls[0]).toBe('dispatch:router-s-1:修复登录:worker')
    const blocks = def.output.render({}, value) as { type: string; text: string }[]
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.text).toContain('T-001')
    expect(blocks[0]!.text).toContain('任务书')
  })

  it('query_tasks：无参数也行，转交 core 并返回 tasks', async () => {
    const calls: string[] = []
    const def = buildToolDefinitions(coreOf(calls), 'router').find((d) => d.name === 'query_tasks')!
    const value = (await run(def, {}, execOf('router-s-1'))) as { tasks: unknown[] }
    expect(value.tasks).toHaveLength(1)
    expect(calls[0]).toContain('query:')
  })

  it('control_task：pause/resume/cancel 逐个转交', async () => {
    const calls: string[] = []
    const core = coreOf(calls)
    for (const action of ['pause', 'resume', 'cancel'] as const) {
      const def = buildToolDefinitions(core, 'router').find((d) => d.name === 'control_task')!
      await run(def, { taskId: 'T-001', action }, execOf('router-s-1'))
    }
    expect(calls).toEqual([
      'control:router-s-1:T-001:pause',
      'control:router-s-1:T-001:resume',
      'control:router-s-1:T-001:cancel',
    ])
  })

  it('search_history：命中直传 + render 出 memoryRef 与摘要（记忆已接线的真实现）', async () => {
    const def = buildToolDefinitions(coreOf(), 'router').find((d) => d.name === 'search_history')!
    const value = (await run(def, { query: '登录', scope: 'project' }, execOf('router-s-1'))) as {
      hits: { memoryRef: string; snippet: string }[]
      note?: string
    }
    expect(value.hits).toEqual([{ memoryRef: 'memory://project.md#e1', snippet: '命中 登录（project）' }])
    expect(value.note).toBeUndefined()
    const rendered = def.output.render({ query: '登录', scope: 'project' }, value)
    expect(rendered[0]!.text).toContain('memory://project.md#e1: 命中 登录（project）')
  })

  it('worker 名下 report_progress / complete_task / report_blocker 全链路', async () => {
    const calls: string[] = []
    const core = coreOf(calls)
    const progress = buildToolDefinitions(core, 'worker').find((d) => d.name === 'report_progress')!
    const complete = buildToolDefinitions(core, 'worker').find((d) => d.name === 'complete_task')!
    const blocker = buildToolDefinitions(core, 'worker').find((d) => d.name === 'report_blocker')!
    const progressValue = (await run(progress, { taskId: 'T-001', progress: '完成一半' }, execOf('worker-s-1'))) as {
      ok: boolean
    }
    const completeValue = (await run(complete, {
      taskId: 'T-001',
      docVersion: 1,
      summary: '做完了',
    }, execOf('worker-s-1'))) as { accepted: boolean; status: string }
    const blockerValue = (await run(blocker, { taskId: 'T-001', reason: '缺凭据' }, execOf('worker-s-1'))) as {
      status: string
    }
    expect(progressValue).toEqual({ ok: true })
    expect(completeValue).toEqual({ accepted: true, status: 'completed' })
    expect(blockerValue).toEqual({ status: 'blocked' })
    expect(calls).toEqual([
      'progress:worker-s-1:T-001:完成一半',
      'complete:worker-s-1:T-001:v1',
      'blocker:worker-s-1:T-001',
    ])
  })

  it('complete_task 的 render 对 review-pending 注明待谁验收', () => {
    const def = buildToolDefinitions(coreOf(), 'worker').find((d) => d.name === 'complete_task')!
    const blocks = def.output.render({}, { accepted: false, status: 'review-pending', pendingFrom: 'supervisor' }) as {
      text: string
    }[]
    expect(blocks[0]!.text).toContain('验收')
  })

  it('核心抛 LedgerError 时工具原样抛出（宿主折成 isError）', async () => {
    const failing: RouterCore = {
      ...coreOf(),
      async controlTask() {
        throw new LedgerError('illegal-transition', 'paused 状态不能取消')
      },
    }
    const def = buildToolDefinitions(failing, 'router').find((d) => d.name === 'control_task')!
    await expect(run(def, { taskId: 'T-001', action: 'cancel' }, execOf('router-s-1'))).rejects.toThrowError(LedgerError)
  })

  it('supplement_task：转交并返回新版本号，render 注明版本', async () => {
    const calls: string[] = []
    const def = buildToolDefinitions(coreOf(calls), 'supervisor').find((d) => d.name === 'supplement_task')!
    const value = (await run(def, { taskId: 'T-001', additions: ['补充：用 PostgreSQL'] }, execOf('sup-s-1'))) as {
      docVersion: number
    }
    expect(value).toEqual({ docVersion: 2 })
    expect(calls[0]).toBe('supplement:sup-s-1:T-001')
    const blocks = def.output.render({}, value) as { text: string }[]
    expect(blocks[0]!.text).toContain('v2')
  })
})
