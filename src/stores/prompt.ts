import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { UcPresetIndex } from '../nai/types'
import { generationDefaultsForModel, isV5Model } from '../nai/models'
import { uid } from '../lib/util'

export interface Params {
  model: string
  width: number
  height: number
  steps: number
  cfgScale: number
  cfgRescale: number
  sampler: string
  noiseSchedule: string
  variety: boolean
  qualityToggle: boolean
  ucPreset: UcPresetIndex
  /** V5 배경 투명 (straight_alpha) — 이 칸이 생기기 전에 저장한 설정·프리셋에는 없다 (없으면 끔) */
  transparentBackground?: boolean
}

export interface PromptPreset {
  id: number
  name: string
  base: string
  detail: string
  negative: string
  params: Params
}

/** 프리셋을 옮길 때 저장하지 않은 내용을 어떻게 할지 */
export type PresetSwitchMode = 'ask' | 'saveNew' | 'saveActive'

export const PRESET_SWITCH_MODES: readonly { value: PresetSwitchMode; label: string }[] = [
  { value: 'ask', label: '물어보기' },
  { value: 'saveNew', label: '자동으로 새 프리셋에 저장' },
  { value: 'saveActive', label: '지금 프리셋에 자동 저장' }
]

/** 옮기기 전에 저장하지 않은 내용을 어떻게 할지 — 새 프리셋은 이름을 함께 준다 */
export type PresetSwitchChoice = 'discard' | 'saveActive' | { saveNew: string }

export interface PresetSwitchResult {
  /** 저장한 프리셋 이름 (저장하지 않았으면 null) */
  savedTo: string | null
  savedAsNew: boolean
  /** 옮기면서 화면의 내용이 바뀌었고, 바뀌기 전 것을 되돌릴 수 있다 */
  undoable: boolean
}

interface PromptState {
  /** 고정 / 가변 / 디테일 3분할 — 전송 시 ", "로 병합 */
  base: string
  additional: string
  detail: string
  negative: string
  params: Params
  /** 빈 문자열 = 매 장 무작위 */
  seed: string
  count: number
  presets: PromptPreset[]
  activePresetId: number | null
  /** 프리셋을 옮길 때 저장하지 않은 내용 — 물어보기(기본) / 새 프리셋에 자동 저장 / 지금 프리셋에 자동 저장 */
  presetSwitch: PresetSwitchMode
  set: (p: Partial<Pick<PromptState, 'base' | 'additional' | 'detail' | 'negative' | 'seed' | 'count'>>) => void
  patchParams: (p: Partial<Params>) => void
  setModel: (model: string) => void
  savePreset: (name: string) => void
  overwritePreset: (id: number) => void
  applyPreset: (id: number) => void
  /**
   * 다른 프리셋으로 옮긴다. 저장하지 않은 내용이 있으면 choice대로 먼저 저장하고, 바뀌기 전 내용을
   * 되돌리기용으로 잡아 둔다 (usePromptUndo). 없는 프리셋이면 null
   */
  switchPreset: (id: number, choice: PresetSwitchChoice) => PresetSwitchResult | null
  setPresetSwitch: (mode: PresetSwitchMode) => void
  renamePreset: (id: number, name: string) => void
  duplicatePreset: (id: number) => void
  deletePreset: (id: number) => void
}

const DEFAULT_PARAMS: Params = {
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  variety: false,
  qualityToggle: true,
  ucPreset: 0,
  transparentBackground: false
}

/** 저장된 params에 빠진 칸(예전 버전에서 저장한 것)을 기본값으로 채운다 */
export function withParamDefaults(params: Partial<Params> | null | undefined): Params {
  return { ...DEFAULT_PARAMS, ...(params && typeof params === 'object' ? params : {}) }
}

export const usePrompt = create<PromptState>()(
  persist(
    (set, get) => ({
      base: '',
      additional: '',
      detail: '',
      negative: '',
      params: DEFAULT_PARAMS,
      seed: '',
      count: 1,
      presets: [],
      activePresetId: null,
      presetSwitch: 'ask',
      set: (p) => set(p),
      patchParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      setModel: (model) =>
        set((s) => {
          // V4.5 ↔ V5 계열을 넘나들 때만 기본 steps/CFG로 맞춘다
          const crossed = isV5Model(model) !== isV5Model(s.params.model)
          const d = generationDefaultsForModel(model)
          return {
            params: {
              ...s.params,
              model,
              ...(crossed ? { steps: d.steps, cfgScale: d.cfgScale, sampler: d.sampler } : {})
            }
          }
        }),
      savePreset: (name) => {
        const s = get()
        const preset: PromptPreset = {
          id: uid(),
          name: name.trim() || '새 프리셋',
          base: s.base,
          detail: s.detail,
          negative: s.negative,
          params: s.params
        }
        set({ presets: [...s.presets, preset], activePresetId: preset.id })
      },
      overwritePreset: (id) =>
        set((s) => ({
          presets: s.presets.map((p) =>
            p.id === id
              ? { ...p, base: s.base, detail: s.detail, negative: s.negative, params: s.params }
              : p
          )
        })),
      applyPreset: (id) => {
        const p = get().presets.find((x) => x.id === id)
        if (!p) return
        set({
          base: p.base,
          detail: p.detail,
          negative: p.negative,
          params: { ...DEFAULT_PARAMS, ...p.params },
          activePresetId: id
        })
      },
      switchPreset: (id, choice) => {
        if (!get().presets.some((x) => x.id === id)) return null
        const unsaved = hasUnsavedPrompt(get())
        let savedTo: string | null = null
        let savedAsNew = false
        if (unsaved && choice !== 'discard') {
          const active = get().presets.find((x) => x.id === get().activePresetId)
          if (choice === 'saveActive' && active) {
            get().overwritePreset(active.id)
            savedTo = active.name
          } else {
            const name =
              typeof choice === 'object' && choice.saveNew.trim()
                ? choice.saveNew
                : autoPresetName(new Date(), get().presets.map((x) => x.name))
            get().savePreset(name)
            savedTo = get().presets.find((x) => x.id === get().activePresetId)?.name ?? name
            savedAsNew = true
          }
        }
        // 저장한 뒤의 상태를 잡는다 — 되돌리면 방금 저장한 프리셋을 고른 상태로 돌아간다
        const before = snapshotOf(get())
        get().applyPreset(id)
        const undoable = unsaved && !sameSnapshot(before, snapshotOf(get()))
        if (undoable) rememberForUndo(before)
        return { savedTo, savedAsNew, undoable }
      },
      setPresetSwitch: (mode) => set({ presetSwitch: presetSwitchMode(mode) }),
      renamePreset: (id, name) =>
        set((s) => ({
          presets: s.presets.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p))
        })),
      duplicatePreset: (id) =>
        set((s) => {
          const i = s.presets.findIndex((p) => p.id === id)
          if (i < 0) return s
          const copy = { ...s.presets[i], id: uid(), name: `${s.presets[i].name} 복사` }
          return { presets: [...s.presets.slice(0, i + 1), copy, ...s.presets.slice(i + 1)] }
        }),
      deletePreset: (id) =>
        set((s) => ({
          presets: s.presets.filter((p) => p.id !== id),
          activePresetId: s.activePresetId === id ? null : s.activePresetId
        }))
    }),
    {
      name: 'naip-prompt',
      // 예전에 저장한 params에는 새 칸(배경 투명 등)이 없다 — 기본값으로 채워 읽는다
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PromptState>
        return { ...current, ...p, params: withParamDefaults(p.params) }
      }
    }
  )
)

// ── 저장하지 않은 내용 · 되돌리기 ──────────────────────────────────────

type WorkState = Pick<PromptState, 'base' | 'detail' | 'negative' | 'params' | 'presets' | 'activePresetId'>

/** 프리셋에 들어가는 칸 중 지금 프리셋과 다른 것 */
export type UnsavedPart = 'base' | 'detail' | 'negative' | 'params'

export const UNSAVED_PART_LABEL: Record<UnsavedPart, string> = {
  base: '고정',
  detail: '디테일',
  negative: '네거티브',
  params: '생성 설정'
}

/** 비교용 — 줄바꿈 형식과 앞뒤 공백만 다른 것은 같은 내용으로 본다 */
function normText(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : ''
}

/** 없음·꺼짐·빈 값은 같은 것으로 본다 (나중에 생긴 설정 칸이 예전 프리셋에 없어도 바뀐 것으로 치지 않게) */
function blank(v: unknown): boolean {
  return v === undefined || v === null || v === false || v === ''
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b || (blank(a) && blank(b))) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (!sameValue(x[k], y[k])) return false
  return true
}

function withDefaults(p: Partial<Params> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...DEFAULT_PARAMS }
  for (const [k, v] of Object.entries(p ?? {})) if (v !== undefined) out[k] = v
  return out
}

/** 생성 설정이 같은지 (프리셋을 불러올 때처럼 빠진 칸은 기본값으로 채워 비교) */
export function sameParams(a: Partial<Params> | undefined, b: Partial<Params> | undefined): boolean {
  return sameValue(withDefaults(a), withDefaults(b))
}

/**
 * 프리셋에 저장되지 않은 칸. 고른 프리셋이 있으면 그 프리셋과 다른 칸(고정·디테일·네거티브·생성 설정),
 * 없으면 내용이 있는 프롬프트 칸. 가변은 프리셋에 들어가지 않으므로 보지 않는다
 */
export function unsavedParts(s: WorkState): UnsavedPart[] {
  const presets = Array.isArray(s.presets) ? s.presets : []
  const active = presets.find((p) => p.id === s.activePresetId)
  const texts = ['base', 'detail', 'negative'] as const
  if (!active) return texts.filter((k) => normText(s[k]) !== '')
  const out: UnsavedPart[] = texts.filter((k) => normText(s[k]) !== normText(active[k]))
  if (!sameParams(s.params, active.params)) out.push('params')
  return out
}

export function hasUnsavedPrompt(s: WorkState): boolean {
  return unsavedParts(s).length > 0
}

export function presetSwitchMode(v: unknown): PresetSwitchMode {
  return v === 'saveNew' || v === 'saveActive' ? v : 'ask'
}

/** 자동으로 저장하는 새 프리셋 이름 ("자동 저장 11-28 14:05", 겹치면 뒤에 번호) */
export function autoPresetName(now: Date, taken: readonly string[] = []): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const name = `자동 저장 ${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`
  if (!taken.includes(name)) return name
  for (let i = 2; ; i++) if (!taken.includes(`${name} (${i})`)) return `${name} (${i})`
}

/** 설정대로 묻지 않고 고를 것 (물어보기면 null). 지금 프리셋이 없으면 새 프리셋에 저장한다 */
export function autoSwitchChoice(
  s: WorkState & { presetSwitch?: unknown },
  now: Date = new Date()
): PresetSwitchChoice | null {
  const mode = presetSwitchMode(s.presetSwitch)
  if (mode === 'ask') return null
  if (mode === 'saveActive' && s.presets.some((p) => p.id === s.activePresetId)) return 'saveActive'
  return { saveNew: autoPresetName(now, s.presets.map((p) => p.name)) }
}

/** 되돌리기용으로 잡아 둔 작업 중 프롬프트 */
export interface PromptSnapshot {
  base: string
  detail: string
  negative: string
  params: Params
  activePresetId: number | null
  /** 가변·시드는 그것까지 바꾸는 작업(설정 불러오기)에서만 잡는다 */
  additional?: string
  seed?: string
}

export function snapshotOf(
  s: Pick<PromptState, 'base' | 'additional' | 'detail' | 'negative' | 'params' | 'activePresetId' | 'seed'>,
  withExtra = false
): PromptSnapshot {
  return {
    base: s.base,
    detail: s.detail,
    negative: s.negative,
    params: s.params,
    activePresetId: s.activePresetId,
    ...(withExtra ? { additional: s.additional, seed: s.seed } : {})
  }
}

function sameSnapshot(a: PromptSnapshot, b: PromptSnapshot): boolean {
  return (
    a.base === b.base &&
    a.detail === b.detail &&
    a.negative === b.negative &&
    a.activePresetId === b.activePresetId &&
    (a.additional ?? '') === (b.additional ?? '') &&
    (a.seed ?? '') === (b.seed ?? '') &&
    sameParams(a.params, b.params)
  )
}

/**
 * 바뀌기 전 프롬프트 한 단계 (메모리에만 — 저장하지 않고 백업에도 넣지 않는다).
 * 프리셋 이동·설정 불러오기가 저장하지 않은 내용을 바꿨을 때 채운다
 */
export const usePromptUndo = create<{ snap: PromptSnapshot | null }>()(() => ({ snap: null }))

export function rememberForUndo(snap: PromptSnapshot): void {
  usePromptUndo.setState({ snap })
}

/**
 * 잡아 둔 프롬프트로 되돌린다 (없으면 false). 프리셋은 고치지 않는다.
 * 되돌리면서 바뀌는 지금 내용도 저장하지 않은 것이면 대신 잡아 두어 다시 되돌릴 수 있다 — 아무것도 잃지 않게
 */
export function undoPromptReplace(): boolean {
  const snap = usePromptUndo.getState().snap
  if (!snap) return false
  const s = usePrompt.getState()
  const extra = snap.additional !== undefined || snap.seed !== undefined
  const current = snapshotOf(s, extra)
  const activePresetId =
    snap.activePresetId !== null && s.presets.some((p) => p.id === snap.activePresetId) ? snap.activePresetId : null
  usePrompt.setState({
    base: snap.base,
    detail: snap.detail,
    negative: snap.negative,
    params: snap.params,
    activePresetId,
    ...(snap.additional !== undefined ? { additional: snap.additional } : {}),
    ...(snap.seed !== undefined ? { seed: snap.seed } : {})
  })
  const keep =
    hasUnsavedPrompt({ ...current, presets: s.presets }) ||
    (current.additional !== undefined && normText(current.additional) !== '' && current.additional !== snap.additional)
  usePromptUndo.setState({ snap: keep ? current : null })
  return true
}

export function mergePromptParts(parts: { base: string; additional: string; detail: string }): string {
  return [parts.base, parts.additional, parts.detail].filter((p) => p.trim()).join(', ')
}
