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
import { processWildcards, resetSequentialCounters, restoreSequentialCounters, sequentialCounterEntries } from '../nai/fragments'
import { cleanFileName, fileNameFor, job, setKeepAwake, wait } from '../lib/native'
import { saveHistoryImageToGallery } from '../storage/export'
import { randomSeed, uid } from '../lib/util'
import { positionFor } from '../lib/position'
// ── Phase 2: 캐릭터 슬롯·변형 뽑기
import {
  castSent,
  checkPeopleCount,
  cleanCursors,
  createDrawState,
  drawStateFor,
  fixedSlots,
  fixPeopleCount,
  resolveCast,
  type CastCursors,
  type CastPlan,
  type CastResolution,
  type CastSent,
  type DrawState
} from '../nai/cast'
import { cursorEpochOf, snapshotCastPlan, useCharacters } from './characters'
import { fragmentLibrary, fragmentSourceFrom, type FragmentLibrary } from './fragments'
import { appendPrompt, useScenes } from './scenes'
import { primeImageUrl, useHistory } from './history'
import { newRequestId, queueStore, resumeDrawFor, type ResumeEntry } from './queue-persist'
import { lowSpaceWarning } from '../storage'
import { mergePromptParts, usePrompt } from './prompt'
import { useRefs, vibeKey, type CharRef, type Vibe } from './refs'
import { toast } from './toast'
import { useSettings } from './settings'
import { useSource } from './source'
// ── Phase 5: 에셋 프로젝트 장의 진행을 프로젝트 조합에 알린다 (src/project/queue.ts)
import {
  projectItemFailed,
  projectItemLanded,
  projectItemRequest,
  projectItemStarted,
  projectItemsQueued,
  releaseProjectItems,
  type ProjectPlanItem
} from '../project/queue'

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
  start: (opts?: { scenes?: number[]; regenerate?: HistoryMeta; redraw?: boolean }) => Promise<void>
  /** 지금 배치를 멈추고 대기열도 비운다 */
  stop: () => void
  removeQueued: (id: number) => void
  setLatest: (id: number | null) => void
  /**
   * 지난 실행에서 끝나지 않은 배치를 이어서 돌린다 (보내지 않은 장만).
   * withUncertain이면 "확인 필요"(보냈는데 결과를 모르는) 장도 다시 보낸다 — 사용자가 고른 경우에만
   */
  resume: (entries: ResumeEntry[], withUncertain: boolean) => Promise<void>
  /** ── Phase 5: 미리 만든 배치(에셋 프로젝트)를 넣는다 — 생성 중이면 대기열 뒤에, 아니면 바로 돌린다 */
  enqueueBatches: (batches: Batch[]) => Promise<void>
  /**
   * ── Phase 5: 이 프로젝트의 장이 든 배치를 대기열에서 빼고, 지금 도는 배치가 그것이면 그 배치만 멈춘다
   * (다른 배치는 이어서 돈다). 뺀 장수를 돌려준다
   */
  cancelProject: (projectId: string) => number
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
/** 멈춰 있을 때 누른 "생성"이 공간 확인을 기다리는 중 (두 번 눌림 방지) */
let preparingFresh = false
/** 지금 도는 배치 */
let current: Batch | null = null
/** 지금 배치만 멈추고 대기열은 이어서 돌린다 (프로젝트 삭제로 그 프로젝트 배치만 취소할 때) */
let skipCurrent = false
/** 마지막으로 서버 응답(성공·실패)을 받은 시각 (performance.now, 0 = 아직 없음) — 배치가 바뀌어도 요청 간격을 지킨다 */
let lastResponseAt = 0

/** 이 장들 중 이 프로젝트의 장이 있는지 */
const hasProject = (plan: readonly PlanItem[], projectId: string): boolean =>
  plan.some((item) => item.project?.tag.projectId === projectId)

/** 생성 계획 한 칸 = 서버 요청 1번 = 이미지 1장 */
export interface PlanItem {
  /** 배치 계획에서의 원래 위치 — 진행 기록(queue_items)의 열쇠. 이어서 돌릴 때만 들어 있다 (없으면 순서) */
  key?: number
  /** reserved: 씬 예약에서 가져온 장이라, 못 뽑으면 예약으로 돌려준다 (다시 생성은 씬 표시만 물려받는다) */
  scene?: { id: number; name: string; prompt: string; negative: string; reserved: boolean }
  /** 씬에 따로 정한 출연 캐릭터(고정 슬롯으로 바꾼 것) — 있으면 화면의 출연 슬롯 대신 쓴다 */
  cast?: CastPlan
  size?: { width: number; height: number }
  /** 고정 시드일 때 더할 오프셋 (씬마다 0부터) */
  offset: number
  /** ── Phase 5: 에셋 프로젝트 장 — 이 장의 프롬프트(화면 프롬프트 대신)·캐릭터·분류 표시 */
  project?: ProjectPlanItem
}

/**
 * 생성 버튼을 누른 순간의 설정 묶음 — 대기 중에 화면을 고쳐도 이 내용대로 돈다.
 * 대기열 저장(queue-persist)이 JSON으로 통째로 저장하므로 필드는 JSON으로 옮겨지는 값으로 둔다 (fragments만 예외)
 */
export interface Batch {
  id: number
  label: string
  base: GenerationRequest
  snap: SettingsSnapshot
  fixedSeed: number | null
  source: { image: string | null; mask: string | null; strength: number; noise: number; originId: number | null }
  vibes: Vibe[]
  charRefs: CharRef[]
  /** 조각 치환 함수 — fragmentLib에서 만든다 (저장할 때는 빼고, 되살릴 때 다시 만든다) */
  fragments: FragmentSource
  fragmentLib: FragmentLibrary
  plan: PlanItem[]
  /** 다시 생성: 이미 치환이 끝난 문장을 그대로 보낸다 */
  verbatim: boolean
  /**
   * 출연 슬롯 스냅샷 (Phase 2) — 장마다 여기서 캐릭터·변형을 뽑는다. 누른 순간의 라이브러리 내용을 복사해 두어
   * 대기 중에 캐릭터를 고쳐도 영향받지 않는다. null = base.characterPrompts를 그대로 (다시 생성)
   */
  cast: CastPlan | null
  /** 다시 생성: 원본의 뽑기 결과 기록을 그대로 물려준다 */
  castSent?: CastSent
  /** 이어서 생성: 앱이 죽기 전의 뽑기 상태에서 이어 간다 (없으면 처음부터) */
  resumeDraw?: DrawSnapshot
  /**
   * "배치에 한 번" 순차 슬롯·변형을 배치를 넘어 이어 간다 — 저장된 순서 자리에서 뽑고, 그림이 나오면 다음 차례로 넘긴다.
   * 화면 설정으로 누른 배치만 (다시 생성·재추첨은 지난 그림을 다시 그리는 것이라 순서를 쓰지도 넘기지도 않는다)
   */
  continueSequence?: boolean
}

/** 배치의 뽑기 상태 — 조각 순차 카운터와 출연 슬롯·변형 뽑기 상태 (순수 JSON, 이어서 생성용으로 장마다 저장한다) */
export interface DrawSnapshot {
  counters: [string, number][]
  states: [string, DrawState][]
  /** 이 배치가 시작할 때의 순서 자리 (continueSequence 배치만) — 이어서 생성은 그사이 넘어간 자리가 아니라 이것으로 뽑는다 */
  cursors?: CastCursors
  /**
   * 이 배치가 시작할 때의 되돌리기 세대 (characters 스토어 cursorEpoch, cursors와 함께만) — 앱이 죽은 뒤 되돌렸으면
   * 이어서 생성한 장이 되돌린 자리를 넘기지 않는다. 없으면(이 칸이 생기기 전 기록) 0
   */
  epoch?: number
}

function drawSnapshot(states: Map<string, DrawState>, sequence?: { cursors: CastCursors; epoch: number }): DrawSnapshot {
  return JSON.parse(
    JSON.stringify({
      counters: sequentialCounterEntries(),
      states: [...states],
      ...(sequence ? { cursors: sequence.cursors, epoch: sequence.epoch } : {})
    })
  ) as DrawSnapshot
}

// ── Phase 5: 프로젝트 배치를 밖(src/project/run.ts)에서 만들 수 있게 모양만 내보낸다
export type { Batch as QueueBatch, PlanItem as QueuePlanItem }

type BatchOutcome = 'done' | 'stopped' | 'fatal'

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

/** 뽑기 결과 → payload용 캐릭터 프롬프트 (text로 조각 치환, 위치는 이 모델이 받는 형태로) */
export function resolvedPrompts(
  res: CastResolution,
  model: string,
  text: (s: string) => string = (s) => s
): CharacterPromptInput[] {
  return res.chars.map((c) => ({
    prompt: text(c.prompt),
    negativePrompt: text(c.negative),
    enabled: true,
    name: c.name,
    ...(c.center ? { center: positionFor(c.center, model) } : {})
  }))
}

/** 출연 슬롯 → payload용 캐릭터 프롬프트 (한 번 뽑아 본 결과 — 실제 생성은 장마다 runBatch에서 다시 뽑는다) */
export function castPrompts(rng: () => number = Math.random): CharacterPromptInput[] {
  const model = usePrompt.getState().params.model
  const res = resolveCast(snapshotCastPlan(), createDrawState(), rng, modelCapabilities(model).maxCharacters)
  return resolvedPrompts(res, model)
}

export function buildRequest(seed: number): GenerationRequest {
  const p = usePrompt.getState()
  // 위치는 지금 모델이 받는 형태로 (V5 자유 위치 0.1%, V4·V4.5는 5×5 격자로 맞춤)
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
    releaseProjectItems(items) // ── Phase 5: 못 뽑은 프로젝트 장의 대기·생성 중 장수를 돌려준다
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

  /**
   * 앞 요청의 응답을 받은 뒤 설정한 간격([delayMin, delayMax]초에서 무작위)이 아직 지나지 않았으면 남은 만큼 기다린다.
   * 배치 안의 장 사이는 아래 루프가 기다리고, 이것은 배치의 첫 요청(바이브 인코딩 포함) 앞에서 — 대기열의 다음 배치나
   * 이어서 생성한 배치가 앞 배치의 마지막 응답 직후에 바로 보내지 않게 한다
   */
  const pace = async (signal: AbortSignal): Promise<void> => {
    if (!lastResponseAt) return
    const { delayMin, delayMax } = useSettings.getState()
    const left = lastResponseAt + Math.round((delayMin + Math.random() * (delayMax - delayMin)) * 1000) - performance.now()
    if (left <= 0) return
    set({ phase: 'waiting' })
    await wait(Math.round(left), signal)
  }

  const syncQueue = (): void =>
    set({ queue: pendingBatches.map((b) => ({ id: b.id, label: b.label, count: b.plan.length })) })

  /** 지금 화면의 설정으로 배치를 만든다 (씬 배치는 이 순간 예약을 가져간다). 만들 수 없으면 이유 */
  const buildBatch = (opts?: { scenes?: number[]; regenerate?: HistoryMeta; redraw?: boolean }): Batch | string => {
    const sceneIds = opts?.scenes
    const regen = opts?.regenerate
    // 재추첨 생성: 그 이미지의 슬롯·변형 원본으로 다시 뽑는다 (조각도 새로)
    const redraw = opts?.redraw ? regen?.snap?.cast : undefined
    if (opts?.redraw && !redraw) return '이 이미지에는 재추첨에 필요한 출연 슬롯 정보가 없습니다'
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
      if (redraw) {
        base = { ...base, prompt: mergePromptParts(regen.snap), negativePrompt: regen.snap.negative, characterPrompts: [] }
      }
    }

    const plan: PlanItem[] = []
    let label: string
    if (regen) {
      plan.push({
        offset: 0,
        size: { width: regen.width, height: regen.height },
        ...(regen.sceneId !== undefined
          ? {
              scene: {
                id: regen.sceneId,
                name: regen.sceneName ?? '',
                // 재추첨은 씬 프롬프트 원본을 다시 붙인다 (다시 생성은 보낸 문장에 이미 들어 있다)
                prompt: redraw?.scene?.prompt ?? '',
                negative: redraw?.scene?.negative ?? '',
                reserved: false
              }
            }
          : {})
      })
      label = `${redraw ? '재추첨 생성' : '다시 생성'} · seed ${regen.seed}`
    } else if (sceneIds) {
      const want = new Set(sceneIds)
      // 씬별 출연: 고정 슬롯으로 바꿔 같은 뽑기 엔진을 거친다 (변형도 적용). 라이브러리에서 지워진 캐릭터는 건너뛴다
      const library = useCharacters.getState().characters
      const picked = useScenes.getState().scenes.filter((sc) => want.has(sc.id) && sc.reserve > 0)
      for (const sc of picked) {
        const cast = sc.cast
          ? snapshotCastPlan({
              slots: fixedSlots(
                sc.cast.filter((id) => library.some((c) => c.id === id)),
                sc.castCenters
              )
            })
          : undefined
        for (let i = 0; i < sc.reserve; i++) {
          plan.push({
            scene: { id: sc.id, name: sc.name, prompt: sc.prompt, negative: sc.negative, reserved: true },
            ...(cast ? { cast } : {}),
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
    const fragmentLib = fragmentLibrary()
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
      fragmentLib,
      fragments: fragmentSourceFrom(fragmentLib),
      plan,
      verbatim: !!regen?.sent && !redraw,
      cast: regen ? (redraw?.plan ?? null) : snapshotCastPlan(),
      ...(regen ? {} : { continueSequence: true }),
      ...(regen?.sent?.cast && !redraw ? { castSent: regen.sent.cast } : {})
    }
  }

  /** 배치 하나를 끝까지(또는 멈출 때까지) 돌린다 */
  const runBatch = async (batch: Batch, token: string, signal: AbortSignal): Promise<BatchOutcome> => {
    const settings = useSettings.getState()
    const { base, fixedSeed, source, plan } = batch // ── Phase 5: snap은 장마다 정한다 (아래 루프)
    const caps = modelCapabilities(base.model)
    const count = plan.length
    const generated = new Set<number>()
    set({ phase: 'preparing', total: count, done: 0, failed: 0, error: null, startedAt: Date.now(), currentLabel: batch.label })
    if (settings.background) job.update(`${batch.label} · 준비 중`, 0, count)
    const timing = { count: 0, gaps: 0, waitMs: 0, downloadMs: 0, processMs: 0, gapMs: 0, sentBytes: 0, receivedBytes: 0 }
    // ── Phase 2: 배치(씬마다 따로 뽑기면 씬)마다 이어지는 뽑기 상태와, 이 배치에서 이미 알린 참고 문구.
    // 이어서 생성한 배치는 앱이 죽기 전의 상태에서 이어 간다 (처음부터 뽑으면 순차 조각·슬롯이 앞 장을 되풀이한다)
    const resumeDraw = batch.resumeDraw
    if (resumeDraw) restoreSequentialCounters(resumeDraw.counters)
    else resetSequentialCounters()
    const drawStates = new Map<string, DrawState>(
      resumeDraw ? (JSON.parse(JSON.stringify(resumeDraw.states)) as [string, DrawState][]) : []
    )
    // "배치에 한 번" 순차가 이 배치에서 시작할 자리 — 지금 저장된 자리 (앞 배치들이 넘겨 놓았다).
    // 이어서 생성은 처음 돌 때 읽은 자리 그대로 (그사이 이 배치의 첫 그림이 자리를 넘겼어도 같은 후보로)
    // 되돌리기 세대도 함께 — 그사이 자리를 처음으로 되돌렸거나 백업으로 바꿨으면 이 배치의 그림으로는 넘기지 않는다
    const sequence: { cursors: CastCursors; epoch: number } | undefined =
      batch.continueSequence && !batch.verbatim
        ? resumeDraw
          ? { cursors: cleanCursors(resumeDraw.cursors), epoch: cursorEpochOf({ cursorEpoch: resumeDraw.epoch }) }
          : { cursors: cleanCursors(useCharacters.getState().cursors), epoch: cursorEpochOf() }
        : undefined
    const cursors = sequence?.cursors
    const castNotes = new Set<string>()
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
          await pace(signal)
          try {
            encoded = await encodeVibe(token, v.image, snapshotVibe.infoExtracted, base.model, signal)
          } finally {
            lastResponseAt = performance.now()
          }
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
        // 진행 기록의 열쇠 (이어서 돌리는 배치는 원래 위치)
        const key = item.key ?? i
        let reqId = ''
        // 이 장을 뽑기 전 뽑기 상태 — "보냄"과 함께 남겨, 앱이 죽어도 이어서 생성이 같은 자리에서 이어 뽑는다
        const drawBefore = batch.verbatim ? null : drawSnapshot(drawStates, sequence)
        // ── Phase 5: 프로젝트 장은 그 조합의 프롬프트·캐릭터로 (화면 프롬프트를 통째로 대신) — 아래 base·snap은 이 장의 것
        const { base, snap } = item.project ? projectItemRequest(batch, item.project, item.size) : batch
        const seed =
          fixedSeed === null || !Number.isFinite(fixedSeed)
            ? randomSeed()
            : (fixedSeed + item.offset) % 4294967296
        // 조각(와일드카드)은 장마다 새로 뽑는다. 다시 생성은 이미 치환이 끝난 문장을 그대로 보낸다
        const wild = (text: string): string => (batch.verbatim ? text : processWildcards(text, batch.fragments))
        // ── Phase 2: 출연 슬롯·변형을 장마다 뽑는다 (캡션을 합친 뒤 조각 치환). 씬 출연은 그 씬의 고정 슬롯
        const castPlan = item.cast ?? batch.cast
        const castRes: CastResolution | null = castPlan
          ? resolveCast(
              castPlan,
              drawStateFor(drawStates, castPlan.options, item.scene?.id, cursors),
              Math.random,
              caps.maxCharacters
            )
          : null
        const characterPrompts = castRes
          ? resolvedPrompts(castRes, base.model, wild)
          : base.characterPrompts.map((c) => ({ ...c, prompt: wild(c.prompt), negativePrompt: wild(c.negativePrompt) }))
        let mainPrompt = wild(appendPrompt(base.prompt, item.scene?.prompt ?? ''))
        let countFix: CastSent['countFix']
        if (castRes && castPlan) {
          // 인원 태그(2girls 등)가 실제 캐릭터 수와 다르면 고쳐 보내거나(설정) 배치마다 한 번 알린다
          const fix = castPlan.options.autoCountTags ? fixPeopleCount(mainPrompt, characterPrompts) : null
          if (fix) {
            mainPrompt = fix.prompt
            countFix = { from: fix.from, to: fix.to }
          }
          const check = fix ? null : checkPeopleCount(mainPrompt, characterPrompts.length)
          const notes = [
            ...castRes.notes,
            ...(check?.conflict ? [`인원 태그(${check.tags.join(', ')})와 캐릭터 ${check.actual}명이 맞지 않습니다`] : [])
          ]
          // 같은 문구는 배치에 한 번만 (알림이 한 줄이라 이번 장의 새 문구를 합쳐 띄운다)
          const fresh = notes.filter((n) => !castNotes.has(n) && castNotes.size < 8 && castNotes.add(n))
          if (fresh.length) toast(fresh.join(' · '), true)
        }
        const request: GenerationRequest = {
          ...base,
          ...(item.size ?? {}),
          model,
          seed,
          prompt: mainPrompt,
          negativePrompt: wild(appendPrompt(base.negativePrompt, item.scene?.negative ?? '')),
          characterPrompts,
          // 위치를 하나라도 정했으면 좌표 사용 (씬 출연은 그 씬에 정한 위치, 정하지 않았으면 AI 선택)
          useCoords: characterPrompts.some((c) => c.enabled && c.center)
        }
        const buildOpts: BuildOptions = {
          ...(vibes.length ? { vibes } : {}),
          ...(characterReferences.length ? { characterReferences } : {}),
          ...(i2iBase ? { i2i: { ...i2iBase, extraNoiseSeed: Math.max(0, seed - 1) } } : {})
        }
        const label = item.scene?.name ? ` · ${item.scene.name}` : ''
        const queued = pendingBatches.length ? ` (대기 ${pendingBatches.length})` : ''
        if (settings.background) job.update(`${i + 1}/${count}장 생성 중${label}${queued}`, i, count)

        // 배치의 첫 장도 앞 배치(대기열·이어서 생성)의 마지막 응답 뒤 간격을 둔다 (그다음 장은 아래에서 기다린다)
        if (i === 0) await pace(signal)
        // 재시도 대상은 네트워크 요청뿐 — 응답을 받은 뒤의 저장 오류로 다시 요청(이중 과금)하지 않는다
        projectItemStarted(item) // ── Phase 5
        let result: Awaited<ReturnType<typeof generateImage>> | null = null
        let resultSeq = 0
        for (let attempt = 0; ; attempt++) {
          set({ phase: attempt === 0 ? 'generating' : 'retrying' })
          try {
            // 보내기 전에 "보냄"을 먼저 남긴다 — 응답 전에 앱이 죽으면 이 장은 다시 보내지 않고 확인을 받는다
            reqId = newRequestId()
            await queueStore.sending(
              batch.id,
              key,
              reqId,
              seed,
              drawBefore ? { idx: key, before: drawBefore, after: drawSnapshot(drawStates, sequence) } : undefined
            )
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
            lastResponseAt = performance.now()
            resultSeq = seq
            break
          } catch (e) {
            lastResponseAt = performance.now()
            if (isAbort(e)) throw e
            if (e instanceof StreamInterruptedError) {
              // 생성이 시작된 뒤 끊겼다 — 서버가 이미 그렸을(과금했을) 수 있어 같은 장을 다시 요청하지 않는다
              queueStore.failed(batch.id, key, reqId)
              set((s) => ({
                failed: s.failed + 1,
                error: `${e.message} — 이미 과금됐을 수 있어 이 장은 다시 요청하지 않았습니다`
              }))
              clearPreview(previewSeq)
              projectItemFailed(item) // ── Phase 5
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
            queueStore.failed(batch.id, key, reqId)
            projectItemFailed(item) // ── Phase 5
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
          // 그림이 나왔다 — 이 장이 쓴 "배치에 한 번" 순차를 다음 배치는 다음 차례부터 (그림이 하나도 안 나온 배치는 넘기지 않는다)
          if (sequence && castRes) useCharacters.getState().commitCursors(castRes.advance, sequence.epoch)
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
                // 이번 장에 뽑힌 캐릭터(조각 치환 전)로 기록해야 "설정 적용"이 같은 출연을 되살린다.
                // 슬롯 설정·캐릭터 원문(씬이면 씬 프롬프트 원문)도 남겨 "재추첨 생성"이 같은 조건으로 다시 뽑게 한다
                snap:
                  castRes && castPlan
                    ? {
                        ...snap,
                        chars: castRes.chars.map((c) => ({
                          name: c.name,
                          prompt: c.prompt,
                          negative: c.negative,
                          ...(c.center ? { center: c.center } : {})
                        })),
                        cast: {
                          plan: castPlan,
                          ...(item.scene ? { scene: { prompt: item.scene.prompt, negative: item.scene.negative } } : {})
                        }
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
                    })),
                  ...(castRes ? { cast: castSent(castRes, countFix) } : batch.castSent ? { cast: batch.castSent } : {})
                },
                ...(item.scene ? { sceneId: item.scene.id, sceneName: item.scene.name } : {}),
                ...(item.project ? { project: item.project.tag } : {}), // ── Phase 5: 분류 표시
                ...(kind !== 't2i' && source.originId !== null ? { parentId: source.originId } : {}),
                requestId: reqId
              },
              image
            )
            queueStore.done(batch.id, key, reqId, id)
            primeImageUrl(id, image)
            // ── Phase 5: 히스토리에 들어간 그림을 조합에 넣는다
            projectItemLanded(item, { id, ts: Date.now(), seed, width: request.width, height: request.height, mime: image.type })
            set((s) => ({ done: s.done + 1, latestId: id, error: null }))
            // 완성본이 결과 화면에 올라간 뒤에 미리보기를 거둔다 (그 사이 다음 장 미리보기가 왔으면 그대로 둔다)
            clearPreview(resultSeq)
            if (settings.autoSave) {
              const folder = settings.sceneFolders ? item.scene?.name || undefined : undefined
              const fileName = fileNameFor(id, seed, image.type)
              void saveHistoryImageToGallery(id, image, fileName, folder)
                .then(() => useHistory.getState().markSaved(id, `${folder ? `${cleanFileName(folder)}/` : ''}${fileName}`))
                .catch((e: Error) => set({ error: `갤러리 저장 실패: ${e.message}` }))
            }
            // V5는 할당량 게이지가 장마다 줄어드는 것이 보이도록 매번, 그 밖에는 10장마다 잔액을 새로 읽는다
            if (isV5Model(base.model) || (i + 1) % 10 === 0) void useSettings.getState().refreshSubscription()
            timing.processMs += performance.now() - received
          })()
          // 중지로 기다림이 먼저 끝난 뒤 저장이 실패해도 처리되지 않은 오류로 남지 않게 한다
          post.catch(() => projectItemFailed(item)) // ── Phase 5: 저장 실패면 그 장은 실패 (그 밖에는 그대로 무시)
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
    skipCurrent = false
    for (let batch: Batch | undefined = first; batch; batch = pendingBatches.shift()) {
      syncQueue()
      controller = new AbortController()
      current = batch
      last = await runBatch(batch, token, controller.signal)
      current = null
      // 끝났거나 멈춘 배치는 기록에서 지운다 (못 뽑은 씬 장은 runBatch가 예약으로 돌려줬다)
      void queueStore.drop(batch.id)
      batches++
      totalDone += get().done
      totalFailed += get().failed
      // 이 배치만 취소한 경우(프로젝트 삭제) 대기열은 이어서 돈다
      const skipped = last === 'stopped' && skipCurrent
      skipCurrent = false
      if (skipped) {
        last = 'done'
        continue
      }
      if (last !== 'done') break
    }
    controller = null
    skipCurrent = false
    // 멈췄거나 막혔으면 남은 대기열은 취소하고 씬 예약을 돌려준다
    for (const rest of pendingBatches.splice(0)) {
      release(rest.plan)
      void queueStore.drop(rest.id)
    }
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
      for (const rest of pendingBatches.splice(0)) {
        release(rest.plan)
        void queueStore.drop(rest.id)
      }
      syncQueue()
      skipCurrent = false
      controller?.abort()
    },
    removeQueued: (id) => {
      const i = pendingBatches.findIndex((b) => b.id === id)
      if (i < 0) return
      const [removed] = pendingBatches.splice(i, 1)
      release(removed.plan)
      void queueStore.drop(removed.id)
      syncQueue()
    },
    cancelProject: (projectId) => {
      let n = 0
      for (let i = pendingBatches.length - 1; i >= 0; i--) {
        const b = pendingBatches[i]
        if (!hasProject(b.plan, projectId)) continue
        pendingBatches.splice(i, 1)
        n += b.plan.length
        release(b.plan)
        void queueStore.drop(b.id)
      }
      syncQueue()
      if (current && controller && hasProject(current.plan, projectId)) {
        n += Math.max(0, get().total - get().done - get().failed)
        skipCurrent = true
        controller.abort()
      }
      return n
    },
    // ── Phase 5: 미리 만든 배치 — buildBatch 대신 받은 배치를 그대로 runQueue/대기열에 (간격·중지·대기열 취소는 같다)
    enqueueBatches: async (batches) => {
      if (!batches.length) return
      const token = useSettings.getState().token
      if (!token) {
        for (const b of batches) release(b.plan)
        set({ error: 'API 토큰을 먼저 설정해 주세요 (설정 탭)' })
        return
      }
      // 배치는 id로 찾고(취소·대기열 저장) 지운다 — 대기·실행 중인 배치와 겹치면 새 id를 준다 (아직 저장 전이라 바꿔도 된다)
      const taken = new Set([...pendingBatches.map((b) => b.id), ...(current ? [current.id] : [])])
      for (const b of batches) {
        if (taken.has(b.id)) b.id = uid()
        taken.add(b.id)
      }
      const images = batches.reduce((n, b) => n + b.plan.length, 0)
      // start와 같이: 저장 공간을 묻고, 앱이 죽어도 이어서 할 수 있게 배치를 저장한다.
      // 공간 확인을 기다리는 사이 다른 "생성"이 시작될 수 있어, 대기열에 넣은 뒤 아무도 돌리지 않을 때만 직접 돌린다
      const fresh = !get().running && !preparingFresh
      if (fresh) preparingFresh = true
      let warning: string | null = null
      try {
        warning = await lowSpaceWarning(images)
      } catch {
        warning = null
      }
      const declined = !!warning && !window.confirm(warning)
      if (fresh) preparingFresh = false
      if (declined) for (const b of batches) release(b.plan)
      else {
        for (const b of batches) void queueStore.save(b)
        pendingBatches.push(...batches)
        syncQueue()
      }
      if (get().running || preparingFresh) {
        if (!declined) toast(`대기열에 추가했습니다 — 배치 ${batches.length}개 · ${images}장`)
        return
      }
      const first = pendingBatches.shift()
      if (first) await runQueue(first, token)
    },
    start: async (opts) => {
      const token = useSettings.getState().token
      if (!token) return set({ error: 'API 토큰을 먼저 설정해 주세요 (설정 탭)' })
      // 공간 확인을 기다리는 동안은 아직 running이 아니라 버튼이 "생성" 그대로다 — 그 사이 두 번 눌려도
      // 배치가 두 번(두 배 비용) 들어가지 않게 막는다. 생성 중 대기열 추가는 누를 때마다 넣는 게 맞다
      const fresh = !get().running
      if (fresh && preparingFresh) return
      const batch = buildBatch(opts)
      if (typeof batch === 'string') {
        if (get().running) toast(batch, true)
        else set({ error: batch })
        return
      }
      // 저장 공간이 모자랄 것 같으면 묻는다 (설정은 이미 누른 순간의 것으로 묶였다)
      if (fresh) preparingFresh = true
      let warning: string | null = null
      try {
        warning = await lowSpaceWarning(batch.plan.length)
      } catch {
        warning = null
      } finally {
        if (fresh) preparingFresh = false
      }
      if (warning && !window.confirm(warning)) {
        release(batch.plan)
        return
      }
      // 앱이 죽어도 이어서 할 수 있게 배치를 저장한다 (첫 장의 "보냄" 기록보다 먼저 쓰인다)
      void queueStore.save(batch)
      if (get().running) {
        pendingBatches.push(batch)
        syncQueue()
        toast(`대기열에 추가했습니다 — ${pendingBatches.length}번째 (${batch.label})`)
        return
      }
      await runQueue(batch, token)
    },
    resume: async (entries, withUncertain) => {
      const token = useSettings.getState().token
      if (!token) return set({ error: 'API 토큰을 먼저 설정해 주세요 (설정 탭)' })
      const batches: Batch[] = []
      for (const e of entries) {
        // 이미 돌거나 대기 중인 배치는 다시 넣지 않는다 (같은 장을 두 번 보내게 된다)
        if (current?.id === e.batch.id || pendingBatches.some((b) => b.id === e.batch.id)) continue
        const extra = withUncertain ? e.uncertain.map((u) => u.item) : []
        // 다시 보내지 않기로 한 "확인 필요" 장은 다음에 또 묻지 않게 표시해 둔다
        if (!withUncertain && e.uncertain.length) await queueStore.skip(e.batch.id, e.uncertain.map((u) => u.key))
        const plan = [...e.remaining, ...extra].sort((a, b) => (a.key ?? 0) - (b.key ?? 0))
        if (!plan.length) {
          void queueStore.drop(e.batch.id)
          continue
        }
        queueStore.resumed(e.batch.id)
        // 이어서 뽑을 씬 장은 다시 이 배치가 가져간 것으로 표시한다 (예약은 처음 누를 때 이미 0으로 줄었다)
        for (const item of plan) if (item.scene?.reserved) claim(item.scene.id, 1)
        projectItemsQueued(plan) // ── Phase 5: 다시 돌릴 프로젝트 장만 대기로 센다 (다시 보내지 않는 "확인 필요" 장은 빼고)
        const resumeDraw = resumeDrawFor(e.draw, plan)
        batches.push({ ...e.batch, label: `${e.batch.label} · 이어서`, plan, ...(resumeDraw ? { resumeDraw } : {}) })
      }
      if (!batches.length) return
      if (get().running) {
        pendingBatches.push(...batches)
        syncQueue()
        toast(`이어서 할 배치 ${batches.length}개를 대기열에 넣었습니다`)
        return
      }
      const [first, ...rest] = batches
      pendingBatches.push(...rest)
      await runQueue(first, token)
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
