import { create } from 'zustand'

/** 디렉터 툴·업스케일에 올려 둔 작업 이미지 (세션 한정) */
interface DirectorState {
  open: boolean
  image: Blob | null
  show: (image?: Blob | null) => void
  setImage: (image: Blob | null) => void
  close: () => void
}

export const useDirector = create<DirectorState>()((set) => ({
  open: false,
  image: null,
  show: (image) => set((s) => ({ open: true, image: image === undefined ? s.image : image })),
  setImage: (image) => set({ image }),
  close: () => set({ open: false })
}))
