/**
 * 身份卡与切换卡（v1.3 规格 §2，Task A2 纯函数）。
 *
 * 身份进历史不进系统提示词：cache-priority 模式的 persona 身份中立（unified.ts），
 * 具体身份由系统投递的卡片声明——
 * - routerIdentityCard()：Router 会话创建后投递的首条消息（职责 + 本身份工具范围）；
 * - switchCard(type, role)：分叉创建 worker 后投递的第一条消息的前段（三段：
 *   ①身份职责=该类型的系统提示词——类型提示词的生效位置从预设 persona 移到此处；
 *   ②本身份可用工具清单逐一列名（cache 超集下的角色裁剪表）；③禁用提醒）。
 *   任务书全文紧随其后由投递方拼接（规格 §2.3 三件套的第三件）；
 * - minimalSwitchHeader(type, role)：最小面模式沿用现行 persona 分置，投递只带
 *   简化身份头（无工具重申必要，仍带身份声明保持协议一致，规格 §2.4）。
 *
 * 工具清单的唯一来源是执行层白名单 toolsForRole（tools/index.ts）——卡片声称的
 * 范围与 assertCallerRole 的硬闸矩阵严格一致；逐条描述取 orchestrationToolDescription
 * （与注册描述同源，不设第二份文本）。
 */

import type { RoleKind } from '../../shared/types.ts'
import { orchestrationToolDescription, toolsForRole } from '../tools/index.ts'

/** 切换卡的身份输入（类型记录的投影：名字 + 该类型的系统提示词）。 */
export interface IdentityTypeInput {
  name: string
  systemPrompt: string
}

/** 角色 → 中文身份标签（卡面用语；brief 的裁剪表：router=编排件、supervisor=编排+子代理、worker=执行件）。 */
const ROLE_LABEL: Record<RoleKind, string> = {
  router: '编排件：理解需求、拆解派发、追踪汇总',
  supervisor: '编排+执行件：自己承担部分工作，也可拆分子任务',
  worker: '执行件：把单个任务做完做对',
}

/** ask_user 是宿主原生工具（不在本插件白名单内），三身份都可用。 */
const ASK_USER_LINE = '- ask_user：向用户提问。只问真正必要的问题；问题直达用户界面浮窗，回答直接回到你的工具结果里。'

/** 本插件白名单内一个工具的卡面行（描述与注册定义同源）。 */
function toolLine(name: string): string {
  return `- ${name}：${orchestrationToolDescription(name as never)}`
}

/** 本身份可用工具清单（逐一列名；含 ask_user，主管加子代理）。 */
function toolSection(role: RoleKind): string {
  const lines = toolsForRole(role).map(toolLine)
  if (role === 'supervisor') {
    lines.push('- subagent：一次性子代理（进程内 spawn，空会话起步）：轻量收尾快的工作用它，提示词写自包含，结果随完成通知回来。')
  }
  lines.push(ASK_USER_LINE)
  return lines.join('\n')
}

/** Router 身份卡（Router 会话创建成功后投递一次；requestId=identity-<sessionId> 幂等）。 */
export function routerIdentityCard(): string {
  return `【身份卡】你是 Router：长期在线的任务编排器。用户的每一句话都说给你；真正的执行工作由独立的执行会话完成。

## 职责与边界

- 理解需求、澄清模糊处、把需求整理成任务（目标、验收条件、约束）、派发、追踪、汇总汇报。
- 你不亲自执行任务里的具体工作（不写代码、不跑命令）：这些属于执行会话。你的产出是清楚的任务书与准确的进度汇报。
- 可以连续接收多条需求：派发完成后不要等待执行结果，继续处理用户的下一条消息。执行会话的进展通过任务快照与通知到达你这里。
- 无需执行的事实问题直接回答，不建任务、不派发。答不准的先向用户澄清，再决定是否需要执行。
- 简单单步任务直接派 worker：一个执行会话一次做完，不要升级主管。多步、需要协调多方、或有依赖拆分的任务才派 supervisor；单点工作永远不要套两层。
- 派发前拿不准类型时先用 list_worker_types 查询，templateId 以它为准；没有合适的类型就先 create_worker_type 再派。
- 任何关于任务当前状态的问题，用 query_tasks 查询，不要凭对话记忆断言。回答「进行得怎么样」前先查。
- 完成的任务结果与用户决定会自动进入记忆：回答「之前做过什么、定过什么」类问题前先 search_history，命中为空就如实说没有记录，不要编造。

## 本身份可用工具（逐一列名；范围外的调用会被系统拒绝——不要尝试）

${toolSection('router')}
`
}

/**
 * 身份切换卡（分叉创建 worker 后投递的第一条消息的前段；主管分叉 worker 同路径
 * 同格式）。三段：①身份与职责（=该类型的系统提示词全文）②本身份可用工具清单
 * （逐一列名，按角色裁剪）③禁用提醒。任务书全文由投递方紧随其后拼接。
 */
export function switchCard(type: IdentityTypeInput, role: RoleKind): string {
  const prompt = type.systemPrompt.trim() !== '' ? type.systemPrompt : `你是「${type.name}」的执行者，完成分派给你的任务。`
  return `【身份切换卡】你现在是「${type.name}」——${ROLE_LABEL[role]}。本卡权威最高：此前所有身份声明作废，以本卡为准。

## 身份与职责

${prompt}

## 本身份可用工具（逐一列名）

${toolSection(role)}

## 禁用提醒

- 上面清单之外的工具，即使你能在会话里看到，也一律不要调用：调用会被系统直接拒绝，只会浪费你一轮。需要范围外的工作，用 report_blocker 说明，由编排方处理。
`
}

/**
 * 最小面模式的投递头（规格 §2.4）：现行 persona 分置不变，投递仍带身份声明保持
 * 协议一致，但不重申工具清单（工具面由该会话预设实际挂载决定）。
 */
export function minimalSwitchHeader(type: { name: string }, role: RoleKind): string {
  return `【身份切换卡】你现在是「${type.name}」（${ROLE_LABEL[role]}）。此前身份声明作废，以本卡为准；可用工具以本会话实际挂载为准。下面投递任务书。`
}
