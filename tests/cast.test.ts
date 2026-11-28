import { describe, expect, it } from 'vitest'
import {
  advanceCursors,
  checkPeopleCount,
  composeCaption,
  createDrawState,
  DEFAULT_CAST_OPTIONS,
  drawStateFor,
  fixedSlots,
  fixPeopleCount,
  joinPromptParts,
  mulberry32,
  resolveCast,
  sexOfCaption,
  weightedIndex,
  type CastCharacter,
  type CastCursors,
  type CastOptions,
  type CastPlan,
  type CastSlot,
  type DrawState,
  type VariationGroup
} from '../src/nai/cast'
import { processWildcards } from '../src/nai/fragments'

let nextId = 1000
const char = (id: number, name: string, p: Partial<CastCharacter> = {}): CastCharacter => ({
  id,
  name,
  folderId: null,
  base: `${name.toLowerCase()} base`,
  additional: '',
  detail: '',
  negative: '',
  variations: [],
  ...p
})
const slot = (p: Partial<CastSlot>): CastSlot => ({
  id: nextId++,
  enabled: true,
  mode: 'fixed',
  charId: null,
  candidates: [],
  chance: 100,
  wrap: true,
  center: null,
  ...p
})
const plan = (slots: CastSlot[], characters: CastCharacter[], options: Partial<CastOptions> = {}): CastPlan => ({
  slots,
  characters,
  options: { ...DEFAULT_CAST_OPTIONS, ...options }
})
const cand = (id: number | null, weight = 1, kind: 'char' | 'folder' = 'char') => ({ kind, id, weight })

const A = char(1, 'A')
const B = char(2, 'B')
const C = char(3, 'C')
const LIB = [A, B, C]

/** n장을 같은 상태로 이어 뽑아 각 장의 캐릭터 이름 목록 */
function drawMany(p: CastPlan, n: number, seed = 1, max = Infinity): string[][] {
  const rng = mulberry32(seed)
  const state = createDrawState()
  return Array.from({ length: n }, () => resolveCast(p, state, rng, max).chars.map((c) => c.name))
}

const tally = (names: string[]): Record<string, number> =>
  names.reduce<Record<string, number>>((t, n) => ((t[n] = (t[n] ?? 0) + 1), t), {})

describe('cast: caption composition', () => {
  it('joins fixed, chosen variations, variable and detail with ", " and skips empty parts', () => {
    const c = char(9, 'X', { base: 'girl, red hair,', additional: '', detail: 'detailed eyes' })
    expect(composeCaption(c, [{ prompt: 'school uniform' }, { prompt: '' }, { prompt: ' smile ' }])).toBe(
      'girl, red hair, school uniform, smile, detailed eyes'
    )
    expect(composeCaption({ ...c, additional: 'sitting' }, [])).toBe('girl, red hair, sitting, detailed eyes')
  })

  it('drops comment lines so a trailing # line does not swallow later parts', () => {
    expect(joinPromptParts(['girl\n# 메모', 'smile'])).toBe('girl, smile')
  })

  it('keeps fragment syntax in item prompts and lets the existing processor resolve it afterwards', () => {
    const outfit: VariationGroup = {
      id: 1,
      kind: 'outfit',
      name: '',
      mode: 'fixed',
      fixedId: null,
      items: [{ id: 11, label: '랜덤 옷', prompt: '<옷>, <red|blue> ribbon', weight: 1 }]
    }
    const c = char(4, 'D', { variations: [outfit] })
    const res = resolveCast(plan(fixedSlots([4]), [c]), createDrawState(), () => 0)
    expect(res.chars[0].prompt).toBe('d base, <옷>, <red|blue> ribbon')
    const source = { getLines: (p: string) => (p === '옷' ? ['dress'] : null) }
    expect(processWildcards(res.chars[0].prompt, source, () => 0)).toBe('d base, dress, red ribbon')
    expect(res.chars[0].variations).toEqual([{ groupId: 1, group: '복장', itemId: 11, label: '랜덤 옷', prompt: '<옷>, <red|blue> ribbon' }])
  })
})

describe('cast: variations', () => {
  const group = (p: Partial<VariationGroup>): VariationGroup => ({
    id: 7,
    kind: 'expression',
    name: '',
    mode: 'random',
    fixedId: null,
    items: [
      { id: 1, label: '웃음', prompt: 'smile', weight: 3 },
      { id: 2, label: '울음', prompt: 'crying', weight: 1 },
      { id: 3, label: '무표정', prompt: 'expressionless', weight: 0 }
    ],
    ...p
  })
  const labels = (g: VariationGroup, n: number, seed = 5): string[] => {
    const c = char(1, 'A', { variations: [g] })
    const rng = mulberry32(seed)
    const state = createDrawState()
    return Array.from({ length: n }, () => resolveCast(plan(fixedSlots([1]), [c]), state, rng).chars[0].variations[0]?.label ?? '-')
  }

  it('random follows weights and never picks weight 0', () => {
    const t = tally(labels(group({}), 4000))
    expect(t['무표정']).toBeUndefined()
    expect(t['웃음'] / 4000).toBeGreaterThan(0.7)
    expect(t['웃음'] / 4000).toBeLessThan(0.8)
  })

  it('fixed uses the chosen item (or the first when the choice is gone)', () => {
    expect(new Set(labels(group({ mode: 'fixed', fixedId: 2 }), 20))).toEqual(new Set(['울음']))
    expect(new Set(labels(group({ mode: 'fixed', fixedId: 99 }), 5))).toEqual(new Set(['웃음']))
  })

  it('sequential cycles through items and off adds nothing', () => {
    expect(labels(group({ mode: 'sequential' }), 5)).toEqual(['웃음', '울음', '무표정', '웃음', '울음'])
    expect(labels(group({ mode: 'off' }), 3)).toEqual(['-', '-', '-'])
  })

  it('perBatch draws once per draw state', () => {
    const seq = labels(group({ perBatch: true }), 30, 9)
    expect(new Set(seq).size).toBe(1)
  })
})

describe('cast: slots', () => {
  it('mixes fixed and random slots; with duplicates forbidden the random slot avoids the fixed character', () => {
    const p = plan([slot({ mode: 'fixed', charId: 1 }), slot({ mode: 'random', candidates: [cand(1), cand(2, 3), cand(3, 1)] })], LIB)
    const draws = drawMany(p, 4000)
    expect(draws.every((d) => d.length === 2 && d[0] === 'A' && d[1] !== 'A')).toBe(true)
    const t = tally(draws.map((d) => d[1]))
    // B:C = 3:1 (A는 이미 고정 슬롯에 있어 빠진다)
    expect(t.B / 4000).toBeGreaterThan(0.7)
    expect(t.B / 4000).toBeLessThan(0.8)
  })

  it('a fixed slot later in the list still reserves its character before earlier random slots draw', () => {
    const p = plan([slot({ mode: 'random', candidates: [cand(1), cand(2)] }), slot({ mode: 'fixed', charId: 1 })], LIB)
    expect(drawMany(p, 200).every((d) => d[0] === 'B' && d[1] === 'A')).toBe(true)
  })

  it('allows the same character in several slots when duplicates are on', () => {
    const slots = [slot({ mode: 'random', candidates: [cand(1)] }), slot({ mode: 'random', candidates: [cand(1)] })]
    expect(drawMany(plan(slots, LIB, { allowDuplicates: true }), 3)).toEqual([['A', 'A'], ['A', 'A'], ['A', 'A']])
    const res = resolveCast(plan(slots, LIB), createDrawState(), mulberry32(1))
    expect(res.chars.map((c) => c.name)).toEqual(['A'])
    expect(res.notes.join()).toContain('다른 슬롯')
  })

  it('sequential walks candidates in order and wraps around', () => {
    const p = plan([slot({ mode: 'sequential', candidates: [cand(3), cand(1), cand(2)] })], LIB)
    expect(drawMany(p, 7).map((d) => d[0])).toEqual(['C', 'A', 'B', 'C', 'A', 'B', 'C'])
  })

  it('sequential without wrap empties the slot after one round', () => {
    const p = plan([slot({ mode: 'sequential', wrap: false, candidates: [cand(1), cand(2)] })], LIB)
    const state = createDrawState()
    const names = Array.from({ length: 4 }, () => resolveCast(p, state).chars.map((c) => c.name))
    expect(names).toEqual([['A'], ['B'], [], []])
    expect(resolveCast(p, state).notes[0]).toContain('순서가 끝나')
  })

  it('sequential skips a candidate already on screen when duplicates are forbidden', () => {
    const p = plan([slot({ mode: 'fixed', charId: 1 }), slot({ mode: 'sequential', candidates: [cand(1), cand(2), cand(3)] })], LIB)
    expect(drawMany(p, 3).map((d) => d[1])).toEqual(['B', 'B', 'C'])
  })

  it('probability slots appear about as often as their chance', () => {
    const p = plan([slot({ mode: 'chance', chance: 30, candidates: [cand(2)] })], LIB)
    const shown = drawMany(p, 10000, 42).filter((d) => d.length).length / 10000
    expect(shown).toBeGreaterThan(0.28)
    expect(shown).toBeLessThan(0.32)
    expect(drawMany(plan([slot({ mode: 'chance', chance: 0, candidates: [cand(2)] })], LIB), 200).flat()).toEqual([])
    expect(drawMany(plan([slot({ mode: 'chance', chance: 100, candidates: [cand(2)] })], LIB), 50).flat().length).toBe(50)
    // 후보를 비워 둔 확률 슬롯은 고정 캐릭터를 쓴다
    expect(drawMany(plan([slot({ mode: 'chance', chance: 100, charId: 3 })], LIB), 2)).toEqual([['C'], ['C']])
  })

  it('skips disabled slots', () => {
    const p = plan([slot({ charId: 1, enabled: false }), slot({ charId: 2 })], LIB)
    expect(drawMany(p, 1)).toEqual([['B']])
  })

  it('batch scope draws random/sequential/probability slots once and per-image scope redraws every image', () => {
    const slots = [
      slot({ mode: 'random', candidates: [cand(1), cand(2), cand(3)] }),
      slot({ mode: 'sequential', candidates: [cand(1), cand(2), cand(3)] })
    ]
    const once = drawMany(plan(slots, LIB, { scope: 'batch', allowDuplicates: true }), 30, 3)
    expect(new Set(once.map((d) => d.join())).size).toBe(1)
    const each = drawMany(plan(slots, LIB, { scope: 'image', allowDuplicates: true }), 30, 3)
    expect(new Set(each.map((d) => d[0])).size).toBe(3)
    expect(each.slice(0, 3).map((d) => d[1])).toEqual(['A', 'B', 'C'])
    // 확률도 배치에 한 번: 나오면 끝까지 나오고, 안 나오면 끝까지 안 나온다
    for (let seed = 1; seed <= 20; seed++) {
      const d = drawMany(plan([slot({ mode: 'chance', chance: 50, candidates: [cand(2)] })], LIB, { scope: 'batch' }), 10, seed)
      expect(new Set(d.map((x) => x.length)).size).toBe(1)
    }
  })

  it('per-scene draw restarts sequences and batch draws for each scene; otherwise they continue across scenes', () => {
    const seq = [slot({ mode: 'sequential', candidates: [cand(1), cand(2), cand(3)] })]
    // 씬 10 → 2장, 씬 20 → 2장 (생성 순서대로)
    const run = (perScene: boolean): string[] => {
      const p = plan(seq, LIB, { perScene })
      const states = new Map()
      return [10, 10, 20, 20].map((scene) => resolveCast(p, drawStateFor(states, p.options, scene)).chars[0].name)
    }
    expect(run(false)).toEqual(['A', 'B', 'C', 'A'])
    expect(run(true)).toEqual(['A', 'B', 'A', 'B'])
    // 씬이 없는 배치는 항상 하나의 상태
    const states = new Map()
    const p = plan(seq, LIB, { perScene: true })
    expect(drawStateFor(states, p.options)).toBe(drawStateFor(states, p.options))
  })

  describe('once-per-batch sequences continue from batch to batch', () => {
    /** 배치 n개를 돌린다 — 배치마다 새 뽑기 상태, 시작 자리는 지난 배치들이 넘긴 커서. 장마다 (씬, 첫 캐릭터·변형) */
    function batches(p: CastPlan, scenesPerBatch: (number | undefined)[], n: number, start: CastCursors = {}) {
      let cursors = start
      const out: string[][] = []
      for (let b = 0; b < n; b++) {
        const states = new Map<string, DrawState>()
        const shots = scenesPerBatch.map((scene) => resolveCast(p, drawStateFor(states, p.options, scene, cursors), mulberry32(b)))
        out.push(shots.map((r) => [r.chars[0]?.name ?? '-', ...(r.chars[0]?.variations ?? []).map((v) => v.label)].join('')))
        // 이 배치에서 그림이 나왔으면 다음 배치는 다음 차례
        for (const r of shots) cursors = advanceCursors(cursors, r.advance) ?? cursors
      }
      return { out, cursors }
    }
    const seq = (p: Partial<CastSlot> = {}) => slot({ id: 500, mode: 'sequential', candidates: [cand(1), cand(2), cand(3)], ...p })

    it('a sequential slot drawn once per batch takes the next candidate in every new batch and wraps', () => {
      const { out, cursors } = batches(plan([seq()], LIB, { scope: 'batch' }), [undefined, undefined], 4)
      expect(out).toEqual([['A', 'A'], ['B', 'B'], ['C', 'C'], ['A', 'A']])
      expect(cursors).toEqual({ 'slot:500': 4 })
    })

    it('reports the next position for every image that used the batch draw, cached or fresh', () => {
      const p = plan([seq()], LIB, { scope: 'batch' })
      const state = createDrawState({ 'slot:500': 1 })
      expect(resolveCast(p, state).advance).toEqual({ 'slot:500': 2 })
      expect(resolveCast(p, state).advance).toEqual({ 'slot:500': 2 })
      expect(resolveCast(p, state).chars[0].name).toBe('B')
    })

    it('without wrap the slot stays empty once every candidate had its batch', () => {
      const { out } = batches(plan([seq({ wrap: false, candidates: [cand(1), cand(2)] })], LIB, { scope: 'batch' }), [undefined], 3)
      expect(out).toEqual([['A'], ['B'], ['-']])
      const res = resolveCast(plan([seq({ wrap: false })], LIB, { scope: 'batch' }), createDrawState({ 'slot:500': 3 }))
      expect(res.notes.join()).toContain('순서가 끝나')
    })

    it('a sequential variation group drawn once per batch takes the next item in every new batch', () => {
      const g: VariationGroup = {
        id: 8,
        kind: 'outfit',
        name: '',
        mode: 'sequential',
        fixedId: null,
        perBatch: true,
        items: [
          { id: 1, label: 'x', prompt: 'x', weight: 1 },
          { id: 2, label: 'y', prompt: 'y', weight: 1 }
        ]
      }
      const p = plan(fixedSlots([1]), [char(1, 'A', { variations: [g] })])
      const { out, cursors } = batches(p, [undefined, undefined], 3)
      expect(out).toEqual([['Ax', 'Ax'], ['Ay', 'Ay'], ['Ax', 'Ax']])
      expect(cursors).toEqual({ 'var:1:8': 3 })
      // 배치마다 한 번이 아니면 장마다 처음부터 — 커서를 읽지도 넘기지도 않는다
      const each = batches(plan(fixedSlots([1]), [char(1, 'A', { variations: [{ ...g, perBatch: false }] })]), [undefined, undefined], 2, { 'var:1:8': 1 })
      expect(each.out).toEqual([['Ax', 'Ay'], ['Ax', 'Ay']])
      expect(each.cursors).toEqual({ 'var:1:8': 1 })
    })

    it('per-image sequences ignore the saved position and never move it', () => {
      const { out, cursors } = batches(plan([seq()], LIB, { scope: 'image' }), [undefined, undefined, undefined], 2, { 'slot:500': 2 })
      expect(out).toEqual([['A', 'B', 'C'], ['A', 'B', 'C']])
      expect(cursors).toEqual({ 'slot:500': 2 })
    })

    it('per-scene draws restart each scene at the batch turn, and the next batch moves every scene on', () => {
      const { out, cursors } = batches(plan([seq()], LIB, { scope: 'batch', perScene: true }), [10, 10, 20, 20], 2)
      expect(out).toEqual([['A', 'A', 'A', 'A'], ['B', 'B', 'B', 'B']])
      expect(cursors).toEqual({ 'slot:500': 2 })
      // 씬마다 따로 뽑지 않으면 씬이 바뀌어도 배치의 한 번 뽑기를 그대로 쓴다
      expect(batches(plan([seq()], LIB, { scope: 'batch' }), [10, 20], 2).out).toEqual([['A', 'A'], ['B', 'B']])
    })

    it('advancing moves only from the turn the batch started at, so replaying a batch (resume) never moves it twice', () => {
      expect(advanceCursors({ 'slot:1': 2 }, { 'slot:1': 3 })).toEqual({ 'slot:1': 3 })
      expect(advanceCursors({ 'slot:1': 3 }, { 'slot:1': 2, 'slot:2': 1 })).toEqual({ 'slot:1': 3, 'slot:2': 1 })
      expect(advanceCursors({ 'slot:1': 3 }, { 'slot:1': 3 })).toBeNull()
      expect(advanceCursors({ 'slot:1': 3 }, {})).toBeNull()
      // 배치가 도는 사이 처음으로 되돌렸으면(3번째 차례에서 시작한 배치가 끝나도) 되돌린 자리를 지킨다
      expect(advanceCursors({}, { 'slot:1': 3 })).toBeNull()
      // 깨진 값(손상된 저장분·백업)은 처음부터로 친다
      expect(advanceCursors({ 'slot:1': Number.NaN }, { 'slot:1': 1 })).toEqual({ 'slot:1': 1 })
      expect(resolveCast(plan([seq()], LIB, { scope: 'batch' }), createDrawState({ 'slot:500': -4 })).chars[0].name).toBe('A')
    })
  })

  it('folder candidates share their weight among members; sequential expands folders in library order', () => {
    const F = 77
    const lib = [char(1, 'A', { folderId: F }), char(2, 'B', { folderId: F }), char(3, 'C'), char(4, 'D', { folderId: null })]
    const p = plan([slot({ mode: 'random', candidates: [cand(F, 1, 'folder'), cand(3, 1)] })], lib)
    const t = tally(drawMany(p, 8000, 11).map((d) => d[0]))
    expect(t.C / 8000).toBeGreaterThan(0.46)
    expect(t.C / 8000).toBeLessThan(0.54)
    expect(t.A / 8000).toBeGreaterThan(0.21)
    expect(t.B / 8000).toBeGreaterThan(0.21)
    expect(t.D).toBeUndefined()
    // 미분류(null) 폴더도 후보가 된다
    const seq = plan([slot({ mode: 'sequential', candidates: [cand(3), cand(F, 1, 'folder'), cand(null, 1, 'folder')] })], lib)
    expect(drawMany(seq, 4).map((d) => d[0])).toEqual(['C', 'A', 'B', 'D'])
  })

  it('drops characters beyond the model limit with a note', () => {
    const lib = Array.from({ length: 8 }, (_, i) => char(i + 1, `C${i + 1}`))
    const res = resolveCast(plan(fixedSlots(lib.map((c) => c.id)), lib), createDrawState(), Math.random, 6)
    expect(res.chars.map((c) => c.name)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'])
    expect(res.dropped.map((c) => c.name)).toEqual(['C7', 'C8'])
    expect(res.notes.join()).toContain('모델 한도 6명')
    const v5 = resolveCast(plan(fixedSlots(lib.map((c) => c.id)), lib), createDrawState(), Math.random, 32)
    expect(v5.chars.length).toBe(8)
  })

  it('keeps per-slot positions and is reproducible with the same seed', () => {
    const p = plan(
      [slot({ mode: 'random', candidates: [cand(1), cand(2), cand(3)], center: { x: 0.3, y: 0.5 } }), slot({ charId: 3, center: null })],
      LIB,
      { allowDuplicates: true }
    )
    const r = resolveCast(p, createDrawState(), mulberry32(7))
    expect(r.chars[0].center).toEqual({ x: 0.3, y: 0.5 })
    expect(r.chars[1].center).toBeNull()
    expect(drawMany(p, 20, 99)).toEqual(drawMany(p, 20, 99))
  })

  it('random and sequential slots with no candidates stay empty even when a fixed character is left over', () => {
    // 고정 → 무작위로 바꾸면 고정 캐릭터가 후보로 옮겨지고 charId는 남는다 — 후보를 다 빼면 슬롯은 비어야 한다
    const left = { charId: 1, candidates: [] }
    for (const mode of ['random', 'sequential'] as const) {
      const res = resolveCast(plan([slot({ mode, ...left })], LIB), createDrawState())
      expect(res.chars).toEqual([])
      expect(res.notes.join()).toContain('후보가 없어 비웠습니다')
    }
    // 확률 슬롯만 후보가 없을 때 고정 캐릭터를 쓴다 (편집 화면이 그 이름을 보여 준다)
    const chance = resolveCast(plan([slot({ mode: 'chance', chance: 100, ...left })], LIB), createDrawState())
    expect(chance.chars.map((c) => c.name)).toEqual(['A'])
  })

  it('leaves out empty captions and slots whose character is gone', () => {
    const empty = char(5, 'E', { base: '' })
    const res = resolveCast(plan([slot({ charId: 5 }), slot({ charId: 404 })], [empty]), createDrawState())
    expect(res.chars).toEqual([])
    expect(res.notes.length).toBe(2)
  })
})

describe('cast: people-count tags', () => {
  it('detects conflicts between count tags and the actual character count', () => {
    expect(checkPeopleCount('2girls, smile', 3)?.conflict).toBe(true)
    expect(checkPeopleCount('2girls, smile', 2)?.conflict).toBe(false)
    expect(checkPeopleCount('1girl, 1boy', 2)?.conflict).toBe(false)
    expect(checkPeopleCount('1girl, solo', 1)?.conflict).toBe(false)
    expect(checkPeopleCount('solo', 2)?.conflict).toBe(true)
    expect(checkPeopleCount('multiple girls', 3)?.conflict).toBe(false)
    expect(checkPeopleCount('multiple girls', 1)?.conflict).toBe(true)
    expect(checkPeopleCount('2girls, multiple girls', 3)?.conflict).toBe(true)
    expect(checkPeopleCount('6+girls', 9)?.conflict).toBe(false)
    expect(checkPeopleCount('no humans, scenery', 1)?.conflict).toBe(true)
    expect(checkPeopleCount('{2girls}, 1.2::1boy::', 2)?.tags).toEqual(['{2girls}', '1.2::1boy::'])
    expect(checkPeopleCount('{2girls}, 1.2::1boy::', 2)?.conflict).toBe(true)
    expect(checkPeopleCount('multiple_boys', 2)?.conflict).toBe(false)
  })

  it('ignores prompts without count tags, comment lines and character-less generations', () => {
    expect(checkPeopleCount('smile, beach', 3)).toBeNull()
    expect(checkPeopleCount('# 2girls\nsmile', 3)).toBeNull()
    expect(checkPeopleCount('2girls', 0)).toBeNull()
  })

  it('reads the sex of a character caption', () => {
    expect(sexOfCaption('girl, red hair')).toBe('girl')
    expect(sexOfCaption('1boy, glasses')).toBe('boy')
    expect(sexOfCaption('red hair')).toBeNull()
  })

  it('rewrites count tags in place to match the drawn characters', () => {
    const girls = (n: number) => Array.from({ length: n }, () => ({ prompt: 'girl, long hair' }))
    expect(fixPeopleCount('masterpiece, 2girls, smile', girls(3))).toEqual({
      prompt: 'masterpiece, 3girls, smile',
      from: '2girls',
      to: '3girls'
    })
    expect(fixPeopleCount('2girls, solo, smile', [{ prompt: 'girl' }, { prompt: 'boy, short hair' }])?.prompt).toBe(
      '1girl, 1boy, smile'
    )
    expect(fixPeopleCount('2girls, smile\nbeach, solo', girls(1))?.prompt).toBe('1girl, solo, smile\nbeach')
    expect(fixPeopleCount('3girls, multiple girls', girls(2))?.prompt).toBe('2girls, multiple girls')
    expect(fixPeopleCount('1girl, smile', girls(8))?.prompt).toBe('6+girls, smile')
    // 성별을 알 수 없으면 원래 태그에 많이 적힌 성별로
    expect(fixPeopleCount('2boys', [{ prompt: 'red hair' }])?.prompt).toBe('1boy')
    // 충돌이 없으면 그대로
    expect(fixPeopleCount('2girls', girls(2))).toBeNull()
    expect(fixPeopleCount('smile', girls(2))).toBeNull()
  })

  it('keeps weight and emphasis groups intact when it rewrites or removes count tags', () => {
    const girls = (n: number) => Array.from({ length: n }, () => ({ prompt: 'girl, long hair' }))
    const fix = (p: string, n: number) => fixPeopleCount(p, girls(n))?.prompt
    // 고친 태그는 감싼 문법(괄호·가중치) 안에 그대로 들어간다
    expect(fix('{2girls, smile}, park', 1)).toBe('{1girl, smile}, park')
    expect(fix('[2girls, smile]', 1)).toBe('[1girl, smile]')
    expect(fix('1.3::2girls, smile::, park', 1)).toBe('1.3::1girl, smile::, park')
    expect(fix('masterpiece, 1.2::2girls, hug::, park', 1)).toBe('masterpiece, 1.2::1girl, hug::, park')
    expect(fix('{{2girls}}, smile', 1)).toBe('{{1girl}}, smile')
    // 지운 태그가 열거나 닫던 그룹은 이웃 태그로 옮겨 짝이 맞게 남는다
    expect(fix('2girls, {smile, solo}, park', 2)).toBe('2girls, {smile}, park')
    expect(fix('2girls, {solo, smile}, park', 2)).toBe('2girls, {smile}, park')
    expect(fix('2girls, {solo}, smile', 2)).toBe('2girls, smile')
    expect(fix('1.2::2girls, solo::, park', 2)).toBe('1.2::2girls::, park')
    expect(fix('2girls, 1.2::solo, smile::, park', 2)).toBe('2girls, 1.2::smile::, park')
    expect(fix('2girls, {solo, 1boy}, smile', 1)).toBe('1girl, solo, smile')
  })

  it('does not count or rewrite count tags inside a negative or zero weight', () => {
    const girls = (n: number) => Array.from({ length: n }, () => ({ prompt: 'girl' }))
    // "-1::solo::"는 솔로가 아니게 하라는 뜻 — 인원 태그로 세지 않는다
    expect(checkPeopleCount('2girls, -1::solo::', 2)?.conflict).toBe(false)
    expect(checkPeopleCount('-1::solo::, smile', 3)).toBeNull()
    expect(checkPeopleCount('0::2girls::', 1)).toBeNull()
    expect(fixPeopleCount('2girls, -1::solo::, smile', girls(2))).toBeNull()
    // 음수 가중치 태그는 양수로 바뀌거나 지워지지 않고, 고칠 태그는 그 밖의 것만
    expect(fixPeopleCount('-1::solo::, 2girls', girls(1))?.prompt).toBe('-1::solo::, 1girl')
    expect(fixPeopleCount('-1::smile, 2girls::, 3girls', girls(1))?.prompt).toBe('-1::smile, 2girls::, 1girl')
    // 주석 줄의 가중치 문법은 영향을 주지 않는다
    expect(fixPeopleCount('# -1::\n2girls', girls(1))?.prompt).toBe('# -1::\n1girl')
  })
})

describe('cast: rng helpers', () => {
  it('weightedIndex ignores non-positive weights and returns -1 when nothing can be picked', () => {
    expect(weightedIndex([0, 0], Math.random)).toBe(-1)
    expect(weightedIndex([0, 5, 0], () => 0.99)).toBe(1)
    expect(weightedIndex([1, 1], () => 0.999999)).toBe(1)
  })
})

import { migrateCharacters, normalizeCharacter, snapshotCastPlan, useCharacters } from '../src/stores/characters'

describe('characters store: migration and snapshots', () => {
  const old = {
    folders: [{ id: 5, name: '주인공' }],
    characters: [
      { id: 1, name: '아리', folderId: 5, prompt: 'girl, black hair\n# 메모', negative: 'bad hands' },
      { id: 2, name: '하루', folderId: null, prompt: 'boy, glasses', negative: '' }
    ],
    cast: [
      { charId: 2, enabled: false, center: { x: 0.3, y: 0.5 } },
      { charId: 1, enabled: true, center: null }
    ]
  }

  it('moves the single prompt into the fixed part losslessly and turns the old cast into fixed slots', () => {
    const m = migrateCharacters(old)
    expect(m.folders).toEqual(old.folders)
    expect(m.characters[0]).toEqual({
      id: 1,
      name: '아리',
      folderId: 5,
      base: 'girl, black hair\n# 메모',
      additional: '',
      detail: '',
      negative: 'bad hands',
      variations: []
    })
    expect(m.slots.map((s) => [s.mode, s.charId, s.enabled, s.center])).toEqual([
      ['fixed', 2, false, { x: 0.3, y: 0.5 }],
      ['fixed', 1, true, null]
    ])
    expect(new Set(m.slots.map((s) => s.id)).size).toBe(2)
    expect(m.options).toEqual(DEFAULT_CAST_OPTIONS)
    // 옮긴 슬롯으로 뽑으면 예전과 같은 캡션이 나온다 (켜 둔 캐릭터만)
    const res = resolveCast({ slots: m.slots, options: m.options, characters: m.characters }, createDrawState())
    expect(res.chars.map((c) => [c.name, c.prompt, c.negative])).toEqual([['아리', 'girl, black hair', 'bad hands']])
  })

  it('leaves data already in the new format unchanged', () => {
    const m = migrateCharacters(old)
    expect(migrateCharacters(JSON.parse(JSON.stringify(m)))).toEqual(m)
    expect(normalizeCharacter({ name: 'x', base: 'a', prompt: 'ignored' }).base).toBe('a')
  })

  it('snapshots the slot config with deep copies so later library edits do not leak into queued batches', () => {
    useCharacters.setState(migrateCharacters(old))
    const s = useCharacters.getState()
    s.patchSlot(s.slots[0].id, { enabled: true, mode: 'random', candidates: [{ kind: 'folder', id: 5, weight: 1 }] })
    const snap = snapshotCastPlan()
    expect(snap.characters.map((c) => c.id).sort()).toEqual([1, 2])
    useCharacters.getState().saveCharacter({ ...useCharacters.getState().characters[0], base: 'changed' })
    useCharacters.getState().deleteCharacter(1)
    expect(snap.characters.find((c) => c.id === 1)?.base).toBe('girl, black hair\n# 메모')
    expect(snap.slots.length).toBe(2)
    // 지운 캐릭터의 고정 슬롯은 내려가고, 폴더 후보는 남는다
    expect(useCharacters.getState().slots.map((x) => x.mode)).toEqual(['random'])
  })

  it('toggles a fixed slot from the library', () => {
    useCharacters.setState(migrateCharacters({ characters: [{ id: 9, name: 'Z', prompt: 'z' }] }))
    useCharacters.getState().toggleFixed(9)
    expect(useCharacters.getState().slots.map((x) => [x.mode, x.charId])).toEqual([['fixed', 9]])
    useCharacters.getState().toggleFixed(9)
    expect(useCharacters.getState().slots).toEqual([])
  })
})
