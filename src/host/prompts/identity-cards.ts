/**
 * 身份切换卡（v1.3 规格 §2，Task A2 纯函数；2026-11-09 起 Router 撤卡）。
 *
 * 身份进历史不进系统提示词：cache-priority 模式的 persona 身份中立（unified.ts），
 * 具体身份由系统投递的卡片声明——
 * - Router 会话**不再投卡**（2026-11-09 裁定）：Router 是长期会话，身份由预设
 *   persona（prompts/router.ts）直定，不把身份钉进历史；
 * - switchCard(type, role)：分叉创建 worker 后投递的第一条消息的前段（三段：
 *   ①身份职责=该类型的系统提示词——类型提示词的生效位置从预设 persona 移到此处；
 *   ②本身份可用工具清单逐一列名（cache 超集下的角色裁剪表）；③禁用提醒）。
 *   任务简述（含任务书文档地址）紧随其后由投递方拼接；
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

/**
 * 宿主执行工具行（评审 F3）：统一超集给执行身份挂了 bash/fs/fs-search——清单里
 * 必须逐一列名，否则「禁用提醒」会挡住正常执行。router（编排件）按设计不列：
 * 它的产出是任务书与汇报，不是命令与文件（规格 §6 承接的误用风险）。
 */
const EXECUTION_TOOL_LINES: readonly string[] = [
  '- bash：执行 shell 命令（跑测试、构建、查环境事实）。',
  '- fs：读写文件（读代码与材料、写交付物）。',
  '- fs-search：按文件名或内容搜索（找代码、找配置、找输入材料）。',
]

/** 技能挂载提示（评审 F6）：技能行按类型挂载，卡面如实声明「以会话实际在场为准」。 */
const SKILLS_NOTE = '- 若本类型配置了技能，会话里另有技能加载与技能调用工具，按会话实际挂载为准；没有挂载就如实用 report_blocker 说明。'

/** 本插件白名单内一个工具的卡面行（描述与注册定义同源）。 */
function toolLine(name: string): string {
  return `- ${name}：${orchestrationToolDescription(name as never)}`
}

/** 本身份可用工具清单（逐一列名；含 ask_user，主管加子代理，执行身份加宿主执行工具）。 */
function toolSection(role: RoleKind): string {
  const lines = toolsForRole(role).map(toolLine)
  if (role === 'supervisor') {
    lines.push('- subagent：一次性子代理（进程内 spawn，空会话起步）：轻量收尾快的工作用它，提示词写自包含，结果随完成通知回来。')
  }
  if (role !== 'router') {
    lines.push(...EXECUTION_TOOL_LINES)
    lines.push(SKILLS_NOTE)
  }
  lines.push(ASK_USER_LINE)
  return lines.join('\n')
}

/**
 * 身份切换卡（分叉创建 worker 后投递的第一条消息的前段；主管分叉 worker 同路径
 * 同格式）。三段：①身份与职责（=该类型的系统提示词全文）②本身份可用工具清单
 * （逐一列名，按角色裁剪）③禁用提醒。任务简述（含任务书文档地址）由投递方
 * 紧随其后拼接。
 *
 * 2026-11-09 起 Router 会话不再投身份卡——Router 身份由预设 persona 直定
 * （长期会话不宜把身份钉在历史里）；只有接收任务的 worker/supervisor 用本卡。
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
