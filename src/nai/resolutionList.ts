/**
 * 해상도 목록 — NAI 기본 해상도(숨길 수 있음) + 사용자가 더한 "내 해상도".
 * 설정 스토어(naip-settings)에 `resolutions`·`hiddenResolutions` 로 저장되고, 설정 백업에 함께 들어간다.
 * 여기 있는 함수는 모두 순수 함수다 (스토어·화면이 같은 규칙을 쓴다).
 */
import { RESOLUTIONS } from './constants'
import { NAI_MAX_GENERATION_PIXELS, NAI_MIN_RESOLUTION, NAI_RESOLUTION_STEP } from './resolution'

/** 사용자가 목록에 더한 해상도 */
export interface UserResolution {
  /** 이름 (선택) */
  name?: string
  width: number
  height: number
}

/** 해상도 목록 설정 (설정 스토어의 두 필드) */
export interface ResolutionPrefs {
  resolutions: UserResolution[]
  /** 숨긴 기본 해상도의 키 (`832x1216`) */
  hiddenResolutions: string[]
}

/** 고르는 칸에 보일 항목 */
export interface ResolutionOption {
  key: string
  /** 칸에 보일 글자 — `세로 (832×1216)`, `카드 (896×1152)`, `896×1152` */
  text: string
  width: number
  height: number
  builtin: boolean
}

export interface ResolutionGroup {
  label: string
  items: ResolutionOption[]
}

/** Opus 무료 생성 범위 (1024×1024 = 1,048,576픽셀). 넘으면 장마다 Anlas가 든다 */
export const FREE_PIXELS = 1024 * 1024
export const RESOLUTION_NAME_MAX = 30
export const MAX_USER_RESOLUTIONS = 50
export const USER_GROUP_LABEL = '내 해상도'

export function sizeKey(width: number, height: number): string {
  return `${width}x${height}`
}

export function sizeText(width: number, height: number): string {
  return `${width}×${height}`
}

/** 무료 범위(1024×1024)를 넘는 크기 */
export function exceedsFreeArea(width: number, height: number): boolean {
  return width * height > FREE_PIXELS
}

/** NovelAI 웹의 해상도 목록과 같은 묶음 (RESOLUTIONS 의 순번) */
const BUILTIN_GROUPS: { label: string; items: number[] }[] = [
  { label: 'Normal', items: [0, 1, 2] },
  { label: 'Large', items: [3, 4, 5] },
  { label: 'Wallpaper', items: [6, 7] },
  { label: 'Small', items: [8, 9, 10] }
]

function builtinOption(i: number): ResolutionOption {
  const r = RESOLUTIONS[i]
  return { key: sizeKey(r.width, r.height), text: `${r.label} (${sizeText(r.width, r.height)})`, width: r.width, height: r.height, builtin: true }
}

/** 기본 해상도 (묶음 순서대로) */
export const BUILTIN_RESOLUTIONS: readonly (ResolutionOption & { name: string; group: string })[] = BUILTIN_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ ...builtinOption(i), name: RESOLUTIONS[i].label, group: g.label }))
)

const BUILTIN_KEYS = new Set(BUILTIN_RESOLUTIONS.map((r) => r.key))

export function userResolutionText(r: UserResolution): string {
  return r.name ? `${r.name} (${sizeText(r.width, r.height)})` : sizeText(r.width, r.height)
}

/** 목록에 넣을 수 없는 크기면 그 이유 (NovelAI 규칙: 64의 배수, 64 이상, 총 3,145,728픽셀 이하) */
export function sizeProblem(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return '너비와 높이를 숫자로 넣으세요'
  if (width < NAI_MIN_RESOLUTION || height < NAI_MIN_RESOLUTION) return `너비와 높이는 ${NAI_MIN_RESOLUTION} 이상이어야 합니다`
  if (width % NAI_RESOLUTION_STEP || height % NAI_RESOLUTION_STEP) return `너비와 높이는 ${NAI_RESOLUTION_STEP}의 배수여야 합니다`
  if (width * height > NAI_MAX_GENERATION_PIXELS) return `너무 큽니다 (최대 ${NAI_MAX_GENERATION_PIXELS.toLocaleString()}픽셀)`
  return null
}

/** 이름 다듬기 — 앞뒤 공백·줄바꿈을 빼고 길이를 자른다. 비면 undefined */
export function cleanResolutionName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  const s = name.replace(/\s+/g, ' ').trim().slice(0, RESOLUTION_NAME_MAX).trim()
  return s || undefined
}

/**
 * 저장된 값(예전 버전·백업·손상된 값) → 쓸 수 있는 내 해상도 목록.
 * 목록이 아니면 빈 목록, 쓸 수 없는 크기·객체가 아닌 항목·같은 크기의 두 번째 항목은 뺀다 (앱에서 더할 때 이미 막는 값들이다)
 */
export function normalizeUserResolutions(raw: unknown): UserResolution[] {
  if (!Array.isArray(raw)) return []
  const out: UserResolution[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const r = x as Record<string, unknown>
    const width = r.width
    const height = r.height
    if (typeof width !== 'number' || typeof height !== 'number' || sizeProblem(width, height)) continue
    if (seen.has(sizeKey(width, height))) continue
    seen.add(sizeKey(width, height))
    const name = cleanResolutionName(r.name)
    out.push(name ? { name, width, height } : { width, height })
    if (out.length >= MAX_USER_RESOLUTIONS) break
  }
  return out
}

/** 숨긴 기본 해상도 — 아는 키만, 한 번씩 */
export function normalizeHiddenResolutions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((k): k is string => typeof k === 'string' && BUILTIN_KEYS.has(k)))]
}

function groupsOf(prefs: ResolutionPrefs): ResolutionGroup[] {
  const hidden = new Set(prefs.hiddenResolutions)
  const groups: ResolutionGroup[] = []
  for (const g of BUILTIN_GROUPS) {
    const items = g.items.map(builtinOption).filter((o) => !hidden.has(o.key))
    if (items.length) groups.push({ label: g.label, items })
  }
  // 기본 해상도와 같은 크기의 내 해상도(앞으로 기본 목록이 늘어날 때 생길 수 있다)는 보이는 기본 것과 겹치지 않게 한 번만
  const seen = new Set(groups.flatMap((g) => g.items.map((o) => o.key)))
  const mine: ResolutionOption[] = []
  for (const r of prefs.resolutions) {
    const key = sizeKey(r.width, r.height)
    if (seen.has(key)) continue
    seen.add(key)
    mine.push({ key, text: userResolutionText(r), width: r.width, height: r.height, builtin: false })
  }
  if (mine.length) groups.push({ label: USER_GROUP_LABEL, items: mine })
  return groups
}

/**
 * 고르는 칸에 보일 묶음: 숨기지 않은 기본 해상도(Normal·Large·Wallpaper·Small) + "내 해상도".
 * 어떤 값이 들어와도 비지 않는다 — 보일 것이 하나도 없으면 기본 해상도를 모두 보인다
 */
export function resolutionGroups(prefs: ResolutionPrefs): ResolutionGroup[] {
  const groups = groupsOf(prefs)
  return groups.length ? groups : groupsOf({ resolutions: [], hiddenResolutions: [] })
}

export function findResolution(groups: ResolutionGroup[], width: number, height: number): ResolutionOption | undefined {
  const key = sizeKey(width, height)
  for (const g of groups) for (const o of g.items) if (o.key === key) return o
  return undefined
}

/** 지금 목록(보이는 것)에 있는 크기인지 */
export function isListedSize(prefs: ResolutionPrefs, width: number, height: number): boolean {
  return !!findResolution(resolutionGroups(prefs), width, height)
}

/** 보이는 항목 수 (빈 목록일 때 기본 해상도를 모두 보이는 대비책은 빼고 센다) */
function visibleCount(prefs: ResolutionPrefs): number {
  return groupsOf(prefs).reduce((n, g) => n + g.items.length, 0)
}

/** 목록이 비지 않게 — 보이는 기본 해상도도 내 해상도도 없으면 숨김을 모두 푼다 */
export function normalizeResolutionPrefs(p: { resolutions?: unknown; hiddenResolutions?: unknown }): ResolutionPrefs {
  const prefs = { resolutions: normalizeUserResolutions(p.resolutions), hiddenResolutions: normalizeHiddenResolutions(p.hiddenResolutions) }
  return visibleCount(prefs) ? prefs : { ...prefs, hiddenResolutions: [] }
}

export type ResolutionEdit = ({ ok: true; notice?: string } & ResolutionPrefs) | { ok: false; error: string }

const EMPTY_ERROR = '목록에 해상도가 하나는 있어야 합니다'

/**
 * 내 해상도 더하기 (맨 끝에). 숨겨 둔 기본 해상도와 같은 크기면 그 기본 해상도를 다시 보이게 한다.
 * 보이는 기본 해상도나 내 해상도에 같은 크기가 있으면 더하지 않는다
 */
export function addUserResolution(prefs: ResolutionPrefs, entry: UserResolution): ResolutionEdit {
  const problem = sizeProblem(entry.width, entry.height)
  if (problem) return { ok: false, error: problem }
  const key = sizeKey(entry.width, entry.height)
  const builtin = BUILTIN_RESOLUTIONS.find((r) => r.key === key)
  if (builtin) {
    if (prefs.hiddenResolutions.includes(key)) {
      return {
        ok: true,
        resolutions: prefs.resolutions,
        hiddenResolutions: prefs.hiddenResolutions.filter((k) => k !== key),
        notice: `숨겨 둔 기본 해상도 "${builtin.name}"을(를) 다시 보이게 했습니다`
      }
    }
    return { ok: false, error: `기본 해상도 "${builtin.name}"와(과) 같은 크기입니다` }
  }
  const same = prefs.resolutions.find((r) => sizeKey(r.width, r.height) === key)
  if (same) return { ok: false, error: `이미 목록에 있습니다: ${userResolutionText(same)}` }
  if (prefs.resolutions.length >= MAX_USER_RESOLUTIONS) return { ok: false, error: `내 해상도는 ${MAX_USER_RESOLUTIONS}개까지 넣을 수 있습니다` }
  const name = cleanResolutionName(entry.name)
  const item: UserResolution = name ? { name, width: entry.width, height: entry.height } : { width: entry.width, height: entry.height }
  return { ok: true, resolutions: [...prefs.resolutions, item], hiddenResolutions: prefs.hiddenResolutions }
}

/** 내 해상도 지우기 — 지우면 목록이 비는 경우는 막는다 */
export function removeUserResolution(prefs: ResolutionPrefs, index: number): ResolutionEdit {
  if (index < 0 || index >= prefs.resolutions.length) return { ok: false, error: '없는 항목입니다' }
  const next = { ...prefs, resolutions: prefs.resolutions.filter((_, i) => i !== index) }
  if (!visibleCount(next)) return { ok: false, error: EMPTY_ERROR }
  return { ok: true, ...next }
}

/** 내 해상도 순서 바꾸기 (delta = -1 위로, +1 아래로). 끝에서 더 못 가면 그대로 */
export function moveUserResolution(prefs: ResolutionPrefs, index: number, delta: number): ResolutionEdit {
  const to = index + delta
  if (index < 0 || index >= prefs.resolutions.length || to < 0 || to >= prefs.resolutions.length) return { ok: true, ...prefs }
  const list = [...prefs.resolutions]
  const [item] = list.splice(index, 1)
  list.splice(to, 0, item)
  return { ok: true, resolutions: list, hiddenResolutions: prefs.hiddenResolutions }
}

/** 기본 해상도 숨기기·다시 보이기 — 숨기면 목록이 비는 경우는 막는다 */
export function setBuiltinHidden(prefs: ResolutionPrefs, key: string, hidden: boolean): ResolutionEdit {
  if (!BUILTIN_KEYS.has(key)) return { ok: false, error: '기본 해상도가 아닙니다' }
  const rest = prefs.hiddenResolutions.filter((k) => k !== key)
  const next = { ...prefs, hiddenResolutions: hidden ? [...rest, key] : rest }
  if (hidden && !visibleCount(next)) return { ok: false, error: EMPTY_ERROR }
  return { ok: true, ...next }
}
