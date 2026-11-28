import { describe, expect, it } from 'vitest'
import {
  AXIS_TEMPLATES,
  applyAxisTemplate,
  createProject,
  describeAction,
  describeMatrixSize,
  expandMatrix,
  missingTemplateValues,
  orphanItems,
  parseComboKey,
  parseValueLines,
  planJobs,
  progressByValue,
  projectGuide,
  reviewQueue,
  templateLines,
  templatesFor,
  type Axis,
  type Project
} from '../src/project'
import { addImage, emptyItem, markExported, setMarks } from '../src/project/curation'
import { useProjects } from '../src/project/store'

/** 캐릭터 2 × 표정 4 (8조합), 목표 1 */
function sample(): Project {
  const p = createProject('봄 이벤트', {}, 1000)
  p.id = 'P'
  p.characters = [
    { id: 'A', libraryId: null, name: '민지', vibeIds: [], refIds: [] },
    { id: 'B', libraryId: null, name: '하늘', vibeIds: [], refIds: [] }
  ]
  const face: Axis = {
    id: 'e',
    kind: 'expression',
    name: '표정',
    target: 'character',
    values: [
      { id: 'n', label: '기본', slug: 'neutral', prompt: 'closed mouth' },
      { id: 's', label: '웃음', slug: 'smile', prompt: 'smile' },
      { id: 'c', label: '울음', prompt: 'crying' },
      { id: 'a', label: '화남', prompt: 'angry' }
    ]
  }
  p.axes = [face]
  p.defaults = { count: 2, target: 1 }
  return p
}

let nextId = 1
/** 조합에 그림 n장 (mark로) */
function give(p: Project, key: string, n: number, mark: 'unreviewed' | 'adopted' | 'rejected' = 'unreviewed'): void {
  let item = p.items[key] ?? emptyItem(key)
  for (let i = 0; i < n; i++) {
    const id = nextId++
    item = addImage(item, { id, ts: id }, { fromQueue: false })
    if (mark !== 'unreviewed') item = setMarks(item, [id], mark)
  }
  p.items[key] = item
}

const keys = (p: Project): string[] => expandMatrix(p).combos.map((c) => c.key)

describe('projectGuide', () => {
  it('empty project → set up characters and axes (step 2)', () => {
    const g = projectGuide(createProject('새'))
    expect(g.step).toBe(2)
    expect(g.actions).toEqual([{ kind: 'setup' }])
    expect(describeAction(g.actions[0])).toContain('캐릭터')
  })

  it('axes but nothing generated → generate all combos (step 3)', () => {
    const g = projectGuide(sample())
    expect(g.step).toBe(3)
    expect(g.actions).toEqual([{ kind: 'generate', combos: 8 }])
  })

  it('images waiting for review come first, with missing combos as the second action', () => {
    const p = sample()
    const k = keys(p)
    give(p, k[0], 2)
    give(p, k[1], 2)
    give(p, k[2], 1, 'adopted')
    const g = projectGuide(p)
    expect(g.step).toBe(4)
    expect(g.actions[0]).toEqual({ kind: 'review', combos: 2, images: 4 })
    expect(g.actions[1]).toEqual({ kind: 'missing', combos: 5 })
  })

  it('running images are shown as the second action while reviewing when nothing else is left to do', () => {
    const p = sample()
    const k = keys(p)
    give(p, k[0], 2)
    p.items[k[1]] = { ...emptyItem(k[1]), queued: 3 }
    for (const key of k.slice(2)) {
      give(p, key, 1, 'adopted')
      const item = p.items[key]
      p.items[key] = markExported(item, item.images[0].id, `x/${key}.png`, 1)
    }
    expect(projectGuide(p).actions).toEqual([
      { kind: 'review', combos: 1, images: 2 },
      { kind: 'running', images: 3 }
    ])
    // 모자란 조합이 있으면 그쪽(누를 수 있는 일)이 둘째
    delete p.items[k[7]]
    expect(projectGuide(p).actions[1]).toEqual({ kind: 'missing', combos: 1 })
  })

  it('only running → running (step 3)', () => {
    const p = sample()
    p.items[keys(p)[0]] = { ...emptyItem(keys(p)[0]), generating: 1, queued: 1 }
    const g = projectGuide(p)
    expect(g.step).toBe(3)
    expect(g.actions[0]).toEqual({ kind: 'running', images: 2 })
  })

  it('missing combos then export: adopted but not exported → export (step 5) → done', () => {
    const p = sample()
    const k = keys(p)
    for (const key of k.slice(0, 7)) give(p, key, 1, 'adopted')
    give(p, k[7], 1, 'rejected')
    let g = projectGuide(p)
    expect(g.actions[0]).toEqual({ kind: 'missing', combos: 1 })
    expect(g.actions[1]).toEqual({ kind: 'export', images: 7 })
    give(p, k[7], 1, 'adopted')
    g = projectGuide(p)
    expect(g.step).toBe(5)
    expect(g.actions).toEqual([{ kind: 'export', images: 8 }])
    for (const key of k) {
      const item = p.items[key]
      const img = item.images.find((i) => i.mark === 'adopted')!
      p.items[key] = markExported(item, img.id, `x/${key}.png`, 1)
    }
    g = projectGuide(p)
    expect(g.step).toBe(6)
    expect(g.actions).toEqual([{ kind: 'done' }])
  })

  it('a combo flagged "재생성 필요" with its target met is a redo action, not missing, and never "done"', () => {
    const p = sample()
    const k = keys(p)
    for (const key of k) give(p, key, 1, 'adopted')
    p.items[k[2]] = { ...p.items[k[2]], redo: true }
    const g = projectGuide(p)
    // "부족한 것만" 계획은 이 조합을 만들지 않으니(채택이 목표만큼) 모자란 조합으로 세지 않는다
    expect(g.actions[0]).toEqual({ kind: 'redo', combos: 1 })
    expect(g.actions[1]).toEqual({ kind: 'export', images: 8 })
    expect(describeAction(g.actions[0])).toContain('재생성')
  })

  it('missing counts only combos the missing plan would generate (flagged redo with too few adopted counts)', () => {
    const p = sample()
    const k = keys(p)
    for (const key of k.slice(1)) give(p, key, 1, 'adopted')
    p.items[k[0]] = { ...emptyItem(k[0]), redo: true, failed: 1 }
    expect(projectGuide(p).actions[0]).toEqual({ kind: 'missing', combos: 1 })
  })

  it('the missing count equals the combos the "부족한 것만" plan makes with unreviewed images counted as filled', () => {
    const p = sample()
    const k = keys(p)
    give(p, k[0], 2) // 고를 그림 2장 (목표 1) → 만들지 않음
    give(p, k[1], 1, 'adopted')
    give(p, k[2], 1, 'rejected') // 다 탈락 → 재생성 필요 → 만든다
    p.items[k[3]] = { ...emptyItem(k[3]), queued: 1 } // 대기 중 → 만들지 않음
    // 목표 3인데 고를 그림 1장뿐 → 상태는 선별 필요지만 2장 모자람 → 만든다
    p.overrides = [{ id: 'o', match: { character: 'B', e: 'n' }, target: 3 }]
    give(p, k[4], 1)
    const g = projectGuide(p)
    const plan = planJobs(p, 'missing', { countUnreviewed: true })
    expect(plan.jobs.map((j) => j.key)).toEqual([k[2], k[4], k[5], k[6], k[7]])
    expect(g.actions).toContainEqual({ kind: 'missing', combos: plan.jobs.length })
  })

  it('too many combos → tooMany', () => {
    const p = sample()
    p.limits = { ...p.limits, hardLimit: 4 }
    expect(projectGuide(p).actions).toEqual([{ kind: 'tooMany' }])
  })

  it('does not change the project', () => {
    const p = sample()
    give(p, keys(p)[0], 2)
    const before = JSON.stringify(p)
    projectGuide(p)
    reviewQueue(p, expandMatrix(p).combos)
    progressByValue(p, expandMatrix(p).combos, 'character')
    expect(JSON.stringify(p)).toBe(before)
  })
})

describe('reviewQueue', () => {
  it('lists combos needing review in matrix order, and wraps around from a given combo', () => {
    const p = sample()
    const k = keys(p)
    give(p, k[1], 1)
    give(p, k[3], 1)
    give(p, k[6], 1)
    give(p, k[4], 1, 'adopted')
    const combos = expandMatrix(p).combos
    expect(reviewQueue(p, combos)).toEqual([k[1], k[3], k[6]])
    expect(reviewQueue(p, combos, k[3])).toEqual([k[6], k[1]])
    expect(reviewQueue(p, combos, k[0])).toEqual([k[1], k[3], k[6]])
  })

  it('a combo whose target is met is no longer in the queue even with unreviewed images left', () => {
    const p = sample()
    const k = keys(p)
    give(p, k[0], 3)
    p.items[k[0]] = setMarks(p.items[k[0]], [p.items[k[0]].images[0].id], 'adopted')
    expect(reviewQueue(p, expandMatrix(p).combos)).toEqual([])
  })
})

describe('progressByValue', () => {
  it('counts adopted/target per value of an axis', () => {
    const p = sample()
    const k = keys(p)
    give(p, k[0], 1, 'adopted') // 민지 · 기본
    give(p, k[1], 2) // 민지 · 웃음
    give(p, k[4], 2, 'adopted') // 하늘 · 기본 (목표 1까지만 센다)
    const combos = expandMatrix(p).combos
    const byChar = progressByValue(p, combos, 'character')
    expect(byChar.get('A')).toEqual({ combos: 4, adopted: 1, target: 4, review: 1, pending: 2 })
    expect(byChar.get('B')).toEqual({ combos: 4, adopted: 1, target: 4, review: 0, pending: 3 })
    const byFace = progressByValue(p, combos, 'e')
    expect(byFace.get('n')).toEqual({ combos: 2, adopted: 2, target: 2, review: 0, pending: 0 })
  })

  it('describes how the matrix is built', () => {
    const p = sample()
    p.exclusions = [{ id: 'x', when: { character: ['B'], e: ['a'] } }]
    expect(describeMatrixSize(expandMatrix(p))).toBe('캐릭터 2 × 표정 4 = 7개 (제외 1)')
  })
})

describe('axis templates', () => {
  const basic = AXIS_TEMPLATES.find((t) => t.id === 'expression-basic')!

  it('has unique slugs and parseable lines for every template', () => {
    for (const t of AXIS_TEMPLATES) {
      expect(new Set(t.values.map((v) => v.slug)).size).toBe(t.values.length)
      const parsed = parseValueLines(templateLines(t.values))
      expect(parsed).toEqual(t.values.map((v) => ({ label: v.label, slug: v.slug, prompt: v.prompt })))
    }
    expect(templatesFor('expression').map((t) => t.id)).toEqual(['expression-basic', 'expression-more'])
  })

  it('creates a new axis with all values when the project has no axis of that kind', () => {
    const p = createProject('새')
    const r = applyAxisTemplate(p, basic)
    const axis = r.project.axes.find((a) => a.id === r.axisId)!
    expect(axis.kind).toBe('expression')
    expect(axis.name).toBe('표정')
    expect(axis.target).toBe('character')
    expect(axis.values.map((v) => v.slug)).toEqual(['neutral', 'smile', 'cry', 'angry', 'surprised', 'shy'])
    expect(r.added).toHaveLength(6)
  })

  it('adds only the missing values to an existing axis and never changes the existing ones', () => {
    const p = sample()
    // 기본(neutral)·웃음(smile)은 이미 있고, 울음은 이름만 같다 (slug 없음) — 셋 다 건너뛴다
    p.axes[0].values[1] = { ...p.axes[0].values[1], prompt: 'my own smile, grin' }
    const before = JSON.stringify(p.axes[0].values)
    expect(missingTemplateValues(p.axes[0], basic).map((v) => v.label)).toEqual(['놀람', '부끄러움'])
    const r = applyAxisTemplate(p, basic)
    expect(r.axisId).toBe('e')
    expect(r.project.axes).toHaveLength(1)
    const values = r.project.axes[0].values
    expect(JSON.stringify(values.slice(0, 4))).toBe(before)
    expect(values.slice(4).map((v) => v.label)).toEqual(['놀람', '부끄러움'])
    // 다시 넣어도 아무것도 늘지 않는다
    const again = applyAxisTemplate(r.project, basic)
    expect(again.added).toEqual([])
    expect(again.project).toBe(r.project)
  })

  it('matches existing values by slug as well as by name (case-insensitive)', () => {
    const axis = { values: [{ id: '1', label: 'Smiling', slug: 'SMILE', prompt: '' }] }
    expect(missingTemplateValues(axis, basic).map((v) => v.slug)).not.toContain('smile')
  })

  it('newAxis makes a separate axis even when one of the kind exists', () => {
    const r = applyAxisTemplate(sample(), basic, { newAxis: true })
    expect(r.project.axes).toHaveLength(2)
    expect(r.project.axes[1].values).toHaveLength(6)
  })

  it('carries existing images into the first value of a new axis, like adding values one by one', () => {
    // 그림을 만든 뒤 의상 세트를 새 축으로 넣으면 지금까지의 그림은 첫 값(교복)의 조합으로 옮겨져 행렬에 남는다
    const p = sample()
    const k = keys(p)
    give(p, k[0], 2)
    const r = applyAxisTemplate(p, AXIS_TEMPLATES.find((t) => t.id === 'outfit-basic')!)
    const outfit = r.project.axes[1]
    const [key] = Object.keys(r.project.items)
    expect(parseComboKey(key)).toEqual({ ...parseComboKey(k[0]), [outfit.id]: outfit.values[0].id })
    expect(r.project.items[key].images).toHaveLength(2)
    expect(orphanItems(r.project)).toEqual([])
  })

  it('store.applyAxisTemplate inserts into the stored project', () => {
    const s = useProjects.getState()
    const id = s.create('세트')
    const axisId = s.applyAxisTemplate(id, 'outfit-basic')
    const proj = useProjects.getState().projects.find((x) => x.id === id)!
    expect(proj.axes.map((a) => a.id)).toEqual([axisId])
    expect(proj.axes[0].values.map((v) => v.label)).toEqual(['교복', '사복', '잠옷', '수영복'])
    expect(s.applyAxisTemplate(id, 'nope')).toBeNull()
  })
})
