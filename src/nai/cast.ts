import { removeComments } from './presets'
import { parseWeights } from './weights'

/**
 * 캐릭터 출연 슬롯 · 변형 뽑기 엔진 (순수 함수 — 저장소·화면과 무관하게 시험할 수 있다).
 *
 * - 캐릭터 = 고정(얼굴·체형·머리) + 변형 그룹(복장·표정·자세 …) + 가변 + 디테일, 네거티브는 따로.
 *   보내는 캡션은 고정, 고른 변형들, 가변, 디테일 순으로 ", "로 잇는다 (빈 칸은 건너뜀).
 *   변형 항목 안의 조각 문법(<이름>, <a|b>, …)은 여기서 건드리지 않는다 — 합친 뒤 생성 단계에서 기존 처리기로 치환한다.
 * - 슬롯 = 출연 한 자리. 고정 / 무작위(가중치) / 순차 / 확률로 그 자리에 누가 나올지 정한다. 위치는 슬롯마다.
 * - 뽑기 상태(DrawState)는 배치(또는 씬)마다 하나 — 순차 카운터와 "배치에 한 번" 뽑은 결과를 담는다.
 * - "배치에 한 번" 뽑는 순차(순차 슬롯 + 배치에 한 번, 배치마다 한 번만 뽑는 순차 변형 그룹)는 배치를 넘어
 *   이어 간다: 배치가 시작할 때의 자리(CastCursors)에서 뽑고, 그 장이 쓴 다음 자리를 결과(advance)로 알린다.
 *   자리를 저장하고 넘기는 일은 부르는 쪽(생성 스토어)이 한다 — 그림이 나온 배치만 넘긴다.
 * - 난수는 주입한다(rng). 시험·미리보기는 mulberry32 같은 시드 난수를, 생성은 Math.random을 쓴다.
 */

export interface Center {
  x: number
  y: number
}

export type Rng = () => number

// ── 변형 그룹 ──────────────────────────────────────────────

export type VariationKind = 'outfit' | 'expression' | 'pose' | 'action' | 'accessory' | 'custom'

export const VARIATION_KINDS: readonly { value: VariationKind; label: string }[] = [
  { value: 'outfit', label: '복장' },
  { value: 'expression', label: '표정' },
  { value: 'pose', label: '자세' },
  { value: 'action', label: '행동' },
  { value: 'accessory', label: '액세서리' },
  { value: 'custom', label: '사용자 정의' }
]

/** fixed = 정한 항목 하나, random = 가중치 무작위, sequential = 차례로, off = 쓰지 않음 */
export type VariationMode = 'fixed' | 'random' | 'sequential' | 'off'

export const VARIATION_MODES: readonly { value: VariationMode; label: string }[] = [
  { value: 'fixed', label: '고정' },
  { value: 'random', label: '무작위' },
  { value: 'sequential', label: '순차' },
  { value: 'off', label: '미사용' }
]

export interface VariationItem {
  id: number
  label: string
  /** 캡션에 들어갈 프롬프트 (비워 두면 "없음" 선택지가 된다) */
  prompt: string
  /** 무작위에서 뽑힐 비중 (0이면 뽑히지 않음) */
  weight: number
}

export interface VariationGroup {
  id: number
  kind: VariationKind
  /** 표시 이름 — 비우면 종류 이름 */
  name: string
  mode: VariationMode
  /** 고정 모드에서 쓸 항목 (없거나 지워졌으면 첫 항목) */
  fixedId: number | null
  /** 무작위·순차를 배치(씬)마다 한 번만 뽑아 그 배치 안에서는 같게 */
  perBatch?: boolean
  items: VariationItem[]
}

export interface CastCharacter {
  id: number
  name: string
  /** null = 미분류 */
  folderId: number | null
  /** 고정: 얼굴·체형·머리 등 정체성 */
  base: string
  /** 가변: 매번 바꿀 복장·표정·자세 */
  additional: string
  /** 디테일: 뒤에 붙일 세부 묘사 */
  detail: string
  negative: string
  variations: VariationGroup[]
}

// ── 출연 슬롯 ──────────────────────────────────────────────

/** fixed = 정한 캐릭터, random = 후보 중 가중치 무작위, sequential = 후보를 차례로, chance = 확률로 등장 */
export type SlotMode = 'fixed' | 'random' | 'sequential' | 'chance'

export const SLOT_MODES: readonly { value: SlotMode; label: string }[] = [
  { value: 'fixed', label: '고정' },
  { value: 'random', label: '무작위' },
  { value: 'sequential', label: '순차' },
  { value: 'chance', label: '확률' }
]

export interface SlotCandidate {
  kind: 'char' | 'folder'
  /** 캐릭터 id 또는 폴더 id (폴더 null = 미분류) */
  id: number | null
  /** 뽑힐 비중. 폴더는 이 비중을 안의 캐릭터들이 나눠 갖는다 */
  weight: number
}

export interface CastSlot {
  id: number
  /** false = 비활성 (모드는 그대로 둬서 다시 켜면 이어 쓴다) */
  enabled: boolean
  mode: SlotMode
  /** 고정 모드의 캐릭터 */
  charId: number | null
  /** 무작위·순차·확률 모드의 후보 (캐릭터·폴더) */
  candidates: SlotCandidate[]
  /** 확률 모드: 이 슬롯이 나올 확률(%) */
  chance: number
  /** 순차 모드: 끝까지 가면 처음부터 (끄면 그 뒤로 이 슬롯은 비운다) */
  wrap: boolean
  /** null = AI 선택 */
  center: Center | null
}

export interface CastOptions {
  /** 같은 캐릭터가 여러 슬롯에 함께 나와도 되는가 */
  allowDuplicates: boolean
  /** 무작위·순차·확률 슬롯을 장마다 새로 뽑을지(image), 배치에 한 번만 뽑을지(batch) */
  scope: 'image' | 'batch'
  /** 씬 여러 개를 돌릴 때 씬마다 따로 뽑기 (배치에 한 번 뽑기·순서가 씬마다 처음부터) */
  perScene: boolean
  /** 메인 프롬프트의 인원 태그(2girls 등)를 실제 캐릭터 수에 맞춰 고쳐 보내기 */
  autoCountTags: boolean
}

export const DEFAULT_CAST_OPTIONS: CastOptions = {
  allowDuplicates: false,
  scope: 'image',
  perScene: false,
  autoCountTags: false
}

/** 뽑기 한 번에 필요한 전부 — 대기열 배치는 라이브러리 내용을 복사해 두어 나중에 고쳐도 영향받지 않는다 */
export interface CastPlan {
  slots: CastSlot[]
  options: CastOptions
  /** 슬롯이 가리키는 캐릭터들 (폴더 후보는 그 안의 캐릭터 전부) */
  characters: CastCharacter[]
}

/**
 * 배치를 넘어 이어 가는 순서 자리 — "배치에 한 번" 뽑는 순차 슬롯·순차 변형 그룹이 새 배치마다 한 칸씩 나아가게 한다.
 * 열쇠는 DrawState.seq와 같다 (`slot:<슬롯 id>`, `var:<캐릭터 id>:<그룹 id>`). 값 = 다음 배치가 쓸 차례 (0 = 첫 후보)
 */
export type CastCursors = Record<string, number>

const CURSOR_KEY = /^(?:slot|var):/

/** 저장소·백업에서 읽은 자리를 믿을 수 있는 것만 남긴다 (0 이상 정수, 아는 열쇠만) */
export function cleanCursors(raw: unknown): CastCursors {
  const out: CastCursors = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (CURSOR_KEY.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v)
  }
  return out
}

/** 열쇠의 자리 (없거나 깨졌으면 0 = 처음부터) */
function cursorAt(cursors: unknown, key: string): number {
  const v = cursors && typeof cursors === 'object' ? (cursors as Record<string, unknown>)[key] : undefined
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

/**
 * 그림이 나온 장의 advance로 저장된 자리를 한 칸 넘긴다 — 그 배치가 시작한 자리(advance − 1)에 아직 있는 열쇠만.
 * - 같은 배치를 다시 적용해도(같은 배치의 다음 장, 씬마다 따로 뽑기, 이어서 생성) 이미 넘어가 있어 한 번만 넘는다
 * - 배치가 도는 사이 자리가 다른 값이 됐으면 그 값을 그대로 둔다. 다만 처음(0)으로 되돌린 자리는 값만으로는
 *   "아직 안 넘김"과 구별되지 않는다 — 되돌리기·백업 복원·지운 슬롯과 캐릭터는 부르는 쪽(characters 스토어
 *   commitCursors의 cursorEpoch와 열쇠 확인)이 거른다
 * 바뀐 것이 없으면 null
 */
export function advanceCursors(cursors: CastCursors, advance: CastCursors | undefined): CastCursors | null {
  let next: CastCursors | null = null
  for (const [k, v] of Object.entries(cleanCursors(advance))) {
    if (v < 1 || cursorAt(cursors, k) !== v - 1) continue
    next ??= cleanCursors(cursors)
    next[k] = v
  }
  return next
}

/** 배치(또는 씬) 하나 동안 이어지는 뽑기 상태 */
export interface DrawState {
  /** 순차 카운터 — `slot:<슬롯 id>`, `var:<캐릭터 id>:<그룹 id>` */
  seq: Record<string, number>
  /** "배치에 한 번" 뽑은 슬롯 결과 (캐릭터 id, null = 이번 배치엔 안 나옴) */
  slots: Record<string, number | null>
  /** "배치에 한 번" 뽑은 변형 항목 (항목 id, null = 없음) */
  vars: Record<string, number | null>
  /** 이 배치가 시작할 때의 순서 자리 — "배치에 한 번" 뽑는 순차만 여기서 시작한다 (없으면 처음부터) */
  cursors?: CastCursors
}

export function createDrawState(cursors?: CastCursors): DrawState {
  return { seq: {}, slots: {}, vars: {}, ...(cursors ? { cursors: { ...cursors } } : {}) }
}

/**
 * 이번 장이 쓸 뽑기 상태 — 배치 전체가 하나를 이어 쓰고, "씬마다 따로 뽑기"면 씬마다 따로 둔다
 * (씬이 바뀌면 순차와 배치에 한 번 뽑기를 이 배치가 시작할 때의 자리부터 다시).
 * cursors = 배치가 시작할 때의 순서 자리 (새로 만드는 상태에만 넣는다)
 */
export function drawStateFor(
  states: Map<string, DrawState>,
  options: CastOptions,
  sceneId?: number,
  cursors?: CastCursors
): DrawState {
  const key = options.perScene && sceneId !== undefined ? `scene:${sceneId}` : 'batch'
  let state = states.get(key)
  if (!state) states.set(key, (state = createDrawState(cursors)))
  return state
}

export interface ResolvedVariation {
  groupId: number
  /** 그룹 표시 이름 (복장·표정 …) */
  group: string
  itemId: number
  label: string
  prompt: string
}

export interface ResolvedCharacter {
  slotId: number
  charId: number
  name: string
  /** 합친 캡션 (조각 치환 전) */
  prompt: string
  negative: string
  center: Center | null
  variations: ResolvedVariation[]
}

export interface CastResolution {
  /** 보낼 캐릭터 (슬롯 순서, 모델 한도 안) */
  chars: ResolvedCharacter[]
  /** 모델 한도를 넘어 뺀 캐릭터 */
  dropped: ResolvedCharacter[]
  /** 화면에 보여 줄 참고 (빈 슬롯·중복으로 뺀 캐릭터 등) */
  notes: string[]
  /**
   * 이 장이 쓴 "배치에 한 번" 순차의 다음 자리 (열쇠 → 다음 배치가 쓸 차례). 이 장의 그림이 나오면
   * advanceCursors로 저장된 자리에 더한다 — 그러면 다음 배치가 다음 후보·항목부터 뽑는다
   */
  advance: CastCursors
}

// ── 난수 ───────────────────────────────────────────────────

/** 시드 난수 (시험·미리보기용) */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 가중치 비례로 하나 고른 위치. 고를 것이 없으면(모두 0 이하) -1 */
export function weightedIndex(weights: readonly number[], rng: Rng): number {
  let total = 0
  for (const w of weights) if (w > 0 && Number.isFinite(w)) total += w
  if (total <= 0) return -1
  let r = rng() * total
  let last = -1
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]
    if (!(w > 0) || !Number.isFinite(w)) continue
    last = i
    if (r < w) return i
    r -= w
  }
  return last
}

// ── 캡션 합치기 ────────────────────────────────────────────

/** 칸들을 ", "로 잇는다 — 주석(#) 줄은 빼고(뒤 칸을 삼키지 않게), 앞뒤 쉼표·빈 칸은 정리 */
export function joinPromptParts(parts: readonly string[]): string {
  return parts
    .map((p) =>
      removeComments(p ?? '')
        .trim()
        .replace(/^,+\s*/, '')
        .replace(/\s*,+$/, '')
        .trim()
    )
    .filter(Boolean)
    .join(', ')
}

/** 캐릭터 캡션 = 고정, 고른 변형들, 가변, 디테일 */
export function composeCaption(c: CastCharacter, variations: readonly { prompt: string }[]): string {
  return joinPromptParts([c.base, ...variations.map((v) => v.prompt), c.additional, c.detail])
}

export function variationGroupLabel(g: VariationGroup): string {
  return g.name.trim() || VARIATION_KINDS.find((k) => k.value === g.kind)?.label || '변형'
}

// ── 후보 펼치기 ────────────────────────────────────────────

/** 무작위·확률용: 후보를 캐릭터 단위 가중치로 (폴더 비중은 안의 캐릭터가 나눠 갖고, 겹치면 더한다) */
export function weightedCandidates(
  slot: Pick<CastSlot, 'mode' | 'candidates' | 'charId'>,
  characters: readonly CastCharacter[]
): { char: CastCharacter; weight: number }[] {
  const out = new Map<number, { char: CastCharacter; weight: number }>()
  const add = (c: CastCharacter, w: number): void => {
    const prev = out.get(c.id)
    if (prev) prev.weight += w
    else out.set(c.id, { char: c, weight: w })
  }
  for (const cand of slot.candidates) {
    const w = Number.isFinite(cand.weight) ? Math.max(0, cand.weight) : 0
    if (cand.kind === 'char') {
      const c = characters.find((x) => x.id === cand.id)
      if (c) add(c, w)
    } else {
      const members = characters.filter((x) => x.folderId === cand.id)
      for (const c of members) add(c, w / members.length)
    }
  }
  // 후보를 비워 둔 확률 슬롯만 고정 캐릭터를 쓴다 (무작위는 후보가 없으면 빈 슬롯 — 고정에서 바꿀 때 남은 charId를 몰래 쓰지 않게)
  if (slot.mode === 'chance' && !slot.candidates.length && slot.charId !== null) {
    const c = characters.find((x) => x.id === slot.charId)
    if (c) add(c, 1)
  }
  return [...out.values()]
}

/** 순차용: 후보 순서대로 (폴더는 라이브러리 순서로 펼치고, 겹치면 처음 것만). 후보가 없으면 빈 목록 */
export function orderedCandidates(
  slot: Pick<CastSlot, 'candidates'>,
  characters: readonly CastCharacter[]
): CastCharacter[] {
  const seen = new Set<number>()
  const out: CastCharacter[] = []
  const add = (c: CastCharacter | undefined): void => {
    if (!c || seen.has(c.id)) return
    seen.add(c.id)
    out.push(c)
  }
  for (const cand of slot.candidates) {
    if (cand.kind === 'char') add(characters.find((x) => x.id === cand.id))
    else for (const c of characters.filter((x) => x.folderId === cand.id)) add(c)
  }
  return out
}

/** 슬롯이 가리키는 캐릭터 id 전부 (스냅샷에 담을 것) */
export function referencedCharacterIds(
  slots: readonly CastSlot[],
  characters: readonly Pick<CastCharacter, 'id' | 'folderId'>[]
): Set<number> {
  const ids = new Set<number>()
  for (const s of slots) {
    if (s.charId !== null) ids.add(s.charId)
    for (const cand of s.candidates) {
      if (cand.kind === 'char' && cand.id !== null) ids.add(cand.id)
      else if (cand.kind === 'folder') for (const c of characters) if (c.folderId === cand.id) ids.add(c.id)
    }
  }
  return ids
}

// ── 뽑기 ───────────────────────────────────────────────────

function drawSlot(
  slot: CastSlot,
  plan: CastPlan,
  state: DrawState,
  rng: Rng,
  blocked: (c: CastCharacter) => boolean,
  note: (msg: string) => void,
  label: string
): CastCharacter | null {
  if (slot.mode === 'chance') {
    const pct = Math.max(0, Math.min(100, slot.chance))
    // 확률을 넘으면 이번에는 안 나온다 (참고 문구 없음 — 의도한 결과)
    if (!(rng() * 100 < pct)) return null
  }
  if (slot.mode === 'sequential') {
    const list = orderedCandidates(slot, plan.characters)
    if (!list.length) {
      note(`${label}: 후보가 없어 비웠습니다`)
      return null
    }
    const key = `slot:${slot.id}`
    // 배치에 한 번이면 배치마다 한 번만 여기에 온다 — 지난 배치들이 넘긴 자리에서 시작한다
    const n = state.seq[key] ?? (plan.options.scope === 'batch' ? cursorAt(state.cursors, key) : 0)
    state.seq[key] = n + 1
    if (!slot.wrap && n >= list.length) {
      note(`${label}: 순서가 끝나 비웠습니다`)
      return null
    }
    // 차례인 캐릭터가 다른 슬롯에 나와 있으면 그다음 사람으로
    for (let k = 0; k < list.length; k++) {
      const c = list[(n + k) % list.length]
      if (!blocked(c)) return c
    }
    note(`${label}: 후보가 모두 다른 슬롯에 나와 비웠습니다`)
    return null
  }
  // random · chance
  const pool = weightedCandidates(slot, plan.characters)
  if (!pool.length) {
    note(`${label}: 후보가 없어 비웠습니다`)
    return null
  }
  const open = pool.filter((p) => !blocked(p.char))
  const i = weightedIndex(
    open.map((p) => p.weight),
    rng
  )
  if (i < 0) {
    note(
      open.length
        ? `${label}: 후보의 비중이 모두 0이라 비웠습니다`
        : `${label}: 후보가 모두 다른 슬롯에 나와 비웠습니다`
    )
    return null
  }
  return open[i].char
}

function drawVariations(c: CastCharacter, state: DrawState, rng: Rng, advance: CastCursors): ResolvedVariation[] {
  const out: ResolvedVariation[] = []
  for (const g of c.variations) {
    if (g.mode === 'off' || !g.items.length) continue
    const key = `var:${c.id}:${g.id}`
    let item: VariationItem | undefined
    if (g.mode === 'fixed') {
      item = g.items.find((x) => x.id === g.fixedId) ?? g.items[0]
    } else if (g.perBatch && key in state.vars) {
      const id = state.vars[key]
      item = id === null ? undefined : g.items.find((x) => x.id === id)
    } else {
      if (g.mode === 'random') {
        const i = weightedIndex(
          g.items.map((x) => x.weight),
          rng
        )
        item = i < 0 ? undefined : g.items[i]
      } else {
        // 배치마다 한 번만 뽑는 순차는 지난 배치들이 넘긴 자리에서 시작한다 (장마다 뽑는 순차는 배치마다 처음부터)
        const n = state.seq[key] ?? (g.perBatch ? cursorAt(state.cursors, key) : 0)
        state.seq[key] = n + 1
        item = g.items[n % g.items.length]
      }
      if (g.perBatch) state.vars[key] = item ? item.id : null
    }
    if (g.perBatch && g.mode === 'sequential' && state.seq[key] !== undefined) advance[key] = state.seq[key]
    if (!item) continue
    out.push({
      groupId: g.id,
      group: variationGroupLabel(g),
      itemId: item.id,
      label: item.label.trim() || item.prompt.trim() || '(빈 항목)',
      prompt: item.prompt
    })
  }
  return out
}

/**
 * 슬롯을 풀어 이번 장에 나올 캐릭터를 정한다.
 * 고정 슬롯이 먼저 자리를 잡고(중복 금지면 다른 슬롯이 그 캐릭터를 뽑지 않는다), 나머지 슬롯을 순서대로 뽑는다.
 * 그다음 뽑힌 캐릭터마다 변형을 고르고 캡션을 합친다. 모델 한도(maxCharacters)를 넘는 뒤쪽 캐릭터는 dropped로.
 * state는 그 자리에서 고친다 (순차 카운터·배치에 한 번 뽑은 결과).
 */
export function resolveCast(
  plan: CastPlan,
  state: DrawState,
  rng: Rng = Math.random,
  maxCharacters = Infinity
): CastResolution {
  const notes: string[] = []
  const note = (m: string): void => {
    notes.push(m)
  }
  const { options } = plan
  const byId = new Map(plan.characters.map((c) => [c.id, c]))
  const active = plan.slots.filter((s) => s.enabled)
  const labelOf = (s: CastSlot): string => `슬롯 ${plan.slots.indexOf(s) + 1}`
  const taken = new Set<number>()
  const blocked = (c: CastCharacter): boolean => !options.allowDuplicates && taken.has(c.id)
  const picks = new Map<number, CastCharacter>()

  // 1) 고정 슬롯이 먼저 자리를 잡는다
  for (const s of active) {
    if (s.mode !== 'fixed') continue
    const c = s.charId === null ? undefined : byId.get(s.charId)
    if (!c) {
      note(`${labelOf(s)}: 캐릭터를 찾을 수 없어 비웠습니다`)
      continue
    }
    if (blocked(c)) {
      note(`${labelOf(s)}: ${c.name}이(가) 이미 다른 슬롯에 있어 뺐습니다 (중복 금지)`)
      continue
    }
    taken.add(c.id)
    picks.set(s.id, c)
  }

  // 2) 나머지 슬롯을 순서대로 뽑는다 (배치에 한 번이면 처음 뽑은 결과를 계속 쓴다)
  const advance: CastCursors = {}
  for (const s of active) {
    if (s.mode === 'fixed') continue
    const key = `slot:${s.id}`
    let c: CastCharacter | null
    if (options.scope === 'batch' && key in state.slots) {
      const id = state.slots[key]
      c = id === null ? null : (byId.get(id) ?? null)
      if (c && blocked(c)) c = null
    } else {
      c = drawSlot(s, plan, state, rng, blocked, note, labelOf(s))
      if (options.scope === 'batch') state.slots[key] = c ? c.id : null
    }
    // 배치에 한 번 뽑은 순차 슬롯: 이 장도 그 차례를 썼다 — 그림이 나오면 다음 배치는 다음 차례부터
    if (options.scope === 'batch' && s.mode === 'sequential' && state.seq[key] !== undefined) advance[key] = state.seq[key]
    if (!c) continue
    taken.add(c.id)
    picks.set(s.id, c)
  }

  // 3) 슬롯 순서대로 변형을 고르고 캡션을 합친다
  const chars: ResolvedCharacter[] = []
  for (const s of active) {
    const c = picks.get(s.id)
    if (!c) continue
    const variations = drawVariations(c, state, rng, advance)
    const prompt = composeCaption(c, variations)
    if (!prompt) {
      note(`${labelOf(s)}: ${c.name}의 프롬프트가 비어 있어 뺐습니다`)
      continue
    }
    chars.push({
      slotId: s.id,
      charId: c.id,
      name: c.name,
      prompt,
      negative: c.negative,
      center: s.center ? { ...s.center } : null,
      variations
    })
  }

  const limit = Math.max(0, Math.floor(maxCharacters))
  const dropped = chars.length > limit ? chars.splice(limit) : []
  if (dropped.length) {
    note(`모델 한도 ${limit}명을 넘어 ${dropped.map((c) => c.name).join(', ')}을(를) 뺐습니다`)
  }
  return { chars, dropped, notes, advance }
}

/** 씬별 출연(캐릭터 id 목록 + 위치)을 고정 슬롯으로 — 씬 캐릭터에도 변형이 그대로 적용된다 */
export function fixedSlots(charIds: readonly number[], centers?: Record<number, Center>): CastSlot[] {
  return charIds.map((id) => ({
    id,
    enabled: true,
    mode: 'fixed',
    charId: id,
    candidates: [],
    chance: 100,
    wrap: true,
    center: centers?.[id] ? { ...centers[id] } : null
  }))
}

// ── 히스토리 기록 ──────────────────────────────────────────

/** 히스토리 snap에 남기는 뽑기 원본 — "재추첨 생성"이 같은 조건으로 다시 뽑는다 */
export interface CastSnapshot {
  plan: CastPlan
  /** 씬 생성이면 씬 프롬프트 원본(조각 치환 전) — 메인 프롬프트 원본은 snap의 base·additional·detail */
  scene?: { prompt: string; negative: string }
}

/** 히스토리 sent에 남기는 뽑기 결과 (sent.chars와 같은 순서) */
export interface CastSent {
  chars: { slotId: number; charId: number; variations: { group: string; label: string }[] }[]
  /** 모델 한도로 뺀 캐릭터 이름 */
  dropped?: string[]
  /** 인원 태그를 고쳐 보냈으면 원래 태그 → 고친 태그 */
  countFix?: { from: string; to: string }
}

export function castSent(res: CastResolution, countFix?: CastSent['countFix']): CastSent {
  return {
    chars: res.chars.map((c) => ({
      slotId: c.slotId,
      charId: c.charId,
      variations: c.variations.map((v) => ({ group: v.group, label: v.label }))
    })),
    ...(res.dropped.length ? { dropped: res.dropped.map((c) => c.name) } : {}),
    ...(countFix ? { countFix } : {})
  }
}

// ── 인원 태그 ──────────────────────────────────────────────

type Sex = 'girl' | 'boy' | 'other'
const SEXES: Sex[] = ['girl', 'boy', 'other']

/** 가중치·괄호·밑줄을 걷어 낸 태그 (비교용) */
function bareTag(tag: string): string {
  return tag
    .trim()
    .replace(/^-?\d+(?:\.\d+)?::/, '')
    .replace(/::$/, '')
    .replace(/^[{[(]+/, '')
    .replace(/[}\])]+$/, '')
    .replace(/:\d+(?:\.\d+)?$/, '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase()
}

interface CountTag {
  sex?: Sex
  /** 정확한 수 */
  n?: number
  /** 이상 (6+girls = 6, multiple girls = 2) */
  atLeast?: number
  solo?: boolean
  none?: boolean
}

function parseCountTag(tag: string): CountTag | null {
  const t = bareTag(tag)
  const m = /^(\d+)(\+)?\s*(girl|boy|other)s?$/.exec(t)
  if (m) {
    const n = Number(m[1])
    return m[2] ? { sex: m[3] as Sex, atLeast: n } : { sex: m[3] as Sex, n }
  }
  const multi = /^multiple (girl|boy|other)s$/.exec(t)
  if (multi) return { sex: multi[1] as Sex, atLeast: 2 }
  if (t === 'solo') return { solo: true }
  if (t === 'no humans') return { none: true }
  return null
}

/** 주석 줄을 뺀 쉼표 태그들 */
function tagsOf(prompt: string): string[] {
  return removeComments(prompt)
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

const isCommentLine = (line: string): boolean => line.trimStart().startsWith('#')

/** 쉼표 칸 하나를 감싼 문법과 태그로 — bareTag가 걷어 내는 자리 그대로 (앞: 가중치 `1.2::`·여는 괄호, 뒤: `:1.2`·닫는 괄호·`::`) */
interface TagSyntax {
  lead: string
  weight: string
  open: string
  core: string
  colon: string
  close: string
  end: string
  trail: string
}

function splitTagSyntax(part: string): TagSyntax {
  const m = /^(\s*)(-?\d+(?:\.\d+)?::)?([{[(]*)(.*?)(:\d+(?:\.\d+)?)?([}\])]*)(::)?(\s*)$/s.exec(part)
  const g = (i: number): string => m?.[i] ?? ''
  return m
    ? { lead: g(1), weight: g(2), open: g(3), core: g(4), colon: g(5), close: g(6), end: g(7), trail: g(8) }
    : { lead: '', weight: '', open: '', core: part, colon: '', close: '', end: '', trail: '' }
}

interface FoundCountTag {
  line: number
  /** 그 줄을 쉼표로 나눈 칸 번호 */
  part: number
  /** 적힌 그대로 (앞뒤 공백만 뺌) */
  raw: string
  tag: CountTag
}

/**
 * 프롬프트의 인원 태그 (주석 줄 제외, 쉼표 칸마다).
 * 음수·0 가중치 안의 태그(-1::solo:: 등)는 "그 인원이 아니게"라는 뜻이라 인원 태그로 세지도 고치지도 않는다.
 */
function findCountTags(prompt: string): FoundCountTag[] {
  const lines = prompt.split('\n')
  // 주석 줄은 같은 길이의 공백으로 바꿔 위치는 그대로 두고, 그 안의 가중치 문법은 무시한다
  const segments = parseWeights(lines.map((l) => (isCommentLine(l) ? ' '.repeat(l.length) : l)).join('\n'))
  const weightAt = (pos: number): number => segments.find((x) => pos >= x.start && pos < x.end)?.weight ?? 1
  const found: FoundCountTag[] = []
  let lineStart = 0
  lines.forEach((line, li) => {
    if (!isCommentLine(line)) {
      let pos = lineStart
      line.split(',').forEach((part, pi) => {
        const tag = parseCountTag(part)
        if (tag) {
          const x = splitTagSyntax(part)
          if (weightAt(pos + x.lead.length + x.weight.length + x.open.length) > 0) {
            found.push({ line: li, part: pi, raw: part.trim(), tag })
          }
        }
        pos += part.length + 1
      })
    }
    lineStart += line.length + 1
  })
  return found
}

export interface CountCheck {
  /** 메인 프롬프트에서 찾은 인원 태그 (적힌 그대로) */
  tags: string[]
  /** 태그가 말하는 인원 범위 */
  min: number
  max: number
  actual: number
  conflict: boolean
}

/**
 * 메인 프롬프트의 인원 태그(1girl·2girls·1boy·solo·multiple girls·no humans …)와 실제 캐릭터 수를 맞춰 본다.
 * 인원 태그가 없거나 캐릭터가 없으면(메인 프롬프트만으로 그리는 경우) null.
 */
export function checkPeopleCount(prompt: string, actual: number): CountCheck | null {
  if (actual <= 0) return null
  const found = findCountTags(prompt)
  if (!found.length) return null
  let min = 0
  let max = 0
  let open = false
  let counted = false
  let solo = false
  let none = false
  const bySex = new Map<Sex, { n: number; atLeast: number }>()
  for (const { tag } of found) {
    if (tag.solo) solo = true
    if (tag.none) none = true
    if (!tag.sex) continue
    counted = true
    const cur = bySex.get(tag.sex) ?? { n: 0, atLeast: 0 }
    if (tag.n !== undefined) cur.n = Math.max(cur.n, tag.n)
    if (tag.atLeast !== undefined) cur.atLeast = Math.max(cur.atLeast, tag.atLeast)
    bySex.set(tag.sex, cur)
  }
  for (const v of bySex.values()) {
    // "2girls, multiple girls"처럼 정확한 수가 있으면 그것이 우선
    if (v.n) {
      min += v.n
      max += v.n
    } else {
      min += v.atLeast
      open = true
    }
  }
  if (!counted) {
    min = none ? 0 : 1
    max = none ? 0 : solo ? 1 : Infinity
  } else if (open) max = Infinity
  if (solo) {
    min = Math.max(min, 1)
    max = Math.min(max, 1)
  }
  if (none) max = 0
  const conflict = actual < min || actual > max
  return { tags: found.map((f) => f.raw), min, max, actual, conflict }
}

const SEX_WORDS: Record<Sex, string[]> = {
  girl: ['girl', '1girl', 'woman', 'female', 'mature female'],
  boy: ['boy', '1boy', 'man', 'male', 'mature male'],
  other: ['other', '1other']
}

/** 캐릭터 캡션에 적힌 성별 (girl·boy·other 태그). 알 수 없으면 null */
export function sexOfCaption(caption: string): Sex | null {
  for (const raw of tagsOf(caption)) {
    const t = bareTag(raw)
    for (const sex of SEXES) if (SEX_WORDS[sex].includes(t)) return sex
  }
  return null
}

function countTag(sex: Sex, n: number): string {
  if (n >= 6) return `6+${sex}s`
  return `${n}${sex}${n > 1 ? 's' : ''}`
}

/**
 * 인원 태그를 실제 캐릭터에 맞게 고친 프롬프트. 고칠 필요가 없으면(충돌 없음·태그 없음) null.
 * 성별은 캐릭터 캡션의 girl/boy/other 태그로 판단하고, 알 수 없으면 원래 프롬프트에 가장 많이 적힌 성별로 친다.
 * 처음 나온 인원 태그 자리에 새 태그를 넣고 나머지 인원 태그는 지운다 (주석 줄은 건드리지 않음).
 * 태그를 감싼 가중치·괄호는 그대로 둔다 — 새 태그는 그 안에 넣고, 지운 태그가 열거나 닫던 문법은 이웃 태그로 옮겨 짝을 맞춘다.
 */
export function fixPeopleCount(
  prompt: string,
  chars: readonly { prompt: string }[]
): { prompt: string; from: string; to: string } | null {
  const check = checkPeopleCount(prompt, chars.length)
  if (!check?.conflict) return null
  // 원래 태그에서 가장 많이 적힌 성별 (알 수 없는 캐릭터용)
  const written = new Map<Sex, number>()
  for (const raw of check.tags) {
    const t = parseCountTag(raw)
    if (t?.sex) written.set(t.sex, (written.get(t.sex) ?? 0) + (t.n ?? t.atLeast ?? 1))
  }
  const fallback: Sex = [...written.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'girl'
  const counts: Record<Sex, number> = { girl: 0, boy: 0, other: 0 }
  for (const c of chars) counts[sexOfCaption(c.prompt) ?? fallback]++
  const next: string[] = SEXES.filter((s) => counts[s] > 0).map((s) => countTag(s, counts[s]))
  const total = chars.length
  const hadSolo = check.tags.some((t) => parseCountTag(t)?.solo)
  if (total === 1 && hadSolo) next.push('solo')
  for (const s of SEXES) {
    if (counts[s] >= 2 && check.tags.some((t) => bareTag(t) === `multiple ${s}s`)) next.push(`multiple ${s}s`)
  }
  const to = next.join(', ')

  const targets = new Set(findCountTags(prompt).map((f) => `${f.line}:${f.part}`))
  const closerOf: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
  let inserted = false
  /** 지운 태그가 열어 둔 문법 (가중치 `1.2::`·여는 괄호) — 다음에 남는 태그 앞에 붙인다 */
  let pending: string[] = []
  const lines = prompt.split('\n').map((line, li) => {
    if (isCommentLine(line)) return line
    const kept: string[] = []
    line.split(',').forEach((part, pi) => {
      if (!targets.has(`${li}:${pi}`)) {
        if (pending.length) {
          const lead = /^\s*/.exec(part)?.[0] ?? ''
          part = lead + pending.join('') + part.slice(lead.length)
          pending = []
        }
        kept.push(part)
        return
      }
      const x = splitTagSyntax(part)
      if (!inserted) {
        inserted = true
        kept.push(x.lead + x.weight + x.open + to + x.colon + x.close + x.end + x.trail)
        return
      }
      // 지우는 태그: 여는 문법은 미뤄 두고, 닫는 문법은 미뤄 둔 것과 짝이 맞으면 함께 없애고 아니면 앞 태그에 붙인다
      if (x.weight) pending.push(x.weight)
      pending.push(...x.open)
      let tail = ''
      for (const closer of x.end ? [...x.close, x.end] : [...x.close]) {
        const top = pending[pending.length - 1]
        const pairs = top !== undefined && (closer === '::' ? top.endsWith('::') : closerOf[top] === closer)
        if (pairs) pending.pop()
        else tail += closer
      }
      if (!tail) return
      if (kept.length) kept[kept.length - 1] = kept[kept.length - 1].replace(/\s*$/, (ws) => tail + ws)
      else kept.push(x.lead + tail)
    })
    // 줄 끝까지 열린 채 남은 문법은 그 줄 끝에 둔다 (다음 줄 태그에 그대로 걸린다)
    if (pending.length) {
      kept.push((kept.length ? ' ' : '') + pending.join(''))
      pending = []
    }
    // 지운 태그는 배열에서 빠지므로 쉼표가 겹치지 않는다 (사용자가 쓴 줄 끝 쉼표 등은 그대로 둔다)
    return kept.join(',')
  })
  return { prompt: lines.join('\n'), from: check.tags.join(', '), to }
}
