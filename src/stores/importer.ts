import { create } from 'zustand'
import type { Importable } from '../lib/apply'

/** "설정 불러오기" 대화상자에 올려 둔 설정 */
interface ImporterState {
  data: Importable | null
  /** 어디서 온 설정인지 (프리셋 이름 기본값에 쓴다) */
  origin: string
  open: (data: Importable, origin: string) => void
  close: () => void
}

export const useImporter = create<ImporterState>()((set) => ({
  data: null,
  origin: '',
  open: (data, origin) => set({ data, origin }),
  close: () => set({ data: null })
}))
