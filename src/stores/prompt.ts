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
}

export interface PromptPreset {
  id: number
  name: string
  base: string
  detail: string
  negative: string
  params: Params
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
  set: (p: Partial<Pick<PromptState, 'base' | 'additional' | 'detail' | 'negative' | 'seed' | 'count'>>) => void
  patchParams: (p: Partial<Params>) => void
  setModel: (model: string) => void
  savePreset: (name: string) => void
  overwritePreset: (id: number) => void
  applyPreset: (id: number) => void
  renamePreset: (id: number, name: string) => void
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
  ucPreset: 0
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
      renamePreset: (id, name) =>
        set((s) => ({
          presets: s.presets.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p))
        })),
      deletePreset: (id) =>
        set((s) => ({
          presets: s.presets.filter((p) => p.id !== id),
          activePresetId: s.activePresetId === id ? null : s.activePresetId
        }))
    }),
    { name: 'naip-prompt' }
  )
)

export function mergePromptParts(parts: { base: string; additional: string; detail: string }): string {
  return [parts.base, parts.additional, parts.detail].filter((p) => p.trim()).join(', ')
}
