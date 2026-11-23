/**
 * 派发工具 router_dispatch 测试（全自动注入）。
 *
 * brief 命名断言：
 *  - dispatch_composes_duty：初始指令 = 职责说明 + 任务 + 根会话 + 报告链要点，
 *    代码拼装、不依赖模型自觉。
 *  - dispatch_spawns_and_records：spawn/fork 经 subagents.startActivation（provider、
 *    prompt、parent、maxDepth 2、delivery parent），成功后自动登记分工记录
 *    （关联 childId 会话、待处理标签、正文 = 拼装指令）。
 *  - dispatch_failure_edges：角色不存在/无调用方/无子代理服务 → 拒绝且不创建子会话；
 *    spawn 失败 → 不落记录；spawn 成功但记录失败 → 返回 childId + recordError 不抛。
 *  - dispatch_bad_args：空任务/非法方式 → INVALID_INPUT。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { buildDispatchTool, composeDispatchInstruction, type SubagentsFace } from '../../src/collaboration/dispatch.ts'
import type { ToolDefinition } from '../../src/collaboration/tools.ts'
import { createRecordStore } from '../../src/collaboration/records.ts'
import { createRoleStore } from '../../src/collaboration/roles.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

interface Started {
  provider: string
  label: string | undefined
  promptText: string
  parent: unknown
  maxDepth: number | undefined
  signal: unknown
  delivery: string
}

function fakeSubagents(childId = 'child-1'): { face: SubagentsFace; started: () => Started | undefined; failWith?: (e: Error) => void; setFail(e: Error | undefined): void } {
  let captured: Started | undefined
  let fail: Error | undefined
  const face: SubagentsFace = {
    async startActivation(request) {
      if (fail !== undefined) throw fail
      captured = {
        provider: request.provider,
        label: request.label,
        promptText: (request.request.prompt[0] as { text: string }).text,
        parent: request.request.parent,
        maxDepth: (request.request as { maxDepth?: number }).maxDepth,
        signal: request.signal,
        delivery: request.delivery,
      }
      return { childId }
    },
  }
  return { face, started: () => captured, setFail: (e) => { fail = e } }
}

async function makeDeps(): Promise<{ records: ReturnType<typeof createRecordStore>; roles: ReturnType<typeof createRoleStore>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'router-dispatch-'))
  roots.push(dir)
  return { records: createRecordStore(dir), roles: createRoleStore(dir), dir }
}

const EXEC = { agent: { session: 'parent-session-1' } }

/** 建一条任务说明记录，返回其 taskId（分工必须引用已存在的任务记录）。 */
async function makeTask(records: ReturnType<typeof createRecordStore>): Promise<string> {
  const saved = await records.create('root-1', { kind: 'task', title: '登录改造', body: '目标' })
  return saved.record.taskId
}

const BASE_ARGS = { rootSessionId: 'root-1', taskId: '11111111-1111-4111-8111-111111111111', teamAdvice: { assessment: '两个页面可并行，联动验收', roles: [{role: '前端程序员', count: 2, reason: '两个页面可独立实现'}] }, role: '主管', task: '改造登录模块', mode: 'spawn' }

async function run(tool: ToolDefinition, args: unknown, exec: unknown = EXEC): Promise<unknown> {
  return tool.execute(args, exec)
}

describe('dispatch_composes_duty — 代码拼装初始指令', () => {
  it('职责说明 + 任务 + 根会话 + 报告链要点都在指令里', () => {
    const text = composeDispatchInstruction({
      role: { name: '执行者', description: '接受分工后独立完成具体工作。' },
      task: '改造登录模块',
      rootSessionId: 'root-1',
    })
    expect(text).toContain('执行者')
    expect(text).toContain('接受分工后独立完成具体工作。')
    expect(text).toContain('改造登录模块')
    expect(text).toContain('root-1')
    expect(text).toContain('报告')
  })
})

describe('dispatch_spawns_and_records — 创建子会话并登记分工记录', () => {
  it('spawn：startActivation 收到 provider/prompt/parent/maxDepth/delivery；分工记录带 childId 会话与待处理标签', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '主管', description: '拆解并汇总。' })
    const taskId = await makeTask(records)
    const sub = fakeSubagents('child-9')
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    const result = (await run(tool, { ...BASE_ARGS, taskId })) as { childId: string; record: { taskId: string; recordId: string } }
    expect(result.childId).toBe('child-9')
    const started = sub.started()!
    expect(started.provider).toBe('spawn')
    expect(started.promptText).toContain('拆解并汇总。')
    expect(started.promptText).toContain('改造登录模块')
    expect(started.parent).toBe(EXEC.agent)
    expect(started.maxDepth).toBe(2)
    expect(started.delivery).toBe('parent')
    // 分工记录自动登记：关联 childId、工作标签待处理、正文 = 拼装指令。
    const list = await records.list('root-1', { taskId, kind: 'assignment' })
    expect(list).toHaveLength(1)
    const record = list[0]!
    expect(record.workLabel).toBe('待处理')
    expect(record.sessions).toEqual([{ sessionId: 'child-9', label: '主管' }])
    expect(record.body).toContain('拆解并汇总。')
    expect(result.record.taskId).toBe(taskId)
    expect(result.record.recordId).toBe(record.id)
  })

  it('fork：provider 传 fork（带父级上下文的派发方式）', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '调研员', description: '只调研不改动。' })
    const taskId = await makeTask(records)
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await run(tool, { ...BASE_ARGS, taskId, role: '调研员', mode: 'fork' })
    expect(sub.started()!.provider).toBe('fork')
  })
})

describe('dispatch_signal — startActivation 必带真实 AbortSignal', () => {
  // 宿主 dsh-subagent.startActivation 内部 spec.signal.throwIfAborted() 非可选，
  // 传 undefined 即「Cannot read properties of undefined (reading 'throwIfAborted')」。
  it('exec.signal 存在时透传调用方 turn 的 signal', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '主管', description: 'd' })
    const taskId = await makeTask(records)
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    const controller = new AbortController()
    await run(tool, { ...BASE_ARGS, taskId }, { agent: EXEC.agent, signal: controller.signal })
    expect(sub.started()!.signal).toBe(controller.signal)
  })

  it('exec.signal 缺席时兜底插件级 AbortSignal（不再传 undefined）', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '主管', description: 'd' })
    const taskId = await makeTask(records)
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await run(tool, { ...BASE_ARGS, taskId })
    expect(sub.started()!.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('dispatch_failure_edges — 失败边界', () => {
  it('角色不存在 → NOT_FOUND，不创建子会话', async () => {
    const { records, roles } = await makeDeps()
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await expect(run(tool, { ...BASE_ARGS, role: '不存在' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(sub.started()).toBeUndefined()
    expect(await records.list('root-1')).toEqual([])
  })

  it('无调用方（exec.agent 缺席）→ 拒绝且不创建', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '主管', description: 'd' })
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await expect(run(tool, BASE_ARGS, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(sub.started()).toBeUndefined()
  })

  it('子代理服务缺席 → 明确报错', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '主管', description: 'd' })
    const tool = buildDispatchTool({ records, roles })
    await expect(run(tool, BASE_ARGS)).rejects.toThrow(/subagents/)
  })

  it('spawn 失败 → 错误上抛，不落分工记录', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '主管', description: 'd' })
    const sub = fakeSubagents()
    sub.setFail(new Error('activation limit'))
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await expect(run(tool, BASE_ARGS)).rejects.toThrow(/activation limit/)
    expect(await records.list('root-1')).toEqual([])
  })

  it('spawn 成功但登记记录失败 → 返回 childId 与 recordError，不抛（子会话已存在不能丢）', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '主管', description: 'd' })
    const failingRecords = {
      ...records,
      async create() {
        throw new Error('disk full')
      },
    }
    const sub = fakeSubagents('child-77')
    const tool = buildDispatchTool({ records: failingRecords, roles, subagents: sub.face })
    const result = (await run(tool, BASE_ARGS)) as { childId: string; recordError: string }
    expect(result.childId).toBe('child-77')
    expect(result.recordError).toContain('disk full')
  })
})

describe('dispatch_bad_args — 参数校验', () => {
  it('空任务 / 非法方式 / 空 taskId → INVALID_INPUT', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '主管', description: 'd' })
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await expect(run(tool, { ...BASE_ARGS, task: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(run(tool, { ...BASE_ARGS, mode: 'teleport' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(run(tool, { ...BASE_ARGS, taskId: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(sub.started()).toBeUndefined()
  })
})

it('首次建议进入主管指令；同一任务后续直接交原主管，投递失败不换队', async () => {
  const {records, roles} = await makeDeps()
  await roles.save({name:'主管', description:'负责组织团队'})
  const taskId = await makeTask(records)
  const sub = fakeSubagents('original')
  const startActivation = vi.fn(sub.face.startActivation)
  const sendMessage = vi.fn(async (..._args: unknown[]) => 'receipt')
  const tool = buildDispatchTool({records,roles,subagents:{startActivation,sendMessage}})
  const args = {...BASE_ARGS,taskId}
  await expect(run(tool,{...args,teamAdvice:undefined})).rejects.toThrow(/组队建议/)
  await expect(run(tool,{...args,teamAdvice:{assessment:'小',roles:[{role:'前端程序员',count:0,reason:'小'}]}})).rejects.toThrow()
  await run(tool,args)
  expect(sub.started()?.promptText).toContain('前端程序员 × 2：两个页面可独立实现')
  expect(sub.started()?.promptText).toContain('由主管自行决定')
  const follow = {...args, task:'新增导出：验收 CSV 文件', teamAdvice:undefined}
  await expect(run(tool,follow)).resolves.toMatchObject({childId:'original',messageId:'receipt'})
  expect(sendMessage).toHaveBeenCalledWith(EXEC.agent,'original',expect.arrayContaining([{type:'text',text:expect.stringContaining(follow.task)}]),expect.anything())
  sendMessage.mockRejectedValueOnce(new Error('offline'))
  await expect(run(tool,follow)).rejects.toThrow(/交接/)
  expect(startActivation).toHaveBeenCalledTimes(1)
  expect(await records.list('root-1',{taskId,kind:'assignment'})).toHaveLength(1)
})

it('不同任务各派主管；同任务有多个历史主管先确认，不猜一个', async () => {
  const { records, roles } = await makeDeps()
  await roles.save({ name: '主管', description: '组织团队' })
  const first = await makeTask(records)
  const second = await makeTask(records)
  const startActivation = vi.fn().mockResolvedValueOnce({childId:'a'}).mockResolvedValueOnce({childId:'b'})
  const sendMessage = vi.fn()
  const tool = buildDispatchTool({records, roles, subagents:{startActivation, sendMessage}})
  await run(tool,{...BASE_ARGS,taskId:first}); await run(tool,{...BASE_ARGS,taskId:second})
  await records.create('root-1',{kind:'assignment',taskId:first,title:'旧主管',body:'',sessions:[{label:'主管',sessionId:'c'}]})
  await expect(run(tool,{...BASE_ARGS,taskId:first})).rejects.toThrow(/多个主管/)
  expect(startActivation).toHaveBeenCalledTimes(2); expect(sendMessage).not.toHaveBeenCalled()
})
