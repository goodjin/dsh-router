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
  it('records the user’s main task before splitting, including standalone tasks', () => {
    expect(collaborationPrompt).toMatch(/先.*主任务.*task 记录.*根会话.*不拆分/)
    expect(collaborationPrompt).toMatch(/汇总.*主任务.*summary/)
  })

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

  it('R1（两级模型）: reporting chain worker → Router → 用户; Router 直接担任主管，跨成员与跨团队都由 Router 转达/协调', () => {
    // Router 主会话直接担任主管：不再有可派发的「主管」层
    expect(collaborationPrompt).toContain('Router 主会话直接担任主管')
    expect(collaborationPrompt).not.toMatch(/派主管|派给主管|报给主管/)
    // worker 的进度/问题/结果报给 Router，不越级直接找用户
    expect(collaborationPrompt).toMatch(/worker[\s\S]*报给 Router/)
    expect(collaborationPrompt).toMatch(/不要越级直接找用户/)
    // Router 把需用户决定的事项交给用户
    expect(collaborationPrompt).toMatch(/Router[\s\S]*需用户决定的事项交给用户/)
    // 跨成员与跨团队都由 Router 承担
    expect(collaborationPrompt).toMatch(/跨成员沟通由 Router 转达/)
    expect(collaborationPrompt).toMatch(/跨团队协调由 Router 协调/)
  })

  it('两级模型的派发契约：taskId 可选（省略即自动建任务）、continue 泛化到任意子会话、追加要求自动拼进任务描述', () => {
    expect(collaborationPrompt).toMatch(/省略 taskId[\s\S]*自动新建一条任务/)
    expect(collaborationPrompt).toContain('parentTaskId')
    // 追加需求：先用 router_record_list 查该任务的分工记录拿子会话，再 continue
    expect(collaborationPrompt).toMatch(/router_record_list\(taskId=归属任务, kind=assignment\)/)
    expect(collaborationPrompt).toMatch(/mode=continue, expectedChildId=/)
    // 追加要求自动拼进任务描述，不要再手动重复更新
    expect(collaborationPrompt).toMatch(/自动拼进该任务的描述/)
    // Router 自己组队：吸收了原主管的组织纪律
    expect(collaborationPrompt).toContain('你自己组队')
    expect(collaborationPrompt).toContain('## 按任务类型组队（八类）')
    expect(collaborationPrompt).toContain('## 复杂度分级参考')
  })

  it('上下文与压缩由插件代劳：活跃任务完整描述每步注入、子会话结束自动压缩', () => {
    expect(collaborationPrompt).toContain('## 上下文与压缩')
    expect(collaborationPrompt).toMatch(/活跃任务[\s\S]*完整描述/)
    expect(collaborationPrompt).toMatch(/子会话结束时[\s\S]*自动压缩/)
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

  it('Router 把拷问式对齐（grilling）作为理解需求的核心纪律：决策树 + 按轮前沿 + 推荐答案', () => {
    // Router 的价值是把模糊想法逼成想得透、说得清、可直接分派的需求；方法就是 grilling。
    expect(collaborationPrompt).toContain('拷问式对齐')
    expect(collaborationPrompt).toContain('决策树')
    // 按轮推进，每轮只问当前「前沿问题」，不问依赖未听答案的问题
    expect(collaborationPrompt).toMatch(/轮/)
    expect(collaborationPrompt).toContain('前沿问题')
    // 每个问题带推荐答案、措辞成「是=接受推荐」，让用户一句同意就能推进
    expect(collaborationPrompt).toContain('推荐')
    // 事实自己查、决策留给用户；对齐到位才建任务/分派，之前不动手
    expect(collaborationPrompt).toMatch(/自己查|自己查/)
    expect(collaborationPrompt).toMatch(/对齐.*才.*建主任务|对齐到位后/)
  })

  it('Router 拷问纪律点出被动失败模式，要求让用户真的做决定、真的反对', () => {
    expect(collaborationPrompt).toContain('被动')
    // 一场没让你反驳的拷问，是一场你不需要的拷问
    expect(collaborationPrompt).toMatch(/反驳|反对/)
  })
})

describe('collaborationPrompt — 任务类型速查（角色库 v2）', () => {
  it('包含八类任务的常用角色组合速查', () => {
    for (const marker of ['需求理解与PRD', '技术设计', '功能开发', 'bugfix', '测试', 'MR审核', '调研', '归档与发布']) {
      expect(collaborationPrompt).toContain(marker)
    }
  })

  it('速查表点到扩容后的关键角色名', () => {
    for (const name of ['需求与PRD工程师', '架构设计工程师', '测试工程师', 'MR审核员', '代码评审员', '部署运维工程师']) {
      expect(collaborationPrompt).toContain(name)
    }
  })

  it('保留简单任务单人直达的原则（不硬拉团队）', () => {
    expect(collaborationPrompt).toContain('简单任务')
  })
})
