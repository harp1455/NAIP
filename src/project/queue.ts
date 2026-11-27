/**
 * 생성 대기열 ↔ 에셋 프로젝트 연결 — stores/generation.ts의 배치 실행이 부르는 갈고리.
 *
 * 계획 한 칸(PlanItem)에 project가 있으면 그 장의 진행을 프로젝트 조합에 알린다:
 *   대기열에 넣을 때 markQueued (run.ts) → 요청 시작 markStarted → 히스토리에 들어가면 addImage
 *   → 실패 markFailed. 시작하지 못한 장(멈춤·취소·막힘)은 releaseQueued, 시작했는데 멈춘 장은 cancelStarted.
 * 칸마다 지금 상태를 WeakMap에 기억해 같은 장을 두 번 세지 않는다 — 배치·계획 칸은 순수 JSON 그대로 둔다
 * (대기열 저장이 직렬화할 수 있게). 다시 불러온 칸은 상태가 없으니 "아직 시작 안 함"으로 본다.
 */
import type { SettingsSnapshot } from '../lib/db'
import type { CharacterPromptInput, GenerationRequest } from '../nai/types'
import type { NewAssetImage } from './curation'
import { useProjects } from './store'
import type { ProjectImageTag } from './types'

/** 프로젝트 장 하나에 붙는 내용 (순수 JSON) */
export interface ProjectPlanItem {
  tag: ProjectImageTag
  /** 조합 이름 (예: 민지 · 교복 · 웃음) */
  label: string
  /** 이 장의 메인 프롬프트·네거티브 — 화면 프롬프트를 통째로 대신한다 (조각 치환 전) */
  prompt: string
  negative: string
  /** 보낼 캐릭터 (라이브러리 캡션 + 조합 조각, 조각 치환 전) */
  characters: { name: string; prompt: string; negative: string }[]
}

type Carrier = { project?: ProjectPlanItem }
type ItemState = 'started' | 'landed' | 'failed' | 'released' | 'cancelled'

const states = new WeakMap<object, ItemState>()

/** 이 장의 요청 바탕과 기록용 설정 — 배치의 것을 프로젝트 장 내용으로 바꾼다 */
export function projectItemRequest(
  batch: { base: GenerationRequest; snap: SettingsSnapshot },
  p: ProjectPlanItem
): { base: GenerationRequest; snap: SettingsSnapshot } {
  const characterPrompts: CharacterPromptInput[] = p.characters.map((c) => ({
    prompt: c.prompt,
    negativePrompt: c.negative,
    enabled: true,
    name: c.name
  }))
  return {
    base: { ...batch.base, prompt: p.prompt, negativePrompt: p.negative, characterPrompts, useCoords: false },
    snap: {
      ...batch.snap,
      base: p.prompt,
      additional: '',
      detail: '',
      negative: p.negative,
      chars: p.characters.map((c) => ({ name: c.name, prompt: c.prompt, negative: c.negative }))
    }
  }
}

/** 요청을 시작한다 (재시도는 같은 장이라 한 번만 센다) */
export function projectItemStarted(item: Carrier): void {
  const p = item.project
  if (!p || states.has(item)) return
  states.set(item, 'started')
  useProjects.getState().markStarted(p.tag.projectId, p.tag.key)
}

/** 그림이 히스토리에 들어갔다 */
export function projectItemLanded(item: Carrier, image: NewAssetImage): void {
  const p = item.project
  if (!p) return
  const state = states.get(item)
  if (state === 'landed') return
  states.set(item, 'landed')
  // 멈춘 뒤에 늦게 도착한 장은 이미 생성 중 장수를 되돌렸다 — 그림만 넣는다
  const fromQueue = state === 'started' || state === undefined
  useProjects.getState().addImage(p.tag.projectId, p.tag.key, image, { fromQueue })
}

/** 이 장은 실패했다 (시작한 장만) */
export function projectItemFailed(item: Carrier): void {
  const p = item.project
  if (!p || states.get(item) !== 'started') return
  states.set(item, 'failed')
  useProjects.getState().markFailed(p.tag.projectId, p.tag.key)
}

/**
 * 뽑지 못한 장을 돌려준다 (멈춤·대기열 취소·막힘). 시작 전이면 대기 장수를, 시작했으면 생성 중 장수를 줄인다.
 * 이미 끝난 장(그림·실패)은 그대로 — 여러 번 불러도 한 번만 센다
 */
export function releaseProjectItems(items: readonly Carrier[]): void {
  for (const item of items) {
    const p = item.project
    if (!p) continue
    const state = states.get(item)
    if (state === undefined) {
      states.set(item, 'released')
      useProjects.getState().releaseQueued(p.tag.projectId, p.tag.key, 1)
    } else if (state === 'started') {
      states.set(item, 'cancelled')
      useProjects.getState().cancelStarted(p.tag.projectId, p.tag.key)
    }
  }
}
