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
 *  - 两级模型（2026-11-24）：taskId 可选（省略即自动建任务，taskTitle 必填、parentTaskId 挂父任务）；
 *    continue 泛化到任意子会话（按 expectedChildId 找归属分工），追加要求自动拼进任务描述；
 *    归属不唯一时拒绝不猜。
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

/** 两级模型默认参数：不给 taskId → 自动建任务（taskTitle 必填）；角色是执行型 worker。 */
const BASE_ARGS = { rootSessionId: 'root-1', role: '执行者', task: '改造登录模块', mode: 'spawn', taskTitle: '改造登录模块' }

async function run(tool: ToolDefinition, args: unknown, exec: unknown = EXEC): Promise<unknown> {
  return tool.execute(args, exec)
}

describe('dispatch_composes_duty — 代码拼装初始指令（职责不在指令里）', () => {
  it('任务 + taskId + 根会话 + 报告链要点都在指令里；角色名与职责正文不在', () => {
    const text = composeDispatchInstruction({
      task: '改造登录模块',
      taskId: 'task-1',
      rootSessionId: 'root-1',
    })
    expect(text).toContain('task-1')
    expect(text).toContain('改造登录模块')
    expect(text).toContain('root-1')
    expect(text).toContain('报告')
    // 职责与角色名进的是系统提示词，不是初始指令。
    expect(text).not.toContain('执行者')
    expect(text).not.toContain('接受分工后独立完成具体工作。')
    expect(text).toContain('你的角色与职责')
  })
})

describe('dispatch_spawns_and_records — 创建子会话并登记分工记录', () => {
  it('spawn：startActivation 收到 provider/prompt/parent/maxDepth/delivery；分工记录带 childId 会话与待处理标签', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '执行者', description: '拆解并汇总。' })
    const taskId = await makeTask(records)
    const sub = fakeSubagents('child-9')
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    const result = (await run(tool, { ...BASE_ARGS, taskId })) as { childId: string; record: { taskId: string; recordId: string } }
    expect(result.childId).toBe('child-9')
    const started = sub.started()!
    expect(started.provider).toBe('spawn')
    // 初始指令只有任务与通用约定：角色名与职责正文不在里面（职责进系统提示词）。
    expect(started.promptText).toContain('改造登录模块')
    expect(started.promptText).not.toContain('拆解并汇总。')
    expect(started.promptText).not.toContain('执行者')
    expect(started.parent).toBe(EXEC.agent)
    expect(started.maxDepth).toBe(2)
    expect(started.delivery).toBe('parent')
    // 分工记录自动登记：关联 childId、工作标签待处理、正文 = 拼装指令。
    const list = await records.list('root-1', { taskId, kind: 'assignment' })
    expect(list).toHaveLength(1)
    const record = list[0]!
    expect(record.workLabel).toBe('待处理')
    expect(record.sessions).toEqual([{ sessionId: 'child-9', label: '执行者' }])
    expect(record.body).toContain('改造登录模块')
    expect(record.body).not.toContain('拆解并汇总。')
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
    await roles.save({ name: '执行者', description: 'd' })
    const taskId = await makeTask(records)
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    const controller = new AbortController()
    await run(tool, { ...BASE_ARGS, taskId }, { agent: EXEC.agent, signal: controller.signal })
    expect(sub.started()!.signal).toBe(controller.signal)
  })

  it('exec.signal 缺席时兜底插件级 AbortSignal（不再传 undefined）', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '执行者', description: 'd' })
    const taskId = await makeTask(records)
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await run(tool, { ...BASE_ARGS, taskId })
    expect(sub.started()!.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('dispatch_failure_edges — 失败边界', () => {
  it('角色参数也可传角色 ID（按名解析不到时按 ID 解析）；分工记录标签仍记角色名', async () => {
    const { records, roles } = await makeDeps()
    const saved = await roles.save({ name: '执行者', description: '职责' })
    const taskId = await makeTask(records)
    const sub = fakeSubagents('child-by-id')
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    const result = (await run(tool, { ...BASE_ARGS, taskId, role: saved.id })) as { childId: string }
    expect(result.childId).toBe('child-by-id')
    const list = await records.list('root-1', { taskId, kind: 'assignment' })
    expect(list[0]!.sessions).toEqual([{ sessionId: 'child-by-id', label: '执行者' }])
  })

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
    await roles.save({ name: '执行者', description: 'd' })
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await expect(run(tool, BASE_ARGS, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(sub.started()).toBeUndefined()
  })

  it('子代理服务缺席 → 明确报错', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '执行者', description: 'd' })
    const tool = buildDispatchTool({ records, roles })
    await expect(run(tool, BASE_ARGS)).rejects.toThrow(/subagents/)
  })

  it('spawn 失败 → 错误上抛，不落分工记录（自动建的任务留下是准确的：任务存在、尚未派发，可带 taskId 重派）', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '执行者', description: 'd' })
    const sub = fakeSubagents()
    sub.setFail(new Error('activation limit'))
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await expect(run(tool, BASE_ARGS)).rejects.toThrow(/activation limit/)
    expect(await records.list('root-1', { kind: 'assignment' })).toEqual([])
    expect(await records.list('root-1', { kind: 'task' })).toHaveLength(1)
  })

  it('spawn 成功但登记记录失败 → 返回 childId 与 recordError，不抛（子会话已存在不能丢）', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '执行者', description: 'd' })
    const failingRecords = {
      ...records,
      async create(root: string, input: Parameters<typeof records.create>[1]) {
        if (input.kind === 'assignment') throw new Error('disk full')
        return records.create(root, input)
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
    await roles.save({ name: '执行者', description: 'd' })
    const sub = fakeSubagents()
    const tool = buildDispatchTool({ records, roles, subagents: sub.face })
    await expect(run(tool, { ...BASE_ARGS, task: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(run(tool, { ...BASE_ARGS, mode: 'teleport' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(run(tool, { ...BASE_ARGS, taskId: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(sub.started()).toBeUndefined()
  })
})

it('两级模型：省略 taskId → 自动建任务（taskTitle 必填；parentTaskId 挂主任务）并关联子会话；指令带新 taskId', async () => {
  const {records, roles} = await makeDeps()
  await roles.save({name:'执行者', description:'干活'})
  const main = await makeTask(records)
  const sub = fakeSubagents('child-new')
  const tool = buildDispatchTool({records,roles,subagents:sub.face})
  // 缺 taskTitle → 拒绝，什么都不写
  const {taskTitle: _omit, ...noTitle} = BASE_ARGS
  await expect(run(tool,{...noTitle, parentTaskId: main})).rejects.toThrow(/taskTitle/)
  expect(await records.list('root-1',{kind:'task'})).toHaveLength(1)
  // 给 parentTaskId → 新任务挂主任务下
  const result = (await run(tool,{...BASE_ARGS, taskTitle:'子任务A', parentTaskId: main})) as {childId:string; taskId:string; createdTask:boolean}
  expect(result.createdTask).toBe(true)
  expect(result.taskId).not.toBe(main)
  const tasks = await records.list('root-1',{kind:'task'})
  const created = tasks.find(t => t.taskId === result.taskId)!
  expect(created.parentRecordId).toBe(main)
  expect(created.title).toBe('子任务A')
  expect(created.body).toBe('改造登录模块')
  expect(created.workLabel).toBe('待处理')
  const assignments = await records.list('root-1',{taskId:result.taskId,kind:'assignment'})
  expect(assignments).toHaveLength(1)
  expect(assignments[0]!.sessions).toEqual([{sessionId:'child-new', label:'执行者'}])
  expect(sub.started()!.promptText).toContain(`本任务 taskId：${result.taskId}`)
  // 不给 parentTaskId → 根级任务也合法
  const r2 = (await run(tool,{...BASE_ARGS, taskTitle:'独立任务'})) as {createdTask:boolean}
  expect(r2.createdTask).toBe(true)
  expect((await records.list('root-1',{kind:'task'})).find(t => t.title==='独立任务')!.parentRecordId).toBeUndefined()
})

it('两级模型：给了不存在的 taskId → 拒绝且不建子会话；给了 taskId 就在该任务下派发（不新建任务）', async () => {
  const {records, roles} = await makeDeps()
  await roles.save({name:'执行者', description:'干活'})
  const sub = fakeSubagents('c1')
  const tool = buildDispatchTool({records,roles,subagents:sub.face})
  await expect(run(tool,{...BASE_ARGS, taskId:'11111111-1111-4111-8111-111111111111'})).rejects.toMatchObject({code:'NOT_FOUND'})
  expect(sub.started()).toBeUndefined()
  const main = await makeTask(records)
  const {taskTitle:_t, ...noTitle} = BASE_ARGS
  const result = (await run(tool,{...noTitle, taskId: main})) as {taskId:string; createdTask:boolean}
  expect(result.taskId).toBe(main)
  expect(result.createdTask).toBe(false)
  expect(await records.list('root-1',{kind:'task'})).toHaveLength(1)
  expect(await records.list('root-1',{taskId:main,kind:'assignment'})).toHaveLength(1)
})

it('两级模型 continue：按 expectedChildId 找归属任务，追加要求自动拼进任务描述后投递；回执为空/投递失败报错不换队', async () => {
  const {records, roles} = await makeDeps()
  await roles.save({name:'执行者', description:'负责组织团队'})
  const taskId = await makeTask(records)
  const sub = fakeSubagents('original')
  const startActivation = vi.fn(sub.face.startActivation)
  const sendMessage = vi.fn(async (..._args: unknown[]) => 'receipt')
  const tool = buildDispatchTool({records,roles,subagents:{startActivation,sendMessage}})
  await run(tool,{...BASE_ARGS, taskId, taskTitle: undefined})
  const follow = {...BASE_ARGS, taskId, mode:'continue', expectedChildId:'original', task:'新增导出：验收 CSV 文件'}
  // 新建模式不许带 expectedChildId；continue 缺 expectedChildId 拒绝
  for (const mode of ['spawn','fork']) await expect(run(tool,{...follow, mode})).rejects.toThrow(/expectedChildId/)
  await expect(run(tool,{...follow, expectedChildId: undefined})).rejects.toThrow(/expectedChildId/)
  // 未登记的子会话 → 拒绝，不投递
  await expect(run(tool,{...follow, expectedChildId:'ghost'})).rejects.toThrow(/没有登记子会话/)
  expect(sendMessage).not.toHaveBeenCalled()
  // 正常追加：投递 + 任务描述被追加
  await expect(run(tool,follow)).resolves.toMatchObject({childId:'original', taskId, messageId:'receipt'})
  expect(sendMessage).toHaveBeenCalledWith(EXEC.agent,'original',expect.arrayContaining([{type:'text',text:expect.stringContaining(follow.task)}]),expect.anything())
  const owned = await records.read('root-1', taskId, taskId)
  expect(owned.record.body).toContain('目标')
  expect(owned.record.body).toContain('[追加要求]')
  expect(owned.record.body).toContain(follow.task)
  // 回执为空 / 投递抛错 → 报错，不换队
  sendMessage.mockResolvedValueOnce('')
  await expect(run(tool,follow)).rejects.toThrow(/回执/)
  sendMessage.mockRejectedValueOnce(new Error('offline'))
  await expect(run(tool,follow)).rejects.toThrow(/交接/)
  expect(startActivation).toHaveBeenCalledTimes(1)
  expect(await records.list('root-1',{taskId,kind:'assignment'})).toHaveLength(1)
})

it('两级模型：不同任务各派子会话；同一子会话登记在多个分工下时 continue 拒绝（归属不唯一，不猜）', async () => {
  const { records, roles } = await makeDeps()
  await roles.save({ name: '执行者', description: '组织团队' })
  const first = await makeTask(records)
  const second = await makeTask(records)
  const startActivation = vi.fn().mockResolvedValueOnce({childId:'a'}).mockResolvedValueOnce({childId:'b'})
  const sendMessage = vi.fn()
  const tool = buildDispatchTool({records, roles, subagents:{startActivation, sendMessage}})
  const {taskTitle:_t, ...noTitle} = BASE_ARGS
  await run(tool,{...noTitle, taskId:first}); await run(tool,{...noTitle, taskId:second})
  // 把 'a' 再登记到另一个任务下 → 归属不唯一
  await records.create('root-1',{kind:'assignment',taskId:second,title:'冲突登记',body:'',sessions:[{label:'执行者',sessionId:'a'}]})
  await expect(run(tool,{...BASE_ARGS, mode:'continue', expectedChildId:'a', task:'追加'})).rejects.toThrow(/归属不唯一/)
  expect(startActivation).toHaveBeenCalledTimes(2); expect(sendMessage).not.toHaveBeenCalled()
})

describe('dispatch role models', () => {
  it('序列为空时 startActivation 参数没有 agentOptions，返回键与现在相同', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '执行者', description: '拆解并汇总。' })
    const taskId = await makeTask(records)
    let request: Record<string, unknown> | undefined
    const tool = buildDispatchTool({
      records,
      roles,
      subagents: {
        async startActivation(input) {
          request = input.request as Record<string, unknown>
          return { childId: 'child-empty' }
        },
      },
    })
    const result = await run(tool, { ...BASE_ARGS, taskId }) as Record<string, unknown>
    expect(Object.keys(request ?? {}).sort()).toEqual(['maxDepth', 'parent', 'prompt'])
    expect(request).not.toHaveProperty('agentOptions')
    expect(Object.keys(result).sort()).toEqual(['childId', 'createdTask', 'record', 'taskId'])
    expect(result).not.toHaveProperty('model')
  })

  it('随机起点为 0 时角色候选的第一项作为子会话初始模型；序列非空时 agentOptions 只有 provider 与 model，成功和 recordError 都带 model', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({
      name: '执行者',
      description: '只写职责',
      models: [
        { provider: 'deepseek', model: 'deepseek-chat' },
        { provider: 'openai', model: 'gpt-4.1' },
      ],
    })
    const taskId = await makeTask(records)
    const runs = new Map<string, { parentSessionId: string; sequence: Array<{ provider: string; model: string }> }>()
    let request: { agentOptions?: Record<string, unknown>; prompt: Array<{ text: string }> } | undefined
    const subagents = {
      async startActivation(input: { request: { agentOptions?: Record<string, unknown>; prompt: Array<{ text: string }> } }) {
        request = input.request
        return { childId: 'child-model' }
      },
    }
    const tool = buildDispatchTool({ records, roles, subagents, childModelRuns: runs as never, random: () => 0 })
    const result = await run(tool, { ...BASE_ARGS, taskId }, { agent: { id: 'parent-9', session: 'other' } }) as { model?: { provider: string; model: string } }
    expect(Object.keys(request ?? {}).sort()).toEqual(['agentOptions', 'maxDepth', 'parent', 'prompt'])
    // 起点 0 → 候选第一项 = 子会话初始模型；后面的候选留给失败回退。
    expect(request?.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(Object.keys(request!.agentOptions!)).toEqual(['provider', 'model'])
    expect(request?.prompt[0]!.text).not.toContain('dsh-router:models')
    expect(request?.prompt[0]!.text).not.toContain('deepseek')
    // 职责不在初始指令里（它进的是子会话的系统提示词）。
    expect(request?.prompt[0]!.text).not.toContain('只写职责')
    expect(result.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(runs.get('child-model')?.parentSessionId).toBe('parent-9')
    expect(runs.get('child-model')?.sequence).toEqual([
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'openai', model: 'gpt-4.1' },
    ])

    const failing = {
      ...records,
      async create(root: string, input: Parameters<typeof records.create>[1]) {
        if (input.kind === 'assignment') throw new Error('disk full')
        return records.create(root, input)
      },
    }
    const tool2 = buildDispatchTool({ records: failing, roles, subagents, childModelRuns: runs as never, random: () => 0 })
    const errored = await run(tool2, { ...BASE_ARGS, taskId, task: '另一件' }, { agent: { id: 'parent-9' } }) as { recordError?: string; model?: { provider: string; model: string } }
    expect(errored.recordError).toContain('disk full')
    expect(errored.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('随机起点决定初始模型与回退序列：起点 k → 序列是 [k, …, 末尾, 1, …, k-1]', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({
      name: '执行者',
      description: '职责',
      models: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' },
        { provider: 'p4', model: 'm4' },
        { provider: 'p5', model: 'm5' },
      ],
    })
    const taskId = await makeTask(records)
    const runs = new Map<string, { sequence: Array<{ provider: string; model: string }> }>()
    let agentOptions: { provider: string; model: string } | undefined
    const subagents = {
      async startActivation(input: { request: { agentOptions?: { provider: string; model: string } } }) {
        agentOptions = input.request.agentOptions
        return { childId: 'child-rotated' }
      },
    }
    // k = floor(0.4 * 5) = 2 → 第三项起步。
    const tool = buildDispatchTool({ records, roles, subagents, childModelRuns: runs as never, random: () => 0.4 })
    const result = await run(tool, { ...BASE_ARGS, taskId }) as { model?: { provider: string; model: string } }
    expect(agentOptions).toEqual({ provider: 'p3', model: 'm3' })
    expect(result.model).toEqual({ provider: 'p3', model: 'm3' })
    // 游标里的序列就是旋转后的实际顺序：失败回退沿它往后走，最后绕回起点之前的那几项。
    expect(runs.get('child-rotated')?.sequence).toEqual([
      { provider: 'p3', model: 'm3' },
      { provider: 'p4', model: 'm4' },
      { provider: 'p5', model: 'm5' },
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ])
  })

  it('随机起点不同 → 顺序相应不同，但仍是同一集合的轮转', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({
      name: '执行者',
      description: '职责',
      models: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' },
      ],
    })
    const taskId = await makeTask(records)
    const orders = new Set<string>()
    for (const [k, value] of [0.1, 0.4, 0.8].entries()) {
      const runs = new Map<string, { sequence: Array<{ provider: string; model: string }> }>()
      let agentOptions: { provider: string; model: string } | undefined
      const tool = buildDispatchTool({
        records,
        roles,
        childModelRuns: runs as never,
        random: () => value,
        subagents: {
          async startActivation(input: { request: { agentOptions?: { provider: string; model: string } } }) {
            agentOptions = input.request.agentOptions
            return { childId: `child-k${k}` }
        },
        },
      })
      await run(tool, { ...BASE_ARGS, taskId })
      const sequence = runs.get(`child-k${k}`)!.sequence
      expect(sequence).toHaveLength(3)
      expect([...sequence].map((item) => item.model).sort()).toEqual(['m1', 'm2', 'm3'])
      // 初始模型 = 旋转后的第一项。
      expect(agentOptions).toEqual({ provider: sequence[0]!.provider, model: sequence[0]!.model })
      orders.add(sequence.map((item) => item.model).join(','))
    }
    expect(orders.size).toBe(3)
  })

  it('不注入随机源时初始模型也是候选之一（默认 Math.random）', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({
      name: '执行者',
      description: '职责',
      models: [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' },
      ],
    })
    const taskId = await makeTask(records)
    const runs = new Map<string, { sequence: Array<{ provider: string; model: string }> }>()
    let agentOptions: { provider: string; model: string } | undefined
    const tool = buildDispatchTool({
      records,
      roles,
      childModelRuns: runs as never,
      subagents: {
        async startActivation(input: { request: { agentOptions?: { provider: string; model: string } } }) {
          agentOptions = input.request.agentOptions
          return { childId: 'child-default-random' }
        },
      },
    })
    await run(tool, { ...BASE_ARGS, taskId })
    expect(['m1', 'm2', 'm3']).toContain(agentOptions!.model)
    const sequence = runs.get('child-default-random')!.sequence
    expect(sequence).toHaveLength(3)
    expect(sequence[0]!.model).toBe(agentOptions!.model)
  })

  it('派发不能指定模型：带 provider/model 一律 INVALID_INPUT，且在建任务和读角色之前拒绝', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({
      name: '执行者',
      description: '职责',
      models: [
        { provider: 'openai', model: 'gpt-4.1' },
        { provider: 'deepseek', model: 'deepseek-chat' },
      ],
    })
    let reads = 0
    const wrapped = {
      ...roles,
      async read(name: string) {
        reads += 1
        return roles.read(name)
      },
    }
    const runs = new Map<string, { sequence: Array<{ provider: string; model: string }> }>()
    let agentOptions: { provider: string; model: string } | undefined
    const tool = buildDispatchTool({
      records,
      roles: wrapped,
      childModelRuns: runs as never,
      random: () => 0,
      subagents: {
        async startActivation(input) {
          agentOptions = (input.request as { agentOptions?: { provider: string; model: string } }).agentOptions
          return { childId: 'child-override' }
        },
      },
    })
    await expect(run(tool, { ...BASE_ARGS, provider: 'only-provider' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(run(tool, { ...BASE_ARGS, model: 'only-model' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(run(tool, { ...BASE_ARGS, provider: 'deepseek', model: 'deepseek-chat' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(reads).toBe(0)
    expect(await records.list('root-1', { kind: 'task' })).toEqual([])
    expect(runs.size).toBe(0)
    expect(agentOptions).toBeUndefined()

    // 不带模型参数正常派发：随机起点为 0 时初始模型就是角色候选的第一项。
    await run(tool, { ...BASE_ARGS })
    expect(agentOptions).toEqual({ provider: 'openai', model: 'gpt-4.1' })
    expect(runs.get('child-override')?.sequence).toEqual([
      { provider: 'openai', model: 'gpt-4.1' },
      { provider: 'deepseek', model: 'deepseek-chat' },
    ])
  })

  it('工具参数里没有 provider/model；工具说明写明模型由角色自己决定', async () => {
    const { records, roles } = await makeDeps()
    const tool = buildDispatchTool({ records, roles })
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties
    expect(properties).not.toHaveProperty('provider')
    expect(properties).not.toHaveProperty('model')
    expect(tool.description).toContain('不能指定模型')
    expect(tool.description).not.toContain('仅这一次')
  })

  it('continue 带 provider 或 model 时 INVALID_INPUT，不投递也不改任务正文', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '执行者', description: '职责' })
    const taskId = await makeTask(records)
    const before = (await records.read('root-1', taskId, taskId)).record.body
    await records.create('root-1', {
      kind: 'assignment',
      taskId,
      title: '已有分工',
      body: '分工',
      sessions: [{ sessionId: 'child-keep', label: '执行者' }],
    })
    const startActivation = vi.fn()
    const sendMessage = vi.fn()
    const tool = buildDispatchTool({ records, roles, subagents: { startActivation, sendMessage } })
    await expect(run(tool, { ...BASE_ARGS, mode: 'continue', expectedChildId: 'child-keep', provider: 'deepseek', task: '不要写入' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(run(tool, { ...BASE_ARGS, mode: 'continue', expectedChildId: 'child-keep', model: 'gpt', task: '不要写入' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(startActivation).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect((await records.read('root-1', taskId, taskId)).record.body).toBe(before)
  })

  it('startActivation 抛错不登记游标，也不改试剩余候选', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({
      name: '执行者',
      description: '职责',
      models: [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }],
    })
    const runs = new Map<string, unknown>()
    let calls = 0
    const tool = buildDispatchTool({
      records,
      roles,
      childModelRuns: runs as never,
      subagents: {
        async startActivation() {
          calls += 1
          throw new Error('activation limit')
        },
      },
    })
    await expect(run(tool, BASE_ARGS)).rejects.toThrow(/activation limit/)
    expect(calls).toBe(1)
    expect(runs.size).toBe(0)
  })

  it('调用方没有 id 时游标里的 parentSessionId 是空串', async () => {
    const { records, roles } = await makeDeps()
    await roles.save({ name: '执行者', description: '职责', models: [{ provider: 'p', model: 'm' }] })
    const taskId = await makeTask(records)
    const runs = new Map<string, { parentSessionId: string }>()
    const tool = buildDispatchTool({
      records,
      roles,
      childModelRuns: runs as never,
      subagents: { async startActivation() { return { childId: 'child-noid' } } },
    })
    await run(tool, { ...BASE_ARGS, taskId })
    expect(runs.get('child-noid')?.parentSessionId).toBe('')
  })
})
