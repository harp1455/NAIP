/**
 * Phase 5 프로젝트 검토 수정에 대한 재검토 지적 회귀 테스트 — 고치기 전에는 실패한다
 */
import { describe, expect, it } from 'vitest'
import {
  addAxis,
  addCharacter,
  addValue,
  adoptedImages,
  createProject,
  expandMatrix,
  normalizeBackground,
  orphanedByEdit,
  orphanItems,
  planExport,
  presetToConvertOptions,
  previousExportPath,
  removeCharacter,
  removeValue,
  validatePreset,
  type Project
} from '../src/project'
import { addImage, emptyItem, markExported, setMarks, setSlotCodes } from '../src/project/curation'

/** 조합마다 그림 한 장을 넣고 채택 (+ 코드·내보낸 기록) */
function adoptAll(p: Project, firstId = 1): Project {
  const items = { ...p.items }
  expandMatrix(p).combos.forEach((c, n) => {
    const id = firstId + n
    let item = addImage(emptyItem(c.key), { id, ts: id, seed: id, width: 832, height: 1216, mime: 'image/png' }, { fromQueue: false })
    item = setMarks(item, [id], 'adopted')
    item = setSlotCodes(item, { 1: `A00${id}` })
    items[c.key] = markExported(item, id, `봄/${id}.png`, 1)
  })
  return { ...p, items }
}

const adoptedCount = (p: Project, key: string): number => adoptedImages(p.items[key]).length

describe('removing the only value or character does not hand its images to the next one added', () => {
  it('keeps a removed outfit\'s adopted image out of the next outfit\'s combination', () => {
    let p = createProject('봄')
    p = addCharacter(p, { name: '민지' }).project
    const o = addAxis(p, 'outfit')
    const uniform = addValue(o.project, o.id, { label: '교복', prompt: 'school uniform' })
    p = adoptAll(uniform.project)
    const before = Object.keys(p.items)
    p = removeValue(p, o.id, uniform.id)
    // 교복 그림은 빠진 조합으로 (지운 값의 키 그대로)
    expect(Object.keys(p.items)).toEqual(before)
    const swim = addValue(p, o.id, { label: '수영복', prompt: 'swimsuit' })
    const combos = expandMatrix(swim.project).combos
    expect(combos.map((c) => c.label)).toEqual(['민지 · 수영복'])
    expect(adoptedCount(swim.project, combos[0].key)).toBe(0)
    expect(orphanItems(swim.project).map((i) => i.key)).toEqual(before)
  })

  it('keeps a removed character\'s adopted images away from the next character', () => {
    let p = createProject('봄')
    const minji = addCharacter(p, { name: '민지' })
    p = minji.project
    const o = addAxis(p, 'outfit')
    p = addValue(o.project, o.id, { label: '교복', prompt: 'school uniform' }).project
    p = addValue(p, o.id, { label: '수영복', prompt: 'swimsuit' }).project
    p = adoptAll(p)
    const before = Object.keys(p.items).sort()
    p = removeCharacter(p, minji.id)
    const haneul = addCharacter(p, { name: '하늘' })
    const combos = expandMatrix(haneul.project).combos
    expect(combos.map((c) => c.label)).toEqual(['하늘 · 교복', '하늘 · 수영복'])
    expect(combos.map((c) => adoptedCount(haneul.project, c.key))).toEqual([0, 0])
    expect(orphanItems(haneul.project).map((i) => i.key).sort()).toEqual(before)
  })
})

describe('confirming key changes the carry cannot follow', () => {
  function started(): { p: Project; key: string } {
    let p = createProject('봄')
    p = addCharacter(p, { name: '민지' }).project
    p = adoptAll(p)
    return { p, key: Object.keys(p.items)[0] }
  }

  it('counts the images an add would orphan while a batch is queued, and none when the carry moves them', () => {
    const { p, key } = started()
    const o = addAxis(p, 'outfit')
    const idle = addValue(o.project, o.id, { label: '교복' }).project
    expect(orphanedByEdit(o.project, idle)).toBe(0)
    expect(orphanItems(idle)).toEqual([])

    const busy = { ...o.project, items: { ...o.project.items, [key]: { ...o.project.items[key], queued: 2 } } }
    const added = addValue(busy, o.id, { label: '교복' }).project
    expect(Object.keys(added.items)).toEqual([key])
    expect(orphanedByEdit(busy, added)).toBe(1)

    // 첫 캐릭터도 마찬가지
    const solo = { ...createProject('봄'), items: {} as Project['items'] }
    const e = addAxis(solo, 'expression')
    let q = addValue(e.project, e.id, { label: '웃음' }).project
    q = adoptAll(q)
    const qKey = Object.keys(q.items)[0]
    const qBusy = { ...q, items: { ...q.items, [qKey]: { ...q.items[qKey], generating: 1 } } }
    expect(orphanedByEdit(qBusy, addCharacter(qBusy, { name: '민지' }).project)).toBe(1)
    expect(orphanedByEdit(q, addCharacter(q, { name: '민지' }).project)).toBe(0)
  })

  it('counts only images that were in the matrix, for toggles too', () => {
    const { p } = started()
    // 이미 빠져 있던 항목은 세지 않는다
    const stray = { ...p, items: { ...p.items, 'character:gone': addImage(emptyItem('character:gone'), { id: 99, ts: 99 }, { fromQueue: false }) } }
    const off = { ...stray, characters: stray.characters.map((c) => ({ ...c, enabled: false })) }
    expect(orphanedByEdit(stray, off)).toBe(1)
    expect(orphanedByEdit(stray, stray)).toBe(0)
  })
})

describe('export records follow the file', () => {
  /** 이미지 1을 A001.png로 내보낸 뒤 탈락, 이미지 2를 채택해 같은 칸의 파일을 덮어씀 */
  function overwritten(): { p: Project; key: string } {
    let p = createProject('봄')
    p = addCharacter(p, { name: '민지' }).project
    p = { ...p, naming: { ...p.naming, fileTemplate: '{code}', folderMode: 'flat', rootFolder: '' } }
    const key = expandMatrix(p).combos[0].key
    let item = emptyItem(key)
    for (const id of [1, 2]) item = addImage(item, { id, ts: id, seed: id, width: 832, height: 1216, mime: 'image/png' }, { fromQueue: false })
    item = setSlotCodes(setMarks(item, [1], 'adopted'), { 1: 'A001' })
    item = markExported(item, 1, 'A001.png', 1)
    item = setMarks(setMarks(item, [1], 'rejected'), [2], 'adopted')
    p = { ...p, items: { [key]: item } }
    const plan = planExport(p, { existing: ['A001.png'], onlyNotExported: true })
    expect(plan.entries.map((e) => [e.candidate.image.id, e.path.path, e.path.status])).toEqual([[2, 'A001.png', 'update']])
    item = markExported(item, 2, plan.entries[0].path.path, 2)
    return { p: { ...p, items: { [key]: item } }, key }
  }

  it('drops the old image\'s record when another image takes over its file', () => {
    const { p, key } = overwritten()
    const item = p.items[key]
    expect(item.images.find((i) => i.id === 2)?.exported?.path).toBe('A001.png')
    expect(item.images.find((i) => i.id === 1)?.exported).toBeUndefined()
    // 다시 채택한 이미지 1은 "새 것만"에 들어가고 자기 파일을 받는다
    const again = { ...p, items: { [key]: setSlotCodes(setMarks(item, [1], 'adopted'), { 2: 'A002' }) } }
    const plan = planExport(again, { existing: ['A001.png'], onlyNotExported: true })
    expect(plan.entries.map((e) => [e.candidate.image.id, e.code, e.path.path, e.path.status])).toEqual([[1, 'A002', 'A002.png', 'ok']])
  })

  it('matches the record path without regard to case', () => {
    let item = emptyItem('k')
    for (const id of [1, 2]) item = addImage(item, { id, ts: id }, { fromQueue: false })
    item = markExported(item, 1, '봄/Minji.png', 1)
    item = markExported(item, 2, '봄/minji.PNG', 2)
    expect(item.images.map((i) => i.exported?.path)).toEqual([undefined, '봄/minji.PNG'])
  })

  it('does not let a new adopter of a slot overwrite a file a re-adopted image still owns', () => {
    let p = createProject('봄')
    p = addCharacter(p, { name: '민지' }).project
    const key = expandMatrix(p).combos[0].key
    let item = emptyItem(key)
    for (const id of [1, 2]) item = addImage(item, { id, ts: id, seed: id }, { fromQueue: false })
    item = markExported(setMarks(item, [1], 'adopted'), 1, 'A001.png', 1)
    // 이미지 1을 보류했다가, 이미지 2가 1번 칸을 받은 뒤 다시 채택 (2번 칸)
    item = setMarks(setMarks(setMarks(item, [1], 'hold'), [2], 'adopted'), [1], 'adopted')
    expect(item.images.map((i) => [i.id, i.slot])).toEqual([
      [1, 2],
      [2, 1]
    ])
    p = { ...p, items: { [key]: item } }
    expect(previousExportPath(p, key, item.images[0])).toBe('A001.png')
    expect(previousExportPath(p, key, item.images[1])).toBeUndefined()
  })
})

describe('JPEG preset backgrounds', () => {
  it('keeps CSS colour names and rgb() saved by earlier versions', () => {
    const base = { name: 'x', format: 'jpeg' as const }
    expect(presetToConvertOptions({ ...base, background: 'black' }).background).toBe('#000000')
    expect(presetToConvertOptions({ ...base, background: ' Red ' }).background).toBe('#ff0000')
    expect(presetToConvertOptions({ ...base, background: 'rgb(255, 255, 255)' }).background).toBe('#ffffff')
    expect(normalizeBackground('rebeccapurple')).toBe('#663399')
    expect(normalizeBackground('#ABC')).toBe('#abc')
    expect(validatePreset({ ...base, background: 'black' })).toEqual([])
    expect(validatePreset({ ...base, background: 'rgb(0 0 0)' })).toEqual([])
  })

  it('still refuses what the canvas would silently paint black', () => {
    const base = { name: 'x', format: 'jpeg' as const }
    for (const bad of ['whte', 'transparent', 'rgb(300, 0, 0)', 'constructor', '#12345']) {
      expect(normalizeBackground(bad)).toBeUndefined()
      expect(validatePreset({ ...base, background: bad })).toHaveLength(1)
    }
  })
})
