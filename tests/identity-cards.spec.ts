/**
 * v1.3 Task A2：身份卡与切换卡（规格 §2；Review Focus 5 幂等）。
 *
 * - routerIdentityCard / switchCard / minimalSwitchHeader 纯函数（prompts/identity-cards）；
 * - 切换卡三段齐：①身份职责（=类型系统提示词）②本身份工具清单逐一列名（角色裁剪）
 *   ③禁用提醒；
 * - Router 卡投递幂等（requestId=identity-<sessionId>，已发标记入 ui-state，
 *   同会话绝不重发）；dispatchTask 投递内容按模式：cache=切换卡+任务书、
 *   minimal=简化身份头+现行格式（任务书+执行指引）。
 */

import { describe, expect, it } from 'vitest'

import { minimalSwitchHeader, routerIdentityCard, switchCard } from '../src/host/prompts/identity-cards.ts'
import { toolsForRole } from '../src/host/tools/index.ts'
import { UiStateStore, type UiStatePersistence, type UiStateFile } from '../src/host/bridge/tabs.ts'
import { SessionBridge, type SessionBridgeDeps, type SessionBridgeHost } from '../src/host/bridge/sessions.ts'
import { TaskLedger, type LedgerFile, type LedgerPersistence } from '../src/host/ledger/store.ts'
import { TaskDocStore } from '../src/host/docs/task-docs.ts'
import { guardCoreWith } from './helpers/guard-core.ts'

/* ────────────────────────── 纯函数 ────────────────────────── */

describe('routerIdentityCard', () => {
  const card = routerIdentityCard()

  it('带【身份卡】头与 Router 身份声明', () => {
    expect(card).toContain('【身份卡】')
    expect(card).toContain('Router')
    expect(card).toMatch(/编排/)
  })

  it('列全 router 角色白名单工具（逐一列名）', () => {
    for (const tool of toolsForRole('router')) {
      expect(card, tool).toContain(tool)
    }
  })

  it('写明身份卡协议要点：最后一张卡生效、范围外调用被拒', () => {
    expect(card).toMatch(/最后一张|范围外|拒绝/)
  })
})

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

  it('router 卡：列 router 白名单 + 子代理通道（cache 超集挂 delegation，A4 准则）', () => {
    const card = routerIdentityCard()
    for (const tool of toolsForRole('router')) {
      expect(card, tool).toContain(tool)
    }
    expect(card).toContain('subagent')
    expect(card).toMatch(/轻[^。]{0,40}子代理|轻活/)
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

/* ────────────────────────── Router 卡投递（桥） ────────────────────────── */

describe('SessionBridge.deliverRouterIdentityCard：幂等投递', () => {
  function bridgeWith(identityHas: (sessionId: string) => boolean) {
    const prompts: { requestId: string; sessionId: string; text: string; mode: string }[] = []
    const marked: string[] = []
    const host: SessionBridgeHost = {
      create: async () => 'session-x',
      onStatus: () => {},
      prompt: async (request) => {
        prompts.push({ requestId: request.requestId, sessionId: request.sessionId, text: request.content.map((b) => b.text).join('\n'), mode: request.mode })
        return {}
      },
    }
    const deps: SessionBridgeDeps = {
      ledger: { get: () => undefined, transition: async () => undefined as never, attachSession: async () => undefined as never },
      docsFor: () => ({}) as never,
      host,
      presets: { supervisor: 'sup', worker: 'wk' },
      workerInstructions: () => '',
      identityCards: {
        has: identityHas,
        mark: async (sessionId) => {
          marked.push(sessionId)
        },
      },
    }
    return { bridge: new SessionBridge(deps), prompts, marked }
  }

  it('投递一次：requestId=identity-<sessionId>、queue 模式、正文=Router 身份卡；成功后打已发标记', async () => {
    const { bridge, prompts, marked } = bridgeWith(() => false)
    await bridge.deliverRouterIdentityCard('s-9')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.requestId).toBe('identity-s-9')
    expect(prompts[0]!.mode).toBe('queue')
    expect(prompts[0]!.text).toBe(routerIdentityCard())
    expect(marked).toEqual(['s-9'])
  })

  it('已发会话直接跳过（不 prompt、不打标）——重启/多次派发不重发', async () => {
    const { bridge, prompts, marked } = bridgeWith(() => true)
    await bridge.deliverRouterIdentityCard('s-9')
    expect(prompts).toHaveLength(0)
    expect(marked).toHaveLength(0)
  })

  it('投递失败不打已发标记（下次重试；宿主按 requestId 去重兜底）', async () => {
    const prompts: unknown[] = []
    const marked: string[] = []
    const host: SessionBridgeHost = {
      create: async () => 'session-x',
      onStatus: () => {},
      prompt: async (request) => {
        prompts.push(request)
        throw new Error('宿主拒收')
      },
    }
    const deps: SessionBridgeDeps = {
      ledger: { get: () => undefined, transition: async () => undefined as never, attachSession: async () => undefined as never },
      docsFor: () => ({}) as never,
      host,
      presets: { supervisor: 'sup', worker: 'wk' },
      workerInstructions: () => '',
      identityCards: {
        has: () => false,
        mark: async (sessionId) => {
          marked.push(sessionId)
        },
      },
    }
    const bridge = new SessionBridge(deps)
    await expect(bridge.deliverRouterIdentityCard('s-9')).rejects.toThrow('宿主拒收')
    expect(marked).toHaveLength(0)
  })
})

/* ────────────────────────── dispatchTask 投递内容（按模式） ────────────────────────── */

describe('dispatchTask 投递内容（v1.3 规格 §2.3/§2.4）', () => {
  it('cache-priority：投递 = 切换卡（含类型系统提示词与角色工具清单）+ 任务书；不含执行指引', async () => {
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
    expect(delivery.text).toMatch(/任务书/)
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

  it('minimal-face（缺省）：投递 = 简化身份头 + 任务书 + 现行执行指引', async () => {
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
    expect(delivery.text).toContain('【执行指引】')
    expect(delivery.text).toMatch(/任务书/)
  })

  it('cache-priority：supplement 重投 = 任务书（身份已在历史，不重发切换卡与指引）', async () => {
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
    expect(supplement.text).toContain('加目录')
    expect(supplement.text).not.toContain('【身份切换卡】')
    expect(supplement.text).not.toContain('【执行指引】')
  })
})

/* ────────────────────────── 收编正主：登记 + 补发（评审 F4） ────────────────────────── */

describe('adoptCanonicalRouterSessions：收编正主先登记 Router 会话再补发身份卡', () => {
  it('未登记的正主：先 register（带 workspace）再 deliver', async () => {
    const { adoptCanonicalRouterSessions } = await import('../src/host/bridge/dedup-adopt.ts')
    const calls: string[] = []
    await adoptCanonicalRouterSessions({
      canonicals: [{ workspaceId: 'ws-1', sessionId: 'picker-1' }],
      known: () => false,
      register: async (sessionId, workspaceId) => {
        calls.push(`register:${sessionId}:${workspaceId}`)
      },
      deliver: async (sessionId) => {
        calls.push(`deliver:${sessionId}`)
      },
    })
    expect(calls).toEqual(['register:picker-1:ws-1', 'deliver:picker-1'])
  })

  it('已登记的正主只补发身份卡（不重写登记名）；deliver 抛错不外泄（entry 有告警兜底）', async () => {
    const { adoptCanonicalRouterSessions } = await import('../src/host/bridge/dedup-adopt.ts')
    const calls: string[] = []
    await expect(
      adoptCanonicalRouterSessions({
        canonicals: [{ workspaceId: 'ws-1', sessionId: 'ours-1' }],
        known: (sessionId) => sessionId === 'ours-1',
        register: async () => {
          calls.push('register')
        },
        deliver: async () => {
          throw new Error('投递失败')
        },
      }),
    ).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })
})

/* ────────────────────────── 观察租约释放（评审 F7） ────────────────────────── */

describe('releaseObservation：.dispose 与 [Symbol.dispose] 双通道释放', () => {
  it('两个通道都调（宿主观察租约用 Symbol.dispose，适配器此前只转发 .dispose）', async () => {
    const { releaseObservation } = await import('../src/host/bridge/sessions.ts')
    const calls: string[] = []
    const sym = (Symbol as unknown as { dispose?: symbol }).dispose
    const observation: unknown = {
      dispose: () => {
        calls.push('prop')
      },
      ...(sym !== undefined ? { [sym]: () => void calls.push('symbol') } : {}),
    }
    releaseObservation(observation)
    expect(calls).toContain('prop')
    expect(sym === undefined || calls.includes('symbol')).toBe(true)
  })

  it('空观察/无任何释放面时不抛（冷会话 undefined）', async () => {
    const { releaseObservation } = await import('../src/host/bridge/sessions.ts')
    expect(() => releaseObservation(undefined)).not.toThrow()
    expect(() => releaseObservation({})).not.toThrow()
  })
})


/* ────────────────────────── dedup 正主清单（收编补发数据源） ────────────────────────── */

describe('dedup 正主清单（收编补发数据源）', () => {
  it('暴露已 pin 的正主会话清单（workspace 配对；无正主时为空）', async () => {
    const { RouterDedup } = await import('../src/host/bridge/dedup.ts')
    const pinned: string[] = []
    const archived: string[] = []
    const dedup = new RouterDedup({
      workspaces: {
        list: () => [{ id: 'ws-1', sessionIds: ['dup-1', 'canon-1'] }],
      },
      sessionQuery: {
        readSession: async (sessionId) => ({
          session: { agentPreset: 'dsh-router', createdAt: sessionId === 'canon-1' ? 1 : 2 },
          events: [],
        }),
      },
      registry: {
        pinSession: async (sessionId) => {
          pinned.push(sessionId)
        },
        archiveSession: async (sessionId) => {
          archived.push(sessionId)
        },
        archivedSessionIds: [],
      },
      routerPreset: 'dsh-router',
    })
    await dedup.resolve()
    expect(dedup.canonicalSessions()).toEqual([{ workspaceId: 'ws-1', sessionId: 'canon-1' }])
    expect(pinned).toContain('canon-1')
    expect(archived).toContain('dup-1')
  })

  it('分叉/种子会话不是 Router（评审 F2）：agentPreset=dsh-router 但 isSeeded=true 不进正主、不归档', async () => {
    const { RouterDedup } = await import('../src/host/bridge/dedup.ts')
    const archived: string[] = []
    const dedup = new RouterDedup({
      workspaces: {
        // seeded-1（fork worker，继承 router 预设）比真 Router 更早：若误认会反客为主
        list: () => [{ id: 'ws-1', sessionIds: ['seeded-1', 'real-1'] }],
      },
      sessionQuery: {
        readSession: async (sessionId) =>
          sessionId === 'seeded-1'
            ? { session: { agentPreset: 'dsh-router', createdAt: 1, isSeeded: true }, events: [] }
            : { session: { agentPreset: 'dsh-router', createdAt: 2 }, events: [] },
      },
      registry: {
        pinSession: async () => ({}),
        archiveSession: async (sessionId) => {
          archived.push(sessionId)
        },
        archivedSessionIds: [],
      },
      routerPreset: 'dsh-router',
    })
    await dedup.resolve()
    expect(dedup.canonicalSessions()).toEqual([{ workspaceId: 'ws-1', sessionId: 'real-1' }])
    // seeded（fork worker）既不是正主候选、也不进归档收编
    expect(archived).toEqual([])
  })
})
