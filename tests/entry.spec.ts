/**
 * 入口接线测试（轻量协作版，计划 Task 2B，Layer 3）。
 *
 * 宿主侧 src/entry.ts 已重写为薄根服务：裸包名、inject 为空（只 provide 不 require
 * 旧宿主服务）、Config 只有 dataDir、apply 提供 routerCollaboration 单实例。旧
 * resolveRootConfig/bindSessionLifecycle/fireAndForget/SessionHeaderIndex/收编/
 * 判定器/预算那套装配整体退役（见 docs/superpowers/specs/2026-11-16-router-lightweight-
 * design.md），相应断言随之下线——新入口的宿主面断言在 tests/collaboration/host-entry.spec.ts。
 *
 * 本文件保留**未变**的浏览器半边工厂面与 ui-kit 形状断言（src/client 本轮不动，下一层
 * Task 3 接工作台）。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply as clientApply, inject as clientInject, name as clientName } from '../src/client/index.ts'
import { hoverDarkenStyle, LightTooltip, LIGHT_TOOLTIP_STYLE, useHoverDarken } from '../src/client/ui-kit.tsx'

describe('浏览器半边 src/client/index.ts：工厂面（本轮不变，Task 3 接工作台）', () => {
  it('name 与包名一致；inject 按页面真实服务名声明', () => {
    expect(clientName).toBe('@goodjin2/dsh-router')
    expect(clientInject).toEqual(['slots', 'uiSession', 'uiWorkspace', 'workspaces'])
  })

  it('apply 注册全部表面：键名正确、id 各自独立', () => {
    const { ctx, captured } = recordingCtx()
    expect(() => clientApply(ctx)).not.toThrow()
    expect([...captured.injected].sort()).toEqual([
      'settings.section',
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
