/**
 * 客户端偏好（计划 Task B7 设置段的回落实现）。
 *
 * 取舍：本包没有宿主 Config schema（cordis.patch.yml 只有客户端装载行，
 * 本任务铁律不许改它），所以「经 settings.update 写 volatile 配置」暂无
 * 落点——偏好落在浏览器本地存储（每浏览器一份、清站点即失），设置段只读
 * 展示当前值；这里提供的 store 就是预留的写通道，将来接入宿主 Config 时
 * 把 startClientPrefs 的 storage 面换成 settings.update 即可，组件不动。
 */

/** 偏好全集。pollMs 是轮询间隔；overlayEnabled 控制问题浮窗；maxActiveCards 是活动卡上限。 */
export interface ClientPrefs {
  pollMs: number
  overlayEnabled: boolean
  maxActiveCards: number
}

/** localStorage 的最小面（测试用内存实现充当）。 */
export interface ClientPrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 订阅式偏好 store（useSyncExternalStore 直接可用）。 */
export interface ClientPrefsStore {
  get(): ClientPrefs
  subscribe(listener: () => void): () => void
  set(next: ClientPrefs): void
}

/** 本地存储键名。 */
export const CLIENT_PREFS_STORAGE_KEY = 'router.client-prefs.v1'

/** 轮询间隔的钳制范围：不低于 1s（防打爆宿主），不高于 1min。 */
export const POLL_MS_MIN = 1000
export const POLL_MS_MAX = 60_000
/** 活动卡上限的钳制范围：1–50。 */
export const MAX_CARDS_MIN = 1
export const MAX_CARDS_MAX = 50

/** 默认值：轮询 2.5s、浮窗开、活动卡上限 12（与计划一致）。 */
export function defaultClientPrefs(): ClientPrefs {
  return { pollMs: 2500, overlayEnabled: true, maxActiveCards: 12 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 非法值一律钳回合法范围；布尔单独判型。 */
export function normalizeClientPrefs(input: ClientPrefs): ClientPrefs {
  return {
    pollMs: clamp(Number.isFinite(input.pollMs) ? input.pollMs : defaultClientPrefs().pollMs, POLL_MS_MIN, POLL_MS_MAX),
    overlayEnabled: typeof input.overlayEnabled === 'boolean' ? input.overlayEnabled : true,
    maxActiveCards: clamp(Number.isFinite(input.maxActiveCards) ? input.maxActiveCards : defaultClientPrefs().maxActiveCards, MAX_CARDS_MIN, MAX_CARDS_MAX),
  }
}

/** 解析存储里的 JSON；坏值/缺字段回落默认（绝不抛）。 */
export function parseClientPrefs(raw: string | null | undefined): ClientPrefs {
  if (typeof raw !== 'string' || raw.length === 0) return defaultClientPrefs()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return defaultClientPrefs()
    const candidate = parsed as Partial<ClientPrefs>
    return normalizeClientPrefs({
      pollMs: typeof candidate.pollMs === 'number' ? candidate.pollMs : defaultClientPrefs().pollMs,
      overlayEnabled: typeof candidate.overlayEnabled === 'boolean' ? candidate.overlayEnabled : true,
      maxActiveCards: typeof candidate.maxActiveCards === 'number' ? candidate.maxActiveCards : defaultClientPrefs().maxActiveCards,
    })
  } catch {
    return defaultClientPrefs()
  }
}

/** 浏览器 localStorage 的安全面：取不到（非浏览器环境/被禁）给内存假面。 */
export function browserPrefsStorage(): ClientPrefsStorage {
  try {
    const storage = globalThis.localStorage
    if (typeof storage?.getItem === 'function' && typeof storage?.setItem === 'function') return storage
  } catch {
    // localStorage 访问被禁（隐私模式等）：落下去用内存假面，偏好不持久而已。
  }
  const memory = new Map<string, string>()
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => { memory.set(key, value) },
  }
}

/** 启动偏好 store：读一次存储，set 时钳制、落盘并广播。 */
export function startClientPrefs(storage: ClientPrefsStorage): ClientPrefsStore {
  const listeners = new Set<() => void>()
  let current = parseClientPrefs(storage.getItem(CLIENT_PREFS_STORAGE_KEY))
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      const normalized = normalizeClientPrefs(next)
      if (JSON.stringify(normalized) === JSON.stringify(current)) return
      current = normalized
      try {
        storage.setItem(CLIENT_PREFS_STORAGE_KEY, JSON.stringify(normalized))
      } catch {
        // 写盘失败（配额满等）：内存值照常生效，下次再试。
      }
      for (const listener of [...listeners]) listener()
    },
  }
}
