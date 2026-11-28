import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { uid } from '../lib/util'
import {
  advanceCursors,
  cleanCursors,
  DEFAULT_CAST_OPTIONS,
  referencedCharacterIds,
  type CastCharacter,
  type CastCursors,
  type CastOptions,
  type CastPlan,
  type CastSlot,
  type SlotCandidate,
  type VariationGroup,
  type VariationItem
} from '../nai/cast'

export interface CharFolder {
  id: number
  name: string
}

/** 라이브러리 캐릭터 — 고정 · 변형 그룹 · 가변 · 디테일 + 네거티브 (src/nai/cast.ts) */
export type Character = CastCharacter

/** 저장 형식 버전 — 0: 캐릭터 prompt 한 칸 + cast 목록, 1: 3분할 + 변형 그룹 + 출연 슬롯 */
export const CHARACTERS_VERSION = 1

interface CharactersData {
  folders: CharFolder[]
  characters: Character[]
  /** 출연 슬롯 (슬롯 순서 = 보내는 순서) */
  slots: CastSlot[]
  options: CastOptions
  /**
   * "배치에 한 번" 순차 슬롯·변형 그룹의 다음 차례 (src/nai/cast.ts CastCursors) — 새 배치마다 한 칸씩 나아간다.
   * 나중에 더한 칸이라 예전 저장분·백업에는 없다 (없으면 처음부터)
   */
  cursors?: CastCursors
}

interface CharactersState extends CharactersData {
  cursors: CastCursors
  /**
   * 순서 자리를 처음으로 되돌리거나 백업으로 바꿀 때마다 하나씩 는다 (이 기기에만 — 백업에 넣지 않는다).
   * 배치는 시작할 때의 값을 들고 있다가 값이 바뀌었으면 그 배치의 그림으로 자리를 넘기지 않는다 —
   * 처음 자리(0)에서 시작한 배치의 남은 장이 되돌린 자리를 다시 1로 넘기지 않게
   */
  cursorEpoch: number
  addFolder: (name: string) => number
  renameFolder: (id: number, name: string) => void
  deleteFolder: (id: number, deleteCharacters: boolean) => void
  saveCharacter: (c: Omit<Character, 'id' | 'variations'> & { id?: number; variations?: VariationGroup[] }) => number
  duplicateCharacter: (id: number) => void
  deleteCharacter: (id: number) => void
  moveCharacter: (id: number, folderId: number | null) => void
  addSlot: (slot?: Partial<Omit<CastSlot, 'id'>>) => number
  patchSlot: (id: number, p: Partial<Omit<CastSlot, 'id'>>) => void
  removeSlot: (id: number) => void
  moveSlot: (id: number, dir: -1 | 1) => void
  duplicateSlot: (id: number) => void
  /** 라이브러리에서 누르기: 그 캐릭터의 고정 슬롯이 있으면 내리고, 없으면 고정 슬롯으로 올린다 */
  toggleFixed: (charId: number) => void
  clearSlots: () => void
  setOptions: (p: Partial<CastOptions>) => void
  /**
   * 그림이 나온 장이 쓴 순서 자리를 넘긴다 (resolveCast의 advance — 같은 배치를 다시 넘겨도 한 번만).
   * epoch = 그 배치가 시작할 때의 cursorEpoch. 그사이 되돌리기·백업 복원이 있었으면 넘기지 않고,
   * 지운 슬롯·캐릭터·변형 그룹의 자리는 다시 만들지 않는다
   */
  commitCursors: (advance: CastCursors, epoch: number) => void
  /** 배치에 한 번 순차를 다음 배치에 첫 후보·항목부터 (지금 도는 배치가 끝나도 그대로) */
  resetCursors: () => void
}

export function newSlot(p: Partial<Omit<CastSlot, 'id'>> = {}): CastSlot {
  return {
    id: uid(),
    enabled: true,
    mode: 'fixed',
    charId: null,
    candidates: [],
    chance: 50,
    wrap: true,
    center: null,
    ...p
  }
}

// ── 이전 형식 → 지금 형식 (저장소·백업·설정 불러오기가 같이 쓴다) ──────────────

/** 깊은 복사 (저장 데이터는 순수 JSON이라 이걸로 충분 — 오래된 웹뷰에는 structuredClone이 없다) */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const idOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** 목록에서 객체인 항목만 (손상·조작된 데이터의 null·숫자·문자열은 읽다가 멈추지 않게 뺀다) */
const objects = (list: unknown[]): Record<string, unknown>[] =>
  list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
const center = (v: unknown): { x: number; y: number } | null => {
  const c = v as { x?: unknown; y?: unknown } | null
  return c && typeof c.x === 'number' && typeof c.y === 'number' ? { x: c.x, y: c.y } : null
}

function normalizeItem(raw: unknown): VariationItem {
  const r = (raw ?? {}) as Record<string, unknown>
  return { id: num(r.id, uid()), label: str(r.label), prompt: str(r.prompt), weight: Math.max(0, num(r.weight, 1)) }
}

function normalizeGroup(raw: unknown): VariationGroup {
  const r = (raw ?? {}) as Record<string, unknown>
  const kinds = ['outfit', 'expression', 'pose', 'action', 'accessory', 'custom']
  const modes = ['fixed', 'random', 'sequential', 'off']
  return {
    id: num(r.id, uid()),
    kind: (kinds.includes(r.kind as string) ? r.kind : 'custom') as VariationGroup['kind'],
    name: str(r.name),
    mode: (modes.includes(r.mode as string) ? r.mode : 'random') as VariationGroup['mode'],
    fixedId: idOrNull(r.fixedId),
    ...(r.perBatch ? { perBatch: true } : {}),
    items: Array.isArray(r.items) ? r.items.map(normalizeItem) : []
  }
}

/** 어떤 형식의 캐릭터든 지금 형식으로 — 예전의 prompt 한 칸은 고정(base)으로 그대로 옮긴다 */
export function normalizeCharacter(raw: unknown): Character {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    id: num(r.id, uid()),
    name: str(r.name) || '이름 없음',
    folderId: idOrNull(r.folderId),
    base: typeof r.base === 'string' ? r.base : str(r.prompt),
    additional: str(r.additional),
    detail: str(r.detail),
    negative: str(r.negative),
    variations: Array.isArray(r.variations) ? r.variations.map(normalizeGroup) : []
  }
}

function normalizeSlot(raw: unknown): CastSlot {
  const r = (raw ?? {}) as Record<string, unknown>
  const modes = ['fixed', 'random', 'sequential', 'chance']
  return {
    id: num(r.id, uid()),
    enabled: r.enabled !== false,
    mode: (modes.includes(r.mode as string) ? r.mode : 'fixed') as CastSlot['mode'],
    charId: idOrNull(r.charId),
    candidates: Array.isArray(r.candidates)
      ? objects(r.candidates).map((c) => ({
          kind: c.kind === 'folder' ? ('folder' as const) : ('char' as const),
          id: idOrNull(c.id),
          weight: Math.max(0, num(c.weight, 1))
        }))
      : [],
    chance: Math.max(0, Math.min(100, num(r.chance, 50))),
    wrap: r.wrap !== false,
    center: center(r.center)
  }
}

/**
 * 저장된(또는 백업의) 캐릭터 데이터를 지금 형식으로 바꾼다. 잃는 내용 없음:
 * - 캐릭터의 prompt 한 칸 → 고정(base), 가변·디테일은 빈 칸, 변형 그룹 없음
 * - 예전 출연 목록 cast [{charId, enabled, center}] → 같은 순서의 고정 슬롯 (켜짐·위치 유지)
 */
export function migrateCharacters(raw: unknown): CharactersData {
  const r = (raw ?? {}) as Record<string, unknown>
  const folders = Array.isArray(r.folders)
    ? objects(r.folders).map((f) => ({ id: num(f.id, uid()), name: str(f.name) || '폴더' }))
    : []
  const characters = Array.isArray(r.characters) ? r.characters.map(normalizeCharacter) : []
  let slots: CastSlot[]
  if (Array.isArray(r.slots)) slots = r.slots.map(normalizeSlot)
  else if (Array.isArray(r.cast)) {
    slots = objects(r.cast).map((e) =>
      newSlot({ mode: 'fixed', charId: idOrNull(e.charId), enabled: e.enabled !== false, center: center(e.center) })
    )
  } else slots = []
  const o = (r.options ?? {}) as Partial<CastOptions>
  const options: CastOptions = {
    allowDuplicates: typeof o.allowDuplicates === 'boolean' ? o.allowDuplicates : DEFAULT_CAST_OPTIONS.allowDuplicates,
    scope: o.scope === 'batch' ? 'batch' : 'image',
    perScene: o.perScene === true,
    autoCountTags: o.autoCountTags === true
  }
  // 순서 자리는 있을 때만 (없는 예전 데이터를 불러와도 지금 자리를 지우지 않게) — 깨진 값은 버린다
  const hasCursors = !!r.cursors && typeof r.cursors === 'object' && !Array.isArray(r.cursors)
  return { folders, characters, slots, options, ...(hasCursors ? { cursors: cleanCursors(r.cursors) } : {}) }
}

/** 백업용 — 지금 형식 그대로 (불러올 때는 migrateCharacters를 거친다) */
export function exportCharacters(): CharactersData & { version: number } {
  const s = useCharacters.getState()
  return {
    version: CHARACTERS_VERSION,
    folders: s.folders,
    characters: s.characters,
    slots: s.slots,
    options: s.options,
    cursors: s.cursors
  }
}

/** 백업 불러오기 — 예전 형식(prompt 한 칸·cast)도 받는다 */
export function importCharacters(raw: unknown): void {
  replaceCharacters(migrateCharacters(raw) as unknown as Record<string, unknown>)
}

/** 저장된 cursorEpoch (없거나 깨졌으면 0) */
export function cursorEpochOf(s: { cursorEpoch?: unknown } = useCharacters.getState()): number {
  const v = s.cursorEpoch
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

const sameCursors = (a: CastCursors, b: CastCursors): boolean => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k])
}

/**
 * 캐릭터 데이터를 백업 것으로 바꾼다 (이미 다듬은 섹션 — 함수 이름과 겹치는 키는 부르는 쪽이 뺀다).
 * 순서 자리가 바뀌면 cursorEpoch를 올려, 지금 돌거나 이어서 돌릴 배치가 복원한 자리를 넘기지 않게 한다.
 * cursorEpoch는 이 기기의 것이라 들어온 값은 쓰지 않는다
 */
export function replaceCharacters(patch: Record<string, unknown>): void {
  const { cursorEpoch: _ignored, ...rest } = patch
  useCharacters.setState((s) => {
    const moved = 'cursors' in rest && !sameCursors(cleanCursors(s.cursors), cleanCursors(rest.cursors))
    return { ...rest, ...(moved ? { cursorEpoch: cursorEpochOf(s) + 1 } : {}) } as Partial<CharactersState>
  })
}

/** 순서 자리의 열쇠가 가리키는 슬롯·변형 그룹이 아직 있는지 (열쇠는 resolveCast가 만드는 것과 같은 모양) */
function cursorTargetExists(key: string, s: Pick<CharactersData, 'slots' | 'characters'>): boolean {
  if (key.startsWith('slot:')) return s.slots.some((x) => `slot:${x.id}` === key)
  return s.characters.some((c) => key.startsWith(`var:${c.id}:`) && c.variations.some((g) => `var:${c.id}:${g.id}` === key))
}

/** 지운 슬롯·캐릭터의 순서 자리를 뺀다 (바뀐 것이 없으면 그대로) */
function pruneCursors(cursors: CastCursors | undefined, keep: (key: string) => boolean): CastCursors {
  const cur = cursors && typeof cursors === 'object' ? cursors : {}
  const gone = Object.keys(cur).filter((k) => !keep(k))
  if (!gone.length) return cur
  const next = { ...cur }
  for (const k of gone) delete next[k]
  return next
}
const varOf = (key: string): number => Number(/^var:(-?\d+):/.exec(key)?.[1] ?? NaN)

/** 후보·고정 캐릭터에서 지워진 캐릭터·폴더를 걷어 낸다 (고정 슬롯이 비면 슬롯째 내린다) */
function pruneSlots(slots: CastSlot[], goneChars: Set<number>, goneFolder?: number): CastSlot[] {
  return slots.flatMap((s) => {
    if (s.mode === 'fixed' && s.charId !== null && goneChars.has(s.charId)) return []
    const candidates = s.candidates.filter((c) =>
      c.kind === 'char' ? c.id === null || !goneChars.has(c.id) : goneFolder === undefined || c.id !== goneFolder
    )
    const charId = s.charId !== null && goneChars.has(s.charId) ? null : s.charId
    return candidates.length === s.candidates.length && charId === s.charId ? [s] : [{ ...s, candidates, charId }]
  })
}

export const useCharacters = create<CharactersState>()(
  persist(
    (set) => ({
      folders: [],
      characters: [],
      slots: [],
      options: DEFAULT_CAST_OPTIONS,
      cursors: {},
      cursorEpoch: 0,
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
            // 폴더 후보는 폴더가 없어지면 뜻이 바뀌므로(미분류로 옮겨진 캐릭터) 후보에서 뺀다
            slots: pruneSlots(s.slots, gone, id),
            cursors: pruneCursors(s.cursors, (k) => !gone.has(varOf(k)))
          }
        }),
      saveCharacter: (c) => {
        const id = c.id ?? uid()
        set((s) => {
          const prev = s.characters.find((x) => x.id === id)
          const next: Character = {
            ...c,
            id,
            name: c.name.trim() || '이름 없음',
            variations: c.variations ?? prev?.variations ?? []
          }
          return {
            characters: prev ? s.characters.map((x) => (x.id === id ? next : x)) : [...s.characters, next]
          }
        })
        return id
      },
      duplicateCharacter: (id) =>
        set((s) => {
          const i = s.characters.findIndex((c) => c.id === id)
          if (i < 0) return s
          const copy: Character = {
            ...clone(s.characters[i]),
            id: uid(),
            name: `${s.characters[i].name} 복사`
          }
          return { characters: [...s.characters.slice(0, i + 1), copy, ...s.characters.slice(i + 1)] }
        }),
      deleteCharacter: (id) =>
        set((s) => ({
          characters: s.characters.filter((c) => c.id !== id),
          slots: pruneSlots(s.slots, new Set([id])),
          cursors: pruneCursors(s.cursors, (k) => varOf(k) !== id)
        })),
      moveCharacter: (id, folderId) =>
        set((s) => ({
          characters: s.characters.map((c) => (c.id === id ? { ...c, folderId } : c))
        })),
      addSlot: (p) => {
        const slot = newSlot(p)
        set((s) => ({ slots: [...s.slots, slot] }))
        return slot.id
      },
      patchSlot: (id, p) => set((s) => ({ slots: s.slots.map((x) => (x.id === id ? { ...x, ...p } : x)) })),
      removeSlot: (id) =>
        set((s) => ({ slots: s.slots.filter((x) => x.id !== id), cursors: pruneCursors(s.cursors, (k) => k !== `slot:${id}`) })),
      moveSlot: (id, dir) =>
        set((s) => {
          const i = s.slots.findIndex((x) => x.id === id)
          const j = i + dir
          if (i < 0 || j < 0 || j >= s.slots.length) return s
          const slots = [...s.slots]
          ;[slots[i], slots[j]] = [slots[j], slots[i]]
          return { slots }
        }),
      duplicateSlot: (id) =>
        set((s) => {
          const i = s.slots.findIndex((x) => x.id === id)
          if (i < 0) return s
          const copy = { ...clone(s.slots[i]), id: uid() }
          return { slots: [...s.slots.slice(0, i + 1), copy, ...s.slots.slice(i + 1)] }
        }),
      toggleFixed: (charId) =>
        set((s) =>
          s.slots.some((x) => x.mode === 'fixed' && x.charId === charId)
            ? { slots: s.slots.filter((x) => !(x.mode === 'fixed' && x.charId === charId)) }
            : { slots: [...s.slots, newSlot({ mode: 'fixed', charId })] }
        ),
      clearSlots: () => set((s) => ({ slots: [], cursors: pruneCursors(s.cursors, (k) => !k.startsWith('slot:')) })),
      setOptions: (p) => set((s) => ({ options: { ...s.options, ...p } })),
      commitCursors: (advance, epoch) =>
        set((s) => {
          if (epoch !== cursorEpochOf(s)) return s
          const live: CastCursors = {}
          for (const [k, v] of Object.entries(advance)) if (cursorTargetExists(k, s)) live[k] = v
          const cursors = advanceCursors(s.cursors, live)
          return cursors ? { cursors } : s
        }),
      resetCursors: () => set((s) => ({ cursors: {}, cursorEpoch: cursorEpochOf(s) + 1 }))
    }),
    {
      name: 'naip-characters',
      version: CHARACTERS_VERSION,
      // 예전 저장분(prompt 한 칸 + cast)을 3분할 + 슬롯으로 — 내용은 그대로 옮긴다
      migrate: (persisted) => migrateCharacters(persisted) as unknown as CharactersState
    }
  )
)

/**
 * 지금 출연 설정의 스냅샷 — 대기열 배치가 나중에 라이브러리를 고쳐도 누른 순간의 내용대로 돌도록
 * 슬롯이 가리키는 캐릭터(폴더 후보는 그 안의 캐릭터 전부)를 깊은 복사로 담는다.
 */
export function snapshotCastPlan(override?: { slots: CastSlot[] }): CastPlan {
  const s = useCharacters.getState()
  const slots = override?.slots ?? s.slots
  const ids = referencedCharacterIds(slots, s.characters)
  return clone({
    slots,
    options: s.options,
    characters: s.characters.filter((c) => ids.has(c.id))
  })
}

/** 후보 한 줄의 이름 (캐릭터 이름 / 폴더 이름) */
export function candidateName(
  cand: SlotCandidate,
  characters: readonly Character[],
  folders: readonly CharFolder[]
): string {
  if (cand.kind === 'char') return characters.find((c) => c.id === cand.id)?.name ?? '(지워진 캐릭터)'
  if (cand.id === null) return '미분류'
  return folders.find((f) => f.id === cand.id)?.name ?? '(지워진 폴더)'
}
