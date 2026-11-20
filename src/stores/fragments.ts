import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { normalizeFragmentPath, type FragmentSource } from '../nai/fragments'
import { uid } from '../lib/util'

export interface FragFolder {
  id: number
  name: string
}

/** 조각: 한 줄에 선택지 하나. 프롬프트의 <이름> / <폴더/이름> 이 그중 한 줄로 치환된다 */
export interface Fragment {
  id: number
  name: string
  folderId: number | null
  content: string
}

interface FragmentsState {
  folders: FragFolder[]
  fragments: Fragment[]
  addFolder: (name: string) => number
  renameFolder: (id: number, name: string) => void
  deleteFolder: (id: number) => void
  saveFragment: (f: Omit<Fragment, 'id'> & { id?: number }) => void
  deleteFragment: (id: number) => void
}

export const useFragments = create<FragmentsState>()(
  persist(
    (set) => ({
      folders: [],
      fragments: [],
      addFolder: (name) => {
        const id = uid()
        set((s) => ({ folders: [...s.folders, { id, name: name.trim() || '새 폴더' }] }))
        return id
      },
      renameFolder: (id, name) =>
        set((s) => ({
          folders: s.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f))
        })),
      deleteFolder: (id) =>
        set((s) => ({
          folders: s.folders.filter((f) => f.id !== id),
          fragments: s.fragments.map((f) => (f.folderId === id ? { ...f, folderId: null } : f))
        })),
      saveFragment: (f) => {
        const id = f.id ?? uid()
        const next: Fragment = { ...f, id, name: f.name.trim() || '이름 없음' }
        set((s) => ({
          fragments: s.fragments.some((x) => x.id === id)
            ? s.fragments.map((x) => (x.id === id ? next : x))
            : [...s.fragments, next]
        }))
      },
      deleteFragment: (id) => set((s) => ({ fragments: s.fragments.filter((f) => f.id !== id) }))
    }),
    { name: 'naip-fragments' }
  )
)

export function fragmentPath(f: Fragment, folders: FragFolder[]): string {
  const folder = folders.find((x) => x.id === f.folderId)
  return folder ? `${folder.name}/${f.name}` : f.name
}

/** 현재 조각 라이브러리의 스냅샷으로 치환 소스를 만든다 (폴더/이름, 이름 둘 다로 찾을 수 있다) */
export function fragmentSource(): FragmentSource {
  const { fragments, folders } = useFragments.getState()
  const map = new Map<string, string[]>()
  for (const f of fragments) {
    const lines = f.content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
    const full = normalizeFragmentPath(fragmentPath(f, folders))
    map.set(full, lines)
    const bare = normalizeFragmentPath(f.name)
    if (!map.has(bare)) map.set(bare, lines)
  }
  return { getLines: (path) => map.get(path) ?? null }
}
