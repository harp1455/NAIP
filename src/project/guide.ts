/**
 * 프로젝트 안내 — 지금 프로젝트가 어느 단계(새 프로젝트 → 축과 값 → 생성 → 선별 → 내보내기)에 있고
 * 다음에 무엇을 하면 되는지, 이어서 고를 조합 목록, 축 값마다 진행. 화면은 이것을 그대로 보여 주기만 한다.
 * 모두 읽기만 하는 순수 함수다 (프로젝트를 바꾸지 않는다).
 */
import { curationCounts, itemStatus } from './curation'
import { expandMatrix, missingFor, type Combination, type MatrixResult } from './matrix'
import type { AssetItem, Project } from './types'

/** 안내 단계 이름 (1부터) */
export const GUIDE_STEPS = ['새 프로젝트', '축과 값', '생성', '선별', '내보내기'] as const

/** 다음에 할 일 */
export type NextAction =
  /** 캐릭터도 축 값도 없다 */
  | { kind: 'setup' }
  /** 조합이 너무 많아 펼치지 못했다 */
  | { kind: 'tooMany' }
  /** 아직 아무것도 만들지 않았다 — 조합 n개를 생성 */
  | { kind: 'generate'; combos: number }
  /** 생성 대기·생성 중 n장 */
  | { kind: 'running'; images: number }
  /** 고를 그림이 남은 조합 n개 (미선별 그림 images장) */
  | { kind: 'review'; combos: number; images: number }
  /** 그림이 모자란 조합 n개 — 채택 + 대기·생성 중 + 고르지 않은 그림이 목표에 못 미침 ("부족한 것만", 고르지 않은 그림도 채운 것으로) */
  | { kind: 'missing'; combos: number }
  /** 채택은 찼지만 "재생성 필요"로 표시한 조합 n개 ("실패한 것만" 계획) */
  | { kind: 'redo'; combos: number }
  /** 채택했지만 아직 내보내지 않은 그림 n장 */
  | { kind: 'export'; images: number }
  /** 모든 조합을 채택하고 내보냈다 */
  | { kind: 'done' }

/**
 * 단계 막대 한 칸 — done: 끝남, now: 지금 할 단계(하나), doing: 아직 남았지만 지금 할 단계는 아님
 * (선별할 조합이 있어도 미생성 조합이 남았으면 생성은 끝난 것이 아니다), todo: 아직
 */
export type StepState = 'done' | 'now' | 'doing' | 'todo'

export interface ProjectGuide {
  /** 지금 단계 (1~5, 모두 끝나면 6) */
  step: number
  /** 단계 막대 다섯 칸 (GUIDE_STEPS 순서) */
  steps: StepState[]
  /** 다음에 할 일 — 첫째가 가장 먼저 할 일, 둘째는 함께 보여 줄 다른 일 (최대 2개) */
  actions: NextAction[]
}

/** 채택했지만 아직 내보내지 않은 그림 수 (행렬 안 조합만 — 내보내기 미리보기와 같은 범위) */
export function unexportedAdopted(project: Project, combos: readonly Combination[]): number {
  let n = 0
  for (const c of combos) for (const img of project.items[c.key]?.images ?? []) if (img.mark === 'adopted' && !img.exported) n++
  return n
}

/** 지금 단계와 다음에 할 일. 이미 펼친 행렬이 있으면 넘겨서 다시 펼치지 않게 (선택 없이 펼친 것) */
export function projectGuide(project: Project, matrix: MatrixResult = expandMatrix(project)): ProjectGuide {
  const setupSteps: StepState[] = ['done', 'now', 'todo', 'todo', 'todo']
  if (matrix.tooMany) return { step: 2, steps: setupSteps, actions: [{ kind: 'tooMany' }] }
  if (!matrix.combos.length) return { step: 2, steps: setupSteps, actions: [{ kind: 'setup' }] }
  let review = 0
  let reviewImages = 0
  let missing = 0
  let redo = 0
  let inFlight = 0
  let touched = 0
  for (const c of matrix.combos) {
    const item = project.items[c.key]
    const status = itemStatus(item, c.target)
    if (item && (item.images.length || item.queued || item.generating || item.failed)) touched++
    inFlight += (item?.queued ?? 0) + (item?.generating ?? 0)
    if (status === 'review') {
      review++
      reviewImages += curationCounts(item).unreviewed
    }
    // "부족한 것만"(고르지 않은 그림도 채운 것으로)이 만들 조합 — 고를 그림이 남은 조합은 빼고 센다
    if (missingFor(item, c.target, true) > 0) missing++
    else if (status === 'redo') redo++
  }
  const exportable = unexportedAdopted(project, matrix.combos)
  const actions: NextAction[] = []
  let step: number
  if (!touched) {
    actions.push({ kind: 'generate', combos: matrix.combos.length })
    step = 3
  } else if (review) {
    actions.push({ kind: 'review', combos: review, images: reviewImages })
    step = 4
  } else if (inFlight) {
    actions.push({ kind: 'running', images: inFlight })
    step = 3
  } else if (missing) {
    actions.push({ kind: 'missing', combos: missing })
    step = 3
  } else if (redo) {
    actions.push({ kind: 'redo', combos: redo })
    step = 3
  } else if (exportable) {
    actions.push({ kind: 'export', images: exportable })
    step = 5
  } else {
    actions.push({ kind: 'done' })
    step = 6
  }
  // 함께 할 수 있는 일 하나 — 누를 수 있는 일(모자란 조합 생성 · 내보내기)이 먼저, 없으면 생성 중 알림
  // (생성 중에도 다 만든 조합은 고를 수 있고, "부족한 것만"은 대기·생성 중인 장을 빼고 센다)
  const first = actions[0].kind
  if (missing && first !== 'missing' && first !== 'generate') actions.push({ kind: 'missing', combos: missing })
  if (exportable && first !== 'export') actions.push({ kind: 'export', images: exportable })
  if (inFlight && first !== 'running') actions.push({ kind: 'running', images: inFlight })
  // 막대: 지금 단계 말고도 남은 일이 있는 단계는 "진행 중"으로 (초록 = 정말 끝난 단계만)
  const generateLeft = !touched || missing > 0 || redo > 0 || inFlight > 0
  const steps: StepState[] = [
    'done',
    'done',
    step === 3 ? 'now' : generateLeft ? 'doing' : 'done',
    step === 4 ? 'now' : step > 4 ? 'done' : 'todo',
    step === 5 ? 'now' : step > 5 ? 'done' : exportable ? 'doing' : 'todo'
  ]
  return { step, steps, actions: actions.slice(0, 2) }
}

/**
 * 한 조합을 고른 정도 (선별 화면의 "다 봤습니다" 알림) — filled: 채택 목표를 채움, open: 미선별이 남음,
 * held: 미선별은 없지만 보류가 남음 (아직 고를 조합 — itemStatus도 선별 필요), seen: 다 봄 (채택 목표 미달)
 */
export function reviewState(item: AssetItem | undefined, target: number): 'filled' | 'open' | 'held' | 'seen' {
  const c = curationCounts(item)
  if (c.adopted >= Math.max(1, target)) return 'filled'
  if (c.unreviewed > 0) return 'open'
  return c.hold > 0 ? 'held' : 'seen'
}

/** 다음에 할 일 한 줄 (목록 카드·안내 카드) */
export function describeAction(a: NextAction): string {
  switch (a.kind) {
    case 'setup':
      return '캐릭터와 축(표정·의상 …)을 넣으면 조합이 생깁니다'
    case 'tooMany':
      return '조합이 너무 많습니다. 축 값을 줄여 주세요'
    case 'generate':
      return `조합 ${a.combos}개를 생성할 차례입니다`
    case 'running':
      return `${a.images}장 생성 중입니다`
    case 'review':
      return `고를 조합 ${a.combos}개${a.images ? ` (미선별 ${a.images}장)` : ''}`
    case 'missing':
      return `그림이 모자란 조합 ${a.combos}개`
    case 'redo':
      return `재생성 필요로 표시한 조합 ${a.combos}개`
    case 'export':
      return `내보낼 채택 그림 ${a.images}장`
    case 'done':
      return '모든 조합을 채택하고 내보냈습니다'
  }
}

/** 이어서 고를 조합 — 선별 필요 상태인 조합 키 (행렬 순서). from을 주면 그 다음 것부터 한 바퀴 */
export function reviewQueue(project: Project, combos: readonly Combination[], from?: string): string[] {
  const keys = combos.filter((c) => itemStatus(project.items[c.key], c.target) === 'review').map((c) => c.key)
  if (from === undefined) return keys
  const at = combos.findIndex((c) => c.key === from)
  if (at < 0) return keys.filter((k) => k !== from)
  const order = new Map(combos.map((c, i) => [c.key, (i - at - 1 + combos.length) % combos.length]))
  return keys.filter((k) => k !== from).sort((a, b) => order.get(a)! - order.get(b)!)
}

export interface ValueProgress {
  combos: number
  adopted: number
  target: number
  review: number
  pending: number
}

/** 축 값마다 진행 (축 id → 값 id → 채택/목표 …). 조합 목록 안에서만 센다 */
export function progressByValue(project: Project, combos: readonly Combination[], axisId: string): Map<string, ValueProgress> {
  const out = new Map<string, ValueProgress>()
  for (const c of combos) {
    const v = c.coords[axisId]
    if (v === undefined) continue
    const item = project.items[c.key]
    const status = itemStatus(item, c.target)
    const row = out.get(v) ?? { combos: 0, adopted: 0, target: 0, review: 0, pending: 0 }
    row.combos++
    row.target += c.target
    row.adopted += Math.min(c.target, curationCounts(item).adopted)
    if (status === 'review') row.review++
    else if (status === 'pending' || status === 'redo') row.pending++
    out.set(v, row)
  }
  return out
}

/** "캐릭터 2 × 표정 5 = 10개" — 조합이 어떻게 만들어지는지 한 줄로 (제외가 있으면 덧붙임) */
export function describeMatrixSize(matrix: MatrixResult): string {
  if (!matrix.axes.length) return ''
  const parts = matrix.axes.map((a) => `${a.name} ${a.values.filter((v) => v.enabled !== false).length}`)
  const n = matrix.tooMany ? matrix.total : matrix.combos.length
  return `${parts.join(' × ')} = ${n.toLocaleString('ko-KR')}개${matrix.excluded ? ` (제외 ${matrix.excluded})` : ''}`
}
