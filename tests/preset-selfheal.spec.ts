/**
 * v1.3.1 热修钉子：注册表缺位自愈与 Duplicate 容忍。
 *
 * 背景（现场：Router 会话切模型报「未知 preset」）：机制 = 冷恢复
 * resumeObserved → composeAgent → resolve('dsh-router')，注册表缺位即报
 * agent-preset/not-found。缺位窗口 = 插件 fiber 重应用的注销/重注册间隙与
 * 注册失败遗留。本组测试钉住两个防线：①register 撞 Duplicate（上一代注册
 * 仍在）时沿用既有注册而非打掉；②ensureRouterPresent 在缺位时自愈重注册、
 * 在册时零开销直过。
 */

import { describe, expect, it } from 'vitest'

import { DynamicPresetEngine } from '../src/host/presets/lifecycle.ts'
import { ROUTER_PRESET_ID } from '../src/host/presets/dynamic.ts'
import { makeMemFs } from './helpers/mem-fs.ts'

interface FakeRegistry {
  registered: Map<string, () => Promise<void>>
  registerThrowsDuplicate: boolean
  register(def: { id: string }): Promise<() => Promise<void>>
}

function fakeEngine(opts: { duplicate?: boolean } = {}) {
  const calls: string[] = []
  const registry: FakeRegistry = {
    registered: new Map(),
    registerThrowsDuplicate: opts.duplicate === true,
    async register(def) {
      if (registry.registerThrowsDuplicate || registry.registered.has(def.id)) {
        throw new Error(`Duplicate agent preset: ${def.id}`)
      }
      const id = def.id
      const unregister = async () => {
        calls.push(`unregister:${id}`)
        registry.registered.delete(id)
      }
      registry.registered.set(id, unregister)
      calls.push(`register:${id}`)
      return unregister
    },
  }
  const cleanups: (() => void)[] = []
  const engine = new DynamicPresetEngine({
    presets: registry,
    // 真 ctx.effect 语义：清理函数存到 fiber 销毁时才执行（不是当场调用）。
    effect: (fn: () => unknown) => {
      cleanups.push(fn as () => void)
      return () => {}
    },
    logger: { info: (m: string) => calls.push(`info:${m}`), warn: (m: string) => calls.push(`warn:${m}`) },
  })
  return { engine, registry, calls, cleanups }
}

describe('register 的 Duplicate 容忍（v1.3.1 热修）', () => {
  it('上一代注册仍在（Duplicate）→ 沿用既有注册：不打掉既有注册、视为成功', async () => {
    // 预置「上一代」注册：registry 已有同 id（外部种子，非本引擎登记）
    const seeded: string[] = []
    const { engine, calls } = fakeEngine({ duplicate: true })
    void seeded
    const outcome = await engine.syncRouter('cache-priority')
    expect(outcome).toBe('dynamic')
    expect(calls.some((entry) => entry.startsWith('info:') && entry.includes('沿用既有注册'))).toBe(true)
    // 关键断言：绝不发生注销（打掉上一代注册 = 冷恢复报未知 preset 的元凶）
    expect(calls.some((entry) => entry.startsWith('unregister:'))).toBe(false)
  })

  it('真实注册（无冲突）→ 正常登记，disposers 可注销', async () => {
    const { engine } = fakeEngine()
    const outcome = await engine.syncRouter('cache-priority')
    expect(outcome).toBe('dynamic')
    expect(engine.registeredIds()).toContain(ROUTER_PRESET_ID)
  })
})

describe('ensureRouterPresent 自愈（v1.3.1 热修）', () => {
  it('在册 → 直过（零注册调用）', async () => {
    const { engine, calls } = fakeEngine()
    await engine.syncRouter('cache-priority')
    const before = calls.filter((entry) => entry.startsWith('register:')).length
    expect(await engine.ensureRouterPresent('cache-priority')).toBe(true)
    expect(calls.filter((entry) => entry.startsWith('register:')).length).toBe(before)
  })

  it('缺位（重应用窗口遗留）→ 告警并按当前模式重注册', async () => {
    const { engine, calls } = fakeEngine()
    // 初始未注册：ensure 触发自愈
    expect(await engine.ensureRouterPresent('minimal-face')).toBe(true)
    expect(engine.registeredIds()).toContain(ROUTER_PRESET_ID)
    expect(calls.some((entry) => entry.startsWith('warn:') && entry.includes('自愈'))).toBe(true)
    void makeMemFs
  })
})
