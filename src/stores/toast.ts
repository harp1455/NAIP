import { create } from 'zustand'

/** 화면 아래에 잠깐 뜨는 알림 한 줄 (복사·공유 결과 등) */
interface ToastState {
  text: string | null
  error: boolean
  /** 같은 문구가 이어서 떠도 다시 보이도록 매번 바뀌는 값 */
  seq: number
  show: (text: string, error?: boolean) => void
  hide: () => void
}

export const useToast = create<ToastState>()((set) => ({
  text: null,
  error: false,
  seq: 0,
  show: (text, error = false) => set((s) => ({ text, error, seq: s.seq + 1 })),
  hide: () => set({ text: null })
}))

export function toast(text: string, error = false): void {
  useToast.getState().show(text, error)
}
