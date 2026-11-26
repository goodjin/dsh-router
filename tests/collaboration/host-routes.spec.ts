/**
 * 宿主根服务入口回归：entry 不再自己注册工作台路由（2026-11-26 修复）。
 *
 * 工作台四条 HTTP 路由原先挂在 src/entry.ts 的可选注入
 * `ctx.inject?.(['webServer','connection'], …)` 上，走不通就静默跳过（宿主无痕）。
 * 现已拆到独立行 src/workbench.ts（`@goodjin2/dsh-router/workbench`，必需 inject
 * ['webServer','connection','routerCollaboration']）。本文件回归断言：即便 webServer
 * 与 connection 都在场，entry 也**不再**注册任何路由——路由只由 workbench 行注册，
 * 把「挂不上」从静默变成可诊断（见 workbench.spec.ts 的正向覆盖）。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { apply as entryApply } from '../../src/entry.ts'

/** 刷新 entry fire-and-forget 的 ctx.inject fiber（cordis fiber reload 是异步的）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

describe('entry 不再自己注册工作台路由 — real cordis Context', () => {
  it('webServer+connection 都在场 → entry 不注册任何路由，routerCollaboration 仍 provide', async () => {
    const ctx = new Context()
    const registered: string[] = []
    ctx.provide('webServer', {
      register: (route: { path: string }) => { registered.push(route.path); return () => {} },
    })
    ctx.provide('connection', { admit: () => ({ peer: {} }) })
    expect(() => entryApply(ctx, { dataDir: '/tmp/router-entry-no-routes' })).not.toThrow()
    await flush()
    // 路由已拆到 workbench 独立行，entry 不再经可选注入注册。
    expect(registered).toEqual([])
    // 根服务单实例仍提供（记录/工具经作用域链取用）。
    const face = ctx.get('routerCollaboration') as { records: { list: unknown }; roles: { list: unknown }; dataDir: string } | undefined
    expect(face).toBeTruthy()
    expect(typeof face?.records.list).toBe('function')
    expect(typeof face?.roles.list).toBe('function')
    expect(face?.dataDir).toBe('/tmp/router-entry-no-routes')
  })
})
