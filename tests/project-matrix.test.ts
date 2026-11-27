import { describe, expect, it } from 'vitest'
import {
  buildJob,
  comboKey,
  createProject,
  estimateJobs,
  expandMatrix,
  formatDuration,
  joinPrompt,
  matrixTotals,
  missingFor,
  orphanItems,
  parseComboKey,
  planJobs,
  planWarnings,
  secondsPerImageFrom,
  type Axis,
  type Project
} from '../src/project'
import { addImage, emptyItem, setMarks } from '../src/project/curation'

/** 캐릭터 2 × 의상 3 × 표정 2, B의 수영복 제외 */
function sample(): Project {
  const p = createProject('봄 이벤트', { model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28 }, 1000)
  p.id = 'P'
  p.stylePrompt = 'artist:foo, masterpiece'
  p.negative = 'lowres'
  p.vibeIds = [1]
  p.refIds = [10]
  p.characters = [
    { id: 'A', libraryId: 101, name: '민지', prompt: 'solo', vibeIds: [2], refIds: [11] },
    { id: 'B', libraryId: 102, name: '하늘', vibeIds: [], refIds: [10] }
  ]
  const outfit: Axis = {
    id: 'o',
    kind: 'outfit',
    name: '의상',
    key: 'outfit',
    target: 'character',
    values: [
      { id: 'u', label: '교복', prompt: 'school uniform', perCharacter: { A: 'school uniform, red ribbon' } },
      { id: 'c', label: '사복', prompt: 'casual clothes', negative: 'armor' },
      { id: 's', label: '수영복', prompt: 'swimsuit' }
    ]
  }
  const emotion: Axis = {
    id: 'e',
    kind: 'expression',
    name: '표정',
    target: 'character',
    values: [
      { id: 'smile', label: '웃음', prompt: 'smile' },
      { id: 'cry', label: '울음', prompt: 'crying, tears' }
    ]
  }
  const place: Axis = {
    id: 'l',
    kind: 'location',
    name: '장소',
    target: 'base',
    values: [{ id: 'cls', label: '교실', prompt: 'classroom' }]
  }
  p.axes = [outfit, emotion, place]
  p.exclusions = [{ id: 'x1', when: { character: ['B'], o: ['s'] } }]
  return p
}

describe('combination keys', () => {
  it('is stable regardless of axis order and round-trips', () => {
    expect(comboKey({ o: 'u', character: 'A' })).toBe(comboKey({ character: 'A', o: 'u' }))
    expect(parseComboKey(comboKey({ 'a|b': 'x:y', c: 'z' }))).toEqual({ 'a|b': 'x:y', c: 'z' })
    expect(parseComboKey('')).toEqual({})
  })

  it('keeps keys when axes are reordered or relabeled', () => {
    const p = sample()
    const before = expandMatrix(p).combos.map((c) => c.key).sort()
    p.axes = [p.axes[1], p.axes[0], p.axes[2]]
    p.axes[0].values[0].label = '미소'
    const after = expandMatrix(p).combos.map((c) => c.key).sort()
    expect(after).toEqual(before)
  })

  it('joins prompt pieces without doubled commas', () => {
    expect(joinPrompt('a, ', ', b', '', undefined, 'c')).toBe('a, b, c')
    expect(joinPrompt('', ' ')).toBe('')
  })
})

describe('matrix expansion', () => {
  it('multiplies axes and applies exclusions', () => {
    const m = expandMatrix(sample())
    expect(m.total).toBe(2 * 3 * 2 * 1)
    expect(m.excluded).toBe(2)
    expect(m.combos).toHaveLength(10)
    expect(m.combos[0].label).toBe('민지 · 교복 · 웃음 · 교실')
    // 첫 축이 가장 바깥 순서
    expect(m.combos.map((c) => c.coords.character).join('')).toBe('AAAAAABBBB')
    expect(m.combos.some((c) => c.coords.character === 'B' && c.coords.o === 's')).toBe(false)
  })

  it('skips disabled values and selects subsets by value or key', () => {
    const p = sample()
    p.axes[1].values[1].enabled = false
    expect(expandMatrix(p).combos).toHaveLength(5)
    const sub = expandMatrix(sample(), { values: { character: ['A'], o: ['u', 's'] } })
    expect(sub.total).toBe(4)
    expect(sub.combos.map((c) => c.label)).toEqual([
      '민지 · 교복 · 웃음 · 교실',
      '민지 · 교복 · 울음 · 교실',
      '민지 · 수영복 · 웃음 · 교실',
      '민지 · 수영복 · 울음 · 교실'
    ])
    const key = sub.combos[2].key
    expect(expandMatrix(sample(), { keys: [key] }).combos.map((c) => c.key)).toEqual([key])
  })

  it('warns about axes left without values and refuses an empty matrix', () => {
    const p = sample()
    const m = expandMatrix(p, { values: { l: [] } })
    expect(m.warnings.map((w) => w.code)).toEqual(['emptyAxis'])
    expect(m.combos).toHaveLength(10)
    const empty = createProject('빈 프로젝트')
    const e = expandMatrix(empty)
    expect(e.combos).toEqual([])
    expect(e.warnings[0]).toMatchObject({ code: 'noAxes', level: 'error' })
  })

  it('does not expand past the hard limit', () => {
    const p = createProject('폭발')
    p.axes = ['a', 'b', 'c'].map((id) => ({
      id,
      kind: 'custom' as const,
      name: id,
      target: 'base' as const,
      values: Array.from({ length: 30 }, (_, i) => ({ id: `${id}${i}`, label: `${i}`, prompt: '' }))
    }))
    const m = expandMatrix(p)
    expect(m.total).toBe(27000)
    expect(m.tooMany).toBe(true)
    expect(m.combos).toEqual([])
    expect(m.warnings[0]).toMatchObject({ code: 'hardLimit', level: 'error' })
    p.limits.hardLimit = 30000
    expect(expandMatrix(p).combos).toHaveLength(27000)
  })

  it('applies overrides: prompts accumulate, the most specific number wins', () => {
    const p = sample()
    p.defaults = { count: 4, target: 1 }
    p.overrides = [
      { id: 'exact', match: { character: 'A', o: 's', e: 'cry', l: 'cls' }, prompt: 'rain', target: 3, count: 6 },
      { id: 'swim', match: { o: 's' }, prompt: 'beach', width: 1216, height: 832, count: 2, characterPrompt: 'wet hair' }
    ]
    const m = expandMatrix(p)
    const swimSmile = m.combos.find((c) => c.coords.character === 'A' && c.coords.o === 's' && c.coords.e === 'smile')!
    const swimCry = m.combos.find((c) => c.coords.character === 'A' && c.coords.o === 's' && c.coords.e === 'cry')!
    const uniform = m.combos.find((c) => c.coords.o === 'u')!
    expect([swimSmile.width, swimSmile.height, swimSmile.count, swimSmile.target]).toEqual([1216, 832, 2, 1])
    expect([swimCry.width, swimCry.count, swimCry.target]).toEqual([1216, 6, 3])
    expect([uniform.width, uniform.height, uniform.count]).toEqual([832, 1216, 4])
    const job = buildJob(p, swimCry)
    expect(job.prompt).toBe('artist:foo, masterpiece, classroom, beach, rain')
    expect(job.characterPrompt).toBe('solo, swimsuit, crying, tears, wet hair')
    expect(job.params).toMatchObject({ width: 1216, height: 832 })
  })
})

describe('generation jobs', () => {
  it('builds prompts, per-character fragments and merged references', () => {
    const p = sample()
    const m = expandMatrix(p)
    const a = buildJob(p, m.combos[0])
    expect(a.prompt).toBe('artist:foo, masterpiece, classroom')
    expect(a.characterPrompt).toBe('solo, school uniform, red ribbon, smile')
    expect(a.character).toEqual({ id: 'A', libraryId: 101, name: '민지' })
    expect(a.vibeIds).toEqual([1, 2])
    expect(a.refIds).toEqual([10, 11])
    expect(a.tag).toEqual({ projectId: 'P', key: m.combos[0].key, coords: m.combos[0].coords })
    expect(a.labels).toEqual({ character: '민지', o: '교복', e: '웃음', l: '교실' })
    const b = buildJob(p, m.combos.find((c) => c.coords.character === 'B' && c.coords.o === 'c')!)
    expect(b.characterPrompt).toBe('casual clothes, smile')
    expect(b.characterNegative).toBe('armor')
    expect(b.negative).toBe('lowres')
    expect(b.refIds).toEqual([10])
  })

  it('puts character fragments in the main prompt when there are no characters, and style at the end if asked', () => {
    const p = sample()
    p.characters = []
    p.exclusions = []
    p.stylePosition = 'end'
    const job = buildJob(p, expandMatrix(p).combos[0])
    expect(job.character).toBeNull()
    expect(job.prompt).toBe('school uniform, smile, classroom, artist:foo, masterpiece')
    expect(job.characterPrompt).toBe('')
  })
})

describe('plans', () => {
  it('plans everything, only the missing, or only the failed', () => {
    const p = sample()
    p.defaults = { count: 4, target: 2 }
    const [c0, c1, c2, c3] = expandMatrix(p).combos
    // c0: 채택 1장 → 1장 부족
    let i0 = addImage(emptyItem(c0.key), { id: 1, ts: 1 }, { fromQueue: false })
    i0 = addImage(i0, { id: 2, ts: 2 }, { fromQueue: false })
    i0 = setMarks(i0, [1], 'adopted')
    // c1: 다 탈락 → 재생성 필요, 실패 3
    let i1 = addImage(emptyItem(c1.key), { id: 3, ts: 3 }, { fromQueue: false })
    i1 = { ...setMarks(i1, [3], 'rejected'), failed: 3 }
    // c2: 대기 중 2장 → 부족 0
    const i2 = { ...emptyItem(c2.key), queued: 2 }
    // c3: 목표 달성
    let i3 = addImage(emptyItem(c3.key), { id: 4, ts: 4 }, { fromQueue: false })
    i3 = addImage(i3, { id: 5, ts: 5 }, { fromQueue: false })
    i3 = setMarks(i3, [4, 5], 'adopted')
    p.items = { [c0.key]: i0, [c1.key]: i1, [c2.key]: i2, [c3.key]: i3 }

    const all = planJobs(p, 'all')
    expect(all.jobs).toHaveLength(10)
    expect(all.jobs.reduce((n, j) => n + j.count, 0)).toBe(40)

    const missing = planJobs(p, 'missing')
    const byKey = new Map(missing.jobs.map((j) => [j.key, j.count]))
    expect(byKey.get(c0.key)).toBe(1)
    expect(byKey.get(c1.key)).toBe(2)
    expect(byKey.has(c2.key)).toBe(false)
    expect(byKey.has(c3.key)).toBe(false)
    expect(missing.jobs).toHaveLength(8)
    expect(missing.unreviewed).toBe(1)
    expect(planJobs(p, 'missing', { perMissing: 3 }).jobs.find((j) => j.key === c0.key)!.count).toBe(3)
    // 미선별도 채워진 것으로 세면 c0은 부족 0
    expect(planJobs(p, 'missing', { countUnreviewed: true }).jobs.some((j) => j.key === c0.key)).toBe(false)

    const failed = planJobs(p, 'failed')
    expect(failed.jobs.map((j) => [j.key, j.count])).toEqual([[c1.key, 3]])
  })

  it('counts in-flight images as reserved', () => {
    expect(missingFor(undefined, 3)).toBe(3)
    expect(missingFor({ ...emptyItem('k'), queued: 1, generating: 1 }, 3)).toBe(1)
    expect(missingFor({ ...emptyItem('k'), queued: 5 }, 3)).toBe(0)
  })

  it('totals progress over the matrix', () => {
    const p = sample()
    p.defaults = { count: 4, target: 2 }
    const m = expandMatrix(p)
    let item = addImage(emptyItem(m.combos[0].key), { id: 1, ts: 1 }, { fromQueue: false })
    item = addImage(item, { id: 2, ts: 2 }, { fromQueue: false })
    item = addImage(item, { id: 3, ts: 3 }, { fromQueue: false })
    item = setMarks(item, [1, 2, 3], 'adopted')
    p.items = { [item.key]: item }
    const t = matrixTotals(p, m)
    expect(t).toMatchObject({ combos: 10, excluded: 2, images: 40, target: 20, adopted: 2 })
    expect(t.progress).toBeCloseTo(0.1)
    expect(t.byStatus.adopted).toBe(1)
    expect(t.byStatus.pending).toBe(9)
  })

  it('lists items that fell out of the matrix', () => {
    const p = sample()
    const key = expandMatrix(p).combos[0].key
    p.items = { [key]: addImage(emptyItem(key), { id: 1, ts: 1 }, { fromQueue: false }) }
    expect(orphanItems(p)).toEqual([])
    p.axes[0].values[0].enabled = false
    expect(orphanItems(p).map((i) => i.key)).toEqual([key])
  })
})

describe('estimates', () => {
  const ctx = { isOpus: false, secondsPerImage: 10 }

  it('charges per image without Opus and nothing with Opus at normal size', () => {
    const p = sample()
    p.refIds = []
    p.vibeIds = []
    p.characters.forEach((c) => {
      c.refIds = []
      c.vibeIds = []
    })
    const plan = planJobs(p, 'all')
    const paid = estimateJobs(plan.jobs, ctx)
    expect(paid).toMatchObject({ jobs: 10, images: 40, anlas: 40 * 20, freeImages: 0, seconds: 400 })
    const opus = estimateJobs(plan.jobs, { ...ctx, isOpus: true })
    expect(opus).toMatchObject({ anlas: 0, freeImages: 40 })
  })

  it('charges large overrides even for Opus', () => {
    const p = sample()
    p.refIds = []
    p.vibeIds = []
    p.characters.forEach((c) => {
      c.refIds = []
      c.vibeIds = []
    })
    p.overrides = [{ id: 'big', match: { o: 's' }, width: 1024, height: 1536 }]
    const est = estimateJobs(planJobs(p, 'all').jobs, { ...ctx, isOpus: true })
    // 민지의 수영복 2조합 × 4장만 유료 (1024×1536 > 1MP → 장당 30)
    expect(est).toMatchObject({ images: 40, freeImages: 32, anlas: 8 * 30 })
  })

  it('counts references only when the model accepts them, and vibe encoding once', () => {
    const p = sample()
    const jobs = planJobs(p, 'all').jobs
    // 민지 조합 6개 × 4장: 레퍼런스 2개, 하늘 4조합 × 4장: 1개 → (48 + 16) × 5
    const est = estimateJobs(jobs, { ...ctx, isOpus: true, unencodedVibeIds: [1, 2, 99] })
    expect(est.referenceAnlas).toBe((24 * 2 + 16 * 1) * 5)
    expect(est.vibeAnlas).toBe(2 * 2)
    expect(est.generationAnlas).toBe(0)
    expect(est.anlas).toBe(est.referenceAnlas + est.vibeAnlas)
    // 의상 레퍼런스는 V4.5에 보내지 않는다
    const typed = estimateJobs(jobs, {
      ...ctx,
      isOpus: true,
      references: [
        { id: 10, type: 'character' },
        { id: 11, type: 'costume' }
      ]
    })
    expect(typed.referenceAnlas).toBe(40 * 5)
    // V5 Medium은 레퍼런스도 바이브도 없다
    p.params.model = 'nai-diffusion-5-full-medium'
    const medium = estimateJobs(planJobs(p, 'all').jobs, { ...ctx, isOpus: true, unencodedVibeIds: [1, 2] })
    expect([medium.referenceAnlas, medium.vibeAnlas]).toEqual([0, 0])
  })

  it('treats V5 Opus images as free only while the usage quota is known to remain', () => {
    const p = sample()
    p.refIds = []
    p.characters.forEach((c) => (c.refIds = []))
    p.params = { ...p.params, model: 'nai-diffusion-5-full', steps: 23 }
    const jobs = planJobs(p, 'all').jobs
    const quota = estimateJobs(jobs, { ...ctx, isOpus: true, opusUsageExhausted: false })
    expect(quota).toMatchObject({ anlas: 0, freeImages: 40, opusUsageImages: 40 })
    const unknown = estimateJobs(jobs, { ...ctx, isOpus: true })
    expect(unknown).toMatchObject({ anlas: 40 * 26, freeImages: 0, opusUsageImages: 0 })
  })

  it('reads seconds per image from the last batch and formats durations', () => {
    expect(secondsPerImageFrom({ perImageMs: 12500 })).toBe(12.5)
    expect(secondsPerImageFrom(null)).toBe(15)
    expect(secondsPerImageFrom({ perImageMs: 0 }, 9)).toBe(9)
    expect(formatDuration(42)).toBe('약 42초')
    expect(formatDuration(600)).toBe('약 10분')
    expect(formatDuration(3600 + 20 * 60)).toBe('약 1시간 20분')
    expect(formatDuration(7200)).toBe('약 2시간')
  })

  it('warns when the plan explodes, with configurable thresholds', () => {
    const p = sample()
    const plan = planJobs(p, 'all')
    const est = estimateJobs(plan.jobs, { ...ctx, secondsPerImage: 30 })
    expect(planWarnings(plan, est)).toEqual([])
    const w = planWarnings(plan, est, { combos: 5, images: 10, anlas: 100, seconds: 600 })
    expect(w.map((x) => x.code)).toEqual(['combos', 'images', 'anlas', 'time'])
    expect(w[0].message).toContain('조합이 10개')
    expect(w[3].message).toContain('약 20분')
  })
})
