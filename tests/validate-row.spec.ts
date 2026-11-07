/**
 * 子行校验函数测试（v1.1 计划 Task A2）。
 *
 * v1 漏洞（本文件钉住）：离线核查器对 config-less 子行不做包 Config 校验——
 * fs-search 行没有 config 就被直接跳过，宿主必填的 `sampleOverCapGlobResults`
 * 缺失没被发现，所有 worker 会话创建失败。validateRowSpec 对 config-less 行
 * 必须以 `undefined` 输入过包的 Config。
 *
 * 测试全部走注入的假模块装载器（不依赖本机宿主安装）；真宿主的端到端校验
 * 由 `scripts/check-subrows.mjs` 双宿主跑（命令门禁，非 vitest）。
 */

import { describe, expect, it } from 'vitest'

import { validateRowSpec, type ValidateLoad } from '../src/host/presets/validate-row.ts'

/* ────────────────────────── 假宿主模块表 ────────────────────────── */

/** 照真宿主行为造的假 Config：schemastery 的 required 键缺了就抛。 */
function fakeSearchConfig(input: unknown): unknown {
  const config = (input ?? {}) as Record<string, unknown>
  if (config.sampleOverCapGlobResults === undefined) {
    throw new Error('$.sampleOverCapGlobResults missing required value')
  }
  return { sampleOverCapGlobResults: config.sampleOverCapGlobResults }
}

function fakeFsConfig(_input: unknown): unknown {
  return { applyPatch: true }
}

/** 假模块表：fs-search 必填键、fs 全缺省、pruner 无 Config 导出。 */
const FAKE_MODULES: Record<string, { Config?: unknown }> = {
  '@deepseek-ai/dsh-tool-fs-search': { Config: fakeSearchConfig },
  '@deepseek-ai/dsh-tool-fs': { Config: fakeFsConfig },
  '@deepseek-ai/dsh-compaction-basic': {},
}

function fakeLoad(): ValidateLoad {
  return async (name: string) => FAKE_MODULES[name]
}

/* ────────────────────────── 断言 ────────────────────────── */

describe('validateRowSpec：config-less 行也过包 Config（v1 漏洞钉住）', () => {
  it('无 config 的 fs-search 行必须报 sampleOverCapGlobResults 缺失（先红——v1 案例）', async () => {
    const verdict = await validateRowSpec(
      { id: 'worker-tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
      { load: fakeLoad() },
    )
    expect(verdict).toEqual({
      ok: false,
      problems: ['worker-tool-fs-search: Config 校验失败: $.sampleOverCapGlobResults missing required value'],
    })
  })

  it('带齐必填键的 fs-search 行通过', async () => {
    const verdict = await validateRowSpec(
      {
        id: 'worker-tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search',
        config: { sampleOverCapGlobResults: false },
      },
      { load: fakeLoad() },
    )
    expect(verdict).toEqual({ ok: true })
  })

  it('config-less 行照样调装载器、以 undefined 输入过 Config（跳过即漏洞）', async () => {
    const received: unknown[] = []
    const verdict = await validateRowSpec(
      { id: 'worker-tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      {
        load: async (name) => {
          const mod = FAKE_MODULES[name]!
          return {
            Config: (input: unknown) => {
              received.push(input)
              return (mod.Config as (i: unknown) => unknown)(input)
            },
          }
        },
      },
    )
    expect(verdict).toEqual({ ok: true })
    expect(received).toEqual([undefined])
  })

  it('导入失败报 ok:false 且带 code', async () => {
    const verdict = await validateRowSpec(
      { id: 'x-row', name: '@deepseek-ai/dsh-tool-gone' },
      { load: async () => { throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }) } },
    )
    expect(verdict).toEqual({
      ok: false,
      problems: ['x-row: 导入失败 ERR_MODULE_NOT_FOUND: Cannot find package'],
    })
  })

  it('包无 Config 导出 → 无从校验，视为通过（与容器核查器同规则）', async () => {
    const verdict = await validateRowSpec(
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { load: fakeLoad() },
    )
    expect(verdict).toEqual({ ok: true })
  })

  it('group 行直接放行（结构容器没有包；子行各自过校验）', async () => {
    let called = 0
    const verdict = await validateRowSpec(
      { id: 'worker-compaction', name: 'cordis:group' },
      { load: async () => { called += 1; return {} } },
    )
    expect(verdict).toEqual({ ok: true })
    expect(called).toBe(0)
  })

  it('带 config 的行把原对象传给 Config（不丢键、不改写）', async () => {
    const received: unknown[] = []
    await validateRowSpec(
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      },
      {
        load: async () => ({
          Config: (input: unknown) => {
            received.push(input)
            return input
          },
        }),
      },
    )
    expect(received).toEqual([{ thresholdChars: 8192, headChars: 4096, tailChars: 1024 }])
  })
})
