/**
 * 축 빠른 시작 세트 — 표정·의상처럼 자주 쓰는 값 묶음 (이름 · 파일 이름 · 프롬프트 조각).
 * 넣은 뒤에는 보통 값처럼 고칠 수 있다. 이미 있는 축에 넣을 때는 같은 이름·파일 이름의 값을 건너뛰고
 * 빠진 것만 더한다 — 있던 값을 바꾸거나 지우지 않는다.
 */
import { addAxis, addValue, keyedAxes, parseValueLines } from './model'
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
export function missingTemplateValues(
  axis: { values: readonly { label: string; slug?: string }[] } | undefined,
  t: AxisTemplate
): AxisTemplateValue[] {
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

/**
 * "여러 줄 추가" 칸에 세트를 불러온다 — 축에도, 칸에 이미 적은 줄에도 없는 값만 줄로 덧붙인다
 * (세트 칩을 두 번 눌러도 같은 줄이 두 번 들어가 같은 파일 이름의 값이 둘 생기지 않게). 더할 것이 없으면 text 그대로
 */
export function appendTemplateLines(text: string, axis: { values: readonly { label: string; slug?: string }[] }, t: AxisTemplate): string {
  const missing = missingTemplateValues({ values: [...axis.values, ...parseValueLines(text)] }, t)
  if (!missing.length) return text
  const lines = templateLines(missing)
  return text.trim() ? `${text.replace(/\s+$/, '')}\n${lines}` : lines
}

/** 세트를 넣을 축 — axisId를 주면 그 축, 아니면 같은 종류의 첫 축 (없으면 새 축) */
export function templateTarget(project: Pick<Project, 'axes'>, t: AxisTemplate, axisId?: string): Axis | undefined {
  if (axisId) return project.axes.find((a) => a.id === axisId)
  return project.axes.find((a) => a.kind === t.kind)
}

/** 지금까지의 그림을 받을 빈 값 ("기본 의상" — 태그 없이 만든 그림이라 프롬프트 조각이 비어 있다) */
export function keepValueFor(t: AxisTemplate): AxisTemplateValue {
  return { label: `기본 ${t.axisName}`, slug: 'default', prompt: '' }
}

export interface TemplateOptions {
  axisId?: string
  newAxis?: boolean
  /**
   * 세트를 넣으면 지금까지의 그림이 첫 값의 조합으로 옮겨질 때(templateCarry) 세트 값보다 먼저 빈 값(keepValueFor)을
   * 만들어 그 그림을 거기에 둔다 — 교복 태그 없이 만든 그림이 "교복"으로 내보내지지 않게
   */
  keepExisting?: boolean
}

/**
 * 세트를 넣는다 — 대상 축(templateTarget)이 있으면 빠진 값만 그 축 끝에, 없으면 새 축을 만들어 전부.
 * 값을 더하는 것은 model.addValue와 같아서(첫 값이면 지금까지의 그림을 그 값의 조합으로 옮김) 키 변화도 같다.
 * 있던 값은 바꾸지 않는다
 */
export function applyAxisTemplate(
  project: Project,
  t: AxisTemplate,
  opts: TemplateOptions = {}
): { project: Project; axisId: string; added: AxisValue['id'][] } {
  let p = project
  let target = opts.newAxis ? undefined : templateTarget(p, t, opts.axisId)
  if (!target) {
    const r = addAxis(p, t.kind, t.axisName)
    p = r.project
    target = p.axes.find((a) => a.id === r.id)!
  }
  const added: string[] = []
  const missing = missingTemplateValues(target, t)
  // 켠 값이 없는 축에 처음 넣는 값이 지금까지의 그림을 받는다 — 원하면 그 자리에 빈 값을 먼저
  if (opts.keepExisting && missing.length && !keyedAxes(p).has(target.id)) {
    const r = addValue(p, target.id, keepValueFor(t))
    p = r.project
    added.push(r.id)
  }
  for (const v of missing) {
    const r = addValue(p, target.id, { label: v.label, slug: v.slug, prompt: v.prompt })
    p = r.project
    added.push(r.id)
  }
  return { project: p, axisId: target.id, added }
}

/** 세트를 넣으면 첫 값의 조합으로 옮겨질 지금까지의 그림 (장수 · 그중 채택 · 받을 값 이름). 옮겨질 그림이 없으면 null */
export function templateCarry(
  project: Project,
  t: AxisTemplate,
  opts: Omit<TemplateOptions, 'keepExisting'> = {}
): { images: number; adopted: number; label: string } | null {
  const r = applyAxisTemplate(project, t, opts)
  if (!r.added.length) return null
  let images = 0
  let adopted = 0
  for (const [key, item] of Object.entries(r.project.items)) {
    if (key in project.items) continue
    images += item.images.length
    adopted += item.images.filter((i) => i.mark === 'adopted').length
  }
  if (!images) return null
  const axis = r.project.axes.find((a) => a.id === r.axisId)
  const label = axis?.values.find((v) => v.id === r.added[0])?.label ?? ''
  return { images, adopted, label }
}
