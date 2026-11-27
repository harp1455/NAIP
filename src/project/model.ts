/**
 * 프로젝트 만들기·고치기 순수 함수 — 축·값·캐릭터를 지울 때 그것을 가리키는 제외 규칙·덮어쓰기·분류 규칙도
 * 함께 정리한다 (조건이 사라진 덮어쓰기가 엉뚱하게 넓어지지 않도록 규칙째 지운다).
 * 에셋 항목(그림)은 지우지 않는다 — 행렬에서 빠진 항목은 matrix.orphanItems로 따로 보여 준다.
 */
import { emptyItem } from './curation'
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
    items: { ...(p.items ?? {}) }
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
  return { project: { ...p, characters: [...p.characters, ch] }, id }
}

export function removeCharacter(p: Project, charId: string): Project {
  const scrubbed = removeValueRefs(p, CHARACTER_AXIS, charId)
  return {
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
  }
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
  return {
    ...p,
    axes: p.axes.filter((a) => a.id !== axisId),
    exclusions: p.exclusions.flatMap((r) => {
      if (!(axisId in r.when)) return [r]
      const when = { ...r.when }
      delete when[axisId]
      // 남은 조건이 없으면 규칙이 모든 조합을 지우게 되니 규칙째 뺀다
      return Object.keys(when).length ? [{ ...r, when }] : []
    }),
    overrides: p.overrides.filter((o) => !(axisId in o.match)),
    rules: p.rules.filter((r) => r.axisId !== axisId)
  }
}

export function moveAxis(p: Project, axisId: string, dir: -1 | 1): Project {
  const i = p.axes.findIndex((a) => a.id === axisId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= p.axes.length) return p
  const axes = [...p.axes]
  ;[axes[i], axes[j]] = [axes[j], axes[i]]
  return { ...p, axes }
}

export function addValue(
  p: Project,
  axisId: string,
  v: Partial<Omit<AxisValue, 'id'>> & { label: string }
): { project: Project; id: string } {
  const id = newId()
  const value: AxisValue = { prompt: '', ...v, id, label: v.label.trim() || '이름 없음' }
  return {
    project: { ...p, axes: p.axes.map((a) => (a.id === axisId ? { ...a, values: [...a.values, value] } : a)) },
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
  return {
    ...scrubbed,
    axes: scrubbed.axes.map((a) => (a.id === axisId ? { ...a, values: a.values.filter((v) => v.id !== valueId) } : a))
  }
}
