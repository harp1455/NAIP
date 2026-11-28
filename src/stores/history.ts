import { create } from 'zustand'
import type { HistoryFilter, HistoryMeta } from '../lib/db'
import { makeThumb } from '../lib/image'
import { getStorage } from '../storage'
import { filterToQuery, matchesSearch, searchTerms, searchText, thumbPathFor } from '../storage/history-repo'
import { forgetLegacy, legacyPending } from '../storage/legacy'
import { useSettings } from './settings'
import { forgetAllProjectImages, projectKeptImageIds, useProjects } from '../project/store' // ── Phase 5

/** 한 번에 읽는 장수 (최신순 커서 페이지) */
const PAGE = 90
/** 필터·검색이 바뀔 때마다 늘린다 — 늦게 끝난 이전 조회 결과를 버리는 데 쓴다 */
let generation = 0
let loadingMore: Promise<void> | null = null

interface HistoryState {
  items: HistoryMeta[]
  total: number
  loaded: boolean
  hasMore: boolean
  /** 뷰어에 열린 이미지 id */
  viewing: number | null
  /** null = 전체 */
  filter: HistoryFilter
  /** 필터·검색 중이면 맞는 장수 */
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
  /** 썸네일 파일이 없거나 깨졌을 때 원본으로 다시 만든다 (한 장에 한 번만) */
  repairThumb: (id: number) => Promise<void>
}

const repaired = new Set<number>()

export const useHistory = create<HistoryState>()((set, get) => ({
  items: [],
  total: 0,
  loaded: false,
  hasMore: false,
  viewing: null,
  filter: null,
  matchCount: null,
  setFilter: async (filter) => {
    const gen = ++generation
    const { history } = await getStorage()
    const q = filterToQuery(filter)
    const [items, count, total] = await Promise.all([
      history.list(q, PAGE),
      filter ? history.count(q) : null,
      filter ? null : history.count({})
    ])
    // 입력이 바뀌는 사이에 늦게 도착한 결과는 버린다
    if (gen !== generation) return
    set({ filter, items, matchCount: count, hasMore: items.length === PAGE, ...(total !== null ? { total } : {}) })
  },
  toggleFav: async (id) => {
    const meta = get().items.find((m) => m.id === id)
    if (!meta) return
    const next = { ...meta }
    if (meta.fav) delete next.fav
    else next.fav = 1
    await (await getStorage()).history.put(next)
    set((s) => ({ items: s.items.map((m) => (m.id === id ? next : m)) }))
  },
  markSaved: async (id, path) => {
    const { history } = await getStorage()
    // 목록에 없는(필터·페이지 밖) 이미지도 기록되도록 DB에서 읽는다
    const meta = get().items.find((m) => m.id === id) ?? (await history.get(id))
    if (!meta) return
    const next = { ...meta, saved: path }
    delete next.unsaved
    await history.put(next)
    const f = get().filter
    if (f && 'unsaved' in f) {
      // 미저장만 보는 중이면 저장한 그림은 목록에서 빠진다. 크게 보고 있었다면 다음 그림으로 넘어간다
      set((s) => {
        const i = s.items.findIndex((m) => m.id === id)
        if (i < 0) return {}
        const rest = s.items.filter((m) => m.id !== id)
        return {
          items: rest,
          matchCount: s.matchCount !== null ? Math.max(0, s.matchCount - 1) : null,
          viewing: s.viewing === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : s.viewing
        }
      })
      return
    }
    set((s) => ({ items: s.items.map((m) => (m.id === id ? next : m)) }))
  },
  init: async () => {
    const gen = ++generation
    const { history } = await getStorage()
    const [items, total] = await Promise.all([history.list({}, PAGE), history.count({})])
    if (gen !== generation) return
    set({ items, total, loaded: true, hasMore: items.length < total, filter: null, matchCount: null })
  },
  loadMore: async () => {
    // 스크롤이 빨라 여러 번 불려도 한 번에 하나씩
    if (loadingMore) return loadingMore
    const { items, filter, hasMore } = get()
    const last = items[items.length - 1]
    if (!hasMore || !last) return
    const gen = generation
    loadingMore = (async () => {
      const { history } = await getStorage()
      const more = await history.list(filterToQuery(filter), PAGE, last.id)
      if (gen !== generation) return
      set((s) => ({ items: [...s.items, ...more], hasMore: more.length === PAGE }))
    })().finally(() => {
      loadingMore = null
    })
    return loadingMore
  },
  add: async (meta, blob) => {
    meta = { ...meta, unsaved: 1 }
    await (await getStorage()).history.add(meta, blob)
    const f = get().filter
    const matches =
      !f ||
      'unsaved' in f ||
      ('sceneId' in f && f.sceneId === meta.sceneId) ||
      ('search' in f && matchesSearch(searchText(meta), searchTerms(f.search)))
    set((s) => ({
      items: matches ? [meta, ...s.items] : s.items,
      total: s.total + 1,
      matchCount: matches && s.matchCount !== null ? s.matchCount + 1 : s.matchCount
    }))
    // 보관 한도를 넘으면 즐겨찾기를 뺀 오래된 것부터 정리.
    // ── Phase 5: 프로젝트 그림(탈락 제외)·내보낸 그림은 자동으로 지우지 않는다 — 사용자가 직접 지울 때만
    const limit = useSettings.getState().historyLimit
    const over = limit > 0 ? get().total - limit : 0
    if (over > 0) {
      // 방금 넣은 그림도 지우지 않는다 — 프로젝트 그림은 이 함수가 끝난 뒤에야 프로젝트에 들어가고,
      // 남길 그림이 한도를 다 채웠을 때 가장 오래된 "지울 수 있는" 그림이 바로 이것이다 (그때는 한도를 잠시 넘긴다)
      const keep = projectKeptImageIds()
      keep.add(meta.id)
      const ids = await (await getStorage()).history.oldestIds(over, keep)
      if (ids.length) await get().remove(ids)
    }
  },
  remove: async (ids) => {
    await (await getStorage()).history.remove(ids)
    // 이전 히스토리 옮기기가 끝나기 전이면 예전 저장소에서도 지운다 — 다음 옮기기에서 되살아나지 않게
    await forgetLegacy(ids).catch((e: unknown) => console.warn('이전 히스토리에서 지우지 못했습니다', e))
    useProjects.getState().forgetImages(ids) // ── Phase 5: 지운 그림을 프로젝트 조합에서도 뺀다
    const gone = new Set(ids)
    set((s) => {
      const removed = s.items.filter((m) => gone.has(m.id)).length
      return {
        items: s.items.filter((m) => !gone.has(m.id)),
        total: Math.max(0, s.total - ids.length),
        matchCount: s.matchCount !== null ? Math.max(0, s.matchCount - removed) : null,
        viewing: s.viewing !== null && gone.has(s.viewing) ? null : s.viewing
      }
    })
  },
  clear: async () => {
    const { history } = await getStorage()
    // 옮기기가 끝나기 전이면 지금 히스토리에 있는(옮겨진) 장만 예전 저장소에서도 지운다. 아직 옮기지 않은 장은 남긴다
    const moved = (await legacyPending()) ? await history.ids({}) : []
    await history.clear()
    if (moved.length) await forgetLegacy(moved).catch((e: unknown) => console.warn('이전 히스토리에서 지우지 못했습니다', e))
    forgetAllProjectImages() // ── Phase 5
    set({ items: [], total: 0, hasMore: false, viewing: null, matchCount: get().filter ? 0 : null })
  },
  view: (id) => set({ viewing: id }),
  repairThumb: async (id) => {
    if (repaired.has(id)) return
    repaired.add(id)
    const meta = get().items.find((m) => m.id === id)
    if (!meta) return
    try {
      const { history, files } = await getStorage()
      const original = await history.readOriginal(meta.id, meta.mime)
      if (!original) return
      const thumb = await makeThumb(original)
      const path = thumbPathFor(meta.id, 'image/jpeg')
      await files.write(path, thumb)
      const url = await history.setThumb(meta.id, path)
      // 같은 주소면 웹뷰가 깨진 그림을 기억하고 있을 수 있어 덧붙인다
      const shown = url.startsWith('blob:') ? url : `${url}?v=${Date.now()}`
      set((s) => ({ items: s.items.map((m) => (m.id === id ? { ...m, thumb: shown } : m)) }))
    } catch {
      /* 원본도 없으면 그대로 둔다 */
    }
  }
}))

/** 방금 받은 원본의 object URL (최근 40장) — 파일을 다시 읽지 않고 바로 띄운다 */
const primed = new Map<number, string>()

/** 방금 받은 원본을 캐시에 미리 넣어, 결과 화면이 썸네일로 깜빡이지 않고 바로 보이게 한다 */
export function primeImageUrl(id: number, blob: Blob): void {
  if (primed.has(id)) return
  primed.set(id, URL.createObjectURL(blob))
  while (primed.size > 40) {
    const [oldId, oldUrl] = primed.entries().next().value as [number, string]
    URL.revokeObjectURL(oldUrl)
    primed.delete(oldId)
  }
}

/** 원본 이미지 주소 — 휴대폰은 파일 주소(웹뷰가 디스크에서 바로 읽는다), 브라우저는 object URL */
export async function imageUrl(id: number, mime: string): Promise<string | null> {
  const hit = primed.get(id)
  if (hit) return hit
  const url = await (await getStorage()).history.originalUrl(id, mime)
  return url || null
}
