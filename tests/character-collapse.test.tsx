/// <reference types="node" />
/**
 * 0.14 캐릭터 화면 접기 — 접힘 기억(naip-sections), 접은 머리의 요약·경고, "모두 접기".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 접힘 기억은 localStorage 를 쓴다 (node 에는 없다) — 가져오기 전에 메모리 것을 둔다
const mem = vi.hoisted(() => {
  const m = new Map<string, string>()
  const store = {
    failWrites: false,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (store.failWrites) throw new Error('QuotaExceededError')
      m.set(k, String(v))
    },
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    }
  }
  ;(globalThis as Record<string, unknown>).localStorage = store
  return store
})

import { renderToString } from 'react-dom/server'
import {
  anySectionOpen,
  reloadSections,
  sectionOpen,
  SECTIONS_KEY,
  setSectionsOpen,
  storedSectionOpen,
  subscribeSections
} from '../src/lib/sections'
import {
  castOptionsSummary,
  castPreviewWarning,
  castSlotsSummary,
  castSlotsWarning,
  EMPTY_TEXT,
  librarySummary,
  slotProblem,
  textExcerpt,
  variationGroupSummary,
  variationProblem,
  variationsSummary,
  variationsWarning
} from '../src/lib/castSummary'
import {
  checkPeopleCount,
  DEFAULT_CAST_OPTIONS,
  type CastCharacter,
  type CastResolution,
  type CastSlot,
  type VariationGroup
} from '../src/nai/cast'
import { FoldAllButton, Section } from '../src/components/ui'

beforeEach(() => {
  mem.failWrites = false
  mem.clear()
  reloadSections()
})

const stored = (): Record<string, unknown> => JSON.parse(mem.getItem(SECTIONS_KEY) ?? 'null') as Record<string, unknown>

describe('접힘 기억 (naip-sections)', () => {
  it('누른 적 없으면 기본값, 누르면 기억한다', () => {
    expect(storedSectionOpen('char.options')).toBeUndefined()
    expect(sectionOpen('char.options', false)).toBe(false)
    expect(sectionOpen('char.slots')).toBe(true)
    setSectionsOpen(['char.options'], true)
    expect(sectionOpen('char.options', false)).toBe(true)
    expect(stored()).toEqual({ 'char.options': true })
  })

  it('0.13.1에 저장된 프롬프트 탭 접힘을 그대로 읽고, 새 열쇠를 써도 지우지 않는다', () => {
    mem.setItem(SECTIONS_KEY, JSON.stringify({ prompt: false, 'prompt.base': true }))
    reloadSections()
    expect(sectionOpen('prompt')).toBe(false)
    setSectionsOpen(['char.slots', 'char.library'], false)
    expect(stored()).toEqual({ prompt: false, 'prompt.base': true, 'char.slots': false, 'char.library': false })
  })

  it('깨진 값·참거짓이 아닌 값·Object 이름은 기본값으로 본다', () => {
    mem.setItem(SECTIONS_KEY, '{not json')
    reloadSections()
    expect(sectionOpen('char.slots')).toBe(true)
    mem.setItem(SECTIONS_KEY, JSON.stringify({ 'char.slots': 'no', constructor: 1 }))
    reloadSections()
    expect(sectionOpen('char.slots')).toBe(true)
    expect(storedSectionOpen('constructor')).toBeUndefined()
    expect(storedSectionOpen('toString')).toBeUndefined()
    mem.setItem(SECTIONS_KEY, '[false]')
    reloadSections()
    expect(storedSectionOpen('0')).toBeUndefined()
    // 깨진 상태에서 눌러도 새로 저장된다
    setSectionsOpen(['char.slots'], false)
    expect(stored()).toEqual({ 'char.slots': false })
  })

  it('저장이 안 돼도(용량) 이번 실행 동안은 접기·펴기가 된다', () => {
    mem.failWrites = true
    expect(() => setSectionsOpen(['slot.candidates'], false)).not.toThrow()
    expect(sectionOpen('slot.candidates')).toBe(false)
    expect(mem.getItem(SECTIONS_KEY)).toBeNull()
  })

  it('바뀌면 구독한 곳에 알리고, "모두 접기"는 보이는 구역의 기본값까지 본다', () => {
    const fn = vi.fn()
    const off = subscribeSections(fn)
    setSectionsOpen(['a', 'b'], false)
    expect(fn).toHaveBeenCalledTimes(1)
    setSectionsOpen([], true)
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    setSectionsOpen(['a'], true)
    expect(fn).toHaveBeenCalledTimes(1)

    reloadSections()
    mem.clear()
    reloadSections()
    // 뽑기 설정·위치는 처음에 접혀 있다 — 그 둘만 보이면 "모두 펴기"
    expect(anySectionOpen([{ key: 'char.options', defaultOpen: false }, { key: 'char.position', defaultOpen: false }])).toBe(false)
    expect(anySectionOpen([{ key: 'char.options', defaultOpen: false }, { key: 'char.slots' }])).toBe(true)
    setSectionsOpen(['char.slots'], false)
    expect(anySectionOpen([{ key: 'char.options', defaultOpen: false }, { key: 'char.slots' }])).toBe(false)
  })
})

describe('Section 머리 — 접으면 요약·경고, 펴면 설명·내용', () => {
  const render = (open: boolean): string => {
    setSectionsOpen(['t.sec'], open)
    return renderToString(
      <Section persistKey="t.sec" title="후보 3" summary="유나, 학생, 서연" hint="비중대로" warn="후보 없음">
        <p>내용칸</p>
      </Section>
    )
  }

  it('접었을 때: 요약과 경고 칩, 내용은 숨김', () => {
    const html = render(false)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('유나, 학생, 서연')
    expect(html).toContain('후보 없음')
    expect(html).not.toContain('내용칸')
    expect(html).not.toContain('비중대로')
  })

  it('펼쳤을 때: 설명과 내용, 경고 칩은 내용 안의 경고에 맡긴다', () => {
    const html = render(true)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('내용칸')
    expect(html).toContain('비중대로')
    expect(html).not.toContain('후보 없음')
    expect(html).not.toContain('유나, 학생, 서연')
  })

  it('persistKey 없이도 기본값대로 그린다 (프로젝트 화면 등 예전 쓰임)', () => {
    const html = renderToString(
      <Section title="경고 기준" defaultOpen={false}>
        <p>내용칸</p>
      </Section>
    )
    expect(html).toContain('경고 기준')
    expect(html).not.toContain('내용칸')
  })

  it('모두 접기 / 모두 펴기 글자가 보이는 구역 상태를 따른다', () => {
    const sections = [{ key: 'x.a' }, { key: 'x.b', defaultOpen: false }]
    expect(renderToString(<FoldAllButton sections={sections} />)).toContain('모두 접기')
    setSectionsOpen(['x.a'], false)
    expect(renderToString(<FoldAllButton sections={sections} />)).toContain('모두 펴기')
  })
})

// ── 요약 · 경고 ─────────────────────────────────────────

const char = (id: number, name: string, folderId: number | null = null, base = 'girl'): CastCharacter => ({
  id,
  name,
  folderId,
  base,
  additional: '',
  detail: '',
  negative: '',
  variations: []
})
const chars = [char(1, '민지', 10), char(2, '유나', 10), char(3, '서연')]
const slot = (p: Partial<CastSlot>): CastSlot => ({
  id: 900,
  enabled: true,
  mode: 'fixed',
  charId: null,
  candidates: [],
  chance: 50,
  wrap: true,
  center: null,
  ...p
})
const group = (p: Partial<VariationGroup>): VariationGroup => ({
  id: 1,
  kind: 'outfit',
  name: '',
  mode: 'random',
  fixedId: null,
  items: [{ id: 11, label: '교복', prompt: 'school uniform', weight: 1 }],
  ...p
})

describe('캐릭터 화면 요약·경고', () => {
  it('뽑기 설정 요약', () => {
    expect(castOptionsSummary(DEFAULT_CAST_OPTIONS)).toBe('장마다 · 중복 안 됨')
    expect(castOptionsSummary({ scope: 'batch', allowDuplicates: true, perScene: true, autoCountTags: true })).toBe(
      '배치에 한 번 · 중복 허용 · 씬마다 따로 · 인원 자동'
    )
  })

  it('아무도 내보내지 못하는 슬롯만 경고한다', () => {
    expect(slotProblem(slot({ mode: 'fixed', charId: 1 }), chars)).toBeNull()
    expect(slotProblem(slot({ mode: 'fixed', charId: null }), chars)).toBe('캐릭터 없음')
    expect(slotProblem(slot({ mode: 'fixed', charId: 99 }), chars)).toBe('캐릭터 없음')
    expect(slotProblem(slot({ mode: 'random' }), chars)).toBe('후보 없음')
    expect(slotProblem(slot({ mode: 'sequential' }), chars)).toBe('후보 없음')
    expect(slotProblem(slot({ mode: 'chance' }), chars)).toBe('후보 없음')
    // 확률 슬롯은 후보가 없으면 고정 캐릭터로 나온다 — 경고 아님
    expect(slotProblem(slot({ mode: 'chance', charId: 3 }), chars)).toBeNull()
    // 빈 폴더·지워진 캐릭터만 후보
    const ghost = { candidates: [{ kind: 'folder' as const, id: 77, weight: 1 }, { kind: 'char' as const, id: 99, weight: 1 }] }
    expect(slotProblem(slot({ mode: 'random', ...ghost }), chars)).toBe('뽑을 캐릭터 없음')
    expect(slotProblem(slot({ mode: 'sequential', ...ghost }), chars)).toBe('뽑을 캐릭터 없음')
    // 비중이 모두 0
    expect(slotProblem(slot({ mode: 'random', candidates: [{ kind: 'char', id: 1, weight: 0 }] }), chars)).toBe('비중이 모두 0')
    expect(slotProblem(slot({ mode: 'random', candidates: [{ kind: 'folder', id: 10, weight: 2 }] }), chars)).toBeNull()
    // 순차는 비중을 쓰지 않는다
    expect(slotProblem(slot({ mode: 'sequential', candidates: [{ kind: 'char', id: 1, weight: 0 }] }), chars)).toBeNull()
    // 꺼 둔 슬롯은 보내지 않으니 경고하지 않는다
    expect(slotProblem(slot({ mode: 'random', enabled: false }), chars)).toBeNull()
  })

  it('접은 출연 슬롯 요약과 경고', () => {
    const slots = [
      slot({ id: 1, mode: 'fixed', charId: 1 }),
      slot({ id: 2, mode: 'random', candidates: [{ kind: 'folder', id: 10, weight: 1 }, { kind: 'char', id: 3, weight: 1 }] }),
      slot({ id: 3, mode: 'sequential', candidates: [{ kind: 'char', id: 3, weight: 1 }] }),
      slot({ id: 4, mode: 'chance', chance: 40 }),
      slot({ id: 5, mode: 'random', enabled: false })
    ]
    expect(castSlotsSummary(slots, chars)).toBe('민지, 무작위 3명, 순차 1명, 확률 40%')
    expect(castSlotsSummary([], chars)).toBe('없음')
    expect(castSlotsSummary([slot({ enabled: false })], chars)).toBe('모두 꺼짐')
    expect(castSlotsWarning(slots, chars, 6)).toBe('후보 없음')
    expect(castSlotsWarning(slots, chars, 3)).toBe('한도 3명 넘음 · 후보 없음')
    expect(castSlotsWarning([...slots, slot({ id: 6, mode: 'fixed' })], chars, 6)).toBe('확인할 슬롯 2개')
    expect(castSlotsWarning(slots.slice(0, 3), chars, 6)).toBeNull()
  })

  it('접은 이번 장 예시 경고 — 고치지 않는 인원 태그 충돌·모델 한도로 빠진 캐릭터', () => {
    const res = (n: number, dropped = 0): CastResolution => ({
      chars: Array.from({ length: n }, (_, i) => ({
        slotId: i,
        charId: i,
        name: `c${i}`,
        prompt: 'girl',
        negative: '',
        center: null,
        variations: []
      })),
      dropped: Array.from({ length: dropped }, (_, i) => ({
        slotId: 50 + i,
        charId: 50 + i,
        name: `d${i}`,
        prompt: 'girl',
        negative: '',
        center: null,
        variations: []
      })),
      notes: [],
      advance: {}
    })
    const conflict = checkPeopleCount('2girls, classroom', 3)
    expect(conflict?.conflict).toBe(true)
    expect(castPreviewWarning(res(3), conflict, false)).toBe('인원 태그 충돌')
    expect(castPreviewWarning(res(3), conflict, true)).toBeNull()
    expect(castPreviewWarning(res(2), checkPeopleCount('2girls', 2), false)).toBeNull()
    expect(castPreviewWarning(res(6, 1), null, false)).toBe('1명 빠짐')
  })

  it('변형 그룹 요약·경고', () => {
    expect(variationProblem(group({}))).toBeNull()
    expect(variationProblem(group({ items: [] }))).toBe('항목 없음')
    expect(variationProblem(group({ mode: 'off', items: [] }))).toBeNull()
    expect(variationProblem(group({ items: [{ id: 1, label: '', prompt: 'x', weight: 0 }] }))).toBe('비중이 모두 0')
    // 고정·순차는 비중을 쓰지 않는다
    expect(variationProblem(group({ mode: 'fixed', items: [{ id: 1, label: '', prompt: 'x', weight: 0 }] }))).toBeNull()
    expect(variationGroupSummary(group({ items: Array.from({ length: 4 }, (_, i) => ({ id: i, label: '', prompt: 'x', weight: 1 })) }))).toBe(
      '무작위 · 4개'
    )
    const groups = [group({ id: 1 }), group({ id: 2, kind: 'expression', mode: 'fixed' }), group({ id: 3, kind: 'pose', items: [] })]
    expect(variationsSummary(groups)).toBe('복장 · 표정 · 자세')
    expect(variationsSummary([group({ name: '겉옷', mode: 'off' })])).toBe('겉옷(미사용)')
    expect(variationsSummary([])).toBe('없음')
    expect(variationsWarning(groups)).toBe('자세 항목 없음')
    expect(variationsWarning([...groups, group({ id: 4, kind: 'action', items: [] })])).toBe('확인할 그룹 2개')
    expect(variationsWarning(groups.slice(0, 2))).toBeNull()
  })

  it('프롬프트 칸 앞부분 — 주석 줄은 빼고 한 줄로', () => {
    expect(textExcerpt('girl,  black hair\n# 메모\nred eyes')).toBe('girl, black hair red eyes')
    expect(textExcerpt('   \n# 메모만')).toBe(EMPTY_TEXT)
    expect(textExcerpt('a'.repeat(100), 10)).toBe(`${'a'.repeat(10)}…`)
  })

  it('라이브러리 요약', () => {
    expect(librarySummary(chars, 1)).toBe('3명 · 폴더 1개')
    expect(librarySummary([], 0)).toBe('0명')
  })
})
