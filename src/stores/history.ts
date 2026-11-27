import { create } from 'zustand'
import * as db from '../lib/db'
import type { HistoryFilter, HistoryMeta } from '../lib/db'
import { useSettings } from './settings'

const PAGE = 60
/** 검색 결과 id 전부 (최신순) — 화면에는 PAGE장씩 꺼내 보여 준다 */
let searchMatches: number[] = []
/** 가장 최근에 요청한 검색어 — 늦게 끝난 이전 검색 결과를 버리는 데 쓴다 */
let latestSearch = ''

interface HistoryState {
  items: HistoryMeta[]
  total: number
  loaded: boolean
  hasMore: boolean
  /** 뷰어에 열린 이미지 id */
  viewing: number | null
  /** null = 전체. 즐겨찾기/씬 필터가 걸리면 items는 필터 결과 전체 */
  filter: HistoryFilter
  /** 검색 중이면 일치한 장수 */
  matchCount: number | null
  setFilter: (filter: HistoryFilter) => Promise<void>
  toggleFav: (id: number) => Promise<void>
  /** 갤러리에 저장했음을 기록 (path는 Pictures/NAIP 아래 경로) */
  markSaved: (id: number, path: string) => Promise<void>
  init: () => Promise<void>
  loadMore: () => Promise<void>
  add: (meta: HistoryMeta, blob: Blob) => Promise<void>
  remove: (ids: number[]) => Promise<void>
  clear: () => Promise<void>
  view: (id: number | null) => void
}

export const useHistory = create<HistoryState>()((set, get) => ({
  items: [],
  total: 0,
  loaded: false,
  hasMore: false,
  viewing: null,
  filter: null,
  matchCount: null,
  setFilter: async (filter) => {
    if (!filter || !('search' in filter)) latestSearch = ''
    if (!filter) {
      set({ filter: null, matchCount: null })
      return get().init()
    }
    if ('search' in filter) {
      latestSearch = filter.search
      const ids = await db.searchIds(filter.search)
      const items = await db.getMetas(ids.slice(0, PAGE))
      // 입력이 바뀌는 사이에 늦게 도착한 결과는 버린다
      if (latestSearch !== filter.search) return
      searchMatches = ids
      set({ filter, items, hasMore: ids.length > PAGE, matchCount: ids.length })
      return
    }
    set({ matchCount: null })
    if ('unsaved' in filter) {
      const items = await db.listUnsaved(PAGE)
      set({ filter, items, hasMore: items.length === PAGE })
      return
    }
    set({ filter, items: await db.listFiltered(filter), hasMore: false })
  },
  toggleFav: async (id) => {
    const meta = get().items.find((m) => m.id === id)
    if (!meta) return
    const next = { ...meta }
    if (meta.fav) delete next.fav
    else next.fav = 1
    await db.putMeta(next)
    set((s) => ({ items: s.items.map((m) => (m.id === id ? next : m)) }))
  },
  markSaved: async (id, path) => {
    // 목록에 없는(필터·페이지 밖) 이미지도 기록되도록 DB에서 읽는다
    const meta = get().items.find((m) => m.id === id) ?? (await db.getMeta(id))
    if (!meta) return
    const next = { ...meta, saved: path }
    delete next.unsaved
    await db.putMeta(next)
    if (get().filter && 'unsaved' in get().filter!) {
      // 미저장만 보는 중이면 저장한 그림은 목록에서 빠진다. 크게 보고 있었다면 다음 그림으로 넘어간다
      set((s) => {
        const i = s.items.findIndex((m) => m.id === id)
        const rest = s.items.filter((m) => m.id !== id)
        return {
          items: rest,
          viewing: s.viewing === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : s.viewing
        }
      })
      return
    }
    set((s) => ({ items: s.items.map((m) => (m.id === id ? next : m)) }))
  },
  init: async () => {
    const [items, total] = await Promise.all([db.listMeta(PAGE), db.countImages()])
    set({ items, total, loaded: true, hasMore: items.length < total })
  },
  loadMore: async () => {
    const { items, total, filter } = get()
    if (filter && 'search' in filter) {
      const more = await db.getMetas(searchMatches.slice(items.length, items.length + PAGE))
      set({ items: [...items, ...more], hasMore: items.length + PAGE < searchMatches.length })
      return
    }
    if (filter && 'unsaved' in filter) {
      const oldest = items[items.length - 1]
      if (!oldest) return
      const more = await db.listUnsaved(PAGE, oldest.id)
      set({ items: [...get().items, ...more], hasMore: more.length === PAGE })
      return
    }
    if (filter) return
    const last = items[items.length - 1]
    if (!last) return
    const more = await db.listMeta(PAGE, last.id)
    const next = [...items, ...more]
    set({ items: next, hasMore: more.length > 0 && next.length < total })
  },
  add: async (meta, blob) => {
    meta = { ...meta, unsaved: 1 }
    await db.addImage(meta, blob)
    const f = get().filter
    const matches =
      !f ||
      'unsaved' in f ||
      ('sceneId' in f && f.sceneId === meta.sceneId) ||
      ('search' in f && db.matchesSearch(db.searchText(meta), db.searchTerms(f.search)))
    set((s) => ({ items: matches ? [meta, ...s.items] : s.items, total: s.total + 1 }))
    // 보관 한도를 넘으면 즐겨찾기를 뺀 오래된 것부터 정리
    const limit = useSettings.getState().historyLimit
    const over = limit > 0 ? get().total - limit : 0
    if (over > 0) {
      const ids = await db.oldestIds(over)
      if (ids.length) await get().remove(ids)
    }
  },
  remove: async (ids) => {
    await db.deleteImages(ids)
    const gone = new Set(ids)
    set((s) => ({
      items: s.items.filter((m) => !gone.has(m.id)),
      total: Math.max(0, s.total - ids.length),
      viewing: s.viewing !== null && gone.has(s.viewing) ? null : s.viewing
    }))
  },
  clear: async () => {
    await db.clearImages()
    set({ items: [], total: 0, hasMore: false, viewing: null })
  },
  view: (id) => set({ viewing: id })
}))

const urlCache = new Map<number, string>()

/** 원본 이미지의 object URL (세션 캐시, 최근 40장만 유지) */
export async function imageUrl(id: number, mime: string): Promise<string | null> {
  const hit = urlCache.get(id)
  if (hit) return hit
  const blob = await db.getBlob(id, mime)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(id, url)
  if (urlCache.size > 40) {
    const [oldId, oldUrl] = urlCache.entries().next().value as [number, string]
    URL.revokeObjectURL(oldUrl)
    urlCache.delete(oldId)
  }
  return url
}
