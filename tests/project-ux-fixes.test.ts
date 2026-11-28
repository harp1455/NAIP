// 프로젝트 탭 다듬기 검수 뒤 고친 것 — 단계 막대, 보류만 남은 조합, 세트를 넣을 때 지금까지의 그림, 여러 줄 칸의 세트 칩
import { describe, expect, it } from 'vitest'
import {
  AXIS_TEMPLATES,
  appendTemplateLines,
  applyAxisTemplate,
  createProject,
  expandMatrix,
  keepValueFor,
  orphanItems,
  parseComboKey,
  parseValueLines,
  projectGuide,
  reviewQueue,
  reviewState,
  templateCarry,
  type Axis,
  type Project
} from '../src/project'
import { addImage, emptyItem, markExported, setMarks } from '../src/project/curation'
import { useProjects } from '../src/project/store'

const outfitSet = AXIS_TEMPLATES.find((t) => t.id === 'outfit-basic')!
const faceSet = AXIS_TEMPLATES.find((t) => t.id === 'expression-basic')!

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
      { id: 'c', label: '울음', slug: 'cry', prompt: 'crying' },
      { id: 'a', label: '화남', slug: 'angry', prompt: 'angry' }
    ]
  }
  p.axes = [face]
  p.defaults = { count: 2, target: 1 }
  return p
}

let nextId = 1
function give(p: Project, key: string, n: number, mark: 'unreviewed' | 'adopted' | 'rejected' | 'hold' = 'unreviewed'): void {
  let item = p.items[key] ?? emptyItem(key)
  for (let i = 0; i < n; i++) {
    const id = nextId++
    item = addImage(item, { id, ts: id }, { fromQueue: false })
    if (mark !== 'unreviewed') item = setMarks(item, [id], mark)
  }
  p.items[key] = item
}

const keys = (p: Project): string[] => expandMatrix(p).combos.map((c) => c.key)

/** 조합 8개에 2장씩 16장, 앞의 셋은 1장씩 채택 */
function started(): Project {
  const p = sample()
  const k = keys(p)
  for (const key of k) give(p, key, 2)
  for (const key of k.slice(0, 3)) p.items[key] = setMarks(p.items[key], [p.items[key].images[0].id], 'adopted')
  return p
}

describe('step bar states', () => {
  it('setup and first generation', () => {
    expect(projectGuide(createProject('새')).steps).toEqual(['done', 'now', 'todo', 'todo', 'todo'])
    expect(projectGuide(sample()).steps).toEqual(['done', 'done', 'now', 'todo', 'todo'])
  })

  it('reviewing while many combos are still 미생성 does not paint 생성 as done', () => {
    // 그림을 만든 뒤 의상 세트(4개)를 넣었다 — 지금까지의 그림은 첫 값으로, 나머지 24조합은 미생성
    const p = applyAxisTemplate(started(), outfitSet).project
    const g = projectGuide(p)
    expect(g.step).toBe(4)
    expect(g.actions[0].kind).toBe('review')
    expect(g.steps).toEqual(['done', 'done', 'doing', 'now', 'doing'])
  })

  it('generation is done once nothing is missing, running or flagged', () => {
    const p = sample()
    for (const key of keys(p)) give(p, key, 2)
    expect(projectGuide(p).steps).toEqual(['done', 'done', 'done', 'now', 'todo'])
    p.items[keys(p)[0]] = { ...p.items[keys(p)[0]], queued: 1 }
    expect(projectGuide(p).steps[2]).toBe('doing')
  })

  it('missing first with adopted images to export → 내보내기 is in progress, not now', () => {
    const p = sample()
    const k = keys(p)
    for (const key of k.slice(0, 7)) give(p, key, 1, 'adopted')
    const g = projectGuide(p)
    expect(g.actions[0].kind).toBe('missing')
    expect(g.steps).toEqual(['done', 'done', 'now', 'todo', 'doing'])
  })

  it('export step and done', () => {
    const p = sample()
    for (const key of keys(p)) give(p, key, 1, 'adopted')
    expect(projectGuide(p).steps).toEqual(['done', 'done', 'done', 'done', 'now'])
    for (const key of keys(p)) {
      const item = p.items[key]
      p.items[key] = markExported(item, item.images[0].id, `x/${key}.png`, 1)
    }
    expect(projectGuide(p).steps).toEqual(['done', 'done', 'done', 'done', 'done'])
  })
})

describe('reviewState', () => {
  it('a combo with only 보류 images left is "held" and stays in the review queue', () => {
    const p = sample()
    const k = keys(p)
    give(p, k[6], 1, 'hold')
    expect(reviewState(p.items[k[6]], 1)).toBe('held')
    expect(reviewQueue(p, expandMatrix(p).combos)).toEqual([k[6]])
    expect(projectGuide(p).actions[0]).toEqual({ kind: 'review', combos: 1, images: 0 })
    // 보류를 탈락으로 정하면 다 본 것 — 고를 조합에서 빠진다
    p.items[k[6]] = setMarks(p.items[k[6]], [p.items[k[6]].images[0].id], 'rejected')
    expect(reviewState(p.items[k[6]], 1)).toBe('seen')
    expect(reviewQueue(p, expandMatrix(p).combos)).toEqual([])
  })

  it('open while unreviewed images are left, filled once the target is met', () => {
    const p = sample()
    const k = keys(p)
    give(p, k[0], 2)
    give(p, k[0], 1, 'hold')
    expect(reviewState(p.items[k[0]], 1)).toBe('open')
    p.items[k[0]] = setMarks(p.items[k[0]], [p.items[k[0]].images[0].id], 'adopted')
    expect(reviewState(p.items[k[0]], 1)).toBe('filled')
    expect(reviewState(p.items[k[0]], 2)).toBe('open')
    expect(reviewState(undefined, 1)).toBe('seen')
  })
})

describe('inserting a set when images already exist', () => {
  it('templateCarry says how many images would go into the first value of the new axis', () => {
    expect(templateCarry(started(), outfitSet)).toEqual({ images: 16, adopted: 3, label: '교복' })
    // 그림이 없거나, 이미 값이 있는 축에 더하면 옮겨질 그림이 없다
    expect(templateCarry(sample(), outfitSet)).toBeNull()
    expect(templateCarry(started(), faceSet)).toBeNull()
    // 생성 대기 중이면 옮기지 않는다 (화면은 그때 따로 묻는다)
    const busy = started()
    busy.items[keys(busy)[0]] = { ...busy.items[keys(busy)[0]], queued: 1 }
    expect(templateCarry(busy, outfitSet)).toBeNull()
  })

  it('keepExisting puts the old images under a blank "기본 의상" value instead of 교복', () => {
    const p = started()
    const r = applyAxisTemplate(p, outfitSet, { keepExisting: true })
    const outfit = r.project.axes.find((a) => a.id === r.axisId)!
    expect(outfit.values.map((v) => [v.label, v.slug, v.prompt])).toEqual([
      ['기본 의상', 'default', ''],
      ['교복', 'uniform', 'school uniform'],
      ['사복', 'casual', 'casual'],
      ['잠옷', 'pajamas', 'pajamas'],
      ['수영복', 'swimsuit', 'swimsuit']
    ])
    expect(keepValueFor(outfitSet)).toEqual({ label: '기본 의상', slug: 'default', prompt: '' })
    const blank = outfit.values[0].id
    const moved = Object.values(r.project.items)
    expect(moved).toHaveLength(8)
    expect(moved.every((i) => parseComboKey(i.key)[outfit.id] === blank)).toBe(true)
    expect(moved.reduce((n, i) => n + i.images.length, 0)).toBe(16)
    expect(orphanItems(r.project)).toEqual([])
    // 교복 조합은 비어 있다 (교복 태그로 만든 그림이 아니므로)
    const uniform = outfit.values[1].id
    expect(expandMatrix(r.project).combos.filter((c) => c.coords[outfit.id] === uniform).every((c) => !r.project.items[c.key])).toBe(true)
  })

  it('without keepExisting the images go to the first set value (unchanged behaviour)', () => {
    const r = applyAxisTemplate(started(), outfitSet)
    const outfit = r.project.axes.find((a) => a.id === r.axisId)!
    expect(outfit.values.map((v) => v.label)).toEqual(['교복', '사복', '잠옷', '수영복'])
    expect(Object.values(r.project.items).every((i) => parseComboKey(i.key)[outfit.id] === outfit.values[0].id)).toBe(true)
  })

  it('keepExisting adds no blank value when nothing would be carried into the first value', () => {
    // 값이 있는 축에 더할 때
    const r = applyAxisTemplate(started(), faceSet, { keepExisting: true })
    expect(r.project.axes[0].values.map((v) => v.label)).toEqual(['기본', '웃음', '울음', '화남', '놀람', '부끄러움'])
    // 다 있으면 아무것도
    const again = applyAxisTemplate(r.project, faceSet, { keepExisting: true })
    expect(again.added).toEqual([])
    expect(again.project).toBe(r.project)
  })

  it('store.applyAxisTemplate passes keepExisting through', () => {
    const s = useProjects.getState()
    const id = s.create('세트')
    s.addCharacter(id, { libraryId: null, name: '민지' })
    const proj = useProjects.getState().projects.find((x) => x.id === id)!
    const key = expandMatrix(proj).combos[0].key
    s.addImage(id, key, { id: 77001, ts: 1 }, { fromQueue: false })
    const axisId = s.applyAxisTemplate(id, 'outfit-basic', { keepExisting: true })
    const after = useProjects.getState().projects.find((x) => x.id === id)!
    const outfit = after.axes.find((a) => a.id === axisId)!
    expect(outfit.values[0].label).toBe('기본 의상')
    const [only] = Object.values(after.items)
    expect(parseComboKey(only.key)[outfit.id]).toBe(outfit.values[0].id)
  })
})

describe('appendTemplateLines', () => {
  const empty = { values: [] as { label: string; slug?: string }[] }

  it('tapping the same set twice does not add the lines twice', () => {
    const once = appendTemplateLines('', empty, faceSet)
    expect(parseValueLines(once)).toHaveLength(6)
    expect(appendTemplateLines(once, empty, faceSet)).toBe(once)
  })

  it('keeps what was typed and adds only lines missing from both the axis and the box', () => {
    const axis = { values: [{ label: '기본', slug: 'neutral' }] }
    const typed = '웃음 (grin): grin\n'
    const out = appendTemplateLines(typed, axis, faceSet)
    expect(out.startsWith('웃음 (grin): grin\n')).toBe(true)
    expect(parseValueLines(out).map((v) => v.label)).toEqual(['웃음', '울음', '화남', '놀람', '부끄러움'])
    // 다른 세트는 이어 붙는다
    const more = appendTemplateLines(out, axis, AXIS_TEMPLATES.find((t) => t.id === 'expression-more')!)
    expect(parseValueLines(more)).toHaveLength(11)
    const slugs = parseValueLines(more).map((v) => v.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})
