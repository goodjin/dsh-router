/**
 * v1.3 Task A2 + 2026-11-09 裁定：身份切换卡（规格 §2）。
 *
 * - Router 会话不再投身份卡（身份由 prompts/router.ts persona 直定）；
 * - switchCard / minimalSwitchHeader 纯函数（prompts/identity-cards）；
 * - 切换卡三段齐：①身份职责（=类型系统提示词）②本身份工具清单逐一列名（角色
 *   裁剪）③禁用提醒；
 * - dispatchTask 投递内容（2026-11-09 派发语义）：切换卡 + 简洁任务分派
 *  （【任务分派】+ 任务书文档地址，全文由 worker 自读；minimal 另附执行指引）。
 */

import { describe, expect, it } from 'vitest'

import { minimalSwitchHeader, switchCard } from '../src/host/prompts/identity-cards.ts'
import { toolsForRole } from '../src/host/tools/index.ts'
import { UiStateStore, type UiStatePersistence, type UiStateFile } from '../src/host/bridge/tabs.ts'
import { SessionBridge, type SessionBridgeDeps, type SessionBridgeHost } from '../src/host/bridge/sessions.ts'
import { TaskLedger, type LedgerFile, type LedgerPersistence } from '../src/host/ledger/store.ts'
import { TaskDocStore } from '../src/host/docs/task-docs.ts'
import { guardCoreWith } from './helpers/guard-core.ts'
import { createFakeIndex } from './helpers/adoption-index.ts'

/* ────────────────────────── 纯函数 ────────────────────────── */

describe('switchCard：三段齐（①身份职责=类型系统提示词 ②工具清单逐一列名 ③禁用提醒）', () => {
  const type = { name: '文档写手', systemPrompt: '你是文档写手，负责把文档写对。' }

  it('worker 卡：三段齐全、含类型系统提示词全文', () => {
    const card = switchCard(type, 'worker')
    expect(card).toContain('【身份切换卡】')
    expect(card).toContain('文档写手')
    expect(card).toContain(type.systemPrompt)
    expect(card).toMatch(/可用工具/)
    expect(card).toMatch(/禁用|不要调用/)
  })

  it('worker 卡：只列 worker 白名单 + ask_user；不出现派发工具名', () => {
    const card = switchCard(type, 'worker')
    for (const tool of toolsForRole('worker')) {
      expect(card, tool).toContain(tool)
    }
    expect(card).toContain('ask_user')
    expect(card).not.toContain('dispatch_task')
    expect(card).not.toContain('query_tasks')
    expect(card).not.toContain('create_worker_type')
  })

  it('worker 卡：含宿主执行工具（bash/fs/fs-search）与技能挂载提示（评审 F3/F6）', () => {
    const card = switchCard(type, 'worker')
    expect(card).toContain('bash')
    expect(card).toContain('fs')
    expect(card).toContain('fs-search')
    expect(card).toMatch(/技能/)
  })

  it('supervisor 卡：列 supervisor 白名单 + 子代理工具 + 执行工具；禁主管链工具不出现', () => {
    const card = switchCard({ name: '主管型', systemPrompt: '主管提示词' }, 'supervisor')
    for (const tool of toolsForRole('supervisor')) {
      expect(card, tool).toContain(tool)
    }
    expect(card).toContain('subagent')
    expect(card).toContain('bash')
    expect(card).not.toContain('create_worker_type')
  })
})

describe('minimalSwitchHeader：简化身份头（无工具重申）', () => {
  it('带【身份切换卡】与类型名；不列任何工具名（工具面按预设挂载）', () => {
    const header = minimalSwitchHeader({ name: '文档写手' }, 'worker')
    expect(header).toContain('【身份切换卡】')
    expect(header).toContain('文档写手')
    expect(header).not.toContain('dispatch_task')
    expect(header).not.toContain('complete_task')
    expect(header).not.toContain('report_progress')
  })
})

/* ────────────────────────── 已发标记（ui-state） ────────────────────────── */

function memUiPersistence(file: UiStateFile = { schemaVersion: 1, routerSessions: [], tabs: [] }) {
  const persistence: UiStatePersistence & { file: UiStateFile } = {
    file,
    async load() {
      return this.file
    },
    async save(f) {
      this.file = JSON.parse(JSON.stringify(f)) as UiStateFile
    },
  }
  return persistence
}

describe('UiStateStore：身份卡已发标记（Review Focus 5）', () => {
  it('mark 后 has 为 true；重复 mark 幂等（单条记录）；未 mark 会话 has 为 false', async () => {
    const ui = new UiStateStore(memUiPersistence(), () => 1)
    await ui.load()
    expect(ui.hasIdentityCard('s-1')).toBe(false)
    await ui.markIdentityCardSent('s-1')
    await ui.markIdentityCardSent('s-1')
    expect(ui.hasIdentityCard('s-1')).toBe(true)
    expect(ui.hasIdentityCard('s-2')).toBe(false)
  })

  it('标记落盘并在重启（新实例 load）后保持——跨重启不重发', async () => {
    const persistence = memUiPersistence()
    const ui = new UiStateStore(persistence, () => 1)
    await ui.load()
    await ui.markIdentityCardSent('s-1')
    const revived = new UiStateStore(persistence, () => 1)
    await revived.load()
    expect(revived.hasIdentityCard('s-1')).toBe(true)
  })

  it('旧文件（无 identityCards 字段）装载后按空表处理，不炸 load', async () => {
    const persistence = memUiPersistence({ schemaVersion: 1, routerSessions: [{ sessionId: 'r', name: 'Router', createdAt: 1 }], tabs: [] })
    const ui = new UiStateStore(persistence, () => 1)
    await ui.load()
    expect(ui.hasIdentityCard('r')).toBe(false)
    expect(ui.routerSessions()).toEqual([{ sessionId: 'r', title: 'Router' }])
  })
})

/* ────────────────────────── dispatchTask 投递内容（按模式） ────────────────────────── */

describe('dispatchTask 投递内容（2026-11-09 派发语义：切换卡 + 简洁任务分派）', () => {
  it('cache-priority：投递 = 切换卡 + 【任务分派】简述（含任务书文档地址，不含全文与执行指引）', async () => {
    const h = await guardCoreWith({ mode: 'cache-priority' })
    await h.core.dispatchTask('router-s-1', {
      title: '写文档',
      goal: '写出文档',
      acceptance: ['文档存在'],
      role: 'worker',
      templateId: 'coder',
    })
    const delivery = h.events.prompts.find((p) => p.requestId.startsWith('dispatch-') || p.requestId.startsWith('switch-'))!
    expect(delivery).toBeDefined()
    expect(delivery.text).toContain('【身份切换卡】')
    expect(delivery.text).toContain('编码')
    expect(delivery.text).toContain('【任务分派】')
    expect(delivery.text).toContain('目标：写出文档')
    // 文档地址（相对任务 cwd）让 worker 自己读全文
    expect(delivery.text).toMatch(/\.router\/tasks\/[^/]+\/task\.v1\.md/)
    expect(delivery.text).toContain('先读全文')
    expect(delivery.text).not.toContain('【执行指引】')
  })

  it('cache-priority：supervisor 角色的任务卡带编排+子代理清单', async () => {
    const h = await guardCoreWith({ mode: 'cache-priority' })
    await h.core.dispatchTask('router-s-1', {
      title: '拆解',
      goal: '拆解工作',
      acceptance: ['完成'],
      role: 'supervisor',
      templateId: 'lead',
    })
    const delivery = h.events.prompts.find((p) => p.requestId.startsWith('dispatch-') || p.requestId.startsWith('switch-'))!
    expect(delivery.text).toContain('dispatch_task')
    expect(delivery.text).toContain('subagent')
  })

  it('minimal-face（缺省）：投递 = 简化身份头 + 任务分派 + 现行执行指引', async () => {
    const h = await guardCoreWith({})
    await h.core.dispatchTask('router-s-1', {
      title: '写文档',
      goal: '写出文档',
      acceptance: ['文档存在'],
      role: 'worker',
      templateId: 'coder',
    })
    const delivery = h.events.prompts.find((p) => p.requestId.startsWith('dispatch-'))!
    expect(delivery.text).toContain('【身份切换卡】')
    expect(delivery.text).toContain('编码')
    expect(delivery.text).toContain('【任务分派】')
    expect(delivery.text).toMatch(/\.router\/tasks\/[^/]+\/task\.v1\.md/)
    expect(delivery.text).toContain('【执行指引】')
  })

  it('supplement 重投 = 【任务补充】升版简述 + 新版文档地址（不重发切换卡与指引）', async () => {
    const h = await guardCoreWith({ mode: 'cache-priority' })
    await h.core.dispatchTask('router-s-1', {
      title: '写文档',
      goal: '写出文档',
      acceptance: ['文档存在'],
      role: 'worker',
      templateId: 'coder',
    })
    const taskId = (await h.ledger.listAll())[0]!.id
    await h.core.supplementTask('router-s-1', taskId, ['补充：加目录'])
    const prompts = h.events.prompts
    const supplement = prompts.filter((p) => p.requestId.startsWith('dispatch-')).at(-1)!
    expect(supplement.text).toContain('【任务补充】')
    expect(supplement.text).toContain('加目录')
    expect(supplement.text).toMatch(/task\.v2\.md/)
    expect(supplement.text).not.toContain('【身份切换卡】')
    expect(supplement.text).not.toContain('【执行指引】')
  })
})

/* ────────────────────────── 收编扫描（v1.4：不去重，独立多 Router） ────────────────────────── */

/**
 * 索引替身：判定面 + 定点核验全 ok（收编语义见 router-adoption-index.spec）。
 * 收编面现在只认「资格授予」——替身把给定 id 都当作已授予的 router 候选。
 */
function adoptionIndex(verdicts: Record<string, 'router' | 'nonrouter'>) {
  const ids = Object.keys(verdicts)
  return createFakeIndex({
    verdicts,
    members: Object.fromEntries(ids.map((id) => [id, 'ws-1'])),
    grants: ids,
  })
}

describe('scanAndAdoptRouterSessions：扫描收编（登记 + 补发身份卡，不归档不跳转）', () => {
  it('Router 预设会话：未登记先 register 再 deliver；已登记只 deliver', async () => {
    const { scanAndAdoptRouterSessions } = await import('../src/host/bridge/router-adoption.ts')
    const calls: string[] = []
    const fake = adoptionIndex({ 'picker-1': 'router', 'picker-2': 'router' })
    await scanAndAdoptRouterSessions({
      index: fake.index,
      known: (id) => id === 'picker-2',
      register: async (id, ws) => { calls.push(`register:${id}:${ws}`) },
      deliver: async (id) => { calls.push(`deliver:${id}`) },
    }, 'dsh-router')
    expect(calls).toEqual(['register:picker-1:ws-1', 'deliver:picker-1', 'deliver:picker-2'])
  })

  it('非 Router 预设会话：跳过（不登记不投递）', async () => {
    const { scanAndAdoptRouterSessions } = await import('../src/host/bridge/router-adoption.ts')
    const calls: string[] = []
    const fake = adoptionIndex({ 'worker-1': 'nonrouter' })
    await scanAndAdoptRouterSessions({
      index: fake.index,
      known: () => false,
      register: async (id, ws) => { calls.push(`register:${id}:${ws}`) },
      deliver: async (id) => { calls.push(`deliver:${id}`) },
    }, 'dsh-router')
    expect(calls).toEqual([])
  })

  it('单个会话失败不拖垮其余（下轮重试）', async () => {
    const { scanAndAdoptRouterSessions, createRouterAdoptionCache } = await import('../src/host/bridge/router-adoption.ts')
    const calls: string[] = []
    const warns: string[] = []
    let badFailing = true
    const fake = adoptionIndex({ 'bad-1': 'router', 'good-1': 'router' })
    const deps = {
      index: fake.index,
      known: () => false,
      register: async (id: string, ws: string) => {
        if (id === 'bad-1' && badFailing) throw new Error('boom')
        calls.push(`register:${id}:${ws}`)
      },
      deliver: async (id: string) => { calls.push(`deliver:${id}`) },
      logger: { warn: (m: string) => { warns.push(m) } },
    }
    const cache = createRouterAdoptionCache()
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { baseBackoffMs: 0, maxBackoffMs: 0 })
    expect(calls).toEqual(['register:good-1:ws-1', 'deliver:good-1'])
    expect(warns.some((m) => m.includes('bad-1'))).toBe(true)

    // 下一轮：失败候选退避后重试成功，收编补齐（不退避就还在冷却里）。
    badFailing = false
    await scanAndAdoptRouterSessions(deps, 'dsh-router', cache, { baseBackoffMs: 0, maxBackoffMs: 0 })
    expect(calls).toEqual(['register:good-1:ws-1', 'deliver:good-1', 'register:bad-1:ws-1', 'deliver:bad-1'])
  })
})
