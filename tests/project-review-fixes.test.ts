/**
 * Phase 5 프로젝트 핵심(모델·분류·이름·목록·코드)의 검토 지적 회귀 테스트 — 고치기 전에는 실패한다
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NAMING,
  addAxis,
  addCharacter,
  addValue,
  characterCode,
  characterCodes,
  classify,
  createProject,
  expandMatrix,
  orphanItems,
  parseValueLines,
  planExport,
  presetToConvertOptions,
  previewPaths,
  previousExportPath,
  removeAxis,
  removeCharacter,
  removeValue,
  toCsv,
  validatePreset,
  type NamingSettings,
  type Project
} from '../src/project'
import { addImage, emptyItem, markExported, setMarks, setSlotCodes } from '../src/project/curation'
import { savedCounters } from '../src/project/save'

const naming = (x: Partial<NamingSettings> = {}): NamingSettings => ({ ...DEFAULT_NAMING, ...x })

/** 민지·하늘 × 의상(교복·수영복) × 표정(웃음), 하늘 + 수영복 제외 */
function wardrobe(): { p: Project; outfit: string; uniform: string; swim: string; minji: string; haneul: string } {
  let p = createProject('봄')
  const a = addCharacter(p, { name: '민지' })
  p = a.project
  const b = addCharacter(p, { name: '하늘' })
  p = b.project
  const o = addAxis(p, 'outfit')
  p = o.project
  const u = addValue(p, o.id, { label: '교복', prompt: 'school uniform' })
  p = u.project
  const sw = addValue(p, o.id, { label: '수영복', prompt: 'swimsuit' })
  p = sw.project
  const e = addAxis(p, 'expression')
  p = e.project
  p = addValue(p, e.id, { label: '웃음', prompt: 'smile' }).project
  p = { ...p, exclusions: [{ id: 'x', when: { character: [b.id], [o.id]: [sw.id] } }] }
  return { p, outfit: o.id, uniform: u.id, swim: sw.id, minji: a.id, haneul: b.id }
}

/** 한 조합에 그림 한 장을 넣고 채택 (+ 코드·내보낸 기록) */
function adoptOne(p: Project, key: string, id: number): Project {
  let item = addImage(emptyItem(key), { id, ts: id, seed: id, width: 832, height: 1216, mime: 'image/png' }, { fromQueue: false })
  item = setMarks(item, [id], 'adopted')
  item = setSlotCodes(item, { 1: 'A001' })
  item = markExported(item, id, `봄/${id}.png`, 1)
  return { ...p, items: { ...p.items, [key]: item }, exportCounters: { [`combination:${key}`]: 1 } }
}

describe('removing an axis keeps exclusion rules narrow', () => {
  it('drops a rule that named the removed axis instead of excluding the whole character', () => {
    const { p, outfit } = wardrobe()
    expect(expandMatrix(p).combos.map((c) => c.label)).toEqual(['민지 · 교복 · 웃음', '민지 · 수영복 · 웃음', '하늘 · 교복 · 웃음'])
    const next = removeAxis(p, outfit)
    expect(next.exclusions).toEqual([])
    expect(expandMatrix(next).combos.map((c) => c.label)).toEqual(['민지 · 웃음', '하늘 · 웃음'])
  })
})

describe('pasting axis values', () => {
  it('keeps NovelAI namespace tags in the prompt instead of reading them as names', () => {
    expect(parseValueLines('artist:wlop, smile\ntext:hello, sign\nsmile, artist:foo')).toEqual([
      { label: 'artist:wlop', prompt: 'artist:wlop, smile' },
      { label: 'text:hello', prompt: 'text:hello, sign' },
      { label: 'smile', prompt: 'smile, artist:foo' }
    ])
  })

  it('still reads "name: prompt", Korean names without a space, full-width colons and slugs', () => {
    expect(parseValueLines('웃음: smile, open mouth\n울음:crying\n화남：angry\n졸림 (sleepy): sleepy\nAngry: frown, 1.2::tears::')).toEqual([
      { label: '웃음', prompt: 'smile, open mouth' },
      { label: '울음', prompt: 'crying' },
      { label: '화남', prompt: 'angry' },
      { label: '졸림', slug: 'sleepy', prompt: 'sleepy' },
      { label: 'Angry', prompt: 'frown, 1.2::tears::' }
    ])
  })
})

describe('combination keys follow axis changes', () => {
  /** 민지 × 표정(웃음) 한 조합에 채택·내보낸 그림 */
  function started(): { p: Project; expr: string; key: string } {
    let p = createProject('봄')
    p = addCharacter(p, { name: '민지' }).project
    const e = addAxis(p, 'expression')
    p = e.project
    p = addValue(p, e.id, { label: '웃음', prompt: 'smile' }).project
    const key = expandMatrix(p).combos[0].key
    return { p: adoptOne(p, key, 7), expr: e.id, key }
  }

  it('moves existing work into the first value of a new axis and back when that value is removed', () => {
    const { p, key } = started()
    const o = addAxis(p, 'outfit')
    expect(o.project.items[key]).toBeDefined()
    const v = addValue(o.project, o.id, { label: '교복', prompt: 'school uniform' })
    const combos = expandMatrix(v.project).combos
    expect(combos).toHaveLength(1)
    const moved = v.project.items[combos[0].key]
    // 선별·코드·내보낸 기록이 그대로 새 키로
    expect(moved).toMatchObject({ key: combos[0].key, codes: { 1: 'A001' } })
    expect(moved.images[0]).toMatchObject({ id: 7, mark: 'adopted', exported: { path: '봄/7.png' } })
    expect(v.project.items[key]).toBeUndefined()
    expect(orphanItems(v.project)).toEqual([])
    expect(v.project.exportCounters).toEqual({ [`combination:${combos[0].key}`]: 1 })
    // 두 번째 값은 키를 바꾸지 않는다
    const two = addValue(v.project, o.id, { label: '수영복', prompt: 'swimsuit' })
    expect(Object.keys(two.project.items)).toEqual([combos[0].key])
    // 하나뿐인 값을 지우면 원래 키로 돌아온다
    const back = removeValue(v.project, o.id, v.id)
    expect(Object.keys(back.items)).toEqual([key])
    expect(orphanItems(back)).toEqual([])
    // 축째 지워도 (값이 하나뿐이면) 마찬가지
    expect(Object.keys(removeAxis(v.project, o.id).items)).toEqual([key])
  })

  it('moves work made without characters into the first character and back', () => {
    let p = createProject('봄')
    const e = addAxis(p, 'expression')
    p = addValue(e.project, e.id, { label: '웃음', prompt: 'smile' }).project
    const key = expandMatrix(p).combos[0].key
    p = adoptOne(p, key, 9)
    const c = addCharacter(p, { name: '민지' })
    const live = expandMatrix(c.project).combos[0].key
    expect(live).not.toBe(key)
    expect(Object.keys(c.project.items)).toEqual([live])
    expect(Object.keys(removeCharacter(c.project, c.id).items)).toEqual([key])
  })

  it('does not move items while a batch is queued for them, or merge into an existing item', () => {
    const { p, key } = started()
    const busy = { ...p, items: { ...p.items, [key]: { ...p.items[key], queued: 2 } } }
    const o = addAxis(busy, 'outfit')
    const v = addValue(o.project, o.id, { label: '교복' })
    expect(Object.keys(v.project.items)).toEqual([key])
    // 옮길 자리에 이미 항목이 있으면 합치지 않는다
    const ax = addAxis(p, 'outfit')
    const free = addValue(ax.project, ax.id, { label: '교복' })
    const movedKey = expandMatrix(free.project).combos[0].key
    expect(Object.keys(free.project.items)).toEqual([movedKey])
    const both = { ...free.project, items: { ...free.project.items, [key]: addImage(emptyItem(key), { id: 8, ts: 8 }, { fromQueue: false }) } }
    const back = removeValue(both, ax.id, free.id)
    expect(Object.keys(back.items).sort()).toEqual([key, movedKey].sort())
    expect(back.items[key].images.map((i) => i.id)).toEqual([8])
  })
})

describe('classification', () => {
  it('ignores axes with no enabled values like the matrix does', () => {
    let p = createProject('봄')
    p = addCharacter(p, { name: '민지' }).project
    const e = addAxis(p, 'expression')
    p = addValue(e.project, e.id, { label: '웃음', prompt: 'smile' }).project
    p = addAxis(p, 'location').project // 아직 값이 없는 축
    const r = classify(p, { prompt: 'smile', characterNames: ['민지'] }, { useFragments: true })
    expect(r.missing).toEqual([])
    expect(r.tag?.key).toBe(expandMatrix(p).combos[0].key)
  })
})

describe('manifest and presets', () => {
  it('guards header cells against formulas too', () => {
    const csv = toCsv([{ a: '=1+1' }], [{ key: 'a', label: '+추가' }], { guardFormulas: true })
    expect(csv).toBe("'+추가\r\n'=1+1\r\n")
  })

  it('rejects JPEG backgrounds the canvas cannot read and never passes them to the converter', () => {
    const base = { name: 'x', format: 'jpeg' as const }
    expect(validatePreset({ ...base, background: '#ffffff' })).toEqual([])
    expect(validatePreset({ ...base, background: '#FFF' })).toEqual([])
    expect(validatePreset({ ...base, background: 'ffffff' })).toHaveLength(1)
    expect(validatePreset({ ...base, background: 'whte' })).toHaveLength(1)
    expect(presetToConvertOptions({ ...base, background: 'ffffff' }).background).toBe('#ffffff')
    expect(presetToConvertOptions({ ...base, background: 'whte' }).background).toBeUndefined()
  })
})

describe('path naming', () => {
  it('never puts a raw separator with path characters into suffixes or fallback names', () => {
    const p = previewPaths(
      [
        { id: 1, vars: { character: 'A x' }, ext: 'png' },
        { id: 2, vars: { character: 'A x' }, ext: 'png' },
        { id: 3, vars: {}, ext: 'png' }
      ],
      naming({ fileTemplate: '{character}', folderMode: 'flat', rootFolder: '', separator: '/' })
    )
    for (const e of p.entries) expect(e.path).not.toContain('/')
    expect(p.entries.map((e) => e.path)).toEqual(['A_x.png', 'A_x_2.png', 'image_001.png'])
  })

  it('records numbers only for entries that were actually saved', () => {
    const items = [1, 2, 3].map((id) => ({ id, vars: { character: '민지' }, ext: 'png', characterKey: 'A', comboKey: 'k' }))
    const plan = previewPaths(items, naming({ fileTemplate: '{character}_{index:02}', folderMode: 'flat', rootFolder: '' }))
    expect(plan.entries.map((e) => e.scope)).toEqual(['combination:k', 'combination:k', 'combination:k'])
    expect(plan.counters).toEqual({ 'combination:k': 3 })
    // 첫 두 장만 저장하고 취소했다
    const saved = plan.entries.slice(0, 2).map((path) => ({ path }))
    expect(savedCounters(saved as never)).toEqual({ 'combination:k': 2 })
    const next = previewPaths(items.slice(2), naming({ fileTemplate: '{character}_{index:02}', folderMode: 'flat', rootFolder: '' }), {
      counters: savedCounters(saved as never)
    })
    expect(next.entries[0].fileName).toBe('민지_03.png')
    // {index}를 쓰지 않는 템플릿은 번호를 남기지 않는다
    expect(previewPaths(items, naming({ fileTemplate: '{character}', folderMode: 'flat' })).entries[0].scope).toBeUndefined()
  })
})

describe('image codes', () => {
  it('gives implicit letters that skip letters other characters already use', () => {
    const p = { characters: [{ id: 'x', name: 'X', code: 'B' }, { id: 'y', name: 'Y' }, { id: 'z', name: 'Z' }] } as Project
    expect([...characterCodes(p).values()]).toEqual(['B', 'C', 'D'])
    expect(characterCode(p, p.characters[0])).toBe('B')
    expect(characterCode(p, p.characters[1])).toBe('C')
  })

  it('lets a new adopter of a freed slot rewrite that slot\'s file instead of leaving the rejected image there', () => {
    const { p: base } = wardrobe()
    const key = expandMatrix(base).combos[0].key
    let item = emptyItem(key)
    for (const id of [1, 2]) item = addImage(item, { id, ts: id, seed: id, width: 832, height: 1216, mime: 'image/png' }, { fromQueue: false })
    item = setMarks(item, [1], 'adopted')
    let p: Project = { ...base, naming: { ...base.naming, fileTemplate: '{code}', folderMode: 'flat', rootFolder: '' }, items: { [key]: item } }
    const first = planExport(p)
    expect(first.entries[0].path.path).toBe('A001.png')
    item = setSlotCodes(item, { 1: first.newCodes[0].code })
    item = markExported(item, 1, 'A001.png', 1)
    expect(item.slotPaths).toEqual({ 1: 'A001.png' })
    // 탈락시키고 다른 그림을 (교체가 아니라) 보통 채택
    item = setMarks(setMarks(item, [1], 'rejected'), [2], 'adopted')
    p = { ...p, items: { [key]: item } }
    expect(previousExportPath(p, key, item.images[1])).toBe('A001.png')
    const again = planExport(p, { existing: ['A001.png'] })
    expect(again.entries.map((e) => [e.candidate.image.id, e.code, e.path.path, e.path.status])).toEqual([[2, 'A001', 'A001.png', 'update']])
  })
})
