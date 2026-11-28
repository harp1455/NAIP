/// <reference types="node" />
/**
 * Phase 2 캐릭터 — "설정 적용"이 그 장의 출연을 똑같이 되살리는지, 변형 항목 여러 줄 붙여넣기가 프롬프트를 지키는지.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 스토어들이 localStorage 를 쓴다 (node 에는 없다) — 가져오기 전에 메모리 것을 둔다
vi.hoisted(() => {
  const m = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    }
  }
})

import { applyImport, type Importable } from '../src/lib/apply'
import { createDrawState, mulberry32, resolveCast, type CastCharacter } from '../src/nai/cast'
import { migrateCharacters, snapshotCastPlan, useCharacters } from '../src/stores/characters'
import { parseItemLines } from '../src/components/CharacterEditor'

const alice = (p: Partial<CastCharacter> = {}): CastCharacter => ({
  id: 1,
  name: 'Alice',
  folderId: null,
  base: 'girl, alice',
  additional: '',
  detail: '',
  negative: 'bad hands',
  variations: [],
  ...p
})

const outfits: CastCharacter['variations'] = [
  {
    id: 50,
    kind: 'outfit',
    name: '',
    mode: 'random',
    fixedId: null,
    items: [
      { id: 51, label: '교복', prompt: 'school uniform', weight: 1 },
      { id: 52, label: '수영복', prompt: 'swimsuit', weight: 1 }
    ]
  }
]

/** 이미지에 기록된 출연(Alice 'girl, alice')을 적용하고, 그 뒤 생성이 보낼 캐릭터 캡션·네거티브 */
function applyAndDraw(): { slotChar: number | null; sent: [string, string][]; libSize: number } {
  const data: Importable = {
    base: '',
    additional: '',
    detail: '',
    negative: '',
    params: {},
    chars: [{ name: 'Alice', prompt: 'girl, alice', negative: 'bad hands' }]
  }
  applyImport(data, new Set(['chars']), null)
  const s = useCharacters.getState()
  const res = resolveCast(snapshotCastPlan(), createDrawState(), mulberry32(3))
  return {
    slotChar: s.slots[0]?.charId ?? null,
    sent: res.chars.map((c) => [c.prompt, c.negative]),
    libSize: s.characters.length
  }
}

describe('apply settings: restoring an image cast', () => {
  beforeEach(() => useCharacters.setState(migrateCharacters({})))

  it('reuses a library character only when it would send exactly the recorded caption and negative', () => {
    useCharacters.setState(migrateCharacters({ characters: [alice()] }))
    const r = applyAndDraw()
    expect(r.slotChar).toBe(1)
    expect(r.libSize).toBe(1)
    expect(r.sent).toEqual([['girl, alice', 'bad hands']])
  })

  it('does not reuse a character whose variations, extra parts or negative would change what is sent', () => {
    const cases: Partial<CastCharacter>[] = [
      { variations: outfits },
      { additional: 'smile' },
      { detail: 'detailed eyes' },
      { negative: 'lowres' }
    ]
    for (const p of cases) {
      useCharacters.setState(migrateCharacters({ characters: [alice(p)] }))
      const r = applyAndDraw()
      // 그 장과 똑같이 — 새로 만든 가져온 캐릭터를 쓰고, 라이브러리의 Alice는 그대로 둔다
      expect(r.slotChar).not.toBe(1)
      expect(r.sent).toEqual([['girl, alice', 'bad hands']])
      expect(useCharacters.getState().characters.find((c) => c.id === 1)).toEqual(alice(p))
    }
  })
})

describe('variation items: pasting several lines', () => {
  it('keeps NovelAI prompt prefixes such as artist: and text: in the prompt', () => {
    const items = parseItemLines('artist:wlop\ntext: "Good morning!"\nRating: general\n교복: school uniform\nswim: swimsuit\npajamas\n1.2::smile::')
    expect(items.map((i) => [i.label, i.prompt])).toEqual([
      ['', 'artist:wlop'],
      ['', 'text: "Good morning!"'],
      ['', 'Rating: general'],
      ['교복', 'school uniform'],
      ['swim', 'swimsuit'],
      ['', 'pajamas'],
      ['', '1.2::smile::']
    ])
  })
})
