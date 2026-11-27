import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TagHit, TagSourceSetting } from '../lib/tags'

/** 기억해 둘 태그 수 — 넘으면 덜 쓰고 오래된 것부터 잊는다 */
const MAX_ENTRIES = 300
/** 추천 줄 맨 앞에 끌어올릴 최대 개수 */
const MAX_BOOSTED = 6

interface UsageEntry {
  hit: Omit<TagHit, 'tier' | 'used'>
  n: number
  last: number
}

interface TagUsageState {
  entries: Record<string, UsageEntry>
  record: (hit: TagHit) => void
  clear: () => void
}

/** 자동완성에서 고른 태그 — 다음부터 같은 글자를 치면 맨 앞에 보여 준다 */
export const useTagUsage = create<TagUsageState>()(
  persist(
    (set) => ({
      entries: {},
      record: (hit) =>
        set((s) => {
          const { tier: _tier, used: _used, ...rest } = hit
          void _tier
          void _used
          const prev = s.entries[hit.tag]
          const entries = { ...s.entries, [hit.tag]: { hit: rest, n: (prev?.n ?? 0) + 1, last: Date.now() } }
          const keys = Object.keys(entries)
          if (keys.length > MAX_ENTRIES) {
            keys
              .sort((a, b) => entries[a].n - entries[b].n || entries[a].last - entries[b].last)
              .slice(0, keys.length - MAX_ENTRIES)
              .forEach((k) => delete entries[k])
          }
          return { entries }
        }),
      clear: () => set({ entries: {} })
    }),
    { name: 'naip-tag-usage' }
  )
)

/**
 * 검색 결과 앞에 "내가 자주 고른 태그" 중 입력과 맞는 것을 끌어올린다 (많이 쓴 순, 같으면 최근 순).
 * 끌어올린 항목에는 used(고른 횟수)를 붙인다.
 */
export function boostUsedTags(
  hits: TagHit[],
  query: string,
  setting: TagSourceSetting,
  opts: { artistOnly?: boolean; limit?: number } = {}
): TagHit[] {
  const q = query.trim().toLowerCase().replace(/_/g, ' ')
  if (!q) return hits
  const used = Object.values(useTagUsage.getState().entries)
    .filter((e) => {
      if (opts.artistOnly && e.hit.category !== 'a') return false
      // 지금 고른 출처(단부루/e621)에 없는 태그는 끌어올리지 않는다
      if (setting === 'danbooru' && e.hit.counts.danbooru === undefined) return false
      if (setting === 'e621' && e.hit.counts.e621 === undefined) return false
      return e.hit.tag.includes(q) || !!e.hit.keyword?.includes(q)
    })
    .sort((a, b) => b.n - a.n || b.last - a.last)
    .slice(0, MAX_BOOSTED)
  if (!used.length) return hits
  const boosted: TagHit[] = used.map((e) => {
    // 같은 태그가 이번 검색에도 나왔으면 그쪽의 게시물 수를 쓴다 (더 최신)
    const fresh = hits.find((h) => h.tag === e.hit.tag)
    return { ...(fresh ?? { ...e.hit, tier: 0 }), used: e.n }
  })
  const seen = new Set(boosted.map((h) => h.tag))
  return [...boosted, ...hits.filter((h) => !seen.has(h.tag))].slice(0, opts.limit ?? 20)
}
