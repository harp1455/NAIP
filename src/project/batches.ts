/**
 * 생성 작업(GenerationJob) → 생성 대기열 배치 (순수 함수 — 저장소·화면과 무관해 시험할 수 있다).
 *
 * - 프로젝트 프롬프트가 화면 프롬프트를 통째로 대신한다 (덧붙이지 않음). 장마다 계획 칸에 프롬프트를 담는다
 * - 캐릭터 프롬프트 = 라이브러리 캐릭터의 고정·가변·디테일 칸 + 조합 조각 (변형 그룹은 쓰지 않는다 —
 *   의상·표정은 프로젝트 축이 정한다). 라이브러리에서 지워졌으면 조합 조각만
 * - 해상도는 작업의 것, 그 밖의 설정은 job.params, 바이브·레퍼런스는 refs 저장소의 그 id들
 * - 레퍼런스는 배치마다 한 번 준비하므로 캐릭터(= 바이브·레퍼런스 묶음)마다 배치 하나, 1장 = 계획 칸 하나
 * - 대기 중에 라이브러리·레퍼런스를 고쳐도 누른 순간의 내용대로 돌도록 여기서 모두 복사해 둔다
 */
import type { SettingsSnapshot } from '../lib/db'
import { composeCaption, type CastCharacter } from '../nai/cast'
import type { FragmentSource } from '../nai/fragments'
import { modelCapabilities } from '../nai/models'
import type { GenerationRequest } from '../nai/types'
import type { CharRef, Vibe } from '../stores/refs'
import type { QueueBatch, QueuePlanItem } from '../stores/generation'
import { joinPrompt, type GenerationJob } from './matrix'
import type { ProjectPlanItem } from './queue'

export interface BatchContext {
  /** 캐릭터 라이브러리 (stores/characters) */
  library: readonly CastCharacter[]
  vibes: readonly Vibe[]
  charRefs: readonly CharRef[]
  fragments: FragmentSource
  /** 배치 id (기본: 1부터) */
  newId?: () => number
}

export interface BuiltBatches {
  batches: QueueBatch[]
  images: number
  /** 화면에 알릴 참고 (지워진 캐릭터·레퍼런스 등, 같은 문구는 한 번) */
  notes: string[]
}

/** 라이브러리 캐릭터의 캡션 (변형 그룹 없이). 없으면 null */
export function libraryCaption(
  libraryId: number | null,
  library: readonly CastCharacter[]
): { prompt: string; negative: string } | null {
  if (libraryId === null) return null
  const c = library.find((x) => x.id === libraryId)
  if (!c) return null
  return { prompt: composeCaption(c, []), negative: c.negative.trim() }
}

/** 작업 하나의 장 내용 (모든 장이 같다 — 조각 치환·시드는 장마다 대기열이) */
export function projectPlanItem(job: GenerationJob, library: readonly CastCharacter[], notes?: Set<string>): ProjectPlanItem {
  const characters: ProjectPlanItem['characters'] = []
  if (job.character) {
    const lib = libraryCaption(job.character.libraryId, library)
    if (job.character.libraryId !== null && !lib) {
      notes?.add(`"${job.character.name}" 캐릭터가 라이브러리에서 지워져 프로젝트 조각만 보냅니다`)
    }
    const prompt = joinPrompt(lib?.prompt, job.characterPrompt)
    const negative = joinPrompt(lib?.negative, job.characterNegative)
    if (prompt) characters.push({ name: job.character.name, prompt, negative })
    else notes?.add(`"${job.character.name}" 캐릭터 프롬프트가 비어 캐릭터 없이 보냅니다`)
  }
  return { tag: job.tag, label: job.label, prompt: job.prompt, negative: job.negative, characters }
}

/** 배치를 나누는 열쇠 — 캐릭터 + 바이브·레퍼런스 + (해상도를 뺀) 설정이 같으면 한 배치 */
function groupKey(job: GenerationJob): string {
  const { width: _w, height: _h, ...rest } = job.params
  void _w
  void _h
  return JSON.stringify([job.character?.id ?? '', [...job.vibeIds].sort(), [...job.refIds].sort(), rest])
}

export function jobsToBatches(projectName: string, jobs: readonly GenerationJob[], ctx: BatchContext): BuiltBatches {
  let seq = 0
  const newId = ctx.newId ?? (() => ++seq)
  const notes = new Set<string>()
  const groups = new Map<string, GenerationJob[]>()
  for (const job of jobs) {
    if (job.count <= 0) continue
    const k = groupKey(job)
    const list = groups.get(k)
    if (list) list.push(job)
    else groups.set(k, [job])
  }
  const batches: QueueBatch[] = []
  let images = 0
  for (const list of groups.values()) {
    const first = list[0]
    const caps = modelCapabilities(first.params.model)
    const vibes = caps.vibes
      ? first.vibeIds.flatMap((id) => {
          const v = ctx.vibes.find((x) => x.id === id)
          if (!v) notes.add('지워진 바이브가 있어 빼고 보냅니다')
          return v ? [{ ...v, encodings: { ...v.encodings }, enabled: true }] : []
        })
      : []
    if (!caps.vibes && first.vibeIds.length) notes.add('이 모델은 바이브를 받지 않아 빼고 보냅니다')
    const charRefs = first.refIds.flatMap((id) => {
      const r = ctx.charRefs.find((x) => x.id === id)
      if (!r) notes.add('지워진 정밀 레퍼런스가 있어 빼고 보냅니다')
      // 프로젝트가 고른 레퍼런스는 저장소에서 꺼 두었어도 쓴다
      return r ? [{ ...r, enabled: true }] : []
    })
    const plan: QueuePlanItem[] = []
    for (const job of list) {
      const project = projectPlanItem(job, ctx.library, notes)
      for (let k = 0; k < job.count; k++) {
        // 장마다 따로 복사 — 계획 칸마다 진행 상태를 따로 센다 (queue.ts)
        plan.push({ offset: k, size: { width: job.width, height: job.height }, project: { ...project, characters: project.characters.map((c) => ({ ...c })) } })
      }
    }
    images += plan.length
    const base: GenerationRequest = {
      ...first.params,
      prompt: first.prompt,
      negativePrompt: first.negative,
      seed: 0,
      characterPrompts: [],
      useCoords: false
    }
    const snap: SettingsSnapshot = {
      base: first.prompt,
      additional: '',
      detail: '',
      negative: first.negative,
      params: { ...first.params },
      chars: []
    }
    const who = first.character?.name ?? '공통'
    batches.push({
      id: newId(),
      label: `${projectName} · ${who} · ${plan.length}장`,
      base,
      snap,
      fixedSeed: null,
      source: { image: null, mask: null, strength: 0.7, noise: 0, originId: null },
      vibes,
      charRefs,
      fragments: ctx.fragments,
      plan,
      verbatim: false,
      cast: null
    })
  }
  return { batches, images, notes: [...notes] }
}
