/**
 * 客户端偏好存取（计划 Task B7 设置段的回落实现）。
 *
 * 本包没有宿主 Config schema（cordis.patch.yml 只有客户端装载行），按简报的
 * 取舍：偏好落在浏览器本地存储（volatile），设置段只读展示；这里测的是
 * 存取语义本身：默认值、钳制、持久化、坏数据回落默认。
 */

import { describe, expect, it } from 'vitest'
import {
  CLIENT_PREFS_STORAGE_KEY,
  defaultClientPrefs,
  normalizeClientPrefs,
  parseClientPrefs,
  startClientPrefs,
} from '../src/client/client-prefs.ts'
import type { ClientPrefsStorage } from '../src/client/client-prefs.ts'

function memoryStorage(initial: Record<string, string> = {}): ClientPrefsStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

describe('默认值与钳制', () => {
  it('默认：轮询 2.5s、浮窗开、活动卡上限 12', () => {
    expect(defaultClientPrefs()).toEqual({ pollMs: 2500, overlayEnabled: true, maxActiveCards: 12 })
  })

  it('normalize 钳制：轮询下限 1000ms、上限 1 张卡', () => {
    expect(normalizeClientPrefs({ pollMs: 10, overlayEnabled: false, maxActiveCards: 0 }))
      .toEqual({ pollMs: 1000, overlayEnabled: false, maxActiveCards: 1 })
    expect(normalizeClientPrefs({ pollMs: 999_999, overlayEnabled: true, maxActiveCards: 999 }))
      .toEqual({ pollMs: 60_000, overlayEnabled: true, maxActiveCards: 50 })
  })
})

describe('存储读写', () => {
  it('set 写入存储并通知订阅者；get 返回钳制后的值', () => {
    const storage = memoryStorage()
    const prefs = startClientPrefs(storage)
    const seen: number[] = []
    prefs.subscribe(() => { seen.push(prefs.get().pollMs) })
    prefs.set({ ...prefs.get(), pollMs: 4000 })
    expect(seen).toEqual([4000])
    expect(prefs.get().pollMs).toBe(4000)
    expect(JSON.parse(storage.map.get(CLIENT_PREFS_STORAGE_KEY)!)).toMatchObject({ pollMs: 4000 })
  })

  it('从存储恢复已保存的偏好', () => {
    const storage = memoryStorage({ [CLIENT_PREFS_STORAGE_KEY]: JSON.stringify({ pollMs: 5000, overlayEnabled: false, maxActiveCards: 3 }) })
    const prefs = startClientPrefs(storage)
    expect(prefs.get()).toEqual({ pollMs: 5000, overlayEnabled: false, maxActiveCards: 3 })
  })

  it('存储里是坏 JSON / 缺字段时回落默认（不抛）', () => {
    expect(parseClientPrefs('not-json')).toEqual(defaultClientPrefs())
    expect(parseClientPrefs(JSON.stringify({ pollMs: 'fast' }))).toEqual(defaultClientPrefs())
    const prefs = startClientPrefs(memoryStorage({ [CLIENT_PREFS_STORAGE_KEY]: '}{垃圾' }))
    expect(prefs.get()).toEqual(defaultClientPrefs())
  })
})
