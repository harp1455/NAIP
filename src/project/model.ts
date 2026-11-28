/**
 * 프로젝트 만들기·고치기 순수 함수 — 축·값·캐릭터를 지울 때 그것을 가리키는 제외 규칙·덮어쓰기·분류 규칙도
 * 함께 정리한다 (조건이 사라진 덮어쓰기·제외 규칙이 엉뚱하게 넓어지지 않도록 규칙째 지운다).
 * 에셋 항목(그림)은 지우지 않는다 — 행렬에서 빠진 항목은 matrix.orphanItems로 따로 보여 준다.
 * 축이 조합 키에 새로 들어올 때(첫 값·첫 캐릭터 추가)는 carryItemKeys가 지금까지의 그림을 새 키로 옮겨
 * 행렬에 남긴다. 하나뿐인 값·캐릭터를 지우면 그 그림은 "행렬에서 빠진 조합"으로 간다 (옮기지 않는다).
 */
import { emptyItem } from './curation'
import { comboKey, excludedBy, parseComboKey, projectAxes } from './matrix'
import {
  CHARACTER_AXIS,
  DEFAULT_AXIS_TARGET,
  DEFAULT_CODES,
  DEFAULT_LIMITS,
  DEFAULT_MANIFEST,
  DEFAULT_NAMING,
  AXIS_KIND_LABEL,
  type AssetItem,
  type Axis,
  type AxisKind,
  type AxisValue,
  type Project,
  type ProjectCharacter,
  type ProjectParams
} from './types'

let lastId = ''
/** 짧은 고정 id (조합 키에 들어가므로 영문·숫자만) */
export function newId(): string {
  let id = ''
  do {
    id = Date.now().toString(36) + Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')
  } while (id === lastId)
  lastId = id
  return id
}

/** 프롬프트 화면 기본값과 같은 설정 (리드는 보통 지금 화면의 params를 넘긴다) */
export const DEFAULT_PROJECT_PARAMS: ProjectParams = {
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  variety: false,
  qualityToggle: true,
  ucPreset: 0
}

export function createProject(name: string, params: Partial<ProjectParams> = {}, now = Date.now()): Project {
  return {
    id: newId(),
    name: name.trim() || '새 프로젝트',
    createdAt: now,
    updatedAt: now,
    characters: [],
    stylePrompt: '',
    stylePosition: 'start',
    negative: '',
    params: { ...DEFAULT_PROJECT_PARAMS, ...params },
    vibeIds: [],
    refIds: [],
    axes: [],
    exclusions: [],
    overrides: [],
    rules: [],
    defaults: { count: 4, target: 1 },
    limits: { ...DEFAULT_LIMITS },
    naming: { ...DEFAULT_NAMING },
    manifest: { ...DEFAULT_MANIFEST, columns: [...DEFAULT_MANIFEST.columns] },
    codes: { ...DEFAULT_CODES },
    convertPresetId: null,
    exportCounters: {},
    items: {}
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 조합 항목 맵에서 객체인 항목만 (손상·조작된 백업의 null·숫자·문자열 항목은 읽다가 멈추지 않게 뺀다) */
function itemRecords(items: unknown): Record<string, AssetItem> {
  if (!isRecord(items)) return {}
  const out: Record<string, AssetItem> = {}
  for (const [k, v] of Object.entries(items)) if (isRecord(v)) out[k] = v as unknown as AssetItem
  return out
}

/** 예전 버전에서 저장한 프로젝트에 빠진 칸을 채운다 */
export function normalizeProject(p: Partial<Project> & Pick<Project, 'id' | 'name'>): Project {
  const base = createProject(p.name, p.params, p.createdAt ?? Date.now())
  return {
    ...base,
    ...p,
    params: { ...base.params, ...p.params },
    defaults: { ...base.defaults, ...p.defaults },
    limits: { ...base.limits, ...p.limits },
    naming: { ...base.naming, ...p.naming },
    manifest: { ...base.manifest, ...p.manifest },
    codes: { ...base.codes, ...p.codes },
    exportCounters: { ...(p.exportCounters ?? {}) },
    items: itemRecords(p.items)
  } as Project
}

/** 앱을 다시 열면 대기열은 비어 있으니 대기·생성 중 장수를 0으로 */
export function resetRuntime(p: Project): Project {
  let changed = false
  const items: Record<string, AssetItem> = {}
  for (const [k, item] of Object.entries(p.items)) {
    if (item.queued || item.generating) {
      changed = true
      items[k] = { ...item, queued: 0, generating: 0 }
    } else items[k] = item
  }
  return changed ? { ...p, items } : p
}

/** 복제 — 설정만 (그림·선별·내보내기 기록은 빼고) */
export function duplicateProject(p: Project, now = Date.now()): Project {
  return {
    ...(JSON.parse(JSON.stringify({ ...p, items: {} })) as Project),
    id: newId(),
    name: `${p.name} 복사`,
    createdAt: now,
    updatedAt: now,
    exportCounters: {}
  }
}

// ── 에셋 항목 ────────────────────────────────────────────────────────────────

export function withItem(p: Project, key: string, fn: (item: AssetItem) => AssetItem, now = Date.now()): Project {
  const prev = p.items[key] ?? emptyItem(key)
  const next = fn(prev)
  if (next === prev) return p
  return { ...p, updatedAt: now, items: { ...p.items, [key]: next } }
}

// ── 캐릭터 ───────────────────────────────────────────────────────────────────

export function addCharacter(
  p: Project,
  c: Partial<Omit<ProjectCharacter, 'id'>> & { name: string }
): { project: Project; id: string } {
  const id = newId()
  const ch: ProjectCharacter = { libraryId: null, vibeIds: [], refIds: [], ...c, id, name: c.name.trim() || '이름 없음' }
  return { project: carryItemKeys(p, { ...p, characters: [...p.characters, ch] }), id }
}

export function removeCharacter(p: Project, charId: string): Project {
  const scrubbed = removeValueRefs(p, CHARACTER_AXIS, charId)
  return carryItemKeys(p, {
    ...scrubbed,
    characters: scrubbed.characters.filter((c) => c.id !== charId),
    // 캐릭터별 조각도 정리
    axes: scrubbed.axes.map((a) => ({
      ...a,
      values: a.values.map((v) => {
        if (!v.perCharacter?.[charId]) return v
        const per = { ...v.perCharacter }
        delete per[charId]
        return { ...v, perCharacter: per }
      })
    }))
  })
}

// ── 축 · 값 ──────────────────────────────────────────────────────────────────

export function addAxis(p: Project, kind: AxisKind, name?: string): { project: Project; id: string } {
  const id = newId()
  const axis: Axis = {
    id,
    kind: kind === 'character' ? 'custom' : kind,
    name: name?.trim() || AXIS_KIND_LABEL[kind],
    target: DEFAULT_AXIS_TARGET[kind],
    values: []
  }
  return { project: { ...p, axes: [...p.axes, axis] }, id }
}

export function removeAxis(p: Project, axisId: string): Project {
  return carryItemKeys(p, {
    ...p,
    axes: p.axes.filter((a) => a.id !== axisId),
    // 제외 규칙은 모든 조건이 맞아야 하는 AND라, 이 축 조건만 떼면 규칙이 넓어진다
    // (하늘 + 수영복 → 하늘 전부). 지운 축의 값은 다시 맞을 수 없으니 규칙째 뺀다
    exclusions: p.exclusions.filter((r) => !(axisId in r.when)),
    overrides: p.overrides.filter((o) => !(axisId in o.match)),
    rules: p.rules.filter((r) => r.axisId !== axisId)
  })
}

export function moveAxis(p: Project, axisId: string, dir: -1 | 1): Project {
  const i = p.axes.findIndex((a) => a.id === axisId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= p.axes.length) return p
  const axes = [...p.axes]
  ;[axes[i], axes[j]] = [axes[j], axes[i]]
  return { ...p, axes }
}

/** 축 안에서 값 순서를 한 칸 옮긴다 (조합 키는 값 id라 바뀌지 않는다) */
export function moveValue(p: Project, axisId: string, valueId: string, dir: -1 | 1): Project {
  const axis = p.axes.find((a) => a.id === axisId)
  if (!axis) return p
  const i = axis.values.findIndex((v) => v.id === valueId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= axis.values.length) return p
  const values = [...axis.values]
  ;[values[i], values[j]] = [values[j], values[i]]
  return { ...p, axes: p.axes.map((a) => (a.id === axisId ? { ...a, values } : a)) }
}

/** 캐릭터 순서를 한 칸 옮긴다 (행렬 순서가 바뀐다. 코드 글자는 내보내기에서 처음 쓸 때 캐릭터에 적어 두어 그대로다) */
export function moveCharacter(p: Project, charId: string, dir: -1 | 1): Project {
  const i = p.characters.findIndex((c) => c.id === charId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= p.characters.length) return p
  const characters = [...p.characters]
  ;[characters[i], characters[j]] = [characters[j], characters[i]]
  return { ...p, characters }
}

export function addValue(
  p: Project,
  axisId: string,
  v: Partial<Omit<AxisValue, 'id'>> & { label: string }
): { project: Project; id: string } {
  const id = newId()
  const value: AxisValue = { prompt: '', ...v, id, label: v.label.trim() || '이름 없음' }
  return {
    project: carryItemKeys(p, { ...p, axes: p.axes.map((a) => (a.id === axisId ? { ...a, values: [...a.values, value] } : a)) }),
    id
  }
}

/** 값을 가리키는 제외·덮어쓰기·분류 규칙 정리 */
function removeValueRefs(p: Project, axisId: string, valueId: string): Project {
  return {
    ...p,
    exclusions: p.exclusions.flatMap((r) => {
      const list = r.when[axisId]
      if (!list?.includes(valueId)) return [r]
      const rest = list.filter((v) => v !== valueId)
      // 그 축에 남은 값이 없으면 규칙이 더는 맞을 수 없다
      return rest.length ? [{ ...r, when: { ...r.when, [axisId]: rest } }] : []
    }),
    overrides: p.overrides.filter((o) => o.match[axisId] !== valueId),
    rules: p.rules.filter((r) => !(r.axisId === axisId && r.valueId === valueId))
  }
}

export function removeValue(p: Project, axisId: string, valueId: string): Project {
  const scrubbed = removeValueRefs(p, axisId, valueId)
  return carryItemKeys(p, {
    ...scrubbed,
    axes: scrubbed.axes.map((a) => (a.id === axisId ? { ...a, values: a.values.filter((v) => v.id !== valueId) } : a))
  })
}

/** 조합 키에 들어가는 축(켠 값이 있는 축) → 켠 값 id들 (matrix.expandMatrix와 같은 기준) */
export function keyedAxes(p: Pick<Project, 'characters' | 'axes'>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const axis of projectAxes(p)) {
    const on = axis.values.filter((v) => v.enabled !== false).map((v) => v.id)
    if (on.length) out.set(axis.id, on)
  }
  return out
}

/** 키의 축·값이 이 행렬 모양(켠 값이 있는 축 전부, 그 축의 켠 값)에 맞는가 */
function fitsKeyedAxes(keyed: Map<string, string[]>, coords: Record<string, string>): boolean {
  const axes = Object.keys(coords)
  return axes.length === keyed.size && axes.every((a) => keyed.get(a)?.includes(coords[a]))
}

/**
 * 조합 키는 켠 값이 있는 축 전부로 만들어서, 빈 축에 첫 값을 넣으면(첫 캐릭터 포함) 모든 키가 바뀌고
 * 지금까지의 그림·선별·코드가 통째로 "행렬에서 빠진 조합"으로 밀려난다.
 * 그 경우(키에 들어가는 축이 하나 늘고, 그 축의 켠 값이 하나뿐일 때)만 지금 행렬 모양의 항목에 그 값을 붙여
 * 새 키로 옮긴다 (지금까지의 그림 = 첫 값의 조합 — 화면에도 그렇게 안내한다).
 * 축이 빠질 때(하나뿐인 값·캐릭터 삭제)는 옮기지 않는다 — 떼어 두면 다음에 넣는 값·캐릭터가 지운 값의 그림을
 * 자기 것으로 넘겨받는다 (교복 그림이 수영복 채택으로, 민지 그림이 하늘 것으로). 그 그림은 빠진 조합에 남는다.
 * 옮길 자리에 이미 항목이 있으면 합치지 않고 그대로 둔다. 생성 대기·생성 중인 항목이 있으면(대기열이 옛 키로
 * 결과를 넣는다) 옮기지 않는다 — 화면은 orphanedByEdit로 먼저 묻는다. 그림은 지우지 않는다.
 */
export function carryItemKeys(prev: Project, next: Project): Project {
  const entries = Object.values(next.items)
  if (!entries.length || entries.some((i) => i.queued > 0 || i.generating > 0)) return next
  const before = keyedAxes(prev)
  const after = keyedAxes(next)
  const added = [...after.keys()].filter((a) => !before.has(a))
  const removed = [...before.keys()].filter((a) => !after.has(a))
  if (added.length !== 1 || removed.length) return next
  const axisId = added[0]
  const values = after.get(axisId)!
  if (values.length !== 1) return next
  const valueId = values[0]
  const items = { ...next.items }
  const counters = { ...next.exportCounters }
  let moved = false
  for (const item of entries) {
    const coords = parseComboKey(item.key)
    // 지금(prev) 행렬 모양인 키만 — 이미 빠져 있던 항목은 건드리지 않는다
    if (!fitsKeyedAxes(before, coords)) continue
    const key = comboKey({ ...coords, [axisId]: valueId })
    if (key === item.key || items[key]) continue
    delete items[item.key]
    items[key] = { ...item, key }
    const from = `combination:${item.key}`
    const to = `combination:${key}`
    if (counters[from] !== undefined && counters[to] === undefined) {
      counters[to] = counters[from]
      delete counters[from]
    }
    moved = true
  }
  return moved ? { ...next, items, exportCounters: counters } : next
}

/**
 * 편집(prev → next, 키 옮기기까지 한 결과)으로 행렬 안에서 "행렬에서 빠진 조합"으로 밀려나는 그림 장수.
 * 확인 창용 — 켜고 끄기로 축이 바뀔 때, 생성 대기 중이라 carryItemKeys가 옮기지 못할 때
 */
export function orphanedByEdit(prev: Project, next: Project): number {
  const before = keyedAxes(prev)
  const after = keyedAxes(next)
  let n = 0
  for (const item of Object.values(next.items)) {
    if (!item.images.length) continue
    const coords = parseComboKey(item.key)
    const liveBefore = fitsKeyedAxes(before, coords) && !excludedBy(coords, prev.exclusions)
    const liveAfter = fitsKeyedAxes(after, coords) && !excludedBy(coords, next.exclusions)
    if (liveBefore && !liveAfter) n += item.images.length
  }
  return n
}

/**
 * 값 여러 줄 붙여넣기 — 한 줄에 하나:
 *   "웃음: smile, open mouth"            → 이름 웃음, 프롬프트 smile, open mouth
 *   "웃음 (smile): smile, open mouth"    → 괄호 안은 파일 이름용 slug
 *   "smile, open mouth"                  → 이름이 없으면 첫 조각을 이름으로
 *   "artist:wlop, smile"                 → 영문 단어 바로 뒤의 콜론(띄어 쓰지 않음)은 NovelAI 태그(artist:·text:)라
 *                                          이름으로 보지 않는다. 이름은 "이름: " 처럼 띄어 쓰거나 전각 콜론으로
 * 빈 줄·# 주석 줄은 건너뛴다
 */
export function parseValueLines(text: string): { label: string; slug?: string; prompt: string }[] {
  const out: { label: string; slug?: string; prompt: string }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // 첫 콜론(전각 포함) 앞이 이름 (쉼표가 든 앞부분은 이름이 아니다).
    // 가중치 문법(1.2::tag::)의 ::와 영문 태그의 콜론(artist:wlop)은 이름 구분으로 보지 않는다
    const hit = /^([^:：,]+?)\s*([:：])(?!:)(\s*)(.*)$/.exec(line)
    const tagSyntax = !!hit && hit[2] === ':' && !hit[3] && /^[\x20-\x7e]+$/.test(hit[1])
    const m = hit && !tagSyntax ? hit : null
    let head = m ? m[1].trim() : ''
    const prompt = (m ? m[4] : line).trim()
    let slug: string | undefined
    const paren = /^(.*?)\s*[(（]([^()（）]+)[)）]$/.exec(head)
    if (paren && paren[1].trim()) {
      head = paren[1].trim()
      slug = paren[2].trim()
    }
    const label = head || prompt.split(',')[0].trim().slice(0, 30)
    if (!label && !prompt) continue
    out.push({ label: label || '이름 없음', ...(slug ? { slug } : {}), prompt })
  }
  return out
}
