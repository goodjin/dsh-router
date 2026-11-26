/**
 * 角色职责进系统提示词（职责不在派发初始指令里）测试。
 *
 * brief 断言：
 *  - 派发初始指令里不再出现角色名与职责正文（职责改由上下文行按会话注入）；
 *  - 被派发的子会话在系统提示词组装结果里拿到「你的角色与职责」段；
 *  - 根会话/非派发会话没有职责段；
 *  - 角色文件缺失或读取失败时不抛、不渲染坏内容（宁缺勿错）；
 *  - 归属靠分工记录反查（sessions[].label），盘上绑定让跨重启（换进程）仍能反查。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { buildDispatchTool } from '../../src/collaboration/dispatch.ts'
import { createRecordStore } from '../../src/collaboration/records.ts'
import { createRoleStore } from '../../src/collaboration/roles.ts'
import { createRoleDutyService } from '../../src/collaboration/role-duty.ts'
import { apply as contextApply } from '../../src/context.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

interface CapturedEntry {
  name: string
  order: number
  text(assembly?: unknown): string
  interpolate?: false
}

/** 注册上下文行，返回捕获到的段（text() 是同步回调）。 */
function registerContextRow(face: {
  dataDir: string
  roles?: { list(): Promise<Array<{ name: string; description: string }>> }
  roleDuties?: { get(sessionId: string): { roleName: string; description: string } | undefined; refresh(sessionId: string): Promise<unknown> }
}): { entry: CapturedEntry; dispose: () => void } {
  let captured: CapturedEntry | undefined
  const dispose = contextApply(
    { systemPrompt: { context: (e: CapturedEntry) => { captured = e } }, routerCollaboration: face as never },
    { order: 100, rolesTtlMs: 0 } as never,
  )
  return { get entry() { return captured! }, dispose }
}

/** 派发一个子会话：假 subagents 服务返回固定 childId。 */
async function dispatchChild(input: {
  records: ReturnType<typeof createRecordStore>
  roles: ReturnType<typeof createRoleStore>
  roleDuties: ReturnType<typeof createRoleDutyService>
  childId: string
  role: string
}): Promise<string> {
  const tool = buildDispatchTool({
    records: input.records,
    roles: input.roles,
    roleDuties: input.roleDuties,
    subagents: {
      async startActivation() {
        return { childId: input.childId }
      },
    },
  })
  const saved = await input.records.create('root-1', { kind: 'task', title: '任务', body: '目标' })
  await tool.execute(
    { rootSessionId: 'root-1', role: input.role, task: '改造登录模块', mode: 'spawn', taskId: saved.record.taskId },
    { agent: { id: 'parent-1', session: 'parent-1' } },
  )
  return input.childId
}

describe('角色职责进系统提示词', () => {
  it('被派发的子会话：组装结果含「你的角色与职责」段；初始指令里没有角色名与职责正文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'router-duty-'))
    roots.push(dir)
    const records = createRecordStore(dir)
    const roles = createRoleStore(dir)
    await roles.save({ name: '执行者', description: '接受分工后独立完成具体工作。' })
    const duties = createRoleDutyService({ dataDir: dir, records, roles })

    const childId = await dispatchChild({ records, roles, roleDuties: duties, childId: 'child-duty', role: '执行者' })

    const row = registerContextRow({ dataDir: dir, roles: { list: async () => roles.list() }, roleDuties: duties })
    const text = row.entry.text({ agent: { id: childId } })
    expect(text).toContain('你的角色与职责')
    expect(text).toContain('执行者')
    expect(text).toContain('接受分工后独立完成具体工作。')
    // 非派发会话（根会话）没有职责段。
    const rootText = row.entry.text({ agent: { id: 'root-session' } })
    expect(rootText).not.toContain('你的角色与职责')
    row.dispose()
  })

  it('跨重启仍能反查：新进程里的服务从盘上绑定 + 分工记录解析出同一份职责', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'router-duty-'))
    roots.push(dir)
    const records = createRecordStore(dir)
    const roles = createRoleStore(dir)
    await roles.save({ name: '测试工程师', description: '写用例并跑回归。' })
    const duties = createRoleDutyService({ dataDir: dir, records, roles })
    const childId = await dispatchChild({ records, roles, roleDuties: duties, childId: 'child-restart', role: '测试工程师' })

    // 换一个服务实例（模拟宿主重启：内存缓存是空的），靠盘上绑定 + 分工记录反查。
    const cold = createRoleDutyService({ dataDir: dir, records, roles })
    expect(cold.get(childId)).toBeUndefined()
    const duty = await cold.refresh(childId)
    expect(duty).toEqual({ roleName: '测试工程师', description: '写用例并跑回归。' })
  })

  it('角色文件缺失：refresh 静默返回 undefined，不抛、不渲染坏内容', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'router-duty-'))
    roots.push(dir)
    const records = createRecordStore(dir)
    const roles = createRoleStore(dir)
    await roles.save({ name: '执行者', description: '职责正文' })
    const duties = createRoleDutyService({ dataDir: dir, records, roles })
    const childId = await dispatchChild({ records, roles, roleDuties: duties, childId: 'child-gone', role: '执行者' })

    // 角色文件被删（用户改过/清理）：冷服务解析不到职责。
    await rm(join(dir, 'collaboration', 'roles', '执行者.md'), { force: true })
    const cold = createRoleDutyService({ dataDir: dir, records, roles })
    await expect(cold.refresh(childId)).resolves.toBeUndefined()

    const row = registerContextRow({ dataDir: dir, roleDuties: cold })
    await cold.refresh(childId)
    const text = row.entry.text({ agent: { id: childId } })
    expect(text).not.toContain('你的角色与职责')
    expect(text).not.toContain('职责正文')
    row.dispose()
  })

  it('没有绑定文件（非派发会话）：refresh 静默返回 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'router-duty-'))
    roots.push(dir)
    const records = createRecordStore(dir)
    const roles = createRoleStore(dir)
    const duties = createRoleDutyService({ dataDir: dir, records, roles })
    await expect(duties.refresh('never-dispatched')).resolves.toBeUndefined()
    expect(duties.get('never-dispatched')).toBeUndefined()
  })

  it('派发工具的初始指令不含角色名与职责正文（职责走系统提示词）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'router-duty-'))
    roots.push(dir)
    const records = createRecordStore(dir)
    const roles = createRoleStore(dir)
    await roles.save({ name: '架构设计工程师', description: '把需求翻译成可实施方案。' })
    const duties = createRoleDutyService({ dataDir: dir, records, roles })
    let promptText = ''
    const tool = buildDispatchTool({
      records,
      roles,
      roleDuties: duties,
      subagents: {
        async startActivation(request) {
          promptText = (request.request.prompt[0] as { text: string }).text
          return { childId: 'child-arch' }
        },
      },
    })
    const saved = await records.create('root-1', { kind: 'task', title: '任务', body: '目标' })
    await tool.execute(
      { rootSessionId: 'root-1', role: '架构设计工程师', task: '设计派发流程', mode: 'spawn', taskId: saved.record.taskId },
      { agent: { id: 'parent-1' } },
    )
    expect(promptText).toContain('设计派发流程')
    expect(promptText).not.toContain('架构设计工程师')
    expect(promptText).not.toContain('把需求翻译成可实施方案。')
    expect(promptText).toContain('你的角色与职责')
  })
})
