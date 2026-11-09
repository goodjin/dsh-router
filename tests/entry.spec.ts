/**
 * 入口 sanity + 装载接线（源码级；产物级断言在 bundle.spec.ts；根服务组装
 * 逻辑在 router-core.spec.ts）。
 *
 * 宿主侧 src/entry.ts 声明 inject 与防御性 Config；浏览器半边 src/client/index.ts
 * 是真正的工厂：name/inject/apply 齐全，apply 用注入的服务注册全部界面表面
 * （conversation.header.leading / shell.overlay /
 * settings.section，键名以 R3 报告为准），并把轮询生命周期挂进 ctx.effect。
 * 组件绝不收 ctx——表面经 registration 的 inject 工厂拿到业务 face。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply as clientApply, inject as clientInject, name as clientName } from '../src/client/index.ts'
import { Config as rootConfig, bindSessionLifecycle, inject, makeIdentityCardDeliverer, name, resolveRootConfig } from '../src/entry.ts'
import { SessionHeaderIndex } from '../src/host/session/session-index.ts'
import {
  hoverDarkenStyle,
  LightTooltip,
  LIGHT_TOOLTIP_STYLE,
  useHoverDarken,
} from '../src/client/ui-kit.tsx'

describe('宿主侧入口 src/entry.ts', () => {
  it('name 是裸包名；必需服务在 inject 里（缺席 fail loud）', () => {
    expect(name).toBe('@goodjin2/dsh-router')
    // B8 起 sessionQuery（压缩锚点+记忆租约）与 llm（摘要流）也是必需服务；
    // v1.1 C1 起 agentPresets 也是（动态注册预设的宿主注册表，r4 §1）。
    expect(inject).toEqual(['sessionController', 'agents', 'workspaceRegistry', 'sessionQuery', 'llm', 'agentPresets'])
  })

  it('Config 全部可缺省：空 config 也过校验（防御性解析在 apply 内）', () => {
    expect(() => rootConfig({})).not.toThrow()
    expect(() => rootConfig(undefined)).not.toThrow()
    expect(() => rootConfig({ maxDepth: 5, maxActiveCards: 20, templates: [
      { templateId: 'coder', name: '编码', description: '', role: 'worker' },
    ] })).not.toThrow()
  })

  it('workerSpawnMode（v1.3 C2）：两合法值过校验、非法值拒；防御性解析缺省/非法回 cache-priority', () => {
    expect(() => rootConfig({ workerSpawnMode: 'cache-priority' })).not.toThrow()
    expect(() => rootConfig({ workerSpawnMode: 'minimal-face' })).not.toThrow()
    expect(() => rootConfig({ workerSpawnMode: 'bogus' as unknown as 'cache-priority' })).toThrow()
    // 运行时默认由 resolveRootConfig 兜底（Schemastery union 的缺省物化行为
    // 随宿主版本浮动，插件自己保证：缺省/非法一律 cache-priority）。
    expect(resolveRootConfig({}).workerSpawnMode).toBe('cache-priority')
    expect(resolveRootConfig({ workerSpawnMode: 'minimal-face' }).workerSpawnMode).toBe('minimal-face')
    expect(resolveRootConfig({ workerSpawnMode: 'bogus' }).workerSpawnMode).toBe('cache-priority')
    expect(resolveRootConfig(undefined).workerSpawnMode).toBe('cache-priority')
  })
})

describe('宿主侧入口 src/entry.ts：收编走受限索引（v1.4 性能修复接线）', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/entry.ts', import.meta.url)), 'utf8')

  it('构造 SessionHeaderIndex（root/preset/持久化/成员面）并挂生命周期与 live 事件', () => {
    expect(source).toMatch(/new SessionHeaderIndex\(\{/)
    expect(source).toMatch(/routerPreset: config\.routerPreset/)
    expect(source).toMatch(/sessionHeaderIndex\.dispose\(\)/)
    expect(source).toMatch(/bindSessionLifecycle\(/)
  })

  it('收编扫描只接索引面：资格授予 + 定点核验，不再接整日志 readSession', () => {
    const at = source.indexOf('scanAndAdoptRouterSessions(')
    expect(at).toBeGreaterThan(0)
    const block = source.slice(at, at + 1200)
    expect(block).toContain('index:')
    expect(block, '收编不得回落到整日志读取').not.toContain('readSession')
    expect(block, '收编不得再自己枚举宿主成员面').not.toContain('workspaceRegistry.list')
  })
})

describe('宿主侧入口 src/entry.ts：live 生命周期接线（真实事件绑定）', () => {
  it('session/created / session/event / session/disposed 三个事件都接到索引', () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
      on: (event: string, listener: (...args: unknown[]) => unknown) => { listeners.set(event, listener) },
    }
    const calls: string[] = []
    bindSessionLifecycle(ctx, {
      onLiveSession: () => { calls.push('created') },
      onLiveSessionEvent: () => { calls.push('event') },
      onLiveSessionDisposed: () => { calls.push('disposed') },
    })
    expect([...listeners.keys()].sort()).toEqual(['session/created', 'session/disposed', 'session/event'])
    listeners.get('session/created')?.({ id: 's1' })
    listeners.get('session/event')?.({ id: 's1' }, { type: 'agent-preset/selected' })
    listeners.get('session/disposed')?.({ id: 's1' })
    expect(calls).toEqual(['created', 'event', 'disposed'])
  })

  it('disposed 事件真的撤销 live 权威（真实索引 + 真实事件通道）', async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = { on: (event: string, listener: (...args: unknown[]) => unknown) => { listeners.set(event, listener) } }
    const index = new SessionHeaderIndex({
      root: '/nonexistent-router-entry-root',
      routerPreset: 'dsh-router',
      resolveLivePreset: () => 'dsh-router',
    })
    bindSessionLifecycle(ctx, index)
    const session = { id: 's-live', header: { id: 's-live', version: 4, createdAt: 1, isSeeded: false } }
    listeners.get('session/created')?.(session)
    expect(index.verdictOf('s-live')).toMatchObject({ status: 'classified', verdict: 'router' })
    // 会话离开 live store → live 权威撤销 → 不再授权。
    listeners.get('session/disposed')?.(session)
    expect(index.verdictOf('s-live').status).not.toBe('classified')
    await index.dispose()
  })
})

describe('宿主侧入口 src/entry.ts：身份卡投递的失败语义（review I2）', () => {
  it('strict 包装传播失败；lenient 包装只告警', async () => {
    const warns: string[] = []
    const deliverer = makeIdentityCardDeliverer(async () => { throw new Error('prompt failed') }, {
      warn: (message) => { warns.push(message) },
    })
    await expect(deliverer.strict('s1')).rejects.toThrow('prompt failed')
    await expect(deliverer.lenient('s1')).resolves.toBeUndefined()
    expect(warns.join(' ')).toContain('prompt failed')
  })
})

/** 记录型假 ctx：captured 记 inject/register 调用，services 全部可空转。 */
function recordingCtx() {
  const captured = {
    injected: [] as string[],
    registered: [] as Array<{ name: string; id?: string; order?: number }>,
    /** inject 键 → 这次 prepare 里登记的 name 列表（登记 name 必须等于槽位键）。 */
    pairs: [] as Array<{ key: string; names: string[] }>,
    effects: 0,
    infos: [] as string[],
    warns: [] as string[],
  }
  const slots = {
    inject: (key: string, prepare: () => unknown) => {
      captured.injected.push(key)
      const before = captured.registered.length
      const result = prepare()
      captured.pairs.push({ key, names: captured.registered.slice(before).map((entry) => entry.name) })
      return result
    },
    register: (options: { name: string; id?: string; order?: number }, _component: unknown) => {
      captured.registered.push({ name: options.name, id: options.id, order: options.order })
      return options
    },
  }
  const ctx = {
    logger: (_name: string) => ({
      info: (message: string) => { captured.infos.push(message) },
      warn: (message: string) => { captured.warns.push(message) },
    }),
    effect: (callback: () => unknown) => { captured.effects += 1; return callback() },
    slots,
    uiSession: {
      adapter: {
        current: {
          subscribe: (_listener: () => void) => () => {},
          getSnapshot: () => ({ key: 's1' }),
        },
      },
    },
    uiWorkspace: { openSession: (_id: string) => {} },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
  }
  return { ctx, captured }
}

describe('浏览器半边 src/client/index.ts：工厂面', () => {
  it('name 与包名一致；inject 按页面真实服务名声明（R3 报告）', () => {
    expect(clientName).toBe('@goodjin2/dsh-router')
    expect(clientInject).toEqual(['slots', 'uiSession', 'uiWorkspace', 'workspaces', 'sessions'])
  })

  it('apply 注册全部表面：键名正确、id 各自独立（shell.overlay 两项；不再注册提示词视图）', () => {
    const { ctx, captured } = recordingCtx()
    expect(() => clientApply(ctx)).not.toThrow()
    // shell.overlay 是 list 级槽位：统一待处理浮窗 + 返回按钮，避免问题卡重复挂载。
    // 2026-11 提示词 UI 移除：conversation.view 的「提示词」视图不再注册。
    expect([...captured.injected].sort()).toEqual([
      'settings.section',
      'router.session-window.detail',
      'shell.overlay',
      'shell.overlay',
      'conversation.header.leading',
    ].sort())
    expect(captured.injected, '提示词视图已移除，不得再注入 conversation.view').not.toContain('conversation.view')
    const ids = captured.registered.map((entry) => entry.id)
    expect(ids).toContain('router-workbench-tabs')
    expect(ids).not.toContain('router-question-overlay')
    expect(ids).toContain('router-back-button')
    expect(ids).not.toContain('router-system-prompt')
    expect(ids).toContain('router-notification-overlay')
    expect(ids).toContain('router-settings')
    expect(new Set(ids).size).toBe(ids.length)
    // 登记的 name 必须就是槽位键（slots.register 的 name 指向被注入的 slot）。
    for (const pair of captured.pairs) {
      expect(pair.names, `表面 ${pair.key} 的 registration name 应为槽位键本身`).toContain(pair.key)
    }
  })

  it('自报一行状态；轮询生命周期挂在 ctx.effect 上', () => {
    const { ctx, captured } = recordingCtx()
    clientApply(ctx)
    expect(captured.infos).toHaveLength(1)
    expect(captured.infos[0]).toMatch(/client loaded/i)
    expect(captured.effects).toBeGreaterThanOrEqual(1)
  })

  it('服务缺失时不抛、只警告（降级不炸 entry）', () => {
    const infos: string[] = []
    const warns: string[] = []
    expect(() => clientApply({
      logger: () => ({ info: (message: string) => { infos.push(message) }, warn: (message: string) => { warns.push(message) } }),
    })).not.toThrow()
    expect(warns.join(' ')).not.toBe('')
    expect(() => clientApply(undefined)).not.toThrow()
    expect(() => clientApply({})).not.toThrow()
  })
})

describe('ui-kit 导出形状（规格 §9 样式基线，供 C3 设置页复用）', () => {
  it('LightTooltip / useHoverDarken / hoverDarkenStyle 是函数，样式常量在', () => {
    expect(typeof LightTooltip).toBe('function')
    expect(typeof useHoverDarken).toBe('function')
    expect(typeof hoverDarkenStyle).toBe('function')
    expect(typeof LIGHT_TOOLTIP_STYLE).toBe('object')
    expect(LIGHT_TOOLTIP_STYLE).not.toBeNull()
    expect(String(LIGHT_TOOLTIP_STYLE.background)).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('浏览器面全部组件不再用原生 title 悬浮提示（规格 §9 禁原生黑浮层）', () => {
    const files = [
      'back-button.tsx',
      'question-cards.tsx',
      'settings.tsx',
      'ui-kit.tsx',
      'workbench-tabs.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(fileURLToPath(new URL(`../src/client/${file}`, import.meta.url)), 'utf8')
      const hits = source.match(/\stitle="/g)
      expect(hits, `${file} 还有原生 title 悬浮提示（应换 ui-kit 的 LightTooltip）`).toBeNull()
    }
  })
})
