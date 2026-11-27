/**
 * 에셋 프로젝트 → 생성 대기열 (화면이 부르는 곳).
 * 계획(planJobs)의 작업을 배치로 바꿔(batches.ts) 대기 장수를 표시하고(markQueued) 대기열에 넣는다.
 * 진행(시작·완료·실패·되돌림)은 stores/generation.ts가 queue.ts 갈고리로 알린다.
 */
import { referencesForModel } from '../nai/reference'
import { useCharacters } from '../stores/characters'
import { fragmentSource } from '../stores/fragments'
import { useGeneration } from '../stores/generation'
import { useRefs, vibeKey } from '../stores/refs'
import { useSettings } from '../stores/settings'
import { jobsToBatches } from './batches'
import {
  buildJob,
  estimateJobs,
  expandMatrix,
  secondsPerImageFrom,
  type EstimateContext,
  type GenerationJob,
  type PlanEstimate
} from './matrix'
import { useProjects } from './store'
import type { Project } from './types'

export interface EnqueueResult {
  batches: number
  images: number
  notes: string[]
}

/** 작업들을 대기열에 넣는다. 넣을 수 없으면 이유(문자열) */
export function enqueueJobs(project: Project, jobs: readonly GenerationJob[]): EnqueueResult | string {
  const live = jobs.filter((j) => j.count > 0)
  if (!live.length) return '생성할 장이 없습니다'
  if (!useSettings.getState().token) return 'API 토큰을 먼저 설정해 주세요 (설정 탭)'
  const refs = useRefs.getState()
  const built = jobsToBatches(project.slug?.trim() || project.name, live, {
    library: useCharacters.getState().characters,
    vibes: refs.vibes,
    charRefs: refs.charRefs,
    fragments: fragmentSource()
  })
  // 대기 장수를 먼저 — 대기열은 넣자마자 첫 장을 시작할 수 있다
  useProjects.getState().markQueued(
    project.id,
    live.map((j) => ({ key: j.key, count: j.count }))
  )
  void useGeneration.getState().enqueueBatches(built.batches)
  return { batches: built.batches.length, images: built.images, notes: built.notes }
}

/** 한 조합을 n장 더 */
export function enqueueCombo(project: Project, key: string, count: number): EnqueueResult | string {
  const combo = expandMatrix(project, { keys: [key] }).combos[0]
  if (!combo) return '이 조합은 지금 행렬에 없습니다 (축 값이 꺼졌거나 제외됨)'
  return enqueueJobs(project, [buildJob(project, combo, Math.max(1, Math.floor(count)))])
}

/** 예상에 쓸 계정·레퍼런스 정보 (구독 정보·지난 배치 속도) */
export function estimateContext(project: Project): EstimateContext {
  const sub = useSettings.getState().subscription
  const refs = useRefs.getState()
  const model = project.params.model
  return {
    isOpus: sub?.tier === 'opus',
    ...(sub?.usage ? { opusUsageExhausted: sub.usage.isNegative } : {}),
    secondsPerImage: secondsPerImageFrom(useGeneration.getState().lastBatch),
    references: refs.charRefs.map((r) => ({ id: r.id, type: r.type, ...(r.sameOutfit !== undefined ? { sameOutfit: r.sameOutfit } : {}) })),
    unencodedVibeIds: refs.vibes.filter((v) => !v.encodings[vibeKey(model, v.infoExtracted)]).map((v) => v.id)
  }
}

export function estimateFor(project: Project, jobs: readonly GenerationJob[]): PlanEstimate {
  return estimateJobs(jobs, estimateContext(project))
}

/** 계획에 쓰인 바이브·레퍼런스 중 지금 모델이 받지 않거나 지워진 것 (경고용) */
export function referenceNotes(project: Project): string[] {
  const refs = useRefs.getState()
  const notes: string[] = []
  const ids = new Set([...project.refIds, ...project.characters.flatMap((c) => c.refIds)])
  const vibeIds = new Set([...project.vibeIds, ...project.characters.flatMap((c) => c.vibeIds)])
  const missingRefs = [...ids].filter((id) => !refs.charRefs.some((r) => r.id === id)).length
  const missingVibes = [...vibeIds].filter((id) => !refs.vibes.some((v) => v.id === id)).length
  if (missingRefs) notes.push(`지워진 정밀 레퍼런스 ${missingRefs}개는 빼고 보냅니다`)
  if (missingVibes) notes.push(`지워진 바이브 ${missingVibes}개는 빼고 보냅니다`)
  const chosen = refs.charRefs.filter((r) => ids.has(r.id)).map((r) => ({ ...r, enabled: true }))
  const usable = referencesForModel(chosen, project.params.model).length
  if (chosen.length > usable) notes.push(`이 모델은 정밀 레퍼런스 ${chosen.length - usable}개를 받지 않아 빼고 보냅니다`)
  return notes
}
