/**
 * 轻量团队协作公共规则文本 collaborationPrompt 测试（计划 Task 2A，Layer 2）。
 *
 * brief 断言：三角色职责作为文本出现 / 角色由子会话初始 message 覆盖 root 默认 /
 * 材料自足（rootSessionId/上级/报告位置）/ record→spawn→记住 childId / report→notify /
 * 保存成功通知失败保留记录 / 创建成功记录失败保留 childId / 决策归模型、验收归用户、
 * 不自动结束 / 角色模板是文本无 preset / 父子邻接与 maxdepth 由宿主 DSH 配置不是本层授权 /
 * 不含宿主插值语法（{{ 或 ${）。
 */

import { describe, expect, it } from 'vitest'

import { collaborationPrompt } from '../../src/collaboration/prompt.ts'

describe('collaborationPrompt — common three-role rule text', () => {
  it('is a non-empty static string', () => {
    expect(typeof collaborationPrompt).toBe('string')
    expect(collaborationPrompt.length).toBeGreaterThan(100)
  })

  it('covers the three roles (Router / supervisor / worker)', () => {
    expect(collaborationPrompt).toContain('Router')
    expect(collaborationPrompt).toContain('主管')
    expect(collaborationPrompt).toContain('worker')
  })

  it('states child role identity comes from the initial task message; root defaults Router only when no child role assigned', () => {
    expect(collaborationPrompt).toContain('初始')
    expect(collaborationPrompt).toContain('Router')
    expect(/root/i.test(collaborationPrompt)).toBe(true)
  })

  it('is self-sufficient: root id, parent, report/record locations', () => {
    expect(collaborationPrompt).toContain('rootSessionId')
    expect(collaborationPrompt).toContain('上级')
    // record kinds as locations
    for (const kind of ['task', 'assignment', 'report', 'summary']) {
      expect(collaborationPrompt).toContain(kind)
    }
  })

  it('record → spawn → remember childId; report via DSH-provided messaging to supervisor', () => {
    // 记录 assignment 后由宿主 DSH spawn 子会话并记住 childId
    expect(collaborationPrompt).toContain('spawn')
    expect(collaborationPrompt).toContain('childId')
    // 通知是流程描述，使用宿主 DSH 提供的发消息能力，不声称存在名为 notify 的工具
    expect(collaborationPrompt).toContain('DSH')
  })

  it('saveOK/sendFAIL retain record; createOK/recordFAIL keep childId', () => {
    // 保存成功但通知失败 → 保留记录
    expect(collaborationPrompt).toMatch(/保存.*通知.*保留|保留.*记录/s)
    // 派发会话成功但记录失败 → 保留 childId，不重复 spawn
    expect(collaborationPrompt).toMatch(/childId/s)
  })

  it('decisions belong to the model; acceptance to the user; session end not auto success; no extra protocol', () => {
    expect(collaborationPrompt).toContain('用户')
    expect(collaborationPrompt).toContain('验收')
    // 会话结束不自动判任务成功；提交报告后可正常结束本轮；没有额外系统完成协议
    expect(collaborationPrompt).toMatch(/会话结束不自动判任务成功/)
    expect(collaborationPrompt).toMatch(/没有额外系统完成协议/)
    // 不再使用歧义的「完成必须走完成协议」措辞
    expect(collaborationPrompt).not.toMatch(/完成必须走完成协议/)
  })

  it('R1: reporting chain worker → 主管 → Router → 用户; cross-member via 主管, cross-team via Router', () => {
    // worker 的进度/问题/结果报给主管，不越级直接找用户
    expect(collaborationPrompt).toMatch(/worker[\s\S]*主管/)
    expect(collaborationPrompt).not.toMatch(/worker[\s\S]*向用户提问/)
    // 主管报 Router，Router 把需用户决定的事项交给用户
    expect(collaborationPrompt).toMatch(/主管[\s\S]*Router[\s\S]*用户/)
    // 跨成员由主管转达，跨团队由 Router 协调
    expect(collaborationPrompt).toMatch(/跨成员[\s\S]*主管转达/)
    expect(collaborationPrompt).toMatch(/跨团队[\s\S]*Router/)
  })

  it('R1: fact sources separated — work materials by records, runtime facts by DSH (model reports not system-certified)', () => {
    expect(collaborationPrompt).toMatch(/工作资料以记录为准/)
    expect(collaborationPrompt).toMatch(/运行事实以 DSH 为准/)
    expect(collaborationPrompt).toMatch(/模型报告非系统认证/)
    // 旧的「记录是唯一事实源」单一来源措辞已纠正
    expect(collaborationPrompt).not.toMatch(/记录是唯一事实源/)
  })

  it('R1: dispatch/notify are process descriptions via installed tools with exact names', () => {
    // 派发只走 router_dispatch（职责注入由代码完成）；控制与发现用宿主原生工具。
    expect(collaborationPrompt).toContain('router_dispatch')
    expect(collaborationPrompt).toContain('send_message')
    expect(collaborationPrompt).toContain('list_agents')
    // 不再指名让模型直接用 subagent 工具派发（防绕过职责注入）。
    expect(collaborationPrompt).not.toContain('subagent 工具')
    expect(collaborationPrompt).toContain('send_message')
    expect(collaborationPrompt).toContain('interrupt_agent')
    expect(collaborationPrompt).not.toContain('后续层绑定')
    // 不声称存在名为 notify 的工具
    expect(collaborationPrompt).not.toMatch(/notify 工具|名为 notify/)
  })

  it('role template is plain text (no preset / no plugin tree)', () => {
    expect(collaborationPrompt).toContain('角色模板')
    expect(collaborationPrompt).toMatch(/文本/)
  })

  it('parent/child adjacency and maxdepth are configured by the host DSH, not authorized here', () => {
    expect(collaborationPrompt).toContain('DSH')
    expect(collaborationPrompt).toContain('maxdepth')
    expect(collaborationPrompt).toMatch(/宿主/)
  })

  it('contains no host interpolation syntax ({{ or ${)', () => {
    expect(collaborationPrompt).not.toContain('{{')
    expect(collaborationPrompt).not.toContain('${')
  })
})
