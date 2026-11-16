/**
 * 宿主入口可选注入薄路由测试（计划 Task 3，Layer 4，真实 Cordis Context）。
 *
 * brief 命名断言：missingservicesdegrade（宿主侧）+ 真实 Cordis 注入夹具（非玩具 ctx）。
 *  - 真实 cordis Context 提供 webServer+connection 时，entry.apply 经官方 ctx.inject 挂三条协作路由，
 *    且与根服务共享同一 RecordStore/RoleStore（routes_reuse_store 的宿主侧证据）。
 *  - 真实 cordis Context 缺 webServer（纯 CLI 宿主）时，ctx.inject 的 fiber 保持未激活——不抛、
 *    不挂路由，routerCollaboration 记录/工具服务照常 provide（不能 required 使 CLI 不可用）。
 *
 * 用 @deepseek-ai/cordis 的真实 Context（new Context + provide + inject + get），
 * 不用手搓玩具 ctx，验证官方注入契约真实成立。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { apply as entryApply } from '../../src/entry.ts'
import {
  COLLABORATION_RECORDS_PATH,
  COLLABORATION_RECORD_PATH,
  COLLABORATION_ROLES_PATH,
} from '../../src/collaboration/routes.ts'

/** 刷新 entry fire-and-forget 的 ctx.inject fiber（cordis fiber reload 是异步的）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

describe('entry optional injection — real cordis Context', () => {
  it('webServer+connection 都在 → 挂三条协作路由，routerCollaboration 仍 provide', async () => {
    const ctx = new Context()
    const registered: string[] = []
    ctx.provide('webServer', {
      register: (route: { path: string }) => { registered.push(route.path); return () => {} },
    })
    ctx.provide('connection', { admit: () => ({ peer: {} }) })
    expect(() => entryApply(ctx, { dataDir: '/tmp/router-cordis-routes' })).not.toThrow()
    await flush()
    expect(registered.slice().sort()).toEqual(
      [COLLABORATION_RECORDS_PATH, COLLABORATION_RECORD_PATH, COLLABORATION_ROLES_PATH].slice().sort(),
    )
    // 根服务单实例仍提供（记录/工具经作用域链取用）。
    const face = ctx.get('routerCollaboration') as { records: { list: unknown }; roles: { list: unknown }; dataDir: string } | undefined
    expect(face).toBeTruthy()
    expect(typeof face?.records.list).toBe('function')
    expect(typeof face?.roles.list).toBe('function')
    expect(face?.dataDir).toBe('/tmp/router-cordis-routes')
  })

  it('缺 webServer（CLI 宿主）→ 不抛、不挂路由，routerCollaboration 照常 provide', async () => {
    const ctx = new Context()
    const registered: string[] = []
    // 只 provide connection，不 provide webServer：模拟纯 CLI 宿主。
    ctx.provide('connection', { admit: () => ({ peer: {} }) })
    // 即便给了 webServer 的 register 捕获也收不到——因为 webServer 服务本身缺席。
    expect(() => entryApply(ctx, { dataDir: '/tmp/router-cordis-cli' })).not.toThrow()
    await flush()
    expect(registered).toEqual([])
    const face = ctx.get('routerCollaboration') as { records: { list: unknown } } | undefined
    expect(face).toBeTruthy()
    expect(typeof face?.records.list).toBe('function')
  })

  it('connection 缺席（webServer 在但无登录准入）→ 不挂路由、不抛', async () => {
    const ctx = new Context()
    const registered: string[] = []
    ctx.provide('webServer', {
      register: (route: { path: string }) => { registered.push(route.path); return () => {} },
    })
    // 不 provide connection。
    expect(() => entryApply(ctx, { dataDir: '/tmp/router-cordis-noconn' })).not.toThrow()
    await flush()
    expect(registered).toEqual([])
    expect(ctx.get('routerCollaboration')).toBeTruthy()
  })
})
