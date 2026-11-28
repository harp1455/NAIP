import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { debouncedIdbStorage } from '../lib/db'
import { uid } from '../lib/util'
import { toastLoadFailed } from './toast'

/** 저장해 둔 마스크 — 다른 그림에도 비율대로 늘려 다시 쓸 수 있다 */
export interface SavedMask {
  id: number
  name: string
  width: number
  height: number
  /** 투명 배경 위 흰색 PNG dataURL */
  data: string
  ts: number
}

interface MasksState {
  masks: SavedMask[]
  add: (m: Omit<SavedMask, 'id' | 'ts'>) => void
  remove: (id: number) => void
  rename: (id: number, name: string) => void
}

/**
 * 이번 실행에서 IndexedDB 의 마스크를 불러오지 못했는지 (열기 실패·손상된 값).
 * 그러면 스토어는 빈 채로 남는다 — 백업·복원이 그 빈 목록을 "지금 마스크"로 보지 않게 알린다.
 */
let loadFailed = false
export function masksLoadFailed(): boolean {
  return loadFailed
}
/** 저장된 마스크를 불러온 뒤에만 저장한다 — 실패한 뒤에 마스크를 더하면 저장된 마스크를 덮어쓰게 된다 */
let loaded = false
/**
 * 불러오는 중에 더한 마스크 id. 그동안의 저장은 버려지므로(loaded 가 아직 false), 불러온 목록에 이 마스크를 더해 두고
 * 불러오기가 끝나면 한 번 저장한다 — 업데이트 뒤 첫 실행처럼 불러오기가 오래 걸릴 때 만든 마스크를 잃지 않게
 */
let loading = false
let addedWhileLoading = new Set<number>()

export const useMasks = create<MasksState>()(
  persist(
    (set) => ({
      masks: [],
      add: (m) =>
        set((s) => {
          const mask = { ...m, id: uid(), ts: Date.now() }
          if (loading) addedWhileLoading.add(mask.id)
          return { masks: [mask, ...s.masks].slice(0, 50) }
        }),
      remove: (id) => set((s) => ({ masks: s.masks.filter((m) => m.id !== id) })),
      rename: (id, name) =>
        set((s) => ({ masks: s.masks.map((m) => (m.id === id ? { ...m, name: name.trim() || m.name } : m)) }))
    }),
    {
      name: 'naip-masks',
      storage: debouncedIdbStorage<Pick<MasksState, 'masks'>>(400, { canWrite: () => loaded }),
      // 불러온 목록이 지금 목록을 바꾼다 — 불러오는 중에 더한 마스크만 그 앞에 남긴다
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<MasksState> | undefined) }
        const early = current.masks.filter((m) => addedWhileLoading.has(m.id))
        if (!early.length || !Array.isArray(merged.masks)) return merged
        const ids = new Set(early.map((m) => m.id))
        return { ...merged, masks: [...early, ...merged.masks.filter((m) => !ids.has(m.id))] }
      },
      // 실패하면 zustand 는 hasHydrated() 를 false 로 둔다 — "아직 불러오는 중"과 가르려고 따로 적는다.
      // 그때는 이번 실행 동안 저장하지 않는다 (저장된 것은 그대로 두고, 다시 시작하면 다시 불러온다)
      onRehydrateStorage: () => {
        loadFailed = false
        loaded = false
        loading = true
        addedWhileLoading = new Set()
        return (state, error) => {
          loading = false
          loadFailed = !state || error !== undefined
          loaded = !loadFailed
          if (loadFailed) {
            console.warn('보관한 마스크를 불러오지 못했습니다', error)
            toastLoadFailed('보관한 마스크')
          } else if (addedWhileLoading.size) {
            // 불러오는 동안 버린 저장을 이제 한다 (불러온 마스크 + 그동안 더한 마스크)
            useMasks.setState((s) => ({ masks: s.masks }))
          }
          addedWhileLoading = new Set()
        }
      }
    }
  )
)
