/**
 * 记忆检索（规格 §6：本轮相关记忆片段；计划 B3 的 search_history 数据面）。
 *
 * v1 关键词扫描，无 SQLite（规格 §9 明确向量检索不在 v1）：把条目正文与主题
 * key 拼成匹配面，查询按空白拆词、大小写不敏感、中文按包含匹配，多词取 AND。
 * 命中按条目写入时间倒序，最多 20 条；memoryRef = memory://<文档相对路径>#<条目锚>，
 * 可一路指回具体条目（来源引用规则）。
 */

import type { MemoryDocStore, MemoryEntry } from './store.ts'
import { memoryDocRelPath } from './store.ts'

export type SearchScope = 'project' | 'global' | 'all'

export interface MemorySearchHit {
  memoryRef: string
  snippet: string
}

const MAX_HITS = 20

interface CollectedHit extends MemorySearchHit {
  at: number
}

function entryMatches(entry: MemoryEntry, terms: string[]): boolean {
  const haystack = `${entry.text}\n${entry.key ?? ''}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

function collect(
  hits: CollectedHit[],
  scope: 'session' | 'project' | 'global',
  key: string | undefined,
  entries: MemoryEntry[],
  terms: string[],
): void {
  const rel = memoryDocRelPath(scope, key)
  for (const entry of entries) {
    if (!entryMatches(entry, terms)) continue
    hits.push({
      memoryRef: `memory://${rel}#${entry.anchor}`,
      snippet: entry.text,
      at: entry.at,
    })
  }
}

export async function search(
  store: MemoryDocStore,
  query: string,
  scope: SearchScope,
): Promise<MemorySearchHit[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '')
  if (terms.length === 0) return []

  const hits: CollectedHit[] = []
  const layers: Array<'project' | 'global'> =
    scope === 'all' ? ['project', 'global'] : [scope]
  for (const layer of layers) {
    const doc = await store.readDoc(layer)
    if (doc !== null) collect(hits, layer, undefined, doc.entries, terms)
  }
  if (scope === 'all') {
    for (const sessionId of await store.listSessionIds()) {
      const doc = await store.readDoc('session', sessionId)
      if (doc !== null) collect(hits, 'session', sessionId, doc.entries, terms)
    }
  }

  hits.sort((a, b) => b.at - a.at)
  return hits.slice(0, MAX_HITS).map((hit) => ({ memoryRef: hit.memoryRef, snippet: hit.snippet }))
}
