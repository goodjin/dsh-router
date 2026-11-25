/**
 * 子会话候选切换：只在 turn/end 的可切换错误、并且已经 idle 之后，
 * 用 agent.model.select 换下一个再投递固定继续句。不订阅 agent/request-error，
 * 不返回 retry，不调用 session.selectModel。
 */

import type { RecordStore, RoleModelCandidate } from './types.ts'

const DIRECT_CODES = new Set(['NO_ADAPTER', 'QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'SERVER'])

/** 命中则这一轮不前进，即使 status 是 429 或 5xx。INVALID_REQUEST 不在此表，单独按清单判断。 */
const EXCLUDED_CODES = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE',
  'PI_AI_ERROR',
  'UNKNOWN',
  'IMAGE_OFFLOAD_REQUIRED',
  'STREAM_CLOSED',
  'MALFORMED_RESPONSE',
])

export interface ChildModelFailure {
  provider: string
  model: string
  code: string
  status?: number
  message: string
}

export interface ChildModelRun {
  sequence: readonly RoleModelCandidate[]
  /** 当前正在用的下标。只增不减。 */
  index: number
  /** checking = 正在读清单，proceed 不得提前换。stopped = 序列走完或不能安全继续。 */
  phase: 'armed' | 'checking' | 'switching' | 'stopped'
  rootSessionId: string
  taskId: string
  roleName: string
  parentSessionId: string
  failedTurn?: number
  failures: ChildModelFailure[]
  pending?: ChildModelFailure
  delivering?: boolean
}

export interface ModelSwitchAgent {
  id?: string
  status?: string
  model?: { select?: (selection: { provider: string; model: string }) => unknown }
}

export interface ModelSwitchAgents {
  get(id: string): ModelSwitchAgent | undefined
}

export interface ModelSwitchSubagents {
  sendMessage?(
    sender: unknown,
    targetId: string,
    content: Array<{ type: 'text'; text: string }>,
    options: { signal: AbortSignal },
  ): Promise<unknown>
}

export interface ModelSwitchLlm {
  listProviders(): Promise<ReadonlyArray<{ id?: string }>> | ReadonlyArray<{ id?: string }>
  listModels(provider: string): Promise<ReadonlyArray<{ id?: string }>> | ReadonlyArray<{ id?: string }>
}

export interface ModelSwitchDeps {
  runs: Map<string, ChildModelRun>
  records: Pick<RecordStore, 'create' | 'update'>
  activeTasks?: { refresh(rootSessionId: string): Promise<unknown> }
  signal: AbortSignal
  getAgents(): ModelSwitchAgents | undefined
  getSubagents(): ModelSwitchSubagents | undefined
  getLlm(): ModelSwitchLlm | undefined
}

export interface ModelSwitchController {
  onSessionEvent(session: unknown, event: unknown): Promise<void>
  onAgentStatus(payload: unknown): Promise<void>
  onAgentsAvailable(): Promise<void>
}

interface TurnError {
  code?: unknown
  status?: unknown
  message?: unknown
}

function warn(error: unknown): void {
  console.warn('[dsh-router] model switch failed:', error instanceof Error ? error.message : String(error))
}

function sessionIdOf(session: unknown): string {
  if (typeof session !== 'object' || session === null) return ''
  const id = (session as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

function agentIdOf(agent: unknown): string {
  if (typeof agent !== 'object' || agent === null) return ''
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

type SwitchClass = 'switch' | 'invalid-request' | 'ignore'

export function classifyTurnError(error: TurnError): SwitchClass {
  const code = typeof error.code === 'string' ? error.code : ''
  if (DIRECT_CODES.has(code)) return 'switch'
  if (code === 'INVALID_REQUEST') return 'invalid-request'
  if (EXCLUDED_CODES.has(code) || code.startsWith('HTTP_')) return 'ignore'
  if (error.status === 429) return 'switch'
  if (typeof error.status === 'number' && error.status >= 500 && error.status <= 599) return 'switch'
  return 'ignore'
}

function toFailure(candidate: RoleModelCandidate, error: TurnError): ChildModelFailure {
  const failure: ChildModelFailure = {
    provider: candidate.provider,
    model: candidate.model,
    code: typeof error.code === 'string' ? error.code : '',
    message: typeof error.message === 'string' ? error.message : '',
  }
  if (typeof error.status === 'number') failure.status = error.status
  return failure
}

function formatPair(candidate: RoleModelCandidate): string {
  return `${candidate.provider}/${candidate.model}`
}

function formatSequence(sequence: readonly RoleModelCandidate[]): string {
  return sequence.map(formatPair).join('、')
}

function formatFailure(failure: ChildModelFailure): string {
  const status = failure.status !== undefined ? ` status=${failure.status}` : ''
  return `- ${failure.provider}/${failure.model}：code=${failure.code}${status} message=${failure.message}`
}

async function modelListed(
  llm: ModelSwitchLlm | undefined,
  provider: string,
  model: string,
): Promise<'missing' | 'present' | 'unreadable'> {
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return 'unreadable'
  let providers: ReadonlyArray<{ id?: string }>
  try {
    const listed = await llm.listProviders()
    if (!Array.isArray(listed)) return 'unreadable'
    providers = listed
  } catch {
    return 'unreadable'
  }
  if (!providers.some((item) => item?.id === provider)) return 'unreadable'
  try {
    const models = await llm.listModels(provider)
    if (!Array.isArray(models)) return 'unreadable'
    return models.some((item) => item?.id === model) ? 'present' : 'missing'
  } catch {
    return 'unreadable'
  }
}

export function createModelSwitch(deps: ModelSwitchDeps): ModelSwitchController {
  const { runs, records, signal } = deps

  const commitPending = (run: ChildModelRun): void => {
    if (run.pending === undefined) return
    run.failures.push(run.pending)
    run.pending = undefined
  }

  const markBlocked = async (run: ChildModelRun): Promise<void> => {
    try {
      await records.update(run.rootSessionId, run.taskId, run.taskId, { workLabel: '受阻' })
    } catch (error) {
      warn(error)
    }
    if (deps.activeTasks === undefined) return
    try {
      await deps.activeTasks.refresh(run.rootSessionId)
    } catch (error) {
      warn(error)
    }
  }

  const writeReport = async (run: ChildModelRun, childId: string, title: string, body: string): Promise<void> => {
    try {
      await records.create(run.rootSessionId, {
        kind: 'report',
        taskId: run.taskId,
        title,
        body,
        workLabel: '已报告',
        sessions: [{ sessionId: childId, label: run.roleName }],
      })
    } catch (error) {
      warn(error)
    }
  }

  const stopUnsafe = async (
    run: ChildModelRun,
    childId: string,
    detail: { stuck: RoleModelCandidate; selectChanged: boolean; delivered: boolean; errorText: string; extra?: string },
  ): Promise<void> => {
    run.phase = 'stopped'
    const lines = [
      '不能安全地再自动走下一步。',
      `卡在候选：${formatPair(detail.stuck)}`,
      `select 已改模型：${detail.selectChanged ? '是' : '否'}`,
      `投递是否发生：${detail.delivered ? '是' : '否'}`,
      `最后一次错误：${detail.errorText}`,
      '未退回主会话模型。',
      '任务已标为受阻。',
    ]
    if (detail.extra !== undefined && detail.extra !== '') lines.push(detail.extra)
    await markBlocked(run)
    await writeReport(run, childId, '模型切换受阻', lines.join('\n'))
  }

  const stopExhausted = async (run: ChildModelRun, childId: string): Promise<void> => {
    commitPending(run)
    run.phase = 'stopped'
    const last = run.failures[run.failures.length - 1]
    const lines = [
      '候选已用完，已停止。',
      '试过：',
      ...run.failures.map(formatFailure),
      `最后一次错误：${last ? `${last.code} ${last.message}` : ''}`,
      '未退回主会话模型。',
      '未再投递继续。',
      '任务已标为受阻，等待用户决定。',
    ]
    await markBlocked(run)
    await writeReport(run, childId, '模型切换受阻', lines.join('\n'))
  }

  const proceed = async (childId: string): Promise<void> => {
    const run = runs.get(childId)
    if (run === undefined || run.phase !== 'switching' || run.delivering === true || signal.aborted) return
    if (run.index + 1 >= run.sequence.length) {
      run.delivering = true
      try {
        if (signal.aborted || run.phase !== 'switching') return
        await stopExhausted(run, childId)
      } finally {
        run.delivering = false
      }
      return
    }
    const agents = deps.getAgents()
    if (agents === undefined) return
    const agent = agents.get(childId)
    if (agent === undefined) {
      run.delivering = true
      try {
        if (signal.aborted || run.phase !== 'switching') return
        commitPending(run)
        const stuck = run.sequence[run.index]!
        await stopUnsafe(run, childId, {
          stuck,
          selectChanged: false,
          delivered: false,
          errorText: '没有在线子会话',
        })
      } finally {
        run.delivering = false
      }
      return
    }
    if (agent.status !== 'idle') return
    if (agents.get(childId)?.status !== 'idle') return
    run.delivering = true
    let successReport: { title: string; body: string } | undefined
    try {
      if (signal.aborted || run.phase !== 'switching') return
      const modelApi = agent.model
      if (modelApi === undefined || typeof modelApi.select !== 'function') {
        commitPending(run)
        await stopUnsafe(run, childId, {
          stuck: run.sequence[run.index]!,
          selectChanged: false,
          delivered: false,
          errorText: '宿主没有 agent.model.select',
          extra: '宿主没有 agent.model.select。',
        })
        return
      }
      const from = run.sequence[run.index]!
      const failure = run.pending
      let chosen = -1
      let selectError: unknown
      for (let index = run.index + 1; index < run.sequence.length; index++) {
        if (signal.aborted || run.phase !== 'switching') return
        const candidate = run.sequence[index]!
        try {
          await modelApi.select({ provider: candidate.provider, model: candidate.model })
          chosen = index
          break
        } catch (error) {
          selectError = error
        }
      }
      if (signal.aborted || run.phase !== 'switching') return
      if (chosen < 0) {
        commitPending(run)
        await stopUnsafe(run, childId, {
          stuck: run.sequence[run.index + 1] ?? from,
          selectChanged: false,
          delivered: false,
          errorText: selectError instanceof Error ? selectError.message : String(selectError),
        })
        return
      }
      const to = run.sequence[chosen]!
      const parent = agents.get(run.parentSessionId)
      if (parent === undefined) {
        commitPending(run)
        run.index = chosen
        await stopUnsafe(run, childId, {
          stuck: to,
          selectChanged: true,
          delivered: false,
          errorText: '没有在线父会话',
          extra: '已改模型，未能取得在线父会话，未投递。',
        })
        return
      }
      const text = `已从 ${from.provider}/${from.model} 换到 ${to.provider}/${to.model}，继续原任务。`
      const subagents = deps.getSubagents()
      if (subagents?.sendMessage === undefined) {
        commitPending(run)
        run.index = chosen
        await stopUnsafe(run, childId, {
          stuck: to,
          selectChanged: true,
          delivered: false,
          errorText: '宿主缺少向子会话投递的能力',
        })
        return
      }
      try {
        await subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal })
      } catch (error) {
        commitPending(run)
        run.index = chosen
        await stopUnsafe(run, childId, {
          stuck: to,
          selectChanged: true,
          delivered: false,
          errorText: error instanceof Error ? error.message : String(error),
        })
        return
      }
      commitPending(run)
      run.index = chosen
      run.phase = 'armed'
      run.failedTurn = undefined
      const reported = failure ?? run.failures[run.failures.length - 1]
      const statusLine = reported?.status !== undefined ? `状态：${reported.status}\n` : ''
      successReport = {
        title: '模型切换',
        body: [
          `已从 ${from.provider}/${from.model} 换到 ${to.provider}/${to.model}。`,
          `错误码：${reported?.code ?? ''}`,
          `${statusLine}错误信息：${reported?.message ?? ''}`,
          `本次序列：${formatSequence(run.sequence)}`,
          `已经放弃的前缀：${formatSequence(run.sequence.slice(0, chosen))}`,
          '未退回主会话模型。',
        ].join('\n'),
      }
    } finally {
      run.delivering = false
    }
    if (successReport !== undefined && !signal.aborted) {
      await writeReport(run, childId, successReport.title, successReport.body)
    }
  }

  const arm = (run: ChildModelRun, turn: number, failure: ChildModelFailure): void => {
    run.phase = 'switching'
    run.failedTurn = turn
    run.pending = failure
  }

  return {
    async onSessionEvent(session: unknown, event: unknown): Promise<void> {
      const childId = sessionIdOf(session)
      const run = runs.get(childId)
      if (run === undefined || run.phase === 'stopped' || signal.aborted) return
      if (typeof event !== 'object' || event === null) return
      const record = event as { type?: unknown; turn?: unknown; reason?: unknown }
      if (record.type === 'turn/start') {
        if (
          (run.phase === 'switching' || run.phase === 'checking')
          && typeof record.turn === 'number'
          && run.failedTurn !== undefined
          && record.turn > run.failedTurn
        ) {
          run.phase = 'armed'
          run.pending = undefined
          run.failedTurn = undefined
        }
        return
      }
      if (record.type !== 'turn/end' || run.phase !== 'armed') return
      const reason = record.reason
      if (typeof reason !== 'object' || reason === null) return
      if ((reason as { kind?: unknown }).kind !== 'error') return
      const error = (reason as { error?: unknown }).error
      if (typeof error !== 'object' || error === null) return
      const turnError = error as TurnError
      const current = run.sequence[run.index]
      if (current === undefined) return
      const kind = classifyTurnError(turnError)
      if (kind === 'ignore') return
      const turn = typeof record.turn === 'number' ? record.turn : 0
      const failure = toFailure(current, turnError)
      if (kind === 'invalid-request') {
        // 先标 checking，避免清单还没读完时 idle 事件走 proceed 把「在清单里」的 id 换掉。
        run.phase = 'checking'
        run.failedTurn = turn
        run.pending = failure
        const verdict = await modelListed(deps.getLlm(), current.provider, current.model)
        const latest = runs.get(childId)
        if (latest === undefined || latest.phase !== 'checking' || latest.failedTurn !== turn || signal.aborted) return
        if (verdict !== 'missing') {
          latest.phase = 'armed'
          latest.pending = undefined
          latest.failedTurn = undefined
          return
        }
        latest.phase = 'switching'
        await proceed(childId)
        return
      }
      arm(run, turn, failure)
      await proceed(childId)
    },

    async onAgentStatus(payload: unknown): Promise<void> {
      if (typeof payload !== 'object' || payload === null || signal.aborted) return
      const record = payload as { agent?: unknown; status?: unknown }
      if (record.status !== 'idle') return
      const childId = agentIdOf(record.agent)
      if (childId === '') return
      await proceed(childId)
    },

    async onAgentsAvailable(): Promise<void> {
      if (signal.aborted) return
      const pending = [...runs.keys()]
      for (const childId of pending) await proceed(childId)
    },
  }
}
