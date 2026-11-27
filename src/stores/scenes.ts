import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { clamp, uid } from '../lib/util'

export interface SceneFolder {
  id: number
  name: string
}

/** 씬: 메인 프롬프트 뒤에 덧붙는 장면별 프롬프트 + 예약 장수 */
export interface Scene {
  id: number
  name: string
  folderId: number | null
  prompt: string
  negative: string
  /** null = 메인 설정의 해상도 사용 */
  size: { width: number; height: number } | null
  /**
   * 이 씬에 출연할 캐릭터(라이브러리 id). 없으면 프롬프트 화면에서 켜 둔 출연을 그대로 쓴다.
   * 빈 배열이면 캐릭터 없이 생성한다
   */
  cast?: number[]
  /** 씬 출연 캐릭터의 위치 (캐릭터 id → 비율 좌표). 없는 캐릭터는 AI 선택 */
  castCenters?: Record<number, { x: number; y: number }>
  /** 예약 장수 — 생성될 때마다 1씩 줄어든다 */
  reserve: number
}

interface ScenesState {
  folders: SceneFolder[]
  scenes: Scene[]
  addFolder: (name: string) => number
  renameFolder: (id: number, name: string) => void
  deleteFolder: (id: number) => void
  saveScene: (s: Omit<Scene, 'id' | 'reserve'> & { id?: number }) => void
  duplicateScene: (id: number) => void
  deleteScene: (id: number) => void
  setReserve: (id: number, n: number) => void
  bumpReserve: (ids: number[], delta: number) => void
  clearReserve: (ids: number[]) => void
}

export const MAX_RESERVE = 999

export const useScenes = create<ScenesState>()(
  persist(
    (set) => ({
      folders: [],
      scenes: [],
      addFolder: (name) => {
        const id = uid()
        set((s) => ({ folders: [...s.folders, { id, name: name.trim() || '새 묶음' }] }))
        return id
      },
      renameFolder: (id, name) =>
        set((s) => ({
          folders: s.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f))
        })),
      deleteFolder: (id) =>
        set((s) => ({
          folders: s.folders.filter((f) => f.id !== id),
          scenes: s.scenes.map((x) => (x.folderId === id ? { ...x, folderId: null } : x))
        })),
      saveScene: (sc) => {
        const id = sc.id ?? uid()
        set((s) => {
          const prev = s.scenes.find((x) => x.id === id)
          const next: Scene = { ...sc, id, name: sc.name.trim() || '이름 없는 씬', reserve: prev?.reserve ?? 0 }
          return { scenes: prev ? s.scenes.map((x) => (x.id === id ? next : x)) : [...s.scenes, next] }
        })
      },
      duplicateScene: (id) =>
        set((s) => {
          const i = s.scenes.findIndex((x) => x.id === id)
          if (i < 0) return s
          const copy: Scene = { ...s.scenes[i], id: uid(), name: `${s.scenes[i].name} 복사`, reserve: 0 }
          return { scenes: [...s.scenes.slice(0, i + 1), copy, ...s.scenes.slice(i + 1)] }
        }),
      deleteScene: (id) => set((s) => ({ scenes: s.scenes.filter((x) => x.id !== id) })),
      setReserve: (id, n) =>
        set((s) => ({
          scenes: s.scenes.map((x) => (x.id === id ? { ...x, reserve: clamp(Math.round(n) || 0, 0, MAX_RESERVE) } : x))
        })),
      bumpReserve: (ids, delta) =>
        set((s) => {
          const hit = new Set(ids)
          return {
            scenes: s.scenes.map((x) =>
              hit.has(x.id) ? { ...x, reserve: clamp(x.reserve + delta, 0, MAX_RESERVE) } : x
            )
          }
        }),
      clearReserve: (ids) =>
        set((s) => {
          const hit = new Set(ids)
          return { scenes: s.scenes.map((x) => (hit.has(x.id) ? { ...x, reserve: 0 } : x)) }
        })
    }),
    { name: 'naip-scenes' }
  )
)

/** NAIS3 appendPrompt — 쉼표 중복 없이 뒤에 덧붙인다 */
export function appendPrompt(base: string, add: string): string {
  const b = base.trim().replace(/,\s*$/, '')
  const a = add.trim().replace(/^,\s*/, '')
  if (!b) return a
  if (!a) return b
  return `${b}, ${a}`
}
