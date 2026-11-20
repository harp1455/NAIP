import type { SettingsSnapshot } from './db'
import type { ImportedSettings } from './metadata'
import { MODELS, NOISE_SCHEDULES, SAMPLERS } from '../nai/constants'
import { fitNaiGenerationResolution } from '../nai/resolution'
import { useCharacters } from '../stores/characters'
import { usePrompt, type Params } from '../stores/prompt'

const IMPORT_FOLDER = '가져온 캐릭터'

/** 캐릭터 프롬프트들을 출연 목록으로 — 같은 프롬프트의 캐릭터가 라이브러리에 있으면 그것을 쓰고, 없으면 새로 만든다 */
function applyCast(
  chars: { name?: string; prompt: string; negative: string; center?: { x: number; y: number } }[]
): void {
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

/** 이 앱이 만든 이미지의 설정 스냅샷을 그대로 복원 */
export function applySnapshot(snap: SettingsSnapshot): void {
  const p = usePrompt.getState()
  p.set({ base: snap.base, additional: snap.additional, detail: snap.detail, negative: snap.negative })
  p.patchParams(snap.params as Partial<Params>)
  applyCast(snap.chars)
}

/** 외부 NAI 이미지의 메타데이터를 설정으로 (프롬프트는 통째로 고정 칸에 들어간다) */
export function applyImported(m: ImportedSettings): void {
  const p = usePrompt.getState()
  p.set({ base: m.prompt, additional: '', detail: '', negative: m.negative })
  const size = m.width && m.height ? fitNaiGenerationResolution(m.width, m.height) : null
  p.patchParams({
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
  })
  applyCast(m.characters)
}
