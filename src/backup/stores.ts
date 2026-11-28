/**
 * 지금 스토어 ↔ BackupData 어댑터. 스토어 필드를 이름으로 고르지 않고 "함수가 아닌 상태"를
 * 통째로 담으므로, Phase 2 처럼 캐릭터 스토어에 필드가 늘어도 그대로 백업·복원된다.
 * 히스토리는 여기서 다루지 않는다 — Phase 3 저장소 위의 포트는 ports.ts.
 *
 * Phase 4 UI 에서 더한 것:
 * - 에셋 프로젝트(useProjects, localStorage naip-projects)를 불투명한 섹션으로 담고 되살린다.
 * - 바이브·레퍼런스·마스크 스토어는 IndexedDB 에서 비동기로 살아나므로 모으기 전에 기다린다(waitHydrated).
 * - 들어오는 데이터는 normalizeBackupData 를 거친다: 캐릭터는 Phase 2 의 migrateCharacters 로
 *   (예전 prompt 한 칸·cast 목록 → 3분할·고정 슬롯), 설정에서는 실행 중에만 쓰는 값을 뺀다.
 * - 스토어에 넣을 때 그 스토어의 함수(동작) 이름과 겹치는 키는 버린다 (조작된 백업이 앱을 깨지 않게).
 * - 목록(배열)·맵이어야 할 값이 그 모양이 아니거나 섹션의 주 목록이 없으면 섹션째 넣지 않고 알린다
 *   (sectionShapeProblem — 열 때 withoutInvalidSections 로 빼고, applyRestorePlan 도 한 번 더 본다).
 * - 목록 안의 쓸 수 없는 항목(객체여야 할 자리의 null·숫자·문자열 등)은 섹션째 버리지 않고 그 항목만 뺀다
 *   (withoutJunkItems — 열 때 뺀 수를 알리고, applyRestorePlan 도 한 번 더 뺀다).
 *   안쪽 목록(출연 슬롯 후보·예전 cast·폴더, 프로젝트 조합 항목)의 그런 항목은 migrateCharacters·normalizeProject 가
 *   읽으면서 뺀다 — 백업을 열거나 적용하다 멈추지 않게 (따로 세어 알리지는 않는다).
 */
import * as projectModel from '../project/model'
import { useProjects } from '../project/store'
import type { Project } from '../project/types'
import { migrateCharacters, replaceCharacters, useCharacters } from '../stores/characters'
import { useFragments } from '../stores/fragments'
import { masksLoadFailed, useMasks } from '../stores/masks'
import { usePrompt } from '../stores/prompt'
import { refsLoadFailed, useRefs } from '../stores/refs'
import { useScenes } from '../stores/scenes'
import { useSettings } from '../stores/settings'
import { useTagUsage } from '../stores/tagUsage'
import { stripCredentials } from './credentials'
import { splitSettings, UNSAVED_SETTINGS } from './format'
import { RESTORE_SCHEMA, type RestorePlan } from './plan'
import { DATA_SECTION_IDS, SECTION_LABELS, type BackupData, type BackupItem, type DataSectionId } from './types'

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 함수와 빼라는 키를 뺀 상태 */
function dataOf(state: object, omit: readonly string[] = []): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'function' || omit.includes(k)) continue
    out[k] = v
  }
  return out
}

/** 스토어의 동작(함수) 이름과 겹치는 키를 뺀다 — setState 로 함수를 덮어쓰면 앱이 깨진다 */
function safePatch(state: object, patch: Obj): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(patch)) {
    if (typeof (state as Obj)[k] === 'function') continue
    out[k] = v
  }
  return out
}

export interface HydrationStatus {
  /** 기다려도 아직 불러오는 중인 섹션 */
  pending: DataSectionId[]
  /**
   * 이번 실행에서 불러오지 못한 섹션 (IndexedDB 열기 실패·손상된 값) — 스토어가 빈 채라 그 내용을
   * 지금 데이터로 볼 수 없다. 기다려도 바뀌지 않는다 (앱을 다시 시작하면 다시 불러 본다)
   */
  failed: DataSectionId[]
}

/** 바이브·레퍼런스·마스크(IndexedDB)가 살아나거나 불러오기에 실패할 때까지 기다린다 (최대 timeoutMs) */
export async function waitHydrated(timeoutMs = 5000): Promise<HydrationStatus> {
  const masksDone = (): boolean => (useMasks.persist?.hasHydrated?.() ?? true) || masksLoadFailed()
  const wait = (ready: () => boolean, subscribe: (fn: () => void) => () => void): Promise<void> =>
    ready()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timer = setTimeout(done, timeoutMs)
          // zustand 는 불러오기 실패를 알려 주지 않는다 (onFinishHydration 은 성공 때만) — 실패는 짧게 들여다본다
          const poll = setInterval(() => ready() && done(), 100)
          const off = subscribe(() => ready() && done())
          function done(): void {
            clearTimeout(timer)
            clearInterval(poll)
            off()
            resolve()
          }
        })
  await Promise.all([
    wait(
      () => useRefs.getState().hydrated,
      (fn) => useRefs.subscribe(fn)
    ),
    wait(masksDone, (fn) => useMasks.persist?.onFinishHydration?.(fn) ?? (() => {}))
  ])
  const status: HydrationStatus = { pending: [], failed: [] }
  if (!useRefs.getState().hydrated) status.pending.push('vibes', 'charRefs')
  else if (refsLoadFailed()) status.failed.push('vibes', 'charRefs')
  if (!masksDone()) status.pending.push('masks')
  else if (masksLoadFailed()) status.failed.push('masks')
  return status
}

export function collectStoreData(): BackupData {
  const { presets, ...prompt } = dataOf(usePrompt.getState())
  // 토큰은 백업 쓰기에서도 지우지만, 여기서부터 아예 넣지 않는다
  const { settings, saveFolders } = splitSettings(stripCredentials(dataOf(useSettings.getState())).value)
  const refs = useRefs.getState()
  return {
    settings,
    saveFolders,
    prompt,
    presets: { presets: (presets as BackupItem[]) ?? [] },
    // 되돌리기 세대(cursorEpoch)는 이 기기에서 도는 배치를 위한 것이라 백업에 넣지 않는다
    characters: dataOf(useCharacters.getState(), ['cursorEpoch']),
    scenes: dataOf(useScenes.getState()),
    fragments: dataOf(useFragments.getState()),
    vibes: { vibes: refs.vibes as unknown as BackupItem[] },
    charRefs: { charRefs: refs.charRefs as unknown as BackupItem[] },
    tagUsage: dataOf(useTagUsage.getState()) as BackupData['tagUsage'],
    masks: dataOf(useMasks.getState()) as BackupData['masks'],
    // ── Phase 4 UI: 에셋 프로젝트 (불투명 — projects·activeId·presets 와 앞으로 늘어날 필드)
    projects: dataOf(useProjects.getState()) as BackupData['projects']
  }
}

// ── 들어오는 데이터 다듬기 ──────────────────────────────────────────────

const CHARACTER_KEYS = ['folders', 'characters', 'slots', 'options', 'cursors']

/**
 * 캐릭터 섹션을 지금 형식(Phase 2)으로 — migrateCharacters 를 거친다(잃는 내용 없음):
 * 예전 prompt 한 칸 → 고정(base), 예전 출연 목록 cast → 같은 순서의 고정 슬롯.
 * 캐릭터와 섹션에 있던 모르는 필드(더 새로운 앱이 더한 것)는 그대로 둔다. version·cast 는 뺀다.
 * 배치에 한 번 순차의 순서 자리(cursors)는 백업에 있을 때만 넣는다 — 없는 예전 백업은 지금 자리를 건드리지 않는다.
 * 되돌리기 세대(cursorEpoch)는 이 기기의 것이라 들어와도 뺀다
 */
export function normalizeCharactersSection(raw: unknown): Obj {
  const r = isObj(raw) ? raw : {}
  const m = migrateCharacters(r)
  const rawById = new Map<unknown, Obj>()
  if (Array.isArray(r.characters)) for (const c of r.characters) if (isObj(c)) rawById.set(c.id, c)
  const characters = m.characters.map((c) => {
    const src = rawById.get(c.id)
    if (!src) return c
    const extra: Obj = {}
    for (const [k, v] of Object.entries(src)) if (!(k in c) && k !== 'prompt' && v !== undefined) extra[k] = v
    return { ...extra, ...c }
  })
  const rest: Obj = {}
  for (const [k, v] of Object.entries(r)) if (![...CHARACTER_KEYS, 'cast', 'version', 'cursorEpoch'].includes(k)) rest[k] = v
  return { ...rest, folders: m.folders, characters, slots: m.slots, options: m.options, ...(m.cursors ? { cursors: m.cursors } : {}) }
}

/** 프로젝트 섹션 — 문자열 id 가 있는 객체만 남긴다 (나머지 모양은 스토어의 normalizeProject 가 채운다) */
function normalizeProjectsSection(raw: unknown): Obj {
  const r = isObj(raw) ? raw : {}
  const keep = (list: unknown): Obj[] =>
    Array.isArray(list) ? list.filter((p): p is Obj => isObj(p) && typeof p.id === 'string' && p.id !== '') : []
  return {
    ...r,
    projects: keep(r.projects),
    ...(Array.isArray(r.presets) ? { presets: keep(r.presets) } : {}),
    activeId: typeof r.activeId === 'string' ? r.activeId : null
  }
}

/** 실행 중 상태(구독 정보 등)와 이 기기에서만 정하는 설정(업데이트 받을 저장소)을 뺀다 */
function withoutTransient(v: unknown): Obj {
  const out: Obj = { ...(isObj(v) ? v : {}) }
  for (const k of UNSAVED_SETTINGS) delete out[k]
  return out
}

/**
 * 백업·.nais·예전 JSON 에서 읽은 데이터를 복원 계획 전에 다듬는다 (어느 형식에서 왔든 같은 길).
 * 계획(planRestore)이 Phase 2 슬롯의 캐릭터 id 를 고치려면 캐릭터가 먼저 지금 형식이어야 한다.
 */
export function normalizeBackupData(data: BackupData): BackupData {
  const out: BackupData = { ...data }
  if (data.characters != null) out.characters = normalizeCharactersSection(data.characters) as BackupData['characters']
  if (data.projects != null) out.projects = normalizeProjectsSection(data.projects) as BackupData['projects']
  if (data.settings != null) out.settings = withoutTransient(stripCredentials(data.settings).value)
  if (data.saveFolders != null) out.saveFolders = stripCredentials(data.saveFolders).value
  return out
}

// ── 섹션 모양 ──────────────────────────────────────────────────────────

/**
 * 같은 스토어에 들어가는 다른 섹션 — 그 섹션의 목록·맵 키가 섞여 들어와도 모양을 본다
 * (설정은 저장 폴더와 같은 useSettings, 작업 중인 프롬프트는 프리셋과 같은 usePrompt 에 들어간다)
 */
const SHARES_STORE_WITH: Partial<Record<DataSectionId, DataSectionId>> = { settings: 'saveFolders', prompt: 'presets' }

/**
 * 섹션이 스토어에 넣을 수 있는 모양인지. 아니면 그 이유(사용자에게 보일 문장), 맞으면 null.
 * - 섹션은 객체여야 한다.
 * - RESTORE_SCHEMA 의 목록(collections·addMissing·lists)은 배열, 맵은 객체여야 한다 (있을 때).
 * - 섹션 이름과 같은 주 목록(presets.presets, vibes.vibes, characters.characters …)은 빠져도 안 된다 —
 *   덮어쓰기가 그 값을 undefined 로 넣거나 "없음"을 "비움"으로 다루지 않게. 이 앱·예전 JSON·NAIS3 변환은 늘 넣는다.
 */
export function sectionShapeProblem(id: DataSectionId, value: unknown): string | null {
  const label = SECTION_LABELS[id]
  const why = (text: string): string => `${label}: ${text} — 이 항목은 복원하지 않습니다`
  if (!isObj(value)) return why('형식이 잘못됐습니다')
  const shared = SHARES_STORE_WITH[id]
  for (const schema of [RESTORE_SCHEMA.sections[id], ...(shared ? [RESTORE_SCHEMA.sections[shared]] : [])]) {
    const lists = [...(schema.collections ?? []), ...(schema.addMissing ?? [])].map((c) => c.key).concat(schema.lists ?? [])
    for (const key of lists) {
      const v = value[key]
      if (v === undefined) {
        if (key === id) return why(`${key} 목록이 없습니다`)
      } else if (!Array.isArray(v)) {
        return why(`${key} 이(가) 목록이 아닙니다`)
      }
    }
    for (const { key } of schema.maps ?? []) {
      if (value[key] !== undefined && !isObj(value[key])) return why(`${key} 모양이 잘못됐습니다`)
    }
  }
  return null
}

/**
 * 섹션 목록에서 쓸 수 없는 항목을 뺀다 — 컬렉션(프리셋·캐릭터·폴더·바이브·마스크·프로젝트 …)의 객체가 아닌 항목,
 * 문자열 목록(저장 폴더)의 문자열이 아닌 항목. 같은 스토어에 들어가는 다른 섹션의 목록도 본다. 뺀 항목 수도 돌려준다
 */
function junkFree(id: DataSectionId, value: Obj): { value: Obj; dropped: number } {
  let out = value
  let dropped = 0
  const keep = (key: string, ok: (x: unknown) => boolean): void => {
    const list = out[key]
    if (!Array.isArray(list)) return
    const kept = list.filter(ok)
    if (kept.length === list.length) return
    dropped += list.length - kept.length
    out = { ...out, [key]: kept }
  }
  const shared = SHARES_STORE_WITH[id]
  for (const schema of [RESTORE_SCHEMA.sections[id], ...(shared ? [RESTORE_SCHEMA.sections[shared]] : [])]) {
    for (const { key } of [...(schema.collections ?? []), ...(schema.addMissing ?? [])]) keep(key, isObj)
    for (const key of schema.lists ?? []) keep(key, (x) => typeof x === 'string')
  }
  return { value: out, dropped }
}

/**
 * 목록 안의 쓸 수 없는 항목(손상·조작된 백업의 null·숫자·문자열)을 뺀 데이터와, 섹션마다 뺀 수·알릴 문장.
 * 섹션째 버리지 않는다 — 나머지 항목은 그대로 복원한다 (모양이 잘못된 섹션은 withoutInvalidSections 가 먼저 뺀다)
 */
export function withoutJunkItems(data: BackupData): { data: BackupData; dropped: { section: DataSectionId; count: number; detail: string }[] } {
  const out: BackupData = { ...data }
  const dropped: { section: DataSectionId; count: number; detail: string }[] = []
  for (const id of DATA_SECTION_IDS) {
    const value = out[id]
    if (!isObj(value)) continue
    const r = junkFree(id, value)
    if (!r.dropped) continue
    ;(out as Record<DataSectionId, unknown>)[id] = r.value
    dropped.push({ section: id, count: r.dropped, detail: `${SECTION_LABELS[id]}: 형식이 잘못된 항목 ${r.dropped}개는 빼고 복원합니다` })
  }
  return { data: out, dropped }
}

/** 모양이 잘못된 섹션을 뺀 데이터와 뺀 섹션·이유 (백업을 열 때 — 미리보기·계획에 나오지 않게) */
export function withoutInvalidSections(data: BackupData): { data: BackupData; invalid: { section: DataSectionId; detail: string }[] } {
  const out: BackupData = { ...data }
  const invalid: { section: DataSectionId; detail: string }[] = []
  for (const id of DATA_SECTION_IDS) {
    if (out[id] == null) continue
    const detail = sectionShapeProblem(id, out[id])
    if (!detail) continue
    delete out[id]
    invalid.push({ section: id, detail })
  }
  return { data: out, invalid }
}

// ── 스토어에 넣기 ──────────────────────────────────────────────────────

function applyProjects(r: Obj): void {
  const projects = (Array.isArray(r.projects) ? r.projects : [])
    .filter((p): p is Obj => isObj(p) && typeof p.id === 'string')
    // 스토어가 앱을 열 때 하는 것과 같게: 빠진 칸 채우기 + 대기·생성 중 장수 0 (대기열은 백업하지 않는다)
    .map((p) => projectModel.resetRuntime(projectModel.normalizeProject({ ...(p as unknown as Project), name: typeof p.name === 'string' ? p.name : '프로젝트' })))
  const activeId = typeof r.activeId === 'string' && projects.some((p) => p.id === r.activeId) ? r.activeId : null
  const state = useProjects.getState()
  useProjects.setState(safePatch(state, { ...r, projects, activeId }) as never)
}

export interface ApplyRestoreResult {
  /** 스토어에 넣은 섹션 */
  applied: DataSectionId[]
  /** 모양이 잘못돼 넣지 않은 섹션과 이유 — 그 스토어는 그대로 둔다 */
  invalid: { section: DataSectionId; detail: string }[]
}

/** 복원 계획의 섹션 결과를 스토어에 넣는다 (부분 setState — 결과에 없는 키는 그대로) */
export function applyRestorePlan(plan: RestorePlan): ApplyRestoreResult {
  const applied: DataSectionId[] = []
  const invalid: ApplyRestoreResult['invalid'] = []
  for (const [id, section] of Object.entries(plan.sections) as [DataSectionId, NonNullable<RestorePlan['sections'][DataSectionId]>][]) {
    // 목록이 없거나 목록이 아닌 섹션은 넣지 않는다 — 스토어를 비우거나 undefined 를 넣지 않게
    const detail = sectionShapeProblem(id, section.result)
    if (detail) {
      invalid.push({ section: id, detail })
      continue
    }
    // 목록 안의 쓸 수 없는 항목은 빼고 넣는다 (열 때 이미 빼고 알렸다 — 여기서는 한 번 더)
    const r = junkFree(id, section.result).value
    switch (id) {
      case 'settings':
      case 'saveFolders':
        // 토큰·비밀값은 백업에서 오지 않는다 (읽을 때 이미 지웠지만 한 번 더). 실행 중 상태(구독 정보 등)와
        // 업데이트 받을 저장소도 넣지 않는다 (남이 만든 백업이 다른 APK를 설치하게 권하지 못하게)
        useSettings.setState(safePatch(useSettings.getState(), withoutTransient(stripCredentials(r).value)) as never)
        break
      case 'prompt':
        usePrompt.setState(safePatch(usePrompt.getState(), r) as never)
        break
      case 'presets':
        usePrompt.setState({ presets: r.presets as never })
        break
      case 'characters':
        // 계획의 결과도 한 번 더 지금 형식으로 (모르는 키·깨진 항목이 스토어에 들어가지 않게)
        // 순서 자리가 바뀌면 지금 도는 배치가 그 자리를 넘기지 않는다 (replaceCharacters)
        replaceCharacters(safePatch(useCharacters.getState(), normalizeCharactersSection(r)))
        break
      case 'scenes':
        useScenes.setState(safePatch(useScenes.getState(), r) as never)
        break
      case 'fragments':
        useFragments.setState(safePatch(useFragments.getState(), r) as never)
        break
      case 'vibes':
        useRefs.setState({ vibes: r.vibes as never })
        break
      case 'charRefs':
        useRefs.setState({ charRefs: r.charRefs as never })
        break
      case 'tagUsage':
        useTagUsage.setState(safePatch(useTagUsage.getState(), r) as never)
        break
      case 'masks':
        useMasks.setState(safePatch(useMasks.getState(), r) as never)
        break
      case 'projects':
        applyProjects(r)
        break
      default:
        // collections·exportTemplates: 아직 스토어가 없다
        continue
    }
    applied.push(id)
  }
  return { applied, invalid }
}
