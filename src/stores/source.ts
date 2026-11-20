import { create } from 'zustand'
import { toPngBase64 } from '../lib/image'
import { snapNaiResolution } from '../nai/resolution'
import { usePrompt } from './prompt'

/** i2i / 인페인트 소스 (세션 한정 — 저장하지 않음) */
interface SourceState {
  /** PNG base64 */
  image: string | null
  width: number
  height: number
  /** 마스크 편집 결과 (투명 배경 위 흰색, 소스와 같은 해상도의 PNG dataURL). 있으면 인페인트 */
  mask: string | null
  strength: number
  noise: number
  setImage: (src: Blob | string) => Promise<void>
  setMask: (mask: string | null) => void
  patch: (p: Partial<Pick<SourceState, 'strength' | 'noise'>>) => void
  clear: () => void
}

export const useSource = create<SourceState>()((set) => ({
  image: null,
  width: 0,
  height: 0,
  mask: null,
  strength: 0.7,
  noise: 0,
  setImage: async (src) => {
    const { base64, width, height } = await toPngBase64(src)
    set({ image: base64, width, height, mask: null })
    // 생성 해상도를 소스 비율에 맞춘 유효 NAI 해상도로 자동 설정
    usePrompt.getState().patchParams(snapNaiResolution(width, height))
  },
  setMask: (mask) => set({ mask }),
  patch: (p) => set(p),
  clear: () => set({ image: null, width: 0, height: 0, mask: null })
}))
