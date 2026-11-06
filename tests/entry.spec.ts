/**
 * 入口 sanity + 装载接线（源码级；产物级断言在 bundle.spec.ts；根服务组装
 * 逻辑在 router-core.spec.ts）。
 *
 * 宿主侧 src/entry.ts 声明 inject 与防御性 Config；浏览器半边 src/client/index.ts
 * 是真正的工厂：name/inject/apply 齐全，apply 用注入的服务注册全部界面表面
 * （conversation.header.leading / shell.overlay / sidebar.footer.action /
 * settings.section，键名以 R3 报告为准），并把轮询生命周期挂进 ctx.effect。
 * 组件绝不收 ctx——表面经 registration 的 inject 工厂拿到业务 face。
 */

import { describe, expect, it } from 'vitest'
import { apply as clientApply, inject as clientInject, name as clientName } from '../src/client/index.ts'
import { Config as rootConfig, inject, name } from '../src/entry.ts'

describe('宿主侧入口 src/entry.ts', () => {
  it('name 是裸包名；必需服务在 inject 里（缺席 fail loud）', () => {
    expect(name).toBe('@goodjin2/dsh-router')
    // B8 起 sessionQuery（压缩锚点+记忆租约）与 llm（摘要流）也是必需服务。
    expect(inject).toEqual(['sessionController', 'agents', 'workspaceRegistry', 'sessionQuery', 'llm'])
  })

  it('Config 全部可缺省：空 config 也过校验（防御性解析在 apply 内）', () => {
    expect(() => rootConfig({})).not.toThrow()
    expect(() => rootConfig(undefined)).not.toThrow()
    expect(() => rootConfig({ maxDepth: 5, maxActiveCards: 20, templates: [
      { templateId: 'coder', name: '编码', description: '', role: 'worker' },
    ] })).not.toThrow()
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
    expect(clientInject).toEqual(['slots', 'uiSession', 'uiWorkspace', 'workspaces'])
  })

  it('apply 注册全部四个表面：键名正确、id 各自独立', () => {
    const { ctx, captured } = recordingCtx()
    expect(() => clientApply(ctx)).not.toThrow()
    expect([...captured.injected].sort()).toEqual([
      'settings.section',
      'shell.overlay',
      'sidebar.footer.action',
      'conversation.header.leading',
    ].sort())
    const ids = captured.registered.map((entry) => entry.id)
    expect(ids).toContain('router-workbench-tabs')
    expect(ids).toContain('router-question-overlay')
    expect(ids).toContain('router-create-entry')
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
