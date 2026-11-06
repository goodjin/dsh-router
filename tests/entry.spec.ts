/**
 * 最小 sanity 测试：两个入口源文件本身可加载、行为符合占位阶段的约定。
 * （产物级的接线断言在 bundle.spec.ts，那里按页面的方式跑 lib/client.js。）
 */

import { describe, expect, it } from 'vitest'
import { apply as clientApply, inject, name as clientName } from '../src/client/index.ts'
import { apply, name } from '../src/entry.ts'

describe('宿主侧入口 src/entry.ts', () => {
  it('name 是裸包名，apply 是能空跑的函数', () => {
    expect(name).toBe('@goodjin2/dsh-router')
    expect(typeof apply).toBe('function')
    expect(() => apply()).not.toThrow()
  })
})

describe('浏览器半边 src/client/index.ts', () => {
  it('占位行：有 name / inject / apply，不注入任何模块，apply 空跑并自报状态', () => {
    expect(clientName).toBe('@goodjin2/dsh-router')
    expect(inject).toEqual([])
    expect(typeof clientApply).toBe('function')
    const infos: string[] = []
    expect(() => clientApply({ logger: () => ({ info: (message: string) => { infos.push(message) }, warn: () => {} }) })).not.toThrow()
    expect(infos.join(' ')).toContain('placeholder')
  })

  it('没有 ctx / logger 时也安全（退回 console，不抛）', () => {
    expect(() => clientApply()).not.toThrow()
    expect(() => clientApply({})).not.toThrow()
  })
})
