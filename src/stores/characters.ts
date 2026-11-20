import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { uid } from '../lib/util'

export interface CharFolder {
  id: number
  name: string
}

export interface Character {
  id: number
  name: string
  /** null = 미분류 */
  folderId: number | null
  prompt: string
  negative: string
}

/** 이번 생성에 출연시킬 캐릭터 (라이브러리 캐릭터 참조) */
export interface CastEntry {
  charId: number
  enabled: boolean
  /** null = AI's Choice */
  center: { x: number; y: number } | null
}

interface CharactersState {
  folders: CharFolder[]
  characters: Character[]
  cast: CastEntry[]
  addFolder: (name: string) => number
  renameFolder: (id: number, name: string) => void
  deleteFolder: (id: number, deleteCharacters: boolean) => void
  saveCharacter: (c: Omit<Character, 'id'> & { id?: number }) => number
  duplicateCharacter: (id: number) => void
  deleteCharacter: (id: number) => void
  moveCharacter: (id: number, folderId: number | null) => void
  toggleCast: (charId: number) => void
  patchCast: (charId: number, p: Partial<Omit<CastEntry, 'charId'>>) => void
  moveCast: (charId: number, dir: -1 | 1) => void
  clearCast: () => void
}

export const useCharacters = create<CharactersState>()(
  persist(
    (set) => ({
      folders: [],
      characters: [],
      cast: [],
      addFolder: (name) => {
        const id = uid()
        set((s) => ({ folders: [...s.folders, { id, name: name.trim() || '새 폴더' }] }))
        return id
      },
      renameFolder: (id, name) =>
        set((s) => ({
          folders: s.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f))
        })),
      deleteFolder: (id, deleteCharacters) =>
        set((s) => {
          const gone = new Set(
            deleteCharacters ? s.characters.filter((c) => c.folderId === id).map((c) => c.id) : []
          )
          return {
            folders: s.folders.filter((f) => f.id !== id),
            characters: s.characters
              .filter((c) => !gone.has(c.id))
              .map((c) => (c.folderId === id ? { ...c, folderId: null } : c)),
            cast: s.cast.filter((e) => !gone.has(e.charId))
          }
        }),
      saveCharacter: (c) => {
        const id = c.id ?? uid()
        const next: Character = { ...c, id, name: c.name.trim() || '이름 없음' }
        set((s) => ({
          characters: s.characters.some((x) => x.id === id)
            ? s.characters.map((x) => (x.id === id ? next : x))
            : [...s.characters, next]
        }))
        return id
      },
      duplicateCharacter: (id) =>
        set((s) => {
          const i = s.characters.findIndex((c) => c.id === id)
          if (i < 0) return s
          const copy = { ...s.characters[i], id: uid(), name: `${s.characters[i].name} 복사` }
          return { characters: [...s.characters.slice(0, i + 1), copy, ...s.characters.slice(i + 1)] }
        }),
      deleteCharacter: (id) =>
        set((s) => ({
          characters: s.characters.filter((c) => c.id !== id),
          cast: s.cast.filter((e) => e.charId !== id)
        })),
      moveCharacter: (id, folderId) =>
        set((s) => ({
          characters: s.characters.map((c) => (c.id === id ? { ...c, folderId } : c))
        })),
      toggleCast: (charId) =>
        set((s) => ({
          cast: s.cast.some((e) => e.charId === charId)
            ? s.cast.filter((e) => e.charId !== charId)
            : [...s.cast, { charId, enabled: true, center: null }]
        })),
      patchCast: (charId, p) =>
        set((s) => ({ cast: s.cast.map((e) => (e.charId === charId ? { ...e, ...p } : e)) })),
      moveCast: (charId, dir) =>
        set((s) => {
          const i = s.cast.findIndex((e) => e.charId === charId)
          const j = i + dir
          if (i < 0 || j < 0 || j >= s.cast.length) return s
          const cast = [...s.cast]
          ;[cast[i], cast[j]] = [cast[j], cast[i]]
          return { cast }
        }),
      clearCast: () => set({ cast: [] })
    }),
    { name: 'naip-characters' }
  )
)
