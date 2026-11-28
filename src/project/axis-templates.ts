/**
 * 축 빠른 시작 세트 — 표정·의상처럼 자주 쓰는 값 묶음 (이름 · 파일 이름 · 프롬프트 조각).
 * 넣은 뒤에는 보통 값처럼 고칠 수 있다. 이미 있는 축에 넣을 때는 같은 이름·파일 이름의 값을 건너뛰고
 * 빠진 것만 더한다 — 있던 값을 바꾸거나 지우지 않는다.
 */
import { addAxis, addValue } from './model'
import type { Axis, AxisKind, AxisValue, Project } from './types'

export interface AxisTemplateValue {
  label: string
  slug: string
  prompt: string
}

export interface AxisTemplate {
  id: string
  kind: AxisKind
  /** 세트 이름 (단추) */
  title: string
  /** 새 축으로 만들 때 축 이름 */
  axisName: string
  values: AxisTemplateValue[]
}

export const AXIS_TEMPLATES: readonly AxisTemplate[] = [
  {
    id: 'expression-basic',
    kind: 'expression',
    title: '표정 기본 세트',
    axisName: '표정',
    values: [
      { label: '기본', slug: 'neutral', prompt: 'closed mouth' },
      { label: '웃음', slug: 'smile', prompt: 'smile, open mouth' },
      { label: '울음', slug: 'cry', prompt: 'crying, tears' },
      { label: '화남', slug: 'angry', prompt: 'angry, v-shaped eyebrows, frown' },
      { label: '놀람', slug: 'surprised', prompt: 'surprised, open mouth, wide-eyed' },
      { label: '부끄러움', slug: 'shy', prompt: 'blush, embarrassed, looking away' }
    ]
  },
  {
    id: 'expression-more',
    kind: 'expression',
    title: '표정 추가 세트',
    axisName: '표정',
    values: [
      { label: '슬픔', slug: 'sad', prompt: 'sad, frown, downturned eyes' },
      { label: '당황', slug: 'flustered', prompt: 'flustered, sweatdrop, wavy mouth' },
      { label: '윙크', slug: 'wink', prompt: 'one eye closed, smile' },
      { label: '자신만만', slug: 'smug', prompt: 'smug, half-closed eyes' },
      { label: '졸림', slug: 'sleepy', prompt: 'sleepy, half-closed eyes' },
      { label: '생각', slug: 'thinking', prompt: 'thinking, looking up' }
    ]
  },
  {
    id: 'outfit-basic',
    kind: 'outfit',
    title: '의상 기본 세트',
    axisName: '의상',
    values: [
      { label: '교복', slug: 'uniform', prompt: 'school uniform' },
      { label: '사복', slug: 'casual', prompt: 'casual' },
      { label: '잠옷', slug: 'pajamas', prompt: 'pajamas' },
      { label: '수영복', slug: 'swimsuit', prompt: 'swimsuit' }
    ]
  }
]

export function templatesFor(kind: AxisKind): AxisTemplate[] {
  return AXIS_TEMPLATES.filter((t) => t.kind === kind)
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase()

/** 축에 아직 없는 세트 값 (같은 표시 이름이나 같은 파일 이름이 있으면 있는 것으로 본다) */
export function missingTemplateValues(axis: Pick<Axis, 'values'> | undefined, t: AxisTemplate): AxisTemplateValue[] {
  const have = new Set<string>()
  for (const v of axis?.values ?? []) {
    have.add(norm(v.label))
    if (v.slug) have.add(norm(v.slug))
  }
  return t.values.filter((v) => !have.has(norm(v.label)) && !have.has(norm(v.slug)))
}

/** 여러 줄 붙여넣기 칸에 넣을 글 ("웃음 (smile): smile, open mouth") — model.parseValueLines가 그대로 읽는다 */
export function templateLines(values: readonly AxisTemplateValue[]): string {
  return values.map((v) => `${v.label} (${v.slug}): ${v.prompt}`).join('\n')
}

/** 세트를 넣을 축 — axisId를 주면 그 축, 아니면 같은 종류의 첫 축 (없으면 새 축) */
export function templateTarget(project: Pick<Project, 'axes'>, t: AxisTemplate, axisId?: string): Axis | undefined {
  if (axisId) return project.axes.find((a) => a.id === axisId)
  return project.axes.find((a) => a.kind === t.kind)
}

/**
 * 세트를 넣는다 — 대상 축(templateTarget)이 있으면 빠진 값만 그 축 끝에, 없으면 새 축을 만들어 전부.
 * 값을 더하는 것은 model.addValue와 같아서(첫 값이면 지금까지의 그림을 그 값의 조합으로 옮김) 키 변화도 같다.
 * 있던 값은 바꾸지 않는다
 */
export function applyAxisTemplate(
  project: Project,
  t: AxisTemplate,
  opts: { axisId?: string; newAxis?: boolean } = {}
): { project: Project; axisId: string; added: AxisValue['id'][] } {
  let p = project
  let target = opts.newAxis ? undefined : templateTarget(p, t, opts.axisId)
  if (!target) {
    const r = addAxis(p, t.kind, t.axisName)
    p = r.project
    target = p.axes.find((a) => a.id === r.id)!
  }
  const added: string[] = []
  for (const v of missingTemplateValues(target, t)) {
    const r = addValue(p, target.id, { label: v.label, slug: v.slug, prompt: v.prompt })
    p = r.project
    added.push(r.id)
  }
  return { project: p, axisId: target.id, added }
}
