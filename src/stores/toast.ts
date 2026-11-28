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

const unloaded = new Set<string>()

/**
 * 저장된 것을 불러오지 못한 스토어를 알린다 — 그 스토어는 이번 실행 동안 저장하지 않는다.
 * 저장소를 열지 못하면 여러 스토어가 한꺼번에 실패하므로 한 줄로 모은다
 */
export function toastLoadFailed(label: string): void {
  unloaded.add(label)
  toast(`${[...unloaded].join('·')}을(를) 불러오지 못했습니다 — 이번에 바꾼 것은 저장하지 않습니다 (앱을 다시 시작하면 다시 불러옵니다)`, true)
}
