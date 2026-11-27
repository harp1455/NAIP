/**
 * 분류 — 프로젝트로 만들지 않은 그림(히스토리)을 프롬프트·씬 이름·캐릭터 이름으로 조합에 배정한다.
 * 프로젝트로 생성한 그림은 분류 표시(ProjectImageTag)가 붙어 있으니 이것이 필요 없다.
 *
 * 규칙(ClassificationRule)이 먼저이고, useFragments면 값의 프롬프트 조각이 통째로 들어 있는지도 본다.
 * 한 축에서 둘 이상의 값이 맞으면 모호하다고 보고 배정하지 않는다.
 */
import { comboKey, excludedBy, projectAxes } from './matrix'
import { CHARACTER_AXIS, type ClassificationRule, type Project, type ProjectImageTag } from './types'

export interface ClassifyInput {
  prompt: string
  sceneName?: string
  /** 보낸 캐릭터 이름들 */
  characterNames?: string[]
  /** 보낸 캐릭터 프롬프트들 */
  characterPrompts?: string[]
}

export interface ClassifyResult {
  /** 축 id → 값 id (맞은 축만) */
  coords: Record<string, string>
  /** 모든 축이 정해지고 제외되지 않았으면 분류 표시 */
  tag: ProjectImageTag | null
  /** 값을 못 정한 축 / 둘 이상 맞아 모호한 축 */
  missing: string[]
  ambiguous: string[]
}

/** 쉼표로 나눈 단어 (소문자, 밑줄 → 공백) — 히스토리 검색과 같은 방식 */
export function classifyTerms(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/_/g, ' ')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

function contains(haystack: string, needle: string): boolean {
  const t = classifyTerms(needle)
  if (!t.length) return false
  const h = haystack.toLowerCase().replace(/_/g, ' ')
  return t.every((x) => h.includes(x))
}

function fieldText(input: ClassifyInput, field: ClassificationRule['field']): string {
  const prompt = [input.prompt, ...(input.characterPrompts ?? [])].join('\n')
  switch (field) {
    case 'prompt':
      return prompt
    case 'scene':
      return input.sceneName ?? ''
    case 'character':
      return (input.characterNames ?? []).join(', ')
    case 'any':
      return [prompt, input.sceneName ?? '', ...(input.characterNames ?? [])].join('\n')
  }
}

export function classify(project: Project, input: ClassifyInput, opts: { useFragments?: boolean } = {}): ClassifyResult {
  const coords: Record<string, string> = {}
  const missing: string[] = []
  const ambiguous: string[] = []
  for (const axis of projectAxes(project)) {
    const hits = new Set<string>()
    for (const rule of project.rules) {
      if (rule.axisId !== axis.id) continue
      if (contains(fieldText(input, rule.field), rule.match)) hits.add(rule.valueId)
    }
    if (!hits.size && axis.id === CHARACTER_AXIS) {
      // 캐릭터는 보낸 캐릭터 이름으로
      const names = new Set((input.characterNames ?? []).map((n) => n.trim().toLowerCase()))
      for (const c of project.characters) if (names.has(c.name.trim().toLowerCase())) hits.add(c.id)
    }
    if (!hits.size && opts.useFragments) {
      const text = fieldText(input, 'prompt')
      for (const v of axis.values) if (v.prompt.trim() && contains(text, v.prompt)) hits.add(v.id)
    }
    const live = [...hits].filter((id) => axis.values.some((v) => v.id === id && v.enabled !== false))
    if (live.length === 1) coords[axis.id] = live[0]
    else if (live.length > 1) ambiguous.push(axis.id)
    else missing.push(axis.id)
  }
  const complete = !missing.length && !ambiguous.length && Object.keys(coords).length > 0
  const tag =
    complete && !excludedBy(coords, project.exclusions) ? { projectId: project.id, key: comboKey(coords), coords } : null
  return { coords, tag, missing, ambiguous }
}
