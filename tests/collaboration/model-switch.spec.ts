/**
 * 子会话候选切换：只在 turn/end 的可切换错误并且 idle 之后 select + 固定继续句。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  classifyTurnError,
  createModelSwitch,
  type ChildModelRun,
  type ModelSwitchAgent,
  type ModelSwitchController,
  type ModelSwitchLlm,
} from '../../src/collaboration/model-switch.ts'
import { createRecordStore } from '../../src/collaboration/records.ts'
import type { RecordStore } from '../../src/collaboration/types.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
})

const ROOT = 'root-switch'
const CHILD = 'child-1'
const PARENT = 'parent-1'

interface Harness {
  records: RecordStore
  runs: Map<string, ChildModelRun>
  switcher: ModelSwitchController
  signal: AbortSignal
  select: ReturnType<typeof vi.fn>
  selectModel: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  listModels: ReturnType<typeof vi.fn>
  taskId: string
  child: ModelSwitchAgent
  parent: ModelSwitchAgent
  setStatus(status: string): void
  setAgents(agents: { get(id: string): ModelSwitchAgent | undefined } | undefined): void
}

async function harness(options?: {
  sequence?: Array<{ provider: string; model: string }>
  listModels?: ModelSwitchLlm['listModels']
  providers?: Array<{ id: string }>
  agentsMissing?: boolean
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'router-model-switch-'))
  roots.push(dir)
  const records = createRecordStore(dir)
  const task = await records.create(ROOT, { kind: 'task', title: '任务', body: '目标', workLabel: '待处理' })
  const sequence = options?.sequence ?? [
    { provider: 'deepseek', model: 'deepseek-chat' },
    { provider: 'openai', model: 'gpt-4.1' },
  ]
  const runs = new Map<string, ChildModelRun>()
  const select = vi.fn(async () => undefined)
  const selectModel = vi.fn()
  const sendMessage = vi.fn(async () => 'msg-1')
  const listModels = vi.fn(options?.listModels ?? (async () => [{ id: 'other' }]))
  const child: ModelSwitchAgent & { selectModel: typeof selectModel } = {
    id: CHILD,
    status: 'idle',
    model: { select },
    selectModel,
  }
  const parent: ModelSwitchAgent = { id: PARENT, status: 'idle' }
  let agents: { get(id: string): ModelSwitchAgent | undefined } | undefined = options?.agentsMissing
    ? undefined
    : { get: (id) => (id === CHILD ? child : id === PARENT ? parent : undefined) }
  const controller = new AbortController()
  const llm: ModelSwitchLlm = {
    listProviders: async () => options?.providers ?? [{ id: 'deepseek' }, { id: 'openai' }],
    listModels,
  }
  const switcher = createModelSwitch({
    runs,
    records,
    activeTasks: { refresh: async () => undefined },
    signal: controller.signal,
    getAgents: () => agents,
    getSubagents: () => ({ sendMessage }),
    getLlm: () => llm,
  })
  runs.set(CHILD, {
    sequence,
    index: 0,
    phase: 'armed',
    rootSessionId: ROOT,
    taskId: task.record.taskId,
    roleName: '执行者',
    parentSessionId: PARENT,
    failures: [],
  })
  return {
    records,
    runs,
    switcher,
    signal: controller.signal,
    select,
    selectModel,
    sendMessage,
    listModels,
    taskId: task.record.taskId,
    child,
    parent,
    setStatus(status: string) { child.status = status },
    setAgents(next) { agents = next },
  }
}

function errorEvent(code: string, turn = 1, extra?: { status?: number; message?: string }): unknown {
  return {
    type: 'turn/end',
    turn,
    reason: { kind: 'error', error: { code, message: extra?.message ?? `${code} 失败`, status: extra?.status } },
  }
}

async function endTurn(h: Harness, code: string, turn = 1, extra?: { status?: number; message?: string }): Promise<void> {
  await h.switcher.onSessionEvent({ id: CHILD }, errorEvent(code, turn, extra))
}

async function taskLabel(h: Harness): Promise<string | undefined> {
  const saved = await h.records.read(ROOT, h.taskId, h.taskId)
  return saved.record.workLabel
}

async function reports(h: Harness) {
  return h.records.list(ROOT, { taskId: h.taskId, kind: 'report' })
}

describe('classifyTurnError', () => {
  it('直接通道码与未排除的 429/5xx 可切换；排除表与未知码不切换', () => {
    for (const code of ['NO_ADAPTER', 'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'SERVER']) {
      expect(classifyTurnError({ code })).toBe('switch')
    }
    expect(classifyTurnError({ code: 'WEIRD', status: 429 })).toBe('switch')
    expect(classifyTurnError({ code: 'WEIRD', status: 503 })).toBe('switch')
    expect(classifyTurnError({ code: 'INVALID_REQUEST', status: 500 })).toBe('invalid-request')
    for (const code of ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED', 'EMPTY_RESPONSE', 'PI_AI_ERROR', 'UNKNOWN', 'IMAGE_OFFLOAD_REQUIRED', 'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'HTTP_404', 'HTTP_500']) {
      expect(classifyTurnError({ code, status: 500 })).toBe('ignore')
      expect(classifyTurnError({ code, status: 429 })).toBe('ignore')
    }
    expect(classifyTurnError({ code: 'CONTENT_REJECTED' })).toBe('ignore')
    expect(classifyTurnError({ code: 'WEIRD', status: 400 })).toBe('ignore')
  })
})

describe('model switch state machine', () => {
  it('agent/request-error 与 llm/retry 不切换', async () => {
    const h = await harness()
    await h.switcher.onSessionEvent({ id: CHILD }, { type: 'agent/request-error', code: 'RATE_LIMIT' })
    await h.switcher.onSessionEvent({ id: CHILD }, { type: 'llm/retry', code: 'RATE_LIMIT' })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.runs.get(CHILD)?.index).toBe(0)
    expect(h.runs.get(CHILD)?.phase).toBe('armed')
  })

  it('turn/end RATE_LIMIT 在 idle 之后 select 下一个并送出固定中文句', async () => {
    const h = await harness()
    h.setStatus('running')
    await endTurn(h, 'RATE_LIMIT', 3, { status: 429, message: '限流' })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.runs.get(CHILD)?.phase).toBe('switching')
    h.setStatus('idle')
    await h.switcher.onAgentStatus({ agent: { id: CHILD }, status: 'running' })
    expect(h.select).not.toHaveBeenCalled()
    await h.switcher.onAgentStatus({ agent: { id: CHILD }, status: 'idle' })
    expect(h.select).toHaveBeenCalledTimes(1)
    expect(h.select).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4.1' })
    expect(h.sendMessage).toHaveBeenCalledWith(
      h.parent,
      CHILD,
      [{ type: 'text', text: '已从 deepseek/deepseek-chat 换到 openai/gpt-4.1，继续原任务。' }],
      { signal: h.signal },
    )
    expect(h.runs.get(CHILD)?.index).toBe(1)
    expect(h.runs.get(CHILD)?.phase).toBe('armed')
    expect(await taskLabel(h)).toBe('待处理')
    const written = await reports(h)
    expect(written).toHaveLength(1)
    expect(written[0]!.workLabel).toBe('已报告')
    expect(written[0]!.body).toContain('已从 deepseek/deepseek-chat 换到 openai/gpt-4.1')
    expect(written[0]!.body).toContain('错误码：RATE_LIMIT')
    expect(written[0]!.body).toContain('状态：429')
    expect(written[0]!.body).toContain('限流')
    expect(written[0]!.body).toContain('本次序列')
    expect(written[0]!.body).toContain('已经放弃的前缀')
    expect(written[0]!.body).toContain('未退回主会话模型')
    expect(written[0]!.sessions).toEqual([{ sessionId: CHILD, label: '执行者' }])
  })

  it('更新的 turn/start 放弃这次切换，下标不动', async () => {
    const h = await harness()
    h.setStatus('running')
    await endTurn(h, 'TIMEOUT', 1)
    await h.switcher.onSessionEvent({ id: CHILD }, { type: 'turn/start', turn: 2 })
    h.setStatus('idle')
    await h.switcher.onAgentStatus({ agent: { id: CHILD }, status: 'idle' })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.runs.get(CHILD)?.phase).toBe('armed')
    expect(h.runs.get(CHILD)?.index).toBe(0)
    expect(await taskLabel(h)).toBe('待处理')
  })

  it('aborted、EMPTY_RESPONSE、HTTP_404 不 select，也不改标签', async () => {
    const h = await harness()
    await h.switcher.onSessionEvent({ id: CHILD }, { type: 'turn/end', turn: 1, reason: { kind: 'aborted' } })
    await endTurn(h, 'EMPTY_RESPONSE')
    await endTurn(h, 'HTTP_404', 2, { status: 404 })
    await h.switcher.onSessionEvent({ id: CHILD }, { type: 'turn/end', turn: 3, reason: { kind: 'completed' } })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(await taskLabel(h)).toBe('待处理')
    expect(await reports(h)).toEqual([])
  })

  it('INVALID_REQUEST 且清单成功不含该 id（含空列表）才前进', async () => {
    const missing = await harness({ listModels: async () => [{ id: 'other-model' }] })
    await endTurn(missing, 'INVALID_REQUEST', 1, { status: 400, message: 'no such model' })
    expect(missing.listModels).toHaveBeenCalledWith('deepseek')
    expect(missing.select).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4.1' })

    const empty = await harness({ listModels: async () => [] })
    await endTurn(empty, 'INVALID_REQUEST')
    expect(empty.select).toHaveBeenCalledTimes(1)

    const present = await harness({ listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] })
    await endTurn(present, 'INVALID_REQUEST', 1, { status: 500, message: 'bad params' })
    expect(present.select).not.toHaveBeenCalled()
    expect(present.sendMessage).not.toHaveBeenCalled()
    expect(present.runs.get(CHILD)?.phase).toBe('armed')
    expect(await taskLabel(present)).toBe('待处理')
    expect(await reports(present)).toEqual([])
  })

  it('INVALID_REQUEST 清单读不到时不 select、不标受阻、不写报告', async () => {
    const thrown = await harness({ listModels: async () => { throw new Error('catalog down') } })
    await endTurn(thrown, 'INVALID_REQUEST')
    expect(thrown.select).not.toHaveBeenCalled()
    expect(await taskLabel(thrown)).toBe('待处理')
    expect(await reports(thrown)).toEqual([])

    const unknownProvider = await harness({ providers: [{ id: 'openai' }] })
    await endTurn(unknownProvider, 'INVALID_REQUEST')
    expect(unknownProvider.listModels).not.toHaveBeenCalled()
    expect(unknownProvider.select).not.toHaveBeenCalled()
    expect(await taskLabel(unknownProvider)).toBe('待处理')

    const noLlm = await harness()
    const bare = createModelSwitch({
      runs: noLlm.runs,
      records: noLlm.records,
      signal: noLlm.signal,
      getAgents: () => ({ get: (id) => (id === CHILD ? noLlm.child : id === PARENT ? noLlm.parent : undefined) }),
      getSubagents: () => ({ sendMessage: noLlm.sendMessage }),
      getLlm: () => undefined,
    })
    await bare.onSessionEvent({ id: CHILD }, errorEvent('INVALID_REQUEST'))
    expect(noLlm.select).not.toHaveBeenCalled()
    expect(await taskLabel(noLlm)).toBe('待处理')
    expect(await reports(noLlm)).toEqual([])
  })

  it('清单读取期间到达的 idle 不提前切换；读完确认不在清单里才前进', async () => {
    let release: (rows: Array<{ id: string }>) => void = () => {}
    const h = await harness({
      listModels: () => new Promise((resolve) => { release = resolve }),
    })
    h.setStatus('running')
    const pending = h.switcher.onSessionEvent({ id: CHILD }, errorEvent('INVALID_REQUEST', 4))
    await Promise.resolve()
    expect(h.runs.get(CHILD)?.phase).toBe('checking')
    h.setStatus('idle')
    await h.switcher.onAgentStatus({ agent: { id: CHILD }, status: 'idle' })
    expect(h.select).not.toHaveBeenCalled()
    release([])
    await pending
    expect(h.select).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4.1' })
  })

  it('清单读取期间到达的 idle 在 id 仍在清单里时不切换', async () => {
    let release: (rows: Array<{ id: string }>) => void = () => {}
    const h = await harness({
      listModels: () => new Promise((resolve) => { release = resolve }),
    })
    const pending = h.switcher.onSessionEvent({ id: CHILD }, errorEvent('INVALID_REQUEST', 4))
    await Promise.resolve()
    await h.switcher.onAgentStatus({ agent: { id: CHILD }, status: 'idle' })
    release([{ id: 'deepseek-chat' }])
    await pending
    expect(h.select).not.toHaveBeenCalled()
    expect(h.runs.get(CHILD)?.phase).toBe('armed')
    expect(await taskLabel(h)).toBe('待处理')
  })

  it('清单读取期间更新的 turn/start 不再前进', async () => {
    let release: (rows: Array<{ id: string }>) => void = () => {}
    const h = await harness({
      listModels: () => new Promise((resolve) => { release = resolve }),
    })
    const pending = h.switcher.onSessionEvent({ id: CHILD }, errorEvent('INVALID_REQUEST', 4))
    await Promise.resolve()
    await h.switcher.onSessionEvent({ id: CHILD }, { type: 'turn/start', turn: 5 })
    release([])
    await pending
    expect(h.select).not.toHaveBeenCalled()
    expect(h.runs.get(CHILD)?.phase).toBe('armed')
    expect(h.runs.get(CHILD)?.index).toBe(0)
  })

  it('NO_ADAPTER 不看清单也会前进', async () => {
    const h = await harness()
    await endTurn(h, 'NO_ADAPTER', 1, { message: '未注册' })
    expect(h.listModels).not.toHaveBeenCalled()
    expect(h.select).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4.1' })
    expect(h.sendMessage).toHaveBeenCalled()
  })

  it('下标只前进；最后一个也失败时任务受阻且不再投递', async () => {
    const h = await harness({
      sequence: [
        { provider: 'p', model: 'm1' },
        { provider: 'p', model: 'm2' },
        { provider: 'p', model: 'm3' },
      ],
    })
    await endTurn(h, 'QUOTA', 1, { message: '第一次' })
    expect(h.select).toHaveBeenCalledTimes(1)
    expect(h.select).toHaveBeenLastCalledWith({ provider: 'p', model: 'm2' })
    await endTurn(h, 'SERVER', 2, { status: 502, message: '第二次' })
    expect(h.select).toHaveBeenCalledTimes(2)
    expect(h.select.mock.calls.map((call) => call[0])).toEqual([
      { provider: 'p', model: 'm2' },
      { provider: 'p', model: 'm3' },
    ])
    expect(h.runs.get(CHILD)?.index).toBe(2)
    await endTurn(h, 'TRANSPORT', 3, { message: '最后一次断了' })
    expect(h.select).toHaveBeenCalledTimes(2)
    expect(h.sendMessage).toHaveBeenCalledTimes(2)
    expect(h.runs.get(CHILD)?.index).toBe(2)
    expect(h.runs.get(CHILD)?.phase).toBe('stopped')
    expect(await taskLabel(h)).toBe('受阻')
    const written = await reports(h)
    const blocked = written.find((report) => report.body.includes('候选已用完'))
    expect(blocked).toBeTruthy()
    expect(blocked!.body).toContain('p/m1')
    expect(blocked!.body).toContain('p/m2')
    expect(blocked!.body).toContain('p/m3')
    expect(blocked!.body).toContain('最后一次断了')
    expect(blocked!.body).toContain('未退回主会话模型')
    expect(blocked!.body).toContain('未再投递继续')
    expect(blocked!.body).toContain('任务已标为受阻')
    await endTurn(h, 'RATE_LIMIT', 4)
    expect(h.select).toHaveBeenCalledTimes(2)
    expect(h.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('只有一个候选时第一次可切换失败立即受阻，不等 idle', async () => {
    const h = await harness({ sequence: [{ provider: 'p', model: 'only' }] })
    h.setStatus('running')
    await endTurn(h, 'RATE_LIMIT', 1, { message: '仅有的候选失败' })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(await taskLabel(h)).toBe('受阻')
    expect((await reports(h))[0]!.body).toContain('p/only')
  })

  it('select 全部抛错则受阻且不投递；成功但 sendMessage 失败不再试下一个', async () => {
    const exhausted = await harness({
      sequence: [
        { provider: 'p', model: 'm1' },
        { provider: 'p', model: 'm2' },
        { provider: 'p', model: 'm3' },
      ],
    })
    exhausted.select.mockRejectedValue(new Error('select 拒绝'))
    await endTurn(exhausted, 'RATE_LIMIT')
    expect(exhausted.select).toHaveBeenCalledTimes(2)
    expect(exhausted.sendMessage).not.toHaveBeenCalled()
    expect(exhausted.runs.get(CHILD)?.index).toBe(0)
    expect(await taskLabel(exhausted)).toBe('受阻')
    expect((await reports(exhausted)).some((report) => report.body.includes('select 已改模型：否'))).toBe(true)

    const delivery = await harness({
      sequence: [
        { provider: 'p', model: 'm1' },
        { provider: 'p', model: 'm2' },
        { provider: 'p', model: 'm3' },
      ],
    })
    delivery.sendMessage.mockRejectedValue(new Error('投递失败'))
    await endTurn(delivery, 'RATE_LIMIT', 1, { message: '通道失败' })
    expect(delivery.select).toHaveBeenCalledTimes(1)
    expect(delivery.select).toHaveBeenCalledWith({ provider: 'p', model: 'm2' })
    expect(delivery.runs.get(CHILD)?.index).toBe(1)
    expect(delivery.runs.get(CHILD)?.phase).toBe('stopped')
    expect(await taskLabel(delivery)).toBe('受阻')
    const body = (await reports(delivery))[0]!.body
    expect(body).toContain('select 已改模型：是')
    expect(body).toContain('投递是否发生：否')
    expect(body).toContain('投递失败')
    expect(body).toContain('未退回主会话模型')
    await endTurn(delivery, 'SERVER', 2)
    expect(delivery.select).toHaveBeenCalledTimes(1)
  })

  it('没有 agent.model.select 时不调用 selectModel', async () => {
    const h = await harness()
    h.child.model = {}
    await endTurn(h, 'QUOTA')
    expect(h.selectModel).not.toHaveBeenCalled()
    expect(h.select).not.toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(await taskLabel(h)).toBe('受阻')
    expect((await reports(h))[0]!.body).toContain('宿主没有 agent.model.select')
  })

  it('没有在线子会话或父会话时不投递；父会话缺失时下标停在已选候选', async () => {
    const missingChild = await harness()
    missingChild.setAgents({ get: () => undefined })
    await endTurn(missingChild, 'SERVER')
    expect(missingChild.sendMessage).not.toHaveBeenCalled()
    expect(await taskLabel(missingChild)).toBe('受阻')
    expect((await reports(missingChild))[0]!.body).toContain('没有在线子会话')

    const missingParent = await harness()
    missingParent.setAgents({
      get: (id) => (id === CHILD ? missingParent.child : undefined),
    })
    await endTurn(missingParent, 'SERVER')
    expect(missingParent.select).toHaveBeenCalledTimes(1)
    expect(missingParent.sendMessage).not.toHaveBeenCalled()
    expect(missingParent.runs.get(CHILD)?.index).toBe(1)
    expect(await taskLabel(missingParent)).toBe('受阻')
    expect((await reports(missingParent))[0]!.body).toContain('已改模型，未能取得在线父会话，未投递')
  })

  it('agents 服务还没到时不标受阻；服务出现后继续', async () => {
    const h = await harness({ agentsMissing: true })
    await endTurn(h, 'RATE_LIMIT')
    expect(await taskLabel(h)).toBe('待处理')
    expect(h.runs.get(CHILD)?.phase).toBe('switching')
    h.setAgents({ get: (id) => (id === CHILD ? h.child : id === PARENT ? h.parent : undefined) })
    await h.switcher.onAgentsAvailable()
    expect(h.select).toHaveBeenCalledTimes(1)
    expect(h.sendMessage).toHaveBeenCalled()
    expect(h.runs.get(CHILD)?.phase).toBe('armed')
  })

  it('写报告或改标签失败只记 warn，不向调用方抛', async () => {
    const h = await harness({ sequence: [{ provider: 'p', model: 'only' }] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.records.update = async () => { throw new Error('disk') }
    h.records.create = async () => { throw new Error('disk') }
    await expect(endTurn(h, 'RATE_LIMIT')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('回退沿旋转后的序列走（随机起点已在派发时排好）', () => {
  it('序列是 [m3, m1, m2]：失败后依次换到 m1、m2，绕回起点之前的那几项', async () => {
    const h = await harness({
      sequence: [
        { provider: 'p', model: 'm3' },
        { provider: 'p', model: 'm1' },
        { provider: 'p', model: 'm2' },
      ],
    })
    await endTurn(h, 'QUOTA', 1, { message: '第一次' })
    expect(h.select).toHaveBeenLastCalledWith({ provider: 'p', model: 'm1' })
    await endTurn(h, 'SERVER', 2, { status: 502, message: '第二次' })
    expect(h.select).toHaveBeenLastCalledWith({ provider: 'p', model: 'm2' })
    expect(h.select.mock.calls.map((call) => call[0])).toEqual([
      { provider: 'p', model: 'm1' },
      { provider: 'p', model: 'm2' },
    ])
    // 走完整条序列（含绕回的两项）后停：每个候选只试一次。
    await endTurn(h, 'TRANSPORT', 3, { message: '最后一次断了' })
    expect(h.select).toHaveBeenCalledTimes(2)
    expect(h.runs.get(CHILD)?.phase).toBe('stopped')
    expect(await taskLabel(h)).toBe('受阻')
    const written = await reports(h)
    const blocked = written.find((report) => report.body.includes('候选已用完'))
    expect(blocked).toBeTruthy()
    expect(blocked!.body).toContain('p/m3')
    expect(blocked!.body).toContain('p/m1')
    expect(blocked!.body).toContain('p/m2')
  })

  it('切换报告里打印的是本次实际的序列顺序（人看得懂实际会用什么）', async () => {
    const h = await harness({
      sequence: [
        { provider: 'p', model: 'm3' },
        { provider: 'p', model: 'm1' },
        { provider: 'p', model: 'm2' },
      ],
    })
    await endTurn(h, 'QUOTA', 1, { message: '第一次' })
    const written = await reports(h)
    const switched = written.find((report) => report.body.includes('已从 p/m3 换到 p/m1'))
    expect(switched).toBeTruthy()
    expect(switched!.body).toContain('本次序列')
    expect(switched!.body).toContain('p/m3、p/m1、p/m2')
  })
})
