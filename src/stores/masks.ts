import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { debouncedIdbStorage } from '../lib/db'
import { uid } from '../lib/util'

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

export const useMasks = create<MasksState>()(
  persist(
    (set) => ({
      masks: [],
      add: (m) => set((s) => ({ masks: [{ ...m, id: uid(), ts: Date.now() }, ...s.masks].slice(0, 50) })),
      remove: (id) => set((s) => ({ masks: s.masks.filter((m) => m.id !== id) })),
      rename: (id, name) =>
        set((s) => ({ masks: s.masks.map((m) => (m.id === id ? { ...m, name: name.trim() || m.name } : m)) }))
    }),
    {
      name: 'naip-masks',
      storage: debouncedIdbStorage<Pick<MasksState, 'masks'>>(),
      // 실패하면 zustand 는 hasHydrated() 를 false 로 둔다 — "아직 불러오는 중"과 가르려고 따로 적는다
      onRehydrateStorage: () => {
        loadFailed = false
        return (state, error) => {
          loadFailed = !state || error !== undefined
        }
      }
    }
  )
)
