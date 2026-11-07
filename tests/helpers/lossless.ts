/**
 * 无损 JSON 门禁（v1.1 计划 Task A3）。
 *
 * v1 现场：query_tasks 返回非无损 JSON → 宿主侧序列化丢字段/直接失败 → 主管
 * 全盲。工具输出值（以及将来任何进 HTTP 契约/模型上下文的值）必须经受：
 *
 *   1. structuredClone —— 结构里不能有克隆不了的东西（函数、Node 原生句柄）；
 *   2. JSON.parse(JSON.stringify(v)) 往返后与原值 strict 深等 —— undefined 值的
 *      键会在 JSON.stringify 里静默蒸发（{a: undefined} → {}），Date/Map/Set/
 *      BigInt 会变形或抛错，这里全部拦下。
 *
 * 比较必须用 deepStrictEqual（区分 undefined 键）：vitest 的 toEqual 对
 * {a: undefined} 与 {} 判等，会把漏洞放过去。
 */

import { deepStrictEqual, fail } from 'node:assert/strict'

/**
 * 断言 value 是无损 JSON 可序列化的：往返后与原值 strict 深等。
 * 不满足时抛带 label 的 AssertionError（或原生序列化错误原样上抛）。
 */
export function assertLosslessJson(value: unknown, label = 'value'): void {
  let cloned: unknown
  try {
    cloned = structuredClone(value)
  } catch (error) {
    fail(`${label}: 结构不可克隆（structuredClone 失败）: ${String(error)}`)
  }
  let roundTripped: unknown
  try {
    roundTripped = JSON.parse(JSON.stringify(value)) as unknown
  } catch (error) {
    fail(`${label}: JSON 序列化失败: ${String(error)}`)
  }
  try {
    deepStrictEqual(cloned, roundTripped)
  } catch {
    fail(
      `${label}: JSON 往返不等（有键会被序列化静默蒸发或变形）\n`
        + `  原值: ${safeStringify(cloned)}\n`
        + `  往返: ${safeStringify(roundTripped)}`,
    )
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => (v === undefined ? '⟪undefined⟫' : v)) ?? String(value)
  } catch {
    return String(value)
  }
}
