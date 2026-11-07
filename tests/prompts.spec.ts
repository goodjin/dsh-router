/**
 * 提示词模板契约测试（计划 B2）：三份角色模板 + worker 执行指引。
 *
 * 只测内容契约（角色边界、工具清单、完成协议、上下文可见性、{{model}} 插值）；
 * yml 与模板的逐字同步在 bundle.spec 里看守。
 */

import { describe, expect, it } from 'vitest'

import { routerPrompt } from '../src/host/prompts/router.ts'
import { supervisorPrompt } from '../src/host/prompts/supervisor.ts'
import { workerPrompt } from '../src/host/prompts/worker.ts'
import { workerInstructions } from '../src/host/prompts/worker-instructions.ts'

describe('routerPrompt', () => {
  it('含 {{model}} 插值变量', () => {
    expect(routerPrompt).toContain('{{model}}')
  })

  it('写明角色边界：只编排不亲自做', () => {
    expect(routerPrompt).toContain('Router')
    expect(routerPrompt).toMatch(/不亲自|不要亲自|不直接/)
  })

  it('说明上下文可见性：活动任务快照自动注入、完整历史不在窗口', () => {
    expect(routerPrompt).toContain('活动任务')
    expect(routerPrompt).toMatch(/快照/)
    expect(routerPrompt).toMatch(/query_tasks/)
  })

  it('列出编排五工具与使用时机 + ask_user', () => {
    for (const tool of ['dispatch_task', 'supplement_task', 'query_tasks', 'control_task', 'search_history', 'ask_user']) {
      expect(routerPrompt, tool).toContain(tool)
    }
  })

  it('写明完成协议：worker 提交、验收策略、Router 不代为完成', () => {
    expect(routerPrompt).toContain('complete_task')
    expect(routerPrompt).toMatch(/review-pending|待验收/)
  })

  it('说明 worker 提问不经 Router 转述', () => {
    expect(routerPrompt).toMatch(/浮窗|直接送达|不经 Router/)
  })

  it('层级自决（v1.1 C6 规格 §3.1）：简单单步直接派 worker，多步/需协调才派主管', () => {
    expect(routerPrompt).toMatch(/简单.{0,20}(直接派|直接指派)worker|简单单步/)
    expect(routerPrompt).toMatch(/多步|需要协调|有依赖/)
    expect(routerPrompt).toMatch(/才派|才.{0,6}主管|指派 supervisor/)
  })

  it('直答路径（v1.1 C6 规格 §3.2）：无需执行的事实问题直接回答，不建任务不派发', () => {
    expect(routerPrompt).toMatch(/直接回答/)
    expect(routerPrompt).toMatch(/不建任务|不要建任务|不派发/)
  })

  it('用户不是执行器（v1.1 C6 规格 §3.5）：不得要求用户跑命令/粘贴输出/报告系统状态', () => {
    expect(routerPrompt).toMatch(/不得要求|不要要求|禁止/)
    expect(routerPrompt).toMatch(/运行命令|跑命令|执行命令/)
    expect(routerPrompt).toMatch(/粘贴/)
  })
})

describe('supervisorPrompt', () => {
  it('含 {{model}} 与主管边界：可再拆分、受深度限制', () => {
    expect(supervisorPrompt).toContain('{{model}}')
    expect(supervisorPrompt).toContain('dispatch_task')
    expect(supervisorPrompt).toMatch(/深度|maxDepth|层数/)
  })

  it('列出主管七工具', () => {
    for (const tool of ['dispatch_task', 'supplement_task', 'query_tasks', 'control_task', 'search_history', 'report_progress', 'complete_task']) {
      expect(supervisorPrompt, tool).toContain(tool)
    }
  })

  it('写明完成协议版本号要求', () => {
    expect(supervisorPrompt).toContain('complete_task')
    expect(supervisorPrompt).toMatch(/docVersion|版本/)
  })

  it('双通道（v1.1 C6 规格 §3.3）：简单子任务派子代理，多轮/提问/持久产品派 worker', () => {
    expect(supervisorPrompt).toMatch(/子代理/)
    expect(supervisorPrompt).toMatch(/一次性/)
    expect(supervisorPrompt).toMatch(/结果.{0,12}(随|以).{0,6}(完成通知|通知)|完成通知/)
    expect(supervisorPrompt).toMatch(/多轮|提问|持久/)
    expect(supervisorPrompt).toMatch(/worker/)
  })

  it('子代理语义（r6 §4）：spawn 空会话起步提示词自包含；明说不要依赖 list_agents（0.2.1 无此工具）', () => {
    expect(supervisorPrompt).toMatch(/自包含|独立会话/)
    expect(supervisorPrompt).toMatch(/不要依赖 list_agents|不依赖 list_agents/)
    expect(supervisorPrompt).toMatch(/report_blocker/)
  })

  it('禁止主管链（v1.1 C6 规格 §3.4）：主管之下不得再派 supervisor', () => {
    expect(supervisorPrompt).toMatch(/不得再派|禁止再派|不能再派|不再派/)
    expect(supervisorPrompt).toMatch(/supervisor|主管/)
  })

  it('用户不是执行器（v1.1 C6 规格 §3.5）：同样禁止要求用户跑命令/粘贴输出', () => {
    expect(supervisorPrompt).toMatch(/运行命令|跑命令|执行命令|粘贴/)
  })
})

describe('workerPrompt', () => {
  it('含 {{model}} 与 worker 边界：无派发工具', () => {
    expect(workerPrompt).toContain('{{model}}')
    expect(workerPrompt).toMatch(/无权派发|不能派发|没有派发|不派发/)
    expect(workerPrompt).not.toContain('dispatch_task')
  })

  it('列出执行三工具与 ask_user', () => {
    for (const tool of ['report_progress', 'complete_task', 'report_blocker', 'ask_user']) {
      expect(workerPrompt, tool).toContain(tool)
    }
  })

  it('写明完成协议：必须用工具提交，自然结束不算完成', () => {
    expect(workerPrompt).toContain('complete_task')
    expect(workerPrompt).toMatch(/自然结束|不算完成|必须调用/)
    expect(workerPrompt).toContain('report_blocker')
  })

  it('提问纪律（v1.1 C6）：有合理默认就继续不问；提问前先看任务书是否已有答案', () => {
    expect(workerPrompt).toMatch(/合理默认|有默认/)
    expect(workerPrompt).toMatch(/先.{0,10}任务书|任务书.{0,10}已有/)
  })

  it('用户不是执行器（v1.1 C6 规格 §3.5）：禁止让用户执行命令或粘贴输出', () => {
    expect(workerPrompt).toMatch(/禁止|不要|不得/)
    expect(workerPrompt).toMatch(/执行命令|运行命令|跑命令/)
    expect(workerPrompt).toMatch(/粘贴/)
  })
})

describe('workerInstructions（随任务书投递的执行指引）', () => {
  it('指向任务书并要求按验收条件工作', () => {
    expect(workerInstructions).toMatch(/任务书/)
    expect(workerInstructions).toContain('验收')
  })

  it('写明完成协议：complete_task + 当前版本号 + 版本不符被拒', () => {
    expect(workerInstructions).toContain('complete_task')
    expect(workerInstructions).toMatch(/版本/)
  })

  it('写明提问与阻塞通道', () => {
    expect(workerInstructions).toContain('ask_user')
    expect(workerInstructions).toContain('report_blocker')
    expect(workerInstructions).toContain('report_progress')
  })

  it('写明补充约束以最新版本为准', () => {
    expect(workerInstructions).toMatch(/补充|最新版本/)
  })

  it('纪律要点同步（v1.1 C6）：先读任务书再问、有合理默认继续、禁止让用户跑命令/粘贴输出', () => {
    expect(workerInstructions).toMatch(/先读|先看/)
    expect(workerInstructions).toMatch(/合理默认|有默认/)
    expect(workerInstructions).toMatch(/执行命令|运行命令|跑命令/)
    expect(workerInstructions).toMatch(/粘贴/)
  })
})
