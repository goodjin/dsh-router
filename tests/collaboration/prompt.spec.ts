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

  it('record → spawn → remember childId; report → notify', () => {
    expect(collaborationPrompt).toContain('spawn')
    expect(collaborationPrompt).toContain('childId')
    expect(collaborationPrompt).toContain('notify')
  })

  it('saveOK/sendFAIL retain record; createOK/recordFAIL keep childId', () => {
    // 保存成功但通知失败 → 保留记录
    expect(collaborationPrompt).toMatch(/保存.*通知.*保留|保留.*记录/s)
    // 派发会话成功但记录失败 → 保留 childId，不重复 spawn
    expect(collaborationPrompt).toMatch(/childId/s)
  })

  it('decisions belong to the model; acceptance to the user; no auto end', () => {
    expect(collaborationPrompt).toContain('用户')
    expect(collaborationPrompt).toContain('验收')
    expect(collaborationPrompt).toMatch(/不自动结束|不得自动结束|不算完成/s)
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
