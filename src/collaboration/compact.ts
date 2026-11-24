/**
 * 压缩工具 router_compact（模型主动调，2026-11-24 取代「子会话结束→自动压缩」触发器）。
 *
 * 用户的两个硬要求，决定了不能走宿主自带的摘要器：
 * 1. **只压缩上一次压缩以来的多轮对话**。宿主 compactNow 每次都从 surface 第一个非系统节点
 *    重新选范围、并把上一份检查点合并成一份累积摘要——它是「累积」的，不是「增量」的。
 * 2. **用任务列表的形式表示**。宿主摘要器的指令是写死的八段英文结构，没有任何注入口。
 *
 * 所以本工具自己做，三步，全部走公开 API：
 * - 选范围（findCompactRange）：起点 = 上一份检查点（`isCompactCheckpointSource` 认得的
 *   user/message）之后的第一个 surface 节点（没有检查点就是第一个非系统节点）；终点 = 当前回合
 *   之前的最后一个 surface 节点——**只压已闭合的回合**，当前这轮（含本工具调用）一个字不动。
 *   终点再按工具调用/结果配对回退（toolPairingBalancedBefore），不切开任何一对。
 * - 生成检查点正文（renderTaskListCheckpoint）：**任务列表**直接从工作记录生成（任务 + 状态 +
 *   子会话 + 最近报告，子任务挂在父任务下），这是确定性的、不花一次模型调用；模型可用 `notes`
 *   附上几条「自上次压缩以来的关键决策/发现」，补记录里没有的对话结论。外面套
 *   `<compacted-summary>` 标签：宿主摘要器之后若因压力再压，会按它的规则把它当 PRIOR checkpoint
 *   合并，而不是当普通内容重述。
 * - 落地（land）：按宿主压缩事务的协议写三条事件——`compaction/start`（turn:null，独立手动尝试）
 *   → 一条带 `surfaceOp: {op:'replace', startSeq, endSeq}` 与 `sourceEventSeqs`（全部被遮蔽节点）
 *   的 user/message（source 用 `compactCheckpointSource(compactionId)`，UI/日志据此认成检查点）
 *   → `compaction/end`。中途失败也写 end(error)，不留悬空锁。
 *
 * 失败口径：没有可压范围（刚压过/当前是第一轮）→ `{compacted:false, reason}`，不是错误；
 * 范围/配对/追加失败 → 包成 IO_ERROR 上抛，锁已闭合。
 */

import { randomUUID } from 'node:crypto'

import { CompactionId, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { compactCheckpointSource, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { CollaborationError, type RecordStore } from './types.ts'
import type { ToolDefinition } from './tools.ts'

/** 检查点正文外层标签（与宿主摘要器识别 PRIOR checkpoint 的标签一致）。 */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** 会话的最小只读面 + 追加面（宿主 Session 的子集；测试用同形状的假对象）。 */
export interface SessionEventLike {
  seq: number
  type: string
  data?: unknown
}

export interface SurfaceOpReplace {
  op: 'replace'
  startSeq: number
  endSeq: number
}

export interface SessionFace {
  events: ReadonlyArray<SessionEventLike>
  surface: { nodes: ReadonlyArray<number> }
  append(
    type: string,
    data: unknown,
    opts: { surfaceOp: SurfaceOpReplace | 'append'; sourceEventSeqs?: number[] },
  ): { seq: number }
}

/** 配对检查（宿主导出 toolPairingBalancedBefore；作为依赖注入，测试不碰宿主内部）。 */
export type PairingCheck = (session: SessionFace, seq: number) => boolean

/** 本次要压的范围。 */
export interface CompactRange {
  /** 被遮蔽的第一个 surface 节点。 */
  startSeq: number
  /** 被遮蔽的最后一个 surface 节点。 */
  endSeq: number
  /** 被遮蔽的全部 surface 节点，按 surface 顺序（= sourceEventSeqs）。 */
  shadowedSeqs: number[]
  /** 上一份检查点的 seq；null = 这是本会话第一次压缩。 */
  sinceCheckpointSeq: number | null
}

function eventAt(session: SessionFace, seq: number): SessionEventLike | undefined {
  // events 按 seq 单调递增；用二分找，避免大会话线性扫。
  const events = session.events
  let lo = 0
  let hi = events.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const ev = events[mid]!
    if (ev.seq === seq) return ev
    if (ev.seq < seq) lo = mid + 1
    else hi = mid - 1
  }
  return undefined
}

function isCheckpointEvent(event: SessionEventLike | undefined): boolean {
  if (event === undefined || event.type !== 'user/message') return false
  const data = event.data
  if (typeof data !== 'object' || data === null) return false
  return isCompactCheckpointSource((data as { source?: unknown }).source as Parameters<typeof isCompactCheckpointSource>[0])
}

function isSystemMessageEvent(event: SessionEventLike | undefined): boolean {
  return event !== undefined && event.type === 'system/message'
}

/**
 * 选范围：上一份检查点之后 → 当前回合开始之前，只含已闭合回合；终点按配对回退。
 * 没有可压内容返回 null。
 */
export function findCompactRange(session: SessionFace, balancedBefore: PairingCheck): CompactRange | null {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return null

  // 起点：上一份检查点（surface 上可见的最后一个）之后；没有检查点 → 跳过 system/message 头。
  let startIndex = 0
  let sinceCheckpointSeq: number | null = null
  for (let index = 0; index < nodes.length; index++) {
    if (isCheckpointEvent(eventAt(session, nodes[index]!))) {
      startIndex = index + 1
      sinceCheckpointSeq = nodes[index]!
    }
  }
  if (sinceCheckpointSeq === null && isSystemMessageEvent(eventAt(session, nodes[0]!))) startIndex = 1
  if (startIndex >= nodes.length) return null

  // 终点：当前回合（最后一个 turn/start）之前的最后一个 surface 节点。
  let currentTurnStart = -1
  for (const event of session.events) {
    if (event.type === 'turn/start' && event.seq > currentTurnStart) currentTurnStart = event.seq
  }
  if (currentTurnStart < 0) return null
  let endIndex = -1
  for (let index = nodes.length - 1; index >= startIndex; index--) {
    if (nodes[index]! < currentTurnStart) {
      endIndex = index
      break
    }
  }
  if (endIndex < startIndex) return null

  // 配对回退：第一个被保留的节点（终点后一个）必须「之前配对平衡」；否则终点往前挪。
  while (endIndex >= startIndex) {
    const next = nodes[endIndex + 1]
    if (next === undefined || balancedBefore(session, next)) break
    endIndex -= 1
  }
  if (endIndex < startIndex) return null

  return {
    startSeq: nodes[startIndex]!,
    endSeq: nodes[endIndex]!,
    shadowedSeqs: nodes.slice(startIndex, endIndex + 1),
    sinceCheckpointSeq,
  }
}

/** 任务列表里的一行（从记录拼出）。 */
export interface TaskLineInput {
  taskId: string
  title: string
  body: string
  workLabel: string
  parentTaskId?: string | undefined
  createdAt: number
  sessions: ReadonlyArray<{ label: string; sessionId: string }>
  latestReportTitle?: string | undefined
}

/** 一句话目标：正文第一个非空行，过长截断。 */
function gist(body: string, max = 120): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
  }
  return '（无描述）'
}

/**
 * 渲染任务列表检查点。确定性纯函数：相同记录 → 逐字相同。
 * 子任务挂在父任务下缩进；根任务按创建序。
 */
export function renderTaskListCheckpoint(input: {
  tasks: ReadonlyArray<TaskLineInput>
  notes: ReadonlyArray<string>
  sinceCheckpointSeq: number | null
}): string {
  const tasks = [...input.tasks].sort((left, right) => left.createdAt - right.createdAt)
  const byParent = new Map<string | undefined, TaskLineInput[]>()
  for (const task of tasks) {
    const key = task.parentTaskId
    const list = byParent.get(key) ?? []
    list.push(task)
    byParent.set(key, list)
  }
  const roots = byParent.get(undefined) ?? []
  const renderTask = (task: TaskLineInput, depth: number): string[] => {
    const indent = '  '.repeat(depth)
    const lines = [`${indent}- [${task.workLabel}] ${task.title}（taskId：${task.taskId}）—— ${gist(task.body)}`]
    if (task.sessions.length > 0) {
      lines.push(`${indent}  - 子会话：${task.sessions.map((s) => `${s.label}=${s.sessionId}`).join('、')}`)
    }
    if (task.latestReportTitle !== undefined && task.latestReportTitle !== '') {
      lines.push(`${indent}  - 最近报告：${task.latestReportTitle}`)
    }
    for (const child of byParent.get(task.taskId) ?? []) lines.push(...renderTask(child, depth + 1))
    return lines
  }
  const taskLines = roots.flatMap((task) => renderTask(task, 0))
  const notes = input.notes.map((note) => note.trim()).filter((note) => note !== '')
  return [
    SUMMARY_OPEN_TAG,
    '# 任务列表检查点（自上次压缩以来）',
    input.sinceCheckpointSeq === null
      ? '这是本会话第一次压缩：下面的任务列表取代了之前的对话。'
      : `下面的任务列表取代了上一份检查点（seq ${input.sinceCheckpointSeq}）之后的对话。`,
    '把它当作已确立的背景，不要复述、不要确认；直接从后面的消息继续。',
    '',
    `## 任务（共 ${String(tasks.length)} 条）`,
    ...(taskLines.length === 0 ? ['（没有任务记录）'] : taskLines),
    '',
    '## 自上次压缩以来的关键决策 / 发现',
    ...(notes.length === 0 ? ['（模型未附注）'] : notes.map((note) => `- ${note}`)),
    '',
    '## 继续工作要知道的',
    '- 活跃任务（未「已报告」）的完整描述每步都在协作上下文里，这里不重复；已报告的任务用 router_record_list 查。',
    '- 追加需求：router_record_list(taskId, kind=assignment) 查子会话 → router_dispatch(mode=continue, expectedChildId=…)。',
    SUMMARY_CLOSE_TAG,
  ].join('\n')
}

/** 工具执行上下文的最小面（宿主 execute(args, exec) 的 exec）。 */
interface CompactExec {
  agent?: unknown
  signal?: AbortSignal
}

function sessionOf(exec: unknown): SessionFace {
  const agent = (exec as CompactExec | undefined)?.agent
  const session = typeof agent === 'object' && agent !== null ? (agent as { session?: unknown }).session : undefined
  if (typeof session !== 'object' || session === null) {
    throw new CollaborationError('INVALID_INPUT', 'router_compact 需要调用方会话（exec.agent.session 缺失）')
  }
  const face = session as SessionFace
  if (!Array.isArray(face.events) || !face.surface || !Array.isArray(face.surface.nodes) || typeof face.append !== 'function') {
    throw new CollaborationError('INVALID_INPUT', 'router_compact 需要的会话面不完整（events / surface.nodes / append）')
  }
  return face
}

/** 构造 router_compact 工具定义。 */
export function buildCompactTool(deps: {
  records: Pick<RecordStore, 'list'>
  uuid?: () => string
  balancedBefore?: PairingCheck
}): ToolDefinition {
  const uuid = deps.uuid ?? randomUUID
  const balancedBefore = deps.balancedBefore ?? ((session, seq) => toolPairingBalancedBefore(session as never, seq as never))
  return {
    name: 'router_compact',
    description:
      '把本会话「上一次压缩以来」的多轮对话压缩成一份**任务列表检查点**（主会话用；由你决定何时压）。' +
      '范围：上一份检查点之后、当前这轮开始之前的全部已闭合回合——当前轮（含本次调用）一个字不动；工具调用/结果不会被切开。' +
      '内容：从工作记录生成的任务列表（每条任务的状态、一句目标、子会话、最近报告；子任务挂在父任务下）+ 你用 notes 附上的关键决策。' +
      '它不花一次模型调用、不调宿主摘要器；被压掉的对话被这条检查点原位取代，之后每步都能看到。' +
      '什么时候压：一个任务收到报告并处理完之后；连续几轮拷问/讨论尘埃落定之后；感觉历史已经很长、但还不想结束时。' +
      '压之前先把关键决策写进任务描述（router_record_update）——记录是检查点的来源，对话里没进记录的东西只有 notes 能带走。' +
      '返回 compacted:false 表示没有可压的内容（刚压过 / 当前是第一轮），不是错误。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rootSessionId: { type: 'string', description: '根会话 ID（显式传入；任务列表从这里的工作记录生成）' },
        notes: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：自上次压缩以来的关键决策 / 发现 / 用户纠正，每条一句。记录里没有的对话结论靠它带走。',
        },
      },
      required: ['rootSessionId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          compacted: { type: 'boolean' },
          reason: { type: 'string', description: 'compacted=false 时：为什么没有可压的内容' },
          compactionId: { type: 'string' },
          checkpointSeq: { type: 'number', description: '落地的那条检查点消息的 seq' },
          startSeq: { type: 'number' },
          endSeq: { type: 'number' },
          shadowedCount: { type: 'number', description: '被遮蔽的 surface 节点数' },
          sinceCheckpointSeq: { type: 'number', description: '上一份检查点的 seq；缺席 = 本会话第一次压缩' },
          taskCount: { type: 'number' },
          checkpoint: { type: 'string', description: '写进去的检查点正文（原样）' },
        },
        required: ['compacted'],
      },
      render: (_args, value) => {
        const v = value as { compacted: boolean; reason?: string; shadowedCount?: number; taskCount?: number; checkpoint?: string }
        if (v.compacted !== true) return [{ type: 'text', text: `未压缩：${v.reason ?? '没有可压的内容'}` }]
        return [
          {
            type: 'text',
            text: `已压缩 ${String(v.shadowedCount)} 个节点（任务 ${String(v.taskCount)} 条）。检查点正文：\n${v.checkpoint ?? ''}`,
          },
        ]
      },
    },
    async execute(args: unknown, exec: unknown): Promise<unknown> {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new CollaborationError('INVALID_INPUT', '参数必须是对象')
      }
      const a = args as Record<string, unknown>
      const rootSessionId = a.rootSessionId
      if (typeof rootSessionId !== 'string' || rootSessionId.trim() === '') {
        throw new CollaborationError('INVALID_INPUT', 'rootSessionId 必须是非空字符串')
      }
      const notes = a.notes === undefined ? [] : a.notes
      if (!Array.isArray(notes) || notes.some((note) => typeof note !== 'string')) {
        throw new CollaborationError('INVALID_INPUT', 'notes 必须是字符串数组')
      }
      const session = sessionOf(exec)
      const range = findCompactRange(session, balancedBefore)
      if (range === null) {
        return { compacted: false, reason: '上一份检查点之后、当前回合之前没有可压的已闭合内容（刚压过，或当前是第一轮）' }
      }

      // 任务列表：全部任务（含已报告——检查点要承载状态，不只是活跃的）+ 子会话 + 最近报告。
      const tasks = await deps.records.list(rootSessionId, { kind: 'task' })
      const lines: TaskLineInput[] = []
      for (const task of tasks) {
        const [assignments, reports] = await Promise.all([
          deps.records.list(rootSessionId, { taskId: task.taskId, kind: 'assignment' }),
          deps.records.list(rootSessionId, { taskId: task.taskId, kind: 'report' }),
        ])
        const sessions: Array<{ label: string; sessionId: string }> = []
        for (const row of assignments) for (const link of row.sessions ?? []) sessions.push({ label: link.label, sessionId: link.sessionId })
        const latest = reports.sort((left, right) => right.createdAt - left.createdAt)[0]
        lines.push({
          taskId: task.taskId,
          title: task.title,
          body: task.body,
          workLabel: task.workLabel ?? '未标注',
          parentTaskId: task.parentRecordId,
          createdAt: task.createdAt,
          sessions,
          latestReportTitle: latest?.title,
        })
      }
      const text = renderTaskListCheckpoint({ tasks: lines, notes: notes as string[], sinceCheckpointSeq: range.sinceCheckpointSeq })

      // 按宿主压缩事务协议落地：start 锁 → 检查点（原位取代）→ end 释放。
      const compactionId = CompactionId(uuid())
      session.append('compaction/start', { turn: null }, { surfaceOp: 'append' })
      try {
        const message = createUserMessage({ content: [{ type: 'text', text }], source: compactCheckpointSource(compactionId) })
        const landed = session.append('user/message', message, {
          surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
          sourceEventSeqs: range.shadowedSeqs,
        })
        session.append('compaction/end', { turn: null }, { surfaceOp: 'append' })
        return {
          compacted: true,
          compactionId,
          checkpointSeq: landed.seq,
          startSeq: range.startSeq,
          endSeq: range.endSeq,
          shadowedCount: range.shadowedSeqs.length,
          sinceCheckpointSeq: range.sinceCheckpointSeq ?? undefined,
          taskCount: lines.length,
          checkpoint: text,
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        try {
          session.append('compaction/end', { turn: null, error: detail }, { surfaceOp: 'append' })
        } catch {
          // 释放锁失败也不覆盖原始错误。
        }
        throw new CollaborationError('IO_ERROR', `压缩落地失败（锁已闭合）：${detail}`, { cause: error })
      }
    },
  }
}
