/**
 * 에셋 행렬 — 축(캐릭터·의상·표정·상황 …)의 값을 곱해 조합을 펼치고, 제외 규칙·덮어쓰기·부분 선택을
 * 적용한 뒤 생성 작업(GenerationJob) 목록과 예상 장수·Anlas·시간·폭발 경고를 만든다.
 *
 * 조합 키는 "축 id:값 id"를 축 id 순으로 정렬해 이은 문자열이라, 축 순서·이름을 바꿔도 그대로다.
 */
import { estimateAnlas } from '../nai/anlas'
import { modelCapabilities } from '../nai/models'
import { referencesForModel } from '../nai/reference'
import { curationCounts, itemStatus, progressOf } from './curation'
import {
  CHARACTER_AXIS,
  DEFAULT_LIMITS,
  type AssetItem,
  type AssetStatus,
  type Axis,
  type AxisValue,
  type ComboOverride,
  type ExclusionRule,
  type PlanLimits,
  type Project,
  type ProjectCharacter,
  type ProjectImageTag,
  type ProjectParams,
  type ReferenceInfo
} from './types'

// ── 조합 키 ──────────────────────────────────────────────────────────────────

/** 축 id → 값 id 를 고정된 키로 (축 id 순 정렬) */
export function comboKey(coords: Readonly<Record<string, string>>): string {
  return Object.keys(coords)
    .sort()
    .map((a) => `${encodeURIComponent(a)}:${encodeURIComponent(coords[a])}`)
    .join('|')
}

export function parseComboKey(key: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!key) return out
  for (const part of key.split('|')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1))
  }
  return out
}

/** 쉼표 중복 없이 조각을 잇는다 (scenes.appendPrompt와 같은 규칙, 빈 조각은 건너뜀) */
export function joinPrompt(...parts: (string | undefined | null)[]): string {
  let out = ''
  for (const raw of parts) {
    const a = (raw ?? '').trim().replace(/^,\s*/, '').replace(/,\s*$/, '')
    if (!a) continue
    out = out ? `${out}, ${a}` : a
  }
  return out
}

// ── 축 ────────────────────────────────────────────────────────────────────────

/** 프로젝트 캐릭터 → 캐릭터 축 (캐릭터가 없으면 null) */
export function characterAxis(project: Pick<Project, 'characters'>): Axis | null {
  if (!project.characters.length) return null
  return {
    id: CHARACTER_AXIS,
    kind: 'character',
    name: '캐릭터',
    key: 'character',
    target: 'character',
    values: project.characters.map((c) => ({
      id: c.id,
      label: c.name,
      ...(c.slug ? { slug: c.slug } : {}),
      prompt: c.prompt ?? '',
      ...(c.negative ? { negative: c.negative } : {}),
      ...(c.enabled === false ? { enabled: false } : {})
    }))
  }
}

/** 행렬에 쓰는 축 전부 (캐릭터 축이 맨 앞) */
export function projectAxes(project: Pick<Project, 'characters' | 'axes'>): Axis[] {
  const ch = characterAxis(project)
  return ch ? [ch, ...project.axes.filter((a) => a.id !== CHARACTER_AXIS)] : project.axes
}

const enabledValues = (axis: Axis): AxisValue[] => axis.values.filter((v) => v.enabled !== false)

// ── 제외 · 덮어쓰기 ──────────────────────────────────────────────────────────

/** 이 조합을 빼는 규칙 (없으면 null). 규칙의 축이 조합에 없으면 그 규칙은 맞지 않는다 */
export function excludedBy(coords: Readonly<Record<string, string>>, rules: readonly ExclusionRule[]): ExclusionRule | null {
  for (const rule of rules) {
    const axes = Object.keys(rule.when)
    if (!axes.length) continue
    if (axes.every((a) => coords[a] !== undefined && rule.when[a].includes(coords[a]))) return rule
  }
  return null
}

/** 조합에 맞는 덮어쓰기 — 덜 구체적인 것부터(같으면 목록 순서) */
export function matchingOverrides(
  coords: Readonly<Record<string, string>>,
  overrides: readonly ComboOverride[]
): ComboOverride[] {
  return overrides
    .map((o, i) => ({ o, i, n: Object.keys(o.match).length }))
    .filter(({ o }) => Object.entries(o.match).every(([a, v]) => coords[a] === v))
    .sort((x, y) => x.n - y.n || x.i - y.i)
    .map(({ o }) => o)
}

/** 숫자 값은 가장 구체적인(뒤에 오는) 덮어쓰기가 이긴다 */
function lastDefined<K extends keyof ComboOverride>(list: readonly ComboOverride[], k: K): ComboOverride[K] | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (list[i][k] !== undefined) return list[i][k]
  return undefined
}

// ── 펼치기 ───────────────────────────────────────────────────────────────────

export interface Combination {
  key: string
  coords: Record<string, string>
  /** 축 순서대로 고른 값 */
  picks: { axis: Axis; value: AxisValue }[]
  character: ProjectCharacter | null
  /** "민지 · 교복 · 웃음" */
  label: string
  /** 한 번에 생성할 장수 / 채택 목표 */
  count: number
  target: number
  width: number
  height: number
  overrides: ComboOverride[]
}

export interface MatrixSelection {
  /** 축 id → 고를 값 id (없는 축은 전부) */
  values?: Record<string, string[]>
  /** 이 조합 키만 */
  keys?: string[]
}

export interface PlanWarning {
  code: 'combos' | 'images' | 'anlas' | 'time' | 'hardLimit' | 'emptyAxis' | 'noAxes' | 'unreviewed' | 'references'
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface MatrixResult {
  axes: Axis[]
  combos: Combination[]
  /** 선택 범위 안의 전체 곱 (제외 전) */
  total: number
  /** 제외 규칙으로 빠진 조합 수 */
  excluded: number
  /** hardLimit을 넘어 펼치지 않았는가 */
  tooMany: boolean
  warnings: PlanWarning[]
}

/**
 * 조합을 펼친다. 선택(select)으로 축별 값이나 조합 키를 좁힐 수 있고, 꺼 둔 값·값이 없는 축은 빠진다.
 * 곱이 limits.hardLimit을 넘으면 펼치지 않고 오류 경고만 돌려준다 (화면이 멈추지 않게)
 */
export function expandMatrix(project: Project, select: MatrixSelection = {}): MatrixResult {
  const limits = { ...DEFAULT_LIMITS, ...project.limits }
  const warnings: PlanWarning[] = []
  const axes: { axis: Axis; values: AxisValue[] }[] = []
  for (const axis of projectAxes(project)) {
    let values = enabledValues(axis)
    const want = select.values?.[axis.id]
    if (want) values = values.filter((v) => want.includes(v.id))
    if (!values.length) {
      warnings.push({
        code: 'emptyAxis',
        level: 'warn',
        message: `"${axis.name}" 축에 고른 값이 없어 이 축은 빼고 펼칩니다`
      })
      continue
    }
    axes.push({ axis, values })
  }
  if (!axes.length) {
    warnings.push({ code: 'noAxes', level: 'error', message: '축이 없습니다. 캐릭터나 축 값을 먼저 추가해 주세요' })
    return { axes: [], combos: [], total: 0, excluded: 0, tooMany: false, warnings }
  }
  const total = axes.reduce((n, a) => n * a.values.length, 1)
  if (total > limits.hardLimit) {
    warnings.push({
      code: 'hardLimit',
      level: 'error',
      message: `조합이 ${total.toLocaleString('ko-KR')}개로 너무 많아 펼치지 않았습니다 (최대 ${limits.hardLimit.toLocaleString('ko-KR')}개). 축 값을 줄이거나 일부만 골라 주세요`
    })
    return { axes: axes.map((a) => a.axis), combos: [], total, excluded: 0, tooMany: true, warnings }
  }

  const keyFilter = select.keys ? new Set(select.keys) : null
  const characters = new Map(project.characters.map((c) => [c.id, c]))
  const combos: Combination[] = []
  let excluded = 0
  const idx = axes.map(() => 0)
  for (let n = 0; n < total; n++) {
    const picks = axes.map((a, i) => ({ axis: a.axis, value: a.values[idx[i]] }))
    const coords: Record<string, string> = {}
    for (const p of picks) coords[p.axis.id] = p.value.id
    // 다음 조합 (마지막 축부터 넘김 — 첫 축이 가장 바깥 순서)
    for (let i = axes.length - 1; i >= 0; i--) {
      if (++idx[i] < axes[i].values.length) break
      idx[i] = 0
    }
    if (excludedBy(coords, project.exclusions)) {
      excluded++
      continue
    }
    const key = comboKey(coords)
    if (keyFilter && !keyFilter.has(key)) continue
    const overrides = matchingOverrides(coords, project.overrides)
    const count = lastDefined(overrides, 'count') ?? project.defaults.count
    const target = lastDefined(overrides, 'target') ?? project.defaults.target
    combos.push({
      key,
      coords,
      picks,
      character: coords[CHARACTER_AXIS] ? (characters.get(coords[CHARACTER_AXIS]) ?? null) : null,
      label: picks.map((p) => p.value.label).join(' · '),
      count: Math.max(0, Math.floor(count)),
      target: Math.max(1, Math.floor(target)),
      width: lastDefined(overrides, 'width') ?? project.params.width,
      height: lastDefined(overrides, 'height') ?? project.params.height,
      overrides
    })
  }
  return { axes: axes.map((a) => a.axis), combos, total, excluded, tooMany: false, warnings }
}

// ── 생성 작업 ────────────────────────────────────────────────────────────────

/**
 * 생성 작업 하나 = 한 조합을 count장. 리드는 이것을 생성 대기열의 배치 계획(1장 = 요청 1번)으로 바꾼다:
 * - 메인 프롬프트 = prompt, 네거티브 = negative (화면의 프롬프트 대신)
 * - 캐릭터 프롬프트 = 라이브러리 캐릭터(character.libraryId)의 프롬프트 + characterPrompt
 * - 해상도 width×height, 그 밖의 설정은 params
 * - 바이브·레퍼런스 = vibeIds·refIds (stores/refs)
 * - 결과 히스토리 이미지에 tag를 붙여 두면 선별 화면이 조합별로 모은다
 */
export interface GenerationJob {
  projectId: string
  key: string
  coords: Record<string, string>
  /** 축 id → 값 표시 이름 */
  labels: Record<string, string>
  label: string
  character: { id: string; libraryId: number | null; name: string } | null
  prompt: string
  negative: string
  /** 캐릭터 프롬프트 뒤에 덧붙일 조각 (캐릭터가 없으면 빈 문자열이고, 조각은 prompt에 들어 있다) */
  characterPrompt: string
  characterNegative: string
  width: number
  height: number
  count: number
  params: ProjectParams
  vibeIds: number[]
  refIds: number[]
  tag: ProjectImageTag
}

function uniq(list: readonly number[]): number[] {
  return [...new Set(list)]
}

/** 조합 → 생성 작업 (count를 주면 그 장수로) */
export function buildJob(project: Project, combo: Combination, count = combo.count): GenerationJob {
  const ch = combo.character
  const base: string[] = []
  const charParts: string[] = []
  const negatives: string[] = []
  const charNegatives: string[] = []
  for (const { axis, value } of combo.picks) {
    if (axis.id === CHARACTER_AXIS) continue
    const fragment = (ch && value.perCharacter?.[ch.id]) ?? value.prompt
    // 캐릭터가 없으면 캐릭터 대상 조각도 메인 프롬프트로
    const toChar = axis.target === 'character' && !!ch
    ;(toChar ? charParts : base).push(fragment)
    if (value.negative) (toChar ? charNegatives : negatives).push(value.negative)
  }
  for (const o of combo.overrides) {
    if (o.prompt) base.push(o.prompt)
    if (o.negative) negatives.push(o.negative)
    if (o.characterPrompt) (ch ? charParts : base).push(o.characterPrompt)
  }
  const prompt =
    project.stylePosition === 'end' ? joinPrompt(...base, project.stylePrompt) : joinPrompt(project.stylePrompt, ...base)
  const labels: Record<string, string> = {}
  for (const { axis, value } of combo.picks) labels[axis.id] = value.label
  return {
    projectId: project.id,
    key: combo.key,
    coords: combo.coords,
    labels,
    label: combo.label,
    character: ch ? { id: ch.id, libraryId: ch.libraryId, name: ch.name } : null,
    prompt,
    negative: joinPrompt(project.negative, ...negatives),
    characterPrompt: ch ? joinPrompt(ch.prompt, ...charParts) : '',
    characterNegative: ch ? joinPrompt(ch.negative, ...charNegatives) : '',
    width: combo.width,
    height: combo.height,
    count,
    params: { ...project.params, width: combo.width, height: combo.height },
    vibeIds: uniq([...project.vibeIds, ...(ch?.vibeIds ?? [])]),
    refIds: uniq([...project.refIds, ...(ch?.refIds ?? [])]),
    tag: { projectId: project.id, key: combo.key, coords: combo.coords }
  }
}

// ── 계획 (전체 / 부족분만 / 실패만) ─────────────────────────────────────────

export type PlanMode = 'all' | 'missing' | 'failed'

export interface PlanOptions {
  select?: MatrixSelection
  /** missing: 부족한 채택 1장당 생성할 장수 (기본 1) */
  perMissing?: number
  /** missing: 아직 선별하지 않은(미선별·보류) 그림도 채워진 것으로 셈 (기본 false = 목표 − 채택) */
  countUnreviewed?: boolean
}

/** 부족한 채택 장수 = 목표 − 채택 − 이미 대기·생성 중 (countUnreviewed면 미선별·보류도 뺀다) */
export function missingFor(item: AssetItem | undefined, target: number, countUnreviewed = false): number {
  const c = curationCounts(item)
  const inFlight = (item?.queued ?? 0) + (item?.generating ?? 0)
  const pending = countUnreviewed ? c.unreviewed + c.hold : 0
  return Math.max(0, target - c.adopted - inFlight - pending)
}

/** 조합별로 이번에 생성할 장수 */
export function planCount(project: Project, combo: Combination, mode: PlanMode, opts: PlanOptions = {}): number {
  const item = project.items[combo.key]
  if (mode === 'all') return combo.count
  if (mode === 'missing') {
    const per = Math.max(1, Math.floor(opts.perMissing ?? 1))
    return missingFor(item, combo.target, opts.countUnreviewed) * per
  }
  // 실패만: 재생성 필요 상태인 조합 — 실패한 장수와 부족한 장수 중 큰 쪽 (최소 1)
  if (itemStatus(item, combo.target) !== 'redo') return 0
  return Math.max(1, item?.failed ?? 0, missingFor(item, combo.target))
}

export interface ProjectPlan {
  mode: PlanMode
  matrix: MatrixResult
  jobs: GenerationJob[]
  /** missing 계획에서 아직 선별하지 않은 그림 수 (먼저 고르면 덜 생성해도 된다) */
  unreviewed: number
}

export function planJobs(project: Project, mode: PlanMode, opts: PlanOptions = {}): ProjectPlan {
  const matrix = expandMatrix(project, opts.select)
  const jobs: GenerationJob[] = []
  let unreviewed = 0
  for (const combo of matrix.combos) {
    const n = planCount(project, combo, mode, opts)
    if (n <= 0) continue
    if (mode === 'missing') unreviewed += curationCounts(project.items[combo.key]).unreviewed
    jobs.push(buildJob(project, combo, n))
  }
  return { mode, matrix, jobs, unreviewed }
}

// ── 예상 (장수 · Anlas · 시간) ──────────────────────────────────────────────

export interface EstimateContext {
  isOpus: boolean
  /** V5 Opus 할당량이 바닥났는가 (모르면 undefined → V5는 무료로 치지 않는다) */
  opusUsageExhausted?: boolean
  /** 장당 걸리는 초 (secondsPerImageFrom으로 지난 배치에서 구할 수 있다) */
  secondsPerImage: number
  /** 정밀 레퍼런스의 종류 (모델이 받지 않는 종류를 빼고 센다). 없으면 모델이 받으면 모두 센다 */
  references?: readonly ReferenceInfo[]
  /** 아직 이 모델로 인코딩하지 않은 바이브 id (인코딩은 계획 전체에서 한 번씩 2 Anlas) */
  unencodedVibeIds?: readonly number[]
}

export interface PlanEstimate {
  jobs: number
  images: number
  anlas: number
  generationAnlas: number
  referenceAnlas: number
  vibeAnlas: number
  /** Opus 무료로 생성되는 장수 / 그 가운데 V5 Opus 할당량을 쓰는 장수 */
  freeImages: number
  opusUsageImages: number
  seconds: number
}

export function estimateJobs(jobs: readonly GenerationJob[], ctx: EstimateContext): PlanEstimate {
  const out: PlanEstimate = {
    jobs: 0,
    images: 0,
    anlas: 0,
    generationAnlas: 0,
    referenceAnlas: 0,
    vibeAnlas: 0,
    freeImages: 0,
    opusUsageImages: 0,
    seconds: 0
  }
  const refInfo = ctx.references ? new Map(ctx.references.map((r) => [r.id, r])) : null
  const unencoded = new Set(ctx.unencodedVibeIds ?? [])
  const toEncode = new Set<number>()
  let encodeModel = ''
  for (const job of jobs) {
    if (job.count <= 0) continue
    const model = job.params.model
    const caps = modelCapabilities(model)
    const refs = refInfo
      ? referencesForModel(
          job.refIds.flatMap((id) => {
            const r = refInfo.get(id)
            return r ? [{ ...r, enabled: true }] : []
          }),
          model
        ).length
      : caps.characterReferences
        ? job.refIds.length
        : 0
    const vibes = caps.vibes ? job.vibeIds : []
    for (const id of vibes) {
      if (unencoded.has(id)) {
        toEncode.add(id)
        encodeModel ||= model
      }
    }
    const est = estimateAnlas({
      model,
      width: job.width,
      height: job.height,
      steps: job.params.steps,
      charRefCount: refs,
      isOpus: ctx.isOpus,
      batchCount: job.count,
      vibeCount: vibes.length,
      unencodedVibes: 0,
      ...(ctx.opusUsageExhausted !== undefined ? { opusUsageExhausted: ctx.opusUsageExhausted } : {})
    })
    out.jobs++
    out.images += job.count
    out.generationAnlas += est.generation + est.vibeGeneration
    out.referenceAnlas += est.charRef
    if (est.generation === 0) out.freeImages += job.count
    if (est.usesOpusUsage) out.opusUsageImages += job.count
  }
  if (toEncode.size) {
    out.vibeAnlas = estimateAnlas({
      model: encodeModel,
      width: 1024,
      height: 1024,
      steps: 28,
      isOpus: ctx.isOpus,
      batchCount: 0,
      unencodedVibes: toEncode.size
    }).vibeEncoding
  }
  out.anlas = out.generationAnlas + out.referenceAnlas + out.vibeAnlas
  out.seconds = out.images * Math.max(0, ctx.secondsPerImage)
  return out
}

/** 지난 배치의 장당 시간(초). 기록이 없으면 fallback */
export function secondsPerImageFrom(lastBatch: { perImageMs: number } | null | undefined, fallback = 15): number {
  const ms = lastBatch?.perImageMs ?? 0
  return ms > 0 && Number.isFinite(ms) ? ms / 1000 : fallback
}

/** "약 1시간 20분" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `약 ${s}초`
  const m = Math.round(s / 60)
  if (m < 60) return `약 ${m}분`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `약 ${h}시간 ${rest}분` : `약 ${h}시간`
}

/** 조합 폭발 경고 (기준은 프로젝트 limits로 바꿀 수 있다) */
export function planWarnings(plan: ProjectPlan, estimate: PlanEstimate, limits: Partial<PlanLimits> = {}): PlanWarning[] {
  const l = { ...DEFAULT_LIMITS, ...limits }
  const fmt = (n: number): string => n.toLocaleString('ko-KR')
  const out = [...plan.matrix.warnings]
  if (plan.matrix.combos.length > l.combos) {
    out.push({
      code: 'combos',
      level: 'warn',
      message: `조합이 ${fmt(plan.matrix.combos.length)}개입니다 (기준 ${fmt(l.combos)}개). 축 값을 줄이거나 제외 규칙을 확인해 주세요`
    })
  }
  if (estimate.images > l.images) {
    out.push({ code: 'images', level: 'warn', message: `${fmt(estimate.images)}장을 생성합니다 (기준 ${fmt(l.images)}장)` })
  }
  if (estimate.anlas > l.anlas) {
    out.push({ code: 'anlas', level: 'warn', message: `예상 ${fmt(estimate.anlas)} Anlas가 듭니다 (기준 ${fmt(l.anlas)})` })
  }
  if (estimate.seconds > l.seconds) {
    out.push({
      code: 'time',
      level: 'warn',
      message: `${formatDuration(estimate.seconds)} 걸릴 것으로 보입니다 (기준 ${formatDuration(l.seconds).replace('약 ', '')})`
    })
  }
  if (plan.mode === 'missing' && plan.unreviewed > 0) {
    out.push({
      code: 'unreviewed',
      level: 'info',
      message: `아직 고르지 않은 그림이 ${fmt(plan.unreviewed)}장 있습니다. 먼저 고르면 덜 생성해도 됩니다`
    })
  }
  return out
}

// ── 진행 현황 ────────────────────────────────────────────────────────────────

export interface MatrixTotals {
  combos: number
  excluded: number
  /** 전체 생성 계획 장수 (조합별 count 합) */
  images: number
  target: number
  /** 조합마다 목표까지만 센 채택 수 */
  adopted: number
  /** 채택 / 목표 (0~1) */
  progress: number
  byStatus: Record<AssetStatus, number>
}

export function matrixTotals(project: Project, matrix: MatrixResult): MatrixTotals {
  const byStatus: Record<AssetStatus, number> = {
    pending: 0,
    queued: 0,
    generating: 0,
    review: 0,
    adopted: 0,
    redo: 0,
    exported: 0
  }
  let images = 0
  let target = 0
  let adopted = 0
  for (const combo of matrix.combos) {
    const item = project.items[combo.key]
    images += combo.count
    target += combo.target
    adopted += Math.min(combo.target, curationCounts(item).adopted)
    byStatus[itemStatus(item, combo.target)]++
  }
  return {
    combos: matrix.combos.length,
    excluded: matrix.excluded,
    images,
    target,
    adopted,
    progress: progressOf(adopted, target),
    byStatus
  }
}

/** 행렬에 더는 없는 조합(축·값을 지웠거나 껐거나 제외한 것)의 에셋 항목 — 그림은 남아 있으니 따로 보여 준다 */
export function orphanItems(project: Project): AssetItem[] {
  const matrix = expandMatrix(project)
  if (matrix.tooMany) return []
  const live = new Set(matrix.combos.map((c) => c.key))
  return Object.values(project.items).filter((i) => !live.has(i.key) && i.images.length > 0)
}
