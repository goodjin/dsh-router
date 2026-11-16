/**
 * 轻量协作运行时 createCollaborationRuntime 测试（计划 Task 2B，Layer 3）。
 *
 * brief 命名断言：runtime_no_business_engine。构造只创建一条 RecordStore 与一条
 * RoleStore 单实例、解析一次 dataDir 默认值（DSH_HOME/router）、不扫描/不建目录/
 * 不执行任何业务引擎；不 import 旧 routerCore/scheduler/adjudicator/adoption/budgets/
 * memory 后台摘要/任务控制路由。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCollaborationRuntime } from '../../src/collaboration/runtime.ts'
import { createRecordStore } from '../../src/collaboration/records.ts'
import { createRoleStore } from '../../src/collaboration/roles.ts'

const scratch: string[] = []
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'router-runtime-'))
  scratch.push(dir)
  return dir
}

describe('createCollaborationRuntime — runtime_no_business_engine', () => {
  it('returns {records, roles, dataDir}; one RecordStore and one RoleStore per runtime', () => {
    const dataDir = '/tmp/router-owned-data'
    const runtime = createCollaborationRuntime({ dataDir })
    expect(runtime.dataDir).toBe(dataDir)
    // records and roles are the real store factories' output, one each, distinct.
    const expectedRecords = createRecordStore(dataDir)
    const expectedRoles = createRoleStore(dataDir)
    expect(Object.keys(runtime.records).sort()).toEqual(Object.keys(expectedRecords).sort())
    expect(Object.keys(runtime.roles).sort()).toEqual(Object.keys(expectedRoles).sort())
    expect(runtime.records).not.toBe(runtime.roles)
    // two runtimes over the same dataDir get their own store instances.
    const runtime2 = createCollaborationRuntime({ dataDir })
    expect(runtime2.records).not.toBe(runtime.records)
    expect(runtime2.roles).not.toBe(runtime.roles)
  })

  it('one RecordStore and one RoleStore per runtime (actual store singletons)', () => {
    const runtime = createCollaborationRuntime({ dataDir: '/tmp/x' })
    // The stores are the real store factories' output (same shape), one each.
    expect(runtime.records).toBeInstanceOf(Object)
    expect(typeof runtime.records.create).toBe('function')
    expect(typeof runtime.records.read).toBe('function')
    expect(typeof runtime.records.list).toBe('function')
    expect(typeof runtime.records.update).toBe('function')
    expect(typeof runtime.roles.list).toBe('function')
    expect(typeof runtime.roles.read).toBe('function')
    expect(typeof runtime.roles.save).toBe('function')
    // records and roles are distinct instances
    expect(runtime.records).not.toBe(runtime.roles)
  })

  it('default dataDir resolves to DSH_HOME/router (resolved once); explicit dataDir passes through', () => {
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = '/tmp/dsh-home-test'
    try {
      const runtime = createCollaborationRuntime({})
      expect(runtime.dataDir).toBe(join('/tmp/dsh-home-test', 'router'))
      // no DSH_HOME → homedir/.dsh/router
      delete process.env.DSH_HOME
      const runtime2 = createCollaborationRuntime({})
      expect(runtime2.dataDir).toBe(join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh', 'router'))
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })

  it('construction scans/creates nothing: fresh owned dataDir has no files after construction', async () => {
    const dataDir = await freshDir()
    // runtime construction must not create the collaboration subdir or any file
    createCollaborationRuntime({ dataDir })
    const entries = await readdir(dataDir).catch(() => [] as string[])
    expect(entries).toEqual([])
  })

  it('does not import or wire old business engines (no scheduler/adjudicator/adoption/budgets/memory)', async () => {
    // The runtime module source must not reference the legacy engine surfaces.
    // 剥掉注释后再查，避免文档注释里提到旧模块名误判。
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const raw = await readFile(fileURLToPath(new URL('../../src/collaboration/runtime.ts', import.meta.url)), 'utf8')
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    for (const forbidden of [
      'routerCore',
      'Scheduler',
      'OutcomeAdjudicator',
      'scanAndAdoptRouterSessions',
      'DispatchBudgets',
      'BackgroundSummarizer',
      'ClosureIntentStore',
      'registerRouterRoutes',
      'host/core',
      'host/ledger',
    ]) {
      expect(source, `runtime.ts 不得引用旧业务引擎 ${forbidden}`).not.toContain(forbidden)
    }
  })
})
