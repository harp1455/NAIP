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

export const useMasks = create<MasksState>()(
  persist(
    (set) => ({
      masks: [],
      add: (m) => set((s) => ({ masks: [{ ...m, id: uid(), ts: Date.now() }, ...s.masks].slice(0, 50) })),
      remove: (id) => set((s) => ({ masks: s.masks.filter((m) => m.id !== id) })),
      rename: (id, name) =>
        set((s) => ({ masks: s.masks.map((m) => (m.id === id ? { ...m, name: name.trim() || m.name } : m)) }))
    }),
    { name: 'naip-masks', storage: debouncedIdbStorage<Pick<MasksState, 'masks'>>() }
  )
)
