import { create } from 'zustand'
import * as db from '../lib/db'
import type { HistoryFilter, HistoryMeta } from '../lib/db'
import { useSettings } from './settings'

const PAGE = 60

interface HistoryState {
  items: HistoryMeta[]
  total: number
  loaded: boolean
  hasMore: boolean
  /** 뷰어에 열린 이미지 id */
  viewing: number | null
  /** null = 전체. 즐겨찾기/씬 필터가 걸리면 items는 필터 결과 전체 */
  filter: HistoryFilter
  setFilter: (filter: HistoryFilter) => Promise<void>
  toggleFav: (id: number) => Promise<void>
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
  setFilter: async (filter) => {
    if (!filter) {
      set({ filter: null })
      return get().init()
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
  init: async () => {
    const [items, total] = await Promise.all([db.listMeta(PAGE), db.countImages()])
    set({ items, total, loaded: true, hasMore: items.length < total })
  },
  loadMore: async () => {
    const { items, total, filter } = get()
    if (filter) return
    const last = items[items.length - 1]
    if (!last) return
    const more = await db.listMeta(PAGE, last.id)
    const next = [...items, ...more]
    set({ items: next, hasMore: more.length > 0 && next.length < total })
  },
  add: async (meta, blob) => {
    await db.addImage(meta, blob)
    const f = get().filter
    const matches = !f || ('sceneId' in f && f.sceneId === meta.sceneId)
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
