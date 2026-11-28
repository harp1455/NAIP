/**
 * 생성 대기열 ↔ 에셋 프로젝트 연결 — stores/generation.ts의 배치 실행이 부르는 갈고리.
 *
 * 계획 한 칸(PlanItem)에 project가 있으면 그 장의 진행을 프로젝트 조합에 알린다:
 *   대기열에 넣을 때 markQueued (run.ts) → 요청 시작 markStarted → 히스토리에 들어가면 addImage
 *   → 실패 markFailed. 시작하지 못한 장(멈춤·취소·막힘)은 releaseQueued, 시작했는데 멈춘 장은 cancelStarted.
 * 칸마다 지금 상태를 WeakMap에 기억해 같은 장을 두 번 세지 않는다 — 배치·계획 칸은 순수 JSON 그대로 둔다
 * (대기열 저장이 직렬화할 수 있게). 다시 불러온 칸은 상태가 없으니 "아직 시작 안 함"으로 본다.
 */
import type { HistoryMeta, SettingsSnapshot } from '../lib/db'
import type { CharacterPromptInput, GenerationRequest } from '../nai/types'
import type { NewAssetImage } from './curation'
import { addedInThisRun, useProjects } from './store'
import type { Project, ProjectImageTag } from './types'

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
/** 다시 불러온 칸 중 이미 대기로 센 것 (앱을 열 때 한 번, 이어서 생성할 때 또 세지 않게) */
const counted = new WeakSet<object>()

/** 이 장의 요청 바탕과 기록용 설정 — 배치의 것을 프로젝트 장 내용으로 바꾼다 */
export function projectItemRequest(
  batch: { base: GenerationRequest; snap: SettingsSnapshot },
  p: ProjectPlanItem,
  /** 이 장의 해상도 — 한 배치에 해상도가 다른 조합이 섞여 있어 기록(snap.params)도 이 장의 것으로 */
  size?: { width: number; height: number }
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
      ...(size ? { params: { ...batch.snap.params, width: size.width, height: size.height } } : {}),
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
  const s = useProjects.getState()
  const current = s.projects.find((x) => x.id === p.tag.projectId)?.items[p.tag.key]
  if (fromQueue && current?.images.some((i) => i.id === image.id)) {
    // 앱을 연 뒤 늦게 돈 빠진 그림 찾기(adoptTaggedImages)가 히스토리 저장과 이 기록 사이에 이 그림을 먼저 넣었다 —
    // 그쪽은 장수를 건드리지 않으므로, 그림은 그대로 두고 이 장의 생성 중(없으면 대기) 장수만 돌려준다
    const generating = current.generating > 0 ? 1 : 0
    const queued = generating === 0 && current.queued > 0 ? 1 : 0
    if (generating || queued) s.releaseRuntime(p.tag.projectId, [{ key: p.tag.key, queued, generating }])
    return
  }
  s.addImage(p.tag.projectId, p.tag.key, image, { fromQueue })
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
  // 프로젝트마다 한 번에 바꾼다 — 장마다 바꾸면 그때마다 프로젝트 전체를 저장해 큰 계획을 멈출 때 화면이 몇 초씩 멈춘다
  const byProject = new Map<string, Map<string, { queued: number; generating: number }>>()
  for (const item of items) {
    const p = item.project
    if (!p) continue
    const state = states.get(item)
    if (state !== undefined && state !== 'started') continue
    states.set(item, state === undefined ? 'released' : 'cancelled')
    const keys = byProject.get(p.tag.projectId) ?? new Map<string, { queued: number; generating: number }>()
    const d = keys.get(p.tag.key) ?? { queued: 0, generating: 0 }
    if (state === undefined) d.queued++
    else d.generating++
    keys.set(p.tag.key, d)
    byProject.set(p.tag.projectId, keys)
  }
  for (const [projectId, keys] of byProject) {
    useProjects.getState().releaseRuntime(projectId, [...keys].map(([key, d]) => ({ key, ...d })))
  }
}

/**
 * 다시 돌릴 장을 대기로 센다 — 앱을 다시 열면 대기 장수가 0으로 돌아가므로, 저장된 대기열을 읽을 때(loadResume)
 * 보내지 않은 장을, 이어서 돌릴 때(resume) 다시 보내기로 한 "확인 필요" 장을 센다. 같은 칸은 한 번만 센다.
 * 다시 보내지 않기로 한 "확인 필요" 장은 넘기지 않는다 (그래야 두 번 세지 않는다)
 */
export function projectItemsQueued(items: readonly Carrier[]): void {
  const byProject = new Map<string, Map<string, number>>()
  for (const item of items) {
    const p = item.project
    if (!p || states.has(item) || counted.has(item)) continue
    counted.add(item)
    const keys = byProject.get(p.tag.projectId) ?? new Map<string, number>()
    keys.set(p.tag.key, (keys.get(p.tag.key) ?? 0) + 1)
    byProject.set(p.tag.projectId, keys)
  }
  for (const [projectId, keys] of byProject) {
    useProjects.getState().markQueued(projectId, [...keys].map(([key, count]) => ({ key, count })))
  }
}

/**
 * 프로젝트 기록에서 빠졌을 수 있는 생성 그림을 찾을 시작점 — 디스크에서 읽은 프로젝트 기록에 있는 가장 새 그림 id
 * (없으면 가장 먼저 만든 프로젝트의 생성 시각). 프로젝트 기록(localStorage)은 통째로 저장되므로, 저장되기 전에 앱이 죽어
 * 빠진 생성 그림은 저장된 가장 새 그림보다 나중 것이다 (그림 id = 만든 시각). 이번 실행에 넣은 그림은 세지 않는다 —
 * 늦게 돈 찾기 전에 들어온 새 그림이 지난 실행에 빠진 그림을 가린다. 분류로 넣은 그림(id가 오래됐다)은 따로 적어 두고
 * 찾는다 (storage/history-repo.ts noteAssigned). 프로젝트가 없으면 null
 */
export function adoptCutoff(): number | null {
  const { projects } = useProjects.getState()
  if (!projects.length) return null
  let newest = 0
  let oldestProject = Infinity
  for (const p of projects) {
    oldestProject = Math.min(oldestProject, p.createdAt)
    for (const it of Object.values(p.items)) {
      for (const img of it.images) if (!addedInThisRun(img.id)) newest = Math.max(newest, img.id)
    }
  }
  return Math.max(newest, Number.isFinite(oldestProject) ? oldestProject - 1 : 0)
}

/**
 * 히스토리에 분류 표시와 함께 들어갔는데 프로젝트에는 아직 없는 그림을 넣는다 (같은 id는 그대로).
 * 앱이 히스토리에 저장한 직후 죽어 프로젝트 기록이 빠진 경우 — 대기열을 다시 열 때(loadResume) 부른다. 넣은 그림 id를 돌려준다
 */
export function adoptTaggedImages(metas: readonly HistoryMeta[]): number[] {
  const added: number[] = []
  const s = useProjects.getState()
  // 프로젝트마다 이미 든 그림 (모든 칸) — 조합 키가 옮겨져(carryItemKeys) 다른 칸에 든 그림을 분류 표시의 옛 키로
  // 다시 넣으면 같은 그림이 두 칸에 든다
  const known = new Map<string, Set<number>>()
  const imagesIn = (p: Project): Set<number> => {
    let ids = known.get(p.id)
    if (!ids) {
      ids = new Set(Object.values(p.items).flatMap((i) => i.images.map((img) => img.id)))
      known.set(p.id, ids)
    }
    return ids
  }
  for (const m of metas) {
    const tag = m.project
    if (!tag) continue
    const project = s.projects.find((p) => p.id === tag.projectId)
    if (!project || imagesIn(project).has(m.id)) continue
    s.addImage(tag.projectId, tag.key, { id: m.id, ts: m.ts, seed: m.seed, width: m.width, height: m.height, mime: m.mime }, { fromQueue: false })
    imagesIn(project).add(m.id)
    added.push(m.id)
  }
  return added
}
