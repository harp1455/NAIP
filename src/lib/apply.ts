import type { SettingsSnapshot } from './db'
import type { ImportedSettings, MetadataVibe } from './metadata'
import { MODELS, NOISE_SCHEDULES, SAMPLERS } from '../nai/constants'
import { fitNaiGenerationResolution } from '../nai/resolution'
import { useCharacters } from '../stores/characters'
import { usePrompt, type Params } from '../stores/prompt'
import { useRefs } from '../stores/refs'

const IMPORT_FOLDER = '가져온 캐릭터'

/** 이미지에서 읽어 온, 항목별로 골라 적용할 수 있는 설정 */
export interface Importable {
  base: string
  additional: string
  detail: string
  negative: string
  params: Partial<Params>
  seed?: number
  chars: { name?: string; prompt: string; negative: string; center?: { x: number; y: number } }[]
  /** 이미지에 들어 있던 인코딩된 바이브와, 확인된 경우 그 인코딩 모델 */
  vibes?: MetadataVibe[]
  vibeModel?: string
}

export type ImportPart = 'prompt' | 'negative' | 'chars' | 'model' | 'size' | 'sampling' | 'quality' | 'seed' | 'vibes'

const PARAM_GROUPS: Record<'model' | 'size' | 'sampling' | 'quality', (keyof Params)[]> = {
  model: ['model'],
  size: ['width', 'height'],
  sampling: ['steps', 'cfgScale', 'cfgRescale', 'sampler', 'noiseSchedule', 'variety'],
  quality: ['qualityToggle', 'ucPreset']
}

/** 이 앱이 만든 이미지의 스냅샷 (조각 치환 전 원본 프롬프트 3분할 그대로) */
export function fromSnapshot(snap: SettingsSnapshot, seed?: number): Importable {
  return {
    base: snap.base,
    additional: snap.additional,
    detail: snap.detail,
    negative: snap.negative,
    params: snap.params as Partial<Params>,
    ...(seed ? { seed } : {}),
    chars: snap.chars
  }
}

/** 외부 NAI 이미지의 메타데이터 (프롬프트는 통째로 고정 칸에 들어간다) */
export function fromMetadata(m: ImportedSettings): Importable {
  const size = m.width && m.height ? fitNaiGenerationResolution(m.width, m.height) : null
  return {
    base: m.prompt,
    additional: '',
    detail: '',
    negative: m.negative,
    params: {
      qualityToggle: m.qualityToggle,
      ucPreset: m.ucPreset,
      ...(m.model && MODELS.some((x) => x.value === m.model) ? { model: m.model } : {}),
      ...(m.steps ? { steps: Math.min(50, Math.max(1, Math.round(m.steps))) } : {}),
      ...(m.cfgScale !== undefined ? { cfgScale: m.cfgScale } : {}),
      ...(m.cfgRescale !== undefined ? { cfgRescale: m.cfgRescale } : {}),
      ...(m.sampler && SAMPLERS.some((x) => x.value === m.sampler) ? { sampler: m.sampler } : {}),
      ...(m.noiseSchedule && NOISE_SCHEDULES.some((x) => x.value === m.noiseSchedule)
        ? { noiseSchedule: m.noiseSchedule }
        : {}),
      ...(m.variety !== undefined ? { variety: m.variety } : {}),
      ...(size ?? {})
    },
    ...(m.seed !== undefined ? { seed: m.seed } : {}),
    chars: m.characters,
    ...(m.vibes.length ? { vibes: m.vibes } : {}),
    ...(m.vibeModel ? { vibeModel: m.vibeModel } : {})
  }
}

/** 이 설정에 실제로 들어 있는 항목만 (체크박스로 보여 줄 것) */
export function availableParts(data: Importable): ImportPart[] {
  const has = (g: keyof typeof PARAM_GROUPS): boolean => PARAM_GROUPS[g].some((k) => data.params[k] !== undefined)
  const parts: ImportPart[] = []
  if (data.base || data.additional || data.detail) parts.push('prompt')
  if (data.negative) parts.push('negative')
  if (data.chars.some((c) => c.prompt.trim())) parts.push('chars')
  for (const g of ['model', 'size', 'sampling', 'quality'] as const) if (has(g)) parts.push(g)
  if (data.seed !== undefined) parts.push('seed')
  if (data.vibes?.length) parts.push('vibes')
  return parts
}

/** 캐릭터 프롬프트들을 출연 목록으로 — 같은 프롬프트의 캐릭터가 라이브러리에 있으면 그것을 쓰고, 없으면 새로 만든다 */
function applyCast(chars: Importable['chars']): void {
  const store = useCharacters.getState()
  store.clearCast()
  let folderId: number | null = null
  chars.forEach((c, i) => {
    if (!c.prompt.trim()) return
    const { characters, folders } = useCharacters.getState()
    let id = characters.find((x) => x.prompt.trim() === c.prompt.trim())?.id
    if (id === undefined) {
      folderId ??= folders.find((f) => f.name === IMPORT_FOLDER)?.id ?? store.addFolder(IMPORT_FOLDER)
      id = store.saveCharacter({
        name: c.name?.trim() || `가져온 캐릭터 ${i + 1}`,
        folderId,
        prompt: c.prompt,
        negative: c.negative
      })
    }
    store.toggleCast(id)
    if (c.center) store.patchCast(id, { center: c.center })
  })
}

/**
 * 고른 항목만 현재 설정에 적용한다 (고르지 않은 항목은 지금 값 유지).
 * presetName을 주면 적용한 결과를 새 프롬프트 프리셋으로 저장하고 그 프리셋을 선택한다.
 */
export function applyImport(
  data: Importable,
  parts: Set<ImportPart>,
  presetName: string | null,
  /** 바이브의 인코딩 모델을 이미지에서 알 수 없을 때 사용자가 고른 모델 */
  chosenVibeModel?: string
): void {
  const p = usePrompt.getState()
  if (parts.has('prompt')) p.set({ base: data.base, additional: data.additional, detail: data.detail })
  if (parts.has('negative')) p.set({ negative: data.negative })
  if (parts.has('seed') && data.seed !== undefined) p.set({ seed: String(data.seed) })
  const patch: Partial<Params> = {}
  for (const g of ['model', 'size', 'sampling', 'quality'] as const) {
    if (!parts.has(g)) continue
    for (const k of PARAM_GROUPS[g]) {
      if (data.params[k] !== undefined) (patch as Record<string, unknown>)[k] = data.params[k]
    }
  }
  // 모델은 setModel 대신 그대로 넣는다 — 함께 고른 스텝·CFG를 기본값으로 덮어쓰지 않게
  p.patchParams(patch)
  if (parts.has('chars')) applyCast(data.chars)
  const vibeModel = data.vibeModel ?? chosenVibeModel
  if (parts.has('vibes') && data.vibes?.length && vibeModel) {
    useRefs.getState().restoreVibes(data.vibes, vibeModel)
  }
  if (presetName !== null) usePrompt.getState().savePreset(presetName)
}
