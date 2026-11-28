import { create } from 'zustand'

/** 알림 옆에 붙는 버튼 하나 (예: 되돌리기) */
export interface ToastAction {
  label: string
  run: () => void
}

/** 화면 아래에 잠깐 뜨는 알림 한 줄 (복사·공유 결과 등) */
interface ToastState {
  text: string | null
  error: boolean
  /** 버튼이 있으면 누를 틈을 주려고 조금 더 오래 띄운다 */
  action: ToastAction | null
  /** 같은 문구가 이어서 떠도 다시 보이도록 매번 바뀌는 값 */
  seq: number
  show: (text: string, error?: boolean, action?: ToastAction) => void
  hide: () => void
}

export const useToast = create<ToastState>()((set) => ({
  text: null,
  error: false,
  action: null,
  seq: 0,
  show: (text, error = false, action) => set((s) => ({ text, error, action: action ?? null, seq: s.seq + 1 })),
  hide: () => set({ text: null, action: null })
}))

export function toast(text: string, error = false, action?: ToastAction): void {
  useToast.getState().show(text, error, action)
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
