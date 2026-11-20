import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { idbStorage } from '../lib/db'
import { makeThumb, pngDataUrl, toPngBase64 } from '../lib/image'
import { uid } from '../lib/util'

export interface Vibe {
  id: number
  name: string
  /** 원본 PNG base64. .naiv4vibe에서 가져온 바이브는 원본이 없을 수 있다 ('') */
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
          if (/\.naiv4vibe$/i.test(f.name) || f.type === 'application/json') {
            const vibe = await parseVibeFile(f)
            set((s) => ({ vibes: [...s.vibes, vibe] }))
            continue
          }
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

/** .naiv4vibe 파일명 속 모델 키 → API 모델 id */
const VIBE_MODEL_KEYS: Record<string, string> = {
  'v4-5full': 'nai-diffusion-4-5-full',
  'v4-5curated': 'nai-diffusion-4-5-curated',
  v4full: 'nai-diffusion-4-full',
  v4curated: 'nai-diffusion-4-curated-preview'
}

/**
 * NovelAI 웹에서 내보낸 .naiv4vibe (이미 인코딩된 바이브) 가져오기 — 재인코딩 비용이 들지 않는다.
 * 구조: { name, image?(base64), encodings: { [모델키]: { [해시]: { encoding, params: { information_extracted } } } } }
 */
async function parseVibeFile(file: File): Promise<Vibe> {
  const data = JSON.parse(await file.text()) as {
    name?: string
    image?: string
    thumbnail?: string
    encodings?: Record<string, Record<string, { encoding?: string; params?: { information_extracted?: number } }>>
    importInfo?: { information_extracted?: number; strength?: number }
  }
  if (!data.encodings) throw new Error('.naiv4vibe 형식이 아닙니다')
  const encodings: Record<string, string> = {}
  let firstIe: number | null = null
  for (const [modelKey, byHash] of Object.entries(data.encodings)) {
    const model = VIBE_MODEL_KEYS[modelKey]
    if (!model) continue
    for (const entry of Object.values(byHash)) {
      if (!entry.encoding) continue
      const ie = entry.params?.information_extracted ?? 1
      firstIe ??= ie
      encodings[vibeKey(model, ie)] = entry.encoding
    }
  }
  if (!Object.keys(encodings).length) throw new Error('지원하는 모델의 인코딩이 없습니다')
  const image = data.image ? data.image.replace(/^data:[^,]+,/, '') : ''
  const thumbSrc = image ? pngDataUrl(image) : data.thumbnail
  return {
    id: uid(),
    name: (data.name ?? file.name).replace(/\.naiv4vibe$/i, ''),
    image,
    thumb: thumbSrc ? await makeThumb(thumbSrc, 256).catch(() => '') : '',
    strength: data.importInfo?.strength ?? 0.6,
    infoExtracted: data.importInfo?.information_extracted ?? firstIe ?? 1,
    enabled: true,
    encodings
  }
}
