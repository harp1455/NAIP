import { create } from 'zustand'
import { encodeVibe, generateImage, generateImageStream, NaiHttpError } from '../nai/client'
import { StreamInterruptedError } from '../nai/stream'
import { estimateAnlas, type AnlasEstimate } from '../nai/anlas'
import { effectiveSteps, inpaintingModelFor, isV5Model, modelCapabilities } from '../nai/models'
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
import type { FragmentSource } from '../nai/fragments'
import { processWildcards, resetSequentialCounters } from '../nai/fragments'
import { cleanFileName, fileNameFor, job, saveToGallery, setKeepAwake, wait } from '../lib/native'
import { randomSeed, uid } from '../lib/util'
import { positionFor } from '../lib/position'
import { useCharacters } from './characters'
import { fragmentSource } from './fragments'
import { appendPrompt, useScenes } from './scenes'
import { primeImageUrl, useHistory } from './history'
import { mergePromptParts, usePrompt } from './prompt'
import { useRefs, vibeKey, type CharRef, type Vibe } from './refs'
import { toast } from './toast'
import { useSettings } from './settings'
import { useSource } from './source'

type Phase = 'idle' | 'preparing' | 'generating' | 'waiting' | 'retrying'

export interface BatchTiming {
  count: number
  /** 장당 전체 평균(ms) — 한 장을 요청하기 시작해서 다음 장을 요청하기 직전까지 */
  perImageMs: number
  /** 올려 보내기 + 서버가 그리는 시간 */
  waitMs: number
  /** 결과 내려받기 */
  downloadMs: number
  /** 썸네일 만들기·기기에 저장 */
  processMs: number
  /** 응답을 받은 뒤 다음 요청까지 실제로 쉰 시간 (설정한 간격보다 훨씬 길면 앱이 느려진 것) */
  gapMs: number
  sentBytes: number
  receivedBytes: number
}

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
  /** 지난 배치에서 장당 평균 어디에 시간이 들었는지 (느릴 때 원인을 보기 위한 측정) */
  lastBatch: BatchTiming | null
  /** 지금 도는 배치의 이름 (대기열 표시용) */
  currentLabel: string
  /** 스트리밍 중간 미리보기 — url은 화면이 꺼져 있으면 만들지 않는다 */
  preview: { seq: number; url: string | null; step: number; total: number } | null
  /** 지금 배치가 끝나면 이어서 돌 배치들 */
  queue: QueuedBatch[]
  /** 씬별로 지금 배치·대기열이 가져간(아직 안 뽑은) 장수 — 씬 카드에 "진행 중"으로 표시 */
  sceneClaims: Record<number, number>
  /**
   * scenes를 주면 그 씬들의 예약분을, regenerate를 주면 그 이미지를 같은 설정·새 시드로 한 장 더,
   * 아무것도 없으면 메인 프롬프트를 장수만큼 생성. 이미 생성 중이면 누른 시점의 설정으로 대기열에 넣는다
   */
  start: (opts?: { scenes?: number[]; regenerate?: HistoryMeta }) => Promise<void>
  /** 지금 배치를 멈추고 대기열도 비운다 */
  stop: () => void
  removeQueued: (id: number) => void
  setLatest: (id: number | null) => void
}

export interface QueuedBatch {
  id: number
  label: string
  count: number
}

const MAX_RETRIES = 3
/** 중간 미리보기를 그리는 최소 간격 — 매 단계 디코딩하면 발열·배터리 소모가 크다 */
const PREVIEW_INTERVAL_MS = 250
let controller: AbortController | null = null
/** 이 세션에서 스트리밍 엔드포인트가 지원되지 않는다고 확인되면 zip 방식으로만 요청한다 */
let streamUnsupported = false
let previewSeq = 0
let lastPreviewAt = 0
/** 대기열에 들어간 배치의 실제 내용 (상태에는 표시용 요약만 둔다) */
const pendingBatches: Batch[] = []

/** 생성 계획 한 칸 = 서버 요청 1번 = 이미지 1장 */
interface PlanItem {
  /** reserved: 씬 예약에서 가져온 장이라, 못 뽑으면 예약으로 돌려준다 (다시 생성은 씬 표시만 물려받는다) */
  scene?: { id: number; name: string; prompt: string; negative: string; reserved: boolean }
  /** 씬에 따로 정한 출연 캐릭터 — 있으면 화면에서 켜 둔 출연 대신 쓴다 */
  chars?: CharacterPromptInput[]
  size?: { width: number; height: number }
  /** 고정 시드일 때 더할 오프셋 (씬마다 0부터) */
  offset: number
}

/** 생성 버튼을 누른 순간의 설정 묶음 — 대기 중에 화면을 고쳐도 이 내용대로 돈다 */
interface Batch {
  id: number
  label: string
  base: GenerationRequest
  snap: SettingsSnapshot
  fixedSeed: number | null
  source: { image: string | null; mask: string | null; strength: number; noise: number; originId: number | null }
  vibes: Vibe[]
  charRefs: CharRef[]
  fragments: FragmentSource
  plan: PlanItem[]
  /** 다시 생성: 이미 치환이 끝난 문장을 그대로 보낸다 */
  verbatim: boolean
}

type BatchOutcome = 'done' | 'stopped' | 'fatal'

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
  // 위치는 지금 모델이 받는 형태로 (V5 자유 위치 0.1%, V4·V4.5는 5×5 격자로 맞춤)
  const chars = castPrompts().map((c) => (c.center ? { ...c, center: positionFor(c.center, p.params.model) } : c))
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

export const useGeneration = create<GenerationState>()((set, get) => {
  /** 씬 예약을 배치가 가져가거나(+) 돌려줄 때(−) 진행 중 표시를 맞춘다 */
  const claim = (sceneId: number, delta: number): void =>
    set((s) => {
      const next = { ...s.sceneClaims, [sceneId]: Math.max(0, (s.sceneClaims[sceneId] ?? 0) + delta) }
      if (!next[sceneId]) delete next[sceneId]
      return { sceneClaims: next }
    })

  /** 못 뽑은 씬 장을 예약으로 돌려준다 */
  const release = (items: PlanItem[]): void => {
    for (const item of items) {
      if (!item.scene?.reserved) continue
      useScenes.getState().bumpReserve([item.scene.id], 1)
      claim(item.scene.id, -1)
    }
  }

  /** 중간 단계 미리보기 — 너무 자주 그리지 않고, 화면이 꺼져 있으면 단계 번호만 갱신한다 */
  const showPreview = (seq: number, step: number, total: number, frame?: Uint8Array): void => {
    const now = performance.now()
    const prev = get().preview
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
    const draw = !!frame && visible && (now - lastPreviewAt >= PREVIEW_INTERVAL_MS || prev?.seq !== seq)
    if (!draw) {
      if (!prev || prev.seq !== seq || prev.step !== step) set({ preview: { seq, url: prev?.seq === seq ? prev.url : null, step, total } })
      return
    }
    lastPreviewAt = now
    const url = URL.createObjectURL(new Blob([frame as BlobPart]))
    if (prev?.url) URL.revokeObjectURL(prev.url)
    set({ preview: { seq, url, step, total } })
  }

  /** 미리보기를 거두고 그림 메모리를 돌려준다. seq를 주면 그 장의 미리보기일 때만 */
  const clearPreview = (seq?: number): void => {
    const prev = get().preview
    if (!prev || (seq !== undefined && prev.seq !== seq)) return
    if (prev.url) URL.revokeObjectURL(prev.url)
    set({ preview: null })
  }

  const syncQueue = (): void =>
    set({ queue: pendingBatches.map((b) => ({ id: b.id, label: b.label, count: b.plan.length })) })

  /** 지금 화면의 설정으로 배치를 만든다 (씬 배치는 이 순간 예약을 가져간다). 만들 수 없으면 이유 */
  const buildBatch = (opts?: { scenes?: number[]; regenerate?: HistoryMeta }): Batch | string => {
    const sceneIds = opts?.scenes
    const regen = opts?.regenerate
    const prompt = usePrompt.getState()
    let fixedSeed = prompt.seed.trim() === '' ? null : Number(prompt.seed)
    let base = buildRequest(0)
    const live = useSource.getState()
    let source = { image: live.image, mask: live.mask, strength: live.strength, noise: live.noise, originId: live.originId }
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
      if (!regen.snap) return '이 이미지에는 다시 생성에 필요한 정보가 없습니다'
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
      source = { image: null, mask: null, strength: 0.7, noise: 0, originId: null }
    }

    const plan: PlanItem[] = []
    let label: string
    if (regen) {
      plan.push({
        offset: 0,
        size: { width: regen.width, height: regen.height },
        ...(regen.sceneId !== undefined
          ? { scene: { id: regen.sceneId, name: regen.sceneName ?? '', prompt: '', negative: '', reserved: false } }
          : {})
      })
      label = `다시 생성 · seed ${regen.seed}`
    } else if (sceneIds) {
      const want = new Set(sceneIds)
      // 씬별 출연: 라이브러리에서 지워진 캐릭터는 건너뛴다
      const library = useCharacters.getState().characters
      const picked = useScenes.getState().scenes.filter((sc) => want.has(sc.id) && sc.reserve > 0)
      for (const sc of picked) {
        const chars = sc.cast?.flatMap((id) => {
          const c = library.find((x) => x.id === id)
          const center = sc.castCenters?.[id]
          return c
            ? [
                {
                  prompt: c.prompt,
                  negativePrompt: c.negative,
                  enabled: true,
                  name: c.name,
                  ...(center ? { center: positionFor(center, base.model) } : {})
                }
              ]
            : []
        })
        for (let i = 0; i < sc.reserve; i++) {
          plan.push({
            scene: { id: sc.id, name: sc.name, prompt: sc.prompt, negative: sc.negative, reserved: true },
            ...(chars ? { chars } : {}),
            // i2i 소스가 있으면 소스에 맞춘 메인 해상도를 유지한다
            ...(sc.size && !source.image ? { size: sc.size } : {}),
            offset: i
          })
        }
      }
      if (!plan.length) return '예약된 씬이 없습니다. 씬 카드에서 장수를 정해 주세요'
      // 예약을 이 배치가 가져간다 — 대기 중에 다시 눌러도 같은 장을 두 번 뽑지 않게
      for (const sc of picked) {
        claim(sc.id, sc.reserve)
        useScenes.getState().setReserve(sc.id, 0)
      }
      label = picked.length === 1 ? `씬 ${picked[0].name} · ${plan.length}장` : `씬 ${picked.length}개 · ${plan.length}장`
    } else {
      const count = Math.max(1, Math.floor(prompt.count))
      for (let i = 0; i < count; i++) plan.push({ offset: i })
      const presetName = prompt.presets.find((x) => x.id === prompt.activePresetId)?.name
      label = `${presetName ?? '메인 프롬프트'} · ${count}장`
    }

    const caps = modelCapabilities(base.model)
    const refs = useRefs.getState()
    return {
      id: uid(),
      label,
      base,
      snap,
      fixedSeed,
      source,
      // 다시 생성은 지금 켜 둔 바이브·레퍼런스를 섞지 않는다 (원래 요청에 없던 것이 들어가면 다른 그림이 된다)
      vibes: caps.vibes && !regen ? refs.vibes.filter((v) => v.enabled) : [],
      charRefs: regen ? [] : refs.charRefs.filter((r) => r.enabled),
      fragments: fragmentSource(),
      plan,
      verbatim: !!regen?.sent
    }
  }

  /** 배치 하나를 끝까지(또는 멈출 때까지) 돌린다 */
  const runBatch = async (batch: Batch, token: string, signal: AbortSignal): Promise<BatchOutcome> => {
    const settings = useSettings.getState()
    const { base, snap, fixedSeed, source, plan } = batch
    const caps = modelCapabilities(base.model)
    const count = plan.length
    const generated = new Set<number>()
    set({ phase: 'preparing', total: count, done: 0, failed: 0, error: null, startedAt: Date.now(), currentLabel: batch.label })
    if (settings.background) job.update(`${batch.label} · 준비 중`, 0, count)
    resetSequentialCounters()
    const timing = { count: 0, gaps: 0, waitMs: 0, downloadMs: 0, processMs: 0, gapMs: 0, sentBytes: 0, receivedBytes: 0 }
    let loopStarted = 0
    let outcome: BatchOutcome = 'done'

    try {
      // ── 레퍼런스 준비 (배치당 1회). 바이브 인코딩은 앞 배치가 저장했을 수 있어 최신 값을 다시 본다
      const vibes: VibeOptions[] = []
      for (const snapshotVibe of batch.vibes) {
        const v = useRefs.getState().vibes.find((x) => x.id === snapshotVibe.id) ?? snapshotVibe
        const key = vibeKey(base.model, snapshotVibe.infoExtracted)
        let encoded = v.encodings[key]
        if (!encoded) {
          if (!v.image) throw new Error(`"${v.name}" 바이브에 ${base.model} 인코딩이 없습니다`)
          encoded = await encodeVibe(token, v.image, snapshotVibe.infoExtracted, base.model, signal)
          useRefs.getState().setVibeEncoding(v.id, key, encoded)
        }
        vibes.push({ strength: snapshotVibe.strength, encodedVibeBase64: encoded })
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
      for (const r of referencesForModel(batch.charRefs, base.model, kind === 'inpaint')) {
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
      loopStarted = performance.now()
      for (let i = 0; i < count; i++) {
        const item = plan[i]
        const seed =
          fixedSeed === null || !Number.isFinite(fixedSeed)
            ? randomSeed()
            : (fixedSeed + item.offset) % 4294967296
        // 조각(와일드카드)은 장마다 새로 뽑는다. 다시 생성은 이미 치환이 끝난 문장을 그대로 보낸다
        const wild = (text: string): string => (batch.verbatim ? text : processWildcards(text, batch.fragments))
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
          // 씬 출연은 그 씬에 정한 위치를 쓴다 (정하지 않았으면 AI 선택)
          ...(item.chars ? { useCoords: item.chars.some((c) => c.center) } : {})
        }
        const buildOpts: BuildOptions = {
          ...(vibes.length ? { vibes } : {}),
          ...(characterReferences.length ? { characterReferences } : {}),
          ...(i2iBase ? { i2i: { ...i2iBase, extraNoiseSeed: Math.max(0, seed - 1) } } : {})
        }
        const label = item.scene?.name ? ` · ${item.scene.name}` : ''
        const queued = pendingBatches.length ? ` (대기 ${pendingBatches.length})` : ''
        if (settings.background) job.update(`${i + 1}/${count}장 생성 중${label}${queued}`, i, count)

        // 재시도 대상은 네트워크 요청뿐 — 응답을 받은 뒤의 저장 오류로 다시 요청(이중 과금)하지 않는다
        let result: Awaited<ReturnType<typeof generateImage>> | null = null
        let resultSeq = 0
        for (let attempt = 0; ; attempt++) {
          set({ phase: attempt === 0 ? 'generating' : 'retrying' })
          try {
            const useStream = useSettings.getState().streaming && !streamUnsupported
            const seq = ++previewSeq
            const totalSteps = effectiveSteps(request.model, request.steps)
            result = useStream
              ? await generateImageStream(
                  token,
                  request,
                  buildOpts,
                  (step, frame) => showPreview(seq, step + 1, totalSteps, frame),
                  signal
                ).catch((e) => {
                  // 스트리밍 자체를 받지 않는 경우에만(헤더 단계 404·405·501 — 생성 시작 전) 이번부터 zip으로
                  if (e instanceof NaiHttpError && [404, 405, 501].includes(e.status)) {
                    streamUnsupported = true
                    return generateImage(token, request, buildOpts, signal)
                  }
                  throw e
                })
              : await generateImage(token, request, buildOpts, signal)
            resultSeq = seq
            break
          } catch (e) {
            if (isAbort(e)) throw e
            if (e instanceof StreamInterruptedError) {
              // 생성이 시작된 뒤 끊겼다 — 서버가 이미 그렸을(과금했을) 수 있어 같은 장을 다시 요청하지 않는다
              set((s) => ({
                failed: s.failed + 1,
                error: `${e.message} — 이미 과금됐을 수 있어 이 장은 다시 요청하지 않았습니다`
              }))
              clearPreview(previewSeq)
              break
            }
            const status = e instanceof NaiHttpError ? e.status : 0
            // 429·5xx·네트워크 오류는 전이성 → 백오프 후 재시도. 그 외 4xx는 영구 오류
            const transient = status === 0 || status === 429 || status >= 500
            if (transient && attempt < MAX_RETRIES) {
              const backoff =
                (e instanceof NaiHttpError ? e.retryAfterMs : undefined) ?? 3000 * 2 ** attempt
              set({
                phase: 'retrying',
                error: `${(e as Error).message} — 재시도 ${attempt + 1}/${MAX_RETRIES}`
              })
              await wait(Math.min(backoff, 60000), signal)
              continue
            }
            set((s) => ({ failed: s.failed + 1, error: (e as Error).message }))
            // 영구 오류(토큰·Anlas 부족·잘못된 요청)는 남은 장과 대기열도 같은 이유로 실패하므로 모두 멈춘다
            if (!transient) {
              outcome = 'fatal'
              return outcome
            }
            break
          }
        }

        // 결과 저장은 다음 장을 기다리는 간격과 겹쳐서 한다 — 저장이 끝난 뒤에야 간격을 세면 그만큼 느려진다
        const received = performance.now()
        let post: Promise<void> = Promise.resolve()
        if (result) {
          const { image, payload } = result
          generated.add(i)
          if (item.scene?.reserved) claim(item.scene.id, -1)
          timing.count++
          timing.waitMs += result.stats.waitMs
          timing.downloadMs += result.stats.downloadMs
          timing.sentBytes += result.stats.sentBytes
          timing.receivedBytes += result.stats.receivedBytes
          const id = uid()
          post = (async () => {
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
                  ? {
                      ...snap,
                      chars: item.chars.map((c) => ({
                        name: c.name ?? '',
                        prompt: c.prompt,
                        negative: c.negativePrompt,
                        ...(c.center ? { center: c.center } : {})
                      }))
                    }
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
                ...(item.scene ? { sceneId: item.scene.id, sceneName: item.scene.name } : {}),
                ...(kind !== 't2i' && source.originId !== null ? { parentId: source.originId } : {})
              },
              image
            )
            primeImageUrl(id, image)
            set((s) => ({ done: s.done + 1, latestId: id, error: null }))
            // 완성본이 결과 화면에 올라간 뒤에 미리보기를 거둔다 (그 사이 다음 장 미리보기가 왔으면 그대로 둔다)
            clearPreview(resultSeq)
            if (settings.autoSave) {
              const folder = settings.sceneFolders ? item.scene?.name || undefined : undefined
              const fileName = fileNameFor(id, seed, image.type)
              void saveToGallery(image, fileName, folder)
                .then(() => useHistory.getState().markSaved(id, `${folder ? `${cleanFileName(folder)}/` : ''}${fileName}`))
                .catch((e: Error) => set({ error: `갤러리 저장 실패: ${e.message}` }))
            }
            // V5는 할당량 게이지가 장마다 줄어드는 것이 보이도록 매번, 그 밖에는 10장마다 잔액을 새로 읽는다
            if (isV5Model(base.model) || (i + 1) % 10 === 0) void useSettings.getState().refreshSubscription()
            timing.processMs += performance.now() - received
          })()
          // 중지로 기다림이 먼저 끝난 뒤 저장이 실패해도 처리되지 않은 오류로 남지 않게 한다
          post.catch(() => {})
        }

        if (i < count - 1) {
          // 장 사이 간격: 응답을 받은 시점부터 [delayMin, delayMax]초에서 매번 무작위
          const { delayMin, delayMax } = useSettings.getState()
          set({ phase: 'waiting' })
          await Promise.all([
            post,
            wait(Math.round((delayMin + Math.random() * (delayMax - delayMin)) * 1000), signal)
          ])
          if (result) {
            timing.gapMs += performance.now() - received
            timing.gaps++
          }
        } else {
          await post
        }
      }
    } catch (e) {
      if (isAbort(e)) outcome = 'stopped'
      else {
        set({ error: (e as Error).message })
        outcome = 'fatal'
      }
    } finally {
      clearPreview()
      // 못 뽑은 씬 장(중지·실패)은 예약으로 돌려준다
      release(plan.filter((_, i) => !generated.has(i)))
      if (timing.count > 0 && loopStarted) {
        const n = timing.count
        set({
          lastBatch: {
            count: n,
            perImageMs: (performance.now() - loopStarted) / n,
            waitMs: timing.waitMs / n,
            downloadMs: timing.downloadMs / n,
            processMs: timing.processMs / n,
            gapMs: timing.gaps ? timing.gapMs / timing.gaps : 0,
            sentBytes: timing.sentBytes / n,
            receivedBytes: timing.receivedBytes / n
          }
        })
      }
    }
    return outcome
  }

  /** 첫 배치를 돌리고, 대기열에 쌓인 배치를 차례로 이어서 돌린다 */
  const runQueue = async (first: Batch, token: string): Promise<void> => {
    const settings = useSettings.getState()
    set({ running: true })
    if (settings.keepAwake) setKeepAwake(true)
    if (settings.background) job.start(`${first.label} · 준비 중`)
    let totalDone = 0
    let totalFailed = 0
    let batches = 0
    let last: BatchOutcome = 'done'
    for (let batch: Batch | undefined = first; batch; batch = pendingBatches.shift()) {
      syncQueue()
      controller = new AbortController()
      last = await runBatch(batch, token, controller.signal)
      batches++
      totalDone += get().done
      totalFailed += get().failed
      if (last !== 'done') break
    }
    controller = null
    // 멈췄거나 막혔으면 남은 대기열은 취소하고 씬 예약을 돌려준다
    for (const rest of pendingBatches.splice(0)) release(rest.plan)
    syncQueue()
    const error = get().error
    set({ running: false, phase: 'idle', currentLabel: '' })
    setKeepAwake(false)
    const stopped = last === 'stopped'
    const summary =
      last === 'fatal' || error
        ? `오류로 중단 — ${totalDone}장 완료`
        : `${totalDone}장 생성 완료${batches > 1 ? ` (배치 ${batches}개)` : ''}${totalFailed ? ` · 실패 ${totalFailed}장` : ''}`
    job.stop(stopped ? undefined : summary, settings.vibrate && !stopped && totalDone + totalFailed > 1)
    void useSettings.getState().refreshSubscription()
  }

  return {
    running: false,
    phase: 'idle',
    total: 0,
    done: 0,
    failed: 0,
    error: null,
    latestId: null,
    startedAt: 0,
    lastBatch: null,
    currentLabel: '',
    preview: null,
    queue: [],
    sceneClaims: {},
    setLatest: (id) => set({ latestId: id }),
    stop: () => {
      for (const rest of pendingBatches.splice(0)) release(rest.plan)
      syncQueue()
      controller?.abort()
    },
    removeQueued: (id) => {
      const i = pendingBatches.findIndex((b) => b.id === id)
      if (i < 0) return
      release(pendingBatches.splice(i, 1)[0].plan)
      syncQueue()
    },
    start: async (opts) => {
      const token = useSettings.getState().token
      if (!token) return set({ error: 'API 토큰을 먼저 설정해 주세요 (설정 탭)' })
      const batch = buildBatch(opts)
      if (typeof batch === 'string') {
        if (get().running) toast(batch, true)
        else set({ error: batch })
        return
      }
      if (get().running) {
        pendingBatches.push(batch)
        syncQueue()
        toast(`대기열에 추가했습니다 — ${pendingBatches.length}번째 (${batch.label})`)
        return
      }
      await runQueue(batch, token)
    }
  }
})

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
