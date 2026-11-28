import { useCallback, useState, useSyncExternalStore } from 'react'

/**
 * 접어 둔 구역 기억 — localStorage 'naip-sections' = { [구역 열쇠]: 펼쳤는가 }.
 * 화면을 오가도, 앱을 다시 열어도 다시 누를 때까지 유지한다. 이 기기 화면 설정이라 백업에 넣지 않는다.
 * 같은 열쇠를 쓰는 곳(구역 머리, "모두 접기", 머리의 버튼을 펼쳤을 때만 보이는 화면)은 함께 바뀐다.
 */
export const SECTIONS_KEY = 'naip-sections'

type Folds = Record<string, boolean>

const listeners = new Set<() => void>()
/** 처음 읽은 뒤로는 이것이 기준 — 저장이 안 돼도(용량·막힌 저장소) 이번 실행 동안은 접기·펴기가 된다 */
let cache: Folds | null = null

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 저장된 값에서 참·거짓만 (깨진 JSON·배열·다른 값은 버린다) */
function parse(raw: string | null | undefined): Folds {
  const out: Folds = Object.create(null) as Folds
  try {
    const v: unknown = JSON.parse(raw ?? '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'boolean') out[k] = x
  } catch {
    // 깨졌으면 모두 기본값
  }
  return out
}

function folds(): Folds {
  if (cache) return cache
  let raw: string | null = null
  try {
    raw = storage()?.getItem(SECTIONS_KEY) ?? null
  } catch {
    raw = null
  }
  cache = parse(raw)
  return cache
}

/** 저장된 펼침 상태 (한 번도 누르지 않았으면 undefined) */
export function storedSectionOpen(key: string): boolean | undefined {
  const all = folds()
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : undefined
}

export function sectionOpen(key: string, defaultOpen = true): boolean {
  return storedSectionOpen(key) ?? defaultOpen
}

/** 여러 구역을 한 번에 접거나 편다 ("모두 접기") — 저장하지 못해도 이번 실행 동안은 바뀐다 */
export function setSectionsOpen(keys: readonly string[], open: boolean): void {
  if (!keys.length) return
  const next: Folds = Object.assign(Object.create(null) as Folds, folds())
  for (const k of keys) next[k] = open
  cache = next
  try {
    storage()?.setItem(SECTIONS_KEY, JSON.stringify({ ...next }))
  } catch {
    // 기억하지 못해도 접기·펴기는 된다
  }
  for (const l of [...listeners]) l()
}

export function subscribeSections(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 시험용: 저장소를 다시 읽게 한다 */
export function reloadSections(): void {
  cache = null
  for (const l of [...listeners]) l()
}

export interface SectionEntry {
  key: string
  /** 한 번도 누르지 않았을 때 (기본 true) */
  defaultOpen?: boolean
}

/** 보이는 구역 중 하나라도 펼쳐져 있나 — "모두 접기"/"모두 펴기"를 가른다 */
export function anySectionOpen(entries: readonly SectionEntry[]): boolean {
  return entries.some((e) => sectionOpen(e.key, e.defaultOpen ?? true))
}

/**
 * 구역 펼침 상태. key가 있으면 기억하고(같은 열쇠끼리 함께 바뀜), 없으면 이 화면에서만.
 */
export function useSectionOpen(key: string | undefined, defaultOpen = true): [boolean, (open: boolean) => void] {
  const [local, setLocal] = useState(defaultOpen)
  const read = (): boolean | undefined => (key ? storedSectionOpen(key) : undefined)
  // 세 번째 인자는 서버 렌더(시험의 renderToString)용 — 앱은 늘 브라우저에서 그린다
  const stored = useSyncExternalStore(subscribeSections, read, read)
  const open = key ? (stored ?? defaultOpen) : local
  const setOpen = useCallback((v: boolean) => (key ? setSectionsOpen([key], v) : setLocal(v)), [key])
  return [open, setOpen]
}

export function useAnySectionOpen(entries: readonly SectionEntry[]): boolean {
  const read = (): boolean => anySectionOpen(entries)
  return useSyncExternalStore(subscribeSections, read, read)
}
