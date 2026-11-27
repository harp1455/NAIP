import { describe, expect, it } from 'vitest'
import { createProject, expandMatrix, planJobs, useProjects, type Axis, type Project } from '../src/project'
import { jobsToBatches, libraryCaption, projectPlanItem } from '../src/project/batches'
import { moveCharacter, moveValue, parseValueLines } from '../src/project/model'
import {
  projectItemFailed,
  projectItemLanded,
  projectItemRequest,
  projectItemStarted,
  releaseProjectItems
} from '../src/project/queue'
import type { CastCharacter } from '../src/nai/cast'
import { fragmentSourceFrom } from '../src/stores/fragments'
import type { CharRef, Vibe } from '../src/stores/refs'
import type { GenerationRequest } from '../src/nai/types'
import type { SettingsSnapshot } from '../src/lib/db'

const LIBRARY: CastCharacter[] = [
  {
    id: 101,
    name: '민지 원본',
    folderId: null,
    base: 'girl, black hair',
    additional: 'looking at viewer',
    detail: '# 주석 줄\ndetailed eyes',
    negative: 'bad hands',
    variations: [
      { id: 1, kind: 'outfit', name: '', mode: 'fixed', fixedId: null, items: [{ id: 1, label: 'x', prompt: 'IGNORED', weight: 1 }] }
    ]
  }
]

const vibe = (id: number): Vibe => ({ id, name: `v${id}`, image: 'AAA', thumb: '', strength: 0.5, infoExtracted: 1, enabled: false, encodings: {} })
const ref = (id: number): CharRef => ({ id, name: `r${id}`, image: 'AAA', thumb: '', type: 'character', strength: 1, fidelity: 1, enabled: false })

/** 캐릭터 2 × 표정 2 × 의상 1 */
function sample(): Project {
  const p = createProject('봄', { model: 'nai-diffusion-4-5-full', width: 832, height: 1216 }, 1000)
  p.id = 'P'
  p.stylePrompt = 'artist:foo'
  p.negative = 'lowres'
  p.defaults = { count: 2, target: 1 }
  p.vibeIds = [1]
  p.characters = [
    { id: 'A', libraryId: 101, name: '민지', prompt: 'solo', vibeIds: [], refIds: [11] },
    { id: 'B', libraryId: null, name: '하늘', prompt: 'boy, short hair', negative: 'beard', vibeIds: [2], refIds: [] }
  ]
  const emotion: Axis = {
    id: 'e',
    kind: 'expression',
    name: '표정',
    target: 'character',
    values: [
      { id: 'smile', label: '웃음', prompt: 'smile' },
      { id: 'cry', label: '울음', prompt: 'crying' }
    ]
  }
  const outfit: Axis = { id: 'o', kind: 'outfit', name: '의상', target: 'character', values: [{ id: 'u', label: '교복', prompt: 'school uniform' }] }
  p.axes = [emotion, outfit]
  return p
}

const ctx = () => ({
  library: LIBRARY,
  vibes: [vibe(1), vibe(2)],
  charRefs: [ref(11)],
  fragmentLib: { folders: [], fragments: [] },
  fragments: fragmentSourceFrom({ folders: [], fragments: [] })
})

describe('project jobs → queue batches', () => {
  it('composes the library caption without variations and strips comments', () => {
    expect(libraryCaption(101, LIBRARY)).toEqual({ prompt: 'girl, black hair, looking at viewer, detailed eyes', negative: 'bad hands' })
    expect(libraryCaption(999, LIBRARY)).toBeNull()
    expect(libraryCaption(null, LIBRARY)).toBeNull()
  })

  it('splits into one batch per character with one plan item per image', () => {
    const p = sample()
    const plan = planJobs(p, 'all')
    expect(plan.jobs).toHaveLength(4)
    const built = jobsToBatches(p.name, plan.jobs, ctx())
    expect(built.batches).toHaveLength(2)
    expect(built.images).toBe(8)
    const [a, b] = built.batches
    expect(a.plan).toHaveLength(4)
    expect(a.label).toBe('봄 · 민지 · 4장')
    expect(a.cast).toBeNull()
    expect(a.verbatim).toBe(false)
    // 레퍼런스·바이브는 그 캐릭터 묶음의 것만, 저장소에서 꺼 두었어도 켜서
    expect(a.vibes.map((v) => [v.id, v.enabled])).toEqual([[1, true]])
    expect(a.charRefs.map((r) => [r.id, r.enabled])).toEqual([[11, true]])
    expect(b.vibes.map((v) => v.id)).toEqual([1, 2])
    expect(b.charRefs).toEqual([])
    // 장마다 프롬프트가 들어 있고 화면 프롬프트와 무관
    const item = a.plan[0]
    expect(item.size).toEqual({ width: 832, height: 1216 })
    expect(item.project!.prompt).toBe('artist:foo')
    expect(item.project!.negative).toBe('lowres')
    expect(item.project!.characters).toEqual([
      { name: '민지', prompt: 'girl, black hair, looking at viewer, detailed eyes, solo, smile, school uniform', negative: 'bad hands' }
    ])
    expect(b.plan[0].project!.characters).toEqual([{ name: '하늘', prompt: 'boy, short hair, smile, school uniform', negative: 'beard' }])
    expect(new Set(a.plan.map((i) => i.project!.tag.key)).size).toBe(2)
    // 계획 칸마다 따로 된 객체 (진행 상태를 칸마다 센다)
    expect(a.plan[0]).not.toBe(a.plan[1])
    expect(a.plan[0].project).not.toBe(a.plan[1].project)
    // 대기열 저장(serializeBatch)이 옮길 수 있는 값 — fragments(함수)만 빼면 순수 JSON
    const plain = built.batches.map(({ fragments: _f, ...rest }) => rest)
    expect(JSON.parse(JSON.stringify(plain))).toEqual(plain)
  })

  it('notes a character removed from the library and sends only project fragments', () => {
    const p = sample()
    p.characters[0].libraryId = 555
    const notes = new Set<string>()
    const job = planJobs(p, 'all').jobs[0]
    expect(projectPlanItem(job, LIBRARY, notes).characters[0].prompt).toBe('solo, smile, school uniform')
    expect([...notes][0]).toContain('라이브러리에서 지워져')
  })

  it('replaces the screen prompt entirely for a project item', () => {
    const base = { prompt: 'SCREEN', negativePrompt: 'SCREEN NEG', characterPrompts: [{ prompt: 'x', negativePrompt: '', enabled: true }], useCoords: true, model: 'm' } as unknown as GenerationRequest
    const snap = { base: 'SCREEN', additional: 'A', detail: 'D', negative: 'N', params: { model: 'm' }, chars: [] } as SettingsSnapshot
    const item = projectPlanItem(planJobs(sample(), 'all').jobs[0], LIBRARY)
    const r = projectItemRequest({ base, snap }, item)
    expect(r.base.prompt).toBe('artist:foo')
    expect(r.base.negativePrompt).toBe('lowres')
    expect(r.base.useCoords).toBe(false)
    expect(r.base.characterPrompts).toEqual([{ prompt: item.characters[0].prompt, negativePrompt: 'bad hands', enabled: true, name: '민지' }])
    expect(r.snap).toMatchObject({ base: 'artist:foo', additional: '', detail: '', negative: 'lowres', params: { model: 'm' } })
  })
})

describe('queue hooks keep the project counts right', () => {
  const counts = (id: string, key: string) => {
    const it = useProjects.getState().projects.find((p) => p.id === id)!.items[key]
    return { queued: it.queued, generating: it.generating, failed: it.failed, images: it.images.length }
  }

  it('walks queued → started → landed / failed / released / cancelled once each', () => {
    const s = useProjects.getState()
    const id = s.create('대기열')
    s.addCharacter(id, { name: '민지' })
    const axis = s.addAxis(id, 'expression')!
    s.addValue(id, axis, { label: '웃음', prompt: 'smile' })
    const project = useProjects.getState().projects.find((p) => p.id === id)!
    const key = expandMatrix(project).combos[0].key
    const job = planJobs(project, 'all').jobs[0]
    const { batches } = jobsToBatches(project.name, [{ ...job, count: 5 }], ctx())
    const items = batches[0].plan
    s.markQueued(id, [{ key, count: 5 }])
    expect(counts(id, key)).toEqual({ queued: 5, generating: 0, failed: 0, images: 0 })

    // 1장: 성공 (재시도해도 시작은 한 번)
    projectItemStarted(items[0])
    projectItemStarted(items[0])
    expect(counts(id, key)).toMatchObject({ queued: 4, generating: 1 })
    projectItemLanded(items[0], { id: 9001, ts: 1, seed: 1, width: 832, height: 1216, mime: 'image/png' })
    projectItemFailed(items[0]) // 저장 뒤의 오류는 무시
    expect(counts(id, key)).toEqual({ queued: 4, generating: 0, failed: 0, images: 1 })

    // 2장: 실패 — 나중에 돌려줘도 다시 세지 않는다
    projectItemStarted(items[1])
    projectItemFailed(items[1])
    releaseProjectItems([items[1]])
    expect(counts(id, key)).toEqual({ queued: 3, generating: 0, failed: 1, images: 1 })

    // 3장: 시작했는데 멈춤 → 생성 중만 되돌림, 늦게 도착한 그림은 대기 장수를 건드리지 않는다
    projectItemStarted(items[2])
    releaseProjectItems(items.slice(2))
    expect(counts(id, key)).toEqual({ queued: 0, generating: 0, failed: 1, images: 1 })
    projectItemLanded(items[2], { id: 9002, ts: 2, seed: 2, width: 832, height: 1216, mime: 'image/png' })
    // 성공한 장은 실패 하나를 상쇄한다 (curation.addImage 규칙)
    expect(counts(id, key)).toEqual({ queued: 0, generating: 0, failed: 0, images: 2 })
    // 여러 번 돌려줘도 그대로
    releaseProjectItems(items)
    expect(counts(id, key)).toEqual({ queued: 0, generating: 0, failed: 0, images: 2 })
    s.remove(id)
  })

  it('ignores plan items without a project', () => {
    expect(() => {
      projectItemStarted({})
      projectItemLanded({}, { id: 1, ts: 1 })
      projectItemFailed({})
      releaseProjectItems([{}, {}])
    }).not.toThrow()
  })

  it('adds classified images without touching in-flight counts', () => {
    const s = useProjects.getState()
    const id = s.create('분류')
    s.markQueued(id, [{ key: 'k', count: 2 }])
    s.addImage(id, 'k', { id: 77, ts: 1 }, { fromQueue: false })
    expect(counts(id, 'k')).toMatchObject({ queued: 2, images: 1 })
    s.markStarted(id, 'k')
    s.cancelStarted(id, 'k')
    expect(counts(id, 'k')).toMatchObject({ queued: 1, generating: 0 })
    s.remove(id)
  })
})

describe('editor helpers', () => {
  it('parses pasted value lines', () => {
    expect(
      parseValueLines('웃음: smile, open mouth\n# 주석\n\n울음 (cry)：crying, tears\nangry, frown\n가중치: 1.2::blush::')
    ).toEqual([
      { label: '웃음', prompt: 'smile, open mouth' },
      { label: '울음', slug: 'cry', prompt: 'crying, tears' },
      { label: 'angry', prompt: 'angry, frown' },
      { label: '가중치', prompt: '1.2::blush::' }
    ])
  })

  it('moves values and characters without changing combination keys', () => {
    const p = sample()
    const before = expandMatrix(p).combos.map((c) => c.key).sort()
    const moved = moveCharacter(moveValue(p, 'e', 'cry', -1), 'B', -1)
    expect(moved.axes[0].values.map((v) => v.id)).toEqual(['cry', 'smile'])
    expect(moved.characters.map((c) => c.id)).toEqual(['B', 'A'])
    expect(expandMatrix(moved).combos.map((c) => c.key).sort()).toEqual(before)
    expect(moveValue(p, 'e', 'smile', -1)).toBe(p)
    expect(moveCharacter(p, 'A', -1)).toBe(p)
  })
})
