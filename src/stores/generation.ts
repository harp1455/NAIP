import { create } from 'zustand'
import { encodeVibe, generateImage, NaiHttpError } from '../nai/client'
import { estimateAnlas, type AnlasEstimate } from '../nai/anlas'
import { inpaintingModelFor, modelCapabilities } from '../nai/models'
import type { BuildOptions, CharacterReferenceOptions, VibeOptions } from '../nai/payload'
import type { CharacterPromptInput, GenerationRequest } from '../nai/types'
import {
  makeThumb,
  normalizeInpaintMask,
  processCharRefImage,
  resizeToPngBase64
} from '../lib/image'
import { fileNameFor, saveToGallery, setKeepAwake } from '../lib/native'
import { randomSeed, sleep, uid } from '../lib/util'
import { useCharacters } from './characters'
import { useHistory } from './history'
import { mergePromptParts, usePrompt } from './prompt'
import { useRefs, vibeKey } from './refs'
import { useSettings } from './settings'
import { useSource } from './source'

type Phase = 'idle' | 'preparing' | 'generating' | 'waiting' | 'retrying'

interface GenerationState {
  running: boolean
  phase: Phase
  total: number
  done: number
  failed: number
  error: string | null
  /** 미리보기에 띄울 가장 최근 결과 */
  latestId: number | null
  start: () => Promise<void>
  stop: () => void
  setLatest: (id: number | null) => void
}

const MAX_RETRIES = 3
let controller: AbortController | null = null

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

/** 출연 목록 → payload용 캐릭터 프롬프트 */
export function castPrompts(): CharacterPromptInput[] {
  const { cast, characters } = useCharacters.getState()
  const out: CharacterPromptInput[] = []
  for (const e of cast) {
    const c = characters.find((x) => x.id === e.charId)
    if (!c) continue
    out.push({
      prompt: c.prompt,
      negativePrompt: c.negative,
      enabled: e.enabled,
      name: c.name,
      ...(e.center ? { center: e.center } : {})
    })
  }
  return out
}

export function buildRequest(seed: number): GenerationRequest {
  const p = usePrompt.getState()
  const chars = castPrompts()
  return {
    ...p.params,
    prompt: mergePromptParts(p),
    negativePrompt: p.negative,
    seed,
    characterPrompts: chars,
    // 수동 위치가 하나라도 지정되면 좌표 사용 (payload가 2명 미만이면 자동으로 끈다)
    useCoords: chars.some((c) => c.enabled && c.center)
  }
}

export const useGeneration = create<GenerationState>()((set, get) => ({
  running: false,
  phase: 'idle',
  total: 0,
  done: 0,
  failed: 0,
  error: null,
  latestId: null,
  setLatest: (id) => set({ latestId: id }),
  stop: () => controller?.abort(),
  start: async () => {
    if (get().running) return
    const settings = useSettings.getState()
    const token = settings.token
    if (!token) return set({ error: 'API 토큰을 먼저 설정해 주세요 (설정 탭)' })

    // ── 시작 시점의 설정을 스냅샷 — 진행 중 편집은 다음 배치부터 반영
    const prompt = usePrompt.getState()
    const count = Math.max(1, Math.floor(prompt.count))
    const fixedSeed = prompt.seed.trim() === '' ? null : Number(prompt.seed)
    const base = buildRequest(0)
    const caps = modelCapabilities(base.model)
    const source = useSource.getState()
    const vibeRows = caps.vibes ? useRefs.getState().vibes.filter((v) => v.enabled) : []
    const refRows = caps.characterReferences
      ? useRefs.getState().charRefs.filter((r) => r.enabled)
      : []

    controller = new AbortController()
    const signal = controller.signal
    set({ running: true, phase: 'preparing', total: count, done: 0, failed: 0, error: null })
    if (settings.keepAwake) setKeepAwake(true)

    try {
      // ── 레퍼런스 준비 (배치당 1회)
      const vibes: VibeOptions[] = []
      for (const v of vibeRows) {
        const key = vibeKey(base.model, v.infoExtracted)
        let encoded = v.encodings[key]
        if (!encoded) {
          encoded = await encodeVibe(token, v.image, v.infoExtracted, base.model, signal)
          useRefs.getState().setVibeEncoding(v.id, key, encoded)
        }
        vibes.push({ strength: v.strength, encodedVibeBase64: encoded })
      }
      const characterReferences: CharacterReferenceOptions[] = []
      for (const r of refRows) {
        characterReferences.push({
          referenceType: r.type,
          strength: r.strength,
          fidelity: r.fidelity,
          imageBase64: await processCharRefImage(r.image)
        })
      }

      // ── i2i / 인페인트 소스 준비
      let i2iBase: Omit<NonNullable<BuildOptions['i2i']>, 'extraNoiseSeed'> | null = null
      let model = base.model
      if (source.image) {
        const imageBase64 = await resizeToPngBase64(source.image, base.width, base.height)
        const maskBase64 = source.mask
          ? await normalizeInpaintMask(source.mask, base.width, base.height)
          : null
        if (maskBase64) model = inpaintingModelFor(model)
        i2iBase = {
          strength: source.strength,
          noise: source.noise,
          colorCorrect: false,
          imageBase64,
          ...(maskBase64 ? { maskBase64 } : {})
        }
      }
      const kind = i2iBase ? (i2iBase.maskBase64 ? 'inpaint' : 'i2i') : 't2i'

      // ── 1장씩 count번 요청 (요청당 n_samples: 1)
      for (let i = 0; i < count; i++) {
        const seed = fixedSeed === null || !Number.isFinite(fixedSeed) ? randomSeed() : fixedSeed + i
        const request: GenerationRequest = { ...base, model, seed }
        const buildOpts: BuildOptions = {
          ...(vibes.length ? { vibes } : {}),
          ...(characterReferences.length ? { characterReferences } : {}),
          ...(i2iBase ? { i2i: { ...i2iBase, extraNoiseSeed: Math.max(0, seed - 1) } } : {})
        }

        // 재시도 대상은 네트워크 요청뿐 — 응답을 받은 뒤의 저장 오류로 다시 요청(이중 과금)하지 않는다
        let result: Awaited<ReturnType<typeof generateImage>> | null = null
        for (let attempt = 0; ; attempt++) {
          set({ phase: attempt === 0 ? 'generating' : 'retrying' })
          try {
            result = await generateImage(token, request, buildOpts, signal)
            break
          } catch (e) {
            if (isAbort(e)) throw e
            const status = e instanceof NaiHttpError ? e.status : 0
            // 429·5xx·네트워크 오류는 전이성 → 백오프 후 재시도. 그 외 4xx는 영구 오류
            const transient = status === 0 || status === 429 || status >= 500
            if (transient && attempt < MAX_RETRIES) {
              const wait =
                (e instanceof NaiHttpError ? e.retryAfterMs : undefined) ?? 3000 * 2 ** attempt
              set({
                phase: 'retrying',
                error: `${(e as Error).message} — 재시도 ${attempt + 1}/${MAX_RETRIES}`
              })
              await sleep(Math.min(wait, 60000), signal)
              continue
            }
            set((s) => ({ failed: s.failed + 1, error: (e as Error).message }))
            // 영구 오류(토큰·Anlas 부족·잘못된 요청)는 남은 장도 같은 이유로 실패하므로 배치를 멈춘다
            if (!transient) return
            break
          }
        }

        if (result) {
          const { image, payload } = result
          const id = uid()
          await useHistory.getState().add(
            {
              id,
              ts: Date.now(),
              thumb: await makeThumb(image),
              width: request.width,
              height: request.height,
              seed,
              model,
              kind,
              prompt: payload.input,
              negative: String(payload.parameters.negative_prompt ?? ''),
              mime: image.type
            },
            image
          )
          set((s) => ({ done: s.done + 1, latestId: id, error: null }))
          if (settings.autoSave) {
            void saveToGallery(image, fileNameFor(id, seed, image.type)).catch((e: Error) =>
              set({ error: `갤러리 저장 실패: ${e.message}` })
            )
          }
        }

        if (i < count - 1) {
          // 장 사이 간격: [delayMin, delayMax]초에서 매번 무작위
          const { delayMin, delayMax } = useSettings.getState()
          set({ phase: 'waiting' })
          await sleep(Math.round((delayMin + Math.random() * (delayMax - delayMin)) * 1000), signal)
        }
      }
    } catch (e) {
      if (!isAbort(e)) set({ error: (e as Error).message })
    } finally {
      controller = null
      set({ running: false, phase: 'idle' })
      setKeepAwake(false)
      void useSettings.getState().refreshSubscription()
    }
  }
}))

/** 현재 설정 기준 예상 Anlas (상단 표시용) */
export function estimateCurrent(): AnlasEstimate {
  const p = usePrompt.getState()
  const caps = modelCapabilities(p.params.model)
  const source = useSource.getState()
  const refs = useRefs.getState()
  const vibes = caps.vibes ? refs.vibes.filter((v) => v.enabled) : []
  const sub = useSettings.getState().subscription
  return estimateAnlas({
    model: p.params.model,
    width: p.params.width,
    height: p.params.height,
    steps: p.params.steps,
    strength: source.image ? source.strength : 1,
    charRefCount: caps.characterReferences ? refs.charRefs.filter((r) => r.enabled).length : 0,
    isOpus: sub?.tier === 'opus',
    batchCount: Math.max(1, p.count),
    unencodedVibes: vibes.filter((v) => !v.encodings[vibeKey(p.params.model, v.infoExtracted)]).length,
    vibeCount: vibes.length,
    opusUsageExhausted: sub?.usage ? sub.usage.isNegative : undefined
  })
}
