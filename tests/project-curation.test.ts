import { describe, expect, it } from 'vitest'
import {
  addAxis,
  addCharacter,
  addValue,
  classify,
  createProject,
  expandMatrix,
  normalizeProject,
  removeAxis,
  removeCharacter,
  removeValue,
  resetRuntime,
  useProjects,
  type AssetItem
} from '../src/project'
import {
  addImage,
  adoptedImages,
  bumpRuntime,
  curationCounts,
  emptyItem,
  groupByCombination,
  itemStatus,
  markExported,
  progressOf,
  removeImages,
  replaceAdopted,
  representativeOf,
  setMarks,
  setRepresentative,
  setSlotCodes,
  versionChain
} from '../src/project/curation'

function withImages(n: number): AssetItem {
  let item = emptyItem('k')
  for (let i = 1; i <= n; i++) item = addImage(item, { id: i, ts: i * 10 }, { fromQueue: false })
  return item
}

describe('curation', () => {
  it('walks through the item statuses', () => {
    expect(itemStatus(undefined, 1)).toBe('pending')
    let item = bumpRuntime(emptyItem('k'), { queued: 2 })
    expect(itemStatus(item, 1)).toBe('queued')
    item = bumpRuntime(item, { queued: -1, generating: 1 })
    expect(itemStatus(item, 1)).toBe('generating')
    item = addImage(item, { id: 1, ts: 1 })
    expect([item.generating, item.queued]).toEqual([0, 1])
    item = addImage(item, { id: 2, ts: 2 })
    expect(itemStatus(item, 1)).toBe('review')
    item = setMarks(item, [1], 'hold')
    item = setMarks(item, [2], 'rejected')
    expect(itemStatus(item, 1)).toBe('review')
    item = setMarks(item, [1], 'rejected')
    expect(itemStatus(item, 1)).toBe('redo')
    item = setMarks(item, [1], 'adopted')
    expect(itemStatus(item, 1)).toBe('adopted')
    expect(itemStatus(item, 2)).toBe('redo')
    item = markExported(item, 1, 'P/민지/a.png', 100, 2048)
    expect(itemStatus(item, 1)).toBe('exported')
    expect(itemStatus({ ...item, redo: true }, 1)).toBe('redo')
    expect(itemStatus(bumpRuntime(emptyItem('k'), { failed: 1 }), 1)).toBe('redo')
  })

  it('offsets failures with later successes and never goes negative', () => {
    let item = bumpRuntime(emptyItem('k'), { failed: 2, queued: -5 })
    expect([item.failed, item.queued]).toEqual([2, 0])
    item = addImage(item, { id: 1, ts: 1 })
    expect(item.failed).toBe(1)
    expect(addImage(item, { id: 1, ts: 1 })).toBe(item)
  })

  it('counts marks and progress', () => {
    let item = withImages(5)
    item = setMarks(item, [1, 2], 'adopted')
    item = setMarks(item, [3], 'hold')
    item = setMarks(item, [4], 'rejected')
    expect(curationCounts(item)).toEqual({ total: 5, unreviewed: 1, adopted: 2, hold: 1, rejected: 1 })
    expect(progressOf(2, 4)).toBe(0.5)
    expect(progressOf(5, 4)).toBe(1)
    expect(progressOf(0, 0)).toBe(1)
  })

  it('gives adopted images the lowest free slot and frees it on un-adopt', () => {
    let item = withImages(4)
    item = setMarks(item, [2, 1], 'adopted')
    expect(adoptedImages(item).map((i) => [i.id, i.slot])).toEqual([
      [2, 1],
      [1, 2]
    ])
    item = setMarks(item, [2], 'hold')
    expect(item.images.find((i) => i.id === 2)!.slot).toBeUndefined()
    item = setMarks(item, [3], 'adopted')
    expect(item.images.find((i) => i.id === 3)!.slot).toBe(1)
    // 이미 같은 표시면 그대로
    expect(setMarks(item, [3], 'adopted')).toBe(item)
  })

  it('replaces an adopted image keeping its slot, code and representative', () => {
    let item = withImages(3)
    item = setMarks(item, [1], 'adopted')
    item = setSlotCodes(item, { 1: 'A001' })
    item = setRepresentative(item, 1)
    item = replaceAdopted(item, 1, 3)
    const old = item.images.find((i) => i.id === 1)!
    const fresh = item.images.find((i) => i.id === 3)!
    expect(old).toMatchObject({ mark: 'rejected', supersededBy: 3 })
    expect(old.slot).toBeUndefined()
    expect(fresh).toMatchObject({ mark: 'adopted', slot: 1, version: 2, replaces: 1 })
    expect(item.representative).toBe(3)
    expect(item.codes).toEqual({ 1: 'A001' })
    // 같은 칸 코드는 다시 정해도 바뀌지 않는다
    expect(setSlotCodes(item, { 1: 'B009' })).toBe(item)
    item = replaceAdopted(item, 3, 2)
    expect(item.images.find((i) => i.id === 2)).toMatchObject({ slot: 1, version: 3 })
    expect(versionChain(item, 1).map((i) => i.id)).toEqual([1, 3, 2])
    expect(versionChain(item, 2).map((i) => i.id)).toEqual([1, 3, 2])
    // 채택이 아닌 그림은 교체할 수 없다
    expect(replaceAdopted(item, 1, 3)).toBe(item)
  })

  it('picks a representative: chosen, first adopted, newest hold, newest unreviewed', () => {
    let item = withImages(4)
    expect(representativeOf(item)!.id).toBe(4)
    item = setMarks(item, [2], 'hold')
    expect(representativeOf(item)!.id).toBe(2)
    item = setMarks(item, [3, 1], 'adopted')
    expect(representativeOf(item)!.id).toBe(3)
    item = setRepresentative(item, 4)
    expect(representativeOf(item)!.id).toBe(4)
    item = setMarks(item, [4], 'rejected')
    expect(item.representative).toBeUndefined()
    expect(representativeOf(emptyItem('k'))).toBeNull()
    expect(setRepresentative(item, 99)).toBe(item)
  })

  it('removes images deleted from the history', () => {
    let item = setRepresentative(withImages(3), 2)
    item = removeImages(item, [2, 9])
    expect(item.images.map((i) => i.id)).toEqual([1, 3])
    expect(item.representative).toBeUndefined()
  })

  it('groups tagged images by combination', () => {
    const list = [
      { id: 1, tag: { key: 'a' } },
      { id: 2, tag: { key: 'b' } },
      { id: 3 },
      { id: 4, tag: { key: 'a' } }
    ]
    const g = groupByCombination(list, (x) => (x as { tag?: { key: string } }).tag?.key)
    expect([...g.keys()]).toEqual(['a', 'b'])
    expect(g.get('a')!.map((x) => x.id)).toEqual([1, 4])
  })
})

describe('project model', () => {
  it('cleans rules that point at removed values, axes and characters', () => {
    let p = createProject('정리')
    const a = addCharacter(p, { name: '민지' })
    p = a.project
    const b = addCharacter(p, { name: '하늘' })
    p = b.project
    const ax = addAxis(p, 'outfit')
    p = ax.project
    expect(p.axes[0]).toMatchObject({ name: '의상', target: 'character', kind: 'outfit' })
    const v1 = addValue(p, ax.id, { label: '교복', prompt: 'uniform', perCharacter: { [a.id]: 'x' } })
    p = v1.project
    const v2 = addValue(p, ax.id, { label: '수영복', prompt: 'swimsuit' })
    p = v2.project
    p.exclusions = [
      { id: 'r1', when: { character: [b.id], [ax.id]: [v2.id] } },
      { id: 'r2', when: { [ax.id]: [v1.id, v2.id] } }
    ]
    p.overrides = [
      { id: 'o1', match: { [ax.id]: v2.id }, width: 1216 },
      { id: 'o2', match: { character: a.id }, count: 2 }
    ]
    p.rules = [{ id: 'c1', axisId: ax.id, valueId: v2.id, match: 'swimsuit', field: 'prompt' }]

    const noSwim = removeValue(p, ax.id, v2.id)
    expect(noSwim.axes[0].values.map((v) => v.label)).toEqual(['교복'])
    expect(noSwim.exclusions).toEqual([{ id: 'r2', when: { [ax.id]: [v1.id] } }])
    expect(noSwim.overrides.map((o) => o.id)).toEqual(['o2'])
    expect(noSwim.rules).toEqual([])

    const noAxis = removeAxis(p, ax.id)
    expect(noAxis.axes).toEqual([])
    expect(noAxis.exclusions).toEqual([{ id: 'r1', when: { character: [b.id] } }])
    expect(noAxis.overrides.map((o) => o.id)).toEqual(['o2'])

    const noA = removeCharacter(p, a.id)
    expect(noA.characters.map((c) => c.name)).toEqual(['하늘'])
    expect(noA.overrides.map((o) => o.id)).toEqual(['o1'])
    expect(noA.axes[0].values[0].perCharacter).toEqual({})
  })

  it('fills missing fields of older saves and resets in-flight counts', () => {
    const p = normalizeProject({ id: 'x', name: '옛 저장', items: { k: { ...emptyItem('k'), queued: 3, generating: 1 } } })
    expect(p.naming.fileTemplate).toBeTruthy()
    expect(p.defaults).toEqual({ count: 4, target: 1 })
    const r = resetRuntime(p)
    expect(r.items.k).toMatchObject({ queued: 0, generating: 0 })
    expect(resetRuntime(r)).toBe(r)
  })
})

describe('project store', () => {
  it('tracks a generation run and curation through the store', () => {
    const s = useProjects.getState()
    const id = s.create('스토어')
    const charId = s.addCharacter(id, { name: '민지', libraryId: 7 })!
    const axisId = s.addAxis(id, 'expression')!
    s.addValue(id, axisId, { label: '웃음', prompt: 'smile' })
    let project = useProjects.getState().projects.find((p) => p.id === id)!
    expect(useProjects.getState().activeId).toBe(id)
    const key = expandMatrix(project).combos[0].key
    expect(key).toContain(charId)

    s.markQueued(id, [{ key, count: 2 }])
    s.markStarted(id, key)
    s.addImage(id, key, { id: 501, ts: 1, seed: 42, width: 832, height: 1216, mime: 'image/png' })
    s.markStarted(id, key)
    s.markFailed(id, key)
    project = useProjects.getState().projects.find((p) => p.id === id)!
    expect(project.items[key]).toMatchObject({ queued: 0, generating: 0, failed: 1 })
    s.setMarks(id, key, [501], 'adopted')
    s.setCodes(id, [{ key, slot: 1, code: 'A001' }])
    s.markExported(id, [{ key, imageId: 501, path: '스토어/민지/a.png', bytes: 10 }], { 'combination:x': 1 })
    project = useProjects.getState().projects.find((p) => p.id === id)!
    expect(project.items[key].images[0]).toMatchObject({ mark: 'adopted', slot: 1, exported: { path: '스토어/민지/a.png' } })
    expect(project.items[key].codes).toEqual({ 1: 'A001' })
    expect(project.exportCounters).toEqual({ 'combination:x': 1 })

    s.forgetImages([501])
    project = useProjects.getState().projects.find((p) => p.id === id)!
    expect(project.items[key].images).toEqual([])

    const copy = s.duplicate(id)!
    const dup = useProjects.getState().projects.find((p) => p.id === copy)!
    expect(dup.name).toBe('스토어 복사')
    expect(dup.items).toEqual({})
    s.remove(id)
    expect(useProjects.getState().projects.some((p) => p.id === id)).toBe(false)
    expect(useProjects.getState().activeId).toBeNull()
  })

  it('resets in-flight counts when restoring a saved state', () => {
    const merge = useProjects.persist.getOptions().merge!
    const saved = { projects: [{ id: 'p', name: '저장됨', items: { k: { ...emptyItem('k'), queued: 4 } } }], activeId: 'p', presets: [] }
    const state = merge(saved, useProjects.getState()) as ReturnType<typeof useProjects.getState>
    expect(state.projects[0].items.k.queued).toBe(0)
    expect(state.projects[0].naming).toBeTruthy()
    expect(state.activeId).toBe('p')
  })

  it('stores only user-defined presets', () => {
    const s = useProjects.getState()
    expect(s.presets).toEqual([])
    const pid = s.savePreset({ name: '내 플랫폼', format: 'webp', maxWidth: 1024, maxBytes: 500 * 1024, quality: 0.9 })
    const projectId = s.create('프리셋')
    s.patch(projectId, { convertPresetId: pid })
    s.removePreset(pid)
    expect(useProjects.getState().presets).toEqual([])
    expect(useProjects.getState().projects.find((p) => p.id === projectId)!.convertPresetId).toBeNull()
  })
})

describe('classification', () => {
  it('assigns outside images by rules, character names and fragments', () => {
    let p = createProject('분류')
    p.id = 'P'
    p.characters = [
      { id: 'A', libraryId: 1, name: '민지', vibeIds: [], refIds: [] },
      { id: 'B', libraryId: 2, name: '하늘', vibeIds: [], refIds: [] }
    ]
    p.axes = [
      {
        id: 'e',
        kind: 'expression',
        name: '표정',
        target: 'character',
        values: [
          { id: 'smile', label: '웃음', prompt: 'smile' },
          { id: 'cry', label: '울음', prompt: 'crying, tears' }
        ]
      }
    ]
    p.rules = [{ id: 'r', axisId: 'e', valueId: 'smile', match: 'grin', field: 'prompt' }]
    const byRule = classify(p, { prompt: '1girl, big_grin', characterNames: ['민지'] })
    expect(byRule.tag).toEqual({ projectId: 'P', key: 'character:A|e:smile', coords: { character: 'A', e: 'smile' } })
    const byFragment = classify(p, { prompt: '1girl, tears, crying', characterNames: ['하늘'] }, { useFragments: true })
    expect(byFragment.tag?.coords).toEqual({ character: 'B', e: 'cry' })
    expect(classify(p, { prompt: '1girl, tears, crying', characterNames: ['하늘'] }).missing).toEqual(['e'])
    const both = classify(p, { prompt: 'smile, crying, tears', characterNames: ['민지'] }, { useFragments: true })
    expect(both.ambiguous).toEqual(['e'])
    expect(both.tag).toBeNull()
    p = { ...p, exclusions: [{ id: 'x', when: { character: ['A'] } }] }
    expect(classify(p, { prompt: 'grin', characterNames: ['민지'] }).tag).toBeNull()
  })
})
