/**
 * 入口接线测试（轻量协作版，计划 Task 3 起）。
 *
 * 宿主侧 src/entry.ts 已重写为薄根服务 + 机会式薄路由（见 tests/collaboration/host-routes.spec.ts
 * 用真实 Cordis Context 验证）。本文件断言浏览器半边工厂面：src/client/index.ts 注册**协作工作台**
 * 单一表面（头部「协作工作台」按钮 + 可关闭浮层），旧的工作台标签条/问题浮窗/返回按钮/设置段
 * 一概不再注册（oldsurfacesnotregistered）。ui-kit 形状断言保留。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply as clientApply, inject as clientInject, name as clientName } from '../src/client/index.ts'
import type { CollaborationStore } from '../src/client/collaboration-store.ts'
import { hoverDarkenStyle, LightTooltip, LIGHT_TOOLTIP_STYLE, useHoverDarken } from '../src/client/ui-kit.tsx'

describe('浏览器半边 src/client/index.ts：协作工作台单一表面', () => {
  it('name 与包名一致；inject 按页面真实服务名声明（slots/uiSession/uiWorkspace）', () => {
    expect(clientName).toBe('@goodjin2/dsh-router')
    expect(clientInject).toEqual(['slots', 'uiSession', 'uiWorkspace'])
  })

  it('apply 注册协作工作台：头部 leading 一个按钮，旧表面一概不注册', () => {
    const { ctx, captured } = recordingCtx()
    expect(() => clientApply(ctx)).not.toThrow()
    expect([...captured.injected].sort()).toEqual(['conversation.header.leading'].sort())
    // 旧表面已退役，不得再注入。
    expect(captured.injected, '旧标签条/浮窗/设置段已退役，不得再注入').not.toContain('shell.overlay')
    expect(captured.injected).not.toContain('settings.section')
    const ids = captured.registered.map((entry) => entry.id)
    expect(ids).toEqual(['router-collaboration-workbench'])
    expect(new Set(ids).size).toBe(ids.length)
    for (const pair of captured.pairs) {
      expect(pair.names, `表面 ${pair.key} 的 registration name 应为槽位键本身`).toContain(pair.key)
    }
  })

  it('自报一行状态；当前会话订阅清理挂在 ctx.effect 上', () => {
    const { ctx, captured } = recordingCtx()
    clientApply(ctx)
    expect(captured.infos).toHaveLength(1)
    expect(captured.infos[0]).toMatch(/collaboration workbench/i)
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

describe('I3 客户端激活守卫 — 服务 getter/method 抛错不穿透 apply（source entry）', () => {
  /** 在 ctx 上装一个「访问即抛错」的访问器属性（真 getter throw，不是缺失、不是普通方法）。 */
  const defineThrowing = (target: Record<string, unknown>, key: string, label: string): void => {
    Object.defineProperty(target, key, { configurable: true, get() { throw new Error(`${label} getter threw`) } })
  }

  it('slots getter 抛错：apply 不穿透，不注册表面', () => {
    const { ctx, captured } = recordingCtx()
    defineThrowing(ctx as unknown as Record<string, unknown>, 'slots', 'slots')
    expect(() => clientApply(ctx)).not.toThrow()
    expect(captured.registered.map((r) => r.id)).toEqual([])
  })

  it('uiSession getter 抛错：apply 不穿透，表面仍注册（根会话留空）', () => {
    const { ctx, captured } = recordingCtx()
    defineThrowing(ctx as unknown as Record<string, unknown>, 'uiSession', 'uiSession')
    expect(() => clientApply(ctx)).not.toThrow()
    expect(captured.registered.map((r) => r.id)).toEqual(['router-collaboration-workbench'])
  })

  it('uiWorkspace getter 抛错：apply 不穿透，表面仍注册（no-op 跳转）', () => {
    const { ctx, captured } = recordingCtx()
    defineThrowing(ctx as unknown as Record<string, unknown>, 'uiWorkspace', 'uiWorkspace')
    expect(() => clientApply(ctx)).not.toThrow()
    expect(captured.registered.map((r) => r.id)).toEqual(['router-collaboration-workbench'])
  })

  it('uiSession 缺失：表面仍注册（根会话留空，不臆造）', () => {
    const { ctx, captured } = recordingCtx()
    delete (ctx as { uiSession?: unknown }).uiSession
    expect(() => clientApply(ctx)).not.toThrow()
    expect(captured.registered.map((r) => r.id)).toEqual(['router-collaboration-workbench'])
  })

  it('uiWorkspace 缺失：表面仍注册（no-op 跳转 + 可见诊断）', () => {
    const { ctx, captured } = recordingCtx()
    delete (ctx as { uiWorkspace?: unknown }).uiWorkspace
    expect(() => clientApply(ctx)).not.toThrow()
    expect(captured.registered.map((r) => r.id)).toEqual(['router-collaboration-workbench'])
  })

  it('logger.info/warn 抛错：不穿透（落 console 兜底）', () => {
    const { ctx } = recordingCtx()
    ctx.logger = () => ({ info: () => { throw new Error('info boom') }, warn: () => { throw new Error('warn boom') } })
    expect(() => clientApply(ctx)).not.toThrow()
  })

  it('uiSession.subscribe 抛错：不穿透，表面仍注册', () => {
    const { ctx, captured } = recordingCtx()
    ;(ctx as { uiSession: unknown }).uiSession = {
      adapter: { current: { subscribe: () => { throw new Error('subscribe boom') }, getSnapshot: () => ({ key: 's1' }) } },
    }
    expect(() => clientApply(ctx)).not.toThrow()
    expect(captured.registered.map((r) => r.id)).toEqual(['router-collaboration-workbench'])
  })

  it('ctx.effect 抛错：不穿透，订阅立即清理（不留无限残留）', () => {
    const disposed: string[] = []
    const { ctx } = recordingCtx()
    ;(ctx as { effect?: unknown }).effect = () => { throw new Error('effect boom') }
    ;(ctx as { uiSession: unknown }).uiSession = {
      adapter: { current: { subscribe: () => () => { disposed.push('session') }, getSnapshot: () => ({ key: 's1' }) } },
    }
    expect(() => clientApply(ctx)).not.toThrow()
    expect(disposed).toEqual(['session'])
  })

  it('effect 缺席：订阅立即清理（不留无限残留）', () => {
    const disposed: string[] = []
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {} }),
      slots: { inject: (_k: string, p: () => unknown) => p(), register: (_o: unknown, _c: unknown) => ({}) },
      uiSession: { adapter: { current: { subscribe: () => () => { disposed.push('session') }, getSnapshot: () => ({ key: 's1' }) } } },
    }
    expect(() => clientApply(ctx as never)).not.toThrow()
    expect(disposed).toEqual(['session'])
  })

  it('effect 在位：订阅保留（真实执行 setup、保存 disposer，激活后不立即清理）', () => {
    const disposed: string[] = []
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {} }),
      // 真实宿主语义：effect 执行 setup 并保存其返回的 disposer（供卸载调用）。
      effect: (cb: () => unknown) => cb(),
      slots: { inject: (_k: string, p: () => unknown) => p(), register: (_o: unknown, _c: unknown) => ({}) },
      uiSession: { adapter: { current: { subscribe: () => () => { disposed.push('session') }, getSnapshot: () => ({ key: 's1' }) } } },
    }
    expect(() => clientApply(ctx as never)).not.toThrow()
    expect(disposed).toEqual([])
  })

  it('激活后订阅存活、宿主切会话同步默认根、卸载清理、effect 抛错仍立即清理', () => {
    const h = lifecycleHarness('ok')
    expect(() => clientApply(h.ctx as never)).not.toThrow()
    // 激活后订阅存活（回归：曾 setup 即 dispose → live=0）。
    expect(h.live()).toBe(1)
    expect(h.disposed()).toEqual([])
    // 初始同步当前会话 A 为默认根。
    expect(h.store().get().currentSessionId).toBe('A')
    expect(h.store().effectiveRootId()).toBe('A')
    // 宿主切会话 A→B：触发订阅回调，store 默认根随之更新。
    h.switchTo('B')
    expect(h.store().get().currentSessionId).toBe('B')
    expect(h.store().effectiveRootId()).toBe('B')
    // 卸载执行 disposer 后订阅释放。
    expect(typeof h.getCleanup()).toBe('function')
    expect(() => h.getCleanup()!()).not.toThrow()
    expect(h.live()).toBe(0)
    expect(h.disposed()).toEqual(['session'])
  })

  it('effect 抛错：绑定失败仍立即清理订阅（不留无限残留）', () => {
    const h = lifecycleHarness('throw')
    expect(() => clientApply(h.ctx as never)).not.toThrow()
    expect(h.live()).toBe(0)
    expect(h.disposed()).toEqual(['session'])
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

  it('浏览器面全部组件不再用原生 title 悬浮提示', () => {
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
      expect(hits, `${file} 还有原生 title 悬浮提示`).toBeNull()
    }
  })
})

/** 记录型假 ctx：captured 记 inject/register 调用，services 全部可空转。 */
function recordingCtx() {
  const captured = {
    injected: [] as string[],
    registered: [] as Array<{ name: string; id?: string; order?: number }>,
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

/**
 * 正常路径订阅生命周期 harness：effect **真实执行 setup 并保存返回的 disposer**（真宿主语义），
 * uiSession.subscribe 记录 listener 并计 live/disposed，可模拟宿主切换会话（改 key + 触发回调）。
 * effectMode 'throw' 模拟 effect 绑定抛错（走立即清理降级）。
 */
function lifecycleHarness(effectMode: 'ok' | 'throw' = 'ok') {
  let listener: (() => void) | undefined
  let liveCount = 0
  const disposedList: string[] = []
  let currentKey = 'A'
  let cleanup: (() => void) | undefined
  let faceRef: { store: CollaborationStore } | undefined
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    effect: effectMode === 'throw'
      ? () => { throw new Error('effect boom') }
      : (cb: () => unknown) => { cleanup = cb() as (() => void) | undefined; return cleanup },
    slots: {
      inject: (_key: string, prepare: () => unknown) => prepare(),
      register: (options: { inject?: () => unknown }, _component: unknown) => {
        const face = options.inject?.()
        if (face && typeof face === 'object' && 'store' in face) faceRef = face as { store: CollaborationStore }
        return {}
      },
    },
    uiSession: {
      adapter: {
        current: {
          subscribe: (l: () => void) => {
            listener = l
            liveCount += 1
            return () => { liveCount -= 1; disposedList.push('session') }
          },
          getSnapshot: () => ({ key: currentKey }),
        },
      },
    },
    uiWorkspace: { openSession: () => {} },
  }
  return {
    ctx,
    store: () => faceRef!.store,
    live: () => liveCount,
    disposed: () => [...disposedList],
    getCleanup: () => cleanup,
    switchTo: (key: string) => { currentKey = key; listener?.() },
  }
}
