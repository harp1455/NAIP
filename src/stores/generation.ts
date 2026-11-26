import { create } from 'zustand'
import { encodeVibe, generateImage, NaiHttpError } from '../nai/client'
import { estimateAnlas, type AnlasEstimate } from '../nai/anlas'
import { inpaintingModelFor, isV5Model, modelCapabilities } from '../nai/models'
import { clampReferenceStrength, referenceCaption, referencesForModel } from '../nai/reference'
import type { BuildOptions, CharacterReferenceOptions, VibeOptions } from '../nai/payload'
import type { CharacterPromptInput, GenerationRequest } from '../nai/types'
import {
  makeThumb,
  normalizeInpaintMask,
  processCharRefImage,
  processCharRefImageV5,
  resizeToPngBase64
} from '../lib/image'
import type { HistoryMeta, SettingsSnapshot } from '../lib/db'
import { processWildcards, resetSequentialCounters } from '../nai/fragments'
import { cleanFileName, fileNameFor, job, saveToGallery, setKeepAwake } from '../lib/native'
import { randomSeed, sleep, uid } from '../lib/util'
import { useCharacters } from './characters'
import { fragmentSource } from './fragments'
import { appendPrompt, useScenes } from './scenes'
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
  /** 배치 시작 시각 (남은 시간 추정용) */
  startedAt: number
  /**
   * scenes를 주면 그 씬들의 예약분을, regenerate를 주면 그 이미지를 같은 설정·새 시드로 한 장 더,
   * 아무것도 없으면 메인 프롬프트를 장수만큼 생성
   */
  start: (opts?: { scenes?: number[]; regenerate?: HistoryMeta }) => Promise<void>
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
  startedAt: 0,
  setLatest: (id) => set({ latestId: id }),
  stop: () => controller?.abort(),
  start: async (opts) => {
    if (get().running) return
    const settings = useSettings.getState()
    const token = settings.token
    if (!token) return set({ error: 'API 토큰을 먼저 설정해 주세요 (설정 탭)' })
    const sceneIds = opts?.scenes
    const regen = opts?.regenerate

    // ── 시작 시점의 설정을 스냅샷 — 진행 중 편집은 다음 배치부터 반영
    const prompt = usePrompt.getState()
    let fixedSeed = prompt.seed.trim() === '' ? null : Number(prompt.seed)
    let base = buildRequest(0)
    let source: Pick<ReturnType<typeof useSource.getState>, 'image' | 'mask' | 'strength' | 'noise'> =
      useSource.getState()
    let snap: SettingsSnapshot = {
      base: prompt.base,
      additional: prompt.additional,
      detail: prompt.detail,
      negative: prompt.negative,
      params: { ...prompt.params },
      chars: base.characterPrompts
        .filter((c) => c.enabled)
        .map((c) => ({
          name: c.name ?? '',
          prompt: c.prompt,
          negative: c.negativePrompt,
          ...(c.center ? { center: c.center } : {})
        }))
    }
    if (regen) {
      // 다시 생성: 화면의 프롬프트·설정·i2i 소스·레퍼런스는 쓰지 않고, 그 이미지를 만들 때의 내용만 쓴다
      if (!regen.snap) return set({ error: '이 이미지에는 다시 생성에 필요한 정보가 없습니다' })
      snap = regen.snap
      const chars = regen.sent?.chars ?? regen.snap.chars
      base = {
        ...base,
        ...(regen.snap.params as Partial<GenerationRequest>),
        prompt: regen.sent?.prompt ?? mergePromptParts(regen.snap),
        negativePrompt: regen.sent?.negative ?? regen.snap.negative,
        characterPrompts: chars.map((c) => ({
          prompt: c.prompt,
          negativePrompt: c.negative,
          enabled: true,
          name: c.name,
          ...(c.center ? { center: c.center } : {})
        })),
        useCoords: chars.some((c) => c.center)
      }
      fixedSeed = null
      source = { image: null, mask: null, strength: 0.7, noise: 0 }
    }
    const caps = modelCapabilities(base.model)
    const fragments = fragmentSource()

    // ── 생성 계획: 한 항목 = 서버 요청 1번 = 이미지 1장
    interface PlanItem {
      /** reserved: 씬 예약분이라 뽑히면 예약을 하나 줄인다 (다시 생성은 씬 표시만 물려받는다) */
      scene?: { id: number; name: string; prompt: string; negative: string; reserved: boolean }
      /** 씬에 따로 정한 출연 캐릭터 — 있으면 화면에서 켜 둔 출연 대신 쓴다 */
      chars?: CharacterPromptInput[]
      size?: { width: number; height: number }
      /** 고정 시드일 때 더할 오프셋 (씬마다 0부터) */
      offset: number
    }
    const plan: PlanItem[] = []
    if (regen) {
      plan.push({
        offset: 0,
        size: { width: regen.width, height: regen.height },
        ...(regen.sceneId !== undefined
          ? { scene: { id: regen.sceneId, name: regen.sceneName ?? '', prompt: '', negative: '', reserved: false } }
          : {})
      })
    } else if (sceneIds) {
      const want = new Set(sceneIds)
      // 씬별 출연: 라이브러리에서 지워진 캐릭터는 건너뛴다
      const library = useCharacters.getState().characters
      const sceneCast = new Map<number, CharacterPromptInput[]>()
      for (const sc of useScenes.getState().scenes) {
        if (!want.has(sc.id) || !sc.cast) continue
        sceneCast.set(
          sc.id,
          sc.cast.flatMap((id) => {
            const c = library.find((x) => x.id === id)
            return c ? [{ prompt: c.prompt, negativePrompt: c.negative, enabled: true, name: c.name }] : []
          })
        )
      }
      for (const sc of useScenes.getState().scenes) {
        if (!want.has(sc.id)) continue
        for (let i = 0; i < sc.reserve; i++) {
          plan.push({
            scene: { id: sc.id, name: sc.name, prompt: sc.prompt, negative: sc.negative, reserved: true },
            ...(sceneCast.get(sc.id) ? { chars: sceneCast.get(sc.id) } : {}),
            // i2i 소스가 있으면 소스에 맞춘 메인 해상도를 유지한다
            ...(sc.size && !source.image ? { size: sc.size } : {}),
            offset: i
          })
        }
      }
      if (!plan.length) return set({ error: '예약된 씬이 없습니다. 씬 카드에서 장수를 정해 주세요' })
    } else {
      const count = Math.max(1, Math.floor(prompt.count))
      for (let i = 0; i < count; i++) plan.push({ offset: i })
    }
    const count = plan.length

    // 다시 생성은 지금 켜 둔 바이브·레퍼런스를 섞지 않는다 (원래 요청에 없던 것이 들어가면 다른 그림이 된다)
    const vibeRows = caps.vibes && !regen ? useRefs.getState().vibes.filter((v) => v.enabled) : []
    controller = new AbortController()
    const signal = controller.signal
    set({
      running: true,
      phase: 'preparing',
      total: count,
      done: 0,
      failed: 0,
      error: null,
      startedAt: Date.now()
    })
    if (settings.keepAwake) setKeepAwake(true)
    if (settings.background) job.start(`0/${count}장 준비 중`)
    resetSequentialCounters()
    let stoppedByUser = false

    try {
      // ── 레퍼런스 준비 (배치당 1회)
      const vibes: VibeOptions[] = []
      for (const v of vibeRows) {
        const key = vibeKey(base.model, v.infoExtracted)
        let encoded = v.encodings[key]
        if (!encoded) {
          if (!v.image) throw new Error(`"${v.name}" 바이브에 ${base.model} 인코딩이 없습니다`)
          encoded = await encodeVibe(token, v.image, v.infoExtracted, base.model, signal)
          useRefs.getState().setVibeEncoding(v.id, key, encoded)
        }
        vibes.push({ strength: v.strength, encodedVibeBase64: encoded })
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

      // ── 정밀 레퍼런스 준비 (배치당 1회). 모델이 받는 종류만, 모델에 맞는 크기·강도로 보낸다
      const characterReferences: CharacterReferenceOptions[] = []
      const refRows = regen ? [] : referencesForModel(useRefs.getState().charRefs, base.model, kind === 'inpaint')
      for (const r of refRows) {
        characterReferences.push({
          referenceType: referenceCaption(r.type, r.sameOutfit, caps)!,
          strength: clampReferenceStrength(r.strength, caps),
          // Fidelity가 없는 모델(V5)은 secondary strength가 0이 되도록 1로 보낸다
          fidelity: caps.referenceFidelity ? r.fidelity : 1,
          imageBase64:
            caps.referencePreprocess === 'bucket'
              ? await processCharRefImageV5(r.image)
              : await processCharRefImage(r.image)
        })
      }

      // ── 1장씩 count번 요청 (요청당 n_samples: 1)
      for (let i = 0; i < count; i++) {
        const item = plan[i]
        const seed =
          fixedSeed === null || !Number.isFinite(fixedSeed)
            ? randomSeed()
            : (fixedSeed + item.offset) % 4294967296
        // 조각(와일드카드)은 장마다 새로 뽑는다
        // 다시 생성은 이미 치환이 끝난 문장을 그대로 보낸다
        const wild = (text: string): string => (regen?.sent ? text : processWildcards(text, fragments))
        const request: GenerationRequest = {
          ...base,
          ...(item.size ?? {}),
          model,
          seed,
          prompt: wild(appendPrompt(base.prompt, item.scene?.prompt ?? '')),
          negativePrompt: wild(appendPrompt(base.negativePrompt, item.scene?.negative ?? '')),
          characterPrompts: (item.chars ?? base.characterPrompts).map((c) => ({
            ...c,
            prompt: wild(c.prompt),
            negativePrompt: wild(c.negativePrompt)
          })),
          // 씬 출연은 위치를 따로 정하지 않는다 (AI 선택)
          ...(item.chars ? { useCoords: false } : {})
        }
        const buildOpts: BuildOptions = {
          ...(vibes.length ? { vibes } : {}),
          ...(characterReferences.length ? { characterReferences } : {}),
          ...(i2iBase ? { i2i: { ...i2iBase, extraNoiseSeed: Math.max(0, seed - 1) } } : {})
        }
        const label = item.scene ? ` · ${item.scene.name}` : ''
        if (settings.background) job.update(`${i + 1}/${count}장 생성 중${label}`, i, count)

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
              mime: image.type,
              // 씬에 따로 정한 출연이 있으면 그 캐릭터들로 기록해야 "설정 적용"이 같은 출연을 되살린다
              snap: item.chars
                ? { ...snap, chars: item.chars.map((c) => ({ name: c.name ?? '', prompt: c.prompt, negative: c.negativePrompt })) }
                : snap,
              sent: {
                prompt: request.prompt,
                negative: request.negativePrompt,
                chars: request.characterPrompts
                  .filter((c) => c.enabled)
                  .map((c) => ({
                    name: c.name ?? '',
                    prompt: c.prompt,
                    negative: c.negativePrompt,
                    ...(c.center ? { center: c.center } : {})
                  }))
              },
              ...(item.scene ? { sceneId: item.scene.id, sceneName: item.scene.name } : {})
            },
            image
          )
          set((s) => ({ done: s.done + 1, latestId: id, error: null }))
          // 씬 예약은 실제로 뽑힌 만큼만 줄인다 (중지·실패분은 예약에 남는다)
          if (item.scene?.reserved) useScenes.getState().bumpReserve([item.scene.id], -1)
          if (settings.autoSave) {
            const folder = settings.sceneFolders ? item.scene?.name || undefined : undefined
            const fileName = fileNameFor(id, seed, image.type)
            void saveToGallery(image, fileName, folder)
              .then(() => useHistory.getState().markSaved(id, `${folder ? `${cleanFileName(folder)}/` : ''}${fileName}`))
              .catch((e: Error) => set({ error: `갤러리 저장 실패: ${e.message}` }))
          }
          // V5는 할당량 게이지가 장마다 줄어드는 것이 보이도록 매번, 그 밖에는 10장마다 잔액을 새로 읽는다
          if (isV5Model(base.model) || (i + 1) % 10 === 0) void useSettings.getState().refreshSubscription()
        }

        if (i < count - 1) {
          // 장 사이 간격: [delayMin, delayMax]초에서 매번 무작위
          const { delayMin, delayMax } = useSettings.getState()
          set({ phase: 'waiting' })
          await sleep(Math.round((delayMin + Math.random() * (delayMax - delayMin)) * 1000), signal)
        }
      }
    } catch (e) {
      if (isAbort(e)) stoppedByUser = true
      else set({ error: (e as Error).message })
    } finally {
      controller = null
      const { done, failed, error } = get()
      set({ running: false, phase: 'idle' })
      setKeepAwake(false)
      const summary = error
        ? `오류로 중단 — ${done}/${count}장 완료`
        : `${done}장 생성 완료${failed ? ` (실패 ${failed}장)` : ''}`
      job.stop(stoppedByUser ? undefined : summary, settings.vibrate && !stoppedByUser && count > 1)
      void useSettings.getState().refreshSubscription()
    }
  }
}))

/** 현재 설정 기준 예상 Anlas (상단 표시용) */
export function estimateCurrent(
  override?: { width: number; height: number; batchCount: number }
): AnlasEstimate {
  const p = usePrompt.getState()
  const caps = modelCapabilities(p.params.model)
  const source = useSource.getState()
  const refs = useRefs.getState()
  const vibes = caps.vibes ? refs.vibes.filter((v) => v.enabled) : []
  const sub = useSettings.getState().subscription
  return estimateAnlas({
    model: p.params.model,
    width: override?.width ?? p.params.width,
    height: override?.height ?? p.params.height,
    steps: p.params.steps,
    strength: source.image ? source.strength : 1,
    charRefCount: referencesForModel(refs.charRefs, p.params.model, !!(source.image && source.mask)).length,
    isOpus: sub?.tier === 'opus',
    batchCount: override?.batchCount ?? Math.max(1, p.count),
    unencodedVibes: vibes.filter((v) => !v.encodings[vibeKey(p.params.model, v.infoExtracted)]).length,
    vibeCount: vibes.length,
    opusUsageExhausted: sub?.usage ? sub.usage.isNegative : undefined
  })
}

/** 씬 예약분 전체의 예상 Anlas (씬마다 해상도가 다를 수 있어 따로 더한다) */
export function estimateScenes(sceneIds: number[]): { count: number; total: number } {
  const p = usePrompt.getState().params
  const hasSource = !!useSource.getState().image
  const want = new Set(sceneIds)
  let count = 0
  let total = 0
  let first = true
  for (const sc of useScenes.getState().scenes) {
    if (!want.has(sc.id) || sc.reserve <= 0) continue
    const size = sc.size && !hasSource ? sc.size : { width: p.width, height: p.height }
    const est = estimateCurrent({ ...size, batchCount: sc.reserve })
    // 바이브 인코딩 비용은 배치당 한 번만
    total += est.total - (first ? 0 : est.vibeEncoding)
    count += sc.reserve
    first = false
  }
  return { count, total }
}
