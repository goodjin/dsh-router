/**
 * 最小 sanity 测试：两个入口源文件本身可加载、模块面符合约定。
 * （产物级的接线断言在 bundle.spec.ts；根服务组装逻辑在 router-core.spec.ts。）
 */

import { describe, expect, it } from 'vitest'
import { apply as clientApply, inject as clientInject, name as clientName } from '../src/client/index.ts'
import { Config as rootConfig, inject, name } from '../src/entry.ts'

describe('宿主侧入口 src/entry.ts', () => {
  it('name 是裸包名；必需服务在 inject 里（缺席 fail loud）', () => {
    expect(name).toBe('@goodjin2/dsh-router')
    expect(inject).toEqual(['sessionController', 'agents', 'workspaceRegistry'])
  })

  it('Config 全部可缺省：空 config 也过校验（防御性解析在 apply 内）', () => {
    expect(() => rootConfig({})).not.toThrow()
    expect(() => rootConfig(undefined)).not.toThrow()
    expect(() => rootConfig({ maxDepth: 5, maxActiveCards: 20, templates: [
      { templateId: 'coder', name: '编码', description: '', role: 'worker' },
    ] })).not.toThrow()
  })
})

describe('浏览器半边 src/client/index.ts', () => {
  it('占位行：有 name / inject / apply，不注入任何模块，apply 空跑并自报状态', () => {
    expect(clientName).toBe('@goodjin2/dsh-router')
    expect(clientInject).toEqual([])
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
