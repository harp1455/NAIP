import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { idbStorage } from '../lib/db'
import { makeThumb, pngDataUrl, toPngBase64 } from '../lib/image'
import { uid } from '../lib/util'

export interface Vibe {
  id: number
  name: string
  /** 원본 PNG base64 */
  image: string
  thumb: string
  strength: number
  infoExtracted: number
  enabled: boolean
  /** `${model}|${infoExtracted}` → 인코딩된 바이브 base64 (encode-vibe 결과 캐시) */
  encodings: Record<string, string>
}

export type RefType = 'character' | 'style' | 'character&style'

export interface CharRef {
  id: number
  name: string
  image: string
  thumb: string
  type: RefType
  strength: number
  fidelity: number
  enabled: boolean
}

export function vibeKey(model: string, infoExtracted: number): string {
  return `${model}|${infoExtracted}`
}

interface RefsState {
  vibes: Vibe[]
  charRefs: CharRef[]
  hydrated: boolean
  addVibes: (files: File[]) => Promise<void>
  patchVibe: (id: number, p: Partial<Omit<Vibe, 'id'>>) => void
  setVibeEncoding: (id: number, key: string, data: string) => void
  removeVibe: (id: number) => void
  addCharRefs: (files: File[]) => Promise<void>
  patchCharRef: (id: number, p: Partial<Omit<CharRef, 'id'>>) => void
  removeCharRef: (id: number) => void
}

export const useRefs = create<RefsState>()(
  persist(
    (set) => ({
      vibes: [],
      charRefs: [],
      hydrated: false,
      addVibes: async (files) => {
        for (const f of files) {
          const { base64 } = await toPngBase64(f, 1536)
          const vibe: Vibe = {
            id: uid(),
            name: f.name.replace(/\.[^.]+$/, ''),
            image: base64,
            thumb: await makeThumb(pngDataUrl(base64), 256),
            strength: 0.6,
            infoExtracted: 1,
            enabled: true,
            encodings: {}
          }
          set((s) => ({ vibes: [...s.vibes, vibe] }))
        }
      },
      patchVibe: (id, p) =>
        set((s) => ({ vibes: s.vibes.map((v) => (v.id === id ? { ...v, ...p } : v)) })),
      setVibeEncoding: (id, key, data) =>
        set((s) => ({
          vibes: s.vibes.map((v) =>
            v.id === id ? { ...v, encodings: { ...v.encodings, [key]: data } } : v
          )
        })),
      removeVibe: (id) => set((s) => ({ vibes: s.vibes.filter((v) => v.id !== id) })),
      addCharRefs: async (files) => {
        for (const f of files) {
          const { base64 } = await toPngBase64(f, 2048)
          const ref: CharRef = {
            id: uid(),
            name: f.name.replace(/\.[^.]+$/, ''),
            image: base64,
            thumb: await makeThumb(pngDataUrl(base64), 256),
            type: 'character&style',
            strength: 1,
            fidelity: 1,
            enabled: true
          }
          set((s) => ({ charRefs: [...s.charRefs, ref] }))
        }
      },
      patchCharRef: (id, p) =>
        set((s) => ({ charRefs: s.charRefs.map((r) => (r.id === id ? { ...r, ...p } : r)) })),
      removeCharRef: (id) => set((s) => ({ charRefs: s.charRefs.filter((r) => r.id !== id) }))
    }),
    {
      name: 'naip-refs',
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => ({ vibes: s.vibes, charRefs: s.charRefs }),
      onRehydrateStorage: () => () => useRefs.setState({ hydrated: true })
    }
  )
)
