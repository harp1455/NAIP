import { create } from 'zustand'
import type { HistoryMeta } from '../lib/db'

/** "골라서 저장" 대화상자에 올려 둔 이미지들 */
interface SaverState {
  items: HistoryMeta[] | null
  /** 저장이 끝난 뒤 호출 (예: 히스토리의 선택 모드 해제) */
  onDone: (() => void) | null
  open: (items: HistoryMeta[], onDone?: () => void) => void
  close: () => void
}

export const useSaver = create<SaverState>()((set) => ({
  items: null,
  onDone: null,
  open: (items, onDone) => set({ items, onDone: onDone ?? null }),
  close: () => set({ items: null, onDone: null })
}))
